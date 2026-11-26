// Configuration
// Map centre / bounds / convoy parameters are overwritten from routing_graph.json "meta"
// (written by `python -m pipeline.run_all`), so switching region needs no JS change.
const CONFIG = {
    map: {
        center: [30.3165, 78.0322], // Dehradun (default; replaced by graph meta)
        zoom: 13,
        minZoom: 9,
        maxZoom: 18
    },
    tiles: {
        // Dark basemap from CartoDB
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19
    },
    geojson: {
        edges: 'routing_edges.geojson',
        routingGraph: 'routing_graph.json'
    },
    convoy: {
        speedKmph: 30,          // replaced by meta.convoy_speed_kmph
        threatRadiusM: 300,     // replaced by meta.threat_zone_radius_m
        hardBlockImpact: 90,    // impact >= this -> road closed (Infinity cost)
        highRiskWeight: 60
    }
};

// Global variables
let map;
let edgesLayer;  // Routing edges (risk map)
let graphMeta = null;     // meta block from routing_graph.json

// Routing state
let routingGraph = null;  // Graph data loaded from routing_graph.json
let nodesLookup = {};     // "id" -> node (built ONCE when the graph loads)
let nodesList = [];       // array of nodes for nearest-node search
let edgeFeatures = [];    // eid -> GeoJSON feature (geometry for drawing + threat checks)
let startNode = null;     // Selected start point
let endNode = null;       // Selected end point
let routeLayers = [];     // Store route polylines
let markerLayers = [];    // Store start/end markers
let routingMode = false;  // Whether routing UI is active
let networkDisplayed = false;  // Whether edges are shown
let coverageArea = null;  // Coverage circle
let directLine = null;    // Direct line between A and B
let lastRoutes = null;    // Last computed {fastest, balanced, safest}
let customLambda = ROUTE_LAMBDAS.balanced;

// Vehicle animation state
let vehicleMarker = null;  // Animated vehicle marker
let riskPopup = null;      // Popup showing current risk
let animationInterval = null;  // Animation timer
let currentRoute = null;   // Currently displayed route for animation

// Threat reporting state
let reportThreatMode = false;  // Whether in threat reporting mode
let threatEvents = [];         // Active threats {lat, lon, type, impact, radius, marker, circle, ...}
let threatEdgeImpact = new Map(); // eid -> max impact (0-100) of threat zones covering the edge
let affectedEdgesLayer = null; // Layer for edges affected by threats (red overlay)

// Threat types (match pipeline/synthetic_threats.py) and default impact (0-100)
const THREAT_TYPES = {
    IED:           { label: 'IED / suspicious object', emoji: '💣', impact: 92 },
    ambush:        { label: 'Ambush risk',              emoji: '🎯', impact: 80 },
    stone_pelting: { label: 'Stone pelting',            emoji: '🪨', impact: 60 },
    road_blockade: { label: 'Road blockade',            emoji: '🚧', impact: 70 },
    landslide:     { label: 'Landslide (road closed)',  emoji: '⛰️', impact: 95 },
    accident:      { label: 'Accident / obstruction',   emoji: '💥', impact: 45 }
};

// Distance (m) from a point to a polyline [[lon,lat],...] (local planar approximation)
function distanceToPolyline(lat, lon, coords) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        const ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky;
        const bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        best = Math.min(best, Math.hypot(px, py));
    }
    return best;
}

// Rebuild eid -> impact map after threats change (one pass over all edges)
function recomputeThreatImpacts() {
    threatEdgeImpact = new Map();
    if (threatEvents.length === 0) return;
    edgeFeatures.forEach((f, eid) => {
        if (!f) return;
        const coords = f.geometry.coordinates;
        let maxImpact = 0;
        for (const t of threatEvents) {
            // cheap bounding check before exact distance
            if (Math.abs(coords[0][1] - t.lat) > 0.05 || Math.abs(coords[0][0] - t.lon) > 0.05) continue;
            if (distanceToPolyline(t.lat, t.lon, coords) <= t.radius) maxImpact = Math.max(maxImpact, t.impact);
        }
        if (maxImpact > 0) threatEdgeImpact.set(eid, maxImpact);
    });
}

// Effective risk weight of an edge given live threats.
//   impact >= hardBlockImpact  -> Infinity (convoy must not pass)
//   otherwise multiplicative penalty scaled by impact (NO cap - see DECISIONS.md)
window.getAdjustedEdgeWeight = function(edge) {
    const impact = threatEdgeImpact.get(edge.eid);
    if (!impact) return edge.weight;
    if (impact >= CONFIG.convoy.hardBlockImpact) return Infinity;
    const f = impact / 100;
    return Math.max(edge.weight, impact) * (1 + 3 * f);
};

// Per-traversal incident probability for an edge with effective weight w
function getAdjustedEdgeProb(edge, w) {
    const p = edge.p_traverse || 0;
    const impact = threatEdgeImpact.get(edge.eid);
    if (!impact) return p;
    if (w === Infinity) return 1;
    return 1 - (1 - p) * (1 - 0.5 * impact / 100);
}

function routingOptions() {
    return {
        Lref: (graphMeta && graphMeta.L_ref) || 100,
        edgeWeight: window.getAdjustedEdgeWeight,
        edgeProb: getAdjustedEdgeProb,
        speedKmph: CONFIG.convoy.speedKmph,
        highRisk: CONFIG.convoy.highRiskWeight,
        lambdas: { balanced: customLambda }
    };
}

