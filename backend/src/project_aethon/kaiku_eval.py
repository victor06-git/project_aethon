"""Evaluating the Kaiku pipeline: routing, answers, thinking level and Exa settings.

Reuses kaiku_agent.py. Structure:
    1. Question set          50 finance questions, 10 per type
    2. Guardrail check       offline, 0 model calls
    3. Routing eval          1 model call per question (only the router runs)
    4. Full answers          tables built from each Result and its checks
    5. Thinking comparison   same questions answered with two thinking levels
    6. Exa settings          0 model calls: official-first evidence, tokens and hit rate

Every function that calls the model takes a `budget` and stops before exceeding it, so a run
fits in a daily request quota. `agent.stats["llm_calls"]` is the real count.
"""
import json

import pandas as pd

from .kaiku_agent import Kaiku, Result, force_web, format_evidence, retrieve_web

# ---------------------------------------------------------------------------
# 1. Question set: 10 finance questions per type (English, Spanish and Finnish)
# ---------------------------------------------------------------------------
QUESTIONS = {
    # Timeless and non-local: answered from training, no search.
    "static": [
        "What is a variable interest rate?",
        "How does compound interest work?",
        "What is an emergency fund for?",
        "What does APR mean on a loan?",
        "What is the difference between a fixed-rate and a variable-rate mortgage?",
    ],
    # Changes over time or depends on place: Exa.
    "web": [
        "What is the 12-month Euribor today?",
        "How much is the Kela general housing allowance this year for a single person in Helsinki?",
        "What is the general VAT rate in Finland right now?",
        "Can my landlord in Finland raise my rent by 8% in the middle of the contract?",
        "What is the capital income tax rate in Finland in 2026?",
    ],
    # The user's own money: transactions.
    "data": [
        "How much did I spend on taxis last month?",
        "Where is my money going? Split it into the three baskets.",
        "What happens to my budget if I stop ordering food delivery?",
        "How much do I spend on coffee per month on average?",
        "Which merchants do I spend the most money at?",
    ],
    # Own data + a live fact. The first one gives a scale the answer must match.
    "both": [
        "My flat in Helsinki is 80 m2. How does the rent I pay each month compare with the average rent for a flat that size?",
        "How much do I pay in rent each month, and what is the average rent in Helsinki right now?",
        "Is my monthly electricity spending higher than the average Finnish household's this year?",
        "With the rent I pay, could I qualify for Kela general housing allowance as a single person in Helsinki?",
        "How much of my food delivery spending last month was VAT at the current Finnish rate?",
    ],
    # Letters and emails: always backed by web sources, quoted word for word.
    "document": [
        "Write a short letter to my landlord objecting to a rent increase, citing the rule that applies in Finland.",
        "Write an email to my landlord in Helsinki objecting to an 8% rent increase in the middle of my contract.",
        "Draft an email to Kela asking them to review my general housing allowance decision.",
        "Draft a complaint to an online store in Finland that has not refunded a returned product after 30 days.",
        "Write an email to a debt collection agency in Finland asking them to verify the debt and its collection costs.",
    ],
}

# type -> (acceptable routes, is it a document?)
EXPECTED = {
    "static": ({"static"}, False),
    "web": ({"web"}, False),
    "data": ({"data"}, False),
    "both": ({"both"}, False),
    "document": ({"web", "both"}, True),
}

# Nothing reliable exists for this: the answer should say so instead of inventing a figure.
UNANSWERABLE = "What is the Kela benefit amount for owners of blue hamsters in Zzyzx municipality in 2031?"

# (query, text that must appear in the evidence). Verify the keys before relying on hit_rate.
EXA_EVAL = [
    ("12-month Euribor rate today", "%"),
    ("Kela general housing allowance amount", "70"),
    ("Finland general VAT rate", "25.5"),
    ("rent increase rules residential lease Finland", "agree"),
    ("Finland basic unemployment allowance per day", "per day"),
    ("Bank of Finland governor", "Rehn"),
]


def sample(per_type: int | None = None, types=None) -> list[tuple[str, str]]:
    """[(type, question)]: the first `per_type` questions of each type (all if None)."""
    return [(t, q) for t in (types or QUESTIONS) for q in QUESTIONS[t][:per_type]]


