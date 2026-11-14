# EDA and data-integrity audit

## 1. File inventory

| file                                         |    rows |   columns |   duplicate_rows | ends_cleanly   |
|:---------------------------------------------|--------:|----------:|-----------------:|:---------------|
| mtg_tx_customer_link_and_final_mtg_infio.csv |     200 |        10 |                0 | True           |
| mtg_negotiation_history.csv                  |    3452 |        16 |                0 | True           |
| tx_customers_junction.csv                    |    5100 |         3 |                0 | True           |
| tx_junction_transactions.csv                 | 3626755 |        10 |                0 | True           |

`ends_cleanly` = the last line is newline-terminated, i.e. the file is not truncated mid-row.

## 2. Schemas

### applications (label + final loan terms)

| column                      | dtype   |   missing_% |   n_unique | example                 |
|:----------------------------|:--------|------------:|-----------:|:------------------------|
| mortgage_customer_id        | str     |         0.0 |        200 | C0004                   |
| customer_id                 | str     |         0.0 |        200 | CUST04457               |
| final_decision              | str     |         0.0 |          2 | approved                |
| rejection_reason            | str     |        75.0 |          4 | insufficient_collateral |
| final_property_price_eur    | int64   |         0.0 |        164 | 203000                  |
| final_requested_loan_eur    | int64   |         0.0 |        159 | 170500                  |
| final_equity_amount_eur     | int64   |         0.0 |        103 | 32500                   |
| final_collateral_value_eur  | int64   |         0.0 |        157 | 132500                  |
| required_monthly_income_eur | float64 |         0.0 |        159 | 3138.668255808          |
| lfinal_loan_to_value        | float64 |         0.0 |        199 | 0.83990147783251        |

### negotiation history (event log)

| column                  | dtype   |   missing_% |   n_unique | example                                  |
|:------------------------|:--------|------------:|-----------:|:-----------------------------------------|
| mortgage_customer_id    | str     |         0.0 |        200 | C0004                                    |
| timestamp               | str     |         0.0 |       3378 | 26MAY26:00:00:00                         |
| event_type              | str     |         0.0 |         12 | application_created                      |
| property_id             | str     |        14.9 |        316 | P0004_01                                 |
| property_type           | str     |        68.0 |          3 | terraced_house                           |
| property_price_estimate | float64 |        14.9 |        364 | 387500.0                                 |
| loan_amount             | float64 |        75.3 |        159 | 170500.0                                 |
| equity_amount           | float64 |        75.3 |        103 | 32500.0                                  |
| collateral_type         | str     |        73.8 |          2 | apartment                                |
| collateral_value        | float64 |        85.1 |        223 | 132500.0                                 |
| collateral_status       | str     |        73.8 |          2 | pending                                  |
| decision                | str     |        90.3 |          2 | approved                                 |
| rejection_reason        | str     |        98.6 |          4 | insufficient_collateral                  |
| expense_type            | str     |        85.7 |          6 | transfer_tax                             |
| expense_amount          | float64 |        85.7 |         42 | 6500.0                                   |
| note                    | str     |         0.0 |        907 | The customer started a mortgage applicat |

### customers

| column               | dtype   |   missing_% |   n_unique | example   |
|:---------------------|:--------|------------:|-----------:|:----------|
| customer_id          | str     |         0.0 |       5100 | CUST00001 |
| customer_postal_code | string  |         0.0 |        290 | 00990     |
| customer_age         | int64   |         0.0 |         73 | 63        |

### transactions

| column            | dtype    |   missing_% |   n_unique | example           |
|:------------------|:---------|------------:|-----------:|:------------------|
| customer_id       | category |         0.0 |       5100 | CUST00001         |
| bank_account_id   | category |         0.0 |       5100 | ACC000001         |
| tx_date           | str      |         0.0 |        730 | 2024-10-03        |
| tx_timestamp      | str      |         0.0 |    3442882 | 03OCT24:09:04:04  |
| category          | category |         0.0 |         15 | Utilities         |
| tx_amount_eur     | float64  |         0.0 |     253291 | -27.32            |
| balance_after_eur | float64  |         0.0 |    1462984 | 3113.21           |
| transaction_type  | category |         0.0 |          8 | utilities_payment |
| merchant_id       | category |        21.7 |        515 | MRC-GRO-0035      |
| mcc_code          | float32  |        21.7 |         36 | 5411.0            |

Categorical cardinalities in the event log: `event_type`=12, `property_type`=3, `collateral_type`=2, `collateral_status`=2, `expense_type`=6. Transactions: `category`=15, `transaction_type`=8, `merchant_id`=515, `mcc_code`=36. `merchant_id`/`mcc_code` are missing together on 21.7% of rows (non-card payments: salary, housing, utilities, investments), so the missingness is structural, not noise.

