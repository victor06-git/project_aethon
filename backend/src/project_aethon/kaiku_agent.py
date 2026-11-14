"""Kaiku Finance: a fixed route -> retrieve -> answer pipeline (at most 2 model calls per question).

    question
       |
    1. ROUTE     one small Gemini call -> a typed decision (route + search/data parameters)
       |         + a code guardrail that can only push a decision TOWARDS the web
       |
       |-- static   -> the router already wrote the answer from training      [MODEL]  1 call
       |-- clarify  -> the router asks one question back                               1 call
       |-- web      -> Exa search (code)        -> 2. ANSWER from the evidence [WEB n] 2 calls
       |-- data     -> pandas totals (code)     -> 2. ANSWER from the evidence [DATA]  2 calls
       `-- both     -> Exa + pandas (code)      -> 2. ANSWER from the evidence         2 calls

Exa is the base: `web` is the default route and every doubt, parse failure or guardrail hit
goes to Exa. Training data is used only for timeless, non-local questions.

Gemini does three things only: interpret the prompt (router), keep tokens low (it never sees
tool schemas, URLs or raw pages) and write the answer from the evidence. Searching, arithmetic,
the source list and the [MODEL] label are done in code.

Contains:
    1. search_exa / format_evidence  -> Exa call and the compact evidence text
    2. spending_summary              -> totals of the user's transactions (pandas)
    3. Route + force_web             -> the router's decision and the code guardrail
    4. Kaiku / create_agent          -> the pipeline: .route(question) and .ask(question)
"""

import copy
import getpass
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlparse

import pandas as pd
from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

MODEL_NAME = "gemini-3.5-flash"
MODEL_CUTOFF = "January 2025"  # knowledge cutoff of the model above; change both together

# Thinking effort per step ("minimal" | "low" | "medium" | "high", None = model default).
# Thinking tokens are billed as output, so this is the biggest token lever of the model.
ROUTER_THINKING: Optional[str] = "minimal"
ANSWER_THINKING: Optional[str] = "low"

# Official / authoritative Finnish sources used when the router asks for `official`.
OFFICIAL_DOMAINS = [
    "finlex.fi",              # legislation
    "kela.fi",                # benefits
    "vero.fi",                # taxes
    "suomenpankki.fi",        # central bank, Euribor and interest rates
    "stat.fi",                # Statistics Finland
    "kkv.fi",                 # consumer authority (rent and consumer disputes)
    "finanssivalvonta.fi",    # financial supervisor
    "suomi.fi",               # public services portal
    "infofinland.fi",         # official guidance in several languages
]


# ---------------------------------------------------------------------------
# Keys and model
# ---------------------------------------------------------------------------
def _load_env() -> None:
    """Loads the keys from `.env` (or a file named `env`) in the project root or the cwd."""
    load_dotenv()
    root = Path(__file__).resolve().parents[2]  # src/project_aethon/ -> project root
    for name in (".env", "env"):
        if (root / name).is_file():
            load_dotenv(root / name)


def _gemini_key() -> Optional[str]:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")


def _ensure_api_keys(model_name: str = MODEL_NAME) -> None:
    """Loads the env file and asks for any missing key."""
    _load_env()
    if model_name.startswith("gemini") and not _gemini_key():
        os.environ["GEMINI_API_KEY"] = getpass.getpass("Gemini API key: ")
    if model_name.startswith("claude") and not os.environ.get("ANTHROPIC_API_KEY"):
        os.environ["ANTHROPIC_API_KEY"] = getpass.getpass("Anthropic API key: ")
    if not os.environ.get("EXA_API_KEY"):
        os.environ["EXA_API_KEY"] = getpass.getpass("Exa API key: ")