def remaining(agent: Kaiku, budget: int) -> int:
    """Model calls left in the budget."""
    return budget - agent.stats["llm_calls"]


# ---------------------------------------------------------------------------
# 2. Guardrail check (offline)
# ---------------------------------------------------------------------------
def guardrail_table(per_type: int | None = None) -> pd.DataFrame:
    """What the code guardrail does with each question, without calling any API.

    `forced_to_web` = why the question can never be answered from training ('' = the router
    decides). `ok` is False only when a question meant to be static would be forced to the web.
    """
    rows = []
    for kind, question in sample(per_type):
        reason = force_web(question) or ""
        rows.append({"type": kind, "question": question[:75], "forced_to_web": reason,
                     "ok": not (reason and kind == "static")})
    return pd.DataFrame(rows)


def guardrail_summary(table: pd.DataFrame) -> str:
    static = table[table["type"] == "static"]
    outside = table[table["type"].isin(["web", "both", "document"])]
    return (f"static questions left to the router: {int(static['ok'].sum())}/{len(static)} | "
            f"web, both and document questions that can never be answered from training: "
            f"{int((outside['forced_to_web'] != '').sum())}/{len(outside)}")


# ---------------------------------------------------------------------------
# 3. Routing eval (router only: 1 call per question)
# ---------------------------------------------------------------------------
def routing_eval(agent: Kaiku, per_type: int | None = 2, budget: int = 20, types=None) -> pd.DataFrame:
    """Runs only the router on the first `per_type` questions of each type. Decisions are
    cached, so a later `agent.ask` on the same question does not pay for the routing again."""
    rows, stopped = [], False
    for kind, question in sample(per_type, types):
        routes, is_doc = EXPECTED[kind]
        row = {"type": kind, "question": question[:60], "route": "NOT RUN", "document": None, "ok": None,
               "decided_by": "", "why": "", "query": None, "tokens": None, "seconds": None}
        rows.append(row)
        if stopped or remaining(agent, budget) < 1:
            continue
        try:
            d = agent.route(question)
        except Exception as e:  # noqa: BLE001 - quota or network: keep what already ran
            print(f"[stopped] {type(e).__name__}: {str(e)[:150]}")
            stopped = True
            continue
        r = d.route
        web = r.route in ("web", "both")
        row.update(route=r.route, document=bool(r.document) and web,
                   ok=r.route in routes and (bool(r.document) and web) == is_doc,
                   decided_by=d.decided_by, why=r.why, query=r.query if web else None,
                   tokens=d.usage["in"] + d.usage["out"], seconds=d.seconds)
        print(f"[{'OK' if row['ok'] else 'FAIL'}] {kind:<8} -> {r.route:<7}{' doc' if row['document'] else '    '} "
              f"| {question[:62]}")
    return pd.DataFrame(rows)


def routing_summary(table: pd.DataFrame) -> pd.DataFrame:
    """Accuracy, tokens and seconds per question type."""
    done = table[table["route"] != "NOT RUN"]
    if not len(done):
        return pd.DataFrame()
    g = done.groupby("type", sort=False)
    out = pd.DataFrame({"routed": g.size(), "correct": g["ok"].sum().astype(int),
                        "by_guardrail": g["decided_by"].apply(lambda s: int(s.str.startswith("guardrail").sum())),
                        "mean_tokens": g["tokens"].mean().round(0), "mean_seconds": g["seconds"].mean().round(2)})
    out.loc["ALL"] = [len(done), int(done["ok"].sum()), int(done["decided_by"].str.startswith("guardrail").sum()),
                      round(done["tokens"].mean()), round(done["seconds"].mean(), 2)]
    return out.astype({"routed": int, "correct": int, "by_guardrail": int, "mean_tokens": int})


# ---------------------------------------------------------------------------
# 4. Full answers
# ---------------------------------------------------------------------------
def label_report(res: Result) -> list[str]:
    """Problems found in the labels and references of an answer (empty list = fine)."""
    return (res.checks or {}).get("labels", [])


