"""
M4 - Export the weighted routing graph in the schema the frontend expects.

routing_graph.json   {meta, nodes, edges, adjacency_list}   (adjacency keys are STRINGS)
routing_edges.geojson  one LineString per edge, same properties
routing_edges.csv      same properties, no geometry
"""
from __future__ import annotations

import csv
import json

import numpy as np
import pandas as pd

from . import config as C


def _r(x, n=3):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def export(G, eidx, road_df: pd.DataFrame, scored: pd.DataFrame, region: dict, metrics: dict | None):
    E = eidx.E
    weights = scored["weight"].values
    # node weight = mean weight of incident edges
    acc = np.zeros(G.number_of_nodes())
    cnt = np.zeros(G.number_of_nodes())
    for i, (u, v) in enumerate(eidx.edges):
        acc[[u, v]] += weights[i]
        cnt[[u, v]] += 1
    node_w = acc / np.maximum(cnt, 1)

    nodes = [{"id": int(n), "lat": round(G.nodes[n]["lat"], 7), "lon": round(G.nodes[n]["lon"], 7),
              "weight": round(float(node_w[n]), 2)} for n in sorted(G.nodes())]

    edges, feats, adj = [], [], {str(n): [] for n in sorted(G.nodes())}
    for i, (u, v) in enumerate(eidx.edges):
        d = G.edges[u, v]
        tt = d["length_m"] / (C.CONVOY_SPEED_KMPH / 3.6)
        props = {
            "eid": i, "source": int(u), "target": int(v),
            "weight": round(float(weights[i]), 2),
            "length_m": round(d["length_m"], 1),
            "street_name": d["street_name"], "highway_type": d["highway_type"],
            "start_node_weight": round(float(node_w[u]), 2), "end_node_weight": round(float(node_w[v]), 2),
            "risk_prob": round(float(scored["risk_prob"].iat[i]), 4),
            "p_traverse": float(f"{scored['p_traverse'].iat[i]:.3e}"),
            "chokepoint": bool(d["chokepoint"]),
            "travel_time_s": round(tt, 1),
            "bridge": bool(d.get("bridge")), "tunnel": bool(d.get("tunnel")),
            "category": "High" if weights[i] >= C.HIGH_RISK_WEIGHT else ("Medium" if weights[i] >= 30 else "Low"),
            "features": {k: _r(road_df[k].iat[i], 4) for k in
                         ("road_priority", "lanes", "unpaved", "curviness", "betweenness")},
        }
        edges.append(props)
        a = {"target": int(v), "weight": props["weight"], "length_m": props["length_m"], "eid": i,
             "risk_prob": props["risk_prob"], "p_traverse": props["p_traverse"],
             "chokepoint": props["chokepoint"], "travel_time_s": props["travel_time_s"]}
        adj[str(u)].append(a)
        adj[str(v)].append({**a, "target": int(u)})
        geom = [[round(x, 6), round(y, 6)] for x, y in d["geometry"]]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": geom},
                      "properties": props})

    lengths = np.array([e["length_m"] for e in edges])
    meta = {
        "data_label": C.SYNTHETIC_LABEL,
        "region": region,
        "convoy_speed_kmph": C.CONVOY_SPEED_KMPH,
        "threat_zone_radius_m": C.THREAT_ZONE_RADIUS_M,
        "hard_block_impact": C.HARD_BLOCK_IMPACT,
        "high_risk_weight": C.HIGH_RISK_WEIGHT,
        "L_ref": round(float(np.median(lengths)), 2),
        "model": (metrics or {}).get("model", "hand-tuned formula"),
        "model_roc_auc": (metrics or {}).get("model_metrics", {}).get("roc_auc"),
    }
    graph = {"meta": meta, "nodes": nodes, "edges": edges, "adjacency_list": adj}
    C.ROUTING_GRAPH_JSON.write_text(json.dumps(graph, separators=(",", ":")))
    C.ROUTING_EDGES_GEOJSON.write_text(json.dumps(
        {"type": "FeatureCollection", "name": "routing_edges", "data_label": C.SYNTHETIC_LABEL,
         "features": feats}, separators=(",", ":")))
    C.REGION_JSON.write_text(json.dumps(meta, indent=2))

    flat_cols = [k for k in edges[0] if k != "features"]
    with open(C.ROUTING_EDGES_CSV, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=flat_cols + list(edges[0]["features"].keys()))
        w.writeheader()
        for e in edges:
            w.writerow({**{k: e[k] for k in flat_cols}, **e["features"]})
    print(f"  [M4] wrote routing_graph.json ({C.ROUTING_GRAPH_JSON.stat().st_size / 1e6:.1f} MB), "
          f"routing_edges.geojson ({C.ROUTING_EDGES_GEOJSON.stat().st_size / 1e6:.1f} MB), routing_edges.csv")
    return graph
