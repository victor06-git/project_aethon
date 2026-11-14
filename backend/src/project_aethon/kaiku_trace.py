"""Kaiku trace: see at a glance what the pipeline did with a question, and why.

    from project_aethon.kaiku_trace import show_trace, explain, timeline

    show_trace(agent.ask("..."))     # one question, step by step
    explain(agent, "...")            # ask + trace + answer in one call
    timeline(results)                # one row per question: seconds and tokens per step

Command line (from the `src` folder):
    python -m project_aethon.kaiku_trace "your question" [--thoughts] [--thinking low] [--json]

What each step shows:
    1 ROUTE     the route, who decided it (model / guardrail / fallback), the router's reason,
                what the code guardrail saw, and the search or data parameters it produced
    2 RETRIEVE  the Exa searches (official + open web), the sources found with their OFFICIAL
                tag and date, and the figures computed from the transactions
    3 ANSWER    the model, mode and thinking level, which sources were cited and which were
                ignored, the fragment that backs each citation, the calculations the app ran,
                the quotes verified in a document, and the automatic checks

The model's own reasoning summary appears under each step when the agent is created with
`show_thoughts=True` (with thinking level "minimal" Gemini usually returns none).

Every Result carries the same information as data in `result.steps` (a list of dicts), so a
UI can draw this trace without parsing text.
"""
import argparse
import json
import textwrap

import pandas as pd

from .kaiku_agent import Kaiku, Result, create_agent

W = 100  # width of the trace


def _head(num: int, name: str, summary: str, right: str = "") -> str:
    """Step header with the cost on the right; the cost drops to its own line if it does not fit."""
    left = f"{num} {name:<9} {summary}"
    if len(left) + len(right) + 2 <= W:
        return f"{left:<{W - len(right)}}{right}".rstrip()
    return left + "\n" + "\n".join(_rows("cost", right))


def _rows(label: str, values) -> list[str]:
    """`  label     : value`, with continuation lines aligned under the first value."""
    values = [values] if isinstance(values, str) else list(values)
    return [f"  {label if i == 0 else '':<10}{':' if i == 0 else ' '} {v}" for i, v in enumerate(values)]


def _thoughts(text: str) -> list[str]:
    if not text:
        return []
    wrapped = textwrap.wrap(" ".join(text.split()), W - 16)[:8]
    return _rows("thoughts", wrapped)