def make_model(model_name: str = MODEL_NAME, thinking: Optional[str] = None,
               temperature: Optional[float] = None, **model_kwargs):
    """Chat model. Gemini goes through `langchain-google-genai` with the key in GEMINI_API_KEY.

    thinking: effort for Gemini ("minimal".."high"); mapped to `thinking_level` on Gemini 3+
        and to `thinking_budget` on Gemini 2.5. None keeps the model default.
    temperature: None keeps the model default (recommended for Gemini 3+).
    Other models supported by `init_chat_model` work too: pass model_provider=... (and
    base_url/api_key for an OpenAI-compatible endpoint such as Gemma on Verda).
    """
    _ensure_api_keys(model_name)
    if model_name.startswith("gemini"):
        model_kwargs.setdefault("model_provider", "google_genai")
        model_kwargs.setdefault("api_key", _gemini_key())
        if thinking and model_name.startswith("gemini-2.5"):
            model_kwargs.setdefault("thinking_budget", {"minimal": 0, "low": 512, "medium": 2048}.get(thinking, -1))
        elif thinking:
            model_kwargs.setdefault("thinking_level", thinking)
    if temperature is not None:
        model_kwargs["temperature"] = temperature
    return init_chat_model(model_name, **model_kwargs)


def message_text(m) -> str:
    """Text of a message; if the content comes in blocks, joins the text parts."""
    c = m.content
    if isinstance(c, list):
        c = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in c)
    return c or ""


def _usage(m) -> dict:
    u = getattr(m, "usage_metadata", None) or {}
    return {"in": u.get("input_tokens", 0) or 0, "out": u.get("output_tokens", 0) or 0,
            "reasoning": (u.get("output_token_details") or {}).get("reasoning", 0) or 0}


# ---------------------------------------------------------------------------
# 1. Exa search (code only, no model involved)
# ---------------------------------------------------------------------------
_exa_client = None


def get_exa_client():
    """Lazy Exa client (import inside so the rest of the module works without exa-py)."""
    global _exa_client
    if _exa_client is None:
        from exa_py import Exa

        _ensure_api_keys()
        _exa_client = Exa(api_key=os.environ["EXA_API_KEY"])
    return _exa_client


def search_exa(
    query: str,
    num_results: int = 3,
    highlight_chars: int = 300,
    include_domains: Optional[list[str]] = None,
    recent_days: Optional[int] = None,
    search_type: str = "auto",
    max_age_hours: Optional[int] = None,
    full_text_chars: Optional[int] = None,
    category: Optional[str] = None,
) -> dict:
    """One Exa search, normalised to {"results": [{title, url, published, snippets}], "cost"}.

    Token levers: `highlight_chars` (Exa returns only the passages relevant to the query),
    `num_results`, and `full_text_chars` (page text instead of highlights, for comparison).
    Freshness levers: `recent_days` (published in the last N days) and `max_age_hours`
    (0 forces a live crawl). `search_type`: "auto", or "lite" for a cheaper, faster search.
    """
    if full_text_chars:
        contents: dict = {"text": {"max_characters": full_text_chars}}
    else:
        contents = {"highlights": {"max_characters": highlight_chars}}
    if max_age_hours is not None:
        contents["max_age_hours"] = max_age_hours

    kwargs: dict = {"type": search_type, "num_results": num_results, "contents": contents}
    if include_domains:
        kwargs["include_domains"] = include_domains
    if recent_days:
        kwargs["start_published_date"] = (date.today() - timedelta(days=recent_days)).isoformat()
    if category:
        kwargs["category"] = category

    response = get_exa_client().search(query, **kwargs)

    results = []
    for r in getattr(response, "results", []) or []:
        highlights = getattr(r, "highlights", None) or []
        text = getattr(r, "text", None) or ""
        snippets = [h.strip() for h in highlights if h and h.strip()] or ([text.strip()] if text.strip() else [])
        results.append({
            "title": getattr(r, "title", None) or "",
            "url": getattr(r, "url", "") or "",
            "published": (getattr(r, "published_date", None) or "")[:10],
            "snippets": snippets,
        })
    cost = getattr(response, "cost_dollars", None)
    return {"query": query, "results": results, "cost": getattr(cost, "total", None)}


def _domain(url: str) -> str:
    return urlparse(url).netloc.removeprefix("www.")


