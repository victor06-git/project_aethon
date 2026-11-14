"""Mortgage decision answers for the Kaiku service, from the trained model in mortgage_ml/.

Answers, with zero LLM calls (pure code, instant):
    "Will my mortgage be approved?"        -> rejection risk from XGBoost + verdict at the 0.25 threshold
    "Why? / what are my weak points?"      -> the customer's values vs approved applicants, weighted by SHAP
    "What should I change to get it?"      -> three recomputed scenarios: more equity, more collateral, cheaper home

The folder produced by the mortgage_ml project must sit at backend/mortgage_ml (or point
KAIKU_MORTGAGE_DIR at it). Two tiers, chosen automatically:

    full      models/xgboost_full.joblib + artifacts/features.parquet
              -> live scoring, personal weak points and what-if scenarios.
              Needs: scikit-learn>=1.6, xgboost>=2.1, catboost>=1.2, pyarrow
    fallback  predictions.csv / artifacts/oof_predictions.csv + reports/feature_importance_shap_xgboost.csv
              -> stored probability and the global factors only (no extra packages needed)

The demo customer is KAIKU_MORTGAGE_ID (default C0681, a real held-out application); a question
can name another one ("... for customer C0479"). Not a bank decision: a statistical estimate.
"""
import csv
import os
import re
import time
from pathlib import Path
from typing import Optional

THRESHOLD = 0.25          # decision threshold from reports/model_report.md (max OOF F1)
HOLDOUT_AUC = "0.84"      # quoted in the answer so the uncertainty is visible
DEFAULT_ID = os.environ.get("KAIKU_MORTGAGE_ID", "C0681")

# Friendly wording for the features shown to the user: label, kind (ratio | eur | months | years)
LABELS = {
    "residual_income_coverage": ("income left after living costs vs the required payment", "ratio"),
    "customer_age": ("age", "years"),
    "collateral_shortfall_eur": ("collateral shortfall", "eur"),
    "equity_coverage": ("savings on the account vs the down payment", "ratio"),
    "tx_salary_sweep_m": ("salary leaving the account right after payday (per month)", "eur"),
    "tx_balance_min": ("lowest account balance in the last year", "eur"),
    "salary_coverage": ("salary vs the required income", "ratio"),
    "tx_balance_last": ("account balance at application", "eur"),
    "tx_housing_to_income": ("current housing cost vs income", "ratio"),
    "lfinal_loan_to_value": ("loan to value", "ratio"),
    "tx_savings_rate": ("share of income moved to savings", "ratio"),
    "collateral_coverage_total": ("total collateral vs the loan", "ratio"),
    "cash_need_coverage": ("cash vs down payment plus fees", "ratio"),
    "collateral_coverage_primary": ("home value vs the loan", "ratio"),
    "collateral_total_value": ("total collateral value", "eur"),
    "tx_discretionary_share": ("share of spending that is discretionary", "ratio"),
    "income_coverage": ("income vs the required income", "ratio"),
    "loan_to_annual_income": ("loan vs annual income", "ratio"),
    "debt_adjusted_income_coverage": ("income after existing loan payments vs required", "ratio"),
    "tx_balance_mean": ("average account balance", "eur"),
}

_MORTGAGE = re.compile(r"\b(mortgage|home loan|housing loan|asuntolaina|hipoteca)\b", re.I)
_ABOUT = re.compile(r"approv|reject|accept|den(y|ied)|chance|likel|odds|qualif|\bget\b|will i|"
                    r"\brisk\b|weak|why|improve|strengthen|what (if|should|would|can)|how can", re.I)
_CUST = re.compile(r"\b(C\d{4})\b")
_AMOUNT = re.compile(r"(\d[\d\s.,]{2,})\s*(?:€|eur)|€\s*(\d[\d\s.,]{2,})", re.I)

_state: dict = {}