## 3. How the four files relate

| join                       | key                  | cardinality        | left_unique   |   orphans_left | orphans_right              |
|:---------------------------|:---------------------|:-------------------|:--------------|---------------:|:---------------------------|
| applications ⟵ negotiation | mortgage_customer_id | 1 : N              | True          |              0 | 0                          |
| applications ⟶ customers   | customer_id          | N : 1 (here 1 : 1) | True          |              0 | n/a (4,900 non-applicants) |
| customers ⟵ transactions   | customer_id          | 1 : N              | True          |              0 | 0                          |

- These are **relational tables, not train/test partitions.** The unit of analysis is the mortgage
  application (200 rows). There is **no unlabeled test file**, so there is nothing to score
  into a submission; the chronological holdout plays that role.
- Event log: 11–25 events per application (median 17).
  Transactions: 148–1,543 per customer (median 700),
  exactly one account per customer.
- **Join strategy:** both 1:N tables are aggregated to one row per key *before* joining, so the
  joins are 1:1 and cannot multiply rows. Row count after all joins: 200 (asserted in code,
  joins use `validate=`).
- Only 200 of 5,100 customers (3.9%) have an application. The other
  4,900 have no label and are used only for label-free postal-area context.

## 4. Target

| final_decision   |   n |   share |
|:-----------------|----:|--------:|
| approved         | 150 |   0.750 |
| rejected         |  50 |   0.250 |

Two classes, 50 in the minority → **binary classification** with moderate imbalance
(25% rejected). Positive class = `rejected`. Primary metric **ROC-AUC**
(threshold-free, insensitive to the 3:1 imbalance), with LogLoss and Brier for probability quality and
PR-AUC for the minority class. OLS linear regression is not a valid model for a binary outcome, so the
linear slot is filled by Logistic Regression.

## 5. Temporal structure

- Applications created 2026-01-02 → 2026-08-07; decisions
  2026-01-20 → 2026-09-08; application-to-decision lag 11–43 days
  (median 24).
- Transactions span 2024-10-01 → 2026-09-30. Every customer's history starts by
  2024-10-23, 435 days before the first application, so a 365-day
  look-back is fully observed for every applicant.
- Because the data is time-ordered, the test set is **the most recent 20% of applications**
  (40 rows, created on or after 2026-06-25); the earlier 160 are the
  development set. Within the development set applications are independent (each customer appears once),
  so repeated stratified 5-fold CV is used rather than forward-chaining, which would leave
  ~26 rows in the first training window.

## 6. Leakage audit

| finding                                                                                    | evidence                                                                  | action                                                                                        |
|:-------------------------------------------------------------------------------------------|:--------------------------------------------------------------------------|:----------------------------------------------------------------------------------------------|
| `rejection_reason` (applications) is non-null exactly when the application is rejected     | holds for all rows: True                                                  | dropped                                                                                       |
| `loan_decision` event carries `decision` / `rejection_reason`; the `note` text restates it | 200 decision events                                                       | event excluded; `decision`, `rejection_reason`, `note` never read                             |
| Events after the decision echo the outcome                                                 | 136 post-decision events, 100% carry `decision`; 0 pre-decision events do | only events with timestamp < decision timestamp are used                                      |
| Transactions continue after the decision (post-approval behaviour)                         | ledger runs up to 253 days past the first decision                        | only the 365 days before application creation are used                                        |
| `required_monthly_income_eur` is a fixed multiple of the loan                              | ratio = 0.018409, std 1.5e-17                                             | not leakage (an input to the decision) but perfectly collinear; filtered for the linear model |
| price = loan + equity and LTV = loan / price are exact identities                          | max abs error 0 EUR and 9.8e-15                                           | same: collinearity filter                                                                     |
| `final_collateral_value_eur` is only the primary valuation                                 | 114 applications have a second (`other_apartment`) valuation in the log   | engineered `collateral_total_value` and coverage ratios                                       |

The final loan terms (price, loan, equity, collateral) are fixed during negotiation, before the decision event, so they are legitimate inputs: this model scores an application **at the moment the bank is about to decide**.

## 7. Engineered feature table

200 rows × 84 features (81 numeric, 3 categorical). Missing cells: 0. Constant features: 0. Quasi-constant (top value ≥ 95%): `tx_negative_balance_share` (98%), `neg_additional_collateral_requested` (96%), `tx_invest_withdraw_m` (96%).

