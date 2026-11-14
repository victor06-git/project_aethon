"""Leaderboard, significance, interpretability and error diagnostics.

Reads what src/train.py saved and writes everything under reports/ plus
predictions.csv. Model selection uses development-set CV only; the holdout is
reported, never used to choose.
"""
from __future__ import annotations

import json
import warnings

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
from catboost import Pool
from scipy import stats
from sklearn.inspection import permutation_importance
from sklearn.metrics import confusion_matrix, f1_score, roc_auc_score, roc_curve

from . import config as C
from . import features as F
from .train import compute_metrics

warnings.filterwarnings("ignore")

# ---- chart style: one fixed colour per model, recessive axes ---------------
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3de"
MODEL_COLORS = {"logreg": "#2a78d6", "random_forest": "#eb6834", "xgboost": "#1baf7a",
                "catboost": "#eda100", "ensemble": "#e87ba4"}
LABELS = {**C.MODEL_LABELS, "ensemble": "Weighted ensemble"}
FAMILIES = {
    "final loan terms": ("final_", "required_", "lfinal_"),
    "collateral (incl. additional)": ("collateral_", "neg_additional", "neg_has_additional", "neg_n_valuations"),
    "negotiation behaviour": ("neg_", "price_vs"),
    "recorded expenses": ("exp_", "expenses_"),
    "transactions (spend, balance, salary)": ("tx_",),
    "affordability / liquidity ratios": ("income_", "salary_cov", "residual_", "loan_to_", "existing_",
                                         "debt_", "equity_cov", "cash_"),
    "customer & location": ("customer_", "postal_", "property_type", "ctx_"),
}


def _style(ax, title=None, xlabel=None, ylabel=None):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=9, length=0)
    ax.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    if title:
        ax.set_title(title, loc="left", fontsize=11, color=INK, fontweight="bold", pad=10)
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=9, color=INK2)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=9, color=INK2)


def _save(fig, name):
    d = C.REPORT_DIR / "figures"
    d.mkdir(parents=True, exist_ok=True)
    fig.patch.set_facecolor(SURFACE)
    fig.savefig(d / name, dpi=160, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)


def _family(col: str) -> str:
    for fam, prefixes in FAMILIES.items():
        if col.startswith(prefixes):
            return fam
    return "other"


# --------------------------------------------------------------------------- #
# Statistics helpers
# --------------------------------------------------------------------------- #
def bootstrap_auc_ci(y, p, n_boot=2000, seed=C.SEED):
    """Stratified bootstrap 95% CI for ROC-AUC."""
    rng = np.random.default_rng(seed)
    pos, neg = np.where(y == 1)[0], np.where(y == 0)[0]
    aucs = []
    for _ in range(n_boot):
        idx = np.r_[rng.choice(pos, len(pos)), rng.choice(neg, len(neg))]
        aucs.append(roc_auc_score(y[idx], p[idx]))
    return float(np.percentile(aucs, 2.5)), float(np.percentile(aucs, 97.5))


def corrected_resampled_ttest(diff: np.ndarray, n_train: int, n_test: int) -> float:
    """Nadeau-Bengio corrected t-test for repeated K-fold score differences.

    Plain paired t-tests are badly anti-conservative here because the folds
    share training data; the correction inflates the variance by n_test/n_train.
    """
    k = len(diff)
    var = diff.var(ddof=1)
    if var == 0:
        return 1.0
    t = diff.mean() / np.sqrt((1 / k + n_test / n_train) * var)
    return float(2 * stats.t.sf(abs(t), df=k - 1))


# --------------------------------------------------------------------------- #
# Interpretability
# --------------------------------------------------------------------------- #
def shap_importance(name: str, pipe, X: pd.DataFrame) -> pd.DataFrame:
    """Mean |SHAP| per model input feature, on the log-odds scale."""
    Xt = pipe[:-1].transform(X)
    est = pipe[-1]
    if name == "logreg":       # exact linear SHAP: coef * (x - mean)
        sv = est.coef_[0] * (Xt.to_numpy() - Xt.to_numpy().mean(axis=0))
    elif name == "catboost":   # CatBoost's own exact TreeSHAP handles categoricals
        sv = est.model_.get_feature_importance(
            Pool(Xt, cat_features=est.cat_features), type="ShapValues")[:, :-1]
    else:
        model = est.model_ if name == "xgboost" else est
        sv = np.asarray(shap.TreeExplainer(model).shap_values(Xt))
        if sv.ndim == 3:       # (n, features, classes) for sklearn forests
            sv = sv[:, :, 1] if sv.shape[2] == 2 else sv[1]
    out = pd.DataFrame({"feature": Xt.columns, "mean_abs_shap": np.abs(sv).mean(axis=0)})
    direction = []
    for j, c in enumerate(Xt.columns):
        x = pd.to_numeric(Xt[c], errors="coerce")
        if x.notna().sum() > 2 and x.nunique() > 1 and np.std(sv[:, j]) > 0:
            r = stats.spearmanr(x, sv[:, j]).statistic
            direction.append("higher → rejection" if r > 0.1 else "higher → approval" if r < -0.1 else "mixed")
        else:
            direction.append("categorical" if x.isna().all() else "none")
    out["direction"] = direction
    out["family"] = [_family(c) for c in out.feature]
    return out.sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)