def trace(res: Result) -> str:
    """The trace of one Result as text."""
    steps = {s["step"]: s for s in res.steps}
    src = {s["n"]: s for s in res.sources}
    q = " ".join(res.question.split())
    out = [f'KAIKU TRACE  "{q[:W - 18]}{"..." if len(q) > W - 18 else ""}"', "=" * W]

    # ---- 1 ROUTE ----
    r = steps.get("route", {})
    right = (f"{r.get('seconds', 0):.2f}s | {r.get('tokens_in', 0)} in / {r.get('tokens_out', 0)} out"
             f" | thinking {r.get('thinking_tokens', 0)}" + (" | cached" if r.get("cached") else ""))
    out.append(_head(1, "ROUTE", f"-> {res.route.upper()}" + (" (document)" if res.document else ""), right))
    out += _rows("decided by", res.decided_by)
    if r.get("why"):
        out += _rows("why", r["why"])
    marker = r.get("guardrail")
    if res.decided_by.startswith("guardrail"):
        out += _rows("guardrail", f"OVERRODE the model: {r.get('model_route')} -> {res.route}")
    elif marker:
        out += _rows("guardrail", f"no override needed; this question can never be static ({marker})")
    else:
        out += _rows("guardrail", "no time, place or document marker: the model's decision stands")
    out += _rows("language", f"{r.get('lang')} | router thinking level: {r.get('thinking_level')}")
    if r.get("query"):
        days = f" | open web limited to the last {r['recent_days']} days" if r.get("recent_days") else ""
        out += _rows("search", f'"{r["query"]}"{days}')
    dp = r.get("data_params")
    if dp:
        out += _rows("data query", f"category={dp['category'] or 'all'} | {dp['start_date'] or 'start'} to "
                                   f"{dp['end_date'] or 'today'} | group by {dp['group_by']}")
    out += _thoughts(r.get("thoughts", ""))

    # ---- 2 RETRIEVE ----
    out.append("-" * W)
    v = steps.get("retrieve")
    if v is None:
        why = "answered from training" if res.route == "static" else "nothing to look up"
        out.append(_head(2, "RETRIEVE", f"skipped: {why}"))
    else:
        what = []
        if v["searches"]:
            what.append(f"Exa x{len(v['searches'])} in parallel" + (" (from cache)" if v["cached"] else ""))
        if v["data"] is not None:
            what.append("pandas on the transactions")
        out.append(_head(2, "RETRIEVE", " + ".join(what) or "nothing found",
                         f"{v['seconds']:.2f}s | Exa ${v['exa_cost']:.3f}"))
        for s in v["searches"]:
            out += _rows(s["scope"], f"{s['results']} results" + (f" | ERROR {s['error']}" if s.get("error") else ""))
        for s in v["sources"]:
            out.append(f"  [{s['n']}] {'OFFICIAL' if s['official'] else 'web':<8} {s['domain'][:26]:<26} "
                       f"{s['published'] or 'no date':<10}  {s['title'][:W - 56]}")
        d = v["data"]
        if d is not None:
            if "error" in d:
                out += _rows("data", f"ERROR {d['error']}")
            else:
                line = (f"{d['category']} | {d['period']} | total {d['total_eur']:,.2f} EUR | "
                        f"{d['transactions']} transactions")
                if "avg_per_month_eur" in d:
                    line += f" | avg/month {d['avg_per_month_eur']:,.2f} ({d['complete_months']} full months)"
                out += _rows("data", line)

    # ---- 3 ANSWER ----
    out.append("-" * W)
    a = steps.get("answer")
    if a is None:
        why = "the router wrote the answer from training" if res.route == "static" else "the router asked back"
        out.append(_head(3, "ANSWER", f"skipped: {why} (no second model call)"))
    elif a["mode"].startswith("skipped"):
        out.append(_head(3, "ANSWER", f"{a['mode']} (no model call, fixed reply)"))
    else:
        right = f"{a['seconds']:.2f}s | {a['tokens_in']} in / {a['tokens_out']} out | thinking {a['thinking_tokens']}"
        out.append(_head(3, "ANSWER", f"{a['model']} | mode: {a['mode']} | thinking level: {a['thinking_level']}",
                         right))
        if a["no_evidence"]:
            out += _rows("outcome", "NO_EVIDENCE: the model judged that no source answers the question")
        cites = []
        for c in a["cited"]:
            s = src.get(c["n"], {})
            tag = f"[{c['k']}]" if res.document else f"[WEB {c['k']}]"
            cites.append(f"{tag} <- source {c['n']} {'OFFICIAL' if s.get('official') else 'web'} "
                         f"{s.get('domain', '?')} | fragment \"{c['fragment']}\""
                         + ("" if c["matched"] else "  (NOT matched in the source text)"))
        if cites:
            out += _rows("cited", cites)
        if a["unused"]:
            out += _rows("not used", "sources " + ", ".join(map(str, a["unused"])))
        calcs = [f"{c['expr']} = {c['shown']}" if "shown" in c else f"{c['expr']}  FAILED: {c['error']}"
                 for c in a["calcs"]]
        if calcs:
            out += _rows("calc", calcs)
        quotes = [(f"VERIFIED ({q['match']}) in source {q['n']}" if q["n"] is not None else "NOT FOUND in any source")
                  + f': "{q["quote"][:60]}{"..." if len(q["quote"]) > 60 else ""}"' for q in a["quotes"]]
        if quotes:
            out += _rows("quotes", quotes)
        ck = a["checks"]
        fig = ck["figures"]
        parts = ["labels OK" if not ck["labels"] else "LABEL PROBLEMS: " + "; ".join(ck["labels"]),
                 f"figures grounded {fig['checked'] - len(fig['ungrounded'])}/{fig['checked']}"
                 + (f" (not in the evidence: {', '.join(fig['ungrounded'])})" if fig["ungrounded"] else "")]
        if ck["cited"]:
            parts.append(f"official sources cited {ck['official_cited']}/{ck['cited']}")
        if ck["quotes"]["total"]:
            parts.append(f"quotes verified {ck['quotes']['verified']}/{ck['quotes']['total']}")
        out += _rows("checks", " | ".join(parts))
        out += _thoughts(a.get("thoughts", ""))

    # ---- total ----
    out.append("=" * W)
    out.append(f"TOTAL       {res.llm_calls} model call(s) | {res.total_tokens:,} tokens "
               f"({res.tokens['reasoning']} thinking) | {res.total_seconds:.2f}s | Exa ${res.exa_cost:.3f}"
               + (" | SERVED FROM CACHE" if res.cached else ""))
    for note in res.notes:
        out.append(f"note        {note}")
    return "\n".join(out)


def show_trace(res: Result) -> None:
    print(trace(res))


def explain(agent: Kaiku, question: str) -> Result:
    """Asks the question and prints the trace followed by the final answer."""
    res = agent.ask(question)
    print(trace(res))
    print("\n" + res.answer)
    return res


def timeline(results: dict) -> pd.DataFrame:
    """One row per question: where the seconds and the tokens went."""
    rows = []
    for name, res in results.items():
        t, ck = res.tokens, res.checks or {}
        rows.append({
            "case": name, "route": res.route + (" (doc)" if res.document else ""), "decided_by": res.decided_by,
            "route_s": res.seconds.get("route", 0.0), "retrieve_s": res.seconds.get("retrieve", 0.0),
            "answer_s": res.seconds.get("answer", 0.0), "total_s": res.total_seconds,
            "router_tok": t["router_in"] + t["router_out"], "answer_tok": t["answer_in"] + t["answer_out"],
            "thinking_tok": t["reasoning"],
            "sources": f"{sum(s['official'] for s in res.sources)} official / {len(res.sources)}",
            "cited": ck.get("cited", 0), "problems": len(ck.get("labels", [])),
        })
    return pd.DataFrame(rows)


def main() -> None:
    p = argparse.ArgumentParser(description="Ask Kaiku one question and print the trace.")
    p.add_argument("question", nargs="+")
    p.add_argument("--thoughts", action="store_true", help="ask the model for its reasoning summary")
    p.add_argument("--thinking", default=None, help="thinking level of the answer step (minimal, low, ...)")
    p.add_argument("--json", action="store_true", help="print the steps as JSON instead of text")
    args = p.parse_args()
    kwargs = {"show_thoughts": args.thoughts}
    if args.thinking:
        kwargs["answer_thinking"] = args.thinking
    res = create_agent(**kwargs).ask(" ".join(args.question))
    if args.json:
        print(json.dumps(res.steps, indent=2, ensure_ascii=False, default=str))
    else:
        print(trace(res))
        print("\n" + res.answer)


if __name__ == "__main__":
    main()
