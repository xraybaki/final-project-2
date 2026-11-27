/**
 * SANCHAR (Smart AI Navigation for Convoy Hazard Avoidance & Rerouting) - map, routing and UI shell glue.
 *
 * Map centre / bounds / convoy parameters come from routing_graph.json "meta"
 * (written by `python -m pipeline.run_all`), so switching region needs no JS change.
 * Threat logic lives in js/threats.js, geometry in js/threat-geo.js, A* in pathfinding.js.
 */
const CONFIG = {
    map: {
        center: [34.0837, 74.7973], // Srinagar (default; replaced by graph meta)
        zoom: 13,
        minZoom: 9,
        maxZoom: 18
    },
    // Basemaps (no API key needed for Esri / OSM; CARTO now watermarks keyless requests)
    tiles: {
        'Dark (Esri)': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
            maxZoom: 16
        },
        'Satellite (Esri)': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
            maxZoom: 18
        },
        'OpenStreetMap': {
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        },
        'Dark (CARTO)': {
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19
        }
    },
    geojson: {
        edges: 'routing_edges.geojson',
        routingGraph: 'routing_graph.json'
    },
    convoy: {
        speedKmph: 30,          // replaced by meta.convoy_speed_kmph
        hardBlockImpact: 90,    // from threat_types.json
        highRiskWeight: 60
    }
};

// ------------------------------------------------------------------ global state
let map;
let edgesLayer;               // ML risk network (canvas)
let edgesData = null;         // routing_edges.geojson (loaded once)
let graphMeta = null;         // meta block from routing_graph.json

let routingGraph = null;      // routing_graph.json
let nodesLookup = {};         // "id" -> node (built ONCE when the graph loads)
let nodesList = [];           // nodes array for nearest-node search
let edgeFeatures = [];        // eid -> GeoJSON feature
let startNode = null;
let endNode = null;
let routeLayers = [];
let markerLayers = [];
let routingMode = false;
let networkDisplayed = false;
let coverageArea = null;
let lastRoutes = null;        // last computed {fastest, balanced, safest}
let customLambda = ROUTE_LAMBDAS.balanced;   // ONE default (0.6), shared with pathfinding.js
let currentRoute = null;

// preview animation (requestAnimationFrame, time-based)
let anim = null;

function routingOptions() {
    return {
        Lref: (graphMeta && graphMeta.L_ref) || 100,
        edgeWeight: window.getAdjustedEdgeWeight,
        edgeProb: window.getAdjustedEdgeProb,
        speedKmph: CONFIG.convoy.speedKmph,
        highRisk: CONFIG.convoy.highRiskWeight,
        lambdas: { balanced: customLambda }
    };
}

// ------------------------------------------------------------------ UI shell (tabs, chips, keys)
const Shell = {
    tabs: ['plan', 'live', 'threats', 'convoys', 'log', 'guide'],
    current: 'plan',
    switchTab(name) {
        if (!this.tabs.includes(name)) return;
        this.current = name;
        document.querySelectorAll('.rail-tab').forEach(b => {
            const on = b.dataset.tab === name;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-selected', on);
        });
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.id === `tab-${name}`));
        const sb = document.getElementById('sidebar');
        if (sb.classList.contains('is-collapsed')) this.setCollapsed(false);
        document.dispatchEvent(new CustomEvent('tabchange', { detail: name }));
    },
    setCollapsed(on) {
        document.getElementById('sidebar').classList.toggle('is-collapsed', on);
        setTimeout(() => map && map.invalidateSize(), 220);
    },
    init() {
        document.querySelectorAll('.rail-tab').forEach(b => b.addEventListener('click', () => this.switchTab(b.dataset.tab)));
        document.getElementById('collapse-btn').addEventListener('click', () =>
            this.setCollapsed(!document.getElementById('sidebar').classList.contains('is-collapsed')));
        document.getElementById('drawer-btn').addEventListener('click', () =>
            document.getElementById('sidebar').classList.toggle('is-open'));
        const chip = (id) => {
            const elx = document.getElementById(id);
            const toggle = () => { const o = !elx.classList.contains('is-open'); elx.classList.toggle('is-open', o); elx.setAttribute('aria-expanded', o); };
            elx.addEventListener('click', toggle);
            elx.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        };
        chip('header-chip');
        chip('legend-chip');
        document.addEventListener('keydown', (e) => {
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
            if (e.key === 'Escape') {
                if (routingMode) toggleRoutingMode(true);
                document.getElementById('sidebar').classList.remove('is-open');
                return;
            }
            if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
            const n = Number(e.key);
            if (n >= 1 && n <= 6) this.switchTab(this.tabs[n - 1]);
        });
    }
};
window.Shell = Shell;

