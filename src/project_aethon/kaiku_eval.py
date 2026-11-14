"""Evaluating the Kaiku pipeline: routing, labels, tokens, speed and Exa settings.

Reuses kaiku_agent.py. Structure:
    1. Guardrail check   (offline, 0 model calls)
    2. Routing eval      (1 model call per question: only the router runs)
    3. Full answers      (labels, tokens and seconds of each Result)
    4. Exa settings      (0 model calls: tokens vs hit rate)

Every function that calls the model takes a `budget` and stops before exceeding it, so a run
fits in a daily request quota. `agent.stats["llm_calls"]` is the real count.
"""
import json
import re

import pandas as pd

from .kaiku_agent import OFFICIAL_DOMAINS, Kaiku, Result, force_web, format_evidence, search_exa

# (question, acceptable routes, text expected in the answer or None)
QUESTIONS = [
    # --- timeless and non-local: training data ---
    ("What is a variable interest rate?", {"static"}, None),
    ("How does compound interest work?", {"static"}, None),
    ("Which national team won the 2022 World Cup?", {"static"}, "Argentina"),
    # --- changes over time or depends on place: Exa ---
    ("What is the 12-month Euribor today?", {"web"}, None),
    ("How much is the Kela general housing allowance this year for a single person in Helsinki?", {"web"}, None),
    ("Can my landlord in Finland raise my rent by 8% in the middle of the contract?", {"web"}, None),
    # --- goes into a letter: Exa even if it looks stable ---
    ("Write a short letter to my landlord objecting to a rent increase, citing the rule that applies in Finland.",
     {"web"}, None),
    # --- the user's own money: transactions ---
    ("How much did I spend on taxis last month?", {"data"}, None),
    ("Where is my money going? Split it into the three baskets.", {"data"}, None),
    # --- own data + live fact ---
    ("How much do I pay in rent each month, and what is the average rent in Helsinki right now?", {"both"}, None),
]

# Nothing reliable exists for this: the answer should say so instead of inventing a figure.
UNANSWERABLE = "What is the Kela benefit amount for owners of blue hamsters in Zzyzx municipality in 2031?"

# (query, text that must appear in the Exa results). Verify the keys before relying on hit_rate.
EXA_EVAL = [
    ("12-month Euribor rate today", "%"),
    ("Kela general housing allowance amount", "70"),
    ("Finland general VAT rate", "25.5"),
    ("rent increase rules residential lease Finland", "agree"),
    ("Finland basic unemployment allowance per day", "per day"),
    ("Bank of Finland governor", "Rehn"),
]


def remaining(agent: Kaiku, budget: int) -> int:
    """Model calls left in the budget."""
    return budget - agent.stats["llm_calls"]


# ---------------------------------------------------------------------------
# 1. Guardrail check (offline)
# ---------------------------------------------------------------------------
def guardrail_table(questions=QUESTIONS) -> pd.DataFrame:
    """What the code guardrail does with each question, without calling any API.

    `forced_to_web` = the reason the question can never be answered from training, or '' if
    the decision is left to the router. A question expected to be static must have ''.
    """
    rows = []
    for question, expected, _ in questions:
        reason = force_web(question) or ""
        rows.append({"question": question[:70], "expected": ",".join(sorted(expected)),
                     "forced_to_web": reason, "ok": not (reason and expected == {"static"})})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 2. Routing eval (router only: 1 call per question)
# ---------------------------------------------------------------------------
def routing_eval(agent: Kaiku, questions=QUESTIONS, budget: int = 20) -> pd.DataFrame:
    """Runs only the router on each question. Decisions are cached, so a later `agent.ask`
    on the same question does not pay for the routing again."""
    rows = []
    for question, expected, _ in questions:
        row = {"question": question[:60], "expected": ",".join(sorted(expected)), "route": "NOT RUN",
               "ok": None, "decided_by": "", "query": None, "official": None, "tokens": None, "seconds": None}
        rows.append(row)
        if remaining(agent, budget) < 1:
            continue
        try:
            d = agent.route(question)
        except Exception as e:  # noqa: BLE001 - quota or network: keep what already ran
            print(f"[stopped] {type(e).__name__}: {str(e)[:150]}")
            budget = agent.stats["llm_calls"]  # nothing else will run
            continue
        r = d.route
        row.update(route=r.route, ok=r.route in expected, decided_by=d.decided_by,
                   query=r.query if r.route in ("web", "both") else None,
                   official=r.official if r.route in ("web", "both") else None,
                   tokens=d.usage["in"] + d.usage["out"], seconds=d.seconds)
        print(f"[{'OK' if row['ok'] else 'FAIL'}] {r.route:<7} <- {question[:70]}")
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 3. Full answers
# ---------------------------------------------------------------------------
_URL = re.compile(r"https?://[^\s)\]>\"']+")


