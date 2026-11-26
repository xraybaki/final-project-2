# DECISIONS.md: assumptions and choices

## Environment and data
1. **OSM download was blocked in the build sandbox.** overpass-api.de, two public Overpass
   mirrors and Geofabrik all reset the connection through the cloud sandbox's egress proxy
   (other hosts, such as unpkg and Esri tiles, worked). As CLAUDE.md §3 specifies, the
   pipeline therefore fell back to the **Toronto** street extract in `legacy_toronto/`, and
   **the committed `routing_graph.json` / screenshots / metrics are Toronto**, labelled
   "Toronto (FALLBACK)" in the UI. The Dehradun path is fully implemented: on any machine with
   normal internet, `python -m pipeline.run_all` downloads Dehradun and rebuilds everything.
   **Before the presentation, run it once on a laptop and commit the regenerated outputs.**
2. Region kept as **Dehradun, Uttarakhand** (no team report or slides naming another area were
   available). Centre 30.3165, 78.0322, radius 12 km, `network_type="drive"`.
3. The Toronto fallback keeps only drivable OSM classes (motorway…service) and splits ways at
   shared vertices to form intersections.
4. The graph is restricted to its **largest connected component**, so any two clicked points are routable.
5. Parallel edges are collapsed to the shortest one in the undirected graph. One-way
   restrictions are ignored (convoys can be escorted against flow; this keeps the graph simple).
6. Original Toronto data and scripts moved to `legacy_toronto/` (nothing deleted). The
   original README is `legacy_toronto/README_original.md`. `test.ipynb` was left untouched.

## Synthetic data (M2)
7. The incident count scales with the network size (about 4 per 100 edges, clipped to
   500–3000). With a fixed 2,400 incidents the small Toronto area produced 73% positive
   labels, which made the task trivial.
8. 10 hotspots: 6 persistent, 2 *fading* (months 1–15) and 2 *emerging* (months 13–24), plus
   38% background incidents driven only by road factors. This makes the future only partly
   predictable from the past, so road features matter and the model can beat the baseline.
9. "Hill sections" are proxied by curviness, because no elevation data is used. "Dense
   settlement" is proxied by graph-node density within 500 m.
10. The hidden propensity used to *generate* data includes betweenness, bridge, unpaved,
    narrow, curviness and density. The model sees related but not identical features. This
    circularity is a known limitation of synthetic data (stated in the README).
11. The timeline is Nov 2024 to Oct 2026 (24 months). Hostile types are 65% at night; landslides
    are weighted 5× in Jul–Sep. Severity ranges per type are listed in `synthetic_threats.py`.
12. Live threats: 5 reports on named major roads near recent activity, at least 1.2 km apart.
    IED (92) and landslide (94) are hard blocks. All descriptions are generic and marked fictional.

## Model (M3)
13. Label: any incident from months 19–24 within **150 m** of the edge. Features come only from
    months 1–18, so there is no leakage.
14. XGBoost (400 trees, depth 5, lr 0.05, `scale_pos_weight` = neg/pos). Probabilities are
    prior-corrected back to the true base rate after class weighting. Fallback order:
    xgboost → HistGradientBoosting → RandomForest, chosen automatically.
15. Threshold = F1-optimal on validation (for the reported precision, recall and confusion matrix).
16. **Added spatial-block CV** (1.5 km grid cells, GroupKFold × 5) because the random split
    is optimistic (0.955 vs 0.68). Both are reported; the spatial number is the honest one.
17. "Retrain on all 24 months" means: refit on the full labelled set (which uses all 24
    months), then score features from the **latest 18-month window (months 7–24)**, so the
    feature scales match training.
18. Expected-severity factor = 0.5 + 0.5 × (mean severity within 500 m, shrunk towards the
    global mean with k = 5) / 100.
19. `weight = clip(100 × risk / q99(risk), 0, 100)`. This gives about 10% of edges ≥ 60 (high risk).
20. Per-traversal probability `p_traverse = 1 − exp(−λ·12 h)`, with λ derived from the
    6-month probability (Poisson). Using the raw 6-month probability in
    `P = 1 − Π(1 − p_i)` would give ≈ 100% for every route.
21. OSM building and POI density skipped: it needs a second, large Overpass query.
    Node density is used instead.

## Routing and UI (M5/M6)
22. Fastest = λ = 0 on length. At a constant convoy speed of 30 km/h, minimum time equals
    minimum distance. OSM `travel_time` is kept in the data but not used for convoy ETA.