// ------------------------------------------------------------------ loading
const Loading = {
    set(frac, text) {
        document.getElementById('loading-bar').style.width = `${Math.round(100 * Math.min(1, frac))}%`;
        if (text) document.getElementById('loading-text').textContent = text;
    },
    done() {
        const l = document.getElementById('loading');
        l.classList.add('is-done');
        setTimeout(() => l.remove(), 400);
    }
};

/** fetch + JSON with download progress (uses Content-Length when available). */
async function fetchJSONProgress(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    // under gzip Content-Length is the compressed size, so prefer the server's uncompressed length
    const total = Number(res.headers.get('X-Uncompressed-Length')) ||
        (res.headers.get('Content-Encoding') ? 0 : Number(res.headers.get('Content-Length'))) || 0;
    if (!res.body || !total) return res.json();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(1, got / total), got);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder('utf-8').decode(buf));
}

// ------------------------------------------------------------------ map
function initMap() {
    map = L.map('map', {
        center: CONFIG.map.center,
        zoom: CONFIG.map.zoom,
        minZoom: CONFIG.map.minZoom,
        maxZoom: CONFIG.map.maxZoom,
        zoomControl: true
    });
    const bases = {};
    Object.entries(CONFIG.tiles).forEach(([name, t]) => {
        bases[name] = L.tileLayer(t.url, { attribution: t.attribution, maxNativeZoom: t.maxZoom, maxZoom: 19 });
    });
    Object.values(bases)[0].addTo(map);
    L.control.layers(bases, null, { position: 'bottomright' }).addTo(map);
    map.on('click', onMapClick);
}

// Colour for a segment risk weight (0-100) - matches the legend
function getEdgeColor(weight) {
    if (weight < 30) return '#00ff00';
    if (weight < 60) return '#ffff00';
    if (weight < 80) return '#ff6b35';
    return '#ff0000';
}

function updateStats() {
    const statsDiv = document.getElementById('stats');
    if (!statsDiv || !routingGraph) return;
    const m = graphMeta || {};
    const edges = routingGraph.edges || [];
    const high = edges.filter(e => e.weight >= CONFIG.convoy.highRiskWeight).length;
    const choke = edges.filter(e => e.chokepoint).length;
    const f2 = (v) => (v ? v.toFixed(2) : 'n/a');
    statsDiv.innerHTML = `
        <p><span class="stat-k">Road segments</span> ${edges.length.toLocaleString()}</p>
        <p><span class="stat-k">High-risk (≥${CONFIG.convoy.highRiskWeight})</span> ${(100 * high / Math.max(1, edges.length)).toFixed(1)}%</p>
        <p><span class="stat-k">Chokepoints</span> ${choke.toLocaleString()}</p>
        <p><span class="stat-k">Risk model</span> ${escapeHtml(m.model || 'n/a')}</p>
        <p><span class="stat-k">ROC-AUC</span> ${f2(m.model_roc_auc)} random split · ${f2(m.model_roc_auc_spatial_cv)} spatial CV (baseline ${f2(m.baseline_roc_auc_spatial_cv)})</p>
        <p><span class="stat-k">Convoy speed</span> ${CONFIG.convoy.speedKmph} km/h</p>
        <p class="warn-text">Threat data is SYNTHETIC - for demonstration only</p>`;
    const hm = document.getElementById('hc-model');
    if (hm) hm.textContent = `${m.model || ''} · AUC ${f2(m.model_roc_auc_spatial_cv)} (spatial CV)`;
}