def format_evidence(results: list[dict], snippet_chars: int = 300) -> str:
    """Numbered evidence for the model: `[n] domain | title | date` + quoted passages.

    URLs are left out on purpose: the model cites [WEB n] and the code adds the source list,
    which saves tokens and makes it impossible to output an invented link.
    """
    lines = []
    for i, r in enumerate(results, start=1):
        head = f"[{i}] {_domain(r['url'])} | {r['title']}"
        if r.get("published"):
            head += f" | {r['published']}"
        lines.append(head)
        budget = snippet_chars
        for s in r["snippets"]:
            s = " ".join(s.split())[:budget]
            if not s:
                break
            lines.append(f'"{s}"')
            budget -= len(s)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 2. Spending data (pandas; the model never does this arithmetic)
# ---------------------------------------------------------------------------
# Columns expected in the transactions table. Rename here when the real S-Bank dataset arrives.
COL_DATE, COL_AMOUNT, COL_CATEGORY, COL_MERCHANT = "date", "amount", "category", "merchant"

# Category -> basket (1 mandatory regular, 2 mandatory irregular, 3 everyday spending).
BASKETS = {
    "rent": 1, "electricity": 1, "gym": 1, "phone": 1,
    "repairs": 2, "health": 2,
    "groceries": 3, "food_delivery": 3, "coffee": 3, "taxi": 3, "dining_out": 3, "entertainment": 3,
}


def sample_transactions(months: int = 6, seed: int = 7, today: Optional[date] = None) -> pd.DataFrame:
    """Small synthetic transaction table (amounts in EUR, positive = spent). Placeholder for
    the S-Bank dataset so the pipeline can be tested locally."""
    rng = random.Random(seed)
    today = today or date.today()
    rows = []
    d = today - timedelta(days=30 * months)
    while d <= today:
        if d.day == 1:
            rows += [(d, 890.0, "rent", "Landlord"), (d, 39.9, "gym", "Elixia"), (d, 24.9, "phone", "Elisa")]
        if d.day == 15:
            rows.append((d, round(rng.uniform(45, 95), 2), "electricity", "Helen"))
        if rng.random() < 0.55:
            rows.append((d, round(rng.uniform(12, 70), 2), "groceries", rng.choice(["Prisma", "S-market", "Alepa"])))
        if rng.random() < 0.45:
            rows.append((d, round(rng.uniform(3, 6), 2), "coffee", rng.choice(["Espresso House", "Robert's Coffee"])))
        if rng.random() < 0.22:
            rows.append((d, round(rng.uniform(18, 38), 2), "food_delivery", rng.choice(["Wolt", "Foodora"])))
        if rng.random() < 0.10:
            rows.append((d, round(rng.uniform(12, 35), 2), "taxi", rng.choice(["Bolt", "Taksi Helsinki"])))
        if rng.random() < 0.12:
            rows.append((d, round(rng.uniform(25, 80), 2), "dining_out", "Restaurant"))
        if rng.random() < 0.06:
            rows.append((d, round(rng.uniform(12, 45), 2), "entertainment", rng.choice(["Finnkino", "Veikkausliiga"])))
        if rng.random() < 0.008:
            rows.append((d, round(rng.uniform(150, 480), 2), "repairs", "Gigantti"))
        d += timedelta(days=1)
    df = pd.DataFrame(rows, columns=[COL_DATE, COL_AMOUNT, COL_CATEGORY, COL_MERCHANT])
    df[COL_DATE] = pd.to_datetime(df[COL_DATE])
    return df


def load_transactions(path: Optional[str] = None) -> pd.DataFrame:
    """Reads a CSV with the columns above, or returns the synthetic sample if no path is given."""
    if not path:
        return sample_transactions()
    df = pd.read_csv(path)
    df[COL_DATE] = pd.to_datetime(df[COL_DATE])
    return df