# ---------------------------------------------------------------------------
# Loading (once, cached in _state)
# ---------------------------------------------------------------------------
def _find_dir() -> Optional[Path]:
    env = os.environ.get("KAIKU_MORTGAGE_DIR")
    here = Path(__file__).resolve()
    for cand in ([Path(env)] if env else []) + [here.parents[2] / "mortgage_ml",
                                               here.parents[3] / "mortgage_ml",
                                               Path.cwd() / "mortgage_ml"]:
        if (cand / "reports" / "feature_importance_shap_xgboost.csv").is_file():
            return cand
    return None


def _load() -> dict:
    """Loads the best available tier. _state["tier"]: "full" | "fallback" | "off"."""
    if _state:
        return _state
    root = _find_dir()
    if root is None:
        _state.update(tier="off", why="mortgage_ml folder not found (put it in backend/ or set KAIKU_MORTGAGE_DIR)")
        return _state
    with open(root / "reports" / "feature_importance_shap_xgboost.csv", encoding="utf-8-sig") as f:
        shap = [r for r in csv.DictReader(f)]
    for r in shap:
        r["mean_abs_shap"] = float(r["mean_abs_shap"])
    probs: dict[str, float] = {}
    for name, col in (("predictions.csv", "p_rejected_xgboost"), (Path("artifacts") / "oof_predictions.csv", "oof_xgboost")):
        p = root / name
        if p.is_file():
            with open(p, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    probs.setdefault(r["mortgage_customer_id"], float(r[col]))
    _state.update(tier="fallback", root=root, shap=shap, probs=probs, why=None)
    try:
        import joblib  # noqa: PLC0415
        import pandas as pd  # noqa: PLC0415
        import sys  # noqa: PLC0415

        if str(root) not in sys.path:  # the pickled pipeline references `src.estimators`
            sys.path.insert(0, str(root))
        model = joblib.load(root / "models" / "xgboost_full.joblib")
        feats = pd.read_parquet(root / "artifacts" / "features.parquet")
        id_col = "mortgage_customer_id"
        feats = feats.set_index(id_col, drop=False) if id_col in feats.columns else feats
        drop = [c for c in (id_col, "customer_id", "rejected", "final_decision", "app_ts") if c in feats.columns]
        X = feats.drop(columns=drop)
        approved = feats["rejected"] == 0 if "rejected" in feats.columns else None
        _state.update(tier="full", model=model, feats=feats, X=X,
                      bench=X[approved.values] if approved is not None else X)
    except Exception as e:  # noqa: BLE001 - missing packages or files: stay on fallback
        _state["why"] = f"full tier unavailable ({type(e).__name__}: {str(e)[:120]}); using stored predictions"
    return _state


# ---------------------------------------------------------------------------
# Scoring, weak points and what-if (full tier)
# ---------------------------------------------------------------------------
def _proba(row) -> float:
    import pandas as pd  # noqa: PLC0415

    s = _load()
    X = pd.DataFrame([row])[s["X"].columns]
    return float(s["model"].predict_proba(X)[0, 1])


def recompute_derived(r: dict) -> dict:
    """Re-derives the engineered ratios from the raw fields of one feature row
    (formulas from mortgage_ml/src/features.py), so a what-if stays consistent."""
    loan, price, equity = r["final_requested_loan_eur"], r["final_property_price_eur"], r["final_equity_amount_eur"]
    req = r["required_monthly_income_eur"]
    total_col = r["final_collateral_value_eur"] + r["neg_additional_collateral_value"]
    r["collateral_total_value"] = total_col
    r["collateral_coverage_primary"] = r["final_collateral_value_eur"] / loan
    r["collateral_coverage_total"] = total_col / loan
    r["collateral_shortfall_eur"] = max(loan - total_col, 0.0)
    r["collateral_to_price"] = total_col / price
    r["lfinal_loan_to_value"] = loan / price
    r["income_coverage"] = r["tx_income_m"] / req
    r["salary_coverage"] = r["tx_salary_median"] / req
    r["residual_income_coverage"] = (r["tx_income_m"] - r["tx_living_cost_ex_housing_m"]) / req
    r["debt_adjusted_income_coverage"] = (r["tx_income_m"] - r["exp_existing_loan"]) / req
    r["loan_to_annual_income"] = loan / (12 * r["tx_income_m"])
    r["equity_coverage"] = r["tx_balance_last"] / equity if equity else r["equity_coverage"]
    r["cash_need_coverage"] = r["tx_balance_last"] / (equity + r["exp_total"])
    r["expenses_to_price"] = r["exp_total"] / price
    if r.get("ctx_postal_salary_median"):
        r["price_vs_postal_salary"] = price / r["ctx_postal_salary_median"]
    if r.get("neg_first_property_price"):
        r["price_vs_first_property"] = price / r["neg_first_property_price"]
    if r.get("neg_max_property_price"):
        r["price_vs_max_considered"] = price / r["neg_max_property_price"]
    return r


def _lever(base: dict, kind: str, amount: float) -> dict:
    """One scenario on the raw fields; derived ratios are recomputed. The income the bank
    requires scales with the loan (required = ratio * loan, exact in this dataset)."""
    r = dict(base)
    ratio = r["required_monthly_income_eur"] / r["final_requested_loan_eur"]
    if kind == "equity":          # pay a larger down payment: same home, smaller loan
        r["final_equity_amount_eur"] += amount
        r["final_requested_loan_eur"] -= amount
    elif kind == "collateral":    # pledge additional collateral
        r["neg_additional_collateral_value"] += amount
        r["neg_has_additional_collateral"] = 1
        r["neg_additional_collateral_requested"] = 1
    elif kind == "price":         # choose a home cheaper by `amount` EUR, same equity
        r["final_property_price_eur"] -= amount
        r["final_requested_loan_eur"] -= amount
    r["required_monthly_income_eur"] = ratio * r["final_requested_loan_eur"]
    return recompute_derived(r)


def _fmt(value: float, kind: str) -> str:
    if kind == "eur":
        return f"€{value:,.0f}"
    if kind in ("years", "months"):
        return f"{value:.0f}"
    return f"{value:.2f}"


def weak_points(row: dict, top: int = 3) -> tuple[list[str], list[str]]:
    """(weaknesses, strengths): where this application sits among APPROVED ones, on the
    features the model weighs most. Position is a percentile; SHAP gives the weight."""
    s = _load()
    weak, strong = [], []
    for f in s["shap"]:
        name, direction = f["feature"], f.get("direction", "")
        if name not in row or name not in s["bench"].columns or "→" not in direction:
            continue
        col = s["bench"][name].dropna()
        if len(col) < 10 or col.std() == 0:
            continue
        pct = float((col <= row[name]).mean())
        toward_rejection = "rejection" in direction
        offside = pct if toward_rejection else 1 - pct  # 1 = deep on the rejection side
        label, kind = LABELS.get(name, (name.replace("_", " "), "ratio"))
        typical = _fmt(float(col.median()), kind)
        line = f"{label}: {_fmt(float(row[name]), kind)} (typical approved: {typical})"
        score = f["mean_abs_shap"] * abs(pct - 0.5) * 2
        (weak if offside >= 0.75 else strong if offside <= 0.25 else []).append((score, line))
    weak.sort(reverse=True)
    strong.sort(reverse=True)
    return [l for _, l in weak[:top]], [l for _, l in strong[:2]]


def what_if(base: dict, p0: float, amount_override: Optional[float] = None) -> list[str]:
    """The three scenarios, best first, each re-scored by the model."""
    scenarios = [("collateral", amount_override or 30000, "pledge €{a:,.0f} of additional collateral"),
                 ("equity", amount_override or 10000, "put in €{a:,.0f} more equity (smaller loan)"),
                 ("price", round(0.10 * base["final_property_price_eur"]), "choose a home ~10% cheaper (−€{a:,.0f})")]
    out = []
    for kind, amount, tmpl in scenarios:
        try:
            p1 = _proba(_lever(base, kind, float(amount)))
        except Exception:  # noqa: BLE001 - one broken scenario should not kill the answer
            continue
        verdict = " → below the review threshold" if p1 < THRESHOLD <= p0 else ""
        out.append((p1, f"{tmpl.format(a=float(amount))}: rejection risk {p0:.0%} → {p1:.0%}{verdict}"))
    out.sort()
    return [line for _, line in out]


# ---------------------------------------------------------------------------
# The answer (docs/API.md shape)
# ---------------------------------------------------------------------------
def wants_mortgage_answer(question: str) -> bool:
    return bool(_MORTGAGE.search(question) and _ABOUT.search(question))


def _verdict(p: float) -> str:
    if p < THRESHOLD:
        return f"likely to be APPROVED (rejection risk {p:.0%}, below the {THRESHOLD:.0%} review threshold)"
    if p < 0.5:
        return f"BORDERLINE (rejection risk {p:.0%}, above the {THRESHOLD:.0%} review threshold)"
    return f"at HIGH RISK of rejection ({p:.0%})"


def try_answer(question: str) -> Optional[dict]:
    """The coach Answer for a mortgage-decision question, or None when the question is not
    one (the service then continues to the normal Kaiku pipeline)."""
    if not wants_mortgage_answer(question):
        return None
    t0 = time.perf_counter()
    s = _load()
    if s["tier"] == "off":
        return {"type": "fact", "source": "model",
                "text": f"The mortgage model is not available: {s['why']}.",
                "trace": _trace("off", 0, t0)}
    m = _CUST.search(question)
    cid = m.group(1) if m else DEFAULT_ID
    amount = None
    am = _AMOUNT.search(question)
    if am:
        try:
            amount = float(re.sub(r"[\s.,](?=\d{3}\b)", "", (am.group(1) or am.group(2)).strip()).replace(",", "."))
        except ValueError:
            amount = None

    lines: list[str] = []
    if s["tier"] == "full" and cid in s["feats"].index:
        row = {k: (float(v) if isinstance(v, (int, float)) else v)
               for k, v in s["feats"].loc[cid].items()}
        p = _proba(row)
        lines.append(f"Application {cid} is {_verdict(p)}.")
        weak, strong = weak_points(row)
        if weak:
            lines.append("What pulls it towards rejection:")
            lines += [f"- {w}" for w in weak]
        if strong:
            lines.append("In its favour: " + "; ".join(strong) + ".")
        scenarios = what_if(row, p, amount)
        if scenarios:
            lines.append("What would change the decision most:")
            lines += [f"- {sc}" for sc in scenarios]
    elif cid in s["probs"]:
        p = s["probs"][cid]
        lines.append(f"Application {cid} is {_verdict(p)}.")
        top = [f for f in s["shap"][:6] if "→" in f.get("direction", "")]
        lines.append("The factors the model weighs most (across all applications): "
                     + "; ".join(f"{LABELS.get(f['feature'], (f['feature'].replace('_', ' '),))[0]}"
                                 f" ({'risk' if 'rejection' in f['direction'] else 'protective'})" for f in top) + ".")
        if s["why"]:
            lines.append(f"Note: {s['why']}. Install scikit-learn, xgboost, catboost and pyarrow "
                         "for personal weak points and what-if scenarios.")
    else:
        return {"type": "fact", "source": "model",
                "text": f"I have no application on file for {cid}. Known ids look like C0479.",
                "trace": _trace(s["tier"], 0, t0)}
    lines.append("This is a statistical estimate from past applications, not a bank decision.")
    return {"type": "fact", "source": "model", "text": "\n".join(lines),
            "figure": f"{p:.0%} rejection risk",
            "dataUsed": {"period": "200 applications, Jan-Aug 2026 (S-Pankki synthetic dataset)",
                         "transactions": 200,
                         "note": f"XGBoost, holdout AUC {HOLDOUT_AUC}, threshold {THRESHOLD:.0%}"},
            "trace": _trace(s["tier"], p, t0)}


def _trace(tier: str, p: float, t0: float) -> dict:
    return {"route": f"mortgage ({'local model' if tier == 'full' else tier})",
            "decidedBy": "code (mortgage intent)", "llmCalls": 0, "tokens": 0,
            "seconds": round(time.perf_counter() - t0, 2), "exaCost": 0.0,
            "query": None, "thinkingLevel": None, "cached": False, "problems": []}


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "Will my mortgage be approved?"
    a = try_answer(q)
    print(a["text"] if a else "(not a mortgage-decision question)")
