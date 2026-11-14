"""Custom sklearn-compatible components used inside the model pipelines.

They live in their own module (not in train.py) so that serialized pipelines
always reference `src.estimators.*` and can be loaded from any entry point.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.base import BaseEstimator, ClassifierMixin, TransformerMixin
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

from . import config as C


class CorrelationFilter(BaseEstimator, TransformerMixin):
    """Multicollinearity guard for the linear model, fitted on the training fold.

    1. drop zero-variance columns;
    2. drop one of every pair with |Spearman rho| > `threshold` (greedy, column order);
    3. iteratively drop the column with the highest variance inflation factor
       until every VIF <= `vif_threshold`. Step 3 is what removes multi-way
       identities that no pairwise check can see (price = loan + equity,
       consumption = sum of category spends, total = primary + additional
       collateral).
    """

    def __init__(self, threshold: float = 0.95, vif_threshold: float | None = 10.0):
        self.threshold = threshold
        self.vif_threshold = vif_threshold

    @staticmethod
    def vif(X: pd.DataFrame) -> pd.Series:
        """VIF_i = i-th diagonal element of the inverse correlation matrix."""
        R = np.corrcoef(X.to_numpy(dtype=float), rowvar=False)
        R = np.atleast_2d(R) + 1e-10 * np.eye(X.shape[1])
        return pd.Series(np.diag(np.linalg.inv(R)), index=X.columns)

    def fit(self, X, y=None):
        X = pd.DataFrame(X)
        self.feature_names_in_ = np.asarray(X.columns, dtype=object)
        keep = [c for c in X.columns if X[c].std() > 1e-12]
        corr = X[keep].corr(method="spearman").abs().fillna(0.0)
        selected: list = []
        for c in keep:
            if all(corr.loc[c, s] <= self.threshold for s in selected):
                selected.append(c)
        if self.vif_threshold is not None:
            while len(selected) > 2:
                v = self.vif(X[selected])
                if v.max() <= self.vif_threshold:
                    break
                selected.remove(v.idxmax())
        self.keep_ = selected
        return self

    def transform(self, X):
        return pd.DataFrame(X, columns=self.feature_names_in_)[self.keep_]

    def get_feature_names_out(self, input_features=None):
        return np.asarray(self.keep_, dtype=object)


class EarlyStoppedBooster(BaseEstimator, ClassifierMixin):
    """XGBoost / CatBoost with leakage-free early stopping.

    fit(): hold out `val_fraction` of the *training* data, train with early
    stopping to find the best number of trees, then refit on all training data
    with that number. The outer validation fold is never seen.
    """

    def __init__(self, kind="xgboost", params=None, max_iter=600, es_rounds=50,
                 val_fraction=0.2, cat_features=None, seed=C.SEED, n_threads=2):
        self.kind = kind
        self.params = params
        self.max_iter = max_iter
        self.es_rounds = es_rounds
        self.val_fraction = val_fraction
        self.cat_features = cat_features
        self.seed = seed
        self.n_threads = n_threads

    def _make(self, n_iter: int, early_stop: bool):
        p = dict(self.params or {})
        if self.kind == "xgboost":
            return XGBClassifier(
                n_estimators=n_iter, objective="binary:logistic", eval_metric="logloss",
                tree_method="hist", random_state=self.seed, n_jobs=self.n_threads,
                early_stopping_rounds=self.es_rounds if early_stop else None, **p)
        return CatBoostClassifier(
            iterations=n_iter, loss_function="Logloss", random_seed=self.seed,
            thread_count=self.n_threads, verbose=False, allow_writing_files=False,
            cat_features=self.cat_features or None,
            early_stopping_rounds=self.es_rounds if early_stop else None, **p)

    def fit(self, X, y):
        y = np.asarray(y)
        self.classes_ = np.unique(y)
        X_tr, X_va, y_tr, y_va = train_test_split(
            X, y, test_size=self.val_fraction, stratify=y, random_state=self.seed)
        probe = self._make(self.max_iter, early_stop=True)
        if self.kind == "xgboost":
            probe.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
            best = probe.best_iteration + 1
        else:
            probe.fit(X_tr, y_tr, eval_set=(X_va, y_va), use_best_model=False)
            best = (probe.get_best_iteration() or 0) + 1
        # The refit sees 1/(1-val_fraction) more rows, so allow a few more trees.
        self.best_iteration_ = int(max(20, np.ceil(best / (1 - self.val_fraction))))
        self.model_ = self._make(self.best_iteration_, early_stop=False)
        self.model_.fit(X, y)
        return self

    def predict_proba(self, X):
        return self.model_.predict_proba(X)

    def predict(self, X):
        return self.classes_[(self.predict_proba(X)[:, 1] >= 0.5).astype(int)]
