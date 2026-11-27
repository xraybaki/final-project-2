/**
 * Live rerouting decisions - pure functions, no DOM. Used by js/live.js and tests.
 *
 * Rules
 *  1. MANDATORY: an edge of the remaining route is hard-blocked (weight = Infinity).
 *       - blocked edge is ahead  -> replan from the NEXT node (finish the current edge first)
 *       - blocked part is on the CURRENT edge ahead of the convoy -> TURN BACK: replan from
 *         the PREVIOUS node (the start of the current edge)
 *     Safety first: mandatory reroutes ignore the 30 s auto-reroute limit.
 *  2. ADVISORY: remaining-route risk cost rose by > riseFrac (15 %) versus the plan baseline.
 *       - alternative >= gainFrac (10 %) cheaper and hysteresis allows -> switch automatically
 *       - otherwise, if it is cheaper at all -> prompt the operator
 *  3. HYSTERESIS: at most one AUTOMATIC advisory reroute per minAutoGapS (30 s sim time); never
 *     switch to a route abandoned in the last abandonWindowS (120 s).
 */
(function (root) {
    'use strict';

    const DEFAULTS = { riseFrac: 0.15, gainFrac: 0.10, minAutoGapS: 30, abandonWindowS: 120 };

    function edgeCost(edge, w, lambda, Lref) {
        if (w === Infinity) return Infinity;
        const n = edge.length_m / Lref;
        return (1 - lambda) * n + lambda * (w / 100) * n;
    }

    function routeCost(edges, weightFn, lambda, Lref) {
        let c = 0;
        for (let i = 0; i < edges.length; i++) {
            c += edgeCost(edges[i], weightFn(edges[i], i), lambda, Lref);
            if (c === Infinity) return Infinity;
        }
        return c;
    }

    /** Signature of a node path, used to recognise previously abandoned routes. */
    const signature = (path) => path.join('>');

    function recentlyAbandoned(abandoned, sig, nowS, windowS) {
        return (abandoned || []).some(a => a.sig === sig && nowS - a.at < windowS);
    }

    /**
     * @param s  {path, edges, k, aheadBlockedOnCurrent, baselineWeights, weightFn, lambda, Lref,
     *            plan(fromNodeId) -> {path, edges}|null, nowS, lastAutoAt, abandoned:[{sig, at}], opts}
     * @returns  {action: 'none'|'reroute'|'prompt'|'stuck', kind, fromNode, turnBack, route, reason,
     *            blockedIdx, costNow, costAlt}
     */
    function decide(s) {
        const o = { ...DEFAULTS, ...(s.opts || {}) };
        const { path, edges, k } = s;
        const none = (reason) => ({ action: 'none', reason });
        if (!edges || k >= edges.length) return none('arrived');

        // ---- 1. mandatory: hard block ahead
        let blockedIdx = -1;
        for (let i = k; i < edges.length; i++) {
            if (s.weightFn(edges[i], i) !== Infinity) continue;
            if (i === k && !s.aheadBlockedOnCurrent) continue;   // closure already behind us on this edge
            blockedIdx = i;
            break;
        }
        if (blockedIdx >= 0) {
            const turnBack = blockedIdx === k;
            const fromNode = turnBack ? path[k] : path[k + 1];
            const route = s.plan(fromNode);
            if (!route) return { action: 'stuck', kind: 'mandatory', fromNode, turnBack, blockedIdx, reason: 'no passable route' };
            return { action: 'reroute', kind: 'mandatory', fromNode, turnBack, route, blockedIdx,
                     reason: turnBack ? 'road closed ahead on current segment' : 'road closed ahead' };
        }

        // ---- 2. advisory: risk rose on the remaining route (from the next node)
        const next = k + 1;
        if (next >= edges.length) return none('on last segment');
        const remaining = edges.slice(next);
        const costNow = routeCost(remaining, (e, i) => s.weightFn(e, next + i), s.lambda, s.Lref);
        const costBase = routeCost(remaining, (e, i) => s.baselineWeights[next + i], s.lambda, s.Lref);
        if (!(costNow > costBase * (1 + o.riseFrac))) return { ...none('risk rise below threshold'), costNow, costBase };
        const alt = s.plan(path[next]);
        if (!alt) return { ...none('no alternative'), costNow };
        const altSig = signature(alt.path);
        if (altSig === signature(path.slice(next))) return { ...none('alternative is the current route'), costNow };
        const costAlt = routeCost(alt.edges, (e) => s.weightFn(e), s.lambda, s.Lref);
        if (!(costAlt < costNow)) return { ...none('alternative not cheaper'), costNow, costAlt };
        if (recentlyAbandoned(s.abandoned, altSig, s.nowS, o.abandonWindowS)) return { ...none('alternative was abandoned recently'), costNow, costAlt };
        const base = { kind: 'advisory', fromNode: path[next], turnBack: false, route: alt, costNow, costAlt, costBase };
        const goodEnough = costAlt <= costNow * (1 - o.gainFrac);
        const hysteresisOk = s.lastAutoAt == null || s.nowS - s.lastAutoAt >= o.minAutoGapS;
        if (goodEnough && hysteresisOk) return { ...base, action: 'reroute', reason: 'risk rose on remaining route' };
        return { ...base, action: 'prompt', reason: goodEnough ? 'auto-reroute limit (hysteresis)' : 'alternative less than 10% better' };
    }

    const api = { decide, routeCost, edgeCost, signature, DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Reroute = api;
})(typeof window !== 'undefined' ? window : globalThis);
