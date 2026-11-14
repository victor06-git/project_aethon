"""Model pipelines, cross-validation, Optuna tuning and serialization.

Four model families are compared on *identical* folds:

    logreg         Logistic Regression (the linear model for a binary target;
                   OLS "Linear Regression" is not valid for classification)
    random_forest  Random Forest
    xgboost        XGBoost with early stopping
    catboost       CatBoost with native categorical handling + early stopping

Leakage controls
----------------
* The chronological holdout is split off before anything is fitted.
* Every preprocessing step (imputation, scaling, collinearity filter, one-hot
  and target encoding) is inside the sklearn Pipeline, so it is re-fitted on
  the training part of every fold.
* Early stopping never looks at the validation fold: it uses an inner split of
  the training fold, then refits on the whole training fold with the selected
  number of trees.
* Hyperparameters are tuned on one set of repeated folds and scored on a
  different set of repeated folds; the holdout is the unbiased check.
* The tuning objective is ROC-AUC with a penalty for log-loss worse than the
  no-skill baseline (see `tune`).
"""
from __future__ import annotations

import json
import time
import warnings

import joblib
import numpy as np
import optuna
import pandas as pd
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.exceptions import ConvergenceWarning
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, balanced_accuracy_score,
                             brier_score_loss, log_loss, roc_auc_score)
from sklearn.model_selection import RepeatedStratifiedKFold, StratifiedKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import (OneHotEncoder, PowerTransformer,
                                   RobustScaler, StandardScaler, TargetEncoder)
from . import config as C
from . import features as F
from .estimators import CorrelationFilter, EarlyStoppedBooster

optuna.logging.set_verbosity(optuna.logging.WARNING)
warnings.filterwarnings("ignore", category=ConvergenceWarning)

LOW_CARD = ["property_type", "postal_city"]   # one-hot
HIGH_CARD = ["postal_area3"]                  # target-encoded (cross-fitted)


# --------------------------------------------------------------------------- #
# Model-specific pipelines
# --------------------------------------------------------------------------- #
def _target_encoder(seed: int) -> TargetEncoder:
    return TargetEncoder(target_type="binary", smooth="auto",
                         cv=StratifiedKFold(5, shuffle=True, random_state=seed))


def build_pipeline(name: str, params: dict, num_cols: list[str],
                   seed: int = C.SEED) -> Pipeline:
    p = dict(params)
    if name == "logreg":
        scaler = {"standard": StandardScaler(), "robust": RobustScaler(),
                  "power": PowerTransformer(method="yeo-johnson")}[p.pop("scaler", "power")]
        numeric = Pipeline([
            ("impute", SimpleImputer(strategy="median", add_indicator=True)),
            ("scale", scaler),
            ("standardize", StandardScaler()),
        ])
        pre = ColumnTransformer([
            ("num", numeric, num_cols),
            ("ohe", OneHotEncoder(drop="first", handle_unknown="ignore",
                                  min_frequency=5, sparse_output=False), LOW_CARD),
            ("te", Pipeline([("te", _target_encoder(seed)), ("sc", StandardScaler())]), HIGH_CARD),
        ], verbose_feature_names_out=False)
        model = LogisticRegression(
            C=p.pop("C", 1.0), l1_ratio=p.pop("l1_ratio", 0.0),
            solver="saga", max_iter=5000, random_state=seed)
        steps = [("pre", pre),
                 ("collinearity", CorrelationFilter(p.pop("corr_threshold", 0.95),
                                                    p.pop("vif_threshold", 10.0))),
                 ("model", model)]

    elif name == "random_forest":
        pre = ColumnTransformer([
            ("num", SimpleImputer(strategy="median", add_indicator=True), num_cols),
            ("ohe", OneHotEncoder(handle_unknown="ignore", min_frequency=5,
                                  sparse_output=False), LOW_CARD),
            ("te", _target_encoder(seed), HIGH_CARD),
        ], verbose_feature_names_out=False)
        model = RandomForestClassifier(random_state=seed, n_jobs=2, **p)
        steps = [("pre", pre), ("model", model)]

    elif name == "xgboost":
        pre = ColumnTransformer([
            ("num", "passthrough", num_cols),  # XGBoost handles NaN natively
            ("ohe", OneHotEncoder(handle_unknown="ignore", min_frequency=5,
                                  sparse_output=False), LOW_CARD),
            ("te", _target_encoder(seed), HIGH_CARD),
        ], verbose_feature_names_out=False)
        model = EarlyStoppedBooster("xgboost", params=p, max_iter=600,
                                    es_rounds=C.EARLY_STOPPING_ROUNDS, seed=seed)
        steps = [("pre", pre), ("model", model)]

    elif name == "catboost":
        cats = F.CATEGORICAL_FEATURES
        pre = ColumnTransformer([  # no encoding: raw strings go to CatBoost
            ("num", "passthrough", num_cols),
            ("cat", "passthrough", cats),
        ], verbose_feature_names_out=False)
        model = EarlyStoppedBooster("catboost", params=p, max_iter=600,
                                    es_rounds=C.EARLY_STOPPING_ROUNDS,
                                    cat_features=cats, seed=seed)
        steps = [("pre", pre), ("model", model)]
    else:
        raise ValueError(name)

    pipe = Pipeline(steps)
    pipe.set_output(transform="pandas")
    return pipe