def show(res: Result) -> None:
    """Prints a one-line summary and the final answer. Use kaiku_trace.show_trace for the detail."""
    print(f"route: {res.route}{' (document)' if res.document else ''} | decided by: {res.decided_by} | "
          f"calls: {res.llm_calls} | tokens: {res.total_tokens} | {res.total_seconds}s"
          + (" | CACHED" if res.cached else ""))
    print("\n" + res.answer)
    if label_report(res):
        print("\nPROBLEMS:", label_report(res))


def ask_all(agent: Kaiku, questions: dict, budget: int = 20) -> dict:
    """Runs `agent.ask` on {name: question}, skipping what would exceed the budget."""
    results = {}
    for name, question in questions.items():
        need = agent.calls_needed(question)
        if remaining(agent, budget) < need:
            print(f"[skipped '{name}'] needs {need} calls, {remaining(agent, budget)} left")
            continue
        try:
            results[name] = agent.ask(question)
        except Exception as e:  # noqa: BLE001
            print(f"[stopped at '{name}'] {type(e).__name__}: {str(e)[:150]}")
            break
    return results


def _answer_step(res: Result) -> dict:
    return next((s for s in res.steps if s["step"] == "answer" and "tokens_in" in s), {})


def results_table(results: dict) -> pd.DataFrame:
    """One row per Result: route, cost, sources and automatic checks."""
    rows = []
    for name, res in results.items():
        t, ck = res.tokens, res.checks
        fig = ck["figures"]
        rows.append({
            "case": name, "route": res.route + (" (doc)" if res.document else ""), "calls": res.llm_calls,
            "tokens": res.total_tokens, "thinking": t["reasoning"], "seconds": res.total_seconds,
            "sources": f"{sum(s['official'] for s in res.sources)} official / {len(res.sources)}",
            "cited": f"{ck['official_cited']} official / {ck['cited']}",
            "fragments_found": f"{ck['fragments_matched']}/{ck['cited']}",
            "calcs": len(res.calcs),
            "figures_grounded": f"{fig['checked'] - len(fig['ungrounded'])}/{fig['checked']}",
            "quotes_verified": f"{ck['quotes']['verified']}/{ck['quotes']['total']}" if res.document else "-",
            "exa_usd": round(res.exa_cost, 3),
            "problems": "; ".join(ck["labels"]),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 5. Thinking comparison
# ---------------------------------------------------------------------------
def compare_thinking(agent: Kaiku, questions: dict, levels=("minimal", "low"), budget: int = 20):
    """Answers the same {name: question} with each thinking level of the answer step.

    Routing and Exa results are shared between the levels, so each level only pays for its
    answer calls and both see exactly the same evidence. Returns (table, {level: {name: Result}}).
    """
    rows, out, stopped = [], {}, False
    for level in levels:
        a = agent if level == agent.answer_thinking else agent.with_thinking(level)
        out[level] = {}
        for name, question in questions.items():
            need = a.calls_needed(question)
            if stopped or remaining(agent, budget) < need:
                print(f"[skipped '{name}' at {level}] needs {need} calls, {remaining(agent, budget)} left")
                continue
            try:
                res = a.ask(question)
            except Exception as e:  # noqa: BLE001
                print(f"[stopped at '{name}' ({level})] {type(e).__name__}: {str(e)[:150]}")
                stopped = True
                continue
            out[level][name] = res
            step, ck = _answer_step(res), res.checks
            rows.append({
                "case": name, "thinking": level,
                "answer_tokens": step.get("tokens_in", 0) + step.get("tokens_out", 0),
                "thinking_tokens": step.get("thinking_tokens", 0),
                "answer_seconds": step.get("seconds", 0.0),
                "words": len(res.text.split()),
                "label_problems": len(ck["labels"]),
                "ungrounded_figures": len(ck["figures"]["ungrounded"]),
                "cited": ck["cited"], "official_cited": ck["official_cited"],
                "fragments_matched": ck["fragments_matched"],
                "quotes_verified": ck["quotes"]["verified"], "quotes_total": ck["quotes"]["total"],
                "no_evidence": res.no_evidence,
            })
    return pd.DataFrame(rows), out


def thinking_verdict(table: pd.DataFrame, base: str = "low", test: str = "minimal") -> str:
    """Plain summary of `test` against `base` over the cases both levels answered."""
    if not len(table):
        return "Nothing to compare."
    both = set(table[table["thinking"] == base]["case"]) & set(table[table["thinking"] == test]["case"])
    if not both:
        return f"No case was answered with both '{base}' and '{test}'."
    b = table[(table["thinking"] == base) & table["case"].isin(both)]
    t = table[(table["thinking"] == test) & table["case"].isin(both)]

    def change(col):
        return f"{100 * (t[col].sum() / b[col].sum() - 1):+.0f} %" if b[col].sum() else "n/a"

    worse = []
    for col, name in (("label_problems", "label problems"), ("ungrounded_figures", "figures not in the evidence")):
        if t[col].sum() > b[col].sum():
            worse.append(f"more {name} ({int(t[col].sum())} vs {int(b[col].sum())})")
    if (t["quotes_verified"].sum() < b["quotes_verified"].sum()):
        worse.append(f"fewer verified quotes ({int(t['quotes_verified'].sum())} vs {int(b['quotes_verified'].sum())})")
    if t["cited"].sum() < b["cited"].sum():
        worse.append(f"fewer sources cited ({int(t['cited'].sum())} vs {int(b['cited'].sum())})")
    if t["no_evidence"].sum() > b["no_evidence"].sum():
        worse.append("more questions left unanswered")
    return (f"'{test}' vs '{base}' on {len(both)} case(s): answer tokens {change('answer_tokens')}, "
            f"answer seconds {change('answer_seconds')}. "
            + ("Automatic checks: no loss detected." if not worse else "Automatic checks WORSE: " + "; ".join(worse) + ".")
            + " Read the answers side by side before deciding: the checks do not judge wording or usefulness.")


def side_by_side(results_by_level: dict, case: str) -> None:
    """Prints the answer each thinking level gave to one case."""
    for level, results in results_by_level.items():
        res = results.get(case)
        print("=" * 30, f"{case} | thinking: {level}", "=" * 30)
        print(res.answer if res else "(not run)")
        print()


# ---------------------------------------------------------------------------
# 6. Exa settings: official-first evidence, tokens and hit rate (no model calls)
# ---------------------------------------------------------------------------
def tok(x) -> int:
    """Approximate tokens (chars/4) of a text or of a serialisable object."""
    return len(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)) // 4


EXA_CONFIGS = [  # (name, parameters of retrieve_web)
    ("official 2 + web 2 (default)", {"official_results": 2, "web_results": 2}),
    ("official 3 only", {"official_results": 3, "web_results": 0}),
    ("open web 3 only", {"official_results": 0, "web_results": 3}),
    ("official 2 + web 2, 150 chars", {"official_results": 2, "web_results": 2, "highlight_chars": 150}),
    ("official 2 + web 2, lite", {"official_results": 2, "web_results": 2, "search_type": "lite"}),
]


def evaluate_exa_config(name: str, evalset=EXA_EVAL, **params) -> dict:
    """One retrieval configuration over the eval queries."""
    hits, toks, share, cost = [], [], [], 0.0
    for q, key in evalset:
        got = retrieve_web(q, **params)
        srcs = got["sources"]
        hits.append(any(key.lower() in (s["title"] + " " + s["text"]).lower() for s in srcs))
        toks.append(tok(format_evidence(srcs)))
        share.append(sum(s["official"] for s in srcs) / len(srcs) if srcs else 0.0)
        cost += got["cost"]
    n = len(evalset)
    return {"config": name, "hit_rate": sum(hits) / n, "evidence_tokens": sum(toks) / n,
            "official_share": sum(share) / n, "exa_cost_usd": round(cost, 4)}


def compare_exa_configs(configs=EXA_CONFIGS, evalset=EXA_EVAL) -> pd.DataFrame:
    """Comparison table; a configuration that fails is reported and skipped."""
    rows = []
    for name, params in configs:
        try:
            rows.append(evaluate_exa_config(name, evalset, **params))
        except Exception as e:  # noqa: BLE001
            print("Failed:", name, "->", str(e)[:120])
    return pd.DataFrame(rows).round(2)
