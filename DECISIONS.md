# DECISIONS.md: assumptions and choices

## Environment and data
1. **Region: Srinagar, Jammu & Kashmir** (changed from the original Dehradun default at the
   team's request). Centre 34.0837, 74.7973 (city centre), 12 km half-width box,
   `network_type="drive"`. The Dehradun settings are kept as a comment in `config.py`.
2. **OSM source.** The Overpass API (and two mirrors, and Geofabrik) were unreachable from the
   build sandbox, so I added a second download path: the openstreetmap.fr
   `jammu_and_kashmir-latest.osm.pbf` extract (27 MB). It is clipped to the box with `osmium`
   (pip `osmium`), filtered with OSMnx's own "drive" rules (no service roads, tracks, footways
   or private access), and loaded with `ox.graph_from_xml` → simplify → bbox truncate. On a
   normal connection the Overpass path is tried first. Both produce the same OSMnx graph type.
   The `.pbf` and the clipped `.osm` live in `data/cache/` (git-ignored).
3. The Toronto fallback (used only if both OSM sources fail) keeps only drivable OSM classes (motorway…service) and splits ways at
   shared vertices to form intersections.
4. The graph is restricted to its **largest connected component**, so any two clicked points are routable.
5. Parallel edges are collapsed to the shortest one in the undirected graph. One-way
   restrictions are ignored (convoys can be escorted against flow; this keeps the graph simple).
6. Original Toronto data and scripts moved to `legacy_toronto/` (nothing deleted). The
   original README is `legacy_toronto/README_original.md`. `test.ipynb` was left untouched.

## Synthetic data (M2)
6b. Live threats and SITREP examples use real Srinagar street names (e.g. Fore Shore Road,
    Boulevard Road) so the demo is concrete. The *events* are invented, generic, and labelled
    "SYNTHETIC / fictional training scenario" in the data, the popups and the UI footer.
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

## M9: precise point threats + SITREP resolver
33. **Windows UTF-8 fix:** every `open` / `read_text` / `write_text` / `to_csv` in `pipeline/`,
    `gemini_api.py` and the tests passes `encoding="utf-8"` (the CSV also `newline=""`). The server
    spawns Python with `PYTHONIOENCODING=utf-8` and reads/writes stdin/stdout as UTF-8.
34. **One table for threat defaults:** `threat_types.json` (impact, radius, TTL, labels) is read by
    the frontend, `sitrep_resolver.py`, the server and `pipeline/config.py`
    (`THREAT_DEFAULT_RADIUS_M`). The global 300 m radius is gone. Defaults: IED 92 / 100 m,
    ambush 80 / 150 m, stone pelting 60 / 100 m, blockade 70 / 50 m, landslide 95 / 50 m,
    accident 45 / 30 m. Radius slider is 25–500 m in steps of 25. The drawn circle and the
    routing radius are the same value (`threat.radius_m`).
35. **Fractional soft penalty:** `f_in` = length of the edge inside the circle ÷ edge length
    (exact circle–segment intersection in local metres). `w_eff = w(1 − f_in) + w_threat·f_in`,
    with `w_threat = max(w, impact)·(1 + 3·impact/100)`. Overlapping threats: highest impact first,
    fractions capped at 1 in total. Probability: `1 − (1−p)·Π(1 − 0.5·impact/100·f_in)`.
    **Hard block** (impact ≥ 90): any intersection closes the whole edge, because a convoy must
    drive the link end to end between two junctions.
36. **Display:** only the clipped part of each road inside a circle is painted (thick red, or
    magenta for closed). Hard-blocked links also get a thin dashed full-length line so the
    operator can see which junction-to-junction link is shut.
37. **Snapping:** map clicks and drags project perpendicularly onto the nearest road within
    150 m, using a 250 m spatial grid over edge geometries (no full scan of 29k edges). A
    dashed line shows the snap when it is more than 10 m. Beyond 150 m the operator must
    confirm an off-road threat (confidence "low").
