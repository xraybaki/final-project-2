"""
M3 (part 2) - ML risk model. This is the "AI" in the project title.

Temporal split (no leakage):
    features  <- incidents in months 1-18   (+ static road / network factors)
    label     <- 1 if any incident in months 19-24 lies within LABEL_RADIUS_M of the edge

Model: XGBoost classifier (falls back to scikit-learn GradientBoosting / RandomForest).
Baseline: rank edges by distance to the nearest past incident only.

Final scoring: the model is refit on the full labelled set and applied to features
computed from the most recent 18-month window (months 7-24), so the app uses all data.
"""
from __future__ import annotations

import json
import math

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import (average_precision_score, confusion_matrix, precision_recall_curve,
                             precision_score, recall_score, roc_auc_score, roc_curve, f1_score)
from sklearn.model_selection import train_test_split

from . import config as C
from .features import FEATURES, build_feature_matrix

INCIDENT_ACTIVE_HOURS = 12.0  # how long a typical incident affects a segment (for per-trip prob)


def make_model(choice: str = C.MODEL_CHOICE, pos_weight: float = 1.0):
    if choice == "xgboost":
        try:
            from xgboost import XGBClassifier
            return XGBClassifier(n_estimators=400, max_depth=5, learning_rate=0.05,
                                 subsample=0.85, colsample_bytree=0.85, min_child_weight=3,
                                 reg_lambda=1.0, scale_pos_weight=pos_weight,
                                 eval_metric="logloss", random_state=C.RANDOM_SEED, n_jobs=4,
                                 tree_method="hist"), "XGBoost"
        except Exception as exc:  # noqa: BLE001
            print(f"  [M3] xgboost unavailable ({exc!r}) -> falling back to scikit-learn")
            choice = "gbm"
    if choice == "gbm":
        from sklearn.ensemble import HistGradientBoostingClassifier
        return HistGradientBoostingClassifier(max_iter=400, learning_rate=0.05, max_depth=6,
                                              class_weight="balanced",
                                              random_state=C.RANDOM_SEED), "HistGradientBoosting"
    from sklearn.ensemble import RandomForestClassifier
    return RandomForestClassifier(n_estimators=400, min_samples_leaf=3, class_weight="balanced",
                                  n_jobs=-1, random_state=C.RANDOM_SEED), "RandomForest"


def make_labels(eidx, incidents: pd.DataFrame, months: tuple[int, int]) -> np.ndarray:
    lo, hi = months
    fut = incidents[(incidents.month_index >= lo) & (incidents.month_index < hi)]
    xy = eidx.proj.xy(fut["lat"].values, fut["lon"].values)
    return (eidx.count_within(xy, C.LABEL_RADIUS_M) > 0).astype(int)


def _threshold_metrics(y, score, thr):
    pred = (score >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {"threshold": float(thr), "precision": float(precision_score(y, pred, zero_division=0)),
            "recall": float(recall_score(y, pred, zero_division=0)),
            "f1": float(f1_score(y, pred, zero_division=0)),
            "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}


def _best_f1_threshold(y, score):
    p, r, t = precision_recall_curve(y, score)
    f1 = 2 * p * r / np.maximum(p + r, 1e-12)
    i = int(np.nanargmax(f1[:-1])) if len(t) else 0
    return float(t[i]) if len(t) else 0.5


def _plots(model, name, y_val, s_val, b_val):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # ROC + PR
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.5))
    for s, lbl, ls in ((s_val, f"{name} model", "-"), (b_val, "Baseline: nearest-incident distance", "--")):
        fpr, tpr, _ = roc_curve(y_val, s)
        ax[0].plot(fpr, tpr, ls, label=f"{lbl} (AUC={roc_auc_score(y_val, s):.3f})")
        pr, rc, _ = precision_recall_curve(y_val, s)
        ax[1].plot(rc, pr, ls, label=f"{lbl} (AP={average_precision_score(y_val, s):.3f})")
    ax[0].plot([0, 1], [0, 1], ":", color="grey")
    ax[0].set(xlabel="False positive rate", ylabel="True positive rate", title="ROC (validation)")
    ax[1].axhline(y_val.mean(), ls=":", color="grey", label=f"Prevalence={y_val.mean():.2f}")
    ax[1].set(xlabel="Recall", ylabel="Precision", title="Precision-Recall (validation)")
    for a in ax:
        a.legend(fontsize=8, loc="lower right" if a is ax[0] else "upper right")
        a.grid(alpha=0.3)
    fig.suptitle("Edge risk model - SYNTHETIC data, for demonstration only", fontsize=10)
    fig.tight_layout()
    fig.savefig(C.REPORTS_DIR / "roc_pr.png", dpi=130)
    plt.close(fig)

    # feature importance
    imp = getattr(model, "feature_importances_", None)
    if imp is None:
        return {}
    order = np.argsort(imp)
    fig, ax = plt.subplots(figsize=(7, 6))
    ax.barh(np.array(FEATURES)[order], np.asarray(imp)[order], color="#3b82f6")
    ax.set(title=f"{name} feature importance (gain)", xlabel="Importance")
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(C.REPORTS_DIR / "feature_importance.png", dpi=130)
    plt.close(fig)
    return {f: float(v) for f, v in sorted(zip(FEATURES, imp), key=lambda t: -t[1])}