function applyGraphMeta(meta) {
    graphMeta = meta || {};
    const r = graphMeta.region || {};
    if (graphMeta.convoy_speed_kmph) CONFIG.convoy.speedKmph = graphMeta.convoy_speed_kmph;
    if (graphMeta.high_risk_weight) CONFIG.convoy.highRiskWeight = graphMeta.high_risk_weight;
    if (r.center) {
        CONFIG.map.center = r.center;
        map.setView(r.center, CONFIG.map.zoom);
    }
    if (r.bounds) map.setMaxBounds(L.latLngBounds(r.bounds).pad(0.3));
    const title = document.getElementById('region-name');
    if (title && r.name) title.textContent = r.name;
    const bi = document.getElementById('bounds-info');
    if (bi && r.bounds) {
        const ns = v => `${Math.abs(v).toFixed(3)}°${v >= 0 ? 'N' : 'S'}`;
        const ew = v => `${Math.abs(v).toFixed(3)}°${v >= 0 ? 'E' : 'W'}`;
        bi.textContent = `Area ${ns(r.bounds[0][0])}–${ns(r.bounds[1][0])}, ${ew(r.bounds[0][1])}–${ew(r.bounds[1][1])}`;
    }
    addCoverageArea();
}

async function init() {
    Shell.init();
    initMap();
    Loading.set(0.02, 'Loading threat types…');
    await Threats.loadTypes();
    await loadRoutingGraph();
    if (routingGraph) {
        toggleNetworkDisplay(true);   // the ML risk map is the core of the demo
        document.dispatchEvent(new CustomEvent('graphready'));
    }
    Loading.done();
}

function addCoverageArea() {
    const r = (graphMeta && graphMeta.region) || {};
    if (coverageArea) map.removeLayer(coverageArea);
    const b = r.bounds;
    coverageArea = b
        ? L.rectangle(b, { color: '#22d39b', weight: 1.5, opacity: 0.35, fill: false, dashArray: '8 8', interactive: false })
        : L.circle(r.center || CONFIG.map.center, { radius: r.radius_m || 12000, color: '#22d39b', weight: 1.5, opacity: 0.35, fill: false, dashArray: '8 8', interactive: false });
    coverageArea.addTo(map);
}

// ------------------------------------------------------------------ risk network layer
window.toggleNetworkDisplay = function (forceOn) {
    const cb = document.getElementById('toggle-network');
    const on = forceOn === true ? true : (cb ? cb.checked : !networkDisplayed);
    if (cb) cb.checked = on;
    if (on && !networkDisplayed) {
        if (!edgesLayer) buildEdgesLayer();
        edgesLayer.addTo(map);
        edgesLayer.bringToBack();
        networkDisplayed = true;
    } else if (!on && networkDisplayed) {
        map.removeLayer(edgesLayer);
        networkDisplayed = false;
    }
};

function edgePopupContent(props) {
    const w = props.weight;
    const eff = Threats.effectOf(props.eid);
    const band = getDangerLevel(w);
    const f = props.features || {};
    const frac = eff && !eff.hard ? Math.round(100 * Math.min(1, eff.parts.reduce((a, p) => a + p.fIn, 0))) : 0;
    return `
        <div class="popup-title">${escapeHtml(props.street_name)}</div>
        <div class="popup-stat">Segment risk <span class="risk-${band.key}">${w.toFixed(1)} / 100 · ${band.label}</span></div>
        <div class="popup-stat">ML incident prob. (6 mo) <span>${(100 * props.risk_prob).toFixed(1)}%</span></div>
        <div class="popup-stat">Road <span>${escapeHtml(props.highway_type)}${props.bridge ? ' · bridge' : ''}${props.tunnel ? ' · tunnel' : ''}</span></div>
        <div class="popup-stat">Length <span>${props.length_m.toFixed(0)} m · ${(props.travel_time_s / 60).toFixed(1)} min @ ${CONFIG.convoy.speedKmph} km/h</span></div>
        ${f.curviness ? `<div class="popup-stat">Curviness <span>${f.curviness.toFixed(2)}</span></div>` : ''}
        ${props.chokepoint ? '<div class="popup-flag is-warn">Chokepoint (top 5% network betweenness)</div>' : ''}
        ${eff ? `<div class="popup-flag is-danger">${eff.hard ? 'CLOSED by a live threat (hard block)' : `Live threat covers ${frac}% of this segment (impact ${eff.maxImpact})`}</div>` : ''}
        <div class="popup-flag muted">${typeof Guide !== 'undefined' ? Guide.link('risk', 'What does segment risk mean?') : ''}</div>`;
}