23. Threat penalty: `w' = max(w, impact) × (1 + 3·impact/100)`. A purely multiplicative
    penalty barely moves low-risk roads (2 × 4 = 8), so the max() term lifts any zone edge to
    at least the impact level. No cap (this fixes the original 84-cap bug).
24. Zone membership is measured as distance to the **edge polyline**, not just the midpoint,
    so long hill-road edges are caught. Impacts are precomputed once per threat change
    (an eid → impact map), not on every A* expansion.
25. The probability on an edge inside a zone is `1 − (1−p)(1 − 0.5·impact/100)`. Hard-blocked
    edges are never traversed.
26. Fastest ignores soft threats (it is pure time) but respects hard blocks.
27. Re-route message: the previous safest route is re-evaluated under the new threats and
    compared with the new safest route (Δkm and Δrisk %, or "previous route BLOCKED").
28. **Basemap switched from CARTO to Esri Dark Gray**: CARTO tiles now show an
    "API KEY REQUIRED" watermark without a key. A layer switcher offers Esri satellite, OSM
    and CARTO as alternatives.
29. Routes are drawn along real edge geometry (from `routing_edges.geojson`, indexed by `eid`).
30. SITREP parser: Gemini is used for field extraction only (it does not invent coordinates).
    Location is always resolved offline against OSM street names (prefers bridge segments
    if "bridge" is mentioned; supports "N km north of" offsets and literal "lat, lon").
    Without a key, or on any error, the rule-based parser is used.
31. `/chat` and `chat.html` still point to the original Toronto assistant
    (`legacy_toronto/gemini_api.py`). It is not part of the convoy demo.
32. Added fields to the graph schema: top-level `meta`; per edge `eid`, `risk_prob`,
    `p_traverse`, `chokepoint`, `travel_time_s`, `bridge`, `tunnel`, `category`, `features`.
    No existing field was renamed or removed.

---

## Summary

### What works
* `python -m pipeline.run_all`: M1 → M4 in about 100 s (Toronto fallback, 9.5k nodes / 12k edges).
* ML risk map, three routes in ~10–25 ms (well under 1 s), comparison table with all convoy metrics, λ slider.
* Threat reporting by map click (type + impact slider), intel feed, and SITREP text. 300 m
  zones, hard blocks never crossed, automatic re-route with Δkm / Δrisk banner.
* Convoy animation showing live segment risk.
* `pytest -q`: 7 tests pass (schema, string keys, weights 0–100, no NaN, model > baseline in
  both random and spatial CV, synthetic labels, JS A* fixture). `npm test` runs the A* check.

### Stubbed / not done
* The Dehradun graph was not built in the sandbox (network block; see #1). Code path is ready.
* Gemini path untested (no key in the sandbox). The rule-based fallback is tested.
* No OSM building/POI density, no elevation.

### Demo script (committed Toronto build)
1. `node server.js`, then open http://localhost:3000. The ML risk map loads (green / yellow / orange / red).
   Click a red segment to show the model probability, road type and chokepoint flag.
2. Click **Plan Convoy Route**. Click **A** near **43.6348, −79.4248** (west waterfront) and
   **B** near **43.6586, −79.3756** (downtown east).
   *Audience sees:* Fastest (blue) cuts straight through a red hotspot band, at about 17%
   route incident probability and 3.9 min high-risk exposure. Safest (green) follows the
   waterfront: +1.7 km, about 3.8%, 0.1 min exposure.
3. Click **Report Threat**, choose **IED** (impact 92 = road closed), and click on the green
   route on the waterfront near **43.6394, −79.3876**.
   *Audience sees:* a magenta closed zone, and the banner "🔀 Re-routed: previous route
   BLOCKED · +1.2 km". The new safest route goes round it.
4. Drag the **λ slider** to show the Balanced route moving between fastest and safest.
5. Click **Fetch Intel Reports**: 5 synthetic reports pop up, the zones appear and the route updates.
6. Type a SITREP: `Stone pelting mob reported on Queen Street West` and click **Parse & add
   threat**. A threat appears on that street.
7. Click **Animate Convoy** to watch the convoy and its live segment-risk readout.

### Demo script (after rebuilding on Dehradun)
Use the same steps with A at the Clock Tower area (~30.3245, 78.0418) and B up Rajpur Road
towards Mussoorie (~30.385, 78.080). Then use the SITREP
`Suspected IED reported near the bridge on Rajpur Road`. Re-check the exact clicks after the rebuild.