38. **Landmark gazetteer** (`pipeline/landmarks.py` → `data/landmarks.json`, 1,806 entries): named
    OSM nodes and ways (bridges, junctions, squares, police, hospitals, markets, religious
    sites, schools, stations, tourism / historic, neighbourhoods) from the same PBF / Overpass
    source, plus named bridge segments of the road graph. Names ending in Road / Street /
    Marg / Bypass are excluded (they are roads, not points). Same-name features within 250 m
    are merged.
39. **Resolver order** (`sitrep_resolver.py`): coordinates (decimal, DMS, **MGRS**: implemented
    with a dependency-free UTM conversion and tested by round-trip) → junction of two named
    roads → landmark (+ offset walked **along road geometry**, choosing at each junction the
    branch best aligned with the stated direction) → road only = `needs_pin` → error listing
    accepted formats.
40. **Junction tolerance:** if two named roads share no node, the nearest node pair within
    120 m is used at *medium* confidence. OSM often has a short unnamed link at a real junction
    (for example Nalahmar Rd / Maharaj Ganj Rd are joined by a 67 m unnamed segment).
41. **Never guess:** a road name alone, or an area name (suburb / neighbourhood) alone, never
    produces a point. Area + road highlights only the part of the road within 1.2 km of the
    area. Ambiguous landmark names (the same name more than 500 m apart) return an error
    listing the candidates, unless a named road disambiguates them.
42. **Gemini** only extracts fields (type, impact, radius, street, junction_with, landmark,
    offset, direction). The offline gazetteer always resolves the location, and AI coordinates
    are ignored.
43. Named bridges stored as road segments (for example "Nawa Kadal") are treated as landmarks,
    not as roads, so "near Nawa Kadal" resolves to a point instead of asking for a pin.
44. Threat ids look like `THR-YYYYMMDD-HHMMSS-nnn` (client-generated until M11 adds the server store).

## M10: UI shell and design system
45. **Layout:** a left sidebar (64 px icon rail + 380 px panel) sits *beside* the map, not over
    it, so the map is 0% covered by default. The panel collapses to the rail. Below 1100 px
    the sidebar becomes an overlay drawer. The info panel became a slim header chip
    (click to expand); the legend is a collapsible chip.
46. **No new dependencies:** inline SVG sprite (Lucide-style paths) instead of an icon font;
    system font stack with Inter if installed (no web-font download); tabular numerals
    for all numbers.
47. **Design tokens** in `:root` (`--bg … --closed`, route colours, 8 px spacing, 6/10/12 px
    radii). `index.html` has no `style=` attributes. `app.js` HTML strings use classes. The
    one remaining JS style write is the convoy arrow rotation, set per frame.
48. **Smoothness:** 180 ms transitions, disabled under `prefers-reduced-motion`. Routes "draw on"
    with stroke-dashoffset. Toasts replace `alert()` and inline status blocks. The loading
    overlay shows real download progress from `Content-Length`. `routing_edges.geojson` is now
    fetched once (it was fetched twice before). The preview drive uses `requestAnimationFrame`
    with time-based interpolation (position = elapsed × speed), independent of frame rate.
49. **Keyboard:** 1–6 switch tabs (ignored while typing); Esc cancels any click mode.
50. Risk bands in `getDangerLevel` now match the legend and Guide exactly
    (Low < 30 ≤ Medium < 60 ≤ High < 80 ≤ Critical).

## M11: persistent SITREP database
51. **Store:** `data/sitrep_db.json` (git-ignored) shaped `{version, records, events}`, with an
    in-memory copy in the server. Every write goes to `sitrep_db.json.tmp` followed by
    `fs.renameSync` (atomic). A corrupt file is moved aside (`*.corrupt-<ts>`) instead of crashing.
    Override the path with `SITREP_DB=...` (used by the tests).
52. **Server-assigned ids** `THR-YYYYMMDD-NNNN` (daily sequence). Records carry a `version`, which
    is incremented on every change. The client applies a record only if its version is newer,
    so the API response and the SSE echo of the same change are applied once.
