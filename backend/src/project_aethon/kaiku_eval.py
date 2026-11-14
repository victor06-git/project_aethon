"""Evaluating the Kaiku agent: routing, source labels, ToolMessage tokens and Exa settings.

Reuses kaiku_agent.py. Structure:
    1. Access to tool calls and ToolMessages
    2. Routing: did it use the right source (model / Exa / user data)?
    3. Source labels and citations ([WEB n] / [DATA] / [MODEL])
    4. ToolMessage tokens
    5. Exa settings: tokens vs hit rate (highlights, text, num_results, domains)
    6. Agent variants over the same questions

Tokens of a ToolMessage: the API only reports usage per LLM call and every call re-sends the
whole history, so for call k:  tokens(ToolMessages) = input_k - input_{k-1} - output_{k-1}.
"""
import json
import re
import statistics

import pandas as pd
from langchain.messages import HumanMessage
from langchain_core.callbacks import get_usage_metadata_callback

from .kaiku_agent import OFFICIAL_DOMAINS, format_results, message_text, search_exa

EXA, DATA = "exa_search", "query_spending"

# (question, tools that MUST be used, text expected in the answer or None)
# set() = answered from training. Check the expected texts before trusting resp_ok.
QUESTIONS = [
    # --- stable knowledge: no tools ---
    ("What is a variable interest rate?", set(), None),
    ("How does compound interest work?", set(), None),
    ("What is an emergency fund for?", set(), None),
    ("Which national team won the 2022 World Cup?", set(), "Argentina"),
    # --- changes over time or depends on place: Exa ---
    ("What is the 12-month Euribor today?", {EXA}, None),
    ("How much is the Kela general housing allowance this year for a single person in Helsinki?", {EXA}, None),
    ("What is the general VAT rate in Finland right now?", {EXA}, None),
    ("Can my landlord in Finland raise my rent by 8% in the middle of the contract?", {EXA}, None),
    # --- will end up in a letter: Exa even if it looks stable ---
    ("Write a short letter to my landlord objecting to a rent increase, citing the rule that applies in Finland.",
     {EXA}, None),
    # --- the user's own money: data tool ---
    ("How much did I spend on taxis last month?", {DATA}, None),
    ("Where is my money going? Split it into the three baskets.", {DATA}, None),
    # --- mixed: own data + live fact ---
    ("How much do I pay in rent each month, and what is the average rent in Helsinki right now?", {DATA, EXA}, None),
]

# Nothing reliable exists for these: the agent should say so instead of answering from memory.
UNANSWERABLE = [
    "What is the Kela benefit amount for owners of blue hamsters in Zzyzx municipality in 2031?",
]

# (query, text that must appear in the Exa results). Verify the keys before relying on hit_rate.
EXA_EVAL = [
    ("12-month Euribor rate today", "Euribor"),
    ("Kela general housing allowance amount", "housing allowance"),
    ("Finland general VAT rate", "25.5"),
    ("rent increase rules residential lease Finland", "rent"),
    ("Finland basic unemployment allowance per day", "unemployment"),
    ("Bank of Finland governor", "Rehn"),
]


# ---------------------------------------------------------------------------
# 1. Access to tool calls and ToolMessages
# ---------------------------------------------------------------------------
def _tool_calls(state: dict) -> list[dict]:
    return [tc for m in state["messages"] if m.type == "ai" for tc in (m.tool_calls or [])]


def tools_called(state: dict) -> list[str]:
    """Names of the tools the model requested, in order."""
    return [tc["name"] for tc in _tool_calls(state)]


def get_tool_messages(state: dict) -> list[dict]:
    """ToolMessages with their tool and arguments: [{tool, args, content}]."""
    calls = {tc["id"]: tc for tc in _tool_calls(state)}
    return [{"tool": calls.get(m.tool_call_id, {}).get("name", "?"),
             "args": calls.get(m.tool_call_id, {}).get("args", {}),
             "content": message_text(m)}
            for m in state["messages"] if m.type == "tool"]


