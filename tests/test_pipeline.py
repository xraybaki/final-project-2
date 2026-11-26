"""Pipeline output checks. Run `python -m pipeline.run_all` first, then `pytest -q`."""
import json
import math
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def graph():
    return json.loads((ROOT / "routing_graph.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def metrics():
    return json.loads((ROOT / "reports" / "metrics.json").read_text(encoding="utf-8"))


def test_schema(graph):
    assert {"nodes", "edges", "adjacency_list"} <= graph.keys()
    n = graph["nodes"][0]
    assert {"id", "lat", "lon", "weight"} <= n.keys()
    e = graph["edges"][0]
    for k in ("source", "target", "weight", "length_m", "street_name", "highway_type",
              "start_node_weight", "end_node_weight", "risk_prob", "chokepoint", "travel_time_s"):
        assert k in e, k
    a = next(iter(graph["adjacency_list"].values()))[0]
    assert {"target", "weight", "length_m"} <= a.keys()


def test_adjacency_keys_are_strings(graph):
    assert all(isinstance(k, str) for k in graph["adjacency_list"])
    assert set(graph["adjacency_list"]) == {str(n["id"]) for n in graph["nodes"]}


def test_weights_in_range_no_nans(graph):
    for e in graph["edges"]:
        for k in ("weight", "length_m", "risk_prob", "travel_time_s"):
            assert not math.isnan(e[k]), (k, e)
        assert 0 <= e["weight"] <= 100
        assert 0 <= e["risk_prob"] <= 1
        assert e["length_m"] > 0
    for n in graph["nodes"]:
        assert 0 <= n["weight"] <= 100 and not math.isnan(n["lat"])


def test_geojson_matches_graph(graph):
    gj = json.loads((ROOT / "routing_edges.geojson").read_text(encoding="utf-8"))
    assert len(gj["features"]) == len(graph["edges"])
    assert gj["features"][0]["geometry"]["type"] == "LineString"


def test_model_beats_baseline(metrics):
    assert metrics["model_metrics"]["roc_auc"] > metrics["baseline_metrics"]["roc_auc"]
    assert metrics["model_metrics"]["pr_auc"] > metrics["baseline_metrics"]["pr_auc"]
    cv = metrics["spatial_block_cv"]
    assert cv["model_roc_auc_mean"] > cv["baseline_roc_auc_mean"]


def test_synthetic_label():
    inc = (ROOT / "data" / "incidents.csv").read_text(encoding="utf-8").splitlines()
    assert "data_label" in inc[0] and "SYNTHETIC" in inc[1]
    live = json.loads((ROOT / "data" / "live_threats.json").read_text(encoding="utf-8"))
    assert "SYNTHETIC" in live["source"] and 4 <= len(live["events"]) <= 6
    for ev in live["events"]:
        assert {"lat", "lon", "type", "impact", "location", "description"} <= ev.keys()


def test_js_suite():
    out = subprocess.run(["node", str(ROOT / "tests" / "run_js_tests.js")], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr
