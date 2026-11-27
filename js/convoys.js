/**
 * Convoys tab (M14): plan several convoys at once so they do not meet head-on on bridges /
 * chokepoints / narrow roads, do not bunch up, and get recommended start-point (SP) times.
 * Logic lives in js/deconflict.js (pure, unit-tested); this file is the UI + map + live glue.
 */
(function () {
    'use strict';
    const { el, toast, escapeHtml } = UI;
    const D = Deconflict;
    const PALETTE = ['#4ea1ff', '#ff9f43', '#a78bfa', '#2ee6a6', '#ff6b9d', '#ffd166', '#5eead4', '#f87171'];
    const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium' };
    const TYPE_LABEL = { head_on: 'Head-on', bunching: 'Bunching', junction: 'Junction crossing', threat: 'Shared threat exposure' };

    const C = {
        list: [],                  // convoy records from /api/convoys
        planned: new Map(),        // id -> {route, routeCost, spMin, occ}
        result: null,              // {conflicts, recommendations, plans}
        settings: { bufferMin: 3, minSepMin: 10 },
        layers: null,
        picking: null,             // {id, which: 'start'|'dest'}
        seenLive: new Set(),
        startMin: null,
    };
    window.Convoys = C;

    // ------------------------------------------------------------------ server
    async function api(method, url, body) {
        try {
            const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
            const data = await res.json();
            if (!res.ok) { toast(`Convoy not saved: ${data.error || res.status}`, { type: 'danger' }); return null; }
            return data;
        } catch (e) { toast('Server unreachable', { type: 'danger' }); return null; }
    }
    C.load = async function () {
        const d = await api('GET', '/api/convoys');
        C.list = d ? d.records : [];
        C.replan();
    };
    C.add = async function (rec) {
        const n = C.list.length;
        const r = await api('POST', '/api/convoys', {
            call_sign: `${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'][n % 8]}-${n + 1}`,
            color: PALETTE[n % PALETTE.length], sp_time: '07:30', priority: Math.min(3, n + 1),
            start: startNode ? { lat: startNode.lat, lon: startNode.lon } : null, dest: endNode ? { lat: endNode.lat, lon: endNode.lon } : null,
            ...(rec || {}) });
        if (r) { upsertLocal(r); C.replan(); }
        return r;
    };
    C.patch = async function (id, changes) {
        if (C.overrides && ('start' in changes || 'dest' in changes || 'profile' in changes)) C.overrides.delete(id);
        const r = await api('PATCH', `/api/convoys/${id}`, changes);
        if (r) { upsertLocal(r); C.replan(); }
    };
    C.remove = async function (id) {
        const r = await api('DELETE', `/api/convoys/${id}`);
        if (r) { C.list = C.list.filter(x => x.id !== id); C.replan(); }
    };
    function upsertLocal(r) {
        const i = C.list.findIndex(x => x.id === r.id);
        if (i < 0) C.list.push(r); else if ((C.list[i].version || 0) <= (r.version || 0)) C.list[i] = r;
    }

    C.loadDemo = async function () {
        for (const c of C.list.slice()) await api('DELETE', `/api/convoys/${c.id}`);
        C.list = [];
        const north = { lat: 34.10535, lon: 74.79728 }, south = { lat: 34.07383, lon: 74.80459 };
        await C.add({ call_sign: 'Alpha-1', color: PALETTE[0], start: south, dest: north, sp_time: '07:30', priority: 1, profile: 'balanced' });
        await C.add({ call_sign: 'Bravo-2', color: PALETTE[1], start: north, dest: south, sp_time: '07:32', priority: 2, profile: 'balanced' });
        await C.add({ call_sign: 'Charlie-3', color: PALETTE[2], start: south, dest: north, sp_time: '07:34', priority: 3, profile: 'balanced' });
        toast('Demo: 3 convoys between both banks of the Jhelum at similar SP times - their routes share river-bridge chokepoints (SYNTHETIC)', { type: 'info', timeout: 5000 });
    };

    // ------------------------------------------------------------------ planning
    const lambdaOf = (p) => (p === 'balanced' ? customLambda : ROUTE_LAMBDAS[p]);
    function edgeInfo(eid) {
        const f = edgeFeatures[eid];
        if (!f) return {};
        const p = f.properties, ft = p.features || {};
        return { bridge: !!p.bridge, chokepoint: !!p.chokepoint, narrow: (ft.lanes || 2) <= 1 && (ft.road_priority || 0.3) <= 0.5,
                 unpaved: ft.unpaved === 1, name: p.street_name !== 'Unnamed road' ? p.street_name : (p.bridge ? 'unnamed bridge' : 'unnamed road') };
    }
    function threatEdges() {
        const m = new Map();
        Threats.effects.forEach((eff, eid) => m.set(eid, eff.parts.map(p => p.threatId)));
        return m;
    }
    const costOf = (route, lambda) => Reroute.routeCost(route.edges, (e) => window.getAdjustedEdgeWeight(e), lambda, (graphMeta && graphMeta.L_ref) || 100);
    const vMpm = (c) => c.speed_kmph * 1000 / 60;

    function planRoute(rec, extra) {
        if (!extra && C.overrides && C.overrides.has(rec.id)) {   // accepted alternative route
            const route = C.overrides.get(rec.id);
            return { route, routeCost: costOf(route, lambdaOf(rec.profile)), destId: String(route.path[route.path.length - 1]) };
        }
        if (!rec.start || !rec.dest || !routingGraph) return null;
        const a = findNearestNode(rec.start.lat, rec.start.lon, nodesList), b = findNearestNode(rec.dest.lat, rec.dest.lon, nodesList);
        if (!a || !b || a.id === b.id) return null;
        const lam = lambdaOf(rec.profile);
        const opts = { ...routingOptions(), ...(extra || {}) };
        const route = astar(routingGraph.adjacency_list, nodesLookup, String(a.id), String(b.id), extra && extra.lambda != null ? extra.lambda : lam, opts);
        return route ? { route, routeCost: costOf(route, lam), destId: String(b.id) } : null;
    }

    function toModel(rec, p) {
        return { id: rec.id, callSign: rec.call_sign, priority: rec.priority, spMin: D.parseHM(rec.sp_time), speedKmph: rec.speed_kmph,
                 vehicles: rec.vehicles, spacing: rec.spacing_m, route: p.route, routeCost: p.routeCost, profile: rec.profile };
    }

    C.replan = function () {
        C.planned.clear();
        const models = [];
        for (const rec of C.list) {
            const p = planRoute(rec);
            if (!p) continue;
            C.planned.set(rec.id, p);
            models.push(toModel(rec, p));
        }
        const opts = C.settings;
        const det = D.detectAll(models, edgeInfo, threatEdges(), opts);
        const res = D.resolve(models, {
            edgeInfo, threatEdges: threatEdges(),
            planAlt: (cv, reserved, blocked) => {
                const rec = C.list.find(x => x.id === cv.id);
                const pen = (e) => (blocked.has(e.eid) ? Infinity : window.getAdjustedEdgeWeight(e) + (reserved.has(e.eid) ? 400 : 0));
                const lam = Math.max(0.5, lambdaOf(rec.profile));   // so the reservation penalty also bites for 'fastest'
                const r = planRoute(rec, { edgeWeight: pen, lambda: lam });
                return r ? { route: r.route, routeCost: costOf(r.route, lambdaOf(rec.profile)) } : null;
            },
            costToMin: (cv, dCost) => dCost * ((graphMeta && graphMeta.L_ref) || 100) / (cv.speedKmph * 1000 / 60),
        }, opts);
        C.result = { conflicts: det.conflicts, occ: det.occ, models, ...res };
        drawMap();
        C.render();
    };

    // ------------------------------------------------------------------ recommendations
    function recText(r) {
        const me = C.list.find(x => x.id === r.convoyId), other = C.list.find(x => x.id === r.otherId);
        const cf = r.conflict;
        const what = `${TYPE_LABEL[cf.type].toLowerCase()} with ${other ? other.call_sign : '?'}${cf.where ? ` on ${cf.where}` : ''}`;
        if (r.kind === 'delay') return `${me.call_sign}: delay SP by ${r.delayMin} min (${D.fmtHM(r.fromSp)} → ${D.fmtHM(r.toSp)}) to avoid ${what}`;
        if (r.kind === 'reroute') return `${me.call_sign}: take an alternative route (same SP ${D.fmtHM(r.fromSp)}) to avoid ${what}`;
        if (r.kind.endsWith('-partial')) return `${me.call_sign}: best option is to ${r.kind.startsWith('delay') ? `delay SP by ${r.delayMin} min` : 'reroute'} - ${r.remaining.length} conflict(s) remain (${what})`;
        return `${me.call_sign}: unresolved ${what} - adjust manually`;
    }

    C.accept = async function (convoyId) {
        const plan = C.result.plans.get(convoyId);
        const rec = C.list.find(x => x.id === convoyId);
        if (!plan || !rec) return;
        if (plan.rerouted) {
            // keep the alternative by pinning it: store as an override used until the convoy changes
            C.overrides = C.overrides || new Map();
            C.overrides.set(convoyId, plan.route);
        }
        await C.patch(convoyId, { sp_time: D.fmtHM(plan.spMin) });
        toast(`${rec.call_sign}: recommendation accepted`, { type: 'ok', timeout: 1800 });
    };
    C.acceptAll = async function () {
        const recs = (C.result && C.result.recommendations) || [];
        for (const r of recs) if (r.kind !== 'unresolved') await C.accept(r.convoyId);
    };

    // ------------------------------------------------------------------ map
    function drawMap() {
        if (C.layers) map.removeLayer(C.layers);
        C.layers = L.layerGroup();
        if (Shell.current !== 'convoys' && !Live.convoys.size) { return; }
        C.list.forEach(rec => {
            const p = C.planned.get(rec.id);
            if (rec.start) L.circleMarker([rec.start.lat, rec.start.lon], { radius: 6, color: rec.color, fillColor: rec.color, fillOpacity: 1, weight: 2 }).bindTooltip(`${rec.call_sign} SP`).addTo(C.layers);
            if (rec.dest) L.circleMarker([rec.dest.lat, rec.dest.lon], { radius: 6, color: '#fff', fillColor: rec.color, fillOpacity: 1, weight: 2 }).bindTooltip(`${rec.call_sign} RP`).addTo(C.layers);
            if (p && !Live.convoys.has(rec.id)) L.polyline(routeLatLngs(p.route), { color: rec.color, weight: 4, opacity: 0.85, interactive: false }).addTo(C.layers);
        });
        (C.result ? C.result.conflicts : []).forEach(cf => {
            const ll = conflictLatLng(cf);
            if (!ll) return;
            const a = C.list.find(x => x.id === cf.a), b = C.list.find(x => x.id === cf.b);
            L.marker(ll, { icon: L.divIcon({ className: 'conflict-icon-wrap', html: `<div class="conflict-icon ${SEV_CLASS[cf.severity]}">!</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 2200 })
                .bindPopup(`<div class="popup-title">${TYPE_LABEL[cf.type]} · ${cf.severity.toUpperCase()}</div>
                    <div class="popup-stat">${escapeHtml(a ? a.call_sign : cf.a)} <span>${D.fmtHM(cf.tA)}</span></div>
                    <div class="popup-stat">${escapeHtml(b ? b.call_sign : cf.b)} <span>${D.fmtHM(cf.tB)}</span></div>
                    <div class="popup-stat">Where <span>${escapeHtml(cf.where || '')}</span></div>
                    <div class="popup-flag muted">Overlap ${D.fmtHM(cf.t0)}–${D.fmtHM(cf.t1)} (incl. ${C.settings.bufferMin} min buffer)</div>`)
                .addTo(C.layers);
        });
        C.layers.addTo(map);
    }
    function conflictLatLng(cf) {
        if (cf.eid != null && edgeFeatures[cf.eid]) {
            const co = edgeFeatures[cf.eid].geometry.coordinates;
            const c = co[Math.floor(co.length / 2)];
            return [c[1], c[0]];
        }
        if (cf.node != null && nodesLookup[cf.node]) return [nodesLookup[cf.node].lat, nodesLookup[cf.node].lon];
        return null;
    }

    // ------------------------------------------------------------------ map picking
    C.pick = function (id, which) {
        C.picking = { id, which };
        document.body.classList.add('mode-route');
        toast(`Click the map to set the ${which === 'start' ? 'start point (SP)' : 'destination (RP)'}. Esc cancels.`, { type: 'info' });
    };
    C.handleMapClick = function (e) {
        if (!C.picking) return false;
        const { id, which } = C.picking;
        C.picking = null;
        document.body.classList.remove('mode-route');
        const n = findNearestNode(e.latlng.lat, e.latlng.lng, nodesList);
        if (n) C.patch(id, { [which]: { lat: n.lat, lon: n.lon } });
        return true;
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && C.picking) { C.picking = null; document.body.classList.remove('mode-route'); } });

    // ------------------------------------------------------------------ march table + CSV
    function marchRows(rec) {
        const p = C.planned.get(rec.id);
        const plan = C.result && C.result.plans.get(rec.id);
        if (!p) return [];
        const sp = D.parseHM(rec.sp_time);
        const v = vMpm(rec);
        const rows = [{ point: 'SP (start point)', eta: sp, km: 0 }];
        let dist = 0, last = null;
        p.route.edges.forEach(e => {
            const info = edgeInfo(e.eid);
            if ((info.bridge || info.chokepoint) && info.name !== last) {
                rows.push({ point: `${info.bridge ? 'Bridge' : 'Chokepoint'}: ${info.name}`, eta: sp + dist / v, km: dist / 1000 });
                last = info.name;
            } else if (!(info.bridge || info.chokepoint)) last = null;
            dist += e.length_m;
        });
        rows.push({ point: 'RP (release point)', eta: sp + dist / v, km: dist / 1000 });
        rows.recommendedDelay = plan ? plan.delayMin : 0;
        return rows;
    }
    C.exportCSV = function () {
        const lines = ['call_sign,priority,point,eta,km_from_sp'];
        C.list.forEach(rec => marchRows(rec).forEach(r => lines.push([rec.call_sign, rec.priority, `"${r.point.replace(/"/g, '""')}"`, D.fmtHM(r.eta), r.km.toFixed(2)].join(','))));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: 'sanchar_march_tables.csv' });
        document.body.appendChild(a); a.click(); a.remove();
    };

    // ------------------------------------------------------------------ Gantt (SVG)
    function gantt() {
        const res = C.result;
        if (!res || !res.models.length) return el('p', { class: 'muted' }, 'Add convoys with a start and destination to see the timeline.');
        const rows = C.list.filter(r => C.planned.has(r.id));
        const occs = rows.map(r => ({ rec: r, occ: res.occ.get(r.id) }));
        const t0 = Math.floor((Math.min(...occs.map(o => o.occ.edges[0].tIn)) - 5) / 10) * 10;
        const t1 = Math.ceil((Math.max(...occs.map(o => o.occ.tTail)) + 5) / 10) * 10;
        const W = 760, left = 92, rowH = 30, top = 22, H = top + rows.length * rowH + 8;
        const x = (t) => left + (t - t0) / (t1 - t0) * (W - left - 10);
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('class', 'gantt');
        const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.appendChild(n); return n; };
        const step = (t1 - t0) > 120 ? 30 : (t1 - t0) > 60 ? 15 : 10;
        for (let t = t0; t <= t1; t += step) {
            add('line', { x1: x(t), x2: x(t), y1: top - 4, y2: H, class: 'g-grid' });
            add('text', { x: x(t), y: 12, class: 'g-tick', 'text-anchor': 'middle' }, D.fmtHM(t));
        }
        occs.forEach(({ rec, occ }, i) => {
            const y = top + i * rowH;
            add('text', { x: 6, y: y + 18, class: 'g-label', fill: rec.color }, rec.call_sign);
            occ.edges.forEach(e => {
                const edge = C.planned.get(rec.id).route.edges[e.idx];
                const w = window.getAdjustedEdgeWeight(edge);
                const band = w === Infinity ? 'closed' : getDangerLevel(Math.min(100, w)).key;
                add('rect', { x: x(e.tIn), y: y + 6, width: Math.max(0.6, x(e.tIn + edge.length_m / vMpm(rec)) - x(e.tIn)), height: 16, class: `g-seg g-${band}` });
            });
            add('rect', { x: x(occ.edges[0].tIn), y: y + 6, width: Math.max(1, x(occ.tTail) - x(occ.edges[0].tIn)), height: 16, class: 'g-outline', stroke: rec.color });
        });
        res.conflicts.forEach(cf => {
            const ia = rows.findIndex(r => r.id === cf.a), ib = rows.findIndex(r => r.id === cf.b);
            [[ia, cf.tA], [ib, cf.tB]].forEach(([i, t]) => {
                if (i < 0) return;
                const cx = x(t), cy = top + i * rowH + 3;
                const tri = add('path', { d: `M${cx - 5},${cy - 4} L${cx + 5},${cy - 4} L${cx},${cy + 4} Z`, class: `g-conflict ${SEV_CLASS[cf.severity]}` });
                const title = document.createElementNS(NS, 'title');
                title.textContent = `${TYPE_LABEL[cf.type]} (${cf.severity}) at ${cf.where} ~${D.fmtHM(t)}`;
                tri.appendChild(title);
            });
        });
        C.nowLine = add('line', { x1: -10, x2: -10, y1: top - 6, y2: H, class: 'g-now' });
        C.ganttX = x;
        return svg;
    }

    C.onLiveTick = function () {
        if (!C.nowLine || !C.ganttX || C.startMin == null) return;
        const any = [...Live.convoys.values()][0];
        if (!any) return;
        const xx = C.ganttX(C.startMin + any.simT / 60);
        C.nowLine.setAttribute('x1', xx);
        C.nowLine.setAttribute('x2', xx);
    };

    // ------------------------------------------------------------------ run all (live)
    C.runAll = function () {
        const ready = C.list.filter(r => C.planned.has(r.id));
        if (!ready.length) { toast('No plannable convoys.', { type: 'warn' }); return; }
        Live.stopAll(true);
        const sps = ready.map(r => D.parseHM(r.sp_time));
        C.startMin = Math.min(...sps);
        ready.forEach(rec => {
            const p = C.planned.get(rec.id);
            Live.addConvoy({ id: rec.id, callSign: rec.call_sign, color: rec.color, profile: rec.profile, route: p.route, destId: p.destId,
                             speedKmph: rec.speed_kmph, vehicles: rec.vehicles, spacing: rec.spacing_m,
                             departAtSimS: (D.parseHM(rec.sp_time) - C.startMin) * 60 });
        });
        Live.focusId = ready[0].id;
        Live.paused = false;
        Live.follow = false;
        C.seenLive = new Set(((C.result && C.result.conflicts) || []).map(key));
        drawMap();
        Live.render();
        toast(`Running ${ready.length} convoys from ${D.fmtHM(C.startMin)} (sim ×${Live.simMult}). Live tab shows the focused convoy.`, { type: 'ok', timeout: 4000 });
    };

    const key = (cf) => `${[cf.a, cf.b].sort().join('|')}|${cf.type}|${cf.where}`;

    // after any live reroute, re-check conflicts for the convoys still moving
    document.addEventListener('convoyrerouted', () => {
        if (C.startMin == null || Live.convoys.size < 2) return;
        const models = [];
        Live.convoys.forEach(c => {
            if (c.arrived) return;
            const k = (() => { let i = 0; while (i + 1 < c.drive.edgeStart.length && c.drive.edgeStart[i + 1] <= c.d) i++; return i; })();
            const v = c.speedKmph * 1000 / 60;
            const nowMin = C.startMin + c.simT / 60;
            const sp = Math.max(nowMin, C.startMin + c.departAtSimS / 60) - (c.d - c.drive.edgeStart[k]) / v;
            models.push({ id: c.id, callSign: c.callSign, priority: 2, spMin: sp, speedKmph: c.speedKmph, vehicles: c.vehicles, spacing: c.spacing,
                          route: { path: c.drive.path.slice(k), edges: c.drive.edges.slice(k) } });
        });
        const { conflicts } = D.detectAll(models, edgeInfo, threatEdges(), C.settings);
        const fresh = conflicts.filter(cf => cf.severity !== 'medium' && !C.seenLive.has(key(cf)));
        fresh.forEach(cf => C.seenLive.add(key(cf)));
        if (fresh.length) {
            const cf = fresh[0];
            const a = Live.convoys.get(cf.a), b = Live.convoys.get(cf.b);
            toast(`New ${TYPE_LABEL[cf.type].toLowerCase()} conflict after reroute: ${a ? a.callSign : cf.a} / ${b ? b.callSign : cf.b} on ${cf.where} ~${D.fmtHM(cf.tA)}`, { type: 'warn', timeout: 8000 });
        }
    });

    // ------------------------------------------------------------------ render
    C.render = function () {
        const root = document.getElementById('convoys-root');
        if (!root) return;
        root.innerHTML = '';
        const res = C.result || { conflicts: [], recommendations: [] };

        // settings + actions
        const buf = el('input', { class: 'input input-sm num-input', type: 'number', min: 0, max: 15, value: C.settings.bufferMin });
        const sep = el('input', { class: 'input input-sm num-input', type: 'number', min: 1, max: 60, value: C.settings.minSepMin });
        buf.addEventListener('change', () => { C.settings.bufferMin = +buf.value; C.replan(); });
        sep.addEventListener('change', () => { C.settings.minSepMin = +sep.value; C.replan(); });
        root.appendChild(el('div', { class: 'card' },
            el('div', { class: 'btn-row' },
                el('button', { class: 'btn btn-primary', onclick: () => C.add(), html: '<svg class="icon"><use href="#i-plus"/></svg><span>Add convoy</span>' }),
                el('button', { class: 'btn btn-secondary', onclick: C.loadDemo }, 'Load demo convoys'),
                el('button', { class: 'btn btn-secondary', onclick: C.runAll, disabled: !C.planned.size, html: '<svg class="icon"><use href="#i-play"/></svg><span>Run all (live)</span>' }),
                el('button', { class: 'btn btn-ghost', onclick: C.exportCSV, disabled: !C.planned.size, html: '<svg class="icon"><use href="#i-download"/></svg><span>March tables CSV</span>' })),
            el('div', { class: 'settings-row' },
                el('label', {}, 'Buffer (min) ', buf), el('label', {}, 'Min separation (min) ', sep),
                el('span', { class: 'muted' }, 'Column length = vehicles × spacing'))));

        // convoy table
        const table = el('table', { class: 'cv-table' });
        table.appendChild(el('thead', {}, el('tr', {}, ['Call sign', 'SP → RP', 'SP time', 'Prio', 'Veh', 'Spc m', 'km/h', 'Profile', ''].map(h => el('th', {}, h)))));
        const tb = el('tbody', {});
        C.list.forEach(rec => {
            const inp = (field, attrs) => {
                const i = el('input', { class: 'input input-sm', value: rec[field], ...attrs });
                i.addEventListener('change', () => C.patch(rec.id, { [field]: attrs && attrs.type === 'number' ? Number(i.value) : i.value }));
                return i;
            };
            const prio = el('select', { class: 'input input-sm' }, [1, 2, 3].map(p => el('option', { value: p, selected: p === rec.priority }, p)));
            prio.addEventListener('change', () => C.patch(rec.id, { priority: Number(prio.value) }));
            const prof = el('select', { class: 'input input-sm' }, ['fastest', 'balanced', 'safest'].map(p => el('option', { value: p, selected: p === rec.profile }, p)));
            prof.addEventListener('change', () => C.patch(rec.id, { profile: prof.value }));
            const planned = C.planned.get(rec.id);
            tb.appendChild(el('tr', {},
                el('td', {}, el('span', { class: 'dot', style: `background:${rec.color}` }), inp('call_sign', { maxlength: 24, class: 'input input-sm cs-input' })),
                el('td', { class: 'nowrap' },
                    el('button', { class: `btn btn-ghost btn-sm ${rec.start ? 'is-set' : ''}`, onclick: () => C.pick(rec.id, 'start'), title: 'Pick start on map' }, rec.start ? 'SP ✓' : 'SP'),
                    el('button', { class: `btn btn-ghost btn-sm ${rec.dest ? 'is-set' : ''}`, onclick: () => C.pick(rec.id, 'dest'), title: 'Pick destination on map' }, rec.dest ? 'RP ✓' : 'RP'),
                    planned ? el('span', { class: 'muted small' }, ` ${(planned.route.distance).toFixed(1)} km`) : null),
                el('td', {}, inp('sp_time', { maxlength: 5, placeholder: 'HH:MM', pattern: '[0-2][0-9]:[0-5][0-9]', class: 'input input-sm time-input', title: '24-hour HH:MM' })),
                el('td', {}, prio),
                el('td', {}, inp('vehicles', { type: 'number', min: 1, max: 200, class: 'input input-sm num-input' })),
                el('td', {}, inp('spacing_m', { type: 'number', min: 10, max: 500, class: 'input input-sm num-input' })),
                el('td', {}, inp('speed_kmph', { type: 'number', min: 5, max: 80, class: 'input input-sm num-input' })),
                el('td', {}, prof),
                el('td', {}, el('button', { class: 'btn btn-ghost btn-icon', title: 'Delete convoy', onclick: () => C.remove(rec.id), html: '<svg class="icon"><use href="#i-trash"/></svg>' }))));
        });
        if (!C.list.length) tb.appendChild(el('tr', {}, el('td', { colspan: 9, class: 'muted center' }, 'No convoys yet - "Add convoy" or "Load demo convoys".')));
        table.appendChild(tb);
        root.appendChild(el('div', { class: 'card cv-card' }, el('div', { class: 'card-title' }, 'Convoys'), el('div', { class: 'cv-wrap' }, table)));

        // conflicts + recommendations
        const cfBox = el('div', { class: 'card' }, el('div', { class: 'card-title row-between' },
            el('span', {}, `Conflicts (${res.conflicts.length})`),
            res.recommendations.length ? el('button', { class: 'btn btn-primary btn-sm', onclick: C.acceptAll }, 'Accept all') : null));
        if (!res.conflicts.length) cfBox.appendChild(el('p', { class: 'ok-text' }, C.planned.size > 1 ? 'No conflicts - convoys are deconflicted.' : 'Add at least two convoys.'));
        res.conflicts.forEach(cf => {
            const a = C.list.find(x => x.id === cf.a), b = C.list.find(x => x.id === cf.b);
            cfBox.appendChild(el('div', { class: `cf-row ${SEV_CLASS[cf.severity]}` },
                el('span', { class: `badge ${SEV_CLASS[cf.severity]}` }, cf.severity),
                el('div', {}, el('b', {}, `${TYPE_LABEL[cf.type]}: ${a ? a.call_sign : cf.a} / ${b ? b.call_sign : cf.b}`),
                    el('div', { class: 'muted small' }, `${cf.where} · ${D.fmtHM(cf.tA)} vs ${D.fmtHM(cf.tB)}${cf.eids && cf.eids.length > 1 ? ` · ${cf.eids.length} shared segments` : ''}`)),
                el('button', { class: 'btn btn-ghost btn-icon', title: 'Locate', onclick: () => { const ll = conflictLatLng(cf); if (ll) map.setView(ll, 16); },
                               html: '<svg class="icon"><use href="#i-locate"/></svg>' })));
        });
        if (res.recommendations.length) {
            cfBox.appendChild(el('div', { class: 'card-title rec-title' }, 'Recommendations'));
            res.recommendations.forEach(r => cfBox.appendChild(el('div', { class: 'rec-row' },
                el('span', {}, recText(r)),
                r.kind !== 'unresolved' ? el('button', { class: 'btn btn-secondary btn-sm', onclick: () => C.accept(r.convoyId) }, 'Accept') : null)));
        }
        root.appendChild(cfBox);

        // gantt
        root.appendChild(el('div', { class: 'card' }, el('div', { class: 'card-title' }, 'Timeline (bars coloured by segment risk; ▼ = conflict)'), gantt(),
            el('div', { class: 'g-legend muted small' }, 'Low · Medium · High · Critical risk bands as on the map. Outline = column incl. tail. Vertical line = now (Run all).')));

        // march tables
        const mt = el('div', { class: 'card' }, el('div', { class: 'card-title' }, 'March tables'));
        C.list.filter(r => C.planned.has(r.id)).forEach(rec => {
            const rows = marchRows(rec);
            mt.appendChild(el('details', { class: 'march' },
                el('summary', {}, el('span', { class: 'dot', style: `background:${rec.color}` }), `${rec.call_sign} · SP ${rec.sp_time} · RP ${D.fmtHM(rows[rows.length - 1].eta)} · ${rows.length - 2} bridge/chokepoint(s)`),
                el('table', { class: 'guide-table' }, el('thead', {}, el('tr', {}, ['Point', 'ETA', 'km'].map(h => el('th', {}, h)))),
                    el('tbody', {}, rows.map(r => el('tr', {}, el('td', {}, r.point), el('td', { class: 'mono' }, D.fmtHM(r.eta)), el('td', {}, r.km.toFixed(2))))))));
        });
        root.appendChild(mt);
    };

    // ------------------------------------------------------------------ wiring
    document.addEventListener('graphready', () => C.load());
    document.addEventListener('tabchange', (e) => { if (e.detail === 'convoys') { C.replan(); } else if (!Live.convoys.size) drawMap(); });
    Threats.on((ev, data) => {
        if (ev === 'convoys_changed') { if (data.action === 'deleted') C.list = C.list.filter(x => x.id !== data.record.id); else upsertLocal(data.record); C.replan(); }
        else if (ev.startsWith('threat_') && Shell.current === 'convoys') C.replan();
    });
})();
