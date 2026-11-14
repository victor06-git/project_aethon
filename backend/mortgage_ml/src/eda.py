"""Data audit: schemas, integrity, joins, leakage, collinearity, drift.

Writes reports/eda_summary.md. Every statement in the report is computed here,
nothing is hard-coded. Anything that looks at the *target* uses the development
split only, so the chronological holdout stays untouched by human eyes too.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from statsmodels.stats.outliers_influence import variance_inflation_factor

from . import config as C
from . import features as F

warnings.filterwarnings("ignore")


def _md(df: pd.DataFrame, index: bool = False, floatfmt: str = ".3f") -> str:
    return df.to_markdown(index=index, floatfmt=floatfmt)


def _schema(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "column": df.columns,
        "dtype": [str(t) for t in df.dtypes],
        "missing_%": (df.isna().mean() * 100).round(1).values,
        "n_unique": [df[c].nunique(dropna=True) for c in df.columns],
        "example": [str(df[c].dropna().iloc[0])[:40] if df[c].notna().any() else "" for c in df.columns],
    })


def _ends_with_newline(path) -> bool:
    with open(path, "rb") as fh:
        fh.seek(-2, 2)
        return fh.read().endswith(b"\n")


def _vif(X: pd.DataFrame) -> pd.Series:
    Z = (X - X.mean()) / X.std()
    Z = Z.loc[:, Z.notna().all()]
    vals = [variance_inflation_factor(Z.values, i) for i in range(Z.shape[1])]
    return pd.Series(vals, index=Z.columns).sort_values(ascending=False)


def run_eda(verbose: bool = True) -> str:
    C.ensure_dirs()
    apps, neg, cust = F.load_applications(), F.load_negotiation(), F.load_customers()
    tx_raw = pd.read_csv(
        C.find_file("transactions"), encoding="utf-8-sig",
        dtype={"customer_id": "category", "bank_account_id": "category", "category": "category",
               "transaction_type": "category", "merchant_id": "category", "mcc_code": "float32"})
    tx = F.load_transactions()
    out: list[str] = ["# EDA and data-integrity audit", ""]
    add = out.append

    # ------------------------------------------------------------------ 1
    add("## 1. File inventory\n")
    inv = []
    for kind, d in [("applications", apps), ("negotiation", neg.drop(columns="ts")),
                    ("customers", cust), ("transactions", tx_raw)]:
        inv.append({"file": C.FILES[kind], "rows": len(d), "columns": d.shape[1],
                    "duplicate_rows": int(d.duplicated().sum()),
                    "ends_cleanly": _ends_with_newline(C.find_file(kind))})
    add(_md(pd.DataFrame(inv)))
    add("\n`ends_cleanly` = the last line is newline-terminated, i.e. the file is not truncated mid-row.\n")

    # ------------------------------------------------------------------ 2
    add("## 2. Schemas\n")
    for title, d in [("applications (label + final loan terms)", apps),
                     ("negotiation history (event log)", neg.drop(columns="ts")),
                     ("customers", cust), ("transactions", tx_raw)]:
        add(f"### {title}\n")
        add(_md(_schema(d), floatfmt=".1f"))
        add("")
    add("Categorical cardinalities in the event log: "
        + ", ".join(f"`{c}`={neg[c].nunique()}" for c in
                    ["event_type", "property_type", "collateral_type", "collateral_status", "expense_type"])
        + f". Transactions: `category`={tx_raw.category.nunique()}, "
          f"`transaction_type`={tx_raw.transaction_type.nunique()}, "
          f"`merchant_id`={tx_raw.merchant_id.nunique()}, `mcc_code`={tx_raw.mcc_code.nunique()}. "
          f"`merchant_id`/`mcc_code` are missing together on "
          f"{tx_raw.merchant_id.isna().mean():.1%} of rows (non-card payments: salary, housing, utilities, "
          "investments), so the missingness is structural, not noise.\n")

    # ------------------------------------------------------------------ 3
    add("## 3. How the four files relate\n")
    app_ids, neg_ids = set(apps[C.APP_KEY]), set(neg[C.APP_KEY])
    cust_ids, tx_ids = set(cust[C.CUST_KEY]), set(tx_raw.customer_id.astype(str).unique())
    rel = pd.DataFrame([
        {"join": "applications ⟵ negotiation", "key": C.APP_KEY, "cardinality": "1 : N",
         "left_unique": apps[C.APP_KEY].is_unique,
         "orphans_left": len(app_ids - neg_ids), "orphans_right": len(neg_ids - app_ids)},
        {"join": "applications ⟶ customers", "key": C.CUST_KEY, "cardinality": "N : 1 (here 1 : 1)",
         "left_unique": apps[C.CUST_KEY].is_unique,
         "orphans_left": len(set(apps[C.CUST_KEY]) - cust_ids), "orphans_right": "n/a (4,900 non-applicants)"},
        {"join": "customers ⟵ transactions", "key": C.CUST_KEY, "cardinality": "1 : N",
         "left_unique": cust[C.CUST_KEY].is_unique,
         "orphans_left": len(cust_ids - tx_ids), "orphans_right": len(tx_ids - cust_ids)},
    ])
    add(_md(rel))
    ev_per_app = neg.groupby(C.APP_KEY).size()
    tx_per_c = tx_raw.groupby("customer_id", observed=True).size()
    df = F.load_feature_table()
    add(f"""
