"""
SITREP location resolver (M9): free text -> precise threat point, or an explicit request to pin.

Ordered rules; the first one that succeeds wins:
  1. coordinates     decimal "34.0812, 74.7956", DMS 34°05'01"N 74°47'50"E, or MGRS 43S DT 12345 67890
  2. junction        two named roads + a junction cue ("junction of X and Y", "X / Y crossing",
                     "where X meets Y", "X-Y chowk")  -> the graph node both roads share
  3/4. landmark      a named OSM feature from data/landmarks.json, optionally "+ N m <dir> [on <road>]"
                     (the offset is walked ALONG the road geometry, never in a straight line)
  5. road only       -> {"status": "needs_pin", ...}: the operator must click the exact point
  6. nothing         -> {"status": "error", ...} listing accepted formats

All geometry is offline (routing_edges.geojson + data/landmarks.json). Coordinates proposed by
an AI model are never trusted.
"""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_TT = json.loads((ROOT / "threat_types.json").read_text(encoding="utf-8"))
THREAT_TYPES = _TT["types"]
HARD_BLOCK = _TT["hard_block_impact"]
R_MIN, R_MAX = _TT["radius_min_m"], _TT["radius_max_m"]

KEYWORDS = {
    "IED": ["ied", "bomb", "explosive", "suspicious object", "unattended object", "device", "pressure cooker"],
    "ambush": ["ambush", "firing", "gunmen", "gunfire", "sniper", "armed men", "militant", "shots"],
    "stone_pelting": ["stone", "pelting", "mob", "crowd", "riot", "rioters"],
    "road_blockade": ["blockade", "protest", "dharna", "chakka jam", "sit-in", "sit in", "barricade", "agitation"],
    "landslide": ["landslide", "debris", "slope", "rockfall", "rock fall", "mudslide", "boulders"],
    "accident": ["accident", "collision", "overturned", "crash", "truck stuck", "breakdown"],
}
DIRS = {"n": (0, 1), "s": (0, -1), "e": (1, 0), "w": (-1, 0),
        "ne": (0.7071, 0.7071), "nw": (-0.7071, 0.7071), "se": (0.7071, -0.7071), "sw": (-0.7071, -0.7071)}
DIR_WORDS = {"north": "n", "south": "s", "east": "e", "west": "w", "northeast": "ne", "north-east": "ne",
             "northwest": "nw", "north-west": "nw", "southeast": "se", "south-east": "se",
             "southwest": "sw", "south-west": "sw", "n": "n", "s": "s", "e": "e", "w": "w",
             "ne": "ne", "nw": "nw", "se": "se", "sw": "sw"}
JUNCTION_CUE = re.compile(r"\b(junction|jn|jnc|intersection|crossing|crossroads?|meets|chowk|crossing of)\b|/")
GENERIC_STREET = {"road", "street", "marg", "lane", "the", "rd", "st"}
GENERIC_LANDMARK = {"bridge", "junction", "jn", "the"}
KIND_PRIORITY = {"bridge": 0, "junction": 0, "square": 1, "police": 2, "hospital": 2, "fire_station": 2,
                 "station": 2, "market": 3, "religious": 3, "school": 3, "landmark": 3, "public": 4,
                 "park": 4, "fuel": 4, "airport": 2, "bus_stop": 5, "area": 9}
PRECISE_KINDS = {"bridge", "junction", "square", "police", "hospital", "fire_station", "station"}
ACCEPTED = ("Accepted location formats: coordinates ('34.0812, 74.7956', DMS 34°05'01\"N 74°47'50\"E, "
            "or MGRS '43S DT 12345 67890'); a junction ('junction of Nalahmar Road and Maharaj Ganj Road'); "
            "a landmark ('near Nawa Kadal'); or landmark + offset ('300 m east of Nawa Kadal on Nalahmar Road').")