function buildEdgesLayer() {
    edgesLayer = L.geoJSON(edgesData, {
        renderer: L.canvas({ padding: 0.5 }),
        style: (feature) => ({
            color: getEdgeColor(feature.properties.weight),
            weight: feature.properties.chokepoint ? 3 : 2,
            opacity: 0.72
        }),
        onEachFeature: (feature, layer) => {
            layer.on('click', (e) => {
                if (routingMode || Threats.reportMode || Threats.pin) return;   // click belongs to the map handler
                L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(edgePopupContent(feature.properties)).openOn(map);
            });
        }
    });
}

window.toggleLayer = function (layerType) {
    if (layerType === 'edges') toggleNetworkDisplay(!networkDisplayed);
};

// ------------------------------------------------------------------ routing
async function loadRoutingGraph() {
    try {
        routingGraph = await fetchJSONProgress(CONFIG.geojson.routingGraph,
            (f, b) => Loading.set(0.05 + 0.5 * f, `Routing graph ${(b / 1e6).toFixed(1)} MB`));
        applyGraphMeta(routingGraph.meta);
        nodesLookup = {};
        routingGraph.nodes.forEach(n => { nodesLookup[String(n.id)] = n; });
        nodesList = routingGraph.nodes;

        edgesData = await fetchJSONProgress(CONFIG.geojson.edges,
            (f, b) => Loading.set(0.55 + 0.4 * f, `Road geometry ${(b / 1e6).toFixed(1)} MB`));
        edgeFeatures = [];
        edgesData.features.forEach(f => { edgeFeatures[f.properties.eid] = f; });

        Loading.set(0.97, 'Indexing roads and landmarks…');
        await Threats.onGraphLoaded();
        await Threats.loadFromServer();
        Threats.connectStream();
        updateStats();
    } catch (error) {
        console.error('Error loading routing graph:', error);
        UI.toast('Could not load routing_graph.json - run: python -m pipeline.run_all', { type: 'danger', timeout: 0 });
    }
}

function onMapClick(e) {
    if (Threats.handleMapClick(e)) return;           // report / pin mode
    if (typeof Live !== 'undefined' && Live.handleMapClick && Live.handleMapClick(e)) return;
    if (typeof Convoys !== 'undefined' && Convoys.handleMapClick && Convoys.handleMapClick(e)) return;
    if (!routingMode || !routingGraph) return;
    setRoutePoint(e.latlng.lat, e.latlng.lng);
}

function routeMarker(lat, lon, label) {
    return L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'route-marker-wrap',
            html: `<div class="route-marker ${label === 'A' ? 'is-a' : 'is-b'}">${label}</div>`,
            iconSize: [34, 34], iconAnchor: [17, 17]
        }),
        zIndexOffset: 1500
    });
}

function setRoutePoint(lat, lon) {
    const nearest = findNearestNode(lat, lon, nodesList);
    if (!nearest) {
        UI.toast('No road found near this location.', { type: 'warn' });
        return;
    }
    if (!startNode) {
        startNode = nearest;
        markerLayers.push(routeMarker(nearest.lat, nearest.lon, 'A').addTo(map));
        UI.toast('Start set. Now click the destination (B).', { type: 'info', timeout: 2500 });
    } else if (!endNode) {
        endNode = nearest;
        markerLayers.push(routeMarker(nearest.lat, nearest.lon, 'B').addTo(map));
        if (routingMode) toggleRoutingMode(true);   // leave placement mode, keep the route
        calculateConvoyRoutes(false);
    }
}
window.setRoutePoint = setRoutePoint;

