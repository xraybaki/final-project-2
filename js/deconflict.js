/**
 * Multi-convoy deconfliction and timing - pure functions, no DOM. Browser + Node tests.
 *
 * Occupancy  head enters edge e at t_in; tail leaves at t_out = t_exit_head + column_len / v.
 *            window(e) = [t_in - buffer, t_out + buffer]   (times in MINUTES)
 *            nodes (junction crossings) get the same treatment.
 * Conflicts  head_on    same edge, opposite directions, overlapping windows
 *                       CRITICAL on bridge / chokepoint / narrow / unpaved, else HIGH
 *            bunching   same edge, same direction, head gap < min separation      MEDIUM
 *            junction   same node, overlapping windows, routes cross (no shared edge there)   MEDIUM
 *            threat     both convoys inside the same threat radius at the same time   HIGH
 *            Consecutive shared edges of one pair/type are grouped into ONE conflict.
 * Resolution sort by priority (1 = highest) then SP time; the first convoy keeps its plan;
 *            each next convoy tries (1) delaying SP in 2-min steps up to 60 min and (2) an
 *            alternative route avoiding edges reserved by higher-priority convoys, and keeps
 *            the option with the lowest combined cost (delay minutes + route-cost minutes).
 *            If nothing is conflict-free, the least-bad option is kept and conflicts flagged.
 */
