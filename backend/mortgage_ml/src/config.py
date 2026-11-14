"""Central configuration: paths, schema, split and CV settings.

Everything that a reviewer might want to change lives here so the other
modules stay free of magic numbers.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("MTG_DATA_DIR", ROOT / "data" / "raw"))
ARTIFACT_DIR = ROOT / "artifacts"
MODEL_DIR = ROOT / "models"
REPORT_DIR = ROOT / "reports"

# Files are matched by suffix so hash-prefixed uploads resolve too.
FILES = {
    "applications": "mtg_tx_customer_link_and_final_mtg_infio.csv",
    "negotiation": "mtg_negotiation_history.csv",
    "customers": "tx_customers_junction.csv",
    "transactions": "tx_junction_transactions.csv",
}

SEED = 42

# --- target -----------------------------------------------------------------
TARGET_RAW = "final_decision"
TARGET = "rejected"  # 1 = rejected (minority / event class), 0 = approved
POSITIVE_LABEL = "rejected"
PRIMARY_METRIC = "roc_auc"

# --- keys -------------------------------------------------------------------
APP_KEY = "mortgage_customer_id"
CUST_KEY = "customer_id"

# --- leakage controls -------------------------------------------------------
# Columns that are the outcome itself or are written after the decision.
LEAKY_APPLICATION_COLS = ["rejection_reason"]
LEAKY_EVENT_COLS = ["decision", "rejection_reason", "note"]
DECISION_EVENT = "loan_decision"
START_EVENT = "application_created"
# Transaction features use a fixed look-back that ends at application start.
TX_LOOKBACK_DAYS = 365
# Postal-area context uses only non-applicants and only data before this date
# (the first application in the data is created on 2026-01-02).
CONTEXT_CUTOFF = "2026-01-01"

# --- split / CV -------------------------------------------------------------
HOLDOUT_FRACTION = 0.20  # most recent applications, by application date
N_SPLITS = 5
N_REPEATS = 5            # repeated stratified K-fold on the development set
N_TRIALS = {"logreg": 60, "random_forest": 40, "xgboost": 60, "catboost": 30}
TUNE_REPEATS = 2         # repeats used inside the Optuna objective
EARLY_STOPPING_ROUNDS = 50

MODEL_ORDER = ["logreg", "random_forest", "xgboost", "catboost"]
MODEL_LABELS = {
    "logreg": "Logistic Regression (linear)",
    "random_forest": "Random Forest",
    "xgboost": "XGBoost",
    "catboost": "CatBoost",
}


def find_file(kind: str) -> Path:
    """Resolve a raw file by suffix inside DATA_DIR."""
    suffix = FILES[kind]
    matches = sorted(p for p in DATA_DIR.iterdir() if p.name.endswith(suffix))
    if not matches:
        raise FileNotFoundError(
            f"No file ending in '{suffix}' in {DATA_DIR}. "
            "Put the four CSVs there or set MTG_DATA_DIR."
        )
    return matches[0]


def ensure_dirs() -> None:
    for d in (ARTIFACT_DIR, MODEL_DIR, REPORT_DIR):
        d.mkdir(parents=True, exist_ok=True)
