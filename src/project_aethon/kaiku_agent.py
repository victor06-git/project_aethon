"""Kaiku Finance agent: LangGraph agent with Exa web search and a spending-data tool.

Routing idea (two sources of knowledge + the user's own data):
    - [DATA]  the user's money            -> `query_spending` (never estimated by the model)
    - [WEB n] facts that change or are local, or anything used in a letter/claim -> `exa_search`
    - [MODEL] timeless, non-local concepts -> answered from training, no tools

The route is decided by the TYPE of data (fixed rules in the system prompt), never by how
confident the model feels.

Contains:
    1. search_exa(...)       -> one Exa call, normalised to plain dicts (reused by kaiku_eval.py)
    2. make_exa_tool(...)    -> compact `exa_search` tool (few tokens in, few tokens out)
    3. make_data_tool(...)   -> `query_spending` tool over a transactions DataFrame
    4. create_agent(...)     -> builds and compiles the agent
    5. run_agent(...)        -> runs one question and returns the final answer
"""

import getpass
import json
import operator
import os
import random
import sys
from datetime import date, timedelta
from typing import Literal, Optional

import pandas as pd
from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain.messages import AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain.tools import tool
from langgraph.graph import END, START, StateGraph
from typing_extensions import Annotated, TypedDict

MODEL_NAME = "claude-haiku-4-5-20251001"
MODEL_CUTOFF = "July 2025"  # knowledge cutoff of the model above; change both together

# Official / authoritative Finnish sources used when the model asks for `official=True`.
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
# Shared agent state
# ---------------------------------------------------------------------------
class MessagesState(TypedDict):
    messages: Annotated[list[AnyMessage], operator.add]
    llm_calls: int


def _ensure_api_keys(model_name: str = MODEL_NAME) -> None:
    """Loads .env and asks for any missing key."""
    load_dotenv()
    if model_name.startswith("claude") and not os.environ.get("ANTHROPIC_API_KEY"):
        os.environ["ANTHROPIC_API_KEY"] = getpass.getpass("Anthropic API key: ")
    if not os.environ.get("EXA_API_KEY"):
        os.environ["EXA_API_KEY"] = getpass.getpass("Exa API key: ")


# ---------------------------------------------------------------------------
# 1. Exa search (plain function, no LLM involved)
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
    highlight_chars: int = 500,
    include_domains: Optional[list[str]] = None,
    recent_days: Optional[int] = None,
    search_type: str = "auto",
    max_age_hours: Optional[int] = None,
    full_text_chars: Optional[int] = None,
    category: Optional[str] = None,
) -> dict:
    """One Exa search, normalised to {"results": [{title, url, published, snippets}], "cost"}.

    Token levers:
        - highlight_chars: Exa returns only the passages relevant to the query (highlights),
          capped at this many characters per result. This is the main saving vs full text.
        - full_text_chars: if set, asks for page text instead of highlights (for comparison).
        - num_results: fewer results = fewer tokens re-sent on every later LLM call.
    Freshness levers:
        - recent_days: only pages published in the last N days.
        - max_age_hours: 0 forces a live crawl, None uses Exa's default cache policy.
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


def format_results(results: list[dict], snippet_chars: int = 500) -> str:
    """Compact, numbered text for the LLM: `[n] title | url | published` + quoted passages.

    The number is what the model cites as [WEB n]. No ids, scores or metadata.
    """
    if not results:
        return "No relevant results."
    lines = []
    for i, r in enumerate(results, start=1):
        head = f"[{i}] {r['title']} | {r['url']}"
        if r.get("published"):
            head += f" | published {r['published']}"
        lines.append(head)
        budget = snippet_chars
        for s in r["snippets"]:
            s = " ".join(s.split())[:budget]
            if not s:
                break
            lines.append(f'    "{s}"')
            budget -= len(s)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 2. `exa_search` tool (what the LLM sees)
# ---------------------------------------------------------------------------
def make_exa_tool(
    num_results: int = 3,
    highlight_chars: int = 500,
    official_domains: Optional[list[str]] = None,
    search_type: str = "auto",
    max_age_hours: Optional[int] = None,
    full_text_chars: Optional[int] = None,
):
    """Builds the `exa_search` tool. Developer-side settings are fixed here; the LLM only fills
    in `query`, `official` and `recent_days`, which keeps the tool schema small.

    The returned tool has a `.stats` dict (calls, results, cost) for the evaluation.
    """
    domains = official_domains or OFFICIAL_DOMAINS
    stats = {"calls": 0, "results": 0, "cost": 0.0}

    @tool
    def exa_search(query: str, official: bool = False, recent_days: Optional[int] = None) -> str:
        """Search the live web. Returns numbered sources with quoted passages.

        Args:
            query: What to find, with the explicit place, subject and year.
            official: True to search only official Finnish sources (laws, benefits, taxes, central bank).
            recent_days: Only pages published in the last N days (use for rates, prices, news).
        """
        out = search_exa(
            query,
            num_results=num_results,
            highlight_chars=highlight_chars,
            include_domains=domains if official else None,
            recent_days=recent_days,
            search_type=search_type,
            max_age_hours=max_age_hours,
            full_text_chars=full_text_chars,
        )
        stats["calls"] += 1
        stats["results"] += len(out["results"])
        stats["cost"] += out["cost"] or 0.0
        if not out["results"]:
            hint = " Retry once with official=false." if official else ""
            return "No relevant results." + hint
        return format_results(out["results"], full_text_chars or highlight_chars)

    exa_search.stats = stats  # type: ignore[attr-defined]
    return exa_search


# ---------------------------------------------------------------------------
# 3. Spending data: sample transactions + `query_spending` tool
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
    the S-Bank dataset so the agent can be tested locally."""
    rng = random.Random(seed)
    today = today or date.today()
    start = today - timedelta(days=30 * months)
    rows = []
    d = start
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
    """Totals computed in pandas (the LLM never does this arithmetic)."""
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