def spending_summary(df: pd.DataFrame, category: Optional[str] = None, start_date: Optional[str] = None,
                     end_date: Optional[str] = None, group_by: str = "category") -> dict:
    """Totals of the user's spending for the given filters."""
    d = df
    if start_date:
        d = d[d[COL_DATE] >= pd.Timestamp(start_date)]
    if end_date:
        d = d[d[COL_DATE] <= pd.Timestamp(end_date)]
    if category:
        d = d[d[COL_CATEGORY].str.lower() == category.lower()]
    first = start_date or (str(d[COL_DATE].min().date()) if len(d) else "?")
    last = end_date or (str(d[COL_DATE].max().date()) if len(d) else "?")
    out = {
        "period": f"{first} to {last}",
        "category": category or "all",
        "total_eur": round(float(d[COL_AMOUNT].sum()), 2),
        "transactions": int(len(d)),
    }
    if not len(d):
        out["note"] = f"No transactions. Known categories: {sorted(df[COL_CATEGORY].unique())}"
        return out
    if group_by == "month":
        g = d.groupby(d[COL_DATE].dt.strftime("%Y-%m"))[COL_AMOUNT].sum()
    elif group_by == "basket":
        names = {1: "1_mandatory_regular", 2: "2_mandatory_irregular", 3: "3_everyday"}
        g = d.groupby(d[COL_CATEGORY].map(lambda c: names.get(BASKETS.get(c, 3))))[COL_AMOUNT].sum()
    elif group_by == "merchant":
        g = d.groupby(COL_MERCHANT)[COL_AMOUNT].sum().nlargest(8)
    else:
        g = d.groupby(COL_CATEGORY)[COL_AMOUNT].sum().sort_values(ascending=False)
    out[f"by_{group_by}"] = {k: round(float(v), 2) for k, v in g.items()}
    return out


# ---------------------------------------------------------------------------
# 3. The routing decision: model output + code guardrail
# ---------------------------------------------------------------------------
class Route(BaseModel):
    """What the router returns. Field meanings are in the router prompt (kept out of the
    schema so they are not sent twice)."""
    route: Literal["static", "web", "data", "both", "clarify"]
    lang: str = "en"
    answer: Optional[str] = None
    query: Optional[str] = None
    official: bool = False
    recent_days: Optional[int] = None
    category: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    group_by: Literal["category", "month", "basket", "merchant"] = "category"


def router_prompt(categories: list[str], cutoff: str = MODEL_CUTOFF, today: Optional[date] = None) -> str:
    today = today or date.today()
    return (
        f"You route questions for Kaiku, a finance coach in a Finnish banking app. Today: "
        f"{today.isoformat()}. Your knowledge ends: {cutoff}.\n"
        "Choose by the TYPE of information, not by how sure you feel. Routes:\n"
        "- data: the user's own spending or transactions.\n"
        "- both: needs the user's spending AND an outside fact.\n"
        f"- static: ONLY timeless, non-local knowledge (definitions, how something works, "
        f"arithmetic, history before {cutoff}). Write `answer`: max 3 sentences, user's language.\n"
        "- clarify: too vague to act on. Write one question in `answer`.\n"
        "- web: everything else, and the default. Anything that changes over time (rates, prices, "
        "benefits, taxes, laws, news), depends on a place or institution, is niche (requirements, "
        "deadlines), or will go into a letter, claim or application. When in doubt: web.\n"
        "Fields:\n"
        "- lang: ISO 639-1 code of the user's language.\n"
        "- web/both: `query` = English search query with place, subject and year; `official` = true "
        "for laws, benefits, taxes or central-bank data; `recent_days` only for rates, prices or news.\n"
        f"- data/both: `category` = one of {categories} or null for all; `start_date`/`end_date` "
        "= YYYY-MM-DD resolved from today; `group_by` = category, month, basket or merchant."
    )


ANSWER_PROMPT = (
    "You are Kaiku, a personal finance coach. Answer the QUESTION using ONLY the evidence given.\n"
    "- Lead with the direct answer and one headline figure. Max 4 sentences, unless the user asks "
    "for a document such as a letter.\n"
    "- End every factual sentence with its source: [WEB n] for web source n, [DATA] for the "
    "user's transactions. Do not write URLs or a source list.\n"
    "- If the evidence does not answer the question, say so plainly. Never add facts from your "
    "own knowledge.\n"
    "- No investment advice. Answer in the user's language."
)