# --------------------------------------------------------------------------- #
# Search spaces
# --------------------------------------------------------------------------- #
def suggest_params(name: str, trial: optuna.Trial) -> dict:
    if name == "logreg":
        return {
            "C": trial.suggest_float("C", 1e-3, 10, log=True),
            "l1_ratio": trial.suggest_float("l1_ratio", 0.0, 1.0),
            "scaler": trial.suggest_categorical("scaler", ["standard", "robust", "power"]),
            "corr_threshold": trial.suggest_float("corr_threshold", 0.80, 0.98),
            "vif_threshold": trial.suggest_categorical("vif_threshold", [5.0, 10.0, 30.0]),
        }
    if name == "random_forest":
        return {
            "n_estimators": 400,
            "max_depth": trial.suggest_int("max_depth", 2, 12),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 10),
            "max_features": trial.suggest_float("max_features", 0.1, 0.8),
            "max_samples": trial.suggest_float("max_samples", 0.5, 1.0),
        }
    if name == "xgboost":
        return {
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
            "max_depth": trial.suggest_int("max_depth", 1, 5),
            "min_child_weight": trial.suggest_float("min_child_weight", 0.5, 8, log=True),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.3, 1.0),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-2, 30, log=True),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-3, 5, log=True),
            "gamma": trial.suggest_float("gamma", 0.0, 3.0),
        }
    if name == "catboost":
        return {
            "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.2, log=True),
            "depth": trial.suggest_int("depth", 2, 6),
            "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1.0, 30.0, log=True),
            "rsm": trial.suggest_float("rsm", 0.2, 1.0),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "bootstrap_type": "Bernoulli",
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 1, 10),
        }
    raise ValueError(name)


# --------------------------------------------------------------------------- #
# Metrics + CV loop
# --------------------------------------------------------------------------- #
def compute_metrics(y, p) -> dict:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return {
        "roc_auc": roc_auc_score(y, p),
        "pr_auc": average_precision_score(y, p),
        "log_loss": log_loss(y, p, labels=[0, 1]),
        "brier": brier_score_loss(y, p),
        "balanced_acc": balanced_accuracy_score(y, (p >= 0.5).astype(int)),
    }


