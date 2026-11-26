/**
 * Live tab (M13): convoy tracking with on-the-move rerouting (Google-Maps style).
 *
 *  - position sources: simulation (default, sim clock 1x/5x/10x/30x), device GPS, external feed
 *    (POST /api/convoys/:id/position -> SSE)
 *  - requestAnimationFrame loop, time-based: distance += speed x sim-dt (frame-rate independent)
 *  - reroute check on every threat change (local or SSE) and every 10 s of sim time,
 *    using the pure rules in js/reroute.js (mandatory / turn-back / advisory / hysteresis)
 *  - HUD, next hazard ahead, event log (reroutes written to the SITREP database), banner, voice
 *  - "Inject threat ahead" and timed scenario files (data/scenarios/*.json)
 *
 * Several convoys can run at once (M14 "Run all"); the HUD follows the focused one.
 */
(function () {
    'use strict';
    const { el, toast, escapeHtml } = UI;

    const Live = {
        convoys: new Map(),        // id -> convoy state
        focusId: null,
        simMult: 10,
        paused: false,
        follow: true,
        voice: false,
        source: 'sim',             // sim | gps | feed
        profile: 'safest',
        raf: 0,
        lastFrame: 0,
        events: [],
        scenario: null,            // {def, done:Set}
        gpsWatch: null,
        checkEveryS: 10,
    };
    window.Live = Live;

    const PROFILES = { fastest: 'Fastest (λ 0)', balanced: 'Balanced (λ 0.6)', safest: 'Safest (λ 0.95)' };
    const lambdaOf = (p) => (p === 'balanced' ? customLambda : ROUTE_LAMBDAS[p]);

    // ------------------------------------------------------------------ geometry helpers
    function buildDrive(path, edges, prefixLatLngs) {
        // latlngs of each edge oriented along the path; optional partial first edge geometry
        const pieces = edges.map((e, i) => (i === 0 && prefixLatLngs) ? prefixLatLngs : (orientedEdgeLatLngs(e, path[i]) ||
            [[nodesLookup[path[i]].lat, nodesLookup[path[i]].lon], [nodesLookup[path[i + 1]].lat, nodesLookup[path[i + 1]].lon]]));
        const latlngs = [], edgeStart = [];
        let dist = 0;
        pieces.forEach((pc, i) => {
            edgeStart.push(dist);
            const start = latlngs.length ? 1 : 0;
            if (!latlngs.length) latlngs.push(pc[0]);
            for (let j = Math.max(1, start); j < pc.length; j++) {
                const a = latlngs[latlngs.length - 1], b = pc[j];
                dist += getDistance(a[0], a[1], b[0], b[1]);
                latlngs.push(b);
            }
        });
        return { path: path.map(String), edges, latlngs, cum: cumulative(latlngs), edgeStart, length: dist };
    }

    /** latlngs along the drive from distance a to b (with interpolated end points) */
    function sliceDrive(dr, a, b) {
        a = Math.max(0, a); b = Math.min(dr.length, b);
        if (b <= a) return [];
        const pa = pointAlong(dr.latlngs, dr.cum, a), pb = pointAlong(dr.latlngs, dr.cum, b);
        const out = [[pa.lat, pa.lon]];
        for (let i = 0; i < dr.cum.length; i++) if (dr.cum[i] > a && dr.cum[i] < b) out.push(dr.latlngs[i]);
        out.push([pb.lat, pb.lon]);
        return out;
    }

    function edgeIndexAt(dr, d) {
        let k = 0;
        while (k + 1 < dr.edgeStart.length && dr.edgeStart[k + 1] <= d) k++;
        return k;
    }

    const roadName = (e) => (e && edgeFeatures[e.eid] ? edgeFeatures[e.eid].properties.street_name : 'road');

    // ------------------------------------------------------------------ convoy lifecycle
    let idSeq = 0;
    /**
     * Start a convoy on a planned route.
     * opts: {id, callSign, color, profile, route ({path, edges}), destId, speedKmph, vehicles, spacing, departAtSimS, quiet}
     */
    Live.addConvoy = function (opts) {
        const id = opts.id || `CV${++idSeq}`;
        const dr = buildDrive(opts.route.path, opts.route.edges);
        const c = {
            id, callSign: opts.callSign || `Convoy-${id}`, color: opts.color || '#4ea1ff', profile: opts.profile || 'safest',
            destId: String(opts.destId), drive: dr, d: 0, speedKmph: opts.speedKmph || CONFIG.convoy.speedKmph,
            vehicles: opts.vehicles || 10, spacing: opts.spacing || 50, simT: 0, departAtSimS: opts.departAtSimS || 0,
            started: false, arrived: false, stuck: false, heading: 0,
            baseline: dr.edges.map(e => window.getAdjustedEdgeWeight(e)), lastAutoAt: null, abandoned: [], promptedSig: null,
            travelled: [], lastK: -1, lastCheckS: 0, totalKm: 0, quiet: !!opts.quiet, layers: {}, startedClock: new Date(),
            plannedKm: dr.length / 1000, rerouteCount: 0,
        };
        drawConvoy(c);
        Live.convoys.set(id, c);
        if (!Live.focusId) Live.focusId = id;
        ensureLoop();
        return c;
    };

    Live.startFromPlan = function () {
        if (!lastRoutes || !endNode) { toast('Plan a route in the Plan tab first.', { type: 'warn' }); Shell.switchTab('plan'); return; }
        Live.stopAll(true);
        const prof = document.getElementById('live-profile') ? document.getElementById('live-profile').value : Live.profile;
        Live.profile = prof;
        const route = lastRoutes[prof];
        stopRouteAnimation();
        dimPlannedRoutes(true);
        const vehicles = +(document.getElementById('live-vehicles') || {}).value || 10;
        const spacing = +(document.getElementById('live-spacing') || {}).value || 50;
        const callSign = (document.getElementById('live-callsign') || {}).value || 'Alpha-1';
        const c = Live.addConvoy({ id: 'LIVE1', callSign, color: getComputedStyle(document.documentElement).getPropertyValue('--info').trim() || '#4ea1ff',
                                   profile: prof, route, destId: endNode.id, vehicles, spacing });
        Live.focusId = c.id;
        Live.paused = false;
        Shell.switchTab('live');
        logEvent(c, 'departed', `${c.callSign} departed on the ${prof} route (${c.plannedKm.toFixed(2)} km, ${PROFILES[prof]})`, true);
        if (Live.source === 'gps') Live.startGPS();
        Live.render();
    };

    Live.stopAll = function (silent) {
        Live.convoys.forEach(c => undrawConvoy(c));
        Live.convoys.clear();
        Live.focusId = null;
        Live.scenario = null;
        Live.stopGPS();
        cancelAnimationFrame(Live.raf);
        Live.raf = 0;
        dimPlannedRoutes(false);
        hideBanner();
        if (!silent) Live.render();
    };

    function dimPlannedRoutes(on) {
        routeLayers.forEach(l => l.setStyle({ opacity: on ? 0.18 : 0.88 }));
    }

    // ------------------------------------------------------------------ drawing
    function arrowIcon(c) {
        return L.divIcon({ className: 'convoy-marker-wrap', iconSize: [22, 24], iconAnchor: [11, 16],
                           html: `<div class="convoy-arrow" style="--cv:${c.color}"></div><div class="convoy-label">${escapeHtml(c.callSign)}</div>` });
    }

    function drawConvoy(c) {
        const L_ = c.layers;
        L_.travelled = L.polyline([], { color: '#8b98a5', weight: 5, opacity: 0.55, interactive: false }).addTo(map);
        L_.remaining = L.polyline(c.drive.latlngs, { color: c.color, weight: 6, opacity: 0.95, interactive: false, className: 'live-remaining' }).addTo(map);
        L_.column = L.polyline([], { color: '#ffffff', weight: 9, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(map);
        L_.marker = L.marker(c.drive.latlngs[0], { icon: arrowIcon(c), zIndexOffset: 2500, interactive: true })
            .on('click', () => { Live.focusId = c.id; Live.render(); }).addTo(map);
        drawOn(L_.remaining);
    }

    function undrawConvoy(c) {
        Object.values(c.layers).forEach(l => l && map.removeLayer(l));
        c.layers = {};
    }

    function updateLayers(c, full) {
        const p = pointAlong(c.drive.latlngs, c.drive.cum, c.d);
        // smooth heading (shortest angular path)
        let dh = ((p.bearing - c.heading + 540) % 360) - 180;
        c.heading = (c.heading + dh * 0.25 + 360) % 360;
        c.layers.marker.setLatLng([p.lat, p.lon]);
        const arrow = c.layers.marker.getElement() && c.layers.marker.getElement().firstChild;
        if (arrow) arrow.style.transform = `rotate(${c.heading}deg)`;
        const colLen = c.vehicles * c.spacing;
        c.layers.column.setLatLngs(sliceDrive(c.drive, c.d - colLen, c.d));
        if (full) {
            c.layers.remaining.setLatLngs(sliceDrive(c.drive, c.d, c.drive.length));
            c.layers.travelled.setLatLngs(c.travelled.concat(sliceDrive(c.drive, 0, c.d)));
        }
        return p;
    }

    // ------------------------------------------------------------------ main loop
    function ensureLoop() {
        if (!Live.raf) { Live.lastFrame = performance.now(); Live.raf = requestAnimationFrame(frame); }
    }

    let lastFull = 0, lastHud = 0, lastPan = 0;
    function frame(now) {
        const dtReal = Math.min(0.25, (now - Live.lastFrame) / 1000);   // clamp after tab switches
        Live.lastFrame = now;
        const dtSim = Live.paused ? 0 : dtReal * Live.simMult;
        const full = now - lastFull > 120;
        if (full) lastFull = now;
        let anyActive = false;
        Live.convoys.forEach(c => {
            if (c.arrived) return;
            anyActive = true;
            c.simT += dtSim;
            if (Live.source === 'sim' || c.id !== Live.focusId) {
                if (c.simT < c.departAtSimS) { updateLayers(c, full); return; }
                if (!c.started) { c.started = true; c.startedClock = simClock(c); }
                if (!c.stuck) c.d = Math.min(c.drive.length, c.d + (c.speedKmph / 3.6) * dtSim);
            }
            const p = updateLayers(c, full);
            progressEvents(c);
            if (c.simT - c.lastCheckS >= Live.checkEveryS) { c.lastCheckS = c.simT; Live.check(c, 'periodic'); }
            if (c.d >= c.drive.length - 0.5) arrive(c);
            if (c.id === Live.focusId && Live.follow && now - lastPan > 200) { lastPan = now; map.panTo([p.lat, p.lon], { animate: true, duration: 0.25, noMoveStart: true }); }
        });
        if (Live.scenario && !Live.paused) runScenario();
        if (now - lastHud > 200) { lastHud = now; renderHud(); if (window.Convoys && Convoys.onLiveTick) Convoys.onLiveTick(); }
        if (anyActive || Live.scenario) Live.raf = requestAnimationFrame(frame);
        else { Live.raf = 0; renderHud(); }
    }

    const simClock = (c) => new Date(c.startedClock.getTime() + Math.max(0, c.simT - c.departAtSimS) * 1000);

    function progressEvents(c) {
        const k = edgeIndexAt(c.drive, c.d);
        if (k === c.lastK) return;
        c.lastK = k;
        const e = c.drive.edges[k];
        if (!e || c.quiet) return;
        const w = window.getAdjustedEdgeWeight(e);
        if (e.chokepoint) logEvent(c, 'chokepoint', `crossing chokepoint: ${roadName(e)}`);
        if (w >= CONFIG.convoy.highRiskWeight && w !== Infinity) logEvent(c, 'high_risk', `entered high-risk segment (${Math.round(Math.min(100, w))}) on ${roadName(e)}`);
    }

    function arrive(c) {
        c.arrived = true;
        c.d = c.drive.length;
        updateLayers(c, true);
        logEvent(c, 'arrived', `${c.callSign} arrived (${(c.totalKm + c.drive.length / 1000).toFixed(2)} km driven, ${c.rerouteCount} reroute(s))`, true);
        if (c.id === Live.focusId) say(`${c.callSign} has arrived.`);
    }

    // ------------------------------------------------------------------ rerouting
    function aheadBlockedOnCurrent(c, k) {
        const e = c.drive.edges[k];
        const eff = e && Threats.effectOf(e.eid);
        if (!eff || !eff.hard) return false;
        const a = c.drive.edgeStart[k], b = k + 1 < c.drive.edgeStart.length ? c.drive.edgeStart[k + 1] : c.drive.length;
        const seg = sliceDrive(c.drive, a, b).map(ll => [ll[1], ll[0]]);
        for (const pc of eff.pieces) {
            if (pc.impact < Threats.hardBlock) continue;
            for (const ll of pc.latlngs) {
                const pr = ThreatGeo.nearestOnPolyline(ll[0], ll[1], seg);
                if (a + pr.along > c.d - 2) return true;
            }
        }
        return false;
    }

    function planFrom(c, fromId) {
        return astar(routingGraph.adjacency_list, nodesLookup, String(fromId), c.destId, lambdaOf(c.profile), routingOptions());
    }

    /** Run the reroute rules for convoy c. reason: 'threat' | 'periodic' | ... */
    Live.check = function (c, reason) {
        if (!c || c.arrived || !routingGraph) return;
        const k = edgeIndexAt(c.drive, c.d);
        const dec = Reroute.decide({
            path: c.drive.path, edges: c.drive.edges, k,
            aheadBlockedOnCurrent: aheadBlockedOnCurrent(c, k),
            baselineWeights: c.baseline, weightFn: (e) => window.getAdjustedEdgeWeight(e),
            lambda: lambdaOf(c.profile), Lref: (graphMeta && graphMeta.L_ref) || 100,
            plan: (from) => planFrom(c, from), nowS: c.simT, lastAutoAt: c.lastAutoAt, abandoned: c.abandoned,
        });
        if (dec.action === 'reroute') applyReroute(c, k, dec, false);
        else if (dec.action === 'stuck') {
            if (!c.stuck) {
                c.stuck = true;
                logEvent(c, 'stuck', `${c.callSign}: no passable route - HOLD POSITION`, true);
                showBanner(`<b>${escapeHtml(c.callSign)}: no passable route.</b> All roads to the destination are closed - hold position.`, 'danger');
                say('No passable route. Hold position.');
            }
        } else if (dec.action === 'prompt') {
            const sig = Reroute.signature(dec.route.path);
            if (sig === c.promptedSig) return;
            c.promptedSig = sig;
            const d = deltas(c, k, dec);
            toast(`${c.callSign}: alternative available · ${d.dKmTxt} · risk ${d.riskTxt}`, {
                type: 'warn', timeout: 0,
                actions: [{ label: 'Accept', primary: true, onClick: () => applyReroute(c, edgeIndexAt(c.drive, c.d), dec, true) },
                          { label: 'Ignore', onClick: () => logEvent(c, 'advisory', 'alternative ignored by operator') }]
            });
        } else if (c.stuck && reason !== 'periodic') {
            c.stuck = false;   // a closure was lifted
        }
    };

    function remainingMetrics(c, k, fromNode, turnBack) {
        // the route the convoy would drive from its next/previous node without rerouting (old plan)
        const startIdx = turnBack ? k : k + 1;
        return { path: c.drive.path.slice(startIdx), edges: c.drive.edges.slice(startIdx) };
    }

    function deltas(c, k, dec) {
        const opts = routingOptions();
        const old = remainingMetrics(c, k, dec.fromNode, dec.turnBack);
        const oldM = old.edges.length ? computeRouteMetrics({ ...old, distance: old.edges.reduce((s, e) => s + e.length_m, 0) / 1000 }, opts) : null;
        const extraBack = dec.turnBack ? (c.d - c.drive.edgeStart[k]) * 2 / 1000 : 0;
        const newKm = dec.route.edges.reduce((s, e) => s + e.length_m, 0) / 1000 + extraBack;
        const newM = computeRouteMetrics({ ...dec.route, distance: newKm }, opts);
        const dKm = oldM ? newKm - oldM.distanceKm : newKm;
        const dMin = dKm / c.speedKmph * 60;
        const oldP = oldM ? oldM.incidentProb : 0;
        const sg = (v, dp) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}`;
        return { dKm, dMin, oldP, newP: newM.incidentProb, dKmTxt: `${sg(dKm, 1)} km · ${sg(dMin, 0)} min`,
                 riskTxt: oldM && oldM.blockedSegments ? `old route closed → ${(100 * newM.incidentProb).toFixed(1)}%`
                     : `${(100 * oldP).toFixed(1)}% → ${(100 * newM.incidentProb).toFixed(1)}%` };
    }

    function viaRoad(oldEdges, newEdges) {
        const old = new Set(oldEdges.map(e => roadName(e)));
        const len = {};
        newEdges.forEach(e => { const n = roadName(e); if (n !== 'Unnamed road' && !old.has(n)) len[n] = (len[n] || 0) + e.length_m; });
        const best = Object.entries(len).sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : null;
    }

    function threatAheadText(c, k) {
        for (let i = k; i < c.drive.edges.length; i++) {
            const e = c.drive.edges[i];
            const w = window.getAdjustedEdgeWeight(e);
            if (w === Infinity || (Threats.effectOf(e.eid) && w > c.baseline[i] * 1.15)) {
                const dist = Math.max(0, c.drive.edgeStart[i] - c.d);
                return `Threat reported on ${roadName(e)}, ${dist < 50 ? 'on the current segment' : `${Math.round(dist / 50) * 50} m ahead`}`;
            }
        }
        return 'Threat picture changed';
    }

    function applyReroute(c, k, dec, manual) {
        const d = deltas(c, k, dec);
        const why = threatAheadText(c, k);
        const oldRemaining = sliceDrive(c.drive, c.d, c.drive.length);
        const oldEdges = c.drive.edges.slice(k + 1);
        const oldSig = Reroute.signature(c.drive.path.slice(k + 1));
        const e = c.drive.edges[k];
        const a = c.drive.edgeStart[k];
        const b = k + 1 < c.drive.edgeStart.length ? c.drive.edgeStart[k + 1] : c.drive.length;
        // new drive: current position -> (finish current edge | turn back to its start) -> new route
        let prefix, path, edges;
        if (dec.turnBack) {
            prefix = sliceDrive(c.drive, a, c.d).reverse();
            path = [c.drive.path[k + 1], ...dec.route.path];
            edges = [e, ...dec.route.edges];
        } else {
            prefix = sliceDrive(c.drive, c.d, b);
            path = [c.drive.path[k], ...dec.route.path];
            edges = [e, ...dec.route.edges];
        }
        if (prefix.length < 2) {   // exactly at a node: start directly on the new route
            const p = pointAlong(c.drive.latlngs, c.drive.cum, c.d);
            prefix = [[p.lat, p.lon], [p.lat, p.lon]];
        }
        c.travelled = c.travelled.concat(sliceDrive(c.drive, 0, c.d));
        c.totalKm += c.d / 1000;
        c.drive = buildDrive(path, edges, prefix);
        c.d = 0;
        c.lastK = -1;
        c.stuck = false;
        c.baseline = c.drive.edges.map(x => window.getAdjustedEdgeWeight(x) === Infinity ? x.weight : window.getAdjustedEdgeWeight(x));
        c.abandoned.push({ sig: oldSig, at: c.simT });
        if (dec.kind === 'advisory' && !manual) c.lastAutoAt = c.simT;
        c.promptedSig = null;
        c.rerouteCount++;

        // feedback: ghost of the old route, new route draws on, banner, voice, log
        const ghost = L.polyline(oldRemaining, { color: '#9aa4ae', weight: 5, opacity: 0.7, dashArray: '6 8', interactive: false, className: 'ghost-route' }).addTo(map);
        setTimeout(() => ghost.getElement && ghost.getElement() && ghost.getElement().classList.add('is-fading'), 50);
        setTimeout(() => map.removeLayer(ghost), 6500);
        c.layers.remaining.setLatLngs(c.drive.latlngs);
        drawOn(c.layers.remaining);
        const viaTxt = viaRoad(oldEdges, dec.route.edges);
        const head = dec.turnBack ? '<b class="closed">TURN BACK</b> - road closed ahead on this segment. ' : '';
        const txt = `${head}${escapeHtml(why)}. ${manual ? 'Alternative accepted' : 'Rerouted'}${viaTxt ? ` via ${escapeHtml(viaTxt)}` : ''} · ${d.dKmTxt} · risk ${d.riskTxt}`;
        if (!c.quiet || c.id === Live.focusId) showBanner(`<b>${escapeHtml(c.callSign)}:</b> ${txt}`, dec.kind === 'mandatory' ? 'danger' : 'warn');
        const plain = `${c.callSign}: ${dec.turnBack ? 'TURN BACK - ' : ''}${why}. Rerouted${viaTxt ? ` via ${viaTxt}` : ''} (${d.dKmTxt}, risk ${d.riskTxt})`;
        logEvent(c, dec.turnBack ? 'turn_back' : 'reroute', plain, true, { kind: dec.kind, dKm: +d.dKm.toFixed(3), riskBefore: d.oldP, riskAfter: d.newP });
        if (c.id === Live.focusId) {
            beep();
            say(dec.turnBack ? 'Turn back. Road closed ahead.' : `Rerouting${viaTxt ? ` via ${viaTxt}` : ''}.`);
        }
        document.dispatchEvent(new CustomEvent('convoyrerouted', { detail: { id: c.id } }));
    }

    // ------------------------------------------------------------------ threat-driven checks
    Threats.on((ev, t) => {
        if (!Live.convoys.size) return;
        if (ev === 'threat_created' && t) {
            Live.convoys.forEach(c => { if (!c.quiet && c.id === Live.focusId) logEvent(c, 'threat', `threat reported: ${Threats.typeInfo(t.type).label} at ${t.location_label}`); });
        }
        if (ev.startsWith('threat_') || ev === 'intel_loaded' || ev === 'loaded') {
            Live.convoys.forEach(c => Live.check(c, 'threat'));
        }
    });

    // ------------------------------------------------------------------ banner / voice / log
    let bannerT = null;
    function showBanner(html, kind) {
        const b = document.getElementById('live-banner');
        if (!b) return;
        b.className = `live-banner is-on is-${kind || 'warn'}`;
        b.innerHTML = html;
        clearTimeout(bannerT);
        bannerT = setTimeout(hideBanner, 9000);
    }
    function hideBanner() {
        const b = document.getElementById('live-banner');
        if (b) b.classList.remove('is-on');
    }
    Live.showBanner = showBanner;

    function say(text) {
        if (!Live.voice || !window.speechSynthesis) return;
        try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch (e) { /* ignore */ }
    }
    let audio = null;
    function beep() {
        if (!Live.voice) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            const o = audio.createOscillator(), g = audio.createGain();
            o.frequency.value = 880; g.gain.value = 0.08;
            o.connect(g); g.connect(audio.destination);
            o.start(); o.stop(audio.currentTime + 0.15);
        } catch (e) { /* ignore */ }
    }

    function logEvent(c, kind, text, persist, data) {
        const ev = { at: c ? simClock(c) : new Date(), kind, text, convoy: c ? c.callSign : null };
        Live.events.unshift(ev);
        if (Live.events.length > 200) Live.events.pop();
        renderEvents();
        if (persist) {
            fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({ kind, text, convoy: ev.convoy, data: data || null }) }).catch(() => {});
        }
    }
    Live.logEvent = logEvent;

    // ------------------------------------------------------------------ demo helpers
    Live.injectAhead = async function (opts = {}) {
        const c = Live.convoys.get(Live.focusId);
        if (!c || c.arrived) { toast('Start a convoy first.', { type: 'warn' }); return; }
        const left = c.drive.length - c.d;
        if (left < 150) { toast('Too close to the destination.', { type: 'warn' }); return; }
        const ahead = opts.ahead_m ? Math.min(opts.ahead_m, left - 60) : Math.min(left - 60, 500 + Math.random() * 500);
        const p = pointAlong(c.drive.latlngs, c.drive.cum, c.d + ahead);
        const type = opts.type || (document.getElementById('live-threat-type') || {}).value || 'IED';
        const t = await Threats.add({ lat: p.lat, lon: p.lon, type, impact: opts.impact, radius_m: opts.radius_m,
                                      source: 'manual_map', resolution: 'map_click', confidence: 'high',
                                      description: opts.description || `Injected ${Math.round(ahead)} m ahead of ${c.callSign} (demo).` });
        if (t) toast(`${Threats.typeInfo(type).label} injected ${Math.round(ahead)} m ahead`, { type: 'info', timeout: 2000 });
    };

    Live.loadScenarios = async function () {
        try {
            const { scenarios } = await (await fetch('/api/scenarios')).json();
            Live.scenarios = scenarios;
        } catch (e) { Live.scenarios = []; }
        Live.render();
    };

    Live.runScenario = async function (file) {
        const def = await (await fetch(`data/scenarios/${encodeURIComponent(file)}`)).json();
        Live.stopAll(true);
        resetRouting();
        Shell.switchTab('plan');
        setRoutePoint(def.start.lat, def.start.lon);
        setRoutePoint(def.end.lat, def.end.lon);
        if (!lastRoutes) { toast('Scenario route could not be planned.', { type: 'danger' }); return; }
        const sel = document.getElementById('live-profile');
        if (sel) sel.value = def.profile || 'safest';
        Live.setSpeed(def.speed_mult || 10);
        Live.startFromPlan();
        Live.scenario = { def, done: new Set() };
        logEvent(Live.convoys.get(Live.focusId), 'scenario', `scenario started: ${def.name}`);
        toast(`Scenario: ${def.name}`, { type: 'info', timeout: 4000 });
    };

    function runScenario() {
        const sc = Live.scenario;
        const c = Live.convoys.get(Live.focusId);
        if (!c) return;
        sc.def.steps.forEach((st, i) => {
            if (sc.done.has(i) || c.simT < st.at_s) return;
            sc.done.add(i);
            if (st.action === 'add_threat') {
                if (st.lat != null) Threats.add({ lat: st.lat, lon: st.lon, type: st.type, impact: st.impact, radius_m: st.radius_m,
                                                   source: 'manual_map', resolution: 'coordinates', description: st.description });
                else Live.injectAhead(st);
            } else if (st.action === 'clear_threats') Threats.clearAll();
            else if (st.action === 'set_speed') Live.setSpeed(st.mult);
            else if (st.action === 'note') logEvent(c, 'note', st.text || '');
        });
        if (sc.done.size === sc.def.steps.length) Live.scenario = null;
    }

    // ------------------------------------------------------------------ GPS + external feed
    Live.startGPS = function () {
        if (!navigator.geolocation) { toast('Geolocation is not available - using simulation.', { type: 'warn' }); Live.setSource('sim'); return; }
        Live.stopGPS();
        Live.gpsWatch = navigator.geolocation.watchPosition(
            (pos) => onPositionFix(pos.coords.latitude, pos.coords.longitude, pos.coords.speed != null ? pos.coords.speed * 3.6 : null),
            (err) => { toast(`GPS error: ${err.message} - using simulation.`, { type: 'warn' }); Live.setSource('sim'); },
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    };
    Live.stopGPS = function () {
        if (Live.gpsWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(Live.gpsWatch);
        Live.gpsWatch = null;
    };

    function inBox(lat, lon) {
        const b = graphMeta && graphMeta.region && graphMeta.region.bounds;
        return !b || (lat >= b[0][0] && lat <= b[1][0] && lon >= b[0][1] && lon <= b[1][1]);
    }

    function onPositionFix(lat, lon, speedKmph) {
        const c = Live.convoys.get(Live.focusId);
        if (!c) return;
        if (!inBox(lat, lon)) {
            toast('Position is outside the operating area - falling back to simulation.', { type: 'warn' });
            Live.setSource('sim');
            return;
        }
        const s = Threats.grid.snap(lat, lon, 60);                     // map-match to the road
        const p = s ? { lat: s.lat, lon: s.lon } : { lat, lon };
        const line = c.drive.latlngs.map(ll => [ll[1], ll[0]]);
        const pr = ThreatGeo.nearestOnPolyline(p.lat, p.lon, line);
        if (pr.dist < 80) {
            c.d = Math.max(c.d, Math.min(c.drive.length, pr.along));    // never jump backwards on jitter
        } else {
            // off route: replan from the nearest node to the destination
            const n = findNearestNode(p.lat, p.lon, nodesList);
            const r = n && planFrom(c, n.id);
            if (r) {
                c.travelled = c.travelled.concat(sliceDrive(c.drive, 0, c.d));
                c.drive = buildDrive(r.path, r.edges);
                c.d = 0;
                c.baseline = c.drive.edges.map(e => window.getAdjustedEdgeWeight(e));
                c.layers.remaining.setLatLngs(c.drive.latlngs);
                logEvent(c, 'reroute', `${c.callSign} left the planned route - new route from current position`, true);
            }
        }
        if (speedKmph != null && speedKmph > 1) c.speedKmph = speedKmph;
        Live.check(c, 'position');
    }
    Live.onPositionFix = onPositionFix;

    Threats.on((ev, p) => {
        if (ev !== 'convoy_position' || Live.source !== 'feed') return;
        const c = Live.convoys.get(Live.focusId);
        if (c && (p.id === c.id || p.id === c.callSign)) onPositionFix(p.lat, p.lon, p.speed_kmph);
    });

    // ------------------------------------------------------------------ controls
    Live.setSpeed = function (m) {
        Live.simMult = Number(m);
        document.querySelectorAll('.seg-speed button').forEach(b => b.classList.toggle('is-active', Number(b.dataset.mult) === Live.simMult));
    };
    Live.togglePause = function () {
        Live.paused = !Live.paused;
        Live.render();
    };
    Live.setSource = function (src) {
        Live.source = src;
        if (src === 'gps' && Live.convoys.size) Live.startGPS(); else Live.stopGPS();
        Live.render();
    };
    Live.handleMapClick = () => false;

    map_on_ready(() => map.on('dragstart', () => { if (Live.follow && Live.convoys.size) { Live.follow = false; Live.render(); } }));
    function map_on_ready(fn) { document.addEventListener('graphready', fn, { once: true }); }

    // ------------------------------------------------------------------ rendering (Live tab)
    function hazardAhead(c) {
        const k = edgeIndexAt(c.drive, c.d);
        for (let i = k; i < c.drive.edges.length; i++) {
            const dist = Math.max(0, c.drive.edgeStart[i] - c.d);
            if (dist > 4000) break;
            const e = c.drive.edges[i];
            const w = window.getAdjustedEdgeWeight(e);
            const at = dist < 30 ? 'now' : `in ${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist / 10) * 10 + ' m'}`;
            if (w === Infinity) return { cls: 'closed', text: `ROAD CLOSED ${at}` };
            if (Threats.effectOf(e.eid)) return { cls: 'danger', text: `Threat zone ${at} (${roadName(e)})` };
            if (w >= CONFIG.convoy.highRiskWeight) return { cls: 'warn', text: `High-risk segment ${at} (${Math.round(Math.min(100, w))})` };
            if (e.chokepoint && i > k) return { cls: 'info', text: `Chokepoint ${at} (${roadName(e)})` };
        }
        return { cls: 'ok', text: 'No hazards in the next 4 km' };
    }

    function renderHud() {
        const host = document.getElementById('live-hud');
        if (!host) return;
        const c = Live.convoys.get(Live.focusId);
        if (!c) { host.innerHTML = ''; return; }
        const k = edgeIndexAt(c.drive, c.d);
        const e = c.drive.edges[k];
        const w = e ? window.getAdjustedEdgeWeight(e) : 0;
        const band = w === Infinity ? { key: 'closed', label: 'CLOSED' } : getDangerLevel(Math.min(100, w));
        const leftKm = (c.drive.length - c.d) / 1000;
        const doneKm = c.totalKm + c.d / 1000;
        const pct = Math.round(100 * doneKm / Math.max(0.001, doneKm + leftKm));
        const etaMin = leftKm / c.speedKmph * 60;
        const now = simClock(c);
        const eta = new Date(now.getTime() + etaMin * 60000);
        const hz = hazardAhead(c);
        const status = c.arrived ? 'ARRIVED' : c.stuck ? 'HOLD - NO ROUTE' : c.simT < c.departAtSimS ? `SP in ${Math.ceil((c.departAtSimS - c.simT) / 60)} min` : Live.paused ? 'PAUSED' : 'MOVING';
        host.innerHTML = `
            <div class="hud-top"><b>${escapeHtml(c.callSign)}</b><span class="badge hud-status st-${c.arrived ? 'ok' : c.stuck ? 'danger' : 'moving'}">${status}</span></div>
            <div class="hud-road">${escapeHtml(roadName(e))}</div>
            <div class="hud-grid">
                <div><span>Speed</span><b class="hud-val">${c.stuck || c.arrived ? 0 : Math.round(c.speedKmph)} km/h</b></div>
                <div><span>Remaining</span><b class="hud-val">${leftKm.toFixed(2)} km</b></div>
                <div><span>ETA</span><b class="hud-val">${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${Math.round(etaMin)} min</b></div>
                <div><span>Segment risk ${Guide.tip('hud')}</span><b class="hud-val risk-${band.key}">${w === Infinity ? '∞' : Math.round(Math.min(100, w))} · ${band.label}</b></div>
            </div>
            <div class="hud-hazard hz-${hz.cls}">${escapeHtml(hz.text)}</div>
            <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
            <div class="hud-foot muted">${doneKm.toFixed(2)} km driven · ${c.rerouteCount} reroute(s) · sim ${fmtClock(now)} ×${Live.simMult}</div>`;
    }

    const fmtClock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    function renderEvents() {
        const host = document.getElementById('live-events');
        if (!host) return;
        host.innerHTML = '';
        if (!Live.events.length) { host.appendChild(el('p', { class: 'muted' }, 'Events appear here once a convoy departs.')); return; }
        Live.events.slice(0, 60).forEach(ev => host.appendChild(el('div', { class: `event-row ev-${ev.kind}` },
            el('span', { class: 'mono' }, ev.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
            el('b', {}, ev.kind.replace('_', ' ')), el('span', {}, ev.text))));
    }

    Live.render = function () {
        const root = document.getElementById('live-root');
        if (!root) return;
        const running = Live.convoys.size > 0;
        const types = Threats.types ? Object.entries(Threats.types) : [];
        root.innerHTML = `
            <div class="card">
                <div class="card-title">Convoy</div>
                <div class="form-grid">
                    <label class="field"><span>Call sign</span><input id="live-callsign" class="input" value="Alpha-1" maxlength="20"></label>
                    <label class="field"><span>Route profile</span><select id="live-profile" class="input">
                        ${Object.entries(PROFILES).map(([k, v]) => `<option value="${k}" ${k === Live.profile ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
                    <label class="field"><span>Vehicles</span><input id="live-vehicles" class="input" type="number" min="1" max="100" value="10"></label>
                    <label class="field"><span>Spacing (m)</span><input id="live-spacing" class="input" type="number" min="10" max="200" value="50"></label>
                </div>
                <div class="field"><span>Position source</span>
                    <div class="seg seg-source">
                        <button data-src="sim" class="${Live.source === 'sim' ? 'is-active' : ''}">Simulation</button>
                        <button data-src="gps" class="${Live.source === 'gps' ? 'is-active' : ''}">Device GPS</button>
                        <button data-src="feed" class="${Live.source === 'feed' ? 'is-active' : ''}">External feed</button>
                    </div></div>
                <div class="field"><span>Sim speed ${Guide.tip('speed')}</span>
                    <div class="seg seg-speed">${[1, 5, 10, 30].map(m => `<button data-mult="${m}" class="${m === Live.simMult ? 'is-active' : ''}">${m}×</button>`).join('')}</div></div>
                <div class="btn-row">
                    ${running ? `<button id="live-pause" class="btn btn-secondary grow"><svg class="icon"><use href="#i-${Live.paused ? 'play' : 'pause'}"/></svg><span>${Live.paused ? 'Resume' : 'Pause'}</span></button>
                                 <button id="live-stop" class="btn btn-ghost"><svg class="icon"><use href="#i-stop"/></svg><span>Stop</span></button>`
                              : `<button id="live-start" class="btn btn-primary grow" ${lastRoutes ? '' : 'disabled'}><svg class="icon"><use href="#i-play"/></svg><span>Start convoy on planned route</span></button>`}
                </div>
                ${lastRoutes || running ? '' : '<p class="hint">Plan a route in the Plan tab (or run a scenario below) first.</p>'}
                <div class="toggles">
                    <label class="switch"><input type="checkbox" id="live-follow" ${Live.follow ? 'checked' : ''}><span>Follow-cam</span></label>
                    <label class="switch"><input type="checkbox" id="live-voice" ${Live.voice ? 'checked' : ''}><span>Voice + beep</span></label>
                </div>
                ${Live.source === 'feed' ? `<p class="hint">External feed: <code>POST /api/convoys/${running ? Live.focusId : 'LIVE1'}/position {lat, lon, speed_kmph, heading, ts}</code></p>` : ''}
            </div>
            <div id="live-hud" class="card hud ${running ? '' : 'is-empty'}"></div>
            <div class="card">
                <div class="card-title">Demo</div>
                <div class="btn-row">
                    <select id="live-threat-type" class="input input-sm grow">${types.map(([k, v]) => `<option value="${k}">${v.emoji} ${v.label}</option>`).join('')}</select>
                    <button id="live-inject" class="btn btn-danger-outline" ${running ? '' : 'disabled'}><svg class="icon"><use href="#i-alert"/></svg><span>Inject threat ahead</span></button>
                </div>
                <div class="btn-row">
                    <select id="live-scenario" class="input input-sm grow">${(Live.scenarios || []).map(s => `<option value="${escapeHtml(s.file)}" title="${escapeHtml(s.description)}">${escapeHtml(s.name)}</option>`).join('') || '<option value="">No scenarios</option>'}</select>
                    <button id="live-run-scn" class="btn btn-secondary" ${(Live.scenarios || []).length ? '' : 'disabled'}><svg class="icon"><use href="#i-play"/></svg><span>Run</span></button>
                </div>
            </div>
            <div class="card"><div class="card-title">Event log</div><div id="live-events" class="event-list"></div></div>`;
        const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
        on('live-start', 'click', Live.startFromPlan);
        on('live-pause', 'click', Live.togglePause);
        on('live-stop', 'click', () => { Live.stopAll(); toast('Live tracking stopped', { type: 'info', timeout: 1500 }); });
        on('live-inject', 'click', () => Live.injectAhead());
        on('live-run-scn', 'click', () => Live.runScenario(document.getElementById('live-scenario').value));
        on('live-follow', 'change', (e) => { Live.follow = e.target.checked; });
        on('live-voice', 'change', (e) => { Live.voice = e.target.checked; if (Live.voice) say('Voice guidance on.'); });
        on('live-profile', 'change', (e) => { Live.profile = e.target.value; });
        root.querySelectorAll('.seg-speed button').forEach(b => b.addEventListener('click', () => Live.setSpeed(b.dataset.mult)));
        root.querySelectorAll('.seg-source button').forEach(b => b.addEventListener('click', () => Live.setSource(b.dataset.src)));
        renderHud();
        renderEvents();
    };

    document.addEventListener('graphready', () => { Live.render(); Live.loadScenarios(); });
    document.addEventListener('routeschange', () => { if (!Live.convoys.size) Live.render(); });
})();