NO_RESULT = {
    "en": "I could not find a reliable source for this, so I would rather not guess.",
    "es": "No he encontrado una fuente fiable para esto, así que prefiero no adivinar.",
    "fi": "En löytänyt tälle luotettavaa lähdettä, joten en halua arvata.",
}
SOURCES_WORD = {"en": "Sources", "es": "Fuentes", "fi": "Lähteet"}

# Guardrail markers. If the router says `static` but the question carries one of these, the
# code overrides the decision to `web`. It can only move a decision towards Exa.
_TIME = re.compile(
    r"\b(today|tonight|now|nowadays|current|currently|latest|recent|recently|right now|as of|"
    r"at the moment|this (?:year|month|week)|hoy|ahora|actual|actualmente|vigente|"
    r"este (?:año|mes)|esta semana|últim[oa]s?|tänään|nyt|tällä hetkellä|nykyinen)\b", re.I)
_PLACE = re.compile(
    r"\b(finland|finnish|finlandia|finland[eé]s|suomi|suomen|suomessa|helsinki|espoo|vantaa|"
    r"tampere|turku|oulu|kela|vero|finlex|s-bank|s-pankki|bank of finland)\b", re.I)
_ACTION = re.compile(
    r"\b(letter|claim|complaint|appeal|application|draft|carta|reclamaci[oó]n|recurso|solicitud|"
    r"redacta|kirje|valitus|hakemus)\b", re.I)
_YEAR = re.compile(r"\b(20\d\d)\b")


def force_web(question: str, cutoff: str = MODEL_CUTOFF) -> Optional[str]:
    """Reason why this question must go to Exa even if the router called it static, or None."""
    for name, rx in (("time marker", _TIME), ("place or institution", _PLACE), ("document", _ACTION)):
        m = rx.search(question)
        if m:
            return f"{name}: {m.group(0).lower()}"
    cutoff_year = int(_YEAR.search(cutoff).group(1)) if _YEAR.search(cutoff) else date.today().year
    late = [y for y in map(int, _YEAR.findall(question)) if y >= cutoff_year]
    return f"year at or after cutoff: {late[0]}" if late else None


def _parse_route(text: str) -> Optional[Route]:
    """Fallback parser when the structured output did not validate."""
    m = re.search(r"\{.*\}", text, flags=re.S)
    try:
        return Route.model_validate(json.loads(m.group(0))) if m else None
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# 4. The pipeline
# ---------------------------------------------------------------------------
@dataclass
class Decision:
    route: Route
    decided_by: str               # "model", "guardrail (...)" or "fallback (...)"
    usage: dict = field(default_factory=lambda: {"in": 0, "out": 0, "reasoning": 0})
    seconds: float = 0.0
    cached: bool = False


@dataclass
class Result:
    question: str
    route: str
    decided_by: str
    answer: str = ""              # final text shown to the user (labels + source list)
    body: str = ""                # text written by the model, before the code adds sources
    query: Optional[str] = None
    official: bool = False
    sources: list = field(default_factory=list)   # [{n, title, url, published, snippets}]
    cited: list = field(default_factory=list)     # source numbers used in the answer
    data: Optional[dict] = None
    llm_calls: int = 0            # model calls this question costs (0 if served from cache)
    tokens: dict = field(default_factory=lambda: {"router_in": 0, "router_out": 0, "answer_in": 0,
                                                  "answer_out": 0, "reasoning": 0})
    exa_cost: float = 0.0
    seconds: dict = field(default_factory=dict)   # {route, retrieve, answer}
    notes: list = field(default_factory=list)
    cached: bool = False

    @property
    def total_tokens(self) -> int:
        t = self.tokens
        return t["router_in"] + t["router_out"] + t["answer_in"] + t["answer_out"]

    @property
    def total_seconds(self) -> float:
        return round(sum(self.seconds.values()), 2)


def _norm(q: str) -> str:
    return " ".join(q.lower().split())


