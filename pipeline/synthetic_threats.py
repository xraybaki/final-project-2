"""
Synthetic threat data (SYNTHETIC - for demonstration only).

Generates a reproducible 24-month incident history on real road edges, biased toward
convoy risk factors (chokepoints, bridges, narrow/unpaved roads, dense settlements,
winding hill sections), plus 4-6 "current" live threat reports.

No real incidents, units, people or operational details are represented.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import networkx as nx
import numpy as np
import pandas as pd

from . import config as C
from .spatial import EdgeIndex, point_along

TYPES = ["IED", "ambush", "stone_pelting", "road_blockade", "landslide", "accident"]
HOSTILE = {"IED", "ambush", "stone_pelting"}
SEVERITY_RANGE = {  # (low, high) on 1-100
    "IED": (60, 100), "ambush": (50, 95), "stone_pelting": (20, 60),
    "road_blockade": (15, 50), "landslide": (30, 85), "accident": (10, 60),
}
START = datetime(2024, 11, 1)


def _rank(x):
    x = np.asarray(x, float)
    return (np.argsort(np.argsort(x)) / max(1, len(x) - 1)) if len(x) else x


def _propensity(road: pd.DataFrame, rng) -> np.ndarray:
    """Latent (hidden) risk propensity per edge used ONLY to generate synthetic data."""
    z = (1.6 * _rank(road["betweenness"]) + 1.2 * road["bridge"] + 0.8 * road["unpaved"]
         + 0.6 * road["narrow"] + 0.9 * _rank(road["curviness"]) + 0.7 * _rank(road["node_density_500m"])
         + 0.4 * road["chokepoint"] + rng.normal(0, 0.35, len(road)))
    return z.values if hasattr(z, "values") else z


def _type_weights(r: pd.Series) -> np.ndarray:
    """Incident-type mix for a location, from its road character."""
    w = np.array([1.0, 1.0, 1.0, 1.0, 0.6, 1.4])
    w[0] += 3.0 * r["bridge"] + 1.5 * r["chokepoint"]                 # IED: bridges, chokepoints
    w[1] += 2.5 * (r["curviness"] > 1.25) + 1.0 * r["narrow"]         # ambush: winding / narrow
    w[2] += 2.0 * (r["node_density_500m"] > 60)                       # stone pelting: dense areas
    w[3] += 1.5 * (r["node_density_500m"] > 60) + 1.0 * (r["road_priority"] >= 0.65)
    w[4] += 3.0 * (r["curviness"] > 1.3) + 1.5 * r["unpaved"]         # landslide: hill roads
    w[5] += 1.5 * (r["road_priority"] >= 0.65)                        # accidents: busy roads
    return w / w.sum()


def _sample_time(itype: str, months: np.ndarray, rng):
    mw = np.ones(len(months))
    if itype == "landslide":
        cal = (START.month - 1 + months) % 12 + 1
        mw = np.where(np.isin(cal, [7, 8, 9]), 5.0, np.where(np.isin(cal, [6, 10]), 1.5, 0.4))
    m = int(rng.choice(months, p=mw / mw.sum()))
    if itype in HOSTILE:
        hour = int(rng.choice([20, 21, 22, 23, 0, 1, 2, 3, 4])) if rng.random() < 0.65 else int(rng.integers(5, 20))
    elif itype == "accident":
        hour = int(rng.choice(np.arange(24), p=_acc_hours()))
    else:
        hour = int(rng.integers(0, 24))
    month_start = START + pd.DateOffset(months=m)
    ts = month_start.to_pydatetime() + timedelta(days=int(rng.integers(0, 28)), hours=hour,
                                                 minutes=int(rng.integers(0, 60)))
    return ts, m


def _acc_hours():
    p = np.ones(24)
    p[[7, 8, 9, 17, 18, 19, 20, 21]] = 2.5
    return p / p.sum()


def generate_incidents(G: nx.Graph, eidx: EdgeIndex, road: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(C.RANDOM_SEED)
    z = _propensity(road, rng)
    E = eidx.E
    span = float(np.ptp(eidx.mid_xy[:, 0]) + np.ptp(eidx.mid_xy[:, 1])) / 2
    min_sep = min(1500.0, span / 8)

    # ---- hotspot centres (on real edges, biased to high propensity, spaced apart)
    # weighted random permutation (Gumbel-top-k) with log-weight 2*z
    order = np.argsort(-(2.0 * z + rng.gumbel(size=E)))
    hot_edges = []
    for e in order:
        if all(np.hypot(*(eidx.mid_xy[e] - eidx.mid_xy[h])) >= min_sep for h in hot_edges):
            hot_edges.append(int(e))
        if len(hot_edges) == C.N_HOTSPOTS:
            break
    H = len(hot_edges)
    # lifecycle: persistent / fading (stops before label window) / emerging (starts late)
    kinds = (["persistent"] * (H - 4) + ["fading", "fading", "emerging", "emerging"])[:H]
    rng.shuffle(kinds)
    all_months = np.arange(C.HISTORY_MONTHS)
    active = {"persistent": all_months, "fading": np.arange(0, 15),
              "emerging": np.arange(C.FEATURE_MONTHS - 6, C.HISTORY_MONTHS)}

    n_total = C.N_INCIDENTS or int(np.clip(0.04 * E, 500, 3000))
    n_hot = int(n_total * 0.62)
    n_bg = n_total - n_hot
    intensity = rng.gamma(2.0, 1.0, H)
    per_hot = rng.multinomial(n_hot, intensity / intensity.sum())

    recs = []

    def add(e, itype, months, hotspot_id):
        xy = point_along(eidx.edge_xy[e], float(rng.random()))
        lat, lon = eidx.proj.latlon(xy[0], xy[1])
        ts, m = _sample_time(itype, months, rng)
        lo, hi = SEVERITY_RANGE[itype]
        sev = int(np.clip(lo + (hi - lo) * rng.beta(2, 2), 1, 100))
        recs.append({"lat": round(float(lat), 6), "lon": round(float(lon), 6), "type": itype,
                     "severity": sev, "timestamp": ts.isoformat(timespec="minutes"),
                     "month_index": m, "is_night": int(ts.hour >= 20 or ts.hour < 5),
                     "hotspot_id": hotspot_id, "edge_index": int(e)})

    for h, (he, kind, n) in enumerate(zip(hot_edges, kinds, per_hot)):
        sigma = rng.uniform(150, 450)
        d = np.hypot(*(eidx.mid_xy - eidx.mid_xy[he]).T)
        near = np.where(d < 3 * sigma)[0]
        w = np.exp(-d[near] ** 2 / (2 * sigma ** 2)) * np.exp(0.5 * (z[near] - z.max()))
        tw = _type_weights(road.iloc[he])
        for e in rng.choice(near, size=n, p=w / w.sum()):
            add(int(e), TYPES[rng.choice(6, p=tw)], active[kind], h)

    # ---- background incidents: driven by road factors (not by past incidents)
    pb = np.exp(1.1 * (z - z.max()))
    for e in rng.choice(E, size=n_bg, p=pb / pb.sum()):
        add(int(e), TYPES[rng.choice(6, p=_type_weights(road.iloc[e]))], all_months, -1)

    df = pd.DataFrame(recs).sort_values(["timestamp", "lat", "lon"], kind="stable").reset_index(drop=True)
    df.insert(0, "incident_id", np.arange(len(df)))
    df["data_label"] = C.SYNTHETIC_LABEL
    df.attrs["hotspots"] = [{"edge_index": e, "kind": k} for e, k in zip(hot_edges, kinds)]
    return df


DESCRIPTIONS = {
    "IED": "Unattended object reported on the road shoulder near {loc}. Area under observation; "
           "movement through the segment is not advised until cleared. (Fictional training scenario.)",
    "ambush": "Report of suspicious individuals observing traffic on a winding stretch of {loc}. "
              "Convoys advised to avoid or proceed with heightened caution. (Fictional training scenario.)",
    "stone_pelting": "Crowd gathering and sporadic stone throwing reported along {loc}. "
                     "Vehicles have sustained minor damage. (Fictional training scenario.)",
    "road_blockade": "Road blocked by a protest sit-in on {loc}. Traffic diverted; "
                     "expected to persist for several hours. (Fictional training scenario.)",
    "landslide": "Debris from a slope failure has fully blocked {loc}. Road closed to all "
                 "vehicles until clearance. (Fictional training scenario.)",
    "accident": "Multi-vehicle collision partially blocking {loc}. Expect delays and "
                "single-lane movement. (Fictional training scenario.)",
}


def generate_live_threats(G: nx.Graph, eidx: EdgeIndex, road: pd.DataFrame,
                          incidents: pd.DataFrame) -> dict:
    rng = np.random.default_rng(C.RANDOM_SEED + 1)
    # candidate edges: named, reasonably major roads near recent incident activity
    recent = incidents[incidents.month_index >= C.HISTORY_MONTHS - 6]
    activity = np.zeros(eidx.E)
    np.add.at(activity, recent["edge_index"].values, 1)
    names = np.array([G.edges[u, v]["street_name"] for u, v in eidx.edges])
    score = activity + 3 * road["road_priority"].values + 2 * road["betweenness"].values / (road["betweenness"].max() or 1)
    score[names == "Unnamed road"] -= 100
    order = np.argsort(-score)

    plan = [("IED", 92), ("ambush", 80), ("stone_pelting", 65), ("road_blockade", 70), ("landslide", 94)]
    events, chosen, used_names = [], [], set()
    for e in order:
        if len(events) == len(plan):
            break
        if names[e] in used_names or any(np.hypot(*(eidx.mid_xy[e] - eidx.mid_xy[c])) < 1200 for c in chosen):
            continue
        itype, impact = plan[len(events)]
        xy = point_along(eidx.edge_xy[e], 0.5)
        lat, lon = eidx.proj.latlon(xy[0], xy[1])
        loc = str(names[e])
        events.append({"id": f"INTEL-{len(events) + 1:03d}", "lat": round(float(lat), 6), "lon": round(float(lon), 6),
                       "type": itype, "impact": impact, "radius_m": C.THREAT_DEFAULT_RADIUS_M[itype],
                       "location": loc, "location_label": loc,
                       "description": DESCRIPTIONS[itype].format(loc=loc)})
        chosen.append(e)
        used_names.add(names[e])
    return {"success": True, "events": events, "source": C.SYNTHETIC_LABEL,
            "data_label": C.SYNTHETIC_LABEL,
            # fixed (end of the synthetic history) so re-running the pipeline does not change the file;
            # the server stamps the live time when it serves the feed
            "timestamp": (START + pd.DateOffset(months=C.HISTORY_MONTHS)).isoformat() + "+00:00"}


def run(G, eidx, road):
    inc = generate_incidents(G, eidx, road)
    inc.to_csv(C.INCIDENTS_CSV, index=False, encoding="utf-8")
    live = generate_live_threats(G, eidx, road, inc)
    C.LIVE_THREATS_JSON.write_text(json.dumps(live, indent=2), encoding="utf-8")
    counts = inc["type"].value_counts().to_dict()
    print(f"  [threats] {len(inc):,} SYNTHETIC incidents -> {C.INCIDENTS_CSV.relative_to(C.ROOT)} {counts}")
    print(f"  [threats] {len(live['events'])} live threats -> {C.LIVE_THREATS_JSON.relative_to(C.ROOT)}")
    return inc, live