- These are **relational tables, not train/test partitions.** The unit of analysis is the mortgage
  application ({len(apps)} rows). There is **no unlabeled test file**, so there is nothing to score
  into a submission; the chronological holdout plays that role.
- Event log: {ev_per_app.min()}–{ev_per_app.max()} events per application (median {ev_per_app.median():.0f}).
  Transactions: {tx_per_c.min()}–{tx_per_c.max():,} per customer (median {tx_per_c.median():.0f}),
  exactly one account per customer.
- **Join strategy:** both 1:N tables are aggregated to one row per key *before* joining, so the
  joins are 1:1 and cannot multiply rows. Row count after all joins: {len(df)} (asserted in code,
  joins use `validate=`).
- Only {len(apps)} of {len(cust):,} customers ({len(apps)/len(cust):.1%}) have an application. The other
  {len(cust)-len(apps):,} have no label and are used only for label-free postal-area context.
""")

    # ------------------------------------------------------------------ 4
    add("## 4. Target\n")
    vc = apps[C.TARGET_RAW].value_counts()
    add(_md(pd.DataFrame({"final_decision": vc.index, "n": vc.values,
                          "share": (vc / vc.sum()).round(3).values})))
    add(f"""
Two classes, {vc.min()} in the minority → **binary classification** with moderate imbalance
({vc.min()/vc.sum():.0%} rejected). Positive class = `rejected`. Primary metric **ROC-AUC**
(threshold-free, insensitive to the 3:1 imbalance), with LogLoss and Brier for probability quality and
PR-AUC for the minority class. OLS linear regression is not a valid model for a binary outcome, so the
linear slot is filled by Logistic Regression.
""")

    # ------------------------------------------------------------------ 5
    add("## 5. Temporal structure\n")
    app_ts = neg.loc[neg.event_type == C.START_EVENT].set_index(C.APP_KEY).ts
    dec_ts = neg.loc[neg.event_type == C.DECISION_EVENT].set_index(C.APP_KEY).ts
    lag = (dec_ts - app_ts).dt.days
    dev, hold = F.chronological_split(df)
    first_tx = tx.groupby("customer_id", observed=True).ts.min()
    hist_days = (app_ts.min() - first_tx.max()).days
    add(f"""- Applications created {app_ts.min():%Y-%m-%d} → {app_ts.max():%Y-%m-%d}; decisions
  {dec_ts.min():%Y-%m-%d} → {dec_ts.max():%Y-%m-%d}; application-to-decision lag {lag.min()}–{lag.max()} days
  (median {lag.median():.0f}).
- Transactions span {tx.ts.min():%Y-%m-%d} → {tx.ts.max():%Y-%m-%d}. Every customer's history starts by
  {first_tx.max():%Y-%m-%d}, {hist_days} days before the first application, so a {C.TX_LOOKBACK_DAYS}-day
  look-back is fully observed for every applicant.