class Kaiku:
    """Route -> retrieve -> answer. Use `.ask(question)`; `.route(question)` runs only step 1."""

    def __init__(self, model_name: str = MODEL_NAME, transactions: Optional[pd.DataFrame] = None,
                 num_results: int = 3, highlight_chars: int = 300, search_type: str = "auto",
                 official_domains: Optional[list[str]] = None, cutoff: str = MODEL_CUTOFF,
                 router_thinking: Optional[str] = ROUTER_THINKING,
                 answer_thinking: Optional[str] = ANSWER_THINKING,
                 cache_ttl: int = 900, **model_kwargs):
        self.model_name, self.cutoff = model_name, cutoff
        self.df = transactions if transactions is not None else load_transactions()
        self.categories = sorted(self.df[COL_CATEGORY].unique())
        self.num_results, self.highlight_chars, self.search_type = num_results, highlight_chars, search_type
        self.domains = official_domains or OFFICIAL_DOMAINS
        self.cache_ttl = cache_ttl
        self._cache: dict = {}
        self.stats = {"llm_calls": 0, "exa_calls": 0, "input_tokens": 0, "output_tokens": 0, "exa_cost": 0.0}
        self._router = make_model(model_name, router_thinking, **model_kwargs).with_structured_output(
            Route, include_raw=True)
        self._answerer = make_model(model_name, answer_thinking, **model_kwargs)

    # ---- small helpers ----
    def _get(self, kind: str, key):
        hit = self._cache.get((kind, key))
        return hit[1] if hit and time.time() - hit[0] < self.cache_ttl else None

    def _put(self, kind: str, key, value):
        self._cache[(kind, key)] = (time.time(), value)
        return value

    def _count(self, usage: dict) -> None:
        self.stats["llm_calls"] += 1
        self.stats["input_tokens"] += usage["in"]
        self.stats["output_tokens"] += usage["out"]

    # ---- step 1: route (one model call, cached) ----
    def route(self, question: str) -> Decision:
        cached = self._get("route", _norm(question))
        if cached:
            return Decision(cached.route, cached.decided_by, cached.usage, cached.seconds, cached=True)
        t0 = time.perf_counter()
        out = self._router.invoke([SystemMessage(content=router_prompt(self.categories, self.cutoff)),
                                   HumanMessage(content=question)])
        usage = _usage(out.get("raw"))
        self._count(usage)
        route = out.get("parsed") or _parse_route(message_text(out["raw"]) if out.get("raw") is not None else "")
        decided_by = "model"
        if route is None:  # unreadable decision -> Exa with the question as the query
            route, decided_by = Route(route="web", query=question), "fallback (unreadable decision)"
        elif route.route == "static":
            reason = force_web(question, self.cutoff)
            if reason:
                route = route.model_copy(update={"route": "web", "answer": None})
                decided_by = f"guardrail ({reason})"
            elif not (route.answer or "").strip():
                route = route.model_copy(update={"route": "web"})
                decided_by = "fallback (no static answer)"
        if route.route in ("web", "both") and not (route.query or "").strip():
            route = route.model_copy(update={"query": question})
        d = Decision(route, decided_by, usage, round(time.perf_counter() - t0, 2))
        self._put("route", _norm(question), d)
        return d

    # ---- step 2: retrieve (code only) ----
    def _search(self, query: str, official: bool, recent_days: Optional[int], notes: list):
        """Exa search with cache. Official searches ignore `recent_days` (official pages often
        carry old or missing dates) and fall back to the open web if they return nothing."""
        key = (_norm(query), official, None if official else recent_days)
        hit = self._get("exa", key)
        if hit is not None:
            return hit, 0.0
        cost, results = 0.0, []
        attempts = [(self.domains, None)] if official else []
        attempts.append((None, recent_days))
        for domains, days in attempts:
            try:
                out = search_exa(query, self.num_results, self.highlight_chars, include_domains=domains,
                                 recent_days=days, search_type=self.search_type)
            except Exception as e:  # noqa: BLE001 - a failed search is "no evidence", not a crash
                notes.append(f"Exa error: {type(e).__name__}: {str(e)[:120]}")
                continue
            self.stats["exa_calls"] += 1
            cost += out["cost"] or 0.0
            results = [r for r in out["results"] if r["snippets"]]
            if results:
                break
            if domains:
                notes.append("no official results; searched the open web")
        self.stats["exa_cost"] += cost
        results = [{"n": i, **r} for i, r in enumerate(results, start=1)]
        return self._put("exa", key, results), cost

    # ---- the whole pipeline ----
    def ask(self, question: str) -> Result:
        cached = self._get("result", _norm(question))
        if cached:
            res = copy.deepcopy(cached)
            res.cached, res.llm_calls = True, 0
            return res

        d = self.route(question)
        r = d.route
        res = Result(question, r.route, d.decided_by, query=r.query, official=r.official,
                     llm_calls=1)
        res.tokens.update(router_in=d.usage["in"], router_out=d.usage["out"], reasoning=d.usage["reasoning"])
        res.seconds["route"] = d.seconds
        lang = (r.lang or "en")[:2].lower()

        if r.route in ("static", "clarify"):
            res.body = (r.answer or "").strip()
            res.answer = res.body + (" [MODEL]" if r.route == "static" else "")
            return self._put("result", _norm(question), res)

        t0 = time.perf_counter()
        if r.route in ("web", "both"):
            res.sources, res.exa_cost = self._search(r.query, r.official, r.recent_days, res.notes)
        if r.route in ("data", "both"):
            try:
                res.data = spending_summary(self.df, r.category, r.start_date, r.end_date, r.group_by)
            except Exception as e:  # noqa: BLE001
                res.data = {"error": f"{type(e).__name__}: {e}"}
        res.seconds["retrieve"] = round(time.perf_counter() - t0, 2)

        if r.route == "web" and not res.sources:  # nothing found: say so, no second model call
            res.body = res.answer = NO_RESULT.get(lang, NO_RESULT["en"])
            return res

        parts = [f"QUESTION: {question}"]
        if res.sources:
            parts.append("WEB:\n" + format_evidence(res.sources, self.highlight_chars))
        elif r.route == "both":
            parts.append("WEB: no results found.")
        if res.data is not None:
            parts.append("DATA (EUR, user's transactions): " + json.dumps(res.data, ensure_ascii=False))
        t0 = time.perf_counter()
        msg = self._answerer.invoke([SystemMessage(content=ANSWER_PROMPT), HumanMessage(content="\n\n".join(parts))])
        usage = _usage(msg)
        self._count(usage)
        res.llm_calls += 1
        res.tokens.update(answer_in=usage["in"], answer_out=usage["out"],
                          reasoning=res.tokens["reasoning"] + usage["reasoning"])
        res.seconds["answer"] = round(time.perf_counter() - t0, 2)

        # The source list is written by the code from the numbers the model cited.
        res.body = message_text(msg).strip()
        res.cited = sorted({int(n) for n in re.findall(r"\[WEB\s*(\d+)\]", res.body)
                            if 1 <= int(n) <= len(res.sources)})
        res.answer = res.body
        if res.cited:
            lines = [f"{s['n']}. {s['title']} - {s['url']}" for s in res.sources if s["n"] in res.cited]
            res.answer += f"\n\n{SOURCES_WORD.get(lang, 'Sources')}:\n" + "\n".join(lines)
        return self._put("result", _norm(question), res)


def create_agent(model_name: str = MODEL_NAME, transactions: Optional[pd.DataFrame] = None, **kwargs) -> Kaiku:
    """Builds the Kaiku pipeline. See `Kaiku.__init__` for the options."""
    return Kaiku(model_name=model_name, transactions=transactions, **kwargs)


def run_agent(agent: Kaiku, question: str) -> str:
    """Runs one question and returns the final answer text."""
    return agent.ask(question).answer


def main() -> None:
    """Usage: python kaiku_agent.py "your question" (asks for it if no argument is given)."""
    question = " ".join(sys.argv[1:]).strip() or input("Question: ").strip()
    if not question:
        raise SystemExit("No question given.")
    res = create_agent().ask(question)
    print(f"\n[{res.route} | {res.decided_by} | {res.llm_calls} calls | {res.total_tokens} tokens | "
          f"{res.total_seconds}s]\n\n{res.answer}")


if __name__ == "__main__":
    main()
