"""SITREP location resolver (M9). Requires routing_edges.geojson + data/landmarks.json (run_all)."""
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sitrep_resolver as R  # noqa: E402


@pytest.fixture(scope="module")
def geo():
    return R.load_geo()


def _dist_m(geo, lat1, lon1, lat2, lon2):
    a, b = geo.xy(lat1, lon1), geo.xy(lat2, lon2)
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _on_street(geo, lat, lon, street, tol=2.0):
    p = geo.xy(lat, lon)
    k = R.key_for(street, R.GENERIC_STREET)
    return min(geo.project(e, p)[0] for e in geo.streets[k]) <= tol


def test_road_only_needs_pin(geo):
    r = R.resolve("IED on Nalahmar Road", geo=geo)
    assert r["status"] == "needs_pin"
    assert r["street"] == "Nalahmar Road" and r["street_eids"]
    assert r["type"] == "IED" and r["radius_m"] == 100 and "lat" not in r


def test_junction_lands_on_both_streets(geo):
    r = R.resolve("IED at junction of Nalahmar Road and Maharaj Ganj Road", geo=geo)
    assert r["status"] == "ok" and r["resolution"] == "junction"
    # OSM has a 67 m unnamed link between the two roads: point is on one, within 120 m of the other
    assert _on_street(geo, r["lat"], r["lon"], "Nalahmar Road", tol=125) and \
        _on_street(geo, r["lat"], r["lon"], "Maharaj Ganj Road", tol=125)


def test_junction_shared_node_exact(geo):
    # pick two streets that genuinely share a node and check the resolver returns that node
    k1 = R.key_for("Residency Road", R.GENERIC_STREET)
    n1 = {geo.edges[e][s] for e in geo.streets[k1] for s in "st"}
    for k2, eids in geo.streets.items():
        if k2 == k1 or k2 in geo.bridge_streets:
            continue
        if n1 & {geo.edges[e][s] for e in eids for s in "st"}:
            break
    r = R.resolve(f"Blockade at junction of {geo.street_name[k1]} and {geo.street_name[k2]}", geo=geo)
    assert r["status"] == "ok" and r["confidence"] == "high"
    assert _on_street(geo, r["lat"], r["lon"], geo.street_name[k1], 0.5)
    assert _on_street(geo, r["lat"], r["lon"], geo.street_name[k2], 0.5)


def test_landmark_within_150m(geo):
    lm = next(l for l in geo.landmarks if l["name"] == "Lal Chowk")
    r = R.resolve("Road blockade near Lal Chowk", geo=geo)
    assert r["status"] == "ok" and r["resolution"] == "landmark"
    assert _dist_m(geo, r["lat"], r["lon"], lm["lat"], lm["lon"]) <= 150


def test_coordinates_exact(geo):
    r = R.resolve("Protest at 34.0812, 74.7956", geo=geo)
    assert r["status"] == "ok" and r["resolution"] == "coordinates" and r["confidence"] == "high"
    assert (r["lat"], r["lon"]) == (34.0812, 74.7956)


def test_dms_and_mgrs(geo):
    r = R.resolve("Landslide at 34°05'01\"N 74°47'50\"E", geo=geo)
    assert abs(r["lat"] - (34 + 5 / 60 + 1 / 3600)) < 1e-5 and abs(r["lon"] - (74 + 47 / 60 + 50 / 3600)) < 1e-5
    for lat, lon in [(34.0837, 74.7973), (34.12, 74.85), (-33.86, 151.2), (51.5, -0.12)]:
        back = R.mgrs_to_latlon(R.latlon_to_mgrs(lat, lon))
        assert abs(back[0] - lat) < 2e-5 and abs(back[1] - lon) < 2e-5
    m = R.latlon_to_mgrs(34.0837, 74.7973)
    r = R.resolve(f"Accident at {m}", geo=geo)
    assert r["resolution"] == "coordinates" and _dist_m(geo, r["lat"], r["lon"], 34.0837, 74.7973) < 3


def test_landmark_offset_walks_along_road(geo):
    r = R.resolve("Ambush risk 300 m east of Nawa Kadal on Nalahmar Road", geo=geo)
    assert r["status"] == "ok" and r["resolution"] == "landmark+offset"
    assert _on_street(geo, r["lat"], r["lon"], "Nalahmar Road", tol=1.0)   # on the road geometry
    lm = next(l for l in geo.landmarks if l["name"] == "Nawa Kadal")
    # 300 m walked along the road from the landmark's snap point (bridge is ~50 m off the road)
    assert 150 < _dist_m(geo, r["lat"], r["lon"], lm["lat"], lm["lon"]) <= 400


def test_landmark_offset_north(geo):
    r = R.resolve("Stone pelting 200 m north of Lal Chowk on Residency Road", geo=geo)
    assert r["status"] == "ok" and _on_street(geo, r["lat"], r["lon"], "Residency Road", tol=1.0)


def test_nothing_matched(geo):
    r = R.resolve("Something happened somewhere", geo=geo)
    assert r["status"] == "error" and "Accepted location formats" in r["message"]


def test_type_defaults_from_shared_table(geo):
    r = R.resolve("Accident near Lal Chowk", geo=geo)
    assert r["radius_m"] == R.THREAT_TYPES["accident"]["radius_m"] == 30
    assert r["impact"] == R.THREAT_TYPES["accident"]["impact"]