# =============================================================================== text helpers
def norm(s: str) -> str:
    s = s.lower().replace("&", " and ")
    s = re.sub(r"(\w)(kadal|chowk|bagh)\b", r"\1 \2", s)          # gawkadal -> gaw kadal
    s = re.sub(r"\bgunj\b", "ganj", s)
    s = re.sub(r"\brd\b\.?", "road", s)
    s = re.sub(r"\bst\b\.?", "street", s)
    s = re.sub(r"\b(jn|jnc|jct)\b\.?", "junction", s)
    s = re.sub(r"[^a-z0-9/ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def key_for(name: str, generic: set) -> str:
    toks = norm(name).replace("/", " ").split()
    core = [t for t in toks if t not in generic]
    k = " ".join(core)
    return k if len(k) >= 5 else " ".join(toks)


def find_keys(text_n: str, keys: dict) -> list[tuple[int, int, str]]:
    """Non-overlapping matches of dictionary keys in normalised text, longest first.
    Returns [(start, end, key)] sorted by position."""
    found, taken = [], []
    padded = f" {text_n} "
    for k in sorted(keys, key=len, reverse=True):
        if len(k) < 4:
            continue
        for m in re.finditer(rf"(?<= ){re.escape(k)}(?= )", padded):
            a, b = m.start() - 1, m.end() - 1
            if all(b <= x or a >= y for x, y in taken):
                found.append((a, b, k))
                taken.append((a, b))
    return sorted(found)


# =============================================================================== geometry
class Geo:
    """Road graph + landmarks in a local metric frame."""

    def __init__(self, edges_geojson: Path, landmarks_json: Path):
        gj = json.loads(edges_geojson.read_text(encoding="utf-8"))
        feats = gj["features"]
        c0 = feats[len(feats) // 2]["geometry"]["coordinates"][0]
        self.lat0, self.lon0 = c0[1], c0[0]
        self.kx = 111_320.0 * math.cos(math.radians(self.lat0))
        self.ky = 110_540.0
        self.edges = {}            # eid -> dict(name, s, t, xy, cum, L)
        self.adj = {}              # node -> [eid]
        self.node_xy = {}
        self.streets = {}          # street key -> set(eid)
        self.street_name = {}      # street key -> display name
        self.bridge_streets = set()  # street keys that are named bridges (treated as landmarks)
        for f in feats:
            p = f["properties"]
            xy = [self.xy(c[1], c[0]) for c in f["geometry"]["coordinates"]]
            cum = [0.0]
            for a, b in zip(xy, xy[1:]):
                cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
            e = {"eid": p["eid"], "name": p["street_name"], "s": p["source"], "t": p["target"],
                 "xy": xy, "cum": cum, "L": cum[-1] or 1e-6}
            self.edges[p["eid"]] = e
            self.adj.setdefault(p["source"], []).append(p["eid"])
            self.adj.setdefault(p["target"], []).append(p["eid"])
            self.node_xy[p["source"]] = xy[0]
            self.node_xy[p["target"]] = xy[-1]
            if p["street_name"] and p["street_name"] != "Unnamed road":
                k = key_for(p["street_name"], GENERIC_STREET)
                self.streets.setdefault(k, set()).add(p["eid"])
                self.street_name.setdefault(k, p["street_name"])
                if p.get("bridge") and not re.search(r"\b(road|street|marg|lane|bypass)\b", p["street_name"], re.I):
                    self.bridge_streets.add(k)
        # coarse grid for nearest-edge queries
        self.cell = 250.0
        self.grid = {}
        for eid, e in self.edges.items():
            xs = [q[0] for q in e["xy"]]
            ys = [q[1] for q in e["xy"]]
            for gx in range(int(min(xs) // self.cell), int(max(xs) // self.cell) + 1):
                for gy in range(int(min(ys) // self.cell), int(max(ys) // self.cell) + 1):
                    self.grid.setdefault((gx, gy), []).append(eid)
        self.landmarks = []
        if landmarks_json.exists():
            for lm in json.loads(landmarks_json.read_text(encoding="utf-8")):
                lm["key"] = key_for(lm["name"], GENERIC_LANDMARK)
                lm["xy"] = self.xy(lm["lat"], lm["lon"])
                self.landmarks.append(lm)
        self.lm_keys = {}
        for lm in self.landmarks:
            self.lm_keys.setdefault(lm["key"], []).append(lm)

    # -- projection
    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def latlon(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)

    # -- nearest point on edges
    def project(self, eid, p):
        """Nearest point on edge polyline -> (dist, along, (x, y))."""
        e = self.edges[eid]
        best = (float("inf"), 0.0, e["xy"][0])
        for i, (a, b) in enumerate(zip(e["xy"], e["xy"][1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
            q = (a[0] + t * dx, a[1] + t * dy)
            d = math.hypot(p[0] - q[0], p[1] - q[1])
            if d < best[0]:
                best = (d, e["cum"][i] + t * math.sqrt(L2), q)
        return best

    def nearest_edge(self, p, max_d=150.0, allowed=None):
        r = int(max_d // self.cell) + 1
        gx, gy = int(p[0] // self.cell), int(p[1] // self.cell)
        cands = set()
        for i in range(gx - r, gx + r + 1):
            for j in range(gy - r, gy + r + 1):
                cands.update(self.grid.get((i, j), ()))
        if allowed is not None:
            cands &= allowed
        best = None
        for eid in cands:
            d, along, q = self.project(eid, p)
            if d <= max_d and (best is None or d < best[0]):
                best = (d, eid, along, q)
        return best

    def point_at(self, eid, along):
        e = self.edges[eid]
        along = max(0.0, min(e["L"], along))
        for i in range(len(e["cum"]) - 1):
            if e["cum"][i + 1] >= along:
                seg = e["cum"][i + 1] - e["cum"][i]
                t = 0 if seg == 0 else (along - e["cum"][i]) / seg
                a, b = e["xy"][i], e["xy"][i + 1]
                return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        return e["xy"][-1]

    def _tangent(self, eid, along, forward):
        a = self.point_at(eid, along)
        b = self.point_at(eid, along + (15 if forward else -15))
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        return dx / n, dy / n

    def walk(self, eid, along, direction, dist, allowed=None):
        """Move `dist` metres along the road network from (eid, along), heading as close to
        `direction` (unit vector) as possible. Stays on `allowed` edges if given.
        Returns ((x, y), walked_m)."""
        e = self.edges[eid]
        tf = self._tangent(eid, along, True)
        forward = tf[0] * direction[0] + tf[1] * direction[1] >= 0
        remaining, walked = dist, 0.0
        for _ in range(500):
            e = self.edges[eid]
            avail = e["L"] - along if forward else along
            if remaining <= avail:
                return self.point_at(eid, along + remaining if forward else along - remaining), walked + remaining
            remaining -= avail
            walked += avail
            node = e["t"] if forward else e["s"]
            best, best_score = None, -0.35
            for nx_ in self.adj.get(node, []):
                if nx_ == eid or (allowed is not None and nx_ not in allowed):
                    continue
                ne = self.edges[nx_]
                fwd = ne["s"] == node
                tan = self._tangent(nx_, 0 if fwd else ne["L"], fwd)
                score = tan[0] * direction[0] + tan[1] * direction[1]
                if score > best_score:
                    best, best_score = (nx_, fwd), score
            if best is None:
                return self.node_xy[node], walked  # dead end: stop at the last junction
            eid, forward = best
            along = 0.0 if forward else self.edges[eid]["L"]
        return self.point_at(eid, along), walked

    def street_length(self, eids):
        return sum(self.edges[e]["L"] for e in eids)


@lru_cache(maxsize=1)
def load_geo() -> Geo:
    return Geo(ROOT / "routing_edges.geojson", ROOT / "data" / "landmarks.json")


# =============================================================================== coordinates
def _dms(text):
    pat = (r"(\d{1,2})\s*[°d]\s*(\d{1,2})\s*['m′]\s*(\d{1,2}(?:\.\d+)?)?\s*(?:\"|″|s|'')?\s*([NS])"
           r"[\s,]+(\d{1,3})\s*[°d]\s*(\d{1,2})\s*['m′]\s*(\d{1,2}(?:\.\d+)?)?\s*(?:\"|″|s|'')?\s*([EW])")
    m = re.search(pat, text, re.I)
    if not m:
        return None
    la = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3) or 0) / 3600
    lo = int(m.group(5)) + int(m.group(6)) / 60 + float(m.group(7) or 0) / 3600
    if m.group(4).upper() == "S":
        la = -la
    if m.group(8).upper() == "W":
        lo = -lo
    return la, lo, m.group(0)


# ---- MGRS (WGS84 / UTM), no dependency ----------------------------------------
_A, _F = 6378137.0, 1 / 298.257223563
_E2 = _F * (2 - _F)
_K0 = 0.9996
_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"          # no I, O
_BANDS = "CDEFGHJKLMNPQRSTUVWX"


def latlon_to_utm(lat, lon):
    zone = int((lon + 180) // 6) + 1
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    phi, lam = math.radians(lat), math.radians(lon)
    ep2 = _E2 / (1 - _E2)
    N = _A / math.sqrt(1 - _E2 * math.sin(phi) ** 2)
    T = math.tan(phi) ** 2
    Cc = ep2 * math.cos(phi) ** 2
    Aa = math.cos(phi) * (lam - lon0)
    M = _A * ((1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256) * phi
              - (3 * _E2 / 8 + 3 * _E2 ** 2 / 32 + 45 * _E2 ** 3 / 1024) * math.sin(2 * phi)
              + (15 * _E2 ** 2 / 256 + 45 * _E2 ** 3 / 1024) * math.sin(4 * phi)
              - (35 * _E2 ** 3 / 3072) * math.sin(6 * phi))
    x = _K0 * N * (Aa + (1 - T + Cc) * Aa ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * Cc - 58 * ep2) * Aa ** 5 / 120) + 500000
    y = _K0 * (M + N * math.tan(phi) * (Aa ** 2 / 2 + (5 - T + 9 * Cc + 4 * Cc ** 2) * Aa ** 4 / 24
                                       + (61 - 58 * T + T ** 2 + 600 * Cc - 330 * ep2) * Aa ** 6 / 720))
    if lat < 0:
        y += 10_000_000
    return zone, x, y


def utm_to_latlon(zone, x, y, north=True):
    x -= 500000
    if not north:
        y -= 10_000_000
    ep2 = _E2 / (1 - _E2)
    M = y / _K0
    mu = M / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    N1 = _A / math.sqrt(1 - _E2 * math.sin(phi1) ** 2)
    T1 = math.tan(phi1) ** 2
    C1 = ep2 * math.cos(phi1) ** 2
    R1 = _A * (1 - _E2) / (1 - _E2 * math.sin(phi1) ** 2) ** 1.5
    D = x / (N1 * _K0)
    lat = phi1 - (N1 * math.tan(phi1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
                                              + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720)
    lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / math.cos(phi1)
    return math.degrees(lat), (zone - 1) * 6 - 180 + 3 + math.degrees(lon)


def latlon_to_mgrs(lat, lon, digits=5):
    zone, x, y = latlon_to_utm(lat, lon)
    band = _BANDS[min(19, int((lat + 80) // 8))]
    s = (zone - 1) % 6
    col = _LETTERS[(s % 3) * 8 + int(x // 100000) - 1]
    row_letters = "ABCDEFGHJKLMNPQRSTUV"
    row = row_letters[(int(y // 100000) + (5 if zone % 2 == 0 else 0)) % 20]
    f = 10 ** (5 - digits)
    return f"{zone}{band} {col}{row} {int(x % 100000) // f:0{digits}d} {int(y % 100000) // f:0{digits}d}"


def mgrs_to_latlon(text):
    m = re.search(r"\b(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])([A-HJ-NP-V])\s*(\d{1,5})\s+(\d{1,5})\b", text.upper())
    if not m or len(m.group(5)) != len(m.group(6)):
        return None
    zone, band, col, row = int(m.group(1)), m.group(2), m.group(3), m.group(4)
    digits = len(m.group(5))
    e_off = int(m.group(5)) * 10 ** (5 - digits) + 10 ** (5 - digits) / 2
    n_off = int(m.group(6)) * 10 ** (5 - digits) + 10 ** (5 - digits) / 2
    s = (zone - 1) % 6
    col_idx = _LETTERS.index(col) - (s % 3) * 8
    if not 0 <= col_idx < 8:
        return None
    x = (col_idx + 1) * 100000 + e_off
    row_letters = "ABCDEFGHJKLMNPQRSTUV"
    row_idx = (row_letters.index(row) - (5 if zone % 2 == 0 else 0)) % 20
    north = band >= "N"
    band_lat = -80 + _BANDS.index(band) * 8
    # band's minimum northing; add 2,000 km cycles until we reach it
    _, _, y_min = latlon_to_utm(band_lat if north else band_lat, (zone - 1) * 6 - 180 + 3)
    y = row_idx * 100000 + n_off
    while y < y_min - 100000:
        y += 2_000_000
    lat, lon = utm_to_latlon(zone, x, y if north else y, north=True if north else False)
    return lat, lon, m.group(0)


def find_coordinates(text):
    m = re.search(r"(-?\d{1,2}\.\d{3,})\s*[°]?\s*[NS]?\s*[, ]\s*(-?\d{1,3}\.\d{3,})", text)
    if m:
        return float(m.group(1)), float(m.group(2)), m.group(0), "decimal"
    d = _dms(text)
    if d:
        return d[0], d[1], d[2], "DMS"
    g = mgrs_to_latlon(text)
    if g:
        return g[0], g[1], g[2], "MGRS"
    return None


# =============================================================================== field extraction
def rule_fields(text: str) -> dict:
    t = text.lower()
    scores = {k: sum(t.count(w) for w in ws) for k, ws in KEYWORDS.items()}
    itype = max(scores, key=scores.get) if max(scores.values()) > 0 else "road_blockade"
    impact = THREAT_TYPES[itype]["impact"]
    if re.search(r"\b(suspected|unconfirmed|possible)\b", t):
        impact -= 4
    if re.search(r"\b(confirmed|multiple|heavy)\b", t):
        impact += 5
    if re.search(r"\b(road closed|completely blocked|fully blocked|impassable)\b", t):
        impact = max(impact, 92)
    out = {"type": itype, "impact": int(max(10, min(100, impact))), "radius_m": None,
           "offset_m": None, "direction": None}
    m = re.search(r"(\d+(?:\.\d+)?)\s*(km|kms|kilomet\w*|m|mtrs?|metres?|meters?)\s+"
                  r"(north-?east|north-?west|south-?east|south-?west|north|south|east|west|ne|nw|se|sw|n|s|e|w)\b"
                  r"\s*(?:of|from)?", t)
    if m:
        val = float(m.group(1))
        out["offset_m"] = val * 1000 if m.group(2).startswith("k") else val
        out["direction"] = DIR_WORDS[m.group(3)]
    r = re.search(r"(?:radius|within)\s*(?:of)?\s*(\d+)\s*(m|mtrs?|metres?|meters?)\b", t)
    if r:
        out["radius_m"] = int(r.group(1))
    return out


def clamp_radius(r, itype):
    r = r or THREAT_TYPES[itype]["radius_m"]
    return int(max(R_MIN, min(R_MAX, round(r / 5) * 5)))


# =============================================================================== location label
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def short_road(name):
    return re.sub(r"\bRoad\b", "Rd", re.sub(r"\bStreet\b", "St", name))


def describe(geo: Geo, x, y) -> str:
    near = geo.nearest_edge((x, y), 200)
    road = geo.edges[near[1]]["name"] if near else None
    best = None
    for lm in geo.landmarks:
        if lm["kind"] in ("area", "bus_stop", "fuel"):
            continue
        d = math.hypot(lm["xy"][0] - x, lm["xy"][1] - y)
        score = d + 60 * KIND_PRIORITY.get(lm["kind"], 5)
        if d < 800 and (best is None or score < best[0]):
            best = (score, d, lm)
    if not road or road == "Unnamed road":
        named = [e for e in geo.edges if geo.edges[e]["name"] != "Unnamed road"]
        nn = geo.nearest_edge((x, y), 150, set(named)) if named else None
        road = f"Unnamed road off {short_road(geo.edges[nn[1]]['name'])}" if nn else "Unnamed road"
    parts = [short_road(road)]
    if best:
        d, lm = best[1], best[2]
        if d < 25:
            parts.append(f"at {lm['name']}")
        else:
            ang = math.degrees(math.atan2(x - lm["xy"][0], y - lm["xy"][1])) % 360
            parts.append(f"~{int(round(d, -1))} m {COMPASS[int((ang + 22.5) // 45) % 8]} of {lm['name']}")
    return ", ".join(parts)


# =============================================================================== resolver
def _streets_in(geo, text_n):
    return [(a, b, k) for a, b, k in find_keys(text_n, geo.streets)]


def _is_bridge_key(geo, k):
    return k in geo.bridge_streets or any(l["kind"] == "bridge" for l in geo.lm_keys.get(k, ()))


def _landmarks_in(geo, text_n, street_spans):
    hits = []
    for a, b, k in find_keys(text_n, geo.lm_keys):
        # skip landmark keys that are just a matched (non-bridge) street name
        if k in geo.streets and not _is_bridge_key(geo, k):
            continue
        hits.append((a, b, k))
    return hits


def _junction_node(geo, k1, k2):
    e1, e2 = geo.streets[k1], geo.streets[k2]
    n1 = {geo.edges[e]["s"] for e in e1} | {geo.edges[e]["t"] for e in e1}
    n2 = {geo.edges[e]["s"] for e in e2} | {geo.edges[e]["t"] for e in e2}
    common = n1 & n2
    if common:
        return max(common, key=lambda n: len(geo.adj.get(n, []))), 0.0
    best = None
    for a in n1:
        pa = geo.node_xy[a]
        for b in n2:
            pb = geo.node_xy[b]
            d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
            if d < 120 and (best is None or d < best[1]):
                best = (a, d)
    return best if best else (None, None)


def _result(geo, x, y, f, resolution, confidence, text, parser, extra_label=None):
    lat, lon = geo.latlon(x, y)
    label = describe(geo, x, y)
    if extra_label:
        label = f"{label} ({extra_label})"
    return {"status": "ok", "lat": round(lat, 6), "lon": round(lon, 6), "type": f["type"],
            "impact": int(f["impact"]), "radius_m": clamp_radius(f.get("radius_m"), f["type"]),
            "location_label": label, "location": label, "resolution": resolution,
            "confidence": confidence, "sitrep_text": text.strip(),
            "description": f.get("description") or f"Parsed from SITREP: \"{text.strip()[:200]}\"",
            "parser": parser}


def resolve(text: str, fields: dict | None = None, parser: str = "rule-based", geo: Geo | None = None) -> dict:
    geo = geo or load_geo()
    f = rule_fields(text)
    if fields:  # AI-extracted fields refine (never replace) the rule-based ones; coords ignored
        for k in ("type", "impact", "radius_m", "offset_m", "direction", "description"):
            if fields.get(k) not in (None, ""):
                f[k] = fields[k]
        if isinstance(f.get("direction"), str):
            f["direction"] = DIR_WORDS.get(f["direction"].lower().replace(" ", ""), None)
    if f["type"] not in THREAT_TYPES:
        f["type"] = "road_blockade"
    f["impact"] = int(max(10, min(100, int(f["impact"]))))
    # AI hints (street / junction_with / landmark) are appended so the offline matcher sees them
    hint = " ".join(str(fields.get(k)) for k in ("landmark", "street", "junction_with")
                    if fields and fields.get(k)) if fields else ""
    text_n = norm(text + (" ; " + hint if hint else ""))

    # 1. coordinates ---------------------------------------------------------------
    c = find_coordinates(text)
    if c:
        x, y = geo.xy(c[0], c[1])
        return _result(geo, x, y, f, "coordinates", "high", text, parser, extra_label=f"{c[3]} {c[2].strip()}")

    streets = _streets_in(geo, text_n)
    street_keys = []
    for _, _, k in streets:
        if k not in street_keys and not _is_bridge_key(geo, k):   # a named bridge is a landmark
            street_keys.append(k)
    landmarks = _landmarks_in(geo, text_n, streets)
    has_offset = f.get("offset_m") and f.get("direction")
    direction = DIRS.get(f.get("direction") or "", None)

    # 2. junction of two named roads --------------------------------------------------
    if len(street_keys) >= 2 and JUNCTION_CUE.search(text_n):
        node, gap = _junction_node(geo, street_keys[0], street_keys[1])
        if node is not None:
            x, y = geo.node_xy[node]
            name = f"jn {geo.street_name[street_keys[0]]} / {geo.street_name[street_keys[1]]}"
            jconf = "high" if gap < 20 else "medium"
            if has_offset:
                allowed = geo.streets[street_keys[2]] if len(street_keys) > 2 else None
                start = min(geo.adj[node], key=lambda e: 0 if allowed is None or e in allowed else 1)
                se = geo.edges[start]
                (x, y), walked = geo.walk(start, 0 if se["s"] == node else se["L"], direction, f["offset_m"], allowed)
                return _result(geo, x, y, f, "junction+offset", "medium", text, parser,
                               extra_label=f"{int(walked)} m {f['direction'].upper()} along road from {name}")
            return _result(geo, x, y, f, "junction", jconf, text, parser,
                           extra_label=None if gap < 20 else f"roads are {int(gap)} m apart in OSM")
        return {"status": "error", "parser": parser, "type": f["type"],
                "message": f"{geo.street_name[street_keys[0]]} and {geo.street_name[street_keys[1]]} "
                           f"do not meet in the road network. " + ACCEPTED}

    # 3/4. landmark (optionally + offset along a road) ------------------------------------
    if landmarks:
        a, b, k = max(landmarks, key=lambda h: (h[1] - h[0], -min(KIND_PRIORITY.get(l["kind"], 5) for l in geo.lm_keys[h[2]])))
        cands = sorted(geo.lm_keys[k], key=lambda l: KIND_PRIORITY.get(l["kind"], 5))
        road_eids = set().union(*(geo.streets[s] for s in street_keys)) if street_keys else None
        # disambiguate same-name landmarks: keep those near the named road, else require uniqueness
        if len(cands) > 1:
            spread = max(math.hypot(p["xy"][0] - q["xy"][0], p["xy"][1] - q["xy"][1]) for p in cands for q in cands)
            if spread > 500:
                if road_eids:
                    near = [l for l in cands if geo.nearest_edge(l["xy"], 300, road_eids)]
                    cands = near or cands
                if len(cands) > 1 and max(math.hypot(p["xy"][0] - q["xy"][0], p["xy"][1] - q["xy"][1])
                                          for p in cands for q in cands) > 500:
                    return {"status": "error", "parser": parser, "type": f["type"],
                            "message": f"'{cands[0]['name']}' matches {len(cands)} places. Add a road name "
                                       f"or coordinates.",
                            "candidates": [{"name": l["name"], "lat": l["lat"], "lon": l["lon"], "kind": l["kind"]}
                                           for l in cands[:6]]}
        lm = cands[0]
        if lm["kind"] == "area" and not has_offset:
            # an area name is not a point: ask for a pin on the named road near that area
            if street_keys:
                eids = [e for e in geo.streets[street_keys[0]]
                        if geo.project(e, lm["xy"])[0] < 1200]
                if eids:
                    return _needs_pin(geo, street_keys[0], eids, f, parser, text,
                                      area=lm["name"])
                return _needs_pin(geo, street_keys[0], sorted(geo.streets[street_keys[0]]), f, parser, text,
                                  note=f"{lm['name']} is not near this road")
            return {"status": "error", "parser": parser, "type": f["type"],
                    "message": f"'{lm['name']}' is a whole area, not a point. Name a road, junction or "
                               f"landmark inside it. " + ACCEPTED}
        snap = geo.nearest_edge(lm["xy"], 300, road_eids) if road_eids else None
        snap = snap or geo.nearest_edge(lm["xy"], 150)
        if snap is None:
            x, y = lm["xy"]
            return _result(geo, x, y, f, "landmark", "medium", text, parser)
        _, eid, along, q = snap
        if has_offset:
            (x, y), walked = geo.walk(eid, along, direction, f["offset_m"], road_eids)
            via = f" along {short_road(geo.edges[eid]['name'])}" if road_eids else " along the road"
            short = " - road ends" if walked < 0.8 * f["offset_m"] else ""
            return _result(geo, x, y, f, "landmark+offset", "medium", text, parser,
                           extra_label=f"{int(walked)} m {f['direction'].upper()} of {lm['name']}{via}{short}")
        conf = "high" if lm["kind"] in PRECISE_KINDS else "medium"
        return _result(geo, q[0], q[1], f, "landmark", conf, text, parser)

    # 5. road only -> operator must pin --------------------------------------------------
    if street_keys:
        k = street_keys[0]
        return _needs_pin(geo, k, sorted(geo.streets[k]), f, parser, text)

    # 6. nothing ---------------------------------------------------------------------------
    return {"status": "error", "parser": parser, "type": f["type"],
            "message": "No location found in the SITREP. " + ACCEPTED}


def _needs_pin(geo, k, eids, f, parser, text, area=None, note=None):
    km = geo.street_length(eids) / 1000
    name = geo.street_name[k]
    where = f" near {area}" if area else ""
    return {"status": "needs_pin", "street": name, "street_eids": sorted(int(e) for e in eids),
            "street_length_km": round(km, 2), "type": f["type"], "impact": int(f["impact"]),
            "radius_m": clamp_radius(f.get("radius_m"), f["type"]), "parser": parser,
            "sitrep_text": text.strip(),
            "description": f.get("description") or f"Parsed from SITREP: \"{text.strip()[:200]}\"",
            "message": f"SITREP names {name}{where} ({km:.1f} km) but no exact point"
                       f"{' (' + note + ')' if note else ''}. Click the highlighted road to pin the threat."}