def make_data_tool(df: pd.DataFrame):
    """Builds the `query_spending` tool over the given transactions."""

    @tool
    def query_spending(category: Optional[str] = None, start_date: Optional[str] = None,
                       end_date: Optional[str] = None,
                       group_by: Literal["category", "month", "basket", "merchant"] = "category") -> str:
        """Totals of the user's own spending in EUR, computed from their bank transactions.

        Args:
            category: One category (e.g. taxi, coffee, food_delivery, rent) or omit for all.
            start_date: First day, YYYY-MM-DD.
            end_date: Last day, YYYY-MM-DD.
            group_by: Breakdown of the total.
        """
        return json.dumps(spending_summary(df, category, start_date, end_date, group_by), ensure_ascii=False)

    return query_spending


# ---------------------------------------------------------------------------
# System prompt: routing by type of data + source labels
# ---------------------------------------------------------------------------
def build_system_prompt(cutoff: str = MODEL_CUTOFF, today: Optional[date] = None) -> str:
    """Ordered rules; the first that applies wins. Short on purpose: it is re-sent on every call."""
    today = today or date.today()
    return (
        "You are Kaiku, a personal finance coach inside a Finnish banking app.\n"
        f"Current date: {today.isoformat()}. Your knowledge ends in {cutoff}.\n"
        "Tools: `query_spending` (the user's own transactions) and `exa_search` (live web).\n\n"
        "Choose the source by the TYPE of information, never by how confident you feel. "
        "Apply every rule that matches the question:\n"
        "1. The user's own money (what they spent, where it goes, their habits): call "
        "`query_spending`. Never estimate or invent their figures. Resolve relative periods "
        "(last month, this week) from the current date into explicit dates.\n"
        "2. ALWAYS call `exa_search`, and never answer from memory, when the fact:\n"
        "   a) changes over time: interest rates, Euribor, prices, inflation, benefit amounts, "
        "tax rates, laws and rules, news, anything current, latest, this year or after your cutoff;\n"
        "   b) depends on place or institution: Finnish law, a municipality, a specific bank or company;\n"
        "   c) is niche: eligibility requirements, procedures, deadlines, forms;\n"
        "   d) will be used in a letter, claim or application, even if you think it is stable.\n"
        "3. ONLY timeless, non-local knowledge (definitions, how compound interest works, what an "
        "emergency fund is, arithmetic, history before your cutoff): answer directly with NO tools. "
        "Do not search to double-check it.\n"
        "4. Searching: put the explicit place, subject and year in the query. Use official=true "
        "for laws, benefits, taxes and central-bank data; if it returns nothing, retry once with "
        "official=false. Use recent_days for rates, prices and news.\n"
        "5. If the search finds nothing reliable, say so plainly. Do not fill the gap from memory.\n"
        "6. If the question is unclear, ask one clarifying question instead of guessing.\n\n"
        "Labels: end every factual sentence with exactly one label showing where it comes from:\n"
        "   [WEB n]  from search result n. Use only facts present in the results.\n"
        "   [DATA]   from `query_spending`.\n"
        "   [MODEL]  your general knowledge.\n"
        "If you used any [WEB n], finish with a line 'Sources:' followed by one line per source "
        "used, as 'n. title - url', copying the url exactly from the results.\n"
        "Lead with the direct answer and one headline figure. Keep it short. "
        "Do not give investment advice. Answer in the language of the user."
    )