def train_and_score(G, eidx, road_df, incidents) -> tuple[pd.DataFrame, dict]:
    F, T = C.FEATURE_MONTHS, C.HISTORY_MONTHS
    X = build_feature_matrix(G, eidx, incidents, (0, F), road_df)
    y = make_labels(eidx, incidents, (F, T))
    print(f"  [M3] labelled edges: {len(y):,}  positives: {y.sum():,} ({y.mean():.1%})")

    X_tr, X_val, y_tr, y_val = train_test_split(X, y, test_size=0.25, stratify=y,
                                                random_state=C.RANDOM_SEED)
    pos_w = float((y_tr == 0).sum() / max(1, (y_tr == 1).sum()))
    model, name = make_model(pos_weight=pos_w)
    model.fit(X_tr, y_tr)
    s_val = model.predict_proba(X_val)[:, 1]
    b_val = -X_val["dist_nearest_inc"].values  # closer past incident -> riskier

    thr = _best_f1_threshold(y_val, s_val)
    bthr = _best_f1_threshold(y_val, b_val)
    metrics = {
        "data": C.SYNTHETIC_LABEL,
        "region": G.graph.get("region_name", C.REGION_NAME),
        "model": name,
        "split": {"feature_months": f"1-{F}", "label_months": f"{F + 1}-{T}",
                  "label_radius_m": C.LABEL_RADIUS_M, "val_fraction": 0.25, "stratified": True},
        "n_edges": int(len(y)), "positive_rate": float(y.mean()),
        "model_metrics": {"roc_auc": float(roc_auc_score(y_val, s_val)),
                          "pr_auc": float(average_precision_score(y_val, s_val)),
                          **_threshold_metrics(y_val, s_val, thr)},
        "baseline_metrics": {"description": "distance to nearest past incident only",
                             "roc_auc": float(roc_auc_score(y_val, b_val)),
                             "pr_auc": float(average_precision_score(y_val, b_val)),
                             **_threshold_metrics(y_val, b_val, bthr)},
    }
    metrics["spatial_block_cv"] = _spatial_cv(eidx, X, y)
    metrics["feature_importance"] = _plots(model, name, y_val, s_val, b_val)
    m, b = metrics["model_metrics"], metrics["baseline_metrics"]
    print(f"  [M3] {name}: ROC-AUC={m['roc_auc']:.3f} PR-AUC={m['pr_auc']:.3f} "
          f"P={m['precision']:.2f} R={m['recall']:.2f} | baseline ROC-AUC={b['roc_auc']:.3f} "
          f"PR-AUC={b['pr_auc']:.3f}")

    # ---- final model: refit on all labelled data, score latest 18-month window
    final, _ = make_model(pos_weight=float((y == 0).sum() / max(1, y.sum())))
    final.fit(X, y)
    X_now = build_feature_matrix(G, eidx, incidents, (T - F, T), road_df)
    p = final.predict_proba(X_now)[:, 1]
    # scale_pos_weight inflates probabilities; recalibrate to the observed base rate
    p = _prior_correct(p, prior_train=0.5 if pos_w != 1 else y.mean(), prior_true=y.mean())
    joblib.dump({"model": final, "features": FEATURES, "name": name, "label": C.SYNTHETIC_LABEL},
                C.MODELS_DIR / "risk_model.joblib")

    # expected severity factor from incidents near each edge (all 24 months)
    xy = eidx.proj.xy(incidents["lat"].values, incidents["lon"].values)
    n500 = eidx.count_within(xy, 500)
    s500 = eidx.count_within(xy, 500, weights=incidents["severity"].values)
    glob = incidents["severity"].mean()
    mean_sev = np.where(n500 > 0, (s500 + 5 * glob) / (n500 + 5), glob)  # shrunk to global mean
    sev_factor = 0.5 + 0.5 * mean_sev / 100.0

    risk = p * sev_factor
    q = np.quantile(risk, 0.99)
    weight = np.clip(100.0 * risk / q, 0, 100)
    # per-traversal incident probability (Poisson rate from 6-month label window)
    window_h = (T - F) * 30.4 * 24
    lam = -np.log(np.clip(1 - p, 1e-6, 1)) / window_h
    p_trav = 1 - np.exp(-lam * INCIDENT_ACTIVE_HOURS)

    scored = pd.DataFrame({"risk_prob": p, "sev_factor": sev_factor, "weight": weight,
                           "p_traverse": p_trav})
    metrics["scoring"] = {"window_months": f"{T - F + 1}-{T}", "weight_scale_q99": float(q),
                          "incident_active_hours": INCIDENT_ACTIVE_HOURS,
                          "pct_high_risk_ge60": float((weight >= C.HIGH_RISK_WEIGHT).mean())}
    (C.REPORTS_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"  [M3] model -> models/risk_model.joblib ; metrics -> reports/metrics.json")
    return scored, metrics


