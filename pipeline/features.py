"""
M3 (part 1) - Per-edge feature engineering.

Two groups of features:
  * road / convoy / network factors (static, from OSM)   -> road_features()
  * incident-history features from a window of incidents -> incident_features()
"""
from __future__ import annotations

import math

import networkx as nx
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config as C
from .build_graph import UNPAVED, haversine_m
from .spatial import EdgeIndex, Projector, ensure_network_metrics

ROAD_PRIORITY = {
    "motorway": 1.0, "motorway_link": 0.9, "trunk": 0.95, "trunk_link": 0.85,
    "primary": 0.8, "primary_link": 0.7, "secondary": 0.65, "secondary_link": 0.6,
    "tertiary": 0.5, "tertiary_link": 0.45, "unclassified": 0.35, "residential": 0.3,
    "living_street": 0.2, "road": 0.3, "service": 0.15, "track": 0.1,
}
DEFAULT_LANES = {"motorway": 3, "trunk": 2, "primary": 2, "secondary": 2, "tertiary": 1.5}

ROAD_FEATURES = [
    "road_priority", "lanes", "narrow", "bridge", "tunnel", "unpaved", "length_m",
    "curviness", "betweenness", "chokepoint", "degree_max", "degree_min", "node_density_500m",
]
INCIDENT_FEATURES = [
    "inc_250m", "inc_500m", "inc_1km", "sev_density_500m", "dist_nearest_inc",
    "night_share_500m", "hostile_500m", "recent_500m",
]
FEATURES = ROAD_FEATURES + INCIDENT_FEATURES
HOSTILE = {"IED", "ambush", "stone_pelting"}


def road_features(G: nx.Graph, eidx: EdgeIndex) -> pd.DataFrame:
    ensure_network_metrics(G)
    node_xy = eidx.proj.xy([G.nodes[n]["lat"] for n in G.nodes()],
                           [G.nodes[n]["lon"] for n in G.nodes()])
    node_tree = cKDTree(node_xy)
    dens = np.array([len(x) for x in node_tree.query_ball_point(eidx.mid_xy, r=500)])

    rows = []
    for (u, v) in eidx.edges:
        d = G.edges[u, v]
        hw = d["highway_type"]
        lanes = d.get("lanes")
        if lanes is None or (isinstance(lanes, float) and math.isnan(lanes)):
            lanes = DEFAULT_LANES.get(hw.replace("_link", ""), 1.0)
        straight = haversine_m(G.nodes[u]["lat"], G.nodes[u]["lon"],
                               G.nodes[v]["lat"], G.nodes[v]["lon"])
        curv = min(5.0, d["length_m"] / straight) if straight > 1 else 1.0
        rows.append({
            "road_priority": ROAD_PRIORITY.get(hw, 0.3),
            "lanes": float(lanes),
            "narrow": float(lanes <= 1 and ROAD_PRIORITY.get(hw, 0.3) <= 0.5),
            "bridge": float(d.get("bridge", False)),
            "tunnel": float(d.get("tunnel", False)),
            "unpaved": float(str(d.get("surface", "")).lower() in UNPAVED or hw == "track"),
            "length_m": d["length_m"],
            "curviness": curv,
            "betweenness": d["betweenness"],
            "chokepoint": float(d["chokepoint"]),
            "degree_max": float(max(G.degree(u), G.degree(v))),
            "degree_min": float(min(G.degree(u), G.degree(v))),
        })
    df = pd.DataFrame(rows)
    df["node_density_500m"] = dens
    return df


def incident_features(eidx: EdgeIndex, inc: pd.DataFrame, ref_month: int) -> pd.DataFrame:
    """Features from incidents `inc` (already filtered to the feature window).
    `ref_month` = first month AFTER the window (used for recency)."""
    xy = eidx.proj.xy(inc["lat"].values, inc["lon"].values) if len(inc) else np.zeros((0, 2))
    sev = inc["severity"].values / 100.0 if len(inc) else np.zeros(0)
    night = inc["is_night"].values.astype(float) if len(inc) else np.zeros(0)
    hostile = inc["type"].isin(HOSTILE).values.astype(float) if len(inc) else np.zeros(0)
    recent = (inc["month_index"].values >= ref_month - 6).astype(float) if len(inc) else np.zeros(0)

    c500 = eidx.count_within(xy, 500)
    df = pd.DataFrame({
        "inc_250m": eidx.count_within(xy, 250),
        "inc_500m": c500,
        "inc_1km": eidx.count_within(xy, 1000),
        "sev_density_500m": eidx.count_within(xy, 500, weights=sev),
        "dist_nearest_inc": eidx.nearest_distance(xy),
        "hostile_500m": eidx.count_within(xy, 500, weights=hostile),
        "recent_500m": eidx.count_within(xy, 500, weights=recent),
    })
    night_c = eidx.count_within(xy, 500, weights=night)
    df["night_share_500m"] = np.where(c500 > 0, night_c / np.maximum(c500, 1), 0.0)
    return df[INCIDENT_FEATURES]


def build_feature_matrix(G, eidx, incidents: pd.DataFrame, months: tuple[int, int],
                         road_df: pd.DataFrame | None = None) -> pd.DataFrame:
    lo, hi = months
    window = incidents[(incidents.month_index >= lo) & (incidents.month_index < hi)]
    road_df = road_df if road_df is not None else road_features(G, eidx)
    inc_df = incident_features(eidx, window, ref_month=hi)
    return pd.concat([road_df.reset_index(drop=True), inc_df.reset_index(drop=True)], axis=1)[FEATURES]
