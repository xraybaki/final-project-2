"""
Road network.

Downloads the drivable OSM road network around config.CENTER with OSMnx (cached to
data/cache/graph.graphml), converts it to an undirected simple graph with consecutive
integer node ids and normalised edge attributes.

Sources, in order: the Overpass API, then the regional .osm.pbf extract configured in
config.OSM_EXTRACT_URL (clipped to the operating box). After the first run everything is
read from the cache, so the pipeline works offline.
"""
from __future__ import annotations

import math

import networkx as nx

from . import config as C

UNPAVED = {"unpaved", "gravel", "dirt", "earth", "ground", "sand", "mud", "grass",
           "compacted", "fine_gravel", "pebblestone", "rock"}


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _first(v):
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    if isinstance(v, str) and v.startswith("[") and v.endswith("]"):
        # graphml round-trip stores lists as strings like "['primary', 'secondary']"
        inner = v[1:-1].split(",")[0].strip().strip("'\"")
        return inner or None
    return v


def _to_float(v, default=None):
    v = _first(v)
    if v is None:
        return default
    try:
        s = str(v).lower().replace("km/h", "").replace("kmh", "").replace("mph", "").strip()
        s = s.split(";")[0].split("|")[0]
        return float(s)
    except (TypeError, ValueError):
        return default


def _to_bool(v):
    v = _first(v)
    if v is None:
        return False
    return str(v).lower() not in ("no", "false", "0", "nan", "none", "")


# OSMnx "drive" network filter, applied by hand when reading a .pbf extract
_DRIVE_EXCLUDE = {"abandoned", "bridleway", "bus_guideway", "construction", "corridor", "cycleway",
                  "elevator", "escalator", "footway", "no", "path", "pedestrian", "planned",
                  "platform", "proposed", "raceway", "razed", "service", "steps", "track"}
_SERVICE_EXCLUDE = {"alley", "driveway", "emergency_access", "parking", "parking_aisle", "private"}


def _is_drive_way(tags) -> bool:
    hw = tags.get("highway")
    return bool(hw) and hw not in _DRIVE_EXCLUDE and tags.get("area") != "yes" \
        and tags.get("access") != "private" and tags.get("motor_vehicle") != "no" \
        and tags.get("motorcar") != "no" and tags.get("service") not in _SERVICE_EXCLUDE


def _bbox():
    lat, lon = C.CENTER
    dlat = C.RADIUS_M / 110_540.0
    dlon = C.RADIUS_M / (111_320.0 * math.cos(math.radians(lat)))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon  # south, west, north, east


def _extract_to_osm_xml(pbf_path, xml_path):
    """Clip a regional .osm.pbf to the operating box, keeping drivable ways (+ their nodes)."""
    import osmium

    s, w, n, e = _bbox()
    keep_ways, need_nodes = set(), set()

    class WayPass(osmium.SimpleHandler):
        def way(self, way):
            if not _is_drive_way(way.tags):
                return
            refs = [nd.ref for nd in way.nodes]
            inside = any(nd.location.valid() and s <= nd.lat <= n and w <= nd.lon <= e
                         for nd in way.nodes)
            if inside:
                keep_ways.add(way.id)
                need_nodes.update(refs)

    WayPass().apply_file(str(pbf_path), locations=True)
    if not keep_ways:
        raise RuntimeError(f"extract {pbf_path.name} has no drivable roads inside {C.REGION_NAME} box")

    if xml_path.exists():
        xml_path.unlink()
    writer = osmium.SimpleWriter(str(xml_path))

    class WritePass(osmium.SimpleHandler):
        def node(self, node):
            if node.id in need_nodes:
                writer.add_node(node)

        def way(self, way):
            if way.id in keep_ways:
                writer.add_way(way)

    WritePass().apply_file(str(pbf_path))
    writer.close()
    print(f"  [graph] clipped extract: {len(keep_ways):,} drivable ways, {len(need_nodes):,} nodes")


