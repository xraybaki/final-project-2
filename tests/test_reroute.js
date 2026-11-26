// Live rerouting decisions (M13): `node tests/test_reroute.js`
const assert = require('assert');
const R = require('../js/reroute.js');
const { astar } = require('../pathfinding.js');

// Grid-ish fixture:   0 -- 1 -- 2 -- 3 -- 4      main road (route)
//                          \              /
//                           5 ---- 6 ----'       bypass
const nodes = {
    0: { lat: 0, lon: 0 }, 1: { lat: 0, lon: 0.001 }, 2: { lat: 0, lon: 0.002 }, 3: { lat: 0, lon: 0.003 }, 4: { lat: 0, lon: 0.004 },
    5: { lat: -0.001, lon: 0.0015 }, 6: { lat: -0.001, lon: 0.003 }
};
let eid = 0;
const graph = {};
function link(a, b, len, w = 10) {
    const id = eid++;
    (graph[a] = graph[a] || []).push({ target: b, weight: w, length_m: len, eid: id });
    (graph[b] = graph[b] || []).push({ target: a, weight: w, length_m: len, eid: id });
}
link(0, 1, 111); link(1, 2, 111); link(2, 3, 111); link(3, 4, 111);   // eids 0..3
link(1, 5, 120); link(5, 6, 170); link(6, 4, 160);                     // eids 4..6
const Lref = 111, lambda = 0.95;

function mkState(overrides) {
    const blocked = new Set(overrides.blocked || []);
    const extra = overrides.extraWeight || {};
    const weightFn = (e) => (blocked.has(e.eid) ? Infinity : e.weight + (extra[e.eid] || 0));
    const route = astar(graph, nodes, '0', '4', lambda, { Lref, edgeWeight: (e) => e.weight });
    return {
        path: route.path, edges: route.edges, k: overrides.k ?? 0,
        aheadBlockedOnCurrent: overrides.aheadBlockedOnCurrent || false,
        baselineWeights: route.edges.map(e => e.weight),
        weightFn, lambda, Lref,
        plan: (from) => astar(graph, nodes, String(from), '4', lambda, { Lref, edgeWeight: weightFn }),
        nowS: overrides.nowS ?? 100, lastAutoAt: overrides.lastAutoAt ?? null, abandoned: overrides.abandoned || [],
    };
}

// baseline route goes straight along the main road
let s = mkState({});
assert.deepStrictEqual(s.path, ['0', '1', '2', '3', '4']);

// 1) block edge 2 (2-3) ahead while the convoy is on edge 0 -> replan from the NEXT node (1)
let d = R.decide(mkState({ k: 0, blocked: [2] }));
assert.strictEqual(d.action, 'reroute'); assert.strictEqual(d.kind, 'mandatory');
assert.strictEqual(d.fromNode, '1'); assert.strictEqual(d.turnBack, false);
assert.deepStrictEqual(d.route.path, ['1', '5', '6', '4'], 'detours via the bypass');

// 2) blocked part on the CURRENT edge ahead -> TURN BACK, replan from the previous node
d = R.decide(mkState({ k: 1, blocked: [1], aheadBlockedOnCurrent: true }));
assert.strictEqual(d.action, 'reroute'); assert.strictEqual(d.turnBack, true);
assert.strictEqual(d.fromNode, '1');
assert.deepStrictEqual(d.route.path, ['1', '5', '6', '4']);

// 2b) current edge blocked but the closure is BEHIND the convoy -> ignore it
d = R.decide(mkState({ k: 1, blocked: [1], aheadBlockedOnCurrent: false }));
assert.notStrictEqual(d.kind, 'mandatory');

// 3) no route at all -> stuck
d = R.decide(mkState({ k: 0, blocked: [2, 5] }));
assert.strictEqual(d.action, 'stuck');

// 4) soft threat below the 15% threshold -> no auto switch
d = R.decide(mkState({ k: 0, extraWeight: { 2: 2 } }));
assert.strictEqual(d.action, 'none'); assert.strictEqual(d.reason, 'risk rise below threshold');

// 5) big soft threat on edge 2 -> advisory auto reroute (alternative >= 10% cheaper)
d = R.decide(mkState({ k: 0, extraWeight: { 2: 500 } }));
assert.strictEqual(d.action, 'reroute'); assert.strictEqual(d.kind, 'advisory');
assert.ok(d.costAlt <= d.costNow * 0.9);

// 6) hysteresis: same situation 10 s after the last automatic reroute -> prompt, not auto
d = R.decide(mkState({ k: 0, extraWeight: { 2: 500 }, nowS: 110, lastAutoAt: 100 }));
assert.strictEqual(d.action, 'prompt'); assert.strictEqual(d.reason, 'auto-reroute limit (hysteresis)');
//    ...but 31 s later it may switch automatically again
d = R.decide(mkState({ k: 0, extraWeight: { 2: 500 }, nowS: 131, lastAutoAt: 100 }));
assert.strictEqual(d.action, 'reroute');

// 7) never switch back to a route abandoned in the last 2 minutes
const altSig = R.signature(['1', '5', '6', '4']);
d = R.decide(mkState({ k: 0, extraWeight: { 2: 500 }, nowS: 200, abandoned: [{ sig: altSig, at: 150 }] }));
assert.strictEqual(d.action, 'none'); assert.strictEqual(d.reason, 'alternative was abandoned recently');
d = R.decide(mkState({ k: 0, extraWeight: { 2: 500 }, nowS: 300, abandoned: [{ sig: altSig, at: 150 }] }));
assert.strictEqual(d.action, 'reroute', 'abandon window expired');

// 8) mandatory reroutes ignore the 30 s limit (safety)
d = R.decide(mkState({ k: 0, blocked: [2], nowS: 105, lastAutoAt: 100 }));
assert.strictEqual(d.action, 'reroute');

// 9) on the last segment, nothing to do (unless blocked ahead)
d = R.decide(mkState({ k: 3 }));
assert.strictEqual(d.action, 'none');

console.log('test_reroute.js: all rerouting checks passed');