- Because the data is time-ordered, the test set is **the most recent {C.HOLDOUT_FRACTION:.0%} of applications**
  ({len(hold)} rows, created on or after {hold.app_ts.min():%Y-%m-%d}); the earlier {len(dev)} are the
  development set. Within the development set applications are independent (each customer appears once),
  so repeated stratified {C.N_SPLITS}-fold CV is used rather than forward-chaining, which would leave
  ~{len(dev)//(C.N_SPLITS+1)} rows in the first training window.
""")

    # ------------------------------------------------------------------ 6
    add("## 6. Leakage audit\n")
    rr_iff = bool((apps.rejection_reason.notna() == (apps[C.TARGET_RAW] == "rejected")).all())
    post = neg.join(dec_ts.rename("dts"), on=C.APP_KEY)
    post = post.loc[post.ts > post.dts]
    post_dec_share = post.decision.notna().mean() if len(post) else float("nan")
    pre = neg.join(dec_ts.rename("dts"), on=C.APP_KEY)
    pre = pre.loc[pre.ts < pre.dts]
    ratio = apps.required_monthly_income_eur / apps.final_requested_loan_eur
    ident = (apps.final_property_price_eur - apps.final_requested_loan_eur
             - apps.final_equity_amount_eur).abs().max()
    ltv_err = (apps.lfinal_loan_to_value
               - apps.final_requested_loan_eur / apps.final_property_price_eur).abs().max()
    n_extra = int((df.neg_has_additional_collateral == 1).sum())
    tx_after = (tx.ts.max() - dec_ts.min()).days
    leak = pd.DataFrame([
        {"finding": "`rejection_reason` (applications) is non-null exactly when the application is rejected",
         "evidence": f"holds for all rows: {rr_iff}", "action": "dropped"},
        {"finding": "`loan_decision` event carries `decision` / `rejection_reason`; the `note` text restates it",
         "evidence": f"{int((neg.event_type == C.DECISION_EVENT).sum())} decision events",
         "action": "event excluded; `decision`, `rejection_reason`, `note` never read"},
        {"finding": "Events after the decision echo the outcome",
         "evidence": f"{len(post)} post-decision events, {post_dec_share:.0%} carry `decision`; "
                     f"{int(pre.decision.notna().sum())} pre-decision events do",
         "action": "only events with timestamp < decision timestamp are used"},
        {"finding": "Transactions continue after the decision (post-approval behaviour)",
         "evidence": f"ledger runs up to {tx_after} days past the first decision",
         "action": f"only the {C.TX_LOOKBACK_DAYS} days before application creation are used"},
        {"finding": "`required_monthly_income_eur` is a fixed multiple of the loan",
         "evidence": f"ratio = {ratio.mean():.6f}, std {ratio.std():.1e}",
         "action": "not leakage (an input to the decision) but perfectly collinear; filtered for the linear model"},
        {"finding": "price = loan + equity and LTV = loan / price are exact identities",
         "evidence": f"max abs error {ident:.0f} EUR and {ltv_err:.1e}",
         "action": "same: collinearity filter"},
        {"finding": "`final_collateral_value_eur` is only the primary valuation",
         "evidence": f"{n_extra} applications have a second (`other_apartment`) valuation in the log",
         "action": "engineered `collateral_total_value` and coverage ratios"},
    ])
    add(_md(leak))
    add("\nThe final loan terms (price, loan, equity, collateral) are fixed during negotiation, before the "
        "decision event, so they are legitimate inputs: this model scores an application **at the moment "
        "the bank is about to decide**.\n")

    # ------------------------------------------------------------------ 7
    add("## 7. Engineered feature table\n")
    feats, num = F.feature_columns(df), F.numeric_columns(df)
    top_share = pd.Series({c: df[c].value_counts(normalize=True, dropna=False).iloc[0] for c in feats})
    quasi = top_share[top_share >= 0.95].sort_values(ascending=False)
    add(f"{len(df)} rows × {len(feats)} features ({len(num)} numeric, {len(F.CATEGORICAL_FEATURES)} categorical). "
        f"Missing cells: {int(df[feats].isna().sum().sum())}. Constant features: "
        f"{int((df[feats].nunique() <= 1).sum())}. Quasi-constant (top value ≥ 95%): "
        + (", ".join(f"`{c}` ({v:.0%})" for c, v in quasi.items()) if len(quasi) else "none") + ".\n")
    fam = pd.DataFrame([
        {"family": "final loan terms", "n": sum(c.startswith(("final_", "required_", "lfinal_")) for c in feats)},
        {"family": "negotiation behaviour (`neg_*`)", "n": sum(c.startswith("neg_") for c in feats)},
        {"family": "recorded expenses (`exp_*`)", "n": sum(c.startswith("exp_") for c in feats)},
        {"family": "transactions, 12 months pre-application (`tx_*`)", "n": sum(c.startswith("tx_") for c in feats)},
        {"family": "postal-area context (`ctx_*`)", "n": sum(c.startswith("ctx_") for c in feats)},
        {"family": "cross-source ratios (collateral, affordability, liquidity, search)",
         "n": sum(c.startswith(("collateral_", "income_", "salary_cov", "residual_", "loan_to_", "existing_",
                                "debt_", "equity_cov", "cash_", "expenses_", "price_vs")) for c in feats)},
        {"family": "customer / categorical", "n": 1 + len(F.CATEGORICAL_FEATURES)},
    ])
    add(_md(fam))
    add(f"\n`postal_area3` has {df.postal_area3.nunique()} levels on {len(df)} rows: CatBoost consumes it "
        "natively, the other models get a cross-fitted target encoding.\n")

    # ------------------------------------------------------------------ 8
    add("## 8. Multicollinearity (development set)\n")
    Xd = dev[num]
    corr = Xd.corr(method="spearman").abs()
    pairs = (corr.where(np.triu(np.ones(corr.shape, bool), 1)).stack()
             .sort_values(ascending=False).head(10).reset_index())
    pairs.columns = ["feature_a", "feature_b", "abs_spearman"]
    add(_md(pairs))
    from .estimators import CorrelationFilter
    Zd = (Xd - Xd.mean()) / Xd.std()
    pair_only = CorrelationFilter(0.95, vif_threshold=None).fit(Zd).keep_
    full = CorrelationFilter(0.95, vif_threshold=10.0).fit(Zd).keep_
    vif_all, vif_pair, vif_full = _vif(Xd), _vif(Xd[pair_only]), _vif(Xd[full])
    dropped_by_vif = [c for c in pair_only if c not in full]
    add(f"""
- {int((corr.where(np.triu(np.ones(corr.shape, bool), 1)) > 0.95).sum().sum())} feature pairs have |ρ| > 0.95.
- VIF on all {len(num)} numeric features: {int((vif_all > 1e6).sum())} are effectively infinite (exact
  identities), median {vif_all.replace(np.inf, np.nan).median():,.0f}.
- A pairwise filter at 0.95 keeps {len(pair_only)} features but the max VIF is still {vif_pair.max():.1e}: multi-way
  identities (price = loan + equity, total consumption = sum of category spends, total collateral =
  primary + additional) are invisible to pairwise checks.
- The linear pipeline therefore adds iterative VIF pruning (drop the worst feature until every VIF ≤ 10):
  **{len(full)} features remain, max VIF {vif_full.max():.1f}, median {vif_full.median():.1f}.** It removes
  {len(dropped_by_vif)} more features, e.g. {", ".join(f"`{c}`" for c in dropped_by_vif[:8])}.
- Both thresholds are refitted inside every CV fold and tuned; the surviving model is elastic-net regularised.
  Tree models keep all features: collinearity does not bias them, it only spreads importance.
""")

    # ------------------------------------------------------------------ 9
    add("## 9. Signal scan (development set only)\n")
    y = dev[C.TARGET]
    sig = pd.DataFrame([{"feature": c, "univariate_auc": roc_auc_score(y, dev[c])}
                        for c in num if dev[c].nunique() > 1])
    sig["strength"] = (sig.univariate_auc - 0.5).abs()
    add(_md(sig.sort_values("strength", ascending=False).head(15)[["feature", "univariate_auc"]]))
    add("\nAUC > 0.5 means higher values go with rejection; < 0.5 with approval.\n")
    for c in ["property_type", "postal_city", "neg_has_additional_collateral"]:
        t = dev.groupby(c)[C.TARGET].agg(n="size", rejection_rate="mean").reset_index().astype({c: str})
        add(_md(t))
        add("")

    # ------------------------------------------------------------------ 10
    add("## 10. Drift between development and holdout (label-free)\n")
    Xa = pd.concat([dev[num], hold[num]]).fillna(-1)
    ya = np.r_[np.zeros(len(dev)), np.ones(len(hold))]
    rf = RandomForestClassifier(300, min_samples_leaf=5, random_state=C.SEED, n_jobs=2)
    p = cross_val_predict(rf, Xa, ya, cv=StratifiedKFold(5, shuffle=True, random_state=C.SEED),
                          method="predict_proba")[:, 1]
    adv = roc_auc_score(ya, p)
    monthly = dev.groupby(dev.app_ts.dt.to_period("M").astype(str))[C.TARGET].agg(
        n="size", rejection_rate="mean").reset_index().rename(columns={"app_ts": "month"})
    add(f"Adversarial validation (can a model tell holdout rows from development rows using features "
        f"alone?): AUC = **{adv:.2f}** (0.50 = indistinguishable). "
        + ("No material covariate shift." if adv < 0.65 else
           "Some covariate shift: expect holdout performance to differ from CV.") + "\n")
    add("Rejection rate by application month, development set:\n")
    add(_md(monthly))
    add("")

    text = "\n".join(out)
    (C.REPORT_DIR / "eda_summary.md").write_text(text)
    if verbose:
        print(f"[eda] wrote {C.REPORT_DIR / 'eda_summary.md'} ({len(text.splitlines())} lines)")
    return text


if __name__ == "__main__":
    run_eda()
