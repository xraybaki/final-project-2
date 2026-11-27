"""
One command builds everything:

    python -m pipeline.run_all

M1 road network -> M2 synthetic threats -> M3 features + ML risk model -> M4 export.
"""
from __future__ import annotations

import time
import traceback

import numpy as np

from . import config as C
from .build_graph import build_graph, _bbox
from .landmarks import build_landmarks
from .export_graph import export
from .features import road_features
from .spatial import EdgeIndex, projector_for
from . import synthetic_threats, train_model


def main():
    t0 = time.time()
    print("=" * 72)
    print(f"Convoy Safest-Route pipeline  |  {C.REGION_NAME}  |  {C.SYNTHETIC_LABEL}")
    print("=" * 72)

    G, region = build_graph()                                   # M1
    G.graph["region_name"] = region["name"]
    eidx = EdgeIndex(G, projector_for(G))
    road_df = road_features(G, eidx)

    incidents, live = synthetic_threats.run(G, eidx, road_df)   # M2

    metrics = None
    try:                                                        # M3
        scored, metrics = train_model.train_and_score(G, eidx, road_df, incidents)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("  [M3] !!! model training failed - using hand-tuned weight formula")
        scored = train_model.hand_tuned_scores(road_df, incidents, eidx)

    export(G, eidx, road_df, scored, region, metrics)           # M4
    build_landmarks(G, _bbox())                                 # M9 gazetteer

    w = scored["weight"].values
    print("-" * 72)
    print(f"Region          : {region['name']}")
    print(f"Nodes / edges   : {G.number_of_nodes():,} / {G.number_of_edges():,}")
    print(f"High-risk edges : {(w >= C.HIGH_RISK_WEIGHT).mean():.1%} (weight >= {C.HIGH_RISK_WEIGHT})")
    print(f"Chokepoints     : {int(sum(d['chokepoint'] for *_, d in G.edges(data=True))):,}")
    if metrics:
        m, b = metrics["model_metrics"], metrics["baseline_metrics"]
        print(f"Model           : {metrics['model']}  ROC-AUC {m['roc_auc']:.3f}  PR-AUC {m['pr_auc']:.3f}"
              f"  (baseline ROC-AUC {b['roc_auc']:.3f}, PR-AUC {b['pr_auc']:.3f})")
    print(f"Done in {time.time() - t0:.0f}s.  Next: node server.js -> http://localhost:3000")


if __name__ == "__main__":
    main()