function orientedEdgeLatLngs(edge, fromId) {
    const f = edgeFeatures[edge.eid];
    const from = nodesLookup[fromId];
    if (!f) return null;
    let coords = f.geometry.coordinates;
    const d0 = Math.abs(coords[0][0] - from.lon) + Math.abs(coords[0][1] - from.lat);
    const d1 = Math.abs(coords[coords.length - 1][0] - from.lon) + Math.abs(coords[coords.length - 1][1] - from.lat);
    if (d1 < d0) coords = coords.slice().reverse();
    return coords.map(c => [c[1], c[0]]);
}

function routeLatLngs(route) {
    const out = [];
    route.edges.forEach((e, i) => {
        const seg = orientedEdgeLatLngs(e, route.path[i]) ||
            [[nodesLookup[route.path[i]].lat, nodesLookup[route.path[i]].lon],
             [nodesLookup[route.path[i + 1]].lat, nodesLookup[route.path[i + 1]].lon]];
        if (out.length) seg.shift();
        out.push(...seg);
    });
    return out;
}

function calculateConvoyRoutes(isReroute = false) {
    if (!startNode || !endNode || !routingGraph) return;
    const opts = routingOptions();
    const t0 = performance.now();
    const routes = calculateRoutes(routingGraph.adjacency_list, nodesLookup, String(startNode.id), String(endNode.id), opts);
    const ms = performance.now() - t0;

    if (!routes) {
        if (isReroute) {
            showRerouteBanner('<span class="closed">No passable route</span> - all paths are blocked by road closures.');
            return;
        }
        UI.toast('No path found between these points (blocked or disconnected). Try different locations.', { type: 'danger' });
        resetRouting();
        return;
    }

    // Re-route summary: previous safest route re-evaluated under the NEW threat picture vs the new one
    let rerouteMsg = null;
    if (isReroute && lastRoutes) {
        const prev = lastRoutes.safest;
        const prevNow = computeRouteMetrics(prev, opts);
        const now = routes.safest.metrics;
        const samePath = prev.path.join(',') === routes.safest.path.join(',');
        const dKm = now.distanceKm - prevNow.distanceKm;
        const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v);
        if (samePath) {
            rerouteMsg = `Safest route unchanged · route incident prob. now ${(100 * now.incidentProb).toFixed(2)}%`;
        } else if (prevNow.blockedSegments > 0) {
            rerouteMsg = `<b>Re-routed</b>: previous route <span class="closed">BLOCKED</span> · ${sgn(+dKm.toFixed(2))} km, ${sgn(+(now.etaMin - prevNow.etaMin).toFixed(1))} min`;
        } else {
            const riskDrop = prevNow.incidentProb > 0 ? 100 * (prevNow.incidentProb - now.incidentProb) / prevNow.incidentProb : 0;
            rerouteMsg = `<b>Re-routed</b>: ${sgn(+dKm.toFixed(2))} km, risk ${riskDrop >= 0 ? '−' : '+'}${Math.abs(riskDrop).toFixed(0)}% (${(100 * prevNow.incidentProb).toFixed(2)}% → ${(100 * now.incidentProb).toFixed(2)}%)`;
        }
    }

    lastRoutes = routes;
    displayConvoyRoutes(routes, !isReroute);
    showRouteComparison(routes, ms, rerouteMsg);
    document.dispatchEvent(new CustomEvent('routeschange', { detail: { routes, isReroute } }));
}

function displayConvoyRoutes(routes, fit = true) {
    routeLayers.forEach(layer => map.removeLayer(layer));
    routeLayers = [];
    ['fastest', 'balanced', 'safest'].forEach((k, i) => displayRoute(routes[k], i, fit));
    currentRoute = routes.safest;
    if (fit) {
        const all = routeLayers.flatMap(l => l.getLatLngs());
        map.fitBounds(L.latLngBounds(all), { padding: [60, 60] });
    }
}