def ask(agent, question: str) -> dict:
    """Runs one question and returns the final state."""
    return agent.invoke({"messages": [HumanMessage(content=question)]})


def show(state: dict) -> None:
    """Prints tool calls (with arguments) and the final answer."""
    for t in get_tool_messages(state):
        print(f"-> {t['tool']}({json.dumps(t['args'], ensure_ascii=False)})  [{len(t['content'])} chars]")
    print("\n" + message_text(state["messages"][-1]))


# ---------------------------------------------------------------------------
# 2. Routing
# ---------------------------------------------------------------------------
def check(agent, question: str, expect: set, verbose: bool = True) -> dict:
    """Runs the agent and checks that the set of tools used equals `expect` (set() = no tools)."""
    state = ask(agent, question)
    used = set(tools_called(state))
    state["_ok"] = used == set(expect)
    if verbose:
        print(f"[{'OK' if state['_ok'] else 'FAIL'}] expected={sorted(expect) or 'none'} | "
              f"used={sorted(used) or 'none'} | {question}")
    return state


def routing_eval(agent, questions=QUESTIONS, repeats: int = 1) -> pd.DataFrame:
    """One row per question: pass rate of the routing, tools used, tokens and label problems."""
    rows = []
    for question, expect, key in questions:
        oks, totals, used_all, problems, resp = [], [], set(), [], []
        for _ in range(repeats):
            try:
                with get_usage_metadata_callback() as cb:
                    st = ask(agent, question)
            except Exception as e:  # noqa: BLE001
                print(f"[error] {question[:50]} -> {type(e).__name__}: {str(e)[:80]}")
                continue
            used = set(tools_called(st))
            used_all |= used
            oks.append(used == set(expect))
            totals.append(sum(u["input_tokens"] + u["output_tokens"] for u in cb.usage_metadata.values()))
            problems += label_report(st)["problems"]
            if key is not None:
                resp.append(key.lower() in message_text(st["messages"][-1]).lower())
        rows.append({
            "question": question[:60],
            "expected": ",".join(sorted(expect)) or "none",
            "used": ",".join(sorted(used_all)) or "none",
            "route_ok": round(sum(oks) / len(oks), 2) if oks else None,
            "resp_ok": round(sum(resp) / len(resp), 2) if resp else None,
            "tokens_mean": round(statistics.mean(totals)) if totals else None,
            "label_problems": "; ".join(sorted(set(problems))),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 3. Source labels and citations
# ---------------------------------------------------------------------------
_URL = re.compile(r"https?://[^\s)\]>\"']+")


def label_report(state: dict) -> dict:
    """Checks that the labels of the answer match what the agent actually did.

    Problems reported:
        - [WEB] used without any `exa_search` call (a web label on a memory answer)
        - `exa_search` returned results but the answer has no [WEB] label or no source URL
        - [DATA] used without `query_spending`, or the other way round
        - a URL in the answer that is not in the search results (invented source)
        - [WEB n] pointing to a result number that does not exist
        - no label at all
    """
    answer = message_text(state["messages"][-1])
    tms = get_tool_messages(state)
    exa_text = "\n".join(t["content"] for t in tms if t["tool"] == EXA)
    used = {t["tool"] for t in tms}
    got_results = bool(_URL.search(exa_text))

    web = re.findall(r"\[WEB\s*(\d+)\]", answer)
    n_data, n_model = answer.count("[DATA]"), answer.count("[MODEL]")
    urls = {u.rstrip(".,;") for u in _URL.findall(answer)}
    source_urls = {u.rstrip(".,;") for u in _URL.findall(exa_text)}
    max_n = max((int(n) for n in re.findall(r"^\[(\d+)\]", exa_text, flags=re.M)), default=0)

    problems = []
    if web and EXA not in used:
        problems.append("[WEB] without search")
    if got_results and not web:
        problems.append("search results but no [WEB] label")
    if web and not urls:
        problems.append("[WEB] without source URL")
    if n_data and DATA not in used:
        problems.append("[DATA] without data tool")
    if DATA in used and not n_data:
        problems.append("data tool but no [DATA] label")
    if urls - source_urls:
        problems.append(f"URL not in results: {sorted(urls - source_urls)}")
    if any(int(n) > max_n for n in web) and EXA in used:
        problems.append("[WEB n] out of range")
    if not (web or n_data or n_model):
        problems.append("no labels")
    return {"web": len(web), "data": n_data, "model": n_model,
            "urls": sorted(urls), "problems": problems}


def unanswerable_check(agent, queries=UNANSWERABLE) -> pd.DataFrame:
    """For questions with no real answer: it should search, and should not cite invented sources.
    Read the answer: whether it 'says so plainly' is a human judgement."""
    rows = []
    for q in queries:
        st = ask(agent, q)
        rep = label_report(st)
        rows.append({"question": q[:60], "searched": EXA in tools_called(st),
                     "problems": "; ".join(rep["problems"]), "answer": message_text(st["messages"][-1])[:300]})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 4. ToolMessage tokens
# ---------------------------------------------------------------------------
def tool_message_tokens(state: dict) -> list[dict]:
    """Tokens per ToolMessage = input_k - input_{k-1} - output_{k-1}.

    With parallel tools only the group total is known, so it is split by characters
    (exact=False). `billed` = tokens x number of LLM calls that re-send that content.
    """
    msgs = state["messages"]
    n_ai = sum(m.type == "ai" for m in msgs)
    names = {tc["id"]: tc["name"] for tc in _tool_calls(state)}
    rows, pending, prev, k = [], [], None, 0
    for m in msgs:
        if m.type == "tool":
            pending.append(m)
        elif m.type == "ai":
            k += 1
            u = m.usage_metadata or {}
            if pending and prev is not None:
                delta = u.get("input_tokens", 0) - prev.get("input_tokens", 0) - prev.get("output_tokens", 0)
                total_chars = sum(len(message_text(t)) for t in pending) or 1
                for t in pending:
                    n = round(delta * len(message_text(t)) / total_chars)
                    rows.append({"tool": names.get(t.tool_call_id, "?"), "chars": len(message_text(t)),
                                 "tokens": n, "billed": n * (n_ai - k + 1), "exact": len(pending) == 1})
            pending, prev = [], u
    return rows


def token_report(state: dict, verbose: bool = True) -> dict:
    """Run totals, ToolMessage tokens and their share of the input."""
    ais = [m for m in state["messages"] if m.type == "ai"]
    inp = sum((m.usage_metadata or {}).get("input_tokens", 0) for m in ais)
    out = sum((m.usage_metadata or {}).get("output_tokens", 0) for m in ais)
    rows = tool_message_tokens(state)
    billed = sum(r["billed"] for r in rows)
    rep = {"llm_calls": len(ais), "tool_calls": len(tools_called(state)),
           "input_tokens": inp, "output_tokens": out, "total_tokens": inp + out,
           "toolmsg_tokens": sum(r["tokens"] for r in rows), "toolmsg_billed_tokens": billed,
           "toolmsg_pct_input": round(100 * billed / inp, 1) if inp else 0.0, "detail": rows}
    if verbose:
        for k, v in rep.items():
            if k != "detail":
                print(f"{k:<24}{v}")
        for d in rows:
            print(f"  - {d['tool']:<16} chars={d['chars']:<6} tokens={d['tokens']:<6} "
                  f"billed={d['billed']:<6} exact={d['exact']}")
    return rep


def schema_tokens(model, tools: list) -> dict:
    """Input tokens the tool schemas add to every call = input("Hello") with tools - without."""
    without = model.invoke("Hello").usage_metadata["input_tokens"]
    return {"without_tools": without,
            "all_tools": model.bind_tools(tools).invoke("Hello").usage_metadata["input_tokens"] - without,
            **{t.name: model.bind_tools([t]).invoke("Hello").usage_metadata["input_tokens"] - without
               for t in tools}}


# ---------------------------------------------------------------------------
# 5. Exa settings: tokens vs hit rate
# ---------------------------------------------------------------------------
def tok(x) -> int:
    """Approximate tokens (chars/4) of a text or of a serialisable object."""
    return len(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)) // 4


def _hit(results: list[dict], key: str) -> bool:
    return any(key.lower() in (r["title"] + " " + " ".join(r["snippets"])).lower() for r in results)


EXA_CONFIGS = [  # (name, parameters of search_exa)
    ("highlights 500 x3 (default)", {"num_results": 3, "highlight_chars": 500}),
    ("highlights 250 x3", {"num_results": 3, "highlight_chars": 250}),
    ("highlights 500 x5", {"num_results": 5, "highlight_chars": 500}),
    ("highlights 1000 x3", {"num_results": 3, "highlight_chars": 1000}),
    ("full text 3000 x3", {"num_results": 3, "full_text_chars": 3000}),
    ("highlights 500 x3 official", {"num_results": 3, "highlight_chars": 500, "include_domains": OFFICIAL_DOMAINS}),
    ("highlights 500 x3 lite", {"num_results": 3, "highlight_chars": 500, "search_type": "lite"}),
]


def evaluate_exa_config(name: str, evalset=EXA_EVAL, **params) -> dict:
    """One Exa configuration over the eval queries: hit rate, tokens sent to the LLM and cost."""
    chars = params.get("full_text_chars") or params.get("highlight_chars", 500)
    hits, toks, n_res, cost = [], [], [], 0.0
    for q, key in evalset:
        out = search_exa(q, **params)
        hits.append(_hit(out["results"], key))
        toks.append(tok(format_results(out["results"], chars)))
        n_res.append(len(out["results"]))
        cost += out["cost"] or 0.0
    return {"config": name, "hit_rate": sum(hits) / len(hits), "mean_tokens": sum(toks) / len(toks),
            "mean_results": sum(n_res) / len(n_res), "exa_cost_usd": round(cost, 4)}


def compare_exa_configs(configs=EXA_CONFIGS, evalset=EXA_EVAL) -> pd.DataFrame:
    """Comparison table; a configuration that fails is reported and skipped."""
    rows = []
    for name, params in configs:
        try:
            rows.append(evaluate_exa_config(name, evalset, **params))
        except Exception as e:  # noqa: BLE001
            print("Failed:", name, "->", str(e)[:120])
    return pd.DataFrame(rows).round(2)


# ---------------------------------------------------------------------------
# 6. Agent variants
# ---------------------------------------------------------------------------
def run_variants(variants: dict, questions=QUESTIONS, repeats: int = 1) -> pd.DataFrame:
    """Runs each agent variant over the same questions and aggregates tokens and quality.

    route_ok = share of questions where it used exactly the expected tools;
    label_ok = share of answers with no label problems.
    """
    rows = []
    for name, agent in variants.items():
        totals, ins, outs = [], [], []
        route_ok = label_ok = n = errors = 0
        for _ in range(repeats):
            run_in = run_out = 0
            for question, expect, _key in questions:
                try:
                    with get_usage_metadata_callback() as cb:
                        st = ask(agent, question)
                except Exception as e:  # noqa: BLE001
                    errors += 1
                    print(f"[error] {name} | {question[:40]} -> {type(e).__name__}: {str(e)[:80]}")
                    continue
                run_in += sum(u["input_tokens"] for u in cb.usage_metadata.values())
                run_out += sum(u["output_tokens"] for u in cb.usage_metadata.values())
                n += 1
                route_ok += set(tools_called(st)) == set(expect)
                label_ok += not label_report(st)["problems"]
            ins.append(run_in), outs.append(run_out), totals.append(run_in + run_out)
        rows.append({
            "variant": name, "runs": repeats,
            "input_mean": round(statistics.mean(ins)), "output_mean": round(statistics.mean(outs)),
            "total_mean": round(statistics.mean(totals)),
            "total_std": round(statistics.stdev(totals)) if len(totals) > 1 else 0,
            "route_ok": round(route_ok / n, 2) if n else None,
            "label_ok": round(label_ok / n, 2) if n else None,
            "errors": errors,
        })
    return pd.DataFrame(rows)