def _graph_from_extract(ox):
    import urllib.request

    url = C.OSM_EXTRACT_URL
    pbf = C.CACHE_DIR / url.rsplit("/", 1)[-1]
    if not pbf.exists():
        print(f"  [graph] downloading regional OSM extract {url} ...")
        tmp = pbf.with_suffix(".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(pbf)
    xml = C.CACHE_DIR / "region_clip.osm"
    _extract_to_osm_xml(pbf, xml)
    G = ox.graph_from_xml(xml, bidirectional=False, simplify=True, retain_all=False)
    s, w, n, e = _bbox()
    G = ox.truncate.truncate_graph_bbox(G, (w, s, e, n))
    G.graph["source"] = f"OpenStreetMap extract ({url.rsplit('/', 1)[-1]})"
    return G


# --------------------------------------------------------------------------- OSMnx path
def _download_osm():
    import osmnx as ox

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(C.CACHE_DIR / "osmnx_http")
    ox.settings.requests_timeout = 180
    ox.settings.log_console = False
    if "surface" not in ox.settings.useful_tags_way:
        ox.settings.useful_tags_way = list(ox.settings.useful_tags_way) + ["surface"]

    if C.GRAPHML_CACHE.exists():
        print(f"  [graph] using cached graph {C.GRAPHML_CACHE.relative_to(C.ROOT)}")
        return ox.load_graphml(C.GRAPHML_CACHE)

    print(f"  [graph] downloading OSM '{C.NETWORK_TYPE}' network: {C.REGION_NAME} "
          f"centre={C.CENTER} r={C.RADIUS_M} m ...")
    try:
        G = ox.graph_from_point(C.CENTER, dist=C.RADIUS_M, network_type=C.NETWORK_TYPE,
                                simplify=True)
        G.graph["source"] = "OpenStreetMap via OSMnx (Overpass API)"
    except Exception as exc:  # noqa: BLE001
        if not getattr(C, "OSM_EXTRACT_URL", None):
            raise
        print(f"  [graph] Overpass failed ({type(exc).__name__}) - trying regional extract instead")
        G = _graph_from_extract(ox)
    G = ox.add_edge_speeds(G)
    G = ox.add_edge_travel_times(G)
    ox.save_graphml(G, C.GRAPHML_CACHE)
    print(f"  [graph] cached to {C.GRAPHML_CACHE.relative_to(C.ROOT)}")
    return G


def _osmnx_to_simple(Gm) -> nx.Graph:
    """MultiDiGraph (osmnx) -> undirected simple Graph with normalised attributes."""
    H = nx.Graph()
    for n, d in Gm.nodes(data=True):
        H.add_node(n, lat=float(d["y"]), lon=float(d["x"]))

    for u, v, d in Gm.edges(data=True):
        if u == v:
            continue
        length = float(d.get("length", 0) or 0)
        if length <= 0:
            length = haversine_m(H.nodes[u]["lat"], H.nodes[u]["lon"],
                                 H.nodes[v]["lat"], H.nodes[v]["lon"])
        if H.has_edge(u, v) and H.edges[u, v]["length_m"] <= length:
            continue  # keep the shortest parallel edge
        geom = d.get("geometry")
        if geom is not None and hasattr(geom, "coords"):
            coords = [(float(x), float(y)) for x, y in geom.coords]
        else:
            coords = [(H.nodes[u]["lon"], H.nodes[u]["lat"]), (H.nodes[v]["lon"], H.nodes[v]["lat"])]
        speed = _to_float(d.get("speed_kph"), None)
        tt = _to_float(d.get("travel_time"), None)
        H.add_edge(
            u, v,
            length_m=length,
            highway_type=str(_first(d.get("highway")) or "unclassified"),
            street_name=str(_first(d.get("name")) or "Unnamed road"),
            lanes=_to_float(d.get("lanes"), None),
            maxspeed=_to_float(d.get("maxspeed"), None),
            speed_kph=speed,
            travel_time_s=tt if tt is not None else length / ((speed or 30) / 3.6),
            bridge=_to_bool(d.get("bridge")),
            tunnel=_to_bool(d.get("tunnel")),
            surface=str(_first(d.get("surface")) or "unknown"),
            geometry=coords,
        )
    return H


# --------------------------------------------------------------------------- public API
def build_graph() -> tuple[nx.Graph, dict]:
    """Return (G, region) where G is an undirected nx.Graph with int nodes 0..N-1."""
    try:
        Gm = _download_osm()
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            f"  [graph] Could not get the OSM road network for {C.REGION_NAME}: {type(exc).__name__}: {str(exc)[:200]}\n"
            f"       Check the internet connection, or download {C.OSM_EXTRACT_URL} manually into {C.CACHE_DIR}.")
    H = _osmnx_to_simple(Gm)
    region = {"name": C.REGION_NAME, "center": list(C.CENTER), "radius_m": C.RADIUS_M,
              "source": Gm.graph.get("source", "OpenStreetMap via OSMnx")}

    # keep largest connected component so every pair of nodes is routable
    largest = max(nx.connected_components(H), key=len)
    dropped = H.number_of_nodes() - len(largest)
    H = H.subgraph(largest).copy()
    H = nx.convert_node_labels_to_integers(H, ordering="sorted", label_attribute="osmid")

    lats = [d["lat"] for _, d in H.nodes(data=True)]
    lons = [d["lon"] for _, d in H.nodes(data=True)]
    region["bounds"] = [[min(lats), min(lons)], [max(lats), max(lons)]]
    print(f"  [graph] graph: {H.number_of_nodes():,} nodes, {H.number_of_edges():,} edges "
          f"(dropped {dropped} nodes outside largest component)")
    return H, region


if __name__ == "__main__":
    build_graph()