def make_splits(y, n_repeats: int, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    rskf = RepeatedStratifiedKFold(n_splits=C.N_SPLITS, n_repeats=n_repeats, random_state=seed)
    return list(rskf.split(np.zeros(len(y)), y))


def run_cv(name, params, X, y, splits, num_cols, seed=C.SEED):
    """Returns OOF matrix (n_repeats x n_rows), per-fold metric frame, fit seconds."""
    n_rep = len(splits) // C.N_SPLITS
    oof = np.full((n_rep, len(y)), np.nan)
    rows = []
    for i, (tr, va) in enumerate(splits):
        pipe = build_pipeline(name, params, num_cols, seed=seed + i)
        t0 = time.perf_counter()
        pipe.fit(X.iloc[tr], y[tr])
        fit_s = time.perf_counter() - t0
        p = pipe.predict_proba(X.iloc[va])[:, 1]
        oof[i // C.N_SPLITS, va] = p
        rows.append({"model": name, "repeat": i // C.N_SPLITS, "fold": i % C.N_SPLITS,
                     "n_val": len(va), "fit_seconds": fit_s, **compute_metrics(y[va], p)})
    return oof, pd.DataFrame(rows)


def tune(name, X, y, num_cols, n_trials, seed=C.SEED):
    """Optuna TPE on out-of-fold ROC-AUC, guarded against unusable probabilities.

    Score = mean pooled OOF ROC-AUC  -  max(0, OOF log-loss - no-skill log-loss).

    The penalty is zero for any configuration whose probabilities beat "always
    predict the base rate", so it does not change the ranking of sane models.
    It only stops the search from buying a sliver of AUC with a wildly
    over-confident model (which is what unpenalised AUC tuning does to a
    barely-regularised logistic regression on 128 rows).
    """
    splits = make_splits(y, C.TUNE_REPEATS, seed + 1000)  # != evaluation folds
    no_skill = log_loss(y, np.full(len(y), y.mean()))

    def objective(trial):
        params = suggest_params(name, trial)
        oof, _ = run_cv(name, params, X, y, splits, num_cols, seed=seed)
        auc = float(np.mean([roc_auc_score(y, r) for r in oof]))
        ll = float(np.mean([log_loss(y, np.clip(r, 1e-6, 1 - 1e-6)) for r in oof]))
        trial.set_user_attr("roc_auc", auc)
        trial.set_user_attr("log_loss", ll)
        return auc - max(0.0, ll - no_skill)

    study = optuna.create_study(direction="maximize",
                                sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
    best = suggest_params(name, optuna.trial.FixedTrial(study.best_params))
    return best, study


# --------------------------------------------------------------------------- #
# Ensemble
# --------------------------------------------------------------------------- #
def fit_blend_weights(oof_mean: pd.DataFrame, y) -> dict:
    """Non-negative weights summing to 1 that minimise OOF log-loss.

    Coarse simplex grid: with ~160 rows, a finer optimiser would only fit noise.
    """
    names = list(oof_mean.columns)
    grid = np.arange(0, 1.0001, 0.1)
    best, best_w = np.inf, None
    for w in np.array(np.meshgrid(*[grid] * (len(names) - 1))).T.reshape(-1, len(names) - 1):
        if w.sum() > 1 + 1e-9:
            continue
        full = np.append(w, 1 - w.sum())
        loss = log_loss(y, np.clip(oof_mean.values @ full, 1e-6, 1 - 1e-6))
        if loss < best - 1e-12:
            best, best_w = loss, full
    return {n: float(round(w, 2)) for n, w in zip(names, best_w)}


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def train_all(fast: bool = False, verbose: bool = True) -> dict:
    C.ensure_dirs()
    df = F.load_feature_table()
    dev, hold = F.chronological_split(df)
    feats, num_cols = F.feature_columns(df), F.numeric_columns(df)
    X_dev, y_dev = dev[feats], dev[C.TARGET].to_numpy()
    X_hold, y_hold = hold[feats], hold[C.TARGET].to_numpy()

    n_repeats = 2 if fast else C.N_REPEATS
    eval_splits = make_splits(y_dev, n_repeats, C.SEED)
    fold_frames, oof_all, best_params, hold_pred, timings = [], {}, {}, {}, {}

    for name in C.MODEL_ORDER:
        n_trials = 4 if fast else C.N_TRIALS[name]
        t0 = time.perf_counter()
        params, study = tune(name, X_dev, y_dev, num_cols, n_trials)
        tune_s = time.perf_counter() - t0
        best_params[name] = params

        oof, folds = run_cv(name, params, X_dev, y_dev, eval_splits, num_cols)
        oof_all[name] = oof
        fold_frames.append(folds)

        # Final fit on the whole development set -> scored once on the holdout.
        pipe = build_pipeline(name, params, num_cols)
        t1 = time.perf_counter()
        pipe.fit(X_dev, y_dev)
        timings[name] = {"tune_seconds": tune_s, "final_fit_seconds": time.perf_counter() - t1,
                         "n_trials": n_trials,
                         "tuning_auc": study.best_trial.user_attrs["roc_auc"],
                         "tuning_log_loss": study.best_trial.user_attrs["log_loss"]}
        hold_pred[name] = pipe.predict_proba(X_hold)[:, 1]
        joblib.dump(pipe, C.MODEL_DIR / f"{name}.joblib")

        # Deployment artefact: same recipe refitted on every labelled row.
        full = clone(build_pipeline(name, params, num_cols)).fit(df[feats], df[C.TARGET].to_numpy())
        joblib.dump(full, C.MODEL_DIR / f"{name}_full.joblib")

        if verbose:
            print(f"[train] {name:<14} OOF AUC {folds.roc_auc.mean():.3f} ± {folds.roc_auc.std():.3f} "
                  f"| tuned in {tune_s:,.0f}s over {n_trials} trials")

    # --- ensemble of all four models, weights from OOF only --------------
    oof_mean = pd.DataFrame({m: oof_all[m].mean(axis=0) for m in C.MODEL_ORDER})
    weights = fit_blend_weights(oof_mean, y_dev)
    w = np.array([weights[m] for m in C.MODEL_ORDER])
    oof_all["ensemble"] = np.stack([
        np.column_stack([oof_all[m][r] for m in C.MODEL_ORDER]) @ w for r in range(n_repeats)])
    hold_pred["ensemble"] = np.column_stack([hold_pred[m] for m in C.MODEL_ORDER]) @ w
    ens_rows = []
    for i, (_, va) in enumerate(eval_splits):
        r = i // C.N_SPLITS
        ens_rows.append({"model": "ensemble", "repeat": r, "fold": i % C.N_SPLITS, "n_val": len(va),
                         "fit_seconds": np.nan, **compute_metrics(y_dev[va], oof_all["ensemble"][r, va])})
    fold_frames.append(pd.DataFrame(ens_rows))

    # --- persist everything evaluate.py needs ------------------------------
    fold_scores = pd.concat(fold_frames, ignore_index=True)
    fold_scores.to_csv(C.ARTIFACT_DIR / "cv_fold_scores.csv", index=False)
    oof_df = dev[[C.APP_KEY, "app_ts", C.TARGET]].copy()
    for m, o in oof_all.items():
        oof_df[f"oof_{m}"] = o.mean(axis=0)
    oof_df.to_csv(C.ARTIFACT_DIR / "oof_predictions.csv", index=False)
    np.savez(C.ARTIFACT_DIR / "oof_by_repeat.npz", **oof_all)
    hold_df = hold[[C.APP_KEY, "app_ts", C.TARGET]].copy()
    for m, p in hold_pred.items():
        hold_df[f"pred_{m}"] = p
    hold_df.to_csv(C.ARTIFACT_DIR / "holdout_predictions.csv", index=False)
    meta = {"best_params": best_params, "timings": timings, "ensemble_weights": weights,
            "n_dev": len(dev), "n_holdout": len(hold), "n_features": len(feats),
            "holdout_starts": str(hold.app_ts.min()), "n_repeats": n_repeats,
            "n_splits": C.N_SPLITS, "fast": fast}
    (C.ARTIFACT_DIR / "training_meta.json").write_text(json.dumps(meta, indent=2, default=str))
    if verbose:
        print(f"[train] ensemble weights: {weights}")
    return meta


if __name__ == "__main__":
    train_all()