53. **Intel feed:** on first run the database is seeded from `data/live_threats.json` with
    `source: "intel_feed"`, `status: "pending"`. "Intel reports" (`POST /api/intel/apply`)
    activates them, so they only appear when the operator asks, as before. `/fetch-live-threats`
    still works and returns those records in the old format. Statuses:
    pending / active / cleared / expired.
54. **Auto-SITREP:** every record gets a standard one-line `sitrep_line` (DTG `DDHHMMZ MON YY`,
    UTC). Manual map threats also use it as `sitrep_text`; SITREP-sourced records keep the
    operator's original text in `sitrep_text`. The location label (nearest road + nearest
    landmark with distance and compass direction) is computed in the browser from the M9
    gazetteer and sent with the create request.
55. **Validation:** type must be in `threat_types.json`; impact 10–100; radius 25–500; lat/lon inside
    the operating box (from `data/region.json`) with about 1 km of padding. Invalid requests
    get HTTP 422 with a message, and the UI shows it as a toast.
56. **Delete is a soft delete** (`status: "cleared"` plus a history entry). The record stays in
    the log and the CSV export. History actions: created / edited / moved / cleared /
    activated / expired, with `changes: {field: {from, to}}`.
57. **Expiry:** per-type TTL from `threat_types.json` (accident 2 h, stone pelting 4 h,
    ambush 6 h, blockade 8 h, IED and landslide until cleared). The server sweeps every 15 s,
    marks records `expired` and broadcasts the change, so they stop affecting routing.
58. **Live sync = Server-Sent Events** (`/api/stream`, with a ping every 20 s), chosen over
    WebSockets because it needs no library on the server or in the browser and reconnects
    automatically. Events: threat_created / threat_updated / threat_cleared / event_logged
    (convoy_position and convoys_changed are added in M13 / M14).
59. CSV export has a UTF-8 BOM so Excel on Windows shows non-ASCII place names correctly.
    The database files are never served as static files (HTTP 403).

## M12: risk guide + tooltips
60. **One λ default:** Balanced = 0.6 everywhere (`ROUTE_LAMBDAS` in `pathfinding.js`, which
    `app.js` reads). Presets are labelled "Fastest (λ 0) · Balanced (λ 0.6) · Safest (λ 0.95)".
    The slider moves only the Balanced route (max 0.95, so Balanced never exceeds Safest).
61. **Guide tables are computed, not typed:** the multiplier table (C) uses the router's
    `1 + 3·impact/100` and the λ table (D) uses `1 + λ·(R/100)/(1 − λ)` with R = 80, so the
    explanation cannot drift from the code. The values match the IMPROVEMENTS.md tables
    (×1.5 / 1.9 / 2.5 / 3.4; 1.0 / 1.2 / 1.4 / 2.2 / 4.2 / 16 km).
62. **Tooltips:** one ⓘ per number or label (route rows, λ, impact, radius, legend, threat-popup
    effect, edge popups, live HUD). Each shows one sentence plus a "More in Guide" link that
    opens the Guide tab at the right section. It works with hover, keyboard focus or click,
    and the popover stays open while hovered so the link can be clicked.
63. The "multiplier" (risk ×1.5) and "λ" (preference 0.6) are always labelled differently and
    explained side by side in a call-out.

## M13: live tracking + on-the-move rerouting
64. **Engine:** one `requestAnimationFrame` loop for all convoys, time-based (distance += speed ×
    sim-dt; dt clamped to 0.25 s after tab switches). Sim clock multiplier 1× / 5× / 10× / 30×
    plus pause. The column is drawn as vehicles × spacing behind the head; heading is smoothed;
    the travelled part is grey and the remaining part coloured. Layers update at about 8 Hz and
    the HUD at 5 Hz.