# ---------------------------------------------------------------------------
# 4. Create the agent
# ---------------------------------------------------------------------------
def create_agent(
    model_name: str = MODEL_NAME,
    temperature: float = 0,
    system_prompt: Optional[str] = None,
    max_llm_calls: int = 8,
    transactions: Optional[pd.DataFrame] = None,
    exa_tool=None,
    # ---- exa_search settings (ignored if `exa_tool` is given) ----
    num_results: int = 3,
    highlight_chars: int = 500,
    **model_kwargs,
):
    """Builds and compiles the Kaiku agent.

    Args:
        model_name: Any model supported by `init_chat_model`. For an OpenAI-compatible endpoint
            (e.g. Gemma served on Verda) pass model_provider="openai", base_url=..., api_key=...
            through **model_kwargs.
        system_prompt: Custom prompt; defaults to `build_system_prompt()`.
        max_llm_calls: Upper bound of model calls per question (avoids loops).
        transactions: DataFrame for `query_spending`; defaults to the synthetic sample.
        exa_tool: A tool built with `make_exa_tool(...)` to test another configuration.
        num_results, highlight_chars: Settings of the default `exa_search` tool.

    Returns:
        The compiled graph, ready for `.invoke({"messages": [...]})`.
    """
    _ensure_api_keys(model_name)
    system_prompt = system_prompt or build_system_prompt()
    model = init_chat_model(model_name, temperature=temperature, **model_kwargs)

    search_tool = exa_tool or make_exa_tool(num_results=num_results, highlight_chars=highlight_chars)
    data_tool = make_data_tool(transactions if transactions is not None else load_transactions())
    tools = [data_tool, search_tool]
    tools_by_name = {t.name: t for t in tools}
    model_with_tools = model.bind_tools(tools)

    def llm_call(state: dict):
        response = model_with_tools.invoke([SystemMessage(content=system_prompt)] + state["messages"])
        return {"messages": [response], "llm_calls": state.get("llm_calls", 0) + 1}

    # Any exception (bad arguments, Exa error, unknown tool) goes back to the model as a
    # ToolMessage with status="error" so it can fix the call instead of crashing the run.
    def tool_node(state: dict):
        results = []
        for tool_call in state["messages"][-1].tool_calls:
            status = "success"
            try:
                observation = tools_by_name[tool_call["name"]].invoke(tool_call["args"])
                if not isinstance(observation, str):
                    observation = json.dumps(observation, ensure_ascii=False, default=str)
            except Exception as e:  # noqa: BLE001 - returned to the model, not hidden
                status = "error"
                observation = (f"Error calling `{tool_call['name']}`: {type(e).__name__}: {e}. "
                               "Fix the arguments or try a different query.")
            results.append(ToolMessage(content=observation, tool_call_id=tool_call["id"],
                                       name=tool_call["name"], status=status))
        return {"messages": results}

    def should_continue(state: MessagesState) -> Literal["tool_node", "__end__"]:
        if state.get("llm_calls", 0) >= max_llm_calls:
            return END
        if state["messages"][-1].tool_calls:
            return "tool_node"
        return END

    builder = StateGraph(MessagesState)
    builder.add_node("llm_call", llm_call)
    builder.add_node("tool_node", tool_node)
    builder.add_edge(START, "llm_call")
    builder.add_conditional_edges("llm_call", should_continue, ["tool_node", END])
    builder.add_edge("tool_node", "llm_call")
    return builder.compile()


# ---------------------------------------------------------------------------
# 5. Run the agent
# ---------------------------------------------------------------------------
def message_text(m) -> str:
    """Text of a message; if the content comes in blocks, joins the text parts."""
    c = m.content
    if isinstance(c, list):
        c = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in c)
    return c


def run_agent(agent, question: str, verbose: bool = False) -> str:
    """Runs one question and returns the final answer. verbose=True prints every message."""
    state = agent.invoke({"messages": [HumanMessage(content=question)]})
    if verbose:
        for m in state["messages"]:
            m.pretty_print()
    return message_text(state["messages"][-1])


def main() -> None:
    """Usage: python kaiku_agent.py "your question" (asks for it if no argument is given)."""
    question = " ".join(sys.argv[1:]).strip() or input("Question: ").strip()
    if not question:
        raise SystemExit("No question given.")
    print("\n", run_agent(create_agent(), question))


if __name__ == "__main__":
    main()