def label_report(res: Result) -> list[str]:
    """Problems in the labels of an answer (empty list = fine).

    The model never sees URLs and the source list is added by the code, so any URL in the
    text written by the model (`res.body`) is an invented one.
    """
    body = res.body
    web = [int(n) for n in re.findall(r"\[WEB\s*(\d+)\]", body)]
    has_data = "[DATA]" in body
    problems = []
    if res.route in ("static", "clarify"):
        return problems
    if res.sources and not web:
        problems.append("web evidence but no [WEB n] label")
    if any(n < 1 or n > len(res.sources) for n in web):
        problems.append("[WEB n] out of range")
    if res.data is not None and not has_data:
        problems.append("data evidence but no [DATA] label")
    if has_data and res.data is None:
        problems.append("[DATA] without data")
    if _URL.search(body):
        problems.append("URL written by the model")
    if "[MODEL]" in body:
        problems.append("[MODEL] in an evidence-based answer")
    return problems


def show(res: Result) -> None:
    """Prints the decision, the evidence used and the final answer."""
    t = res.tokens
    print(f"route: {res.route} | decided by: {res.decided_by} | calls: {res.llm_calls} | "
          f"tokens: {res.total_tokens} (router {t['router_in']}+{t['router_out']}, "
          f"answer {t['answer_in']}+{t['answer_out']}, thinking {t['reasoning']}) | "
          f"{res.total_seconds}s {res.seconds}" + (" | CACHED" if res.cached else ""))
    if res.query:
        print(f"search: {res.query!r} | official={res.official} | {len(res.sources)} sources | "
              f"Exa ${res.exa_cost:.3f}")
    if res.data is not None:
        print("data:", json.dumps(res.data, ensure_ascii=False)[:300])
    for note in res.notes:
        print("note:", note)
    print("\n" + res.answer)
    problems = label_report(res)
    if problems:
        print("\nLABEL PROBLEMS:", problems)


def ask_all(agent: Kaiku, questions: dict, budget: int = 20) -> dict:
    """Runs `agent.ask` on {name: question}, stopping before the budget is exceeded.
    Keeps 2 calls in reserve per question (routing + answer)."""
    results = {}
    for name, question in questions.items():
        if remaining(agent, budget) < 2:
            print(f"[skipped '{name}'] not enough budget left ({remaining(agent, budget)} calls)")
            continue
        try:
            results[name] = agent.ask(question)
        except Exception as e:  # noqa: BLE001
            print(f"[stopped at '{name}'] {type(e).__name__}: {str(e)[:150]}")
            break
    return results


def results_table(results: dict) -> pd.DataFrame:
    """One row per Result: route, calls, tokens, seconds and label problems."""
    rows = []
    for name, res in results.items():
        t = res.tokens
        rows.append({"case": name, "route": res.route, "decided_by": res.decided_by, "calls": res.llm_calls,
                     "tokens": res.total_tokens, "router_tokens": t["router_in"] + t["router_out"],
                     "answer_tokens": t["answer_in"] + t["answer_out"], "thinking": t["reasoning"],
                     "sources": len(res.sources), "cited": len(res.cited), "exa_usd": round(res.exa_cost, 3),
                     "seconds": res.total_seconds, "label_problems": "; ".join(label_report(res))})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 4. Exa settings: tokens vs hit rate (no model calls)
# ---------------------------------------------------------------------------
def tok(x) -> int:
    """Approximate tokens (chars/4) of a text or of a serialisable object."""
    return len(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)) // 4


def _hit(results: list[dict], key: str) -> bool:
    return any(key.lower() in (r["title"] + " " + " ".join(r["snippets"])).lower() for r in results)


EXA_CONFIGS = [  # (name, parameters of search_exa)
    ("highlights 300 x3 (default)", {"num_results": 3, "highlight_chars": 300}),
    ("highlights 150 x3", {"num_results": 3, "highlight_chars": 150}),
    ("highlights 300 x2", {"num_results": 2, "highlight_chars": 300}),
    ("highlights 500 x3", {"num_results": 3, "highlight_chars": 500}),
    ("full text 3000 x3", {"num_results": 3, "full_text_chars": 3000}),
    ("highlights 300 x3 official", {"num_results": 3, "highlight_chars": 300, "include_domains": OFFICIAL_DOMAINS}),
    ("highlights 300 x3 lite", {"num_results": 3, "highlight_chars": 300, "search_type": "lite"}),
]


def evaluate_exa_config(name: str, evalset=EXA_EVAL, **params) -> dict:
    """One Exa configuration over the eval queries: hit rate, evidence tokens and cost."""
    chars = params.get("full_text_chars") or params.get("highlight_chars", 300)
    hits, toks, cost = [], [], 0.0
    for q, key in evalset:
        out = search_exa(q, **params)
        hits.append(_hit(out["results"], key))
        toks.append(tok(format_evidence(out["results"], chars)))
        cost += out["cost"] or 0.0
    return {"config": name, "hit_rate": sum(hits) / len(hits), "evidence_tokens": sum(toks) / len(toks),
            "exa_cost_usd": round(cost, 4)}


def compare_exa_configs(configs=EXA_CONFIGS, evalset=EXA_EVAL) -> pd.DataFrame:
    """Comparison table; a configuration that fails is reported and skipped."""
    rows = []
    for name, params in configs:
        try:
            rows.append(evaluate_exa_config(name, evalset, **params))
        except Exception as e:  # noqa: BLE001
            print("Failed:", name, "->", str(e)[:120])
    return pd.DataFrame(rows).round(2)