65. **Reroute rules** (`js/reroute.js`, pure and unit-tested): mandatory if any remaining edge
    is hard-blocked, replanning from the next node. If the closure lies *ahead on the current
    edge*, the convoy **turns back** and replans from the previous node ("ahead" = the clipped
    closure pieces project beyond the convoy's position on that edge). Advisory if the
    remaining risk cost rises by more than 15% over the plan baseline: automatic if the
    alternative is at least 10% cheaper, otherwise a prompt with Accept / Ignore.
66. **Hysteresis:** at most one *automatic advisory* reroute per 30 s of sim time, and never back
    to a route abandoned in the last 120 s. **Mandatory reroutes bypass the 30 s limit**
    because a closed road is a safety stop, not a preference.
67. **Triggers:** every threat change (local or arriving by SSE from another tab or client) and
    every 10 s of sim time. Replanning uses the λ of the profile chosen at departure.
68. **No jump:** the new drive line starts at the convoy's current position, then finishes the
    current edge (or reverses it when turning back) and joins the new route. The old remaining
    route fades out as a grey dashed ghost (6 s) while the new one draws on.
69. **Feedback:** a top banner with the cause, the "via" road (the longest named road on the new
    route that wasn't on the old one), Δkm, Δmin and route risk before → after. Optional
    `speechSynthesis` voice and a WebAudio beep (off by default). Reroute / turn-back / stuck /
    departed / arrived events are written to the SITREP database (`POST /api/events`) and shown
    in the Live and Log tabs.
70. **No passable route:** the convoy holds position ("HOLD - NO ROUTE") until a closure is lifted.
71. **GPS:** `watchPosition` fixes are map-matched to the road (snap ≤ 60 m) and projected onto
    the drive line (progress never jumps backwards on jitter). More than 80 m off the route →
    replan from the nearest node. Outside the operating box → warning and fall back to
    simulation. **External feed:** `POST /api/convoys/:id/position {lat, lon, speed_kmph,
    heading, ts}` is rebroadcast over SSE (`convoy_position`) and drives the focused convoy
    when "External feed" is selected.
72. **Scenarios** (`data/scenarios/*.json`): timed steps by sim seconds; `add_threat` accepts
    either `lat`/`lon` or `ahead_m` (placed on the convoy's *current* route, so "stone pelting
    on the alternative" lands on the rerouted path). One scenario is shipped: Srinagar, IED
    on route, then stone pelting on the alternative.

## M14: multi-convoy deconfliction and timing
73. **Occupancy:** the head enters edge e at `t_in = SP + dist / v`; the tail leaves at
    `t_exit_head + column / v` with column = vehicles × spacing. Window = [t_in − buffer,
    t_out + buffer], buffer 3 min by default. Junction crossings get the same window at the
    node. Times are minutes of day from the 24-hour SP (HH:MM).
74. **Conflict rules:** head-on = same edge, opposite directions, overlapping windows. It is
    **Critical** on a bridge, chokepoint (top-5% betweenness), narrow road (≤ 1 lane, minor
    class) or unpaved road; High elsewhere. Bunching = same edge, same direction, head gap
    < 10 min (Medium). Junction = same node with overlapping windows where the routes *cross*
    (nodes on a shared stretch are not double-counted) (Medium). Shared threat exposure = both
    convoys inside the same threat radius at overlapping times (High).
75. **Grouping:** consecutive shared edges of one pair and type form *one* conflict, labelled at
    its worst location (a bridge is preferred), so a long shared stretch doesn't produce dozens
    of warnings.
76. **Resolution (prioritised planning):** sort by priority, then SP. The first convoy keeps
    its plan. Each next convoy tries (1) delaying SP in 2-min steps up to 60 min and (2) an
    alternative route found with A* where edges reserved by higher-priority convoys get
    +400 risk (Critical ones are blocked, with λ ≥ 0.5 so the penalty also applies to
    "fastest"). The option with the fewest critical, then high, then total conflicts wins,
    with ties broken by cost = delay minutes + extra route cost converted to minutes
    (Δcost × L_ref ÷ speed). If nothing is conflict-free, the least-bad option is kept and
    the remaining conflicts are flagged.
77. **Recommendations, not silent changes:** "Bravo-2: delay SP by 14 min (07:32 → 07:46) to avoid
    head-on with Alpha-1 on Syed Mansoor Bridge" with Accept / Accept all. Accepting a reroute
    pins that route until the convoy's endpoints or profile change.
78. **Persistence:** `data/convoys.json` (git-ignored, atomic writes) via
    `GET/POST/PATCH/DELETE /api/convoys`. Changes are broadcast over SSE (`convoys_changed`)
    so other tabs stay in sync.
79. **Run all:** every convoy runs in the M13 live engine from its own SP (sim offsets
    relative to the earliest SP). The Gantt shows a "now" line. After any live reroute, the
    conflict check re-runs on the convoys' remaining routes from their current positions, and
    any new High or Critical conflict raises a toast.
80. **Demo convoys** ("Load demo convoys"): Alpha-1 south→north 07:30 (P1), Bravo-2 north→south
    07:32 (P2), Charlie-3 south→north 07:34 (P3), between both banks of the Jhelum. Their
    routes share river-bridge chokepoints, which gives 2 Critical head-ons and 1 bunching;
    "Accept all" delays Bravo-2 by 14 min and Charlie-3 by 28 min, leaving zero conflicts.

---

## Summary

### What works
* `python -m pipeline.run_all`: M1 → M4 in about 110 s on **Srinagar** (24,574 nodes / 29,078 edges,
  real OSM data). Model: XGBoost ROC-AUC 0.936 random split / 0.76 spatial CV vs baseline 0.71 / 0.70.
* ML risk map, three routes in ~10–25 ms (well under 1 s), comparison table with all convoy metrics, λ slider.
* Threat reporting by map click (type + impact slider), intel feed, and SITREP text. 300 m
  zones, hard blocks never crossed, automatic re-route with Δkm / Δrisk banner.
* Convoy animation showing live segment risk.
* `pytest -q`: 7 tests pass (schema, string keys, weights 0–100, no NaN, model > baseline in
  both random and spatial CV, synthetic labels, JS A* fixture). `npm test` runs the A* check.

### Stubbed / not done
* Gemini path untested (no key in the sandbox). The rule-based fallback is tested.
* No OSM building/POI density, no elevation.

### Demo script (committed Srinagar build)
1. `node server.js`, then open http://localhost:3000. The ML risk map of Srinagar loads
   (about 2.5 s; the graph files are about 40 MB). Red clusters are the synthetic hotspots.
   Click a red segment to show the model probability, road type and chokepoint flag.
2. Click **Plan Convoy Route**. Click **A** near **34.0931, 74.8095** (city centre, just east of
   the Jhelum) and **B** near **34.0649, 74.7415** (west Srinagar).
   *Audience sees:* Fastest (blue) and Balanced (orange) cut through the red cluster west of
   the river: about 10.6% route incident probability, 18 high-risk segments. Safest (green)
   swings south round it: 10.0 km (+1.5 km, +3 min), **1.7%**, zero high-risk segments.
3. Click **Report Threat**, choose **IED** (impact 92 = road closed), and click on the green
   route near **34.0718, 74.7926**.
   *Audience sees:* a magenta closed zone, and the banner "🔀 Re-routed: previous route
   BLOCKED · +3.25 km". The new safest route goes further south round the closure.
4. Drag the **λ slider** to show the Balanced route moving between fastest and safest.
5. Click **Fetch Intel Reports**: 5 synthetic reports appear (Gandarbal Road IED,
   Lalbazar ambush, Amda Kadal stone pelting, Srinagar–Athwajan Road blockade, Nowgam
   landslide), 2 of them road closures, and the route updates.
6. Type the SITREP `Suspected IED reported near the bridge on Fore Shore Road` and click
   **Parse & add threat**. The threat lands on the Fore Shore Road bridge segment.
   Also try `Stone pelting mob gathering on Boulevard Road, 1 km east`.
7. Click **Animate Convoy** to watch the convoy and its live segment-risk readout.
