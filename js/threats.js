/**
 * Live threats: precise point + small, editable radius.
 *
 *  - one threat model for every source (map click, SITREP, intel feed)
 *  - per-type default impact / radius from threat_types.json (single source of truth)
 *  - map clicks snap to the nearest road (perpendicular projection)
 *  - SITREP that names only a road -> PIN MODE (operator clicks the exact point)
 *  - only the part of a road inside the circle is penalised and painted
 *
 * Depends on: Leaflet, js/threat-geo.js (ThreatGeo), js/ui.js (UI), app.js globals
 * (map, edgeFeatures, CONFIG, lastRoutes, startNode, endNode, calculateConvoyRoutes).
 */
(function () {
    'use strict';
    const { el, toast, confirmToast, escapeHtml } = UI;

    const T = {
        types: null,              // from threat_types.json
        hardBlock: 90,
        rMin: 25, rMax: 500, rStep: 25,
        list: [],                 // threat objects (see makeThreat)
        layers: new Map(),        // id -> {marker, circle}
        effects: new Map(),       // eid -> effect (ThreatGeo.computeThreatEffects)
        grid: null,               // ThreatGeo.SpatialGrid over edge geometries
        landmarks: [],
        overlay: null,
        reportMode: false,
        pin: null,                // {request, layer} while in pin mode
        preview: null,            // {data, marker, circle} while a SITREP preview is open
        listeners: [],            // callbacks(eventName, threat) - used by later milestones
    };
    window.Threats = T;

    // ------------------------------------------------------------------ setup
    T.loadTypes = async function () {
        try {
            const res = await fetch('threat_types.json');
            const tt = await res.json();
            T.types = tt.types;
            T.hardBlock = tt.hard_block_impact;
            T.rMin = tt.radius_min_m; T.rMax = tt.radius_max_m; T.rStep = tt.radius_step_m;
        } catch (e) {
            console.error('threat_types.json missing', e);
            T.types = { IED: { label: 'IED', short: 'IED', emoji: '💣', impact: 92, radius_m: 100 } };
        }
        CONFIG.convoy.hardBlockImpact = T.hardBlock;
        const sel = document.getElementById('threat-type');
        if (sel) {
            sel.innerHTML = '';
            for (const [k, v] of Object.entries(T.types)) sel.appendChild(el('option', { value: k }, `${v.emoji} ${v.label}`));
        }
        const rs = document.getElementById('threat-radius');
        if (rs) { rs.min = T.rMin; rs.max = T.rMax; rs.step = T.rStep; }
        T.applyTypeDefaults();
    };

    T.onGraphLoaded = async function () {
        T.grid = new ThreatGeo.SpatialGrid(250);
        edgeFeatures.forEach((f, eid) => { if (f) T.grid.insert(eid, f.geometry.coordinates); });
        try {
            T.landmarks = await (await fetch('data/landmarks.json')).json();
        } catch (e) {
            T.landmarks = [];
        }
    };

    T.typeInfo = (type) => (T.types && T.types[type]) || { label: type, short: String(type).toUpperCase(), emoji: '⚠️', impact: 60, radius_m: 100 };
    T.clampRadius = (r) => Math.max(T.rMin, Math.min(T.rMax, Math.round(Number(r) || 100)));
    T.on = (fn) => T.listeners.push(fn);
    const emit = (ev, t) => T.listeners.forEach(fn => { try { fn(ev, t); } catch (e) { console.error(e); } });

    // ------------------------------------------------------------------ location label
    const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const KIND_PRI = { bridge: 0, junction: 0, square: 1, police: 2, hospital: 2, fire_station: 2, station: 2, airport: 2,
                       market: 3, religious: 3, school: 3, landmark: 3, public: 4, park: 4 };
    const shortRoad = (n) => n.replace(/\bRoad\b/g, 'Rd').replace(/\bStreet\b/g, 'St');

    T.describeLocation = function (lat, lon) {
        let road = 'Off-road';
        const s = T.grid && T.grid.snap(lat, lon, 200);
        if (s) {
            road = edgeFeatures[s.eid].properties.street_name;
            if (road === 'Unnamed road') {
                const named = new Set([...T.grid.query(lat, lon, 150)].filter(id => edgeFeatures[id].properties.street_name !== 'Unnamed road'));
                const n = named.size ? T.grid.snap(lat, lon, 150, named) : null;
                road = n ? `Unnamed road off ${shortRoad(edgeFeatures[n.eid].properties.street_name)}` : 'Unnamed road';
            } else road = shortRoad(road);
        }
        let best = null;
        for (const lm of T.landmarks) {
            if (!(lm.kind in KIND_PRI)) continue;
            if (Math.abs(lm.lat - lat) > 0.008 || Math.abs(lm.lon - lon) > 0.01) continue;
            const d = getDistance(lat, lon, lm.lat, lm.lon);
            const score = d + 60 * KIND_PRI[lm.kind];
            if (d < 800 && (!best || score < best.score)) best = { score, d, lm };
        }
        if (!best) return road;
        if (best.d < 25) return `${road}, at ${best.lm.name}`;
        const p = ThreatGeo.toXY(lat, lon, { lat: best.lm.lat, lon: best.lm.lon });
        const ang = (Math.atan2(p[0], p[1]) * 180 / Math.PI + 360) % 360;
        return `${road}, ~${Math.round(best.d / 10) * 10} m ${COMPASS[Math.floor((ang + 22.5) / 45) % 8]} of ${best.lm.name}`;
    };

    // ------------------------------------------------------------------ model
    let seq = 0;
    T.newId = function () {
        const d = new Date();
        const p = (n, w = 2) => String(n).padStart(w, '0');
        seq = (seq + 1) % 1000;
        return `THR-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(seq, 3)}`;
    };

    T.makeThreat = function (o) {
        const info = T.typeInfo(o.type);
        const now = new Date();
        const ttl = info.ttl_min;
        return {
            id: o.id || T.newId(),
            lat: Number(o.lat), lon: Number(o.lon),
            radius_m: T.clampRadius(o.radius_m ?? info.radius_m),
            type: o.type,
            impact: Math.max(10, Math.min(100, Math.round(Number(o.impact ?? info.impact)))),
            location_label: o.location_label || o.location || T.describeLocation(o.lat, o.lon),
            resolution: o.resolution || 'map_click',
            confidence: o.confidence || 'high',
            source: o.source || 'manual_map',
            description: o.description || '',
            sitrep_text: o.sitrep_text || '',
            created_at: o.created_at || now.toISOString(),
            expires_at: o.expires_at !== undefined ? o.expires_at : (ttl ? new Date(now.getTime() + ttl * 60000).toISOString() : null),
            status: o.status || 'active',
        };
    };

    // Persistence: every create / edit / move / clear goes through the server API.
    // The UI updates from the API response and from SSE - never optimistically.
    async function api(method, url, body) {
        try {
            const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
                                           body: body ? JSON.stringify(body) : undefined });
            const data = await res.json();
            if (!res.ok) { toast(`Not saved: ${data.error || res.status}`, { type: 'danger' }); return null; }
            return data;
        } catch (e) {
            toast('Server unreachable - threat not saved', { type: 'danger' });
            return null;
        }
    }
    T.reporter = () => {
        const i = document.getElementById('reported-by');
        return (i && i.value.trim()) || 'Ops desk';
    };
    T.store = {
        create(t) {
            const { id, created_at, expires_at, status, ...body } = t;   // server assigns id / times / status
            return api('POST', '/api/threats', { ...body, reported_by: T.reporter() });
        },
        update(id, changes) { return api('PATCH', `/api/threats/${encodeURIComponent(id)}`, { ...changes, by: T.reporter() }); },
        remove(id) { return api('DELETE', `/api/threats/${encodeURIComponent(id)}?by=${encodeURIComponent(T.reporter())}`); },
    };

    T.loadFromServer = async function () {
        try {
            const data = await (await fetch('/api/threats?status=active')).json();
            data.records.forEach(r => T.upsertLocal(r, false));
            T.changed('loaded', null);
        } catch (e) {
            console.error('threat load failed', e);
        }
    };

    T.connectStream = function () {
        if (!window.EventSource) return;
        const es = new EventSource('/api/stream');
        ['threat_created', 'threat_updated', 'threat_cleared'].forEach(ev =>
            es.addEventListener(ev, (m) => T.upsertLocal(JSON.parse(m.data), true)));
        es.addEventListener('event_logged', (m) => emit('event_logged', JSON.parse(m.data)));
        es.addEventListener('convoy_position', (m) => emit('convoy_position', JSON.parse(m.data)));
        es.addEventListener('convoys_changed', (m) => emit('convoys_changed', JSON.parse(m.data)));
        es.onerror = () => { document.body.classList.add('stream-down'); };
        es.onopen = () => { document.body.classList.remove('stream-down'); };
        T.stream = es;
    };

    T.get = (id) => T.list.find(t => t.id === id);
    T.active = () => T.list.filter(t => t.status === 'active');

    T.add = async function (o, { notify = true } = {}) {
        const t = await T.store.create(T.makeThreat(o));
        if (!t) return null;
        T.upsertLocal(t, notify);
        return T.get(t.id) || t;
    };

    T.update = async function (id, changes) {
        const cur = T.get(id);
        if (!cur) return;
        if (changes.type && changes.type !== cur.type && changes.impact === undefined) changes.impact = T.typeInfo(changes.type).impact;
        if (changes.radius_m !== undefined) changes.radius_m = T.clampRadius(changes.radius_m);
        if (changes.lat !== undefined && changes.location_label === undefined) changes.location_label = T.describeLocation(changes.lat, changes.lon);
        const t = await T.store.update(id, changes);
        if (t) T.upsertLocal(t, true);
    };

    T.remove = async function (id) {
        const t = await T.store.remove(id);
        if (t) T.upsertLocal({ ...t, status: t.status || 'cleared' }, true);
    };

    /** Apply a threat record coming from the store / server / SSE to local state + map. */
    T.upsertLocal = function (t, notify = true) {
        if (!t || !t.id) return;
        const i = T.list.findIndex(x => x.id === t.id);
        const isNew = i < 0;
        if (!isNew && (T.list[i].version || 0) >= (t.version || 0)) return;   // API response + SSE echo: apply once
        if (isNew) T.list.push(t); else T.list[i] = t;
        if (t.status === 'active') drawThreat(t); else undrawThreat(t.id);
        if (notify) T.changed(isNew ? 'threat_created' : (t.status === 'active' ? 'threat_updated' : 'threat_cleared'), t);
    };

    T.clearAll = async function () {
        for (const t of T.active()) await T.remove(t.id);
    };

    // ------------------------------------------------------------------ effects + re-route
    T.changed = function (ev, t) {
        T.effects = ThreatGeo.computeThreatEffects(T.active(), T.grid, T.hardBlock);
        drawOverlay();
        emit(ev, t);
        if (typeof startNode !== 'undefined' && startNode && endNode && lastRoutes) calculateConvoyRoutes(true);
        if (T.renderList) T.renderList();
    };

    T.effectOf = (eid) => T.effects.get(eid);
    window.getAdjustedEdgeWeight = (edge) => ThreatGeo.effectiveWeight(edge.weight, T.effects.get(edge.eid));
    window.getAdjustedEdgeProb = (edge) => ThreatGeo.effectiveProb(edge.p_traverse || 0, T.effects.get(edge.eid));

    function drawOverlay() {
        if (T.overlay) map.removeLayer(T.overlay);
        T.overlay = L.layerGroup();
        const svg = L.svg({ padding: 0.3 });
        T.effects.forEach((eff, eid) => {
            if (eff.hard) {   // full link thin dashed: shows which junction-to-junction link is closed
                const f = edgeFeatures[eid];
                L.polyline(f.geometry.coordinates.map(c => [c[1], c[0]]), {
                    renderer: svg, color: 'var(--closed, #ff00ff)', weight: 2, opacity: 0.85, dashArray: '4 6', interactive: false
                }).addTo(T.overlay);
            }
            eff.pieces.forEach(p => {
                L.polyline(p.latlngs, {
                    renderer: svg, weight: 6, opacity: 0.95, interactive: false, lineCap: 'round',
                    color: p.impact >= T.hardBlock ? '#ff00ff' : '#ff2d2d'
                }).addTo(T.overlay);
            });
        });
        T.overlay.addTo(map);
    }

    // ------------------------------------------------------------------ drawing
    function colorFor(t) { return t.impact >= T.hardBlock ? '#ff00ff' : '#ff3b3b'; }

    function markerIcon(t) {
        return L.divIcon({
            className: 'threat-marker-wrap',
            html: `<div class="threat-marker ${t.impact >= T.hardBlock ? 'is-closed' : ''}">${T.typeInfo(t.type).emoji}</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13]
        });
    }

    function drawThreat(t) {
        let L_ = T.layers.get(t.id);
        if (!L_) {
            const marker = L.marker([t.lat, t.lon], { icon: markerIcon(t), draggable: true, zIndexOffset: 2000, autoPan: true });
            const circle = L.circle([t.lat, t.lon], { radius: t.radius_m, interactive: false, weight: 2 });
            marker.on('dragend', () => {
                const p = marker.getLatLng();
                const s = T.grid.snap(p.lat, p.lng, 150);
                const pos = s ? { lat: s.lat, lon: s.lon } : { lat: p.lat, lon: p.lng };
                T.update(t.id, { ...pos, resolution: 'operator_pin', confidence: s ? 'high' : 'low' });
            });
            marker.on('drag', () => circle.setLatLng(marker.getLatLng()));
            marker.bindPopup(() => popupContent(T.get(t.id)), { minWidth: 260, maxWidth: 320 });
            L_ = { marker, circle };
            marker.addTo(map);
            circle.addTo(map);
            T.layers.set(t.id, L_);
        }
        const c = colorFor(t);
        L_.marker.setLatLng([t.lat, t.lon]).setIcon(markerIcon(t));
        // the drawn circle IS the routing radius - one value, never drifts
        L_.circle.setLatLng([t.lat, t.lon]).setRadius(t.radius_m)
            .setStyle({ color: c, fillColor: c, fillOpacity: t.impact >= T.hardBlock ? 0.22 : 0.14, dashArray: t.impact >= T.hardBlock ? null : '5 5' });
    }

    function undrawThreat(id) {
        const L_ = T.layers.get(id);
        if (!L_) return;
        map.removeLayer(L_.marker);
        map.removeLayer(L_.circle);
        T.layers.delete(id);
    }

    T.locate = function (id) {
        const t = T.get(id);
        if (!t) return;
        map.setView([t.lat, t.lon], Math.max(map.getZoom(), 16));
        const L_ = T.layers.get(id);
        if (L_) L_.marker.openPopup();
    };

    function popupContent(t) {
        if (!t) return 'Threat removed';
        const info = T.typeInfo(t.type);
        const closed = t.impact >= T.hardBlock;
        const root = el('div', { class: 'threat-popup' });
        root.appendChild(el('div', { class: 'tp-title', style: null }, `${info.emoji} ${info.label}`));
        root.appendChild(el('div', { class: 'tp-loc' }, t.location_label));
        root.appendChild(el('div', { class: 'tp-meta' },
            el('span', { class: `badge conf-${t.confidence}` }, `${t.resolution} · ${t.confidence}`),
            el('span', { class: 'tp-id' }, t.id)));
        if (t.description) root.appendChild(el('div', { class: 'tp-desc' }, t.description));
        if (t.sitrep_text && t.source === 'sitrep_text') root.appendChild(el('div', { class: 'tp-sitrep' }, `“${t.sitrep_text}”`));

        const typeSel = el('select', { class: 'input' });
        for (const [k, v] of Object.entries(T.types)) typeSel.appendChild(el('option', { value: k, selected: k === t.type }, v.label));
        const imp = el('input', { type: 'range', min: 10, max: 100, step: 1, value: t.impact, class: 'range' });
        const impV = el('b', { class: 'num' }, impactText(t.impact));
        const rad = el('input', { type: 'range', min: T.rMin, max: T.rMax, step: T.rStep, value: t.radius_m, class: 'range' });
        const radV = el('b', { class: 'num' }, `${t.radius_m} m`);
        imp.addEventListener('input', () => { impV.textContent = impactText(+imp.value); });
        rad.addEventListener('input', () => { radV.textContent = `${rad.value} m`; });
        typeSel.addEventListener('change', () => {
            const d = T.typeInfo(typeSel.value);
            imp.value = d.impact; rad.value = d.radius_m;
            impV.textContent = impactText(d.impact); radV.textContent = `${d.radius_m} m`;
        });
        root.appendChild(el('label', { class: 'field' }, el('span', {}, 'Type'), typeSel));
        const tipEl = (k) => { const sp = el('span', {}); sp.innerHTML = window.Guide ? ' ' + Guide.tip(k) : ''; return sp; };
        root.appendChild(el('label', { class: 'field' }, el('span', {}, 'Impact ', impV, tipEl('impact')), imp));
        root.appendChild(el('label', { class: 'field' }, el('span', {}, 'Radius ', radV, tipEl('radius')), rad));
        const eff = el('div', { class: 'tp-effect' }, closed ? 'Effect: ROAD CLOSED (hard block) '
            : `Effect: risk ×${(1 + 3 * t.impact / 100).toFixed(1)} on the part of each road inside the circle `);
        if (window.Guide) eff.insertAdjacentHTML('beforeend', Guide.tip(closed ? 'impact' : 'multiplier'));
        root.appendChild(eff);
        root.appendChild(el('div', { class: 'tp-actions' },
            el('button', { class: 'btn btn-primary btn-sm', onclick: () => {
                map.closePopup();
                T.update(t.id, { type: typeSel.value, impact: +imp.value, radius_m: +rad.value });
            } }, 'Apply'),
            el('button', { class: 'btn btn-danger btn-sm', onclick: () => { map.closePopup(); T.remove(t.id); } }, 'Delete')));
        root.appendChild(el('div', { class: 'tp-hint' }, 'Drag the marker to move it. SYNTHETIC - for demonstration only'));
        return root;
    }

    function impactText(v) { return v >= T.hardBlock ? `${v} (ROAD CLOSED)` : String(v); }
    T.impactText = impactText;

    // ------------------------------------------------------------------ report mode (map click)
    T.applyTypeDefaults = function () {
        const sel = document.getElementById('threat-type');
        if (!sel || !T.types) return;
        const d = T.typeInfo(sel.value);
        const imp = document.getElementById('threat-impact');
        const rad = document.getElementById('threat-radius');
        if (imp) imp.value = d.impact;
        if (rad) rad.value = d.radius_m;
        T.updateSliderLabels();
    };

    T.updateSliderLabels = function () {
        const imp = document.getElementById('threat-impact');
        const rad = document.getElementById('threat-radius');
        const iv = document.getElementById('threat-impact-value');
        const rv = document.getElementById('threat-radius-value');
        if (imp && iv) { iv.textContent = impactText(+imp.value); iv.classList.toggle('is-closed', +imp.value >= T.hardBlock); }
        if (rad && rv) rv.textContent = `${rad.value} m`;
    };

    T.setReportMode = function (on) {
        T.reportMode = on;
        document.body.classList.toggle('mode-report', on);
        const btn = document.getElementById('report-threat-btn');
        if (btn) {
            btn.classList.toggle('is-active', on);
            const sp = btn.querySelector('span');
            if (sp) sp.textContent = on ? 'Placing… (Esc to stop)' : 'Click map to place';
        }
        if (on) {
            if (typeof routingMode !== 'undefined' && routingMode) toggleRoutingMode(true);  // keep the active route
            if (window.Shell) Shell.switchTab('threats');
            toast('Click the map to place the threat. It snaps to the nearest road. Esc to stop.', { type: 'info' });
        }
    };

    function currentFormThreat() {
        return {
            type: document.getElementById('threat-type').value,
            impact: +document.getElementById('threat-impact').value,
            radius_m: +document.getElementById('threat-radius').value,
        };
    }

    function placeAt(lat, lon, extra) {
        return T.add({ ...currentFormThreat(), lat, lon, source: 'manual_map', description: 'Operator-reported threat (manual map entry).', ...extra });
    }

    function snapLine(from, to) {
        const line = L.polyline([from, to], { color: '#ffffff', weight: 1.5, dashArray: '3 4', opacity: 0.9, interactive: false }).addTo(map);
        setTimeout(() => map.removeLayer(line), 5000);
    }

    T.handleMapClick = function (e) {
        if (T.pin) { handlePinClick(e); return true; }
        if (!T.reportMode) return false;
        const { lat, lng } = e.latlng;
        const s = T.grid.snap(lat, lng, 150);
        if (s) {
            if (s.dist > 10) snapLine([lat, lng], [s.lat, s.lon]);
            placeAt(s.lat, s.lon, { resolution: 'map_click', confidence: 'high' });
        } else {
            confirmToast('No road within 150 m. Place the threat off-road anyway?', () =>
                placeAt(lat, lng, { resolution: 'map_click', confidence: 'low' }), { yes: 'Place off-road' });
        }
        return true;
    };

    // ------------------------------------------------------------------ pin mode
    T.startPin = function (req) {
        T.cancelPin(true);
        T.setReportMode(false);
        const svg = L.svg({ padding: 0.3 });
        const layer = L.layerGroup();
        const eids = new Set(req.street_eids);
        const bounds = [];
        eids.forEach(eid => {
            const f = edgeFeatures[eid];
            if (!f) return;
            const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
            bounds.push(...ll);
            L.polyline(ll, { renderer: svg, className: 'pin-highlight', weight: 8, interactive: false }).addTo(layer);
        });
        layer.addTo(map);
        if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [80, 80], maxZoom: 16 });
        T.pin = { req, eids, layer };
        document.body.classList.add('mode-pin');
        T.pinToast = toast(`${req.message}  (Esc to cancel)`, { type: 'warn', timeout: 0,
            actions: [{ label: 'Cancel', onClick: () => T.cancelPin() }] });
    };

    T.cancelPin = function (silent) {
        if (!T.pin) return;
        map.removeLayer(T.pin.layer);
        T.pin = null;
        document.body.classList.remove('mode-pin');
        if (T.pinToast) { T.pinToast.close(); T.pinToast = null; }
        if (!silent) toast('Pin cancelled', { type: 'info', timeout: 1500 });
    };

    function handlePinClick(e) {
        const { lat, lng } = e.latlng;
        const s = T.grid.snap(lat, lng, 60, T.pin.eids);
        if (!s) {
            toast(`Click on the highlighted ${T.pin.req.street} (within 60 m).`, { type: 'warn' });
            return;
        }
        const r = T.pin.req;
        if (s.dist > 10) snapLine([lat, lng], [s.lat, s.lon]);
        T.cancelPin(true);
        T.add({ lat: s.lat, lon: s.lon, type: r.type, impact: r.impact, radius_m: r.radius_m,
                resolution: 'operator_pin', confidence: 'high', source: 'sitrep_text',
                sitrep_text: r.sitrep_text, description: r.description });
        toast('Threat pinned', { type: 'ok', timeout: 1800 });
    }

    // ------------------------------------------------------------------ SITREP
    T.parseSitrep = async function () {
        const input = document.getElementById('sitrep-input');
        const text = (input.value || '').trim();
        if (!text) return;
        T.closePreview();
        const status = document.getElementById('sitrep-status');
        status.innerHTML = '<span class="muted">Parsing SITREP…</span>';
        try {
            const res = await fetch('/parse-sitrep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
            const r = await res.json();
            status.innerHTML = '';
            if (r.status === 'needs_pin') {
                T.startPin(r);
                status.innerHTML = `<span class="warn-text">Pin required: ${escapeHtml(r.street)} (${r.street_length_km} km)</span>`;
            } else if (r.status === 'ok') {
                showPreview(r);
            } else {
                status.innerHTML = `<span class="danger-text">${escapeHtml(r.message || r.error || 'Could not parse')}</span>`;
                if (r.candidates) status.innerHTML += '<ul class="cand-list">' + r.candidates.map(c =>
                    `<li>${escapeHtml(c.name)} <span class="muted">(${c.kind}, ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)})</span></li>`).join('') + '</ul>';
                toast('SITREP could not be located - see the Threats tab', { type: 'danger' });
            }
        } catch (err) {
            console.error(err);
            status.innerHTML = '<span class="danger-text">SITREP service unavailable</span>';
        }
    };

    function showPreview(r) {
        const info = T.typeInfo(r.type);
        const c = r.impact >= T.hardBlock ? '#ff00ff' : '#ff3b3b';
        const marker = L.marker([r.lat, r.lon], { draggable: true, icon: L.divIcon({ className: 'threat-marker-wrap',
            html: `<div class="threat-marker is-preview">${info.emoji}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
        const circle = L.circle([r.lat, r.lon], { radius: r.radius_m, color: c, fillColor: c, fillOpacity: 0.1, dashArray: '2 6', interactive: false }).addTo(map);
        let moved = false;
        marker.on('drag', () => circle.setLatLng(marker.getLatLng()));
        marker.on('dragend', () => {
            const p = marker.getLatLng();
            const s = T.grid.snap(p.lat, p.lng, 150);
            if (s) marker.setLatLng([s.lat, s.lon]);
            circle.setLatLng(marker.getLatLng());
            moved = true;
            const lbl = document.querySelector('#sitrep-preview .pv-loc');
            if (lbl) lbl.textContent = T.describeLocation(marker.getLatLng().lat, marker.getLatLng().lng);
        });
        T.preview = { data: r, marker, circle, moved: () => moved };
        map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));

        const host = document.getElementById('sitrep-preview');
        host.innerHTML = '';
        host.appendChild(el('div', { class: 'preview-card' },
            el('div', { class: 'pv-head' }, el('b', {}, `${info.emoji} ${info.label}`),
                el('span', { class: `badge conf-${r.confidence}`, title: 'Location confidence - see the Guide' }, r.confidence)),
            el('div', { class: 'pv-loc' }, r.location_label),
            el('div', { class: 'pv-grid' },
                el('span', {}, 'Impact'), el('b', { class: 'num' }, impactText(r.impact)),
                el('span', {}, 'Radius'), el('b', { class: 'num' }, `${r.radius_m} m`),
                el('span', {}, 'Method'), el('b', {}, r.resolution),
                el('span', {}, 'Parser'), el('b', { class: 'muted' }, r.parser || '')),
            el('div', { class: 'pv-actions' },
                el('button', { class: 'btn btn-primary btn-sm', onclick: confirmPreview }, 'Confirm'),
                el('button', { class: 'btn btn-secondary btn-sm', onclick: () => {
                    map.setView(marker.getLatLng(), 17);
                    toast('Drag the dashed marker to adjust, then Confirm.', { type: 'info' });
                } }, 'Adjust'),
                el('button', { class: 'btn btn-ghost btn-sm', onclick: () => map.setView(marker.getLatLng(), 16) }, 'Locate'),
                el('button', { class: 'btn btn-ghost btn-sm', onclick: () => T.closePreview() }, 'Cancel'))));
    }

    function confirmPreview() {
        const p = T.preview;
        if (!p) return;
        const pos = p.marker.getLatLng();
        const r = p.data;
        const moved = p.moved();
        T.closePreview();
        T.add({ lat: pos.lat, lon: pos.lng, type: r.type, impact: r.impact, radius_m: r.radius_m,
                location_label: moved ? undefined : r.location_label,
                resolution: moved ? 'operator_pin' : r.resolution, confidence: moved ? 'high' : r.confidence,
                source: 'sitrep_text', sitrep_text: r.sitrep_text, description: r.description });
        document.getElementById('sitrep-input').value = '';
        toast('Threat added from SITREP', { type: 'ok', timeout: 1800 });
    }

    T.closePreview = function () {
        if (!T.preview) return;
        map.removeLayer(T.preview.marker);
        map.removeLayer(T.preview.circle);
        T.preview = null;
        const host = document.getElementById('sitrep-preview');
        if (host) host.innerHTML = '';
    };

    // ------------------------------------------------------------------ intel feed
    T.fetchIntel = async function () {
        const data = await api('POST', '/api/intel/apply');
        if (!data) return;
        data.records.forEach(r => T.upsertLocal(r, false));
        T.changed('intel_loaded', null);
        const closed = data.records.filter(r => r.impact >= T.hardBlock).length;
        toast(data.records.length
            ? `${data.records.length} intel report(s) active (${data.activated} new) · ${closed} road closure(s) · SYNTHETIC`
            : 'No intel reports in the database', { type: data.records.length ? 'ok' : 'warn' });
    };

    // ------------------------------------------------------------------ active threat list (Threats tab)
    T.renderList = function () {
        const host = document.getElementById('threat-list');
        const act = T.active();
        const badge = document.getElementById('threat-count');
        if (badge) { badge.textContent = act.length; badge.hidden = act.length === 0; }
        if (!host) return;
        host.innerHTML = '';
        if (!act.length) { host.appendChild(el('p', { class: 'muted' }, 'No active threats.')); return; }
        act.slice().sort((a, b) => b.impact - a.impact).forEach(t => {
            const info = T.typeInfo(t.type);
            host.appendChild(el('div', { class: `threat-row ${t.impact >= T.hardBlock ? 'is-closed' : ''}` },
                el('span', {}, info.emoji),
                el('div', {},
                    el('div', { class: 'tr-title' }, `${info.label} · ${impactText(t.impact)} · ${t.radius_m} m`),
                    el('div', { class: 'tr-sub', title: t.location_label }, `${t.location_label} · ${t.source.replace('_', ' ')}`)),
                el('div', { class: 'tr-actions' },
                    el('button', { class: 'btn btn-ghost btn-icon', title: 'Locate', 'aria-label': 'Locate', onclick: () => T.locate(t.id),
                                   html: '<svg class="icon"><use href="#i-locate"/></svg>' }),
                    el('button', { class: 'btn btn-ghost btn-icon', title: 'Clear', 'aria-label': 'Clear', onclick: () => T.remove(t.id),
                                   html: '<svg class="icon"><use href="#i-trash"/></svg>' }))));
        });
    };

    // Esc cancels pin / report / preview
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (T.pin) T.cancelPin();
        else if (T.preview) T.closePreview();
        else if (T.reportMode) T.setReportMode(false);
    });
})();