def group_permutation(pipe, X, y, n_repeats=100, seed=C.SEED) -> pd.DataFrame:
    """AUC drop when a whole feature family is shuffled together."""
    rng = np.random.default_rng(seed)
    base = roc_auc_score(y, pipe.predict_proba(X)[:, 1])
    rows = []
    for fam in FAMILIES:
        cols = [c for c in X.columns if _family(c) == fam]
        drops = []
        for _ in range(n_repeats):
            Xp = X.copy()
            # .iloc keeps each column's dtype (a numpy round-trip would turn mixed
            # numeric/string families into object columns)
            Xp[cols] = X[cols].iloc[rng.permutation(len(X))].set_axis(X.index)
            drops.append(base - roc_auc_score(y, pipe.predict_proba(Xp)[:, 1]))
        rows.append({"family": fam, "n_features": len(cols),
                     "auc_drop_mean": np.mean(drops), "auc_drop_std": np.std(drops)})
    return pd.DataFrame(rows).sort_values("auc_drop_mean", ascending=False).reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def evaluate(verbose: bool = True) -> dict:
    C.ensure_dirs()
    df = F.load_feature_table()
    dev, hold = F.chronological_split(df)
    feats = F.feature_columns(df)
    y_dev, y_hold = dev[C.TARGET].to_numpy(), hold[C.TARGET].to_numpy()
    folds = pd.read_csv(C.ARTIFACT_DIR / "cv_fold_scores.csv")
    oof_rep = dict(np.load(C.ARTIFACT_DIR / "oof_by_repeat.npz"))
    hold_df = pd.read_csv(C.ARTIFACT_DIR / "holdout_predictions.csv")
    meta = json.loads((C.ARTIFACT_DIR / "training_meta.json").read_text())
    models = C.MODEL_ORDER + ["ensemble"]
    n_val = int(round(len(dev) / C.N_SPLITS))

    # ------------------------------------------------------------ leaderboard
    rows = []
    for m in models:
        f = folds.loc[folds.model == m]
        per_rep = pd.DataFrame([compute_metrics(y_dev, r) for r in oof_rep[m]]).mean()
        ph = hold_df[f"pred_{m}"].to_numpy()
        hm = compute_metrics(y_hold, ph)
        lo, hi = bootstrap_auc_ci(y_hold, ph)
        t = meta["timings"].get(m, {})
        rows.append({
            "model": LABELS[m], "key": m,
            "cv_auc_mean": f.roc_auc.mean(), "cv_auc_std": f.roc_auc.std(),
            "oof_auc": per_rep.roc_auc, "oof_pr_auc": per_rep.pr_auc,
            "oof_log_loss": per_rep.log_loss, "oof_brier": per_rep.brier,
            "holdout_auc": hm["roc_auc"], "holdout_auc_ci_lo": lo, "holdout_auc_ci_hi": hi,
            "holdout_pr_auc": hm["pr_auc"], "holdout_log_loss": hm["log_loss"],
            "holdout_brier": hm["brier"],
            "fit_seconds": f.fit_seconds.mean(), "tune_seconds": t.get("tune_seconds", np.nan),
        })
    prior = float(y_dev.mean())
    base_dev = compute_metrics(y_dev, np.full(len(y_dev), prior))
    base_hold = compute_metrics(y_hold, np.full(len(y_hold), prior))
    lb = pd.DataFrame(rows).sort_values("cv_auc_mean", ascending=False).reset_index(drop=True)
    singles = lb.loc[lb.key != "ensemble"]
    best, runner = singles.key.iloc[0], singles.key.iloc[1]
    lb.to_csv(C.REPORT_DIR / "leaderboard.csv", index=False)

    # paired fold-level comparison against the best single model
    pivot = folds.pivot_table(index=["repeat", "fold"], columns="model", values="roc_auc")
    sig = []
    for m in models:
        if m == best:
            continue
        d = (pivot[best] - pivot[m]).to_numpy()
        sig.append({"comparison": f"{LABELS[best]} vs {LABELS[m]}", "mean_auc_diff": d.mean(),
                    "folds_won_by_best": f"{int((d > 0).sum())}/{len(d)}",
                    "corrected_p_value": corrected_resampled_ttest(d, len(dev) - n_val, n_val)})
    sig = pd.DataFrame(sig)

    # ------------------------------------------------------- interpretability
    pipes = {m: joblib.load(C.MODEL_DIR / f"{m}.joblib") for m in C.MODEL_ORDER}
    shap_tables = {}
    for m in C.MODEL_ORDER:
        try:
            shap_tables[m] = shap_importance(m, pipes[m], dev[feats])
            shap_tables[m].to_csv(C.REPORT_DIR / f"feature_importance_shap_{m}.csv", index=False)
        except Exception as exc:  # never let an explainer incompatibility kill the run
            print(f"[evaluate] SHAP failed for {m}: {exc}")
    # Explicit scorer: sklearn's string scorer mis-detects the custom booster wrapper.
    perm = permutation_importance(
        pipes[best], hold[feats], y_hold, n_repeats=100, random_state=C.SEED, n_jobs=1,
        scoring=lambda est, X, y: roc_auc_score(y, est.predict_proba(X)[:, 1]))
    perm_df = (pd.DataFrame({"feature": feats, "auc_drop_mean": perm.importances_mean,
                             "auc_drop_std": perm.importances_std})
               .sort_values("auc_drop_mean", ascending=False).reset_index(drop=True))
    perm_df.to_csv(C.REPORT_DIR / f"feature_importance_permutation_holdout_{best}.csv", index=False)
    fam_df = group_permutation(pipes[best], hold[feats], y_hold)
    fam_df.to_csv(C.REPORT_DIR / f"feature_family_importance_holdout_{best}.csv", index=False)
    fam_shap = (shap_tables[best].groupby("family").mean_abs_shap.sum()
                .sort_values(ascending=False).rename("sum_mean_abs_shap").reset_index())
    fam_shap["share"] = fam_shap.sum_mean_abs_shap / fam_shap.sum_mean_abs_shap.sum()

    # ----------------------------------------------------------- diagnostics
    p_oof = oof_rep[best].mean(axis=0)
    p_hold = hold_df[f"pred_{best}"].to_numpy()
    diag = dev.copy()
    diag["p"], diag["residual"] = p_oof, y_dev - p_oof
    reasons = F.load_applications()[[C.APP_KEY, "rejection_reason"]]  # diagnostics only
    diag = diag.merge(reasons, on=C.APP_KEY, how="left")
    diag["outcome"] = diag.rejection_reason.fillna("approved")

    grid = np.round(np.arange(0.10, 0.71, 0.01), 2)
    thr = float(grid[int(np.argmax([f1_score(y_dev, p_oof >= t) for t in grid]))])
    cm_oof = confusion_matrix(y_dev, p_oof >= thr)
    cm_hold = confusion_matrix(y_hold, p_hold >= thr)

    diag["bin"] = pd.qcut(diag.p, 5, duplicates="drop")
    calib = diag.groupby("bin", observed=True).agg(
        n=("p", "size"), mean_predicted=("p", "mean"), observed_rate=(C.TARGET, "mean")).reset_index()
    calib["bin"] = calib.bin.astype(str)

    by_reason = diag.groupby("outcome").agg(
        n=("p", "size"), mean_predicted=("p", "mean"),
        flagged_at_threshold=("p", lambda s: (s >= thr).mean())).reset_index()

    diag["coverage_band"] = pd.cut(diag.collateral_coverage_total, [0, 0.9, 1.0, 1.5, np.inf],
                                   labels=["< 0.9", "0.9–1.0", "1.0–1.5", "> 1.5"])
    seg_rows = []
    for col in ["property_type", "postal_city", "neg_has_additional_collateral", "coverage_band"]:
        for lvl, g in diag.groupby(col, observed=True):
            yy = g[C.TARGET].to_numpy()
            seg_rows.append({"segment": col, "level": str(lvl), "n": len(g),
                             "observed_rate": yy.mean(), "mean_predicted": g.p.mean(),
                             "auc": roc_auc_score(yy, g.p) if 0 < yy.sum() < len(yy) else np.nan,
                             "mean_abs_residual": g.residual.abs().mean()})
    seg = pd.DataFrame(seg_rows)

    num = F.numeric_columns(df)
    res_corr = (pd.Series({c: stats.spearmanr(diag[c], diag.residual).statistic for c in num})
                .dropna().sort_values(key=np.abs, ascending=False).head(8)
                .rename("spearman_with_residual").reset_index().rename(columns={"index": "feature"}))
    show = [C.APP_KEY, "outcome", "p", "collateral_coverage_total", "neg_has_additional_collateral",
            "lfinal_loan_to_value", "tx_savings_rate", "customer_age"]
    worst = diag.assign(abs_res=diag.residual.abs()).sort_values("abs_res", ascending=False).head(10)[show]

    # ------------------------------------------------------------ predictions
    pred = hold[[C.APP_KEY, C.CUST_KEY, "app_ts"]].copy()
    pred[f"p_rejected_{best}"] = p_hold
    pred["p_rejected_ensemble"] = hold_df["pred_ensemble"].to_numpy()
    pred["predicted_decision"] = np.where(p_hold >= thr, "rejected", "approved")
    pred["actual_decision"] = hold[C.TARGET_RAW].to_numpy()
    pred.to_csv(C.ROOT / "predictions.csv", index=False)

    # ----------------------------------------------------------------- charts
    # A blend that collapsed onto one model would only hide that model's curve.
    degenerate = max(meta["ensemble_weights"].values()) >= 0.999
    plot_models = C.MODEL_ORDER if degenerate else models
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), sharey=True)
    for ax, (yy, getter, title) in zip(axes, [
            (y_dev, lambda m: oof_rep[m].mean(axis=0), f"Out-of-fold, development set (n={len(dev)})"),
            (y_hold, lambda m: hold_df[f'pred_{m}'].to_numpy(), f"Chronological holdout (n={len(hold)})")]):
        ax.plot([0, 1], [0, 1], color=GRID, linewidth=1.2, linestyle="--")
        for m in plot_models:
            p = getter(m)
            fpr, tpr, _ = roc_curve(yy, p)
            ax.plot(fpr, tpr, color=MODEL_COLORS[m], linewidth=2,
                    label=f"{LABELS[m]}  AUC {roc_auc_score(yy, p):.3f}")
        _style(ax, title, "False positive rate (approved flagged as rejected)")
        ax.legend(frameon=False, fontsize=8.5, loc="lower right", labelcolor=INK)
    axes[0].set_ylabel("True positive rate (rejections caught)", fontsize=9, color=INK2)
    _save(fig, "roc_curves.png")

    fig, ax = plt.subplots(figsize=(8, 4.2))
    order = lb.iloc[::-1]
    ypos = np.arange(len(order))
    ax.barh(ypos + 0.16, order.cv_auc_mean, height=0.34, color="#2a78d6",
            label="CV AUC (bar), ± SD over folds (whisker)")
    ax.errorbar(order.cv_auc_mean, ypos + 0.16, xerr=order.cv_auc_std, fmt="none",
                ecolor="#0f3f7a", elinewidth=1.2, capsize=3)
    ax.errorbar(order.holdout_auc, ypos - 0.2, fmt="D", color=INK, markersize=5, elinewidth=1.2, capsize=3,
                xerr=[order.holdout_auc - order.holdout_auc_ci_lo, order.holdout_auc_ci_hi - order.holdout_auc],
                label="Holdout AUC, 95% bootstrap CI")
    for yv, v in zip(ypos, order.cv_auc_mean):
        ax.text(0.505, yv + 0.16, f"{v:.3f}", va="center", ha="left", fontsize=9, color="white", fontweight="bold")
    ax.set_yticks(ypos, order.model, fontsize=9, color=INK)
    ax.set_xlim(0.5, 1.02)
    _style(ax, "ROC-AUC by model: cross-validation vs. chronological holdout", "ROC-AUC (0.5 = chance)")
    ax.grid(axis="y", visible=False)
    ax.legend(frameon=False, fontsize=8.5, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=2, labelcolor=INK)
    _save(fig, "leaderboard.png")

    top = shap_tables[best].head(15).iloc[::-1]
    fig, ax = plt.subplots(figsize=(8, 5.2))
    ax.barh(top.feature, top.mean_abs_shap, height=0.6, color="#2a78d6")
    for i, (v, d) in enumerate(zip(top.mean_abs_shap, top.direction)):
        ax.text(v, i, f"  {d}", va="center", fontsize=8, color=INK2)
    ax.set_xlim(0, top.mean_abs_shap.max() * 1.45)
    _style(ax, f"What drives {LABELS[best]}: top 15 features", "Mean |SHAP| (log-odds of rejection)")
    ax.grid(axis="y", visible=False)
    ax.tick_params(axis="y", labelsize=8.5, colors=INK)
    _save(fig, f"shap_top15_{best}.png")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
    ax = axes[0]
    ax.plot([0, 1], [0, 1], color=GRID, linewidth=1.2, linestyle="--")
    ax.plot(calib.mean_predicted, calib.observed_rate, color="#2a78d6", linewidth=2, marker="o", markersize=7)
    lim = max(calib.mean_predicted.max(), calib.observed_rate.max()) * 1.15
    ax.set_xlim(0, lim); ax.set_ylim(0, lim)
    _style(ax, f"Calibration, {LABELS[best]} (out-of-fold, {len(calib)} bins of ~{int(calib.n.mean())})",
           "Mean predicted P(rejected)", "Observed rejection rate")
    ax = axes[1]
    bins = np.linspace(0, 1, 21)
    ax.hist([p_oof[y_dev == 0], p_oof[y_dev == 1]], bins=bins, stacked=False,
            color=["#2a78d6", "#eb6834"], label=["Approved", "Rejected"], rwidth=0.9)
    ax.axvline(thr, color=INK, linewidth=1, linestyle=":")
    ax.text(thr, ax.get_ylim()[1] * 0.95, f"  threshold {thr:.2f}", fontsize=8.5, color=INK2, va="top")
    _style(ax, "Out-of-fold score distribution by actual decision", "Predicted P(rejected)", "Applications")
    ax.legend(frameon=False, fontsize=9, labelcolor=INK)
    _save(fig, f"calibration_and_scores_{best}.png")

    # ----------------------------------------------------------------- report
    def md(d, floatfmt=".3f"):
        return d.to_markdown(index=False, floatfmt=floatfmt)

    b = lb.loc[lb.key == best].iloc[0]
    lb_show = lb.drop(columns="key").copy()
    lb_show["cv_auc"] = lb_show.cv_auc_mean.map("{:.3f}".format) + " ± " + lb_show.cv_auc_std.map("{:.3f}".format)
    lb_show["holdout_auc_95ci"] = (lb_show.holdout_auc.map("{:.3f}".format) + " [" +
                                   lb_show.holdout_auc_ci_lo.map("{:.2f}".format) + ", " +
                                   lb_show.holdout_auc_ci_hi.map("{:.2f}".format) + "]")
    cols = ["model", "cv_auc", "oof_pr_auc", "oof_log_loss", "oof_brier", "holdout_auc_95ci",
            "holdout_pr_auc", "holdout_log_loss", "holdout_brier", "fit_seconds", "tune_seconds"]
    cmf = lambda cm: (f"TN {cm[0, 0]}, FP {cm[0, 1]}, FN {cm[1, 0]}, TP {cm[1, 1]} "
                      f"(recall {cm[1, 1] / max(cm[1].sum(), 1):.0%}, precision "
                      f"{cm[1, 1] / max(cm[:, 1].sum(), 1):.0%})")
    r = [
        "# Model report: predicting mortgage rejection", "",
        f"Target `final_decision` (positive class = rejected). {len(dev)} development applications "
        f"(before {meta['holdout_starts'][:10]}), {len(hold)} holdout applications (on or after). "
        f"{meta['n_features']} features. CV = {meta['n_repeats']}×{meta['n_splits']} repeated stratified folds, "
        "identical for every model.", "",
        "## Leaderboard", "", md(lb_show[cols]), "",
        f"- `cv_auc` is the mean ± SD of per-fold ROC-AUC over {meta['n_repeats'] * meta['n_splits']} folds; "
        "`oof_*` metrics are computed on pooled out-of-fold predictions and averaged over repeats.",
        f"- No-skill reference (always predict the development rejection rate, {prior:.3f}): AUC 0.500, "
        f"log-loss {base_dev['log_loss']:.3f} (dev) / {base_hold['log_loss']:.3f} (holdout), "
        f"Brier {base_dev['brier']:.3f} / {base_hold['brier']:.3f}.",
        f"- `fit_seconds` is one pipeline fit on {len(dev) - n_val} rows (boosters include the early-stopping "
        "probe and the refit); `tune_seconds` is the whole Optuna study.",
        f"- Ensemble weights (non-negative, sum to 1, chosen on out-of-fold log-loss): "
        f"{meta['ensemble_weights']}. "
        + (f"No blend beat {LABELS[max(meta['ensemble_weights'], key=meta['ensemble_weights'].get)]} alone, so "
           "the ensemble row is identical to that model."
           if max(meta["ensemble_weights"].values()) >= 0.999 else
           "Its OOF numbers are slightly optimistic because the weights were chosen on those same "
           "predictions; its holdout numbers are not."), "",
        f"**Selected model: {LABELS[best]}** (highest CV AUC among single models; the holdout was not used "
        "to choose).", "",
        "### Are the differences real?", "", md(sig), "",
        "Corrected resampled t-test (Nadeau–Bengio) on per-fold AUC differences. With "
        f"{n_val} validation rows per fold, p-values above 0.05 mean the ranking between those two models "
        "is not established by this data.", "",
        "![ROC curves](figures/roc_curves.png)", "", "![Leaderboard](figures/leaderboard.png)", "",
        "## Tuned hyperparameters", "",
    ]
    for m in C.MODEL_ORDER:
        r.append(f"- **{LABELS[m]}** ({meta['timings'][m]['n_trials']} Optuna trials): "
                 f"`{json.dumps({k: (float(f'{v:.4g}') if isinstance(v, float) else v) for k, v in meta['best_params'][m].items()})}`"
                 + (f"; early stopping kept {pipes[m][-1].best_iteration_} trees"
                    if m in ("xgboost", "catboost") else ""))
    r += ["", f"## What drives the predictions ({LABELS[best]})", "",
          f"SHAP on the development set (in-sample attribution), top 15 of {len(shap_tables[best])}:", "",
          md(shap_tables[best].head(15), ".4f"), "",
          f"![SHAP]({'figures/shap_top15_' + best + '.png'})", "",
          "Share of total attribution by feature family:", "", md(fam_shap), "",
          f"Runner-up ({LABELS[runner]}) top 10, as a cross-check that the story is not model-specific:", "",
          md(shap_tables[runner].head(10), ".4f"), "",
          f"### Out-of-sample check on the holdout ({len(hold)} rows, so noisy)", "",
          "AUC drop when a whole feature family is shuffled (100 repeats):", "", md(fam_df), "",
          "Single-feature permutation importance, top 10:", "", md(perm_df.head(10), ".4f"), "",
          "## Error diagnostics", "",
          f"Residual = actual − predicted P(rejected), on out-of-fold predictions of {LABELS[best]}.", "",
          "### Calibration", "", md(calib), "",
          f"![Calibration]({'figures/calibration_and_scores_' + best + '.png'})", "",
          f"### Decision threshold", "",
          f"Threshold {thr:.2f} maximises out-of-fold F1 for the rejected class.", "",
          f"- Out-of-fold: {cmf(cm_oof)}", f"- Holdout: {cmf(cm_hold)}", "",
          "### Which rejections does the model miss?", "",
          "`rejection_reason` is used here for diagnosis only; it is never a model input.", "",
          md(by_reason), "", "### Segments", "", md(seg), "",
          "### Features most correlated with the residual", "",
          "A large value means the model systematically under- or over-predicts along that feature.", "",
          md(res_corr), "", "### Ten largest out-of-fold errors", "", md(worst), ""]
    (C.REPORT_DIR / "model_report.md").write_text("\n".join(r))

    summary = {"best_model": best, "runner_up": runner, "threshold": thr,
               "cv_auc_mean": float(b.cv_auc_mean), "cv_auc_std": float(b.cv_auc_std),
               "holdout_auc": float(b.holdout_auc),
               "holdout_auc_ci": [float(b.holdout_auc_ci_lo), float(b.holdout_auc_ci_hi)]}
    (C.ARTIFACT_DIR / "evaluation_summary.json").write_text(json.dumps(summary, indent=2))
    if verbose:
        print(lb[["model", "cv_auc_mean", "cv_auc_std", "oof_log_loss", "holdout_auc",
                  "holdout_log_loss"]].round(3).to_string(index=False))
        print(f"[evaluate] best single model: {best}; reports in {C.REPORT_DIR}")
    return summary


if __name__ == "__main__":
    evaluate()
