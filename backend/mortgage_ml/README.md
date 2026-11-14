# Mortgage decision model

Predicts whether a mortgage application will be **rejected** (`final_decision`), comparing four model
families on identical cross-validation folds: Logistic Regression, Random Forest, XGBoost and CatBoost.

Results live in `reports/model_report.md`; the data audit is in `reports/eda_summary.md`.

## Run

```bash
pip install -r requirements.txt
# put the four CSVs in data/raw/ (or point MTG_DATA_DIR at them; hash-prefixed names are fine)
python main.py            # full run, roughly 30-40 min on 2 cores
python main.py --fast     # 4 Optuna trials per model, about 5 min, for a smoke test
python main.py --stages evaluate   # re-create reports from saved artifacts
```

## Layout

| Path | Purpose |
|---|---|
| `main.py` | Single entry point: features → EDA → train → evaluate |
| `src/config.py` | Paths, target, leakage rules, split and CV settings, trial budgets |
| `src/features.py` | Loading, joins, time-cut feature engineering, chronological split |
| `src/eda.py` | Integrity, join, leakage, collinearity and drift audit → `reports/eda_summary.md` |
| `src/estimators.py` | `CorrelationFilter` (pairwise + VIF pruning) and `EarlyStoppedBooster` |
| `src/train.py` | Model-specific pipelines, Optuna tuning, shared-fold CV, ensemble, serialization |
| `src/evaluate.py` | Leaderboard, significance test, SHAP / permutation importance, error diagnostics |
| `models/` | `<model>.joblib` (fitted on the development set, the one that was evaluated) and `<model>_full.joblib` (same recipe refitted on all 200 rows, for scoring new applications) |
| `artifacts/` | Feature table, per-fold scores, out-of-fold and holdout predictions, tuning metadata |
| `predictions.csv` | Holdout predictions from the selected model and the ensemble, with actual outcomes |

## The data

| File | Grain | Role |
|---|---|---|
| `mtg_tx_customer_link_and_final_mtg_infio.csv` | 1 row per application (200) | label + final loan terms + link to `customer_id` |
| `mtg_negotiation_history.csv` | 1 row per event (3,452) | negotiation log, aggregated per application |
| `tx_customers_junction.csv` | 1 row per customer (5,100) | age, postal code |
| `tx_junction_transactions.csv` | 1 row per transaction (3.63M) | account ledger, aggregated per customer |

Both 1:N tables are aggregated to one row per key before joining, so every join is 1:1.

## Design decisions

- **Target and problem type.** `final_decision` is binary (25% rejected), so this is classification.
  OLS linear regression is not valid for a binary outcome; the linear slot is Logistic Regression with a
  tuned elastic-net penalty. Primary metric ROC-AUC; LogLoss, Brier and PR-AUC are reported alongside.
- **Prediction moment.** The model scores an application just before the bank decides. Features use only
  negotiation events earlier than the decision event and transactions from the 365 days before the
  application was created.
- **Leakage removed.** `rejection_reason`, the decision event, the free-text `note`, and all post-decision
  events (which repeat the outcome). Details and evidence in the EDA report, section 6.
- **Split.** The most recent 20% of applications by creation date are a locked holdout. Tuning and model
  selection use only the earlier 80%, with 5×5 repeated stratified folds shared by all models.
  Hyperparameters are tuned on a different set of folds from the ones used for reporting.
- **Preprocessing is inside the pipelines**, so imputation, scaling, the collinearity filter and target
  encoding are refitted on the training part of each fold.
- **Early stopping** for XGBoost and CatBoost uses an inner split of the training fold, never the
  validation fold, then refits on the full training fold with the chosen number of trees.
- **CatBoost** receives the raw string categoricals through `cat_features`; nothing is one-hot encoded.

## Limits

- 200 labelled applications. Confidence intervals are wide and differences between the tree models are
  not statistically established; the report says which comparisons are and are not.
- There is no unlabeled test file among the four CSVs, so `predictions.csv` holds holdout predictions.
- Only 4% of customers have an application, and nothing here models who applies.
