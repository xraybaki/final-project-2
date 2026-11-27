"""Shared spatial helpers: local metric projection, densified edge points, KD-tree queries,
and network metrics (edge betweenness / chokepoints) cached on the graph."""
from __future__ import annotations

import math

import networkx as nx
import numpy as np
from scipy.spatial import cKDTree

from . import config as C

STEP_M = 25.0  # densification step along edges


class Projector:
    """Equirectangular projection around a reference point -> metres. Accurate to <0.5% in 15 km."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111_320.0 * math.cos(math.radians(lat0))
        self.ky = 110_540.0

    def xy(self, lat, lon):
        lat = np.asarray(lat, float)
        lon = np.asarray(lon, float)
        return np.column_stack(((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky))

    def latlon(self, x, y):
        return self.lat0 + np.asarray(y) / self.ky, self.lon0 + np.asarray(x) / self.kx


def projector_for(G: nx.Graph) -> Projector:
    lats = [d["lat"] for _, d in G.nodes(data=True)]
    lons = [d["lon"] for _, d in G.nodes(data=True)]
    return Projector(float(np.mean(lats)), float(np.mean(lons)))


class EdgeIndex:
    """Edges of G densified into points every STEP_M metres (with owning edge index)."""

    def __init__(self, G: nx.Graph, proj: Projector):
        self.G, self.proj = G, proj
        self.edges = list(G.edges())
        self.E = len(self.edges)
        pts, owner = [], []
        self.mid_xy = np.zeros((self.E, 2))
        self.edge_xy = []  # projected polyline per edge
        for i, (u, v) in enumerate(self.edges):
            geom = G.edges[u, v]["geometry"]
            xy = proj.xy([c[1] for c in geom], [c[0] for c in geom])
            self.edge_xy.append(xy)
            dense = densify(xy, STEP_M)
            pts.append(dense)
            owner.append(np.full(len(dense), i))
            self.mid_xy[i] = point_along(xy, 0.5)
        self.pts = np.vstack(pts)
        self.owner = np.concatenate(owner)
        self.tree = cKDTree(self.pts)

    # -- incidents -> edges -------------------------------------------------
    def count_within(self, inc_xy: np.ndarray, radius: float, weights=None) -> np.ndarray:
        """Per edge: (weighted) number of incidents within `radius` m of the edge."""
        out = np.zeros(self.E)
        if len(inc_xy) == 0:
            return out
        w = np.ones(len(inc_xy)) if weights is None else np.asarray(weights, float)
        hits = self.tree.query_ball_point(inc_xy, r=radius + STEP_M / 2)
        for j, idxs in enumerate(hits):
            if idxs:
                for e in np.unique(self.owner[idxs]):
                    out[e] += w[j]
        return out

    def incidents_within(self, inc_xy: np.ndarray, radius: float) -> list[set]:
        res = [set() for _ in range(self.E)]
        if len(inc_xy) == 0:
            return res
        hits = self.tree.query_ball_point(inc_xy, r=radius + STEP_M / 2)
        for j, idxs in enumerate(hits):
            for e in np.unique(self.owner[idxs]) if idxs else ():
                res[e].add(j)
        return res

    def nearest_distance(self, inc_xy: np.ndarray, cap: float = 5000.0) -> np.ndarray:
        """Per edge: distance (m) from the edge to the closest incident (capped)."""
        if len(inc_xy) == 0:
            return np.full(self.E, cap)
        d, _ = cKDTree(inc_xy).query(self.pts, k=1, distance_upper_bound=cap)
        d = np.minimum(d, cap)
        out = np.full(self.E, cap)
        np.minimum.at(out, self.owner, d)
        return out


def densify(xy: np.ndarray, step: float) -> np.ndarray:
    seg = np.diff(xy, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    out = [xy[0]]
    for a, s, L in zip(xy[:-1], seg, seglen):
        n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1):
            out.append(a + s * (k / n))
    return np.asarray(out)


def point_along(xy: np.ndarray, frac: float) -> np.ndarray:
    seg = np.diff(xy, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    total = seglen.sum()
    if total == 0:
        return xy[0].copy()
    target = frac * total
    acc = 0.0
    for a, s, L in zip(xy[:-1], seg, seglen):
        if acc + L >= target and L > 0:
            return a + s * ((target - acc) / L)
        acc += L
    return xy[-1].copy()


# --------------------------------------------------------------------------- network metrics
def ensure_network_metrics(G: nx.Graph) -> None:
    """Adds `betweenness` (edge, approx k samples), `chokepoint` (top-N%), `degree` to G."""
    if G.graph.get("_metrics_done"):
        return
    k = min(C.BETWEENNESS_K, G.number_of_nodes())
    print(f"  [network] edge betweenness (k={k} samples) on {G.number_of_edges():,} edges ...")
    eb = nx.edge_betweenness_centrality(G, k=k, weight="length_m", normalized=True,
                                        seed=C.RANDOM_SEED)
    vals = np.array([eb.get((u, v), eb.get((v, u), 0.0)) for u, v in G.edges()])
    thr = np.percentile(vals, 100 - C.CHOKEPOINT_TOP_PCT)
    for (u, v), b in zip(G.edges(), vals):
        G.edges[u, v]["betweenness"] = float(b)
        G.edges[u, v]["chokepoint"] = bool(b >= thr and b > 0)
    for n in G.nodes():
        G.nodes[n]["degree"] = G.degree(n)
    G.graph["_metrics_done"] = True
