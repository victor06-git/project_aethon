"""Kaiku Finance: a fixed route -> retrieve -> answer pipeline (at most 2 model calls per question).

    question
       |
    1. ROUTE     one small Gemini call -> a typed decision (route + search/data parameters)
       |         + a code guardrail that can only push a decision TOWARDS the web
       |
       |-- static   -> the router already wrote the answer from training      [MODEL]  1 call
       |-- clarify  -> the router asks one question back                               1 call
       |-- web      -> Exa: official sources + open web   -> 2. ANSWER         [WEB n] 2 calls
       |-- data     -> pandas totals and monthly averages -> 2. ANSWER         [DATA]  2 calls
       `-- both     -> Exa + pandas                       -> 2. ANSWER                 2 calls

Rules of the house:
    - Exa is the base: `web` is the default route; every doubt or failure goes to Exa.
    - Official sources first: every search queries the official domains and the open web in
      parallel, official results are listed first and tagged OFFICIAL, and when several sources
      back the same sentence the official one is kept.
    - Gemini only interprets the prompt and writes from the evidence. Searching, arithmetic
      ({{ }} expressions are computed by the app), source numbering, the source list and the
      checks are done in code.
    - Documents (letters, emails) quote the source word for word and carry their references at
      the end; quotes are verified against the source text.

Contains:
    1. search_exa / retrieve_web     -> Exa calls and the official-first evidence
    2. spending_summary              -> totals and monthly averages of the user's transactions
    3. Route + force_web             -> the router's decision and the code guardrail
    4. apply_calcs / finish_*        -> post-processing of the model's text (code only)
    5. Kaiku / create_agent          -> the pipeline: .route(question) and .ask(question)
"""

import ast
import copy
import difflib
import getpass
import json
import operator
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
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
ANSWER_THINKING: Optional[str] = "minimal"

QUOTE_CHARS = 20  # length of the source fragment shown in the source list

# Official / authoritative sources. Subdomains match too (laskurit.kela.fi, ecb.europa.eu).
OFFICIAL_DOMAINS = [
    "finlex.fi",              # legislation
    "kela.fi",                # benefits
    "vero.fi",                # taxes
    "suomenpankki.fi",        # central bank, Euribor and interest rates
    "stat.fi",                # Statistics Finland
    "tilastokeskus.fi",       # Statistics Finland (Finnish domain)
    "kkv.fi",                 # consumer authority (rent and consumer disputes)
    "kuluttajariita.fi",      # Consumer Disputes Board
    "finanssivalvonta.fi",    # financial supervisor
    "vm.fi",                  # Ministry of Finance
    "oikeus.fi",              # courts and legal aid
    "suomi.fi",               # public services portal
    "infofinland.fi",         # official guidance in several languages
    "europa.eu",              # EU institutions, ECB, Eurostat
]

TEXT = {
    "en": {"sources": "Sources", "references": "References", "official": "OFFICIAL",
           "published": "published", "no_date": "no date", "data": "Your bank transactions",
           "tx": "transactions", "model": "Model's general knowledge (no external source)",
           "no_result": "I could not find a reliable source for this, so I would rather not guess.",
           "searched": "No source answered this. Searched"},
    "es": {"sources": "Fuentes", "references": "Referencias", "official": "OFICIAL",
           "published": "publicado", "no_date": "sin fecha", "data": "Tus movimientos bancarios",
           "tx": "movimientos", "model": "Conocimiento general del modelo (sin fuente externa)",
           "no_result": "No he encontrado una fuente fiable para esto, así que prefiero no adivinar.",
           "searched": "Ninguna fuente responde a esto. Consultadas"},
    "fi": {"sources": "Lähteet", "references": "Lähteet", "official": "VIRALLINEN",
           "published": "julkaistu", "no_date": "ei päivämäärää", "data": "Omat tilitapahtumasi",
           "tx": "tapahtumaa", "model": "Mallin yleistieto (ei ulkoista lähdettä)",
           "no_result": "En löytänyt tälle luotettavaa lähdettä, joten en halua arvata.",
           "searched": "Mikään lähde ei vastannut tähän. Haettu"},
}