(function (root) {
    'use strict';

    const DEFAULTS = { bufferMin: 3, minSepMin: 10, delayStepMin: 2, maxDelayMin: 60 };
    const SEV_RANK = { critical: 3, high: 2, medium: 1 };

    /** Occupancy of one convoy: {edges: [{eid, from, to, idx, tIn, tOut, w0, w1}], nodes: [{node, t0, t1}], tEnd} */
    function occupancy(cv, opts) {
        const o = { ...DEFAULTS, ...(opts || {}) };
        const vMpm = cv.speedKmph * 1000 / 60;                     // metres per minute
        const colMin = (cv.vehicles * cv.spacing) / vMpm;
        const route = cv.route;
        const edges = [], nodes = [];
        let dist = cv.startOffsetM || 0;
        const sp = cv.spMin;
        route.edges.forEach((e, i) => {
            const tIn = sp + dist / vMpm;
            dist += e.length_m;
            const tExitHead = sp + dist / vMpm;
            const tOut = tExitHead + colMin;
            edges.push({ eid: e.eid, from: String(route.path[i]), to: String(route.path[i + 1]), idx: i,
                         tIn, tOut, w0: tIn - o.bufferMin, w1: tOut + o.bufferMin });
            nodes.push({ node: String(route.path[i]), t0: tIn - o.bufferMin, t1: tIn + colMin + o.bufferMin, idx: i });
        });
        const tEnd = sp + dist / vMpm;
        nodes.push({ node: String(route.path[route.path.length - 1]), t0: tEnd - o.bufferMin, t1: tEnd + colMin + o.bufferMin, idx: route.edges.length });
        return { edges, nodes, tEnd, tTail: tEnd + colMin };
    }

    const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

    /**
     * Conflicts between two convoys.
     * edgeInfo(eid) -> {bridge, chokepoint, narrow, unpaved, name}; threatEdges: Map eid -> [threatId]
     */
    function pairConflicts(A, B, oa, ob, edgeInfo, threatEdges, opts) {
        const o = { ...DEFAULTS, ...(opts || {}) };
        const out = [];
        const bByEid = new Map();
        ob.edges.forEach(x => { if (!bByEid.has(x.eid)) bByEid.set(x.eid, []); bByEid.get(x.eid).push(x); });
        const groups = {};      // type -> [{a, b, sev}]
        const sharedNodes = new Set();
        for (const a of oa.edges) {
            for (const b of bByEid.get(a.eid) || []) {
                sharedNodes.add(a.from); sharedNodes.add(a.to);
                const info = edgeInfo(a.eid) || {};
                if (a.from === b.to && a.to === b.from) {
                    if (overlap(a.w0, a.w1, b.w0, b.w1)) {
                        const crit = info.bridge || info.chokepoint || info.narrow || info.unpaved;
                        (groups.head_on = groups.head_on || []).push({ a, b, sev: crit ? 'critical' : 'high', info });
                    }
                } else if (Math.abs(a.tIn - b.tIn) < o.minSepMin) {
                    (groups.bunching = groups.bunching || []).push({ a, b, sev: 'medium', info });
                }
            }
        }
        // group consecutive edges (by A's index) into one conflict each
        for (const [type, list] of Object.entries(groups)) {
            list.sort((x, y) => x.a.idx - y.a.idx);
            let run = [];
            const flush = () => {
                if (!run.length) return;
                const worst = run.reduce((m, r) => (SEV_RANK[r.sev] > SEV_RANK[m.sev] || (r.info.bridge && !m.info.bridge) ? r : m), run[0]);
                out.push({ type, severity: run.some(r => r.sev === 'critical') ? 'critical' : run[0].sev,
                           a: A.id, b: B.id, eids: run.map(r => r.a.eid), eid: worst.a.eid, where: worst.info.name || `edge ${worst.a.eid}`,
                           bridge: !!worst.info.bridge, chokepoint: !!worst.info.chokepoint,
                           tA: worst.a.tIn, tB: worst.b.tIn, t0: Math.max(worst.a.w0, worst.b.w0), t1: Math.min(worst.a.w1, worst.b.w1) });
                run = [];
            };
            for (const r of list) {
                if (run.length && r.a.idx !== run[run.length - 1].a.idx + 1) flush();
                run.push(r);
            }
            flush();
        }
        // junction crossings where the routes cross (not where they already share an edge)
        const bNodes = new Map();
        ob.nodes.forEach(n => { if (!bNodes.has(n.node)) bNodes.set(n.node, []); bNodes.get(n.node).push(n); });
        for (const na of oa.nodes) {
            if (sharedNodes.has(na.node)) continue;
            for (const nb of bNodes.get(na.node) || []) {
                if (overlap(na.t0, na.t1, nb.t0, nb.t1)) {
                    out.push({ type: 'junction', severity: 'medium', a: A.id, b: B.id, node: na.node, where: `junction ${na.node}`,
                               tA: na.t0 + o.bufferMin, tB: nb.t0 + o.bufferMin,
                               t0: Math.max(na.t0, nb.t0), t1: Math.min(na.t1, nb.t1) });
                    break;
                }
            }
        }
        // shared threat exposure
        if (threatEdges && threatEdges.size) {
            const win = (oc) => {
                const m = new Map();
                oc.edges.forEach(x => (threatEdges.get(x.eid) || []).forEach(tid => {
                    const cur = m.get(tid);
                    m.set(tid, cur ? [Math.min(cur[0], x.w0), Math.max(cur[1], x.w1), cur[2]] : [x.w0, x.w1, x.eid]);
                }));
                return m;
            };
            const wa = win(oa), wb = win(ob);
            wa.forEach((va, tid) => {
                const vb = wb.get(tid);
                if (vb && overlap(va[0], va[1], vb[0], vb[1])) {
                    out.push({ type: 'threat', severity: 'high', a: A.id, b: B.id, threatId: tid, eid: va[2], where: `threat ${tid}`,
                               tA: va[0], tB: vb[0], t0: Math.max(va[0], vb[0]), t1: Math.min(va[1], vb[1]) });
                }
            });
        }
        return out;
    }

    function detectAll(convoys, edgeInfo, threatEdges, opts) {
        const occ = new Map(convoys.map(c => [c.id, occupancy(c, opts)]));
        const out = [];
        for (let i = 0; i < convoys.length; i++) {
            for (let j = i + 1; j < convoys.length; j++) {
                out.push(...pairConflicts(convoys[i], convoys[j], occ.get(convoys[i].id), occ.get(convoys[j].id), edgeInfo, threatEdges, opts));
            }
        }
        return { conflicts: out.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity] || x.t0 - y.t0), occ };
    }

    const badness = (cs) => [cs.filter(c => c.severity === 'critical').length, cs.filter(c => c.severity === 'high').length, cs.length];
    const lexLess = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };

    /**
     * Prioritised planning.
     * convoys: [{id, callSign, priority, spMin, speedKmph, vehicles, spacing, route, routeCost}]
     * ctx: {edgeInfo, threatEdges, planAlt(convoy, reservedEids:Set, blockedEids:Set) -> {route, routeCost}|null, costToMin(c, dCost)}
     * returns {order, plans: Map id -> {spMin, route, delayMin, rerouted, conflicts}, recommendations: [...]}
     */
    function resolve(convoys, ctx, opts) {
        const o = { ...DEFAULTS, ...(opts || {}) };
        const order = convoys.slice().sort((a, b) => a.priority - b.priority || a.spMin - b.spMin);
        const fixed = [];
        const plans = new Map();
        const recs = [];
        const conflictsVsFixed = (cand) => {
            const oc = occupancy(cand, o);
            const cs = [];
            for (const f of fixed) cs.push(...pairConflicts(f, cand, f._occ, oc, ctx.edgeInfo, ctx.threatEdges, o));
            return { cs, oc };
        };
        for (const c of order) {
            let best = null;
            const consider = (opt) => {
                const score = badness(opt.cs);
                if (!best || lexLess(score, best.score) || (score.join() === best.score.join() && opt.cost < best.cost)) best = { ...opt, score };
            };
            const base = conflictsVsFixed(c);
            consider({ kind: 'none', delayMin: 0, route: c.route, routeCost: c.routeCost, cost: 0, cs: base.cs, oc: base.oc });
            if (base.cs.length && fixed.length) {
                // (1) delay SP
                for (let d = o.delayStepMin; d <= o.maxDelayMin; d += o.delayStepMin) {
                    const cand = { ...c, spMin: c.spMin + d };
                    const r = conflictsVsFixed(cand);
                    if (!r.cs.length) { consider({ kind: 'delay', delayMin: d, route: c.route, routeCost: c.routeCost, cost: d, cs: [], oc: r.oc }); break; }
                    if (d === o.maxDelayMin) consider({ kind: 'delay', delayMin: d, route: c.route, routeCost: c.routeCost, cost: d, cs: r.cs, oc: r.oc });
                }
                // (2) alternative route avoiding reserved edges (critical ones blocked)
                if (ctx.planAlt) {
                    const reserved = new Set(), blocked = new Set();
                    base.cs.forEach(x => (x.eids || [x.eid]).forEach(e => { if (e != null) { reserved.add(e); if (x.severity === 'critical') blocked.add(e); } }));
                    fixed.forEach(f => f._occ.edges.forEach(x => { if (overlap(x.w0, x.w1, c.spMin - 30, c.spMin + 240)) reserved.add(x.eid); }));
                    const alt = ctx.planAlt(c, reserved, blocked);
                    if (alt && alt.route) {
                        const cand = { ...c, route: alt.route };
                        const r = conflictsVsFixed(cand);
                        const extra = ctx.costToMin ? ctx.costToMin(c, alt.routeCost - c.routeCost) : 0;
                        consider({ kind: 'reroute', delayMin: 0, route: alt.route, routeCost: alt.routeCost, cost: Math.max(0, extra), cs: r.cs, oc: r.oc });
                    }
                }
            }
            const plan = { ...c, spMin: c.spMin + best.delayMin, route: best.route, routeCost: best.routeCost, _occ: best.oc };
            fixed.push(plan);
            plans.set(c.id, { spMin: plan.spMin, route: best.route, delayMin: best.delayMin, rerouted: best.kind === 'reroute',
                              conflicts: best.cs, baseConflicts: base.cs, kind: best.kind, cost: best.cost });
            if (base.cs.length) {
                const worst = base.cs.slice().sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity])[0];
                const other = convoys.find(x => x.id === (worst.a === c.id ? worst.b : worst.a));
                recs.push({ convoyId: c.id, kind: best.cs.length ? (best.kind === 'none' ? 'unresolved' : `${best.kind}-partial`) : best.kind,
                            delayMin: best.delayMin, fromSp: c.spMin, toSp: c.spMin + best.delayMin, rerouted: best.kind === 'reroute',
                            conflict: worst, otherId: other ? other.id : null, remaining: best.cs });
            }
        }
        return { order: order.map(c => c.id), plans, recommendations: recs };
    }

    const fmtHM = (min) => {
        const m = ((Math.round(min) % 1440) + 1440) % 1440;
        return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const parseHM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };

    const api = { occupancy, pairConflicts, detectAll, resolve, fmtHM, parseHM, DEFAULTS, SEV_RANK };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Deconflict = api;
})(typeof window !== 'undefined' ? window : globalThis);