// Initialize the map
function initMap() {
    map = L.map('map', {
        center: CONFIG.map.center,
        zoom: CONFIG.map.zoom,
        minZoom: CONFIG.map.minZoom,
        maxZoom: CONFIG.map.maxZoom,
        zoomControl: true
    });

    // Add dark tile layer
    L.tileLayer(CONFIG.tiles.url, {
        attribution: CONFIG.tiles.attribution,
        maxZoom: CONFIG.tiles.maxZoom
    }).addTo(map);

    // Add click handler for routing / threat reporting
    map.on('click', onMapClick);

    console.log('Map initialized');
}

// Get color for edge based on risk weight (0-100) - matches the legend
function getEdgeColor(weight) {
    if (weight < 30) return '#00ff00';      // Low
    if (weight < 60) return '#ffff00';      // Medium
    if (weight < 80) return '#ff6b35';      // High
    return '#ff0000';                       // Critical
}

// Update statistics panel from graph meta
function updateStats() {
    const statsDiv = document.getElementById('stats');
    if (!statsDiv || !routingGraph) return;
    const m = graphMeta || {};
    const edges = routingGraph.edges || [];
    const high = edges.filter(e => e.weight >= CONFIG.convoy.highRiskWeight).length;
    const choke = edges.filter(e => e.chokepoint).length;
    const auc = m.model_roc_auc ? m.model_roc_auc.toFixed(3) : 'n/a';
    statsDiv.innerHTML = `
        <p><strong>Road segments:</strong> ${edges.length.toLocaleString()}</p>
        <p><strong>High-risk (≥${CONFIG.convoy.highRiskWeight}):</strong> ${(100 * high / Math.max(1, edges.length)).toFixed(1)}%</p>
        <p><strong>Chokepoints:</strong> ${choke.toLocaleString()}</p>
        <p><strong>Risk model:</strong> ${m.model || 'n/a'} (ROC-AUC ${auc})</p>
        <p><strong>Convoy speed:</strong> ${CONFIG.convoy.speedKmph} km/h</p>
        <p style="margin-top: 8px; font-size: 11px; color: #ffaa00;">⚠️ Threat data is SYNTHETIC - for demonstration only</p>
    `;
}

// Apply region / convoy settings from routing_graph.json meta
function applyGraphMeta(meta) {
    graphMeta = meta || {};
    const r = graphMeta.region || {};
    if (graphMeta.convoy_speed_kmph) CONFIG.convoy.speedKmph = graphMeta.convoy_speed_kmph;
    if (graphMeta.threat_zone_radius_m) CONFIG.convoy.threatRadiusM = graphMeta.threat_zone_radius_m;
    if (graphMeta.hard_block_impact) CONFIG.convoy.hardBlockImpact = graphMeta.hard_block_impact;
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
        bi.innerHTML = `📍 Area: ${ns(r.bounds[0][0])} to ${ns(r.bounds[1][0])}<br>${ew(r.bounds[0][1])} to ${ew(r.bounds[1][1])}`;
    }
    addCoverageArea();
}

// Initialize app
async function init() {
    initMap();
    await loadRoutingGraph();
    // Show the ML risk map by default - it is the core of the demo
    if (routingGraph && !networkDisplayed) toggleNetworkDisplay();
}

// ============================================
// LIVE THREAT INTEL (synthetic feed) + SITREP PARSING
// ============================================

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fetch current intel reports (served from data/live_threats.json - SYNTHETIC)
window.fetchLiveThreats = async function() {
    const statusDiv = document.getElementById('fetch-status');
    const btn = document.getElementById('fetch-crimes-btn');
    statusDiv.style.display = 'block';
    statusDiv.innerHTML = '<em style="color: #667eea;">📡 Fetching intel reports...</em>';
    btn.disabled = true;
    btn.style.opacity = '0.5';

    try {
        const response = await fetch('/fetch-live-threats');
        const data = await response.json();
        if (data.error || !data.success || !data.events || data.events.length === 0) {
            statusDiv.innerHTML = `<em style="color: #ffaa00;">⚠️ ${escapeHtml(data.error || 'No current reports')}</em>`;
            return;
        }

        clearThreats(false);
        const eventCoords = [];
        for (const event of data.events) {
            if (createThreatAtLocation(event.lat, event.lon, event.type, event.impact, event.location, event.description, false)) {
                eventCoords.push([event.lat, event.lon]);
            }
        }
        onThreatsChanged();

        if (eventCoords.length > 0 && !lastRoutes) {
            map.fitBounds(L.latLngBounds(eventCoords), { padding: [50, 50], maxZoom: 14 });
        }
        showAllIncidentsPopup(data.events, data.source);
        const blocks = data.events.filter(e => e.impact >= CONFIG.convoy.hardBlockImpact).length;
        statusDiv.innerHTML = `
            <div style="color: #00ff88; font-weight: bold; margin-bottom: 5px;">✅ ${eventCoords.length} intel reports loaded</div>
            <div style="color: #ccc; font-size: 10px;">${blocks} road closure(s) (hard block) · ${CONFIG.convoy.threatRadiusM} m threat zones<br>
            <span style="color:#ffaa00;">${escapeHtml(data.source || 'SYNTHETIC')}</span></div>`;
    } catch (error) {
        console.error('Fetch threats error:', error);
        statusDiv.innerHTML = '<em style="color: #ff6b6b;">❌ Failed to reach intel service</em>';
    } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
    }
};
window.fetchLiveCrimes = window.fetchLiveThreats;  // backwards-compatible alias

