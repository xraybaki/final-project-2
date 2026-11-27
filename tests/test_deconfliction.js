// Multi-convoy deconfliction: `node tests/test_deconfliction.js`
const assert = require('assert');
const D = require('../js/deconflict.js');

// Straight road  W(0) -- 1 -- 2 ==BRIDGE== 3 -- 4 -- E(5); each link 500 m (1 min at 30 km/h)
const E = (eid, len = 500) => ({ eid, length_m: len, weight: 10 });
const fwd = { path: ['0', '1', '2', '3', '4', '5'], edges: [E(0), E(1), E(2), E(3), E(4)] };
const rev = { path: ['5', '4', '3', '2', '1', '0'], edges: [E(4), E(3), E(2), E(1), E(0)] };
const info = (eid) => ({ bridge: eid === 2, chokepoint: false, name: eid === 2 ? 'Zero Bridge' : `Link ${eid}` });
const cv = (id, priority, spMin, route) => ({ id, callSign: id, priority, spMin, speedKmph: 30, vehicles: 10, spacing: 50, route, routeCost: 25 });

// occupancy: head enters edge i at sp + i min; tail leaves 1 min (500 m column) after head exits
const occ = D.occupancy(cv('A', 1, 480, fwd), { bufferMin: 3 });
assert.strictEqual(occ.edges.length, 5);
assert.ok(Math.abs(occ.edges[2].tIn - 482) < 1e-9 && Math.abs(occ.edges[2].tOut - 484) < 1e-9);
assert.ok(Math.abs(occ.edges[2].w0 - 479) < 1e-9 && Math.abs(occ.edges[2].w1 - 487) < 1e-9);

// 1) opposite directions over the same bridge at overlapping times -> CRITICAL head-on (grouped)
const A = cv('Alpha-1', 1, 480, fwd), B = cv('Bravo-2', 2, 481, rev);
let { conflicts } = D.detectAll([A, B], info, null, {});
const headOn = conflicts.filter(c => c.type === 'head_on');
assert.strictEqual(headOn.length, 1, 'consecutive shared edges grouped into one conflict');
assert.strictEqual(headOn[0].severity, 'critical');
assert.ok(headOn[0].bridge && headOn[0].where === 'Zero Bridge', 'worst location is the bridge');

// 2) resolution: Alpha-1 (priority 1) keeps its plan; Bravo-2 gets a delay that removes the conflict
const res = D.resolve([B, A], { edgeInfo: info, threatEdges: null, planAlt: null }, {});
assert.deepStrictEqual(res.order, ['Alpha-1', 'Bravo-2']);
assert.strictEqual(res.plans.get('Alpha-1').delayMin, 0);
const pb = res.plans.get('Bravo-2');
assert.ok(pb.delayMin > 0 && pb.delayMin % 2 === 0 && pb.delayMin <= 60, `delay ${pb.delayMin}`);
assert.strictEqual(pb.conflicts.length, 0, 'conflict-free after the delay');
const rec = res.recommendations.find(r => r.convoyId === 'Bravo-2');
assert.strictEqual(rec.kind, 'delay'); assert.strictEqual(rec.conflict.type, 'head_on');
// the delayed plan really is conflict-free when re-checked from scratch
({ conflicts } = D.detectAll([A, { ...B, spMin: pb.spMin }], info, null, {}));
assert.strictEqual(conflicts.filter(c => c.type === 'head_on').length, 0);

// 3) same direction, 5 min apart (< 10 min separation) -> bunching (medium)
({ conflicts } = D.detectAll([A, cv('Charlie-3', 2, 485, fwd)], info, null, {}));
assert.ok(conflicts.some(c => c.type === 'bunching' && c.severity === 'medium'));
assert.ok(!conflicts.some(c => c.type === 'head_on'));

// 4) far apart in time -> no conflicts
({ conflicts } = D.detectAll([A, cv('Delta-4', 2, 480 + 180, rev)], info, null, {}));
assert.strictEqual(conflicts.length, 0);

// 5) crossing routes at a junction at the same time -> junction conflict
const cross = { path: ['9', '2', '8'], edges: [E(90), E(91)] };   // passes node 2 only
({ conflicts } = D.detectAll([A, cv('Echo-5', 2, 481, cross)], info, null, {}));
assert.ok(conflicts.some(c => c.type === 'junction' && c.node === '2'));

// 6) shared threat exposure -> high
const threatEdges = new Map([[1, ['THR-1']]]);
({ conflicts } = D.detectAll([A, cv('Foxtrot-6', 2, 485, fwd)], info, threatEdges, {}));
assert.ok(conflicts.some(c => c.type === 'threat' && c.severity === 'high'));

// 7) when delays (capped at 6 min here) cannot remove a CRITICAL head-on, the alternative route is
//    kept as the least-bad option (only a medium junction conflict remains where it leaves node 5)
const alt = { path: ['5', '7', '0'], edges: [E(70, 1400), E(71, 1400)] };   // bypass, no shared edges
const res2 = D.resolve([A, B], { edgeInfo: info, threatEdges: null,
    planAlt: () => ({ route: alt, routeCost: 30 }), costToMin: (c, dCost) => dCost * 0.2 }, { maxDelayMin: 6 });
const p2 = res2.plans.get('Bravo-2');
assert.ok(p2.rerouted && p2.delayMin === 0, 'reroute chosen');
assert.ok(!p2.conflicts.some(c => c.severity === 'critical'), 'no critical conflict left');
assert.ok(res2.recommendations.find(r => r.convoyId === 'Bravo-2').kind === 'reroute-partial');

// 8) without the cap, the clean (conflict-free) delay beats a route that still has a conflict
const res3 = D.resolve([A, B], { edgeInfo: info, threatEdges: null, planAlt: () => ({ route: alt, routeCost: 30 }), costToMin: () => 1 }, {});
assert.ok(!res3.plans.get('Bravo-2').rerouted && res3.plans.get('Bravo-2').conflicts.length === 0);

assert.strictEqual(D.fmtHM(D.parseHM('07:38') + 8), '07:46');
console.log('test_deconfliction.js: all deconfliction checks passed');