/** Animate an SVG polyline drawing itself (stroke-dashoffset). */
function drawOn(polyline) {
    const path = polyline._path;
    if (!path || !path.getTotalLength || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len} ${len}`;
    path.style.strokeDashoffset = len;
    path.getBoundingClientRect();
    path.classList.add('route-draw');
    path.style.strokeDashoffset = 0;
    setTimeout(() => { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; path.classList.remove('route-draw'); }, 750);
}
window.drawOn = drawOn;

function displayRoute(route, index, animate = true) {
    const m = route.metrics;
    const polyline = L.polyline(routeLatLngs(route), {
        color: route.color,
        weight: [9, 7, 5][index],
        opacity: 0.88,
        smoothFactor: 1,
        className: `route-line route-${route.key}`
    }).addTo(map);
    if (animate) drawOn(polyline);
    polyline.bindPopup(`
        <div class="route-popup">
            <div class="rp-title rp-${route.key}">${route.name} route</div>
            <div class="rp-desc">${route.description}</div>
            <hr>
            <div class="popup-stat">Distance · ETA <span>${formatDistance(m.distanceKm)} · ${m.etaMin.toFixed(0)} min</span></div>
            <div class="popup-stat">Route incident prob. <span>${(100 * m.incidentProb).toFixed(2)}%</span></div>
            <div class="popup-stat">High-risk exposure <span>${m.exposureMin.toFixed(1)} min</span></div>
            <div class="popup-stat">Chokepoints <span>${m.chokepoints}</span></div>
        </div>`);
    routeLayers.push(polyline);
}

function showRerouteBanner(html) {
    const elx = document.getElementById('reroute-banner');
    if (!elx) return;
    elx.innerHTML = html;
    elx.hidden = false;
}

// Metric definitions shown as tooltips (M12 adds the full Guide)
const METRIC_TIPS = {
    distance: 'Total road distance of the route.',
    eta: 'Drive time at the convoy speed.',
    prob: 'Chance of at least one incident on this trip: P = 1 − Π(1 − pᵢ) over segments (per-traversal probabilities; synthetic data).',
    mean: 'Length-weighted average segment risk along the route (scale 0–100).',
    max: 'Worst segment risk on the route (scale 0–100).',
    high: 'Number of segments with risk ≥ 60.',
    exposure: 'Minutes the convoy spends on segments with risk ≥ 60 at convoy speed.',
    choke: 'Segments in the top 5% of network betweenness: bridges and single links whose loss cuts the network.',
    zone: 'Segments touching an active threat radius.'
};

function showRouteComparison(routes, ms, rerouteMsg) {
    const panel = document.getElementById('route-result');
    if (!panel) return;
    const keys = ['fastest', 'balanced', 'safest'];
    const ms_ = keys.map(k => routes[k].metrics);
    const tip = (k) => (typeof Guide !== 'undefined' ? Guide.tip(k) : '');
    const row = (label, k, vals, fmt) => {
        const v = Math.min(...vals);
        return `<tr><td class="metric-label">${label}${tip(k)}</td>${vals.map(x =>
            `<td class="${Math.abs(x - v) < 1e-9 ? 'best' : ''}">${fmt(x)}</td>`).join('')}</tr>`;
    };
    const cls = { fastest: 'r-fast', balanced: 'r-bal', safest: 'r-safe' };
    panel.innerHTML = `
        <h3>Route comparison</h3>
        <div id="reroute-banner" class="reroute-banner" ${rerouteMsg ? '' : 'hidden'}>${rerouteMsg || ''}</div>
        <table class="route-table">
            <thead><tr><th></th>${keys.map(k => `<th class="${cls[k]}">${routes[k].name.replace(/^\S+\s/, '')}</th>`).join('')}</tr></thead>
            <tbody>
                ${row('Distance', 'distance', ms_.map(m => m.distanceKm), v => `${v.toFixed(2)} km`)}
                ${row(`ETA @ ${CONFIG.convoy.speedKmph} km/h`, 'eta', ms_.map(m => m.etaMin), v => `${v.toFixed(0)} min`)}
                ${row('Incident prob.', 'prob', ms_.map(m => m.incidentProb), v => `${(100 * v).toFixed(2)}%`)}
                ${row('Mean seg. risk', 'mean', ms_.map(m => m.meanRisk), v => v.toFixed(1))}
                ${row('Max seg. risk', 'max', ms_.map(m => m.maxRisk), v => v.toFixed(0))}
                ${row('High-risk segs', 'high', ms_.map(m => m.highRiskSegments), v => v)}
                ${row('Exposure ≥ 60', 'exposure', ms_.map(m => m.exposureMin), v => `${v.toFixed(1)} min`)}
                ${row('Chokepoints', 'choke', ms_.map(m => m.chokepoints), v => v)}
                ${row('Threat-zone segs', 'zone', ms_.map(m => m.threatSegments), v => v)}
            </tbody>
        </table>
        <div class="lambda-control">
            <div class="row-between"><span>Balanced λ (risk weight)${tip('lambda')}</span><b id="lambda-value" class="num">${customLambda.toFixed(2)}</b></div>
            <input type="range" id="lambda-slider" class="range" min="0" max="0.95" step="0.05" value="${customLambda}">
            <div id="lambda-sentence" class="lambda-sentence"></div>
        </div>
        <div class="route-footnote">3 routes in ${ms.toFixed(0)} ms · risk from the ML model on SYNTHETIC data</div>
        <div class="btn-row">
            <button id="animate-route-btn" class="btn btn-secondary grow"><svg class="icon"><use href="#i-play"/></svg><span>Preview drive (safest)</span></button>
            <button id="go-live-btn" class="btn btn-primary grow"><svg class="icon"><use href="#i-radio"/></svg><span>Start live</span></button>
        </div>`;
    panel.hidden = false;
    const slider = panel.querySelector('#lambda-slider');
    const sentence = () => {
        const v = Number(slider.value);
        panel.querySelector('#lambda-value').textContent = v.toFixed(2);
        const s = panel.querySelector('#lambda-sentence');
        if (typeof Guide !== 'undefined') s.textContent = Guide.lambdaSentence(v);
    };
    slider.addEventListener('input', sentence);
    slider.addEventListener('change', () => setBalancedLambda(slider.value));
    sentence();
    panel.querySelector('#animate-route-btn').addEventListener('click', () => (anim ? stopRouteAnimation() : startRouteAnimation()));
    panel.querySelector('#go-live-btn').addEventListener('click', () => {
        if (typeof Live !== 'undefined' && Live.startFromPlan) Live.startFromPlan();
        else UI.toast('Live tracking arrives in the Live tab.', { type: 'info' });
    });
}

window.setBalancedLambda = function (v) {
    customLambda = Number(v);
    const chip = document.getElementById('chip-bal-lambda');
    if (chip) chip.textContent = customLambda.toFixed(2).replace(/0$/, '');
    if (startNode && endNode) calculateConvoyRoutes(false);
};

window.toggleRoutingMode = function (keepRoute = false) {
    routingMode = !routingMode;
    const btn = document.getElementById('routing-toggle-btn');
    const instructions = document.getElementById('routing-instructions');
    document.body.classList.toggle('mode-route', routingMode);
    if (routingMode) {
        if (Threats.reportMode) Threats.setReportMode(false);
        if (startNode && endNode) resetRouting();
        btn.classList.add('is-active');
        btn.querySelector('span').textContent = 'Cancel (Esc)';
        instructions.hidden = false;
        Shell.switchTab('plan');
    } else {
        btn.classList.remove('is-active');
        btn.querySelector('span').textContent = 'Pick start & destination';
        instructions.hidden = true;
        if (!keepRoute) resetRouting();
    }
};

window.resetRouting = function () {
    stopRouteAnimation();
    startNode = null;
    endNode = null;
    currentRoute = null;
    lastRoutes = null;
    routeLayers.forEach(layer => map.removeLayer(layer));
    routeLayers = [];
    markerLayers.forEach(marker => map.removeLayer(marker));
    markerLayers = [];
    const panel = document.getElementById('route-result');
    if (panel) panel.hidden = true;
    document.dispatchEvent(new CustomEvent('routeschange', { detail: { routes: null } }));
};

// ------------------------------------------------------------------ preview drive (rAF, time-based)
const PREVIEW_SPEEDUP = 20;   // 30 km/h × 20 for a quick on-map preview

/** Cumulative distances along a latlng polyline (metres). */
function cumulative(latlngs) {
    const cum = [0];
    for (let i = 1; i < latlngs.length; i++) cum.push(cum[i - 1] + getDistance(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]));
    return cum;
}

/** Point + bearing at distance d along a polyline with cumulative distances. */
function pointAlong(latlngs, cum, d) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
    const a = latlngs[i - 1], b = latlngs[i];
    return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, bearing: calculateBearing(a[0], a[1], b[0], b[1]), seg: i - 1 };
}
window.cumulative = cumulative;
window.pointAlong = pointAlong;

window.startRouteAnimation = function () {
    if (!currentRoute) return;
    stopRouteAnimation();
    const latlngs = routeLatLngs(currentRoute);
    const cum = cumulative(latlngs);
    // edge index at each latlng vertex, to read live segment risk
    const edgeAt = [];
    currentRoute.edges.forEach((e, i) => {
        const n = (orientedEdgeLatLngs(e, currentRoute.path[i]) || [0, 0]).length - (i ? 1 : 0);
        for (let k = 0; k < n; k++) edgeAt.push(i);
    });
    const marker = L.marker(latlngs[0], {
        icon: L.divIcon({ className: 'convoy-marker-wrap', html: '<div class="convoy-arrow"></div>', iconSize: [22, 24], iconAnchor: [11, 16] }),
        zIndexOffset: 1800
    }).addTo(map);
    const popup = L.popup({ closeButton: false, autoClose: false, closeOnClick: false, className: 'risk-popup', offset: [0, -14] });
    const mps = CONFIG.convoy.speedKmph / 3.6 * PREVIEW_SPEEDUP;
    const t0 = performance.now();
    let lastHud = 0;
    anim = { marker, popup, raf: 0 };
    const btn = document.querySelector('#animate-route-btn span');
    if (btn) btn.textContent = 'Stop preview';
    const frame = (now) => {
        const d = (now - t0) / 1000 * mps;
        if (d >= cum[cum.length - 1]) { stopRouteAnimation(); return; }
        const p = pointAlong(latlngs, cum, d);
        marker.setLatLng([p.lat, p.lon]);
        const arrow = marker.getElement() && marker.getElement().firstChild;
        if (arrow) arrow.style.transform = `rotate(${p.bearing}deg)`;
        if (now - lastHud > 200) {   // HUD at 5 Hz is plenty
            lastHud = now;
            const edge = currentRoute.edges[edgeAt[Math.min(p.seg, edgeAt.length - 1)]];
            const w = edge ? window.getAdjustedEdgeWeight(edge) : 0;
            const band = w === Infinity ? { label: 'ROAD CLOSED', key: 'closed' } : getDangerLevel(Math.min(100, w));
            const road = edge && edgeFeatures[edge.eid] ? edgeFeatures[edge.eid].properties.street_name : '';
            popup.setLatLng([p.lat, p.lon]).setContent(`
                <div class="risk-hud">
                    <div class="rh-road">${escapeHtml(road)}</div>
                    <div class="rh-band risk-${band.key}">${band.label}</div>
                    <div class="rh-val risk-${band.key}">${w === Infinity ? '∞' : Math.min(100, w).toFixed(0)}</div>
                    <div class="muted">${(d / 1000).toFixed(2)} / ${(cum[cum.length - 1] / 1000).toFixed(2)} km · ×${PREVIEW_SPEEDUP}</div>
                </div>`);
            if (!map.hasLayer(popup)) popup.openOn(map);
        }
        anim.raf = requestAnimationFrame(frame);
    };
    anim.raf = requestAnimationFrame(frame);
};

window.stopRouteAnimation = function () {
    if (!anim) return;
    cancelAnimationFrame(anim.raf);
    map.removeLayer(anim.marker);
    map.closePopup(anim.popup);
    anim = null;
    const btn = document.querySelector('#animate-route-btn span');
    if (btn) btn.textContent = 'Preview drive (safest)';
};

function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

document.addEventListener('DOMContentLoaded', init);
