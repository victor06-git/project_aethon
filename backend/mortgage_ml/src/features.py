"""Data loading, merging, time-aware feature engineering and the train/holdout split.

Design rules that keep this module leakage-free
------------------------------------------------
1. Every feature for an application is computed from that application's own
   history only, and only from information available *before* the decision:
     * negotiation events strictly earlier than the `loan_decision` event;
     * bank transactions in a fixed look-back window that ends when the
       application was created.
2. Nothing in here is *fitted* on labelled rows. Imputation, scaling, encoding
   and target encoding live inside the model pipelines (src/train.py) and are
   re-fitted inside every CV fold.
3. The only cross-row statistic is the postal-area context, which is computed
   from customers who never applied for a mortgage, using transactions dated
   before the first application in the data. It cannot see any label.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C

TS_FORMAT = "%d%b%y:%H:%M:%S"  # e.g. 26MAY26:00:00:00

SPEND_CATEGORIES = {
    "Groceries": "groceries",
    "Restaurants": "restaurants",
    "Transportation": "transportation",
    "Utilities": "utilities",
    "Entertainment": "entertainment",
    "Health": "health",
    "Home & Tech": "home_tech",
    "Housing": "housing",
    "Lifestyle": "lifestyle",
    "Travel": "travel",
}
DISCRETIONARY = ["restaurants", "entertainment", "lifestyle", "travel"]
EXPENSE_TYPES = [
    "existing_loan", "renovation", "transfer_tax",
    "maintenance_fee", "valuation_fee", "bank_fee",
]

CATEGORICAL_FEATURES = ["property_type", "postal_city", "postal_area3"]
# Never used as model inputs.
META_COLS = [C.APP_KEY, C.CUST_KEY, "app_ts", "decision_ts", C.TARGET_RAW, C.TARGET]


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #
def load_applications() -> pd.DataFrame:
    df = pd.read_csv(C.find_file("applications"), encoding="utf-8-sig")
    df.columns = [c.strip() for c in df.columns]
    return df


def load_negotiation() -> pd.DataFrame:
    df = pd.read_csv(C.find_file("negotiation"), encoding="utf-8-sig")
    df["ts"] = pd.to_datetime(df["timestamp"], format=TS_FORMAT)
    # Stable sort keeps file order for equal timestamps.
    return df.sort_values([C.APP_KEY, "ts"], kind="stable").reset_index(drop=True)


def load_customers() -> pd.DataFrame:
    return pd.read_csv(
        C.find_file("customers"), encoding="utf-8-sig",
        dtype={"customer_postal_code": "string"},
    )


def load_transactions(use_cache: bool = True) -> pd.DataFrame:
    """Load the 3.6M-row ledger with compact dtypes; cached as parquet."""
    cache = C.ARTIFACT_DIR / "transactions.parquet"
    src = C.find_file("transactions")
    if use_cache and cache.exists() and cache.stat().st_mtime >= src.stat().st_mtime:
        return pd.read_parquet(cache)
    df = pd.read_csv(
        src, encoding="utf-8-sig",
        usecols=["customer_id", "tx_timestamp", "category", "tx_amount_eur",
                 "balance_after_eur", "merchant_id"],
        dtype={"customer_id": "category", "category": "category",
               "merchant_id": "category", "tx_amount_eur": "float64",
               "balance_after_eur": "float64"},
    )
    df["ts"] = pd.to_datetime(df.pop("tx_timestamp"), format=TS_FORMAT)
    C.ensure_dirs()
    df.to_parquet(cache, index=False)
    return df


# --------------------------------------------------------------------------- #
# Negotiation log -> one row per application
# --------------------------------------------------------------------------- #
def build_negotiation_features(neg: pd.DataFrame) -> pd.DataFrame:
    """Aggregate the event log using only events strictly before the decision."""
    decision_ts = (neg.loc[neg.event_type == C.DECISION_EVENT]
                   .groupby(C.APP_KEY)["ts"].min().rename("decision_ts"))
    app_ts = (neg.loc[neg.event_type == C.START_EVENT]
              .groupby(C.APP_KEY)["ts"].min().rename("app_ts"))

    ev = neg.join(decision_ts, on=C.APP_KEY)
    ev = ev.loc[ev.ts < ev.decision_ts].drop(columns=C.LEAKY_EVENT_COLS)

    rows = []
    for app_id, g in ev.groupby(C.APP_KEY, sort=False):
        et = g.event_type
        r = {C.APP_KEY: app_id}
        t0 = g.ts.iloc[0]

        r["neg_n_events"] = len(g)
        r["neg_days_active"] = (g.ts.iloc[-1] - t0).total_seconds() / 86400
        r["neg_n_contacts"] = int((et == "customer_contact").sum())
        r["neg_n_documents"] = int((et == "document_received").sum())

        # --- properties considered and price path -------------------------
        added = g.loc[et == "property_added"]
        calc = g.loc[et == "loan_calculation"].iloc[-1]
        final_pid = calc.property_id
        prices = g.loc[g.event_type.isin(["property_added", "property_price_updated"])]
        final_prices = prices.loc[prices.property_id == final_pid, "property_price_estimate"]
        r["property_type"] = calc.property_type
        r["neg_n_properties"] = len(added)
        r["neg_n_price_updates"] = int((et == "property_price_updated").sum())
        r["neg_first_property_price"] = added.property_price_estimate.iloc[0]
        r["neg_max_property_price"] = prices.property_price_estimate.max()
        r["neg_final_price_revision_pct"] = (
            final_prices.iloc[-1] / final_prices.iloc[0] - 1 if len(final_prices) else np.nan)
        r["neg_days_to_loan_calc"] = (calc.ts - t0).total_seconds() / 86400

        # --- collateral: primary + any additional pledged property --------
        val = g.loc[et == "collateral_valuation"]
        extra = val.loc[val.collateral_type != "apartment", "collateral_value"]
        r["neg_n_valuations"] = len(val)
        r["neg_additional_collateral_requested"] = int(
            (et == "additional_collateral_requested").any())
        r["neg_additional_collateral_value"] = float(extra.sum())
        r["neg_has_additional_collateral"] = int(len(extra) > 0)

        # --- recorded expenses --------------------------------------------
        exp = g.loc[et == "expense_recorded"]
        by_type = exp.groupby("expense_type")["expense_amount"].sum()
        r["neg_n_expenses"] = len(exp)
        for t in EXPENSE_TYPES:
            r[f"exp_{t}"] = float(by_type.get(t, 0.0))
        r["exp_total"] = float(exp.expense_amount.sum())
        rows.append(r)

    out = pd.DataFrame(rows).set_index(C.APP_KEY)
    return out.join(app_ts).join(decision_ts).reset_index()


# --------------------------------------------------------------------------- #
# Transactions -> one row per applicant (window ends at application start)
# --------------------------------------------------------------------------- #
def build_transaction_features(tx: pd.DataFrame, cutoffs: pd.Series) -> pd.DataFrame:
    """`cutoffs` maps customer_id -> application-created timestamp."""
    months = C.TX_LOOKBACK_DAYS / 365 * 12
    t = tx.loc[tx.customer_id.isin(cutoffs.index)].copy()
    t["customer_id"] = t.customer_id.astype(str)
    t["cutoff"] = t.customer_id.map(cutoffs)
    start = t.cutoff - pd.Timedelta(days=C.TX_LOOKBACK_DAYS)
    t = t.loc[(t.ts >= start) & (t.ts < t.cutoff)].sort_values(["customer_id", "ts"])
    t["category"] = t.category.astype(str)

    by_cat = (t.pivot_table(index="customer_id", columns="category",
                            values="tx_amount_eur", aggfunc="sum", fill_value=0.0)
              .reindex(columns=list(SPEND_CATEGORIES) + [
                  "Salary", "Other Income", "Invest Deposit",
                  "Invest Withdraw", "Salary Sweep"], fill_value=0.0))

    f = pd.DataFrame(index=by_cat.index)
    for raw, name in SPEND_CATEGORIES.items():
        f[f"tx_spend_{name}_m"] = -by_cat[raw] / months
    f["tx_salary_m"] = by_cat["Salary"] / months
    f["tx_other_income_m"] = by_cat["Other Income"] / months
    f["tx_invest_deposit_m"] = -by_cat["Invest Deposit"] / months
    f["tx_invest_withdraw_m"] = by_cat["Invest Withdraw"] / months
    f["tx_salary_sweep_m"] = -by_cat["Salary Sweep"] / months

    sal = t.loc[t.category == "Salary"].groupby("customer_id")["tx_amount_eur"]
    f["tx_salary_median"] = sal.median()
    f["tx_salary_cv"] = sal.std() / sal.mean()
    f["tx_salary_n"] = sal.size()
    recent = t.ts >= (t.cutoff - pd.Timedelta(days=90))
    sal_recent = t.loc[recent & (t.category == "Salary")].groupby("customer_id")["tx_amount_eur"].sum() / 3
    sal_prior = (t.loc[~recent & (t.category == "Salary")].groupby("customer_id")["tx_amount_eur"].sum()
                 / (months - 3))
    f["tx_salary_trend"] = sal_recent / sal_prior

    bal = t.groupby("customer_id")["balance_after_eur"]
    f["tx_balance_last"] = bal.last()
    f["tx_balance_mean"] = bal.mean()
    f["tx_balance_min"] = bal.min()
    f["tx_balance_std"] = bal.std()
    f["tx_balance_growth"] = bal.last() - bal.first()
    f["tx_negative_balance_share"] = (
        t.assign(neg=t.balance_after_eur < 0).groupby("customer_id")["neg"].mean())
    f["tx_n_m"] = t.groupby("customer_id").size() / months
    f["tx_n_merchants"] = t.groupby("customer_id")["merchant_id"].nunique()

    # --- behavioural ratios ------------------------------------------------
    spend_cols = [f"tx_spend_{n}_m" for n in SPEND_CATEGORIES.values()]
    f["tx_income_m"] = f.tx_salary_m + f.tx_other_income_m
    f["tx_consumption_m"] = f[spend_cols].sum(axis=1)
    f["tx_living_cost_ex_housing_m"] = f.tx_consumption_m - f.tx_spend_housing_m
    f["tx_savings_rate"] = 1 - f.tx_consumption_m / f.tx_income_m
    f["tx_housing_to_income"] = f.tx_spend_housing_m / f.tx_income_m
    f["tx_discretionary_share"] = (
        f[[f"tx_spend_{n}_m" for n in DISCRETIONARY]].sum(axis=1) / f.tx_consumption_m)
    return f.replace([np.inf, -np.inf], np.nan).reset_index()


def build_postal_context(tx: pd.DataFrame, customers: pd.DataFrame,
                         applicant_ids: set[str]) -> pd.DataFrame:
    """Neighbourhood affluence from non-applicants, before any application."""
    cutoff = pd.Timestamp(C.CONTEXT_CUTOFF)
    t = tx.loc[(tx.ts < cutoff) & ~tx.customer_id.isin(applicant_ids)]
    months = (cutoff - t.ts.min()).days / 30.44
    per_cust = pd.DataFrame({
        "salary_m": t.loc[t.category == "Salary"].groupby("customer_id", observed=True)["tx_amount_eur"].sum() / months,
        "balance": t.groupby("customer_id", observed=True)["balance_after_eur"].mean(),
    }).reset_index()
    per_cust["customer_id"] = per_cust.customer_id.astype(str)
    per_cust = per_cust.merge(customers, on=C.CUST_KEY, how="left")
    per_cust["postal_area3"] = per_cust.customer_postal_code.str[:3]
    ctx = per_cust.groupby("postal_area3").agg(
        ctx_postal_salary_median=("salary_m", "median"),
        ctx_postal_balance_median=("balance", "median"),
        ctx_postal_n=("customer_id", "size"),
    )
    # Areas with very few reference customers are too noisy to trust.
    ctx.loc[ctx.ctx_postal_n < 5, ["ctx_postal_salary_median", "ctx_postal_balance_median"]] = np.nan
    return ctx.drop(columns="ctx_postal_n").reset_index()


# --------------------------------------------------------------------------- #
# Cross-source domain features
# --------------------------------------------------------------------------- #
def add_domain_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    loan = d.final_requested_loan_eur
    price = d.final_property_price_eur
    req = d.required_monthly_income_eur

    # Collateral: the link file only carries the primary valuation.
    d["collateral_total_value"] = d.final_collateral_value_eur + d.neg_additional_collateral_value
    d["collateral_coverage_primary"] = d.final_collateral_value_eur / loan
    d["collateral_coverage_total"] = d.collateral_total_value / loan
    d["collateral_shortfall_eur"] = (loan - d.collateral_total_value).clip(lower=0)
    d["collateral_to_price"] = d.final_collateral_value_eur / price

    # Affordability: observed income vs. the income the loan requires.
    d["income_coverage"] = d.tx_income_m / req
    d["salary_coverage"] = d.tx_salary_median / req
    d["residual_income_coverage"] = (d.tx_income_m - d.tx_living_cost_ex_housing_m) / req
    d["loan_to_annual_income"] = loan / (12 * d.tx_income_m)
    d["existing_loan_to_income"] = d.exp_existing_loan / d.tx_income_m
    d["debt_adjusted_income_coverage"] = (d.tx_income_m - d.exp_existing_loan) / req

    # Liquidity: can the account fund the down payment and closing costs?
    d["equity_coverage"] = d.tx_balance_last / d.final_equity_amount_eur
    d["cash_need_coverage"] = d.tx_balance_last / (d.final_equity_amount_eur + d.exp_total)
    d["expenses_to_price"] = d.exp_total / price

    # Search behaviour: how far the final choice sits below what was considered.
    d["price_vs_first_property"] = price / d.neg_first_property_price
    d["price_vs_max_considered"] = price / d.neg_max_property_price
    d["price_vs_postal_salary"] = price / (12 * d.ctx_postal_salary_median)
    return d.replace([np.inf, -np.inf], np.nan)


# --------------------------------------------------------------------------- #
# Assemble
# --------------------------------------------------------------------------- #
def build_feature_table(save: bool = True, verbose: bool = True) -> pd.DataFrame:
    apps = load_applications()
    neg = load_negotiation()
    cust = load_customers()
    tx = load_transactions()

    n0 = len(apps)
    assert apps[C.APP_KEY].is_unique and apps[C.CUST_KEY].is_unique
    assert cust[C.CUST_KEY].is_unique

    df = apps.drop(columns=C.LEAKY_APPLICATION_COLS)
    df[C.TARGET] = (df[C.TARGET_RAW] == C.POSITIVE_LABEL).astype(int)

    df = df.merge(build_negotiation_features(neg), on=C.APP_KEY, how="left", validate="1:1")
    df = df.merge(cust, on=C.CUST_KEY, how="left", validate="1:1")
    df["postal_city"] = df.customer_postal_code.str[:2]
    df["postal_area3"] = df.customer_postal_code.str[:3]

    cutoffs = df.set_index(C.CUST_KEY)["app_ts"]
    df = df.merge(build_transaction_features(tx, cutoffs), on=C.CUST_KEY, how="left", validate="1:1")
    df = df.merge(build_postal_context(tx, cust, set(df[C.CUST_KEY])),
                  on="postal_area3", how="left", validate="m:1")
    df = add_domain_features(df).drop(columns=["customer_postal_code"])

    assert len(df) == n0, "row explosion in joins"
    for c in CATEGORICAL_FEATURES:
        df[c] = df[c].astype("string").fillna("missing").astype(str)
    df = df.sort_values(["app_ts", C.APP_KEY]).reset_index(drop=True)

    if save:
        C.ensure_dirs()
        df.to_parquet(C.ARTIFACT_DIR / "features.parquet", index=False)
    if verbose:
        print(f"[features] {df.shape[0]} applications x {len(feature_columns(df))} features "
              f"({df[C.TARGET].mean():.1%} rejected)")
    return df


def feature_columns(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns if c not in META_COLS]


def numeric_columns(df: pd.DataFrame) -> list[str]:
    return [c for c in feature_columns(df) if c not in CATEGORICAL_FEATURES]


def chronological_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Most recent applications (by creation time) form the locked holdout."""
    d = df.sort_values(["app_ts", C.APP_KEY]).reset_index(drop=True)
    n_hold = int(round(len(d) * C.HOLDOUT_FRACTION))
    dev, hold = d.iloc[:-n_hold].copy(), d.iloc[-n_hold:].copy()
    assert dev.app_ts.max() <= hold.app_ts.min()
    return dev.reset_index(drop=True), hold.reset_index(drop=True)


def load_feature_table() -> pd.DataFrame:
    path = C.ARTIFACT_DIR / "features.parquet"
    return pd.read_parquet(path) if path.exists() else build_feature_table()


if __name__ == "__main__":
    build_feature_table()
