"""
Landmark gazetteer for SITREP location resolution (M9).

Extracts named OSM features inside the operating box (bridges, chowks / squares, named
junctions, police stations, hospitals, markets, religious sites, schools, stations,
tourism / historic sites, neighbourhoods) and writes data/landmarks.json as
    [{"name", "lat", "lon", "kind"}]

Source, in order: the cached regional .osm.pbf extract (same one build_graph uses), else the
Overpass API via OSMnx. Named bridge segments of the road graph are always added.
"""
from __future__ import annotations

import json
import math
import re

from . import config as C

# OSM tag -> landmark kind
AMENITY_KIND = {
    "police": "police", "hospital": "hospital", "clinic": "hospital", "doctors": "hospital",
    "fire_station": "fire_station", "marketplace": "market", "place_of_worship": "religious",
    "school": "school", "college": "school", "university": "school", "bus_station": "station",
    "post_office": "public", "townhall": "public", "courthouse": "public", "fuel": "fuel",
    "bank": "public", "library": "public", "stadium": "public", "community_centre": "public",
}
PLACE_KIND = {"square": "square", "neighbourhood": "area", "suburb": "area", "quarter": "area",
              "locality": "area", "village": "area", "hamlet": "area", "town": "area"}
AREA_KINDS = {"area"}   # big areas: a name alone is NOT a precise location
ROADLIKE = re.compile(r"\b(road|rd|street|st|marg|lane|bypass|highway|link)\s*$", re.I)


def _kind(tags) -> str | None:
    g = tags.get
    if g("bridge") in ("yes", "viaduct") or g("man_made") == "bridge":
        return "bridge"
    if g("highway") in ("motorway_junction", "junction") or g("junction"):
        return "junction"
    if g("place") in PLACE_KIND:
        return PLACE_KIND[g("place")]
    if g("amenity") in AMENITY_KIND:
        return AMENITY_KIND[g("amenity")]
    if g("healthcare"):
        return "hospital"
    if g("railway") in ("station", "halt"):
        return "station"
    if g("aeroway") in ("aerodrome", "terminal"):
        return "airport"
    if g("historic") or g("tourism") in ("attraction", "museum", "viewpoint", "hotel"):
        return "landmark"
    if g("leisure") in ("park", "garden", "stadium"):
        return "park"
    if g("highway") == "bus_stop":
        return "bus_stop"
    return None


def _in_box(lat, lon, box):
    s, w, n, e = box
    return s <= lat <= n and w <= lon <= e


def _from_pbf(pbf, box):
    import osmium

    out = []

    class H(osmium.SimpleHandler):
        def node(self, nd):
            name = nd.tags.get("name")
            if not name or not nd.location.valid():
                return
            k = _kind(nd.tags)
            if k and _in_box(nd.location.lat, nd.location.lon, box):
                out.append({"name": name, "lat": nd.location.lat, "lon": nd.location.lon, "kind": k})

        def way(self, wy):
            name = wy.tags.get("name")
            if not name:
                return
            k = _kind(wy.tags)
            if not k:
                return
            try:
                pts = [(x.lat, x.lon) for x in wy.nodes if x.location.valid()]
            except Exception:  # noqa: BLE001 - missing node locations at extract edges
                return
            if not pts:
                return
            lat = sum(p[0] for p in pts) / len(pts)
            lon = sum(p[1] for p in pts) / len(pts)
            if _in_box(lat, lon, box):
                out.append({"name": name, "lat": lat, "lon": lon, "kind": k})

    H().apply_file(str(pbf), locations=True)
    return out


def _from_overpass(box):
    import osmnx as ox

    s, w, n, e = box
    tags = {"amenity": list(AMENITY_KIND), "place": list(PLACE_KIND), "bridge": "yes",
            "highway": ["motorway_junction", "bus_stop"], "railway": ["station", "halt"],
            "historic": True, "tourism": ["attraction", "museum", "viewpoint", "hotel"]}
    gdf = ox.features_from_bbox((w, s, e, n), tags)
    out = []
    for _, row in gdf.iterrows():
        name = row.get("name")
        if not isinstance(name, str):
            continue
        k = _kind({kk: row.get(kk) for kk in ("bridge", "man_made", "highway", "junction", "place",
                                               "amenity", "healthcare", "railway", "aeroway",
                                               "historic", "tourism", "leisure")
                   if isinstance(row.get(kk), str)})
        if k:
            c = row.geometry.centroid
            out.append({"name": name, "lat": c.y, "lon": c.x, "kind": k})
    return out


def _dedupe(items):
    """Merge same-name features within 250 m (e.g. a bridge split into several OSM ways)."""
    kept = []
    for it in sorted(items, key=lambda x: (x["name"].lower(), x["kind"])):
        for k in kept:
            if k["name"].lower() == it["name"].lower():
                d = math.hypot((k["lat"] - it["lat"]) * 110540,
                               (k["lon"] - it["lon"]) * 111320 * math.cos(math.radians(it["lat"])))
                if d < 250:
                    break
        else:
            kept.append(it)
    return kept


def build_landmarks(G, box) -> list[dict]:
    items = []
    url = getattr(C, "OSM_EXTRACT_URL", None)
    pbf = C.CACHE_DIR / url.rsplit("/", 1)[-1] if url else None
    try:
        if pbf and pbf.exists():
            items = _from_pbf(pbf, box)
            src = pbf.name
        else:
            items = _from_overpass(box)
            src = "Overpass"
    except Exception as exc:  # noqa: BLE001 - landmarks are optional; graph bridges still added
        print(f"  [LM] landmark extraction failed ({type(exc).__name__}: {str(exc)[:120]})")
        src = "none"

    # named bridge segments in the road graph (e.g. 'Nawa Kadal', 'Habba Kadal Bridge')
    for u, v, d in G.edges(data=True):
        name = d.get("street_name", "")
        if d.get("bridge") and name and name != "Unnamed road" and not ROADLIKE.search(name):
            items.append({"name": name, "lat": (G.nodes[u]["lat"] + G.nodes[v]["lat"]) / 2,
                          "lon": (G.nodes[u]["lon"] + G.nodes[v]["lon"]) / 2, "kind": "bridge"})

    items = [i for i in items if len(i["name"].strip()) >= 3 and not ROADLIKE.search(i["name"].strip())]
    items = _dedupe(items)
    for i in items:
        i["lat"], i["lon"] = round(i["lat"], 6), round(i["lon"], 6)
    C.LANDMARKS_JSON.write_text(json.dumps(items, ensure_ascii=False, indent=0), encoding="utf-8")
    kinds = {}
    for i in items:
        kinds[i["kind"]] = kinds.get(i["kind"], 0) + 1
    print(f"  [LM] {len(items):,} landmarks ({src} + graph bridges) -> "
          f"{C.LANDMARKS_JSON.relative_to(C.ROOT)} {dict(sorted(kinds.items(), key=lambda t: -t[1]))}")
    return items