def T(lang: str, key: str) -> str:
    return TEXT.get(lang, TEXT["en"])[key]


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
               temperature: Optional[float] = None, include_thoughts: bool = False, **model_kwargs):
    """Chat model. Gemini goes through `langchain-google-genai` with the key in GEMINI_API_KEY.

    thinking: effort for Gemini ("minimal".."high"); mapped to `thinking_level` on Gemini 3+
        and to `thinking_budget` on Gemini 2.5. None keeps the model default.
    include_thoughts: ask Gemini to return a summary of its reasoning (shown by the trace tool).
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
        if include_thoughts:
            model_kwargs.setdefault("include_thoughts", True)
    if temperature is not None:
        model_kwargs["temperature"] = temperature
    return init_chat_model(model_name, **model_kwargs)


def message_text(m) -> str:
    """Text of a message; if the content comes in blocks, joins the text blocks only."""
    c = getattr(m, "content", "")
    if isinstance(c, list):
        c = "".join(b.get("text", "") if isinstance(b, dict) and b.get("type", "text") == "text"
                    else (b if isinstance(b, str) else "") for b in c)
    return c or ""


def message_thoughts(m) -> str:
    """Reasoning summary of a message, when the model was created with include_thoughts=True."""
    c = getattr(m, "content", None)
    out = []
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") in ("thinking", "reasoning"):
                out.append(str(b.get("thinking") or b.get("reasoning") or b.get("text") or ""))
    return "\n".join(x for x in out if x).strip()


def _usage(m) -> dict:
    u = getattr(m, "usage_metadata", None) or {}
    return {"in": u.get("input_tokens", 0) or 0, "out": u.get("output_tokens", 0) or 0,
            "reasoning": (u.get("output_token_details") or {}).get("reasoning", 0) or 0}


# ---------------------------------------------------------------------------
# 1. Exa: one search, and the official-first retrieval (code only)
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


def is_official(url: str, domains: Optional[list[str]] = None) -> bool:
    d = _domain(url).lower()
    return any(d == x or d.endswith("." + x) for x in (domains or OFFICIAL_DOMAINS))


def retrieve_web(query: str, official_results: int = 2, web_results: int = 2, highlight_chars: int = 300,
                 recent_days: Optional[int] = None, search_type: str = "auto",
                 domains: Optional[list[str]] = None) -> dict:
    """Official-first evidence for a query.

    Runs two Exa searches in parallel: one restricted to the official domains and one on the
    open web. Results are merged without duplicates, official ones first, and numbered.
    `recent_days` applies only to the open web: official pages often carry old or no dates.

    Returns {"sources": [{n, official, domain, title, url, published, text}], "cost",
             "searches": [{scope, results, cost | error}], "notes"}.
    """
    domains = domains or OFFICIAL_DOMAINS
    get_exa_client()  # create the client before the threads start
    jobs = {}
    if official_results:
        jobs["official"] = {"num_results": official_results, "include_domains": domains}
    if web_results:
        jobs["open web"] = {"num_results": web_results, "recent_days": recent_days}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {scope: pool.submit(search_exa, query, highlight_chars=highlight_chars,
                                      search_type=search_type, **kw) for scope, kw in jobs.items()}
    searches, raw, notes, cost = [], [], [], 0.0
    for scope, fut in futures.items():
        try:
            out = fut.result()
        except Exception as e:  # noqa: BLE001 - a failed search is "no evidence", not a crash
            searches.append({"scope": scope, "results": 0, "error": f"{type(e).__name__}: {str(e)[:100]}"})
            notes.append(f"Exa {scope} search failed: {type(e).__name__}")
            continue
        cost += out["cost"] or 0.0
        searches.append({"scope": scope, "results": len(out["results"]), "cost": out["cost"]})
        raw += out["results"]

    seen, merged = set(), []
    for r in raw:
        text = " ".join(" ".join(r["snippets"]).split())[:highlight_chars]
        key = r["url"].split("#")[0].rstrip("/")
        if not text or key in seen:
            continue
        seen.add(key)
        merged.append({"official": is_official(r["url"], domains), "domain": _domain(r["url"]),
                       "title": " ".join((r["title"] or "").split()) or _domain(r["url"]),
                       "url": r["url"], "published": r["published"], "text": text})
    merged.sort(key=lambda s: not s["official"])  # stable sort: official sources first
    return {"sources": [{"n": i, **s} for i, s in enumerate(merged, start=1)],
            "cost": cost, "searches": searches, "notes": notes}


def format_evidence(sources: list[dict]) -> str:
    """Numbered evidence for the model: `[n] OFFICIAL|web | domain | title | date` + the passage.

    URLs are left out on purpose: the model cites [WEB n] and the code writes the source list,
    which saves tokens and makes it impossible to output an invented link.
    """
    lines = []
    for s in sources:
        head = f"[{s['n']}] {'OFFICIAL' if s['official'] else 'web'} | {s['domain']} | {s['title'][:80]}"
        if s.get("published"):
            head += f" | {s['published']}"
        lines += [head, f'"{s["text"]}"']
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
_BASKET_NAMES = {1: "1_mandatory_regular", 2: "2_mandatory_irregular", 3: "3_everyday"}


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


def _group_keys(d: pd.DataFrame, group_by: str):
    if group_by == "month":
        return d[COL_DATE].dt.strftime("%Y-%m")
    if group_by == "basket":
        return d[COL_CATEGORY].map(lambda c: _BASKET_NAMES.get(BASKETS.get(c, 3)))
    if group_by == "merchant":
        return d[COL_MERCHANT]
    return d[COL_CATEGORY]


def spending_summary(df: pd.DataFrame, category: Optional[str] = None, start_date: Optional[str] = None,
                     end_date: Optional[str] = None, group_by: str = "category") -> dict:
    """Totals of the user's spending, plus monthly averages over the complete calendar months
    of the period (so "per month", "per year" and what-if questions get figures computed here)."""
    lo, hi = df[COL_DATE].min().normalize(), df[COL_DATE].max().normalize()
    p0 = max(pd.Timestamp(start_date), lo) if start_date else lo
    p1 = min(pd.Timestamp(end_date), hi) if end_date else hi
    d = df[(df[COL_DATE] >= p0) & (df[COL_DATE] <= p1)]
    if category:
        d = d[d[COL_CATEGORY].str.lower() == category.lower()]
    out = {
        "period": f"{p0.date()} to {p1.date()}",
        "category": category or "all",
        "total_eur": round(float(d[COL_AMOUNT].sum()), 2),
        "transactions": int(len(d)),
    }
    if not len(d):
        out["note"] = f"No transactions. Known categories: {sorted(df[COL_CATEGORY].unique())}"
        return out

    g = d.groupby(_group_keys(d, group_by))[COL_AMOUNT].sum()
    if group_by == "merchant":
        g = g.nlargest(8)
    elif group_by != "month":
        g = g.sort_values(ascending=False)
    out[f"by_{group_by}"] = {k: round(float(v), 2) for k, v in g.items()}

    full = [m for m in pd.period_range(p0, p1, freq="M")
            if m.start_time >= p0 and m.end_time.normalize() <= p1]
    if len(full) >= 2:
        in_full = d[d[COL_DATE].dt.to_period("M").isin(full)]
        avg = float(in_full[COL_AMOUNT].sum()) / len(full)
        out["complete_months"] = len(full)
        out["avg_per_month_eur"] = round(avg, 2)
        out["per_year_eur"] = round(avg * 12, 2)
        if group_by != "month" and len(in_full):
            g2 = in_full.groupby(_group_keys(in_full, group_by))[COL_AMOUNT].sum() / len(full)
            g2 = g2[[k for k in g.index if k in g2.index]]
            out[f"avg_per_month_by_{group_by}"] = {k: round(float(v), 2) for k, v in g2.items()}
    return out


# ---------------------------------------------------------------------------
# 3. The routing decision: model output + code guardrail
# ---------------------------------------------------------------------------
class Route(BaseModel):
    """What the router returns. Field meanings are in the router prompt (kept out of the
    schema so they are not sent twice)."""
    route: Literal["static", "web", "data", "both", "clarify"]
    why: str = ""
    lang: str = "en"
    document: bool = False
    answer: Optional[str] = None
    query: Optional[str] = None
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
        "- static: ONLY timeless, non-local knowledge (definitions, how something works, "
        "arithmetic). Write `answer`: max 3 sentences, user's language.\n"
        "- clarify: too vague to act on. Write one question in `answer`.\n"
        "- web: everything else, and the default. Anything that changes over time (rates, prices, "
        "benefits, taxes, laws, statistics, news), depends on a place or institution, or is niche "
        "(requirements, deadlines). When in doubt: web.\n"
        "Fields:\n"
        "- why: 3-6 words naming the type of information.\n"
        "- lang: ISO 639-1 code of the user's language.\n"
        "- document: true if the user asks you to write a letter, email, claim or application. "
        "A document is never static or data: use web or both.\n"
        "- web/both: `query` = English search query with place, subject, year and the unit the "
        "user needs (per m2, per month...); `recent_days` only for rates, prices or news.\n"
        f"- data/both: `category` = one of {categories} or null for all; `start_date`/`end_date` "
        "= YYYY-MM-DD resolved from today, null for the whole history; `group_by` = category, "
        "month, basket or merchant (month for averages, comparisons and what-if questions)."
    )


ANSWER_PROMPT = (
    "You are Kaiku, a personal finance coach. Answer the QUESTION using ONLY the evidence given.\n"
    "- Lead with the direct answer and one headline figure. Max 4 sentences.\n"
    "- Sources: end each fact with its tag, [WEB n] for web source n or [DATA] for the user's "
    "transactions. One web source per fact, never several tags together. Prefer sources marked "
    "OFFICIAL; if sources disagree, trust the OFFICIAL one. Never write URLs or a source list.\n"
    "- Scale: answer on the user's scale. If the question or DATA gives a quantity (a flat size "
    "in m2, a number of people or months, a monthly amount), convert unit values to it and give "
    "the complete figure and the comparison, never only the unit value. If a needed quantity is "
    "missing, ask for it.\n"
    "- Arithmetic: never calculate yourself. Write the expression in double braces with plain "
    "numbers, like {{A*B}} or {{abs(A-B*C)}} with the real numbers in place of the letters; the "
    "app replaces it with the result.\n"
    "- If the evidence does not answer the question at all, reply NO_EVIDENCE followed by one "
    "sentence in the user's language saying no reliable source was found. Never add facts from "
    "your own knowledge.\n"
    "- No investment advice. Answer in the user's language."
)

DOC_PROMPT = (
    "You are Kaiku, a personal finance coach. Write the document the user asks for (letter or "
    "email), ready to send, using ONLY the evidence given. Today: {today}.\n"
    "- Structure: subject, greeting, the facts, the rule, a clear request with a deadline, "
    "closing, signature. Use [square-bracket placeholders] for personal details you do not know.\n"
    "- Quote the rule that supports the request word for word from a web source, in double "
    "quotes, once or twice, max 25 words each. Copy the words exactly, do not translate them. "
    "Prefer sources marked OFFICIAL. Use double quotes only for text copied from a source.\n"
    "- Do not write [WEB n] tags, URLs or a source list inside the document. After the signature "
    "add one last line with the sources you used, like: USED: 1, 3\n"
    "- Arithmetic: never calculate yourself; write {{expression}} with plain numbers.\n"
    "- If the evidence does not support the request, reply NO_EVIDENCE followed by one sentence "
    "in the user's language.\n"
    "- Write in the user's language."
)

# Guardrail markers. If the router says `static` but the question carries one of these, the
# code overrides the decision to `web`. It can only move a decision towards Exa.
_TIME = re.compile(
    r"\b(today|tonight|now|nowadays|current|currently|latest|recent|recently|right now|as of|"
    r"at the moment|this (?:year|month|week)|hoy|ahora|actual|actualmente|vigente|"
    r"este (?:año|mes)|esta semana|últim[oa]s?|tänään|nyt|tällä hetkellä|nykyinen)\b", re.I)
_PLACE = re.compile(
    r"\b(finland|finnish|finlandia|finland[eé]s|suomi|suomen|suomessa|helsinki|espoo|vantaa|"
    r"tampere|turku|oulu|kela|vero|finlex|s-bank|s-pankki|bank of finland|ecb|bce)\b", re.I)
_ACTION = re.compile(
    r"\b(letter|email|e-mail|claim|complaint|appeal|application|draft|carta|correo|"
    r"reclamaci[oó]n|recurso|solicitud|redacta|kirje|sähköposti|valitus|hakemus)\b", re.I)
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
# 4. Post-processing of the model's text (code only)
# ---------------------------------------------------------------------------
# ---- 4a. Calculator: {{ expression }} -> result ----
_CALC = re.compile(r"\{\{(.+?)\}\}", re.S)
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
_FUNCS = {"abs": abs, "round": round, "min": min, "max": max}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _eval(node.operand)
        return -v if isinstance(node.op, ast.USub) else v
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS
            and not node.keywords):
        return _FUNCS[node.func.id](*[_eval(a) for a in node.args])
    raise ValueError("only numbers, + - * / ( ) and abs/round/min/max are allowed")


def safe_calc(expr: str) -> float:
    """Evaluates an arithmetic expression without `eval`.

    Units and currency signs are ignored ("80 m2 * 21.34 €"), "x" between numbers means
    times and "25.5%" means 25.5/100. Anything it cannot read safely raises an error instead
    of guessing: the caller then leaves the expression in the text and reports it.
    """
    clean = expr.replace("×", "*").replace("·", "*").replace("÷", "/").replace("−", "-")
    clean = re.sub(r"(?<=[\d)\s])[xX](?=[\s(\d])", "*", clean)
    clean = re.sub(r"(?<=\d)\s*%", "/100", clean)
    clean = re.sub(r"[A-Za-z_][\w²]*", lambda m: m.group(0) if m.group(0) in _FUNCS else " ", clean)
    clean = re.sub(r"[€$£²]", " ", clean)
    if not any(f + "(" in clean.replace(" ", "") for f in _FUNCS):  # no function call: commas are number marks
        clean = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", clean)      # 1,707 -> 1707
        clean = re.sub(r"(?<=\d),(?=\d{1,2}(?!\d))", ".", clean)   # 21,34 -> 21.34
    return float(_eval(ast.parse(clean.strip(), mode="eval")))


def fmt_number(v: float, lang: str = "en") -> str:
    """1,707.20 in English, 1.707,20 in Spanish, 1 707,20 in Finnish. Whole numbers lose the decimals."""
    s = f"{int(round(v)):,}" if abs(v - round(v)) < 1e-9 else f"{v:,.2f}"
    if lang in ("es", "de", "it", "pt", "nl"):
        s = s.replace(",", "§").replace(".", ",").replace("§", ".")
    elif lang in ("fi", "sv", "fr"):
        s = s.replace(",", "\u00a0").replace(".", ",")
    return s


def apply_calcs(text: str, lang: str = "en") -> tuple[str, list]:
    """Replaces every {{expression}} with its result. Returns (text, [{expr, value, shown}])."""
    calcs = []

    def repl(m):
        expr = " ".join(m.group(1).split())
        try:
            value = safe_calc(expr)
        except Exception as e:  # noqa: BLE001
            calcs.append({"expr": expr, "error": (str(e) or type(e).__name__)[:80]})
            return expr
        calcs.append({"expr": expr, "value": value, "shown": fmt_number(value, lang)})
        return calcs[-1]["shown"]

    return _CALC.sub(repl, text), calcs


# ---- 4b. Fragments: which part of a source backs a claim ----
def clip(text: str, max_chars: int) -> str:
    text = " ".join(text.split())
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    sp = cut.rfind(" ")
    if sp >= max_chars * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:.") + "…"


def _window(text: str, start: int, length: int, max_chars: int) -> str:
    """At most `max_chars` of `text` around text[start:start+length], cut at word boundaries."""
    if length >= max_chars:
        a, b = start, start + max_chars
    else:
        a = max(0, start - (max_chars - length) // 2)
        while 0 < a < start and text[a - 1].isalnum():
            a += 1
        b = min(len(text), a + max_chars)
        if b < len(text) and text[b - 1].isalnum() and text[b].isalnum():
            sp = text.rfind(" ", start + length, b)
            if sp > 0:
                b = sp
    return ("…" if a > 0 else "") + text[a:b].strip() + ("…" if b < len(text) else "")


def used_fragment(claim: str, source_text: str, max_chars: int = QUOTE_CHARS) -> tuple[str, bool]:
    """The piece of the source that backs the claim: (fragment, matched).

    Looks first for a figure of the claim inside the source, then for the longest run of
    shared words, then for a distinctive shared word. matched=False means nothing in common
    was found and the fragment is just the start of the source.
    """
    text = " ".join(source_text.split())
    figures = sorted(set(re.findall(r"\d+(?:[.,]\d+)*", claim)),
                     key=lambda t: (("." in t or "," in t), len(t)), reverse=True)
    for t in figures:
        if len(t) < 2:
            continue
        for variant in dict.fromkeys([t, t.replace(".", ","), t.replace(",", ".")]):
            m = re.search(r"(?<![\d.,])" + re.escape(variant) + r"(?!\d)", text)
            if m:
                return _window(text, m.start(), len(variant), max_chars), True
    cw = [w.lower() for w in re.findall(r"\w+", claim)]
    spans = [(m.group(0).lower(), m.start(), m.end()) for m in re.finditer(r"\w+", text)]
    if cw and spans:
        mt = difflib.SequenceMatcher(None, cw, [s[0] for s in spans], autojunk=False).find_longest_match(
            0, len(cw), 0, len(spans))
        if mt.size >= 3:
            start, end = spans[mt.b][1], spans[mt.b + mt.size - 1][2]
            return _window(text, start, end - start, max_chars), True
        words = {s[0]: s for s in reversed(spans)}
        for w in sorted({w for w in cw if len(w) >= 6}, key=len, reverse=True):
            if w in words:
                return _window(text, words[w][1], len(w), max_chars), True
    return clip(text, max_chars), False


def _canon(s: str) -> str:
    return " ".join(re.findall(r"\w+", s.lower()))


def match_quote(quote: str, source_text: str) -> Optional[str]:
    """"exact" if the quote is in the source word for word (punctuation and case ignored,
    "..." allowed between parts), "partial" if most of it is one contiguous run, else None."""
    src = f" {_canon(source_text)} "
    parts = [p for p in (_canon(p) for p in re.split(r"\[\.\.\.\]|\.\.\.|…", quote)) if p]
    if parts and all(f" {p} " in src for p in parts):
        return "exact"
    qw, sw = _canon(quote).split(), src.split()
    if qw and sw:
        mt = difflib.SequenceMatcher(None, qw, sw, autojunk=False).find_longest_match(0, len(qw), 0, len(sw))
        if mt.size >= max(4, int(0.6 * len(qw))):
            return "partial"
    return None


# ---- 4c. Source tags: one per fact, official preferred, numbered 1..k in order of use ----
_ONE = r"\[WEB\s*\d[\d\s,;&]*\]"  # needs a number, so "[Website]" placeholders are left alone
_TAG_NUMS = re.compile(r"\[WEB\s*(\d[\d\s,;&]*)\]", re.I)
_RUN = re.compile(_ONE + r"(?:\s*(?:,|;|&|and|y|ja)?\s*" + _ONE + r")*", re.I)
_BARE = re.compile(r"\[WEB\s*\]", re.I)
_TAGS_OR_DATA = re.compile("(?:" + _RUN.pattern + r")|\[DATA\]", re.I)
_USED = re.compile(r"^[ \t]*USED\s*:?\s*([\d\s,;&]*)[ \t]*$", re.I | re.M)
_QUOTE = re.compile(r'["“«]([^"“”«»\n]{12,400})["”»]')


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]+([.,;:])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _claim_figures(claim: str) -> list[str]:
    """Distinctive figures of a claim (decimals first), without small integers and years."""
    out = []
    for t in set(re.findall(r"\d+(?:[.,]\d+)*", claim)):
        if t.isdigit() and (int(t) <= 31 or 1900 <= int(t) <= 2100):
            continue
        out.append(t)
    return sorted(out, key=lambda t: (("." in t or "," in t), len(t)), reverse=True)


def _has_figure(text: str, figure: str) -> bool:
    return any(re.search(r"(?<![\d.,])" + re.escape(v) + r"(?!\d)", text)
               for v in dict.fromkeys([figure, figure.replace(".", ","), figure.replace(",", ".")]))


def _pick_source(claim: str, candidates: list[int], sources: list[dict]) -> tuple[int, Optional[str]]:
    """The one source a fact should cite: (chosen, note or None).

    Among the sources the model cited, one that carries a figure of the claim wins, then an
    official one. Two corrections are made in code, and reported:
    - official preferred: the winner is not official but an official source carries the same
      key figure -> the citation moves to the official source;
    - repair: none of the cited sources carries the key figure of the claim but another
      source does -> the citation moves to the source that actually has it.
    """
    by_n = {s["n"]: s for s in sources}
    figures = _claim_figures(claim)

    def carried(n):
        return [t for t in figures if _has_figure(by_n[n]["text"], t)]

    best = sorted(candidates, key=lambda n: (not carried(n), not by_n[n]["official"]))[0]
    shared = carried(best)
    if shared and not by_n[best]["official"]:
        for s in sources:
            if s["official"] and _has_figure(s["text"], shared[0]):
                return s["n"], f"official source preferred: citation moved from source {best} to source {s['n']}"
    if not shared:
        key = next((t for t in figures if "." in t or "," in t or len(t) >= 4), None)
        for s in sources if key else []:  # sources are ordered official first
            if s["n"] != best and _has_figure(s["text"], key):
                return s["n"], f"citation repaired: {key} is in source {s['n']}, not in source {best}"
    return best, None


def finish_answer(text: str, sources: list[dict], quote_chars: int = QUOTE_CHARS) -> dict:
    """Cleans the tags of a normal answer (call it before the calculations are replaced, so
    the figures inside {{ }} can be matched against the sources).

    - a run of tags ("[WEB 1], [WEB 2], [WEB 3]") becomes one tag: the source that carries
      the figure of the sentence, official sources first;
    - a fact cited from a non-official source moves to an official one that has the same figure;
    - tags pointing to sources that do not exist are removed and reported;
    - sources are renumbered 1..k in the order they are first cited, so the list never
      starts at 2 or skips a number.
    Returns {"text", "cited": [{k, n, fragment, matched}], "quotes": [], "notes"}.
    """
    by_n = {s["n"]: s for s in sources}
    notes = []
    if _BARE.search(text):
        notes.append("tags: web tag without a source number")
        text = _BARE.sub("", text)

    pieces, order, claims, last = [], [], {}, 0
    for m in _TAGS_OR_DATA.finditer(text):
        claim = text[last:m.start()]
        pieces.append(claim)
        last = m.end()
        if m.group(0).upper() == "[DATA]":
            pieces.append("[DATA]")
            continue
        ns = list(dict.fromkeys(int(x) for x in re.findall(r"\d+", m.group(0))))
        valid = [n for n in ns if n in by_n]
        if len(valid) < len(ns) and "tags: cited a source number that does not exist" not in notes:
            notes.append("tags: cited a source number that does not exist")
        if not valid:
            continue
        n, note = _pick_source(claim, valid, sources)
        if note and note not in notes:
            notes.append(note)
        if n not in order:
            order.append(n)
        claims.setdefault(n, []).append(claim)
        pieces.append(("WEB", n))
    pieces.append(text[last:])
    new = {old: k for k, old in enumerate(order, start=1)}
    text = _tidy("".join(p if isinstance(p, str) else f"[WEB {new[p[1]]}]" for p in pieces))
    cited = []
    for old in order:
        fragment, matched = used_fragment(" ".join(claims[old]), by_n[old]["text"], quote_chars)
        cited.append({"k": new[old], "n": old, "fragment": fragment, "matched": matched})
    return {"text": text, "cited": cited, "quotes": [], "notes": notes}


def finish_document(text: str, sources: list[dict], quote_chars: int = QUOTE_CHARS) -> dict:
    """Cleans a document (letter, email).

    - removes the `USED:` line and any [WEB n] tag from the body;
    - finds every direct quote and checks it against the sources (official ones first);
    - puts a reference number after each verified quote and numbers the references 1..k.
    Returns {"text", "cited": [{k, n, fragment, matched}], "quotes": [{quote, n, match}], "notes"}.
    """
    by_n = {s["n"]: s for s in sources}
    listed = [int(x) for m in _USED.finditer(text) for x in re.findall(r"\d+", m.group(1))]
    text = _USED.sub("", text)
    listed += [int(x) for m in _TAG_NUMS.finditer(text) for x in re.findall(r"\d+", m.group(1))]
    text = _tidy(_BARE.sub("", _RUN.sub("", text)))
    notes = ["tags: cited a source number that does not exist"] if any(n not in by_n for n in listed) else []

    quotes, order = [], []
    for m in _QUOTE.finditer(text):
        q = m.group(1).strip()
        found = None
        for s in sources:  # sources are already ordered official first
            kind = match_quote(q, s["text"])
            if kind == "exact":
                found = (s["n"], kind)
                break
            if kind == "partial" and found is None:
                found = (s["n"], kind)
        quotes.append({"quote": q, "n": found[0] if found else None,
                       "match": found[1] if found else None, "_end": m.end()})
        if found and found[0] not in order:
            order.append(found[0])
    order += [n for n in dict.fromkeys(listed) if n in by_n and n not in order]
    new = {old: k for k, old in enumerate(order, start=1)}
    for q in reversed(quotes):  # right to left so the positions stay valid
        if q["n"] is not None:
            text = text[:q["_end"]] + f" [{new[q['n']]}]" + text[q["_end"]:]
    cited = []
    for old in order:
        mine = [q for q in quotes if q["n"] == old]
        if mine:
            fragment, matched = clip(mine[0]["quote"], quote_chars), True
        else:
            fragment, matched = used_fragment(text, by_n[old]["text"], quote_chars)
        cited.append({"k": new[old], "n": old, "fragment": fragment, "matched": matched})
    for q in quotes:
        q.pop("_end")
    return {"text": text.strip(), "cited": cited, "quotes": quotes, "notes": notes}


def sources_block(cited: list[dict], sources: list[dict], lang: str = "en", style: str = "web",
                  data: Optional[dict] = None, model: bool = False) -> str:
    """The source list, always with the same structure:

        Sources
        [WEB 1] OFFICIAL | kela.fi | published 2026-01-02
                Title of the page
                "fragment used…"
                https://...
        [DATA] Your bank transactions | 2026-10-01 to 2026-10-31 | 2 transactions

    style="doc" writes "References" and plain [1] numbers, for the end of a letter or email.
    """
    by_n = {s["n"]: s for s in sources}
    lines = [T(lang, "references" if style == "doc" else "sources")]
    for c in cited:
        s = by_n[c["n"]]
        tag = f"[{c['k']}]" if style == "doc" else f"[WEB {c['k']}]"
        pad = " " * (len(tag) + 1)
        when = f"{T(lang, 'published')} {s['published']}" if s["published"] else T(lang, "no_date")
        lines.append(f"{tag} {T(lang, 'official') if s['official'] else 'WEB'} | {s['domain']} | {when}")
        if s["title"] != s["domain"]:
            lines.append(f"{pad}{s['title'][:90]}")
        lines += [f'{pad}"{c["fragment"]}"', f"{pad}{s['url']}"]
    if data is not None:
        lines.append(f"[DATA] {T(lang, 'data')} | {data.get('period', '')} | "
                     f"{data.get('transactions', 0)} {T(lang, 'tx')}")
    if model:
        lines.append(f"[MODEL] {T(lang, 'model')}")
    return "\n".join(lines) if len(lines) > 1 else ""


# ---- 4d. Checks ----
_URL = re.compile(r"https?://[^\s)\]>\"']+")
_NUMS = re.compile(r"\d+(?:[.,]\d+)*")
_DOTTED_DATE = re.compile(r"^\d{1,2}\.\d{1,2}\.\d{2,4}$")


def _interpretations(tok: str) -> list[tuple[float, int]]:
    """Possible values of a number as written, with its decimals: "1,242" -> 1242 or 1.242."""
    seps = [c for c in tok if c in ".,"]
    if not seps:
        return [(float(tok), 0)]
    last = max(tok.rfind("."), tok.rfind(","))
    decimals = len(tok) - last - 1
    as_decimal = float(re.sub(r"[.,]", "", tok[:last]) + "." + tok[last + 1:])
    as_thousands = float(re.sub(r"[.,]", "", tok))
    if len(set(seps)) == 2:
        return [(as_decimal, decimals)]
    if len(seps) > 1:
        return [(as_thousands, 0)]
    if decimals == 3:
        return [(as_decimal, 3), (as_thousands, 0)]
    return [(as_decimal, decimals)]


def figures_check(body: str, allowed_text: str) -> dict:
    """Heuristic grounding check: every significant figure the model wrote (including the
    operands of its {{ }} expressions) should appear in the question, the web evidence or the
    data. Small integers (<= 31) and years are skipped. Returns {"checked", "ungrounded"}."""
    allowed = [v for tok in _NUMS.findall(allowed_text) for v, _ in _interpretations(tok)]
    claim = re.sub(r"\[(?:WEB[^\]]*|DATA|MODEL|\d+)\]", " ", body)
    claim = _USED.sub(" ", claim).replace("{{", " ").replace("}}", " ")
    checked, bad = 0, []
    for tok in _NUMS.findall(claim):
        if _DOTTED_DATE.match(tok):
            continue
        interps = _interpretations(tok)
        if all(dec == 0 and (v <= 31 or 1900 <= v <= 2100) for v, dec in interps):
            continue
        checked += 1
        if not any(abs(a - v) <= 0.5 * 10 ** -dec + 1e-9 for v, dec in interps for a in allowed):
            bad.append(tok)
    return {"checked": checked, "ungrounded": bad}


# ---------------------------------------------------------------------------
# 5. The pipeline
# ---------------------------------------------------------------------------
@dataclass
class Decision:
    route: Route
    decided_by: str               # "model", "guardrail (...)" or "fallback (...)"
    usage: dict = field(default_factory=lambda: {"in": 0, "out": 0, "reasoning": 0})
    seconds: float = 0.0
    cached: bool = False
    info: dict = field(default_factory=dict)   # model_route, guardrail, thoughts


@dataclass
class Result:
    question: str
    route: str
    decided_by: str
    lang: str = "en"
    document: bool = False
    answer: str = ""              # final text for the user: answer or document + source list
    text: str = ""                # the answer or document without the source list
    body: str = ""                # raw text written by the model
    query: Optional[str] = None
    sources: list = field(default_factory=list)   # [{n, official, domain, title, url, published, text}]
    cited: list = field(default_factory=list)     # [{k, n, fragment, matched}] in citation order
    data: Optional[dict] = None
    calcs: list = field(default_factory=list)     # [{expr, value, shown}]
    quotes: list = field(default_factory=list)    # documents: [{quote, n, match}]
    checks: dict = field(default_factory=dict)    # labels, figures, quotes, official_cited
    no_evidence: bool = False
    thinking: Optional[str] = None                # thinking level of the answer step
    llm_calls: int = 0            # model calls this question costs (0 if served from cache)
    tokens: dict = field(default_factory=lambda: {"router_in": 0, "router_out": 0, "answer_in": 0,
                                                  "answer_out": 0, "reasoning": 0})
    exa_cost: float = 0.0
    seconds: dict = field(default_factory=dict)   # {route, retrieve, answer}
    notes: list = field(default_factory=list)
    steps: list = field(default_factory=list)     # structured trace, see kaiku_trace.py
    cached: bool = False

    @property
    def total_tokens(self) -> int:
        t = self.tokens
        return t["router_in"] + t["router_out"] + t["answer_in"] + t["answer_out"]

    @property
    def total_seconds(self) -> float:
        return round(sum(self.seconds.values()), 2)


def run_checks(res: Result) -> dict:
    """Checks on a finished Result. `labels` is the list of problems (empty = fine)."""
    by_n = {s["n"]: s for s in res.sources}
    labels = []
    if not (res.no_evidence or res.route in ("static", "clarify")):
        has_web, has_data = bool(res.cited), "[DATA]" in res.text
        if res.document:
            if not res.cited:
                labels.append("document without references")
            if not res.quotes:
                labels.append("document without a direct quote")
            lost = sum(q["n"] is None for q in res.quotes)
            if lost:
                labels.append(f"{lost} quote(s) not found in the sources")
        else:
            if res.sources and not has_web:
                labels.append("web evidence but no [WEB n] label")
            if res.data is not None and not has_data:
                labels.append("data evidence but no [DATA] label")
            if has_data and res.data is None:
                labels.append("[DATA] without data")
        if "[MODEL]" in res.body:
            labels.append("[MODEL] in an evidence-based answer")
        if _URL.search(res.body):
            labels.append("URL written by the model")
        labels += sorted({n[6:] for n in res.notes if n.startswith("tags: ")})
        if any("error" in c for c in res.calcs):
            labels.append("calculation could not be evaluated")
    allowed = " ".join([res.question, json.dumps(res.data or {}, ensure_ascii=False)]
                       + [f"{s['title']} {s['published']} {s['text']}" for s in res.sources])
    figures = ({"checked": 0, "ungrounded": []} if res.route in ("static", "clarify") or res.no_evidence
               else figures_check(res.body, allowed))
    return {
        "labels": labels,
        "figures": figures,
        "quotes": {"verified": sum(q["n"] is not None for q in res.quotes), "total": len(res.quotes)},
        "cited": len(res.cited),
        "official_cited": sum(by_n[c["n"]]["official"] for c in res.cited),
        "fragments_matched": sum(c["matched"] for c in res.cited),
    }


def _norm(q: str) -> str:
    return " ".join(q.lower().split())


class Kaiku:
    """Route -> retrieve -> answer. Use `.ask(question)`; `.route(question)` runs only step 1."""

    def __init__(self, model_name: str = MODEL_NAME, transactions: Optional[pd.DataFrame] = None,
                 official_results: int = 2, web_results: int = 2, highlight_chars: int = 300,
                 search_type: str = "auto", official_domains: Optional[list[str]] = None,
                 cutoff: str = MODEL_CUTOFF, router_thinking: Optional[str] = ROUTER_THINKING,
                 answer_thinking: Optional[str] = ANSWER_THINKING, quote_chars: int = QUOTE_CHARS,
                 show_thoughts: bool = False, cache_ttl: int = 900, **model_kwargs):
        self.model_name, self.cutoff = model_name, cutoff
        self.df = transactions if transactions is not None else load_transactions()
        self.categories = sorted(self.df[COL_CATEGORY].unique())
        self.official_results, self.web_results = official_results, web_results
        self.highlight_chars, self.search_type = highlight_chars, search_type
        self.domains = official_domains or OFFICIAL_DOMAINS
        self.quote_chars, self.show_thoughts, self.cache_ttl = quote_chars, show_thoughts, cache_ttl
        self.router_thinking, self.answer_thinking = router_thinking, answer_thinking
        self._model_kwargs = model_kwargs
        self._cache: dict = {}
        self.stats = {"llm_calls": 0, "exa_calls": 0, "input_tokens": 0, "output_tokens": 0, "exa_cost": 0.0}
        self._router = make_model(model_name, router_thinking, include_thoughts=show_thoughts,
                                  **model_kwargs).with_structured_output(Route, include_raw=True)
        self._answerer = make_model(model_name, answer_thinking, include_thoughts=show_thoughts, **model_kwargs)

    def with_thinking(self, answer_thinking: Optional[str]) -> "Kaiku":
        """A copy that answers with another thinking level. It shares the routing cache, the
        Exa cache and the call counters, so comparing levels only pays for the answer calls."""
        other = copy.copy(self)
        other.answer_thinking = answer_thinking
        other._answerer = make_model(self.model_name, answer_thinking, include_thoughts=self.show_thoughts,
                                     **self._model_kwargs)
        return other

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

    def calls_needed(self, question: str) -> int:
        """Model calls that `ask(question)` would make right now, given the caches."""
        if self._get("result", (_norm(question), self.answer_thinking)):
            return 0
        d = self._get("route", _norm(question))
        if d is None:
            return 2
        return 0 if d.route.route in ("static", "clarify") else 1

    # ---- step 1: route (one model call, cached) ----
    def route(self, question: str) -> Decision:
        cached = self._get("route", _norm(question))
        if cached:
            return Decision(cached.route, cached.decided_by, cached.usage, cached.seconds, True, cached.info)
        t0 = time.perf_counter()
        out = self._router.invoke([SystemMessage(content=router_prompt(self.categories, self.cutoff)),
                                   HumanMessage(content=question)])
        raw = out.get("raw")
        usage = _usage(raw)
        self._count(usage)
        route = out.get("parsed") or _parse_route(message_text(raw) if raw is not None else "")
        marker = force_web(question, self.cutoff)
        info = {"model_route": route.route if route else None, "guardrail": marker,
                "thoughts": message_thoughts(raw) if raw is not None else ""}
        decided_by = "model"
        if route is None:  # unreadable decision -> Exa with the question as the query
            route, decided_by = Route(route="web", query=question), "fallback (unreadable decision)"
        elif route.route == "static" and marker:
            route = route.model_copy(update={"route": "web", "answer": None})
            decided_by = f"guardrail ({marker})"
        elif route.route == "static" and not (route.answer or "").strip():
            route = route.model_copy(update={"route": "web"})
            decided_by = "fallback (no static answer)"
        if route.document and route.route in ("static", "clarify", "data"):
            route = route.model_copy(update={"route": "both" if route.route == "data" else "web", "answer": None})
            decided_by = "guardrail (documents always use web sources)"
        if route.route in ("web", "both") and not (route.query or "").strip():
            route = route.model_copy(update={"query": question})
        d = Decision(route, decided_by, usage, round(time.perf_counter() - t0, 2), False, info)
        self._put("route", _norm(question), d)
        return d

    # ---- step 2: retrieve (code only) ----
    def _search(self, query: str, recent_days: Optional[int]) -> tuple[dict, bool]:
        key = (_norm(query), recent_days)
        hit = self._get("exa", key)
        if hit is not None:
            return hit, True
        got = retrieve_web(query, self.official_results, self.web_results, self.highlight_chars,
                           recent_days, self.search_type, self.domains)
        self.stats["exa_calls"] += sum("error" not in s for s in got["searches"])
        self.stats["exa_cost"] += got["cost"]
        if got["sources"]:
            self._put("exa", key, got)
        return got, False

    # ---- the whole pipeline ----
    def ask(self, question: str) -> Result:
        key = (_norm(question), self.answer_thinking)
        cached = self._get("result", key)
        if cached:
            res = copy.deepcopy(cached)
            res.cached, res.llm_calls = True, 0
            return res

        # 1. route
        d = self.route(question)
        r = d.route
        lang = (r.lang or "en")[:2].lower()
        web, own = r.route in ("web", "both"), r.route in ("data", "both")
        res = Result(question, r.route, d.decided_by, lang=lang, document=bool(r.document) and web,
                     query=r.query if web else None, llm_calls=1, thinking=self.answer_thinking)
        res.tokens.update(router_in=d.usage["in"], router_out=d.usage["out"], reasoning=d.usage["reasoning"])
        res.seconds["route"] = d.seconds
        res.steps.append({
            "step": "route", "route": r.route, "model_route": d.info.get("model_route"),
            "decided_by": d.decided_by, "why": r.why, "guardrail": d.info.get("guardrail"),
            "lang": lang, "document": res.document, "query": res.query,
            "recent_days": r.recent_days if web else None,
            "data_params": {"category": r.category, "start_date": r.start_date, "end_date": r.end_date,
                            "group_by": r.group_by} if own else None,
            "seconds": d.seconds, "tokens_in": d.usage["in"], "tokens_out": d.usage["out"],
            "thinking_tokens": d.usage["reasoning"], "thinking_level": self.router_thinking,
            "cached": d.cached, "thoughts": d.info.get("thoughts") or ""})

        if r.route in ("static", "clarify"):
            res.body = res.text = (r.answer or "").strip()
            res.answer = res.text
            if r.route == "static":
                res.text += " [MODEL]"
                res.answer = res.text + "\n\n" + sources_block([], [], lang, model=True)
            res.checks = run_checks(res)
            return self._put("result", key, res)

        # 2. retrieve
        t0 = time.perf_counter()
        searches, exa_cached = [], False
        if web:
            got, exa_cached = self._search(r.query, r.recent_days)
            res.sources, searches = got["sources"], got["searches"]
            res.exa_cost = 0.0 if exa_cached else got["cost"]
            res.notes += got["notes"]
        if own:
            try:
                res.data = spending_summary(self.df, r.category, r.start_date, r.end_date, r.group_by)
            except Exception:  # noqa: BLE001 - unreadable dates: use the whole history and say so
                res.notes.append(f"data: could not read the period {r.start_date!r} to {r.end_date!r}; "
                                 "used the whole history")
                try:
                    res.data = spending_summary(self.df, r.category, None, None, r.group_by)
                except Exception as e:  # noqa: BLE001
                    res.data = {"error": f"{type(e).__name__}: {e}"}
        res.seconds["retrieve"] = round(time.perf_counter() - t0, 2)
        res.steps.append({
            "step": "retrieve", "seconds": res.seconds["retrieve"], "searches": searches,
            "cached": exa_cached, "exa_cost": res.exa_cost, "data": res.data,
            "sources": [{k: s[k] for k in ("n", "official", "domain", "published", "title")} for s in res.sources]})

        if r.route == "web" and not res.sources:  # nothing found: say so, no second model call
            res.no_evidence = True
            res.body = res.text = res.answer = T(lang, "no_result")
            res.steps.append({"step": "answer", "mode": "skipped: no evidence", "no_evidence": True})
            res.checks = run_checks(res)
            return res

        # 3. answer
        parts = [f"QUESTION: {question}"]
        if res.sources:
            parts.append("WEB:\n" + format_evidence(res.sources))
        elif web:
            parts.append("WEB: no results found.")
        if res.data is not None:
            parts.append("DATA (EUR, user's transactions): " + json.dumps(res.data, ensure_ascii=False))
        system = DOC_PROMPT.replace("{today}", date.today().isoformat()) if res.document else ANSWER_PROMPT
        t0 = time.perf_counter()
        msg = self._answerer.invoke([SystemMessage(content=system), HumanMessage(content="\n\n".join(parts))])
        usage = _usage(msg)
        self._count(usage)
        res.llm_calls += 1
        res.tokens.update(answer_in=usage["in"], answer_out=usage["out"],
                          reasoning=res.tokens["reasoning"] + usage["reasoning"])
        res.seconds["answer"] = round(time.perf_counter() - t0, 2)
        res.body = message_text(msg).strip()

        # 4. post-process in code: calculations, tags, numbering, source list
        if res.body.upper().startswith("NO_EVIDENCE"):
            res.no_evidence = True
            res.text = res.body[len("NO_EVIDENCE"):].lstrip(" :.-\n").strip() or T(lang, "no_result")
            searched = ", ".join(dict.fromkeys(s["domain"] for s in res.sources))
            res.answer = res.text + (f"\n\n{T(lang, 'searched')}: {searched}" if searched else "")
        else:
            done = (finish_document if res.document else finish_answer)(res.body, res.sources, self.quote_chars)
            res.text, res.calcs = apply_calcs(done["text"], lang)
            res.cited, res.quotes = done["cited"], done["quotes"]
            res.notes += done["notes"]
            show_data = res.data if (res.document or "[DATA]" in res.text) else None
            block = sources_block(res.cited, res.sources, lang, "doc" if res.document else "web", data=show_data)
            res.answer = res.text + (f"\n\n{block}" if block else "")
        res.checks = run_checks(res)
        cited_ns = {c["n"] for c in res.cited}
        res.steps.append({
            "step": "answer", "mode": "document" if res.document else "answer", "model": self.model_name,
            "thinking_level": self.answer_thinking, "seconds": res.seconds["answer"],
            "tokens_in": usage["in"], "tokens_out": usage["out"], "thinking_tokens": usage["reasoning"],
            "thoughts": message_thoughts(msg), "no_evidence": res.no_evidence, "cited": res.cited,
            "unused": [s["n"] for s in res.sources if s["n"] not in cited_ns],
            "calcs": res.calcs, "quotes": res.quotes, "checks": res.checks})
        return self._put("result", key, res)


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