| family                                                             |   n |
|:-------------------------------------------------------------------|----:|
| final loan terms                                                   |   6 |
| negotiation behaviour (`neg_*`)                                    |  15 |
| recorded expenses (`exp_*`)                                        |   7 |
| transactions, 12 months pre-application (`tx_*`)                   |  33 |
| postal-area context (`ctx_*`)                                      |   2 |
| cross-source ratios (collateral, affordability, liquidity, search) |  17 |
| customer / categorical                                             |   4 |

`postal_area3` has 26 levels on 200 rows: CatBoost consumes it natively, the other models get a cross-fitted target encoding.

## 8. Multicollinearity (development set)

| feature_a                   | feature_b                     |   abs_spearman |
|:----------------------------|:------------------------------|---------------:|
| final_requested_loan_eur    | required_monthly_income_eur   |          1.000 |
| income_coverage             | loan_to_annual_income         |          1.000 |
| neg_n_valuations            | neg_has_additional_collateral |          1.000 |
| exp_existing_loan           | existing_loan_to_income       |          0.997 |
| tx_salary_m                 | tx_salary_median              |          0.994 |
| tx_salary_m                 | tx_income_m                   |          0.990 |
| final_requested_loan_eur    | tx_salary_median              |          0.989 |
| required_monthly_income_eur | tx_salary_median              |          0.989 |
| required_monthly_income_eur | tx_salary_m                   |          0.987 |
| final_requested_loan_eur    | tx_salary_m                   |          0.987 |

- 25 feature pairs have |ρ| > 0.95.
- VIF on all 81 numeric features: 36 are effectively infinite (exact
  identities), median 1,184.
- A pairwise filter at 0.95 keeps 68 features but the max VIF is still 1.0e+15: multi-way
  identities (price = loan + equity, total consumption = sum of category spends, total collateral =
  primary + additional) are invisible to pairwise checks.
- The linear pipeline therefore adds iterative VIF pruning (drop the worst feature until every VIF ≤ 10):
  **45 features remain, max VIF 8.7, median 2.8.** It removes
  23 more features, e.g. `final_property_price_eur`, `final_equity_amount_eur`, `neg_n_events`, `neg_first_property_price`, `neg_max_property_price`, `neg_days_to_loan_calc`, `neg_n_valuations`, `neg_additional_collateral_value`.
- Both thresholds are refitted inside every CV fold and tuned; the surviving model is elastic-net regularised.
  Tree models keep all features: collinearity does not bias them, it only spreads importance.

## 9. Signal scan (development set only)

| feature                     |   univariate_auc |
|:----------------------------|-----------------:|
| residual_income_coverage    |            0.724 |
| tx_housing_to_income        |            0.305 |
| tx_savings_rate             |            0.695 |
| tx_consumption_m            |            0.306 |
| tx_spend_housing_m          |            0.319 |
| tx_living_cost_ex_housing_m |            0.319 |
| tx_spend_lifestyle_m        |            0.322 |
| tx_spend_transportation_m   |            0.326 |
| collateral_shortfall_eur    |            0.672 |
| collateral_coverage_total   |            0.330 |
| tx_spend_groceries_m        |            0.330 |
| customer_age                |            0.330 |
| tx_discretionary_share      |            0.661 |
| tx_spend_home_tech_m        |            0.348 |
| tx_salary_sweep_m           |            0.642 |

AUC > 0.5 means higher values go with rejection; < 0.5 with approval.

| property_type   |   n |   rejection_rate |
|:----------------|----:|-----------------:|
| apartment       |  75 |            0.253 |
| detached_house  |  28 |            0.321 |
| terraced_house  |  57 |            0.175 |

|   postal_city |   n |   rejection_rate |
|--------------:|----:|-----------------:|
|            00 |  87 |            0.241 |
|            01 |  21 |            0.048 |
|            02 |  52 |            0.308 |

|   neg_has_additional_collateral |   n |   rejection_rate |
|--------------------------------:|----:|-----------------:|
|                               0 |  75 |            0.347 |
|                               1 |  85 |            0.141 |

## 10. Drift between development and holdout (label-free)

Adversarial validation (can a model tell holdout rows from development rows using features alone?): AUC = **0.52** (0.50 = indistinguishable). No material covariate shift.

Rejection rate by application month, development set:

| month   |   n |   rejection_rate |
|:--------|----:|-----------------:|
| 2026-01 |  30 |            0.333 |
| 2026-02 |  30 |            0.300 |
| 2026-03 |  29 |            0.138 |
| 2026-04 |  24 |            0.250 |
| 2026-05 |  32 |            0.219 |
| 2026-06 |  15 |            0.133 |