// Create a threat zone at a location
function createThreatAtLocation(lat, lon, type, impact, location, fullDescription, notify = true) {
    if (!map) return false;
    const t = THREAT_TYPES[type] || { label: type, emoji: '⚠️', impact: impact || 60 };
    impact = Number(impact ?? t.impact);
    const radius = CONFIG.convoy.threatRadiusM;
    const hardBlock = impact >= CONFIG.convoy.hardBlockImpact;
    const color = hardBlock ? '#ff00ff' : '#ff0000';

    const marker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'crime-event-marker',
            html: `<div style="background: ${color}; width: 22px; height: 22px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 12px ${color}; display:flex; align-items:center; justify-content:center; font-size:11px; animation: pulse 2s infinite;">${t.emoji}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        }),
        zIndexOffset: 2000
    }).addTo(map);

    const circle = L.circle([lat, lon], {
        radius,
        color,
        fillColor: color,
        fillOpacity: hardBlock ? 0.25 : 0.15,
        weight: 2,
        dashArray: hardBlock ? null : '5, 5',
        interactive: false
    }).addTo(map);

    const event = { lat, lon, type, impact, radius, location: location || 'Map-reported location',
                    description: fullDescription, timestamp: Date.now(), marker, circle };

    marker.bindPopup(() => `
        <div style="min-width: 240px; max-width: 340px;">
            <div style="font-weight: bold; color: ${color}; font-size: 15px; margin-bottom: 6px;">${t.emoji} ${escapeHtml(t.label)}</div>
            <div style="font-size: 13px; color: #00ff88; font-weight: bold; margin-bottom: 6px;">📍 ${escapeHtml(event.location)}</div>
            ${fullDescription ? `<div style="font-size: 11px; color: #ccc; line-height: 1.5; margin-bottom: 8px; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 4px;">${escapeHtml(fullDescription)}</div>` : ''}
            <div style="font-size: 11px; color: #999;">
                <div style="display:flex; justify-content:space-between;"><span>Impact:</span><strong style="color:#ffaa00;">${impact}/100</strong></div>
                <div style="display:flex; justify-content:space-between;"><span>Zone:</span><strong>${radius} m radius</strong></div>
                <div style="display:flex; justify-content:space-between;"><span>Effect:</span><strong style="color:${color};">${hardBlock ? 'ROAD CLOSED (hard block)' : 'Risk penalty ×' + (1 + 3 * impact / 100).toFixed(1)}</strong></div>
            </div>
            <div style="font-size: 10px; color: #ffaa00; margin-top: 6px;">SYNTHETIC - for demonstration only</div>
            <button onclick="removeThreat(${event.timestamp})" style="margin-top:8px; width:100%; padding:5px; background:#333; color:#fff; border:1px solid #666; border-radius:4px; cursor:pointer;">🗑️ Remove this threat</button>
        </div>
    `);

    threatEvents.push(event);
    if (notify) onThreatsChanged();
    return true;
}
const createCrimeEventAtLocation = createThreatAtLocation;  // backwards-compatible alias

window.removeThreat = function(ts) {
    const ev = threatEvents.find(e => e.timestamp === ts);
    if (!ev) return;
    map.removeLayer(ev.marker);
    map.removeLayer(ev.circle);
    threatEvents = threatEvents.filter(e => e !== ev);
    map.closePopup();
    onThreatsChanged();
};

// Called whenever the threat picture changes: recompute zones, overlay, and re-route
function onThreatsChanged() {
    recomputeThreatImpacts();
    updateAffectedEdges();
    if (startNode && endNode && lastRoutes) {
        calculateConvoyRoutes(true);
    }
}

// Show popup with all intel reports
function showAllIncidentsPopup(events, source) {
    const existingPopup = document.getElementById('all-incidents-popup');
    if (existingPopup) existingPopup.remove();

    let incidentsHTML = '';
    events.forEach(event => {
        const t = THREAT_TYPES[event.type] || { label: event.type, emoji: '⚠️' };
        const hard = event.impact >= CONFIG.convoy.hardBlockImpact;
        incidentsHTML += `
            <div style="margin-bottom: 15px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 6px; border-left: 4px solid ${hard ? '#ff00ff' : event.impact > 70 ? '#ff6b6b' : '#ffaa00'};">
                <div style="font-weight: bold; color: #ff4444; font-size: 13px; margin-bottom: 6px;">
                    ${t.emoji} ${escapeHtml(t.label.toUpperCase())} - Impact ${event.impact}/100 ${hard ? '· <span style="color:#ff00ff;">ROAD CLOSED</span>' : ''}
                </div>
                <div style="font-size: 12px; color: #00ff88; margin-bottom: 6px;">📍 ${escapeHtml(event.location)}</div>
                <div style="font-size: 11px; color: #ccc; line-height: 1.4;">${escapeHtml(event.description)}</div>
            </div>`;
    });

    const regionName = (graphMeta && graphMeta.region && graphMeta.region.name) || '';
    const popup = document.createElement('div');
    popup.id = 'all-incidents-popup';
    popup.innerHTML = `
        <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 10000; display: flex; align-items: center; justify-content: center;" onclick="this.parentElement.remove()">
            <div style="background: #1a1a2e; padding: 25px; border-radius: 10px; max-width: 700px; max-height: 80vh; overflow-y: auto; box-shadow: 0 10px 50px rgba(0,0,0,0.5);" onclick="event.stopPropagation()">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #667eea; padding-bottom: 15px;">
                    <div>
                        <div style="font-size: 20px; font-weight: bold; color: #fff;">📡 Current Intel Reports</div>
                        <div style="font-size: 12px; color: #999; margin-top: 5px;">${escapeHtml(regionName)} - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</div>
                        <div style="font-size: 11px; color: #ffaa00; margin-top: 3px;">${escapeHtml(source || 'SYNTHETIC - for demonstration only')}</div>
                    </div>
                    <button onclick="this.closest('#all-incidents-popup').remove()" style="background: #ff4444; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-weight: bold;">✕ Close</button>
                </div>
                <div style="color: #ccc;">${incidentsHTML}</div>
            </div>
        </div>`;
    document.body.appendChild(popup);
}

// Parse a free-text SITREP into a threat (server: Gemini if configured, else rule-based)
window.parseSitrep = async function() {
    const input = document.getElementById('sitrep-input');
    const status = document.getElementById('sitrep-status');
    const text = (input.value || '').trim();
    if (!text) return;
    status.style.display = 'block';
    status.innerHTML = '<em style="color:#667eea;">🤖 Parsing SITREP...</em>';
    try {
        const res = await fetch('/parse-sitrep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        const t = await res.json();
        if (!res.ok || t.error || t.lat == null) {
            status.innerHTML = `<em style="color:#ff6b6b;">❌ ${escapeHtml(t.error || 'Could not locate the threat')}</em>`;
            return;
        }
        createThreatAtLocation(t.lat, t.lon, t.type, t.impact, t.location, t.description);
        if (!lastRoutes) map.setView([t.lat, t.lon], 15);
        status.innerHTML = `<div style="color:#00ff88;">✅ ${escapeHtml((THREAT_TYPES[t.type] || {}).label || t.type)} at ${escapeHtml(t.location)} (impact ${t.impact})</div>
            <div style="color:#888; font-size:10px;">parser: ${escapeHtml(t.parser || 'n/a')}</div>`;
        input.value = '';
    } catch (err) {
        console.error(err);
        status.innerHTML = '<em style="color:#ff6b6b;">❌ SITREP service unavailable</em>';
    }
};

// Add coverage area circle to show where routing works
function addCoverageArea() {
    const r = (graphMeta && graphMeta.region) || {};
    if (coverageArea) map.removeLayer(coverageArea);
    coverageArea = L.circle(r.center || CONFIG.map.center, {
        radius: r.radius_m || 12000,
        color: '#00ff88',
        fillColor: '#00ff88',
        fillOpacity: 0.03,
        weight: 2,
        opacity: 0.3,
        dashArray: '10, 10',
        interactive: false  // DON'T intercept clicks!
    }).addTo(map);
}

// Toggle network display (edges and nodes)
window.toggleNetworkDisplay = function() {
    const btn = document.getElementById('show-network-btn');
    
    if (!networkDisplayed) {
        console.log('📊 Loading street network...');
        btn.textContent = '⏳ Loading...';
        btn.disabled = true;
        
        loadEdges().then(() => {
            networkDisplayed = true;
            btn.textContent = '🙈 Hide Street Network';
            btn.disabled = false;
            console.log('✅ Street network displayed');
        }).catch(err => {
            console.error('❌ Error loading network:', err);
            btn.textContent = '🔍 Show Street Network';
            btn.disabled = false;
        });
    } else {
        console.log('🙈 Hiding street network...');
        if (edgesLayer) {
            map.removeLayer(edgesLayer);
            edgesLayer = null;
        }
        networkDisplayed = false;
        btn.textContent = '🔍 Show Street Network';
    }
};

// Edge popup content (risk map)
function edgePopupContent(props) {
    const w = props.weight;
    const impact = threatEdgeImpact.get(props.eid);
    const f = props.features || {};
    return `
        <div class="popup-title">${escapeHtml(props.street_name)}</div>
        <div class="popup-stat">Risk weight: <span style="color: ${getEdgeColor(w)}; font-weight: bold;">${w.toFixed(1)}/100</span></div>
        <div class="popup-stat">ML incident prob. (6 mo): <span>${(100 * props.risk_prob).toFixed(1)}%</span></div>
        <div class="popup-stat">Road: <span>${escapeHtml(props.highway_type)}${props.bridge ? ' · bridge' : ''}${props.tunnel ? ' · tunnel' : ''}</span></div>
        <div class="popup-stat">Length: <span>${props.length_m.toFixed(0)} m · ${(props.travel_time_s / 60).toFixed(1)} min @ ${CONFIG.convoy.speedKmph} km/h</span></div>
        ${f.curviness ? `<div class="popup-stat">Curviness: <span>${f.curviness.toFixed(2)}</span></div>` : ''}
        ${props.chokepoint ? '<div class="popup-stat" style="color:#ff9900;">⚠️ Chokepoint (top 5% betweenness)</div>' : ''}
        ${impact ? `<div class="popup-stat" style="color:#ff4444;">🚨 Inside live threat zone (impact ${impact})</div>` : ''}
    `;
}

// Load all routing edges coloured by ML risk weight
function loadEdges() {
    return fetch(CONFIG.geojson.edges)
        .then(response => response.json())
        .then(data => {
            edgesLayer = L.geoJSON(data, {
                renderer: L.canvas({ padding: 0.5 }),
                style: (feature) => ({
                    color: getEdgeColor(feature.properties.weight),
                    weight: feature.properties.chokepoint ? 3.5 : 2.5,
                    opacity: 0.75
                }),
                onEachFeature: (feature, layer) => {
                    layer.on('click', (e) => {
                        // in routing / reporting mode the click belongs to the map handler
                        if (routingMode || reportThreatMode) return;
                        L.popup().setLatLng(e.latlng).setContent(edgePopupContent(feature.properties)).openOn(map);
                    });
                }
            }).addTo(map);
            edgesLayer.bringToBack();
        });
}

// Toggle layer visibility
window.toggleLayer = function(layerType) {
    if (layerType === 'edges' && edgesLayer) {
        if (map.hasLayer(edgesLayer)) map.removeLayer(edgesLayer);
        else map.addLayer(edgesLayer);
    }
};

// ===========================
// ROUTING FUNCTIONS
// ===========================

// Load routing graph (once) and build lookups
async function loadRoutingGraph() {
    try {
        const response = await fetch(CONFIG.geojson.routingGraph);
        routingGraph = await response.json();
        applyGraphMeta(routingGraph.meta);

        // Node lookup is built ONCE here (string keys match adjacency_list)
        nodesLookup = {};
        routingGraph.nodes.forEach(n => { nodesLookup[String(n.id)] = n; });
        nodesList = routingGraph.nodes;

        // Edge geometries for drawing routes along the real road shape and for threat checks
        const edgesResponse = await fetch(CONFIG.geojson.edges);
        const edgesData = await edgesResponse.json();
        edgeFeatures = [];
        edgesData.features.forEach(f => { edgeFeatures[f.properties.eid] = f; });

        updateStats();
        console.log(`✅ Routing graph loaded: ${routingGraph.nodes.length} nodes, ${edgeFeatures.length} edges`);
    } catch (error) {
        console.error('❌ Error loading routing graph:', error);
        const statsDiv = document.getElementById('stats');
        if (statsDiv) statsDiv.innerHTML = '<p style="color:#ff4444;">Could not load routing_graph.json - run <code>python -m pipeline.run_all</code></p>';
    }
}

// Handle map clicks for routing / threat reporting
function onMapClick(e) {
    if (reportThreatMode) {
        handleThreatClick(e);
        return;
    }
    if (!routingMode || !routingGraph) return;
    setRoutePoint(e.latlng.lat, e.latlng.lng);
}

// Place start (A) or end (B) at the nearest graph node
function setRoutePoint(lat, lon) {
    const nearest = findNearestNode(lat, lon, nodesList);
    if (!nearest) {
        alert('No road found near this location.');
        return;
    }
    const mk = (label, bg, fg) => L.marker([nearest.lat, nearest.lon], {
        icon: L.divIcon({
            className: 'custom-marker',
            html: `<div style="background: ${bg}; width: 35px; height: 35px; border-radius: 50%; border: 4px solid white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 18px; color: ${fg}; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">${label}</div>`,
            iconSize: [35, 35],
            iconAnchor: [17, 17]
        }),
        zIndexOffset: 1500
    }).addTo(map);

    if (!startNode) {
        startNode = nearest;
        const marker = mk('A', '#00ff88', 'black');
        marker.bindPopup('<b>🟢 Start Point (A)</b><br>Click another location for destination').openPopup();
        markerLayers.push(marker);
    } else if (!endNode) {
        endNode = nearest;
        const marker = mk('B', '#ff4444', 'white');
        markerLayers.push(marker);
        calculateConvoyRoutes(false);
    }
}
window.setRoutePoint = setRoutePoint;

// Edge geometry oriented from node `fromId` to node `toId`
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

// Calculate and display Fastest / Balanced / Safest convoy routes
function calculateConvoyRoutes(isReroute = false) {
    if (!startNode || !endNode || !routingGraph) return;
    const opts = routingOptions();
    const t0 = performance.now();
    const routes = calculateRoutes(routingGraph.adjacency_list, nodesLookup, String(startNode.id), String(endNode.id), opts);
    const ms = performance.now() - t0;

    if (!routes) {
        if (isReroute) {
            showRerouteBanner('<span style="color:#ff00ff;">⛔ No passable route - all paths are blocked by road closures.</span>');
            return;
        }
        alert('❌ No path found between these points (blocked or disconnected). Try different locations.');
        resetRouting();
        return;
    }

    // Re-route summary: previous safest route re-evaluated under the NEW threat picture vs new safest route
    let rerouteMsg = null;
    if (isReroute && lastRoutes) {
        const prev = lastRoutes.safest;
        const prevNow = computeRouteMetrics(prev, opts);
        const now = routes.safest.metrics;
        const samePath = prev.path.join(',') === routes.safest.path.join(',');
        const dKm = now.distanceKm - prevNow.distanceKm;
        if (samePath) {
            rerouteMsg = `ℹ️ Safest route unchanged · route risk now ${(100 * now.incidentProb).toFixed(2)}%`;
        } else if (prevNow.blockedSegments > 0) {
            rerouteMsg = `🔀 <b>Re-routed</b>: previous route <span style="color:#ff00ff;">BLOCKED</span> · ${dKm >= 0 ? '+' : ''}${dKm.toFixed(2)} km, ${(now.etaMin - prevNow.etaMin >= 0 ? '+' : '')}${(now.etaMin - prevNow.etaMin).toFixed(1)} min`;
        } else {
            const riskDrop = prevNow.incidentProb > 0 ? 100 * (prevNow.incidentProb - now.incidentProb) / prevNow.incidentProb : 0;
            rerouteMsg = `🔀 <b>Re-routed</b>: ${dKm >= 0 ? '+' : ''}${dKm.toFixed(2)} km, risk ${riskDrop >= 0 ? '−' : '+'}${Math.abs(riskDrop).toFixed(0)}% (${(100 * prevNow.incidentProb).toFixed(2)}% → ${(100 * now.incidentProb).toFixed(2)}%)`;
        }
    }

    lastRoutes = routes;
    displayConvoyRoutes(routes, !isReroute);
    showRouteComparison(routes, ms, rerouteMsg);
}
const calculateSafestRoute = () => calculateConvoyRoutes(false);  // backwards-compatible name

// Draw the three routes (safest on top)
function displayConvoyRoutes(routes, fit = true) {
    routeLayers.forEach(layer => map.removeLayer(layer));
    routeLayers = [];
    ['fastest', 'balanced', 'safest'].forEach((k, i) => displayRoute(routes[k], i));
    currentRoute = routes.safest;
    if (fit) {
        const all = routeLayers.flatMap(l => l.getLatLngs());
        map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [300, 60], paddingBottomRight: [580, 60] });
    }
}

// Display a route on the map
function displayRoute(route, index) {
    const m = route.metrics;
    const polyline = L.polyline(routeLatLngs(route), {
        color: route.color,
        weight: [9, 7, 5][index],
        opacity: 0.85,
        smoothFactor: 1
    }).addTo(map);

    polyline.bindPopup(`
        <div style="min-width: 220px;">
            <div style="font-weight: bold; font-size: 14px; margin-bottom: 5px; color:${route.color};">${route.name} route</div>
            <div style="font-size: 11px; color: #ccc;">${route.description}</div>
            <hr style="margin: 8px 0; border-color: #444;">
            <div style="font-size: 12px; line-height:1.6;">
                📏 ${formatDistance(m.distanceKm)} · ⏱️ ${m.etaMin.toFixed(0)} min<br>
                🎲 Route incident prob.: <b>${(100 * m.incidentProb).toFixed(2)}%</b><br>
                🔥 High-risk exposure: <b>${m.exposureMin.toFixed(1)} min</b><br>
                🚧 Chokepoints: <b>${m.chokepoints}</b>
            </div>
        </div>
    `);
    routeLayers.push(polyline);
}

function showRerouteBanner(html) {
    const el = document.getElementById('reroute-banner');
    if (!el) return;
    el.innerHTML = html;
    el.style.display = 'block';
}

// Show route comparison panel: metrics side by side
function showRouteComparison(routes, ms, rerouteMsg) {
    const panel = document.getElementById('route-result');
    if (!panel) return;
    const keys = ['fastest', 'balanced', 'safest'];
    const ms_ = keys.map(k => routes[k].metrics);
    const best = (vals, lower = true) => {
        const v = lower ? Math.min(...vals) : Math.max(...vals);
        return vals.map(x => Math.abs(x - v) < 1e-9);
    };
    const row = (label, vals, fmt, lower = true, tip = '') => {
        const b = best(vals, lower);
        return `<tr title="${tip}"><td class="metric-label">${label}</td>${vals.map((v, i) =>
            `<td style="${b[i] ? 'color:#00ff88;font-weight:bold;' : ''}">${fmt(v)}</td>`).join('')}</tr>`;
    };

    panel.innerHTML = `
        <h3 style="margin: 0 0 6px 0; color:#00ff88;">🛡️ Convoy Route Comparison</h3>
        <div id="reroute-banner" class="reroute-banner" style="display:${rerouteMsg ? 'block' : 'none'};">${rerouteMsg || ''}</div>
        <table class="route-table">
            <thead><tr><th></th>${keys.map(k => `<th style="color:${routes[k].color};">${routes[k].name}</th>`).join('')}</tr></thead>
            <tbody>
                ${row('Distance', ms_.map(m => m.distanceKm), v => `${v.toFixed(2)} km`)}
                ${row(`ETA @ ${CONFIG.convoy.speedKmph} km/h`, ms_.map(m => m.etaMin), v => `${v.toFixed(0)} min`)}
                ${row('Route incident prob.', ms_.map(m => m.incidentProb), v => `${(100 * v).toFixed(2)}%`, true, 'P = 1 − Π(1 − p_i), Krumm & Horvitz 2017')}
                ${row('Mean segment risk', ms_.map(m => m.meanRisk), v => v.toFixed(1), true, 'length-weighted, 0-100')}
                ${row('Max segment risk', ms_.map(m => m.maxRisk), v => v.toFixed(0))}
                ${row('High-risk segments', ms_.map(m => m.highRiskSegments), v => v)}
                ${row('Exposure time (risk ≥ 60)', ms_.map(m => m.exposureMin), v => `${v.toFixed(1)} min`)}
                ${row('Chokepoints crossed', ms_.map(m => m.chokepoints), v => v)}
                ${row('Threat-zone segments', ms_.map(m => m.threatSegments), v => v)}
            </tbody>
        </table>
        <div class="lambda-control">
            <label>Balanced λ (risk weight): <b id="lambda-value">${customLambda.toFixed(2)}</b></label>
            <input type="range" id="lambda-slider" min="0" max="1" step="0.05" value="${customLambda}"
                oninput="document.getElementById('lambda-value').textContent=Number(this.value).toFixed(2)"
                onchange="setBalancedLambda(this.value)">
        </div>
        <div style="font-size:10px; color:#777; margin:4px 0 8px;">3 routes in ${ms.toFixed(0)} ms · risk from ML model on SYNTHETIC data</div>
        <button id="animate-route-btn" onclick="startRouteAnimation()" class="animate-btn">🚚 Animate Convoy (Safest)</button>
        <div id="animation-controls" style="display: none; margin-bottom: 8px;">
            <button id="stop-animation-btn" onclick="stopRouteAnimation()" class="stop-btn">⏹️ Stop Animation</button>
        </div>
        <button onclick="resetRouting()" class="reset-btn">🔄 Plan New Route</button>
    `;
    panel.style.display = 'block';
}

window.setBalancedLambda = function(v) {
    customLambda = Number(v);
    if (startNode && endNode) calculateConvoyRoutes(false);
};

// Transport mode selector removed

// Toggle routing mode
window.toggleRoutingMode = function() {
    routingMode = !routingMode;
    const btn = document.getElementById('routing-toggle-btn');
    const instructions = document.getElementById('routing-instructions');

    if (routingMode) {
        if (reportThreatMode) toggleReportThreatMode();
        btn.textContent = '🛑 Cancel Route Planning';
        btn.style.background = 'linear-gradient(135deg, #ff4444 0%, #cc0000 100%)';
        instructions.style.display = 'block';
        if (coverageArea) coverageArea.setStyle({ fillOpacity: 0.08, opacity: 0.6 });
    } else {
        btn.textContent = '🗺️ Plan Convoy Route';
        btn.style.background = 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)';
        instructions.style.display = 'none';
        if (coverageArea) coverageArea.setStyle({ fillOpacity: 0.03, opacity: 0.3 });
        resetRouting();
    }
};

// Reset routing state
window.resetRouting = function() {
    stopRouteAnimation();
    startNode = null;
    endNode = null;
    directLine = null;
    currentRoute = null;
    lastRoutes = null;
    routeLayers.forEach(layer => map.removeLayer(layer));
    routeLayers = [];
    markerLayers.forEach(marker => map.removeLayer(marker));
    markerLayers = [];
    const panel = document.getElementById('route-result');
    if (panel) panel.style.display = 'none';
};

// ============================================
// VEHICLE ANIMATION FUNCTIONS
// ============================================

// Start route animation
window.startRouteAnimation = function() {
    if (!currentRoute || !currentRoute.coordinates) {
        console.error('No route to animate');
        return;
    }
    
    // Stop any existing animation
    stopRouteAnimation();
    
        
    // Show/hide buttons
    document.getElementById('animate-route-btn').style.display = 'none';
    document.getElementById('animation-controls').style.display = 'block';
    
    // Create convoy marker (triangle)
    const startCoord = currentRoute.coordinates[0];
    vehicleMarker = L.marker([startCoord[1], startCoord[0]], {
        icon: L.divIcon({
            className: 'vehicle-marker',
            html: '<div style="width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-bottom: 25px solid #667eea; transform: rotate(0deg); filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));"></div>',
            iconSize: [30, 30],
            iconAnchor: [15, 25]
        }),
        zIndexOffset: 1000
    }).addTo(map);
    
    // Create risk popup
    riskPopup = L.popup({
        closeButton: false,
        autoClose: false,
        closeOnClick: false,
        className: 'risk-popup'
    });
    
    // Animation variables
    let currentSegment = 0;
    let progress = 0;
    const speed = 0.02; // Progress per frame (0-1), adjust for speed
    const delayMs = 30; // Frame delay in milliseconds
    
    // Animation loop
    animationInterval = setInterval(() => {
        if (currentSegment >= currentRoute.coordinates.length - 1) {
            // Animation complete
            stopRouteAnimation();
            return;
        }
        
        // Get current and next points
        const start = currentRoute.coordinates[currentSegment];
        const end = currentRoute.coordinates[currentSegment + 1];
        
        // Interpolate position
        const lat = start[1] + (end[1] - start[1]) * progress;
        const lon = start[0] + (end[0] - start[0]) * progress;
        
        // Calculate bearing (rotation) for triangle
        const bearing = calculateBearing(start[1], start[0], end[1], end[0]);
        
        // Update vehicle position
        vehicleMarker.setLatLng([lat, lon]);
        
        // Update vehicle rotation
        const vehicleElement = vehicleMarker.getElement();
        if (vehicleElement) {
            const triangle = vehicleElement.querySelector('div');
            if (triangle) {
                triangle.style.transform = `rotate(${bearing}deg)`;
            }
        }
        
        // Get current edge data for risk
        const edgeIndex = Math.min(currentSegment, currentRoute.edges.length - 1);
        const currentEdge = currentRoute.edges[edgeIndex];
        
        // Effective risk of the current segment under the live threat picture
        const w = currentEdge ? window.getAdjustedEdgeWeight(currentEdge) : 0;
        const riskScore = w === Infinity ? 100 : Math.min(100, w);
        const dangerLevel = w === Infinity ? { label: 'ROAD CLOSED', color: '#ff00ff' } : getDangerLevel(riskScore);
        const props = currentEdge && edgeFeatures[currentEdge.eid] ? edgeFeatures[currentEdge.eid].properties : {};
        const roadName = props.street_name || 'Unnamed road';

        const riskHtml = `
            <div style="text-align: center; min-width: 200px;">
                <div style="font-size: 24px; margin-bottom: 5px;">🚚</div>
                <div style="font-weight: bold; color: #00ff88; font-size: 14px; margin-bottom: 8px;">📍 ${escapeHtml(roadName)}</div>
                <div style="font-weight: bold; color: ${dangerLevel.color}; font-size: 16px; margin-bottom: 6px;">${dangerLevel.label}</div>
                <div style="font-size: 12px; color: #888;">Segment risk</div>
                <div style="font-size: 20px; font-weight: bold; color: ${dangerLevel.color};">${riskScore.toFixed(1)}</div>
                ${currentEdge && currentEdge.chokepoint ? '<div style="color:#ff9900; font-size:11px;">⚠️ Chokepoint</div>' : ''}
                <div style="margin-top: 6px; font-size: 11px; color: #aaa;">Segment ${currentSegment + 1}/${currentRoute.coordinates.length - 1}</div>
            </div>
        `;

        riskPopup.setLatLng([lat, lon]).setContent(riskHtml).openOn(map);
        
        // Update progress
        progress += speed;
        if (progress >= 1) {
            progress = 0;
            currentSegment++;
        }
        
    }, delayMs);
};

// Stop route animation
window.stopRouteAnimation = function() {
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }
    
    if (vehicleMarker) {
        map.removeLayer(vehicleMarker);
        vehicleMarker = null;
    }
    
    if (riskPopup) {
        map.closePopup(riskPopup);
        riskPopup = null;
    }
    
    // Show/hide buttons
    const animateBtn = document.getElementById('animate-route-btn');
    const controlsDiv = document.getElementById('animation-controls');
    
    if (animateBtn) animateBtn.style.display = 'block';
    if (controlsDiv) controlsDiv.style.display = 'none';
    
};

// Calculate bearing between two points (for triangle rotation)
function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360; // Normalize to 0-360
}

// ===========================
// THREAT REPORTING (click on map)
// ===========================

window.toggleReportThreatMode = function() {
    reportThreatMode = !reportThreatMode;
    const btn = document.getElementById('report-crime-btn');
    const panel = document.getElementById('report-crime-panel');
    if (reportThreatMode) {
        if (routingMode) {
            // keep the active route so it can re-route; just stop placing A/B
            routingMode = false;
            document.getElementById('routing-toggle-btn').textContent = '🗺️ Plan Convoy Route';
            document.getElementById('routing-toggle-btn').style.background = 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)';
            document.getElementById('routing-instructions').style.display = 'none';
        }
        btn.style.background = '#ff4444';
        btn.style.color = '#fff';
        btn.textContent = '🚨 Click map to place threat';
        panel.style.display = 'block';
        updateImpactDefault();
    } else {
        btn.style.background = 'rgba(255,68,68,0.2)';
        btn.style.color = '#ff4444';
        btn.textContent = '🚨 Report Threat';
        panel.style.display = 'none';
    }
};
window.toggleReportCrimeMode = window.toggleReportThreatMode;  // alias

window.updateImpactDefault = function() {
    const type = document.getElementById('crime-event-type').value;
    const slider = document.getElementById('threat-impact');
    slider.value = (THREAT_TYPES[type] || {}).impact || 60;
    updateImpactLabel();
};

window.updateImpactLabel = function() {
    const v = Number(document.getElementById('threat-impact').value);
    const el = document.getElementById('threat-impact-value');
    el.textContent = v >= CONFIG.convoy.hardBlockImpact ? `${v} (ROAD CLOSED)` : v;
    el.style.color = v >= CONFIG.convoy.hardBlockImpact ? '#ff00ff' : '#ffaa00';
};

// Handle threat placement click
function handleThreatClick(e) {
    const type = document.getElementById('crime-event-type').value;
    const impact = Number(document.getElementById('threat-impact').value);
    let location = 'Map-reported location';
    // name the location after the nearest road
    let bestD = Infinity;
    edgeFeatures.forEach(f => {
        if (!f) return;
        const c = f.geometry.coordinates[0];
        if (Math.abs(c[1] - e.latlng.lat) > 0.01 || Math.abs(c[0] - e.latlng.lng) > 0.01) return;
        const d = distanceToPolyline(e.latlng.lat, e.latlng.lng, f.geometry.coordinates);
        if (d < bestD) { bestD = d; location = f.properties.street_name; }
    });
    createThreatAtLocation(e.latlng.lat, e.latlng.lng, type, impact, location,
        'Operator-reported threat (manual map entry).');
}

// Clear all threats
window.clearThreats = function(notify = true) {
    threatEvents.forEach(event => {
        if (event.marker) map.removeLayer(event.marker);
        if (event.circle) map.removeLayer(event.circle);
    });
    threatEvents = [];
    if (notify) onThreatsChanged();
    else {
        threatEdgeImpact = new Map();
        updateAffectedEdges();
    }
};
window.clearCrimeEvents = window.clearThreats;  // alias

// Red overlay for edges inside threat zones (magenta = closed)
function updateAffectedEdges() {
    if (affectedEdgesLayer) {
        map.removeLayer(affectedEdgesLayer);
        affectedEdgesLayer = null;
    }
    if (threatEdgeImpact.size === 0) return;
    const feats = [];
    threatEdgeImpact.forEach((impact, eid) => {
        const f = edgeFeatures[eid];
        if (f) feats.push({ ...f, properties: { ...f.properties, threatImpact: impact } });
    });
    affectedEdgesLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        style: (f) => ({
            color: f.properties.threatImpact >= CONFIG.convoy.hardBlockImpact ? '#ff00ff' : '#ff0000',
            weight: 5,
            opacity: 0.9,
            className: 'affected-edge'
        }),
        interactive: false
    }).addTo(map);
}

// Run when DOM is ready
document.addEventListener('DOMContentLoaded', init);