def _spatial_cv(eidx, X, y, cell_m: float = 1500.0, folds: int = 5) -> dict:
    """Spatially blocked CV: edges grouped into cell_m grid cells so neighbouring edges never
    sit on both sides of the split. A more honest estimate than the random split."""
    from sklearn.model_selection import GroupKFold
    groups = (np.floor(eidx.mid_xy[:, 0] / cell_m).astype(int) * 100003
              + np.floor(eidx.mid_xy[:, 1] / cell_m).astype(int))
    m_auc, b_auc = [], []
    for tr, te in GroupKFold(n_splits=folds).split(X, y, groups):
        if len(set(y[te])) < 2:
            continue
        mdl, _ = make_model(pos_weight=float((y[tr] == 0).sum() / max(1, y[tr].sum())))
        mdl.fit(X.iloc[tr], y[tr])
        m_auc.append(roc_auc_score(y[te], mdl.predict_proba(X.iloc[te])[:, 1]))
        b_auc.append(roc_auc_score(y[te], -X.iloc[te]["dist_nearest_inc"].values))
    out = {"cell_m": cell_m, "folds": len(m_auc),
           "model_roc_auc_mean": float(np.mean(m_auc)), "model_roc_auc_std": float(np.std(m_auc)),
           "baseline_roc_auc_mean": float(np.mean(b_auc))}
    print(f"  [M3] spatial-block CV ({cell_m:.0f} m cells): model ROC-AUC {out['model_roc_auc_mean']:.3f}"
          f" ± {out['model_roc_auc_std']:.3f}  vs baseline {out['baseline_roc_auc_mean']:.3f}")
    return out


def _prior_correct(p, prior_train, prior_true):
    """Bayes prior shift: undo class re-weighting so probabilities match the real base rate."""
    if abs(prior_train - prior_true) < 1e-9:
        return p
    a = p * prior_true / prior_train
    b = (1 - p) * (1 - prior_true) / (1 - prior_train)
    return a / np.maximum(a + b, 1e-12)


def hand_tuned_scores(road_df, incidents, eidx) -> pd.DataFrame:
    """Fallback if model training fails: transparent weighted formula."""
    xy = eidx.proj.xy(incidents["lat"].values, incidents["lon"].values)
    inc = eidx.count_within(xy, 500, weights=incidents["severity"].values / 100)
    r = lambda s: (np.argsort(np.argsort(s)) / max(1, len(s) - 1))  # noqa: E731
    score = (0.5 * r(inc) + 0.2 * r(road_df["betweenness"].values) + 0.1 * road_df["bridge"].values
             + 0.1 * road_df["unpaved"].values + 0.1 * r(road_df["curviness"].values))
    weight = np.clip(100 * score / np.quantile(score, 0.99), 0, 100)
    p = np.clip(weight / 100 * 0.5, 0, 0.99)
    p_trav = 1 - np.exp(-(-np.log(1 - p) / (6 * 30.4 * 24)) * INCIDENT_ACTIVE_HOURS)
    return pd.DataFrame({"risk_prob": p, "sev_factor": 1.0, "weight": weight, "p_traverse": p_trav})
