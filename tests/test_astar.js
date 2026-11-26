// A* check on a tiny fixture graph: `node tests/test_astar.js`
const assert = require('assert');
const { astar, calculateRoutes, PriorityQueue } = require('../pathfinding.js');

// heap sanity
const pq = new PriorityQueue();
[5, 1, 4, 2, 3].forEach(p => pq.enqueue(p, p));
assert.deepStrictEqual([1, 2, 3, 4, 5].map(() => pq.dequeue().priority), [1, 2, 3, 4, 5]);

//   0 --- 1 --- 3        short path 0-1-3 is risky (w=90)
//    \         /
//     `-- 2 --'          long path 0-2-3 is safe (w=0)
const nodes = {
    '0': { lat: 0, lon: 0 }, '1': { lat: 0, lon: 0.001 }, '3': { lat: 0, lon: 0.002 },
    '2': { lat: -0.001, lon: 0.001 }
};
const E = (t, w, len, eid) => ({ target: t, weight: w, length_m: len, eid, p_traverse: w / 1000 });
const graph = {
    '0': [E(1, 90, 111, 0), E(2, 0, 160, 1)],
    '1': [E(0, 90, 111, 0), E(3, 90, 111, 2)],
    '2': [E(0, 0, 160, 1), E(3, 0, 160, 3)],
    '3': [E(1, 90, 111, 2), E(2, 0, 160, 3)]
};
const opts = { Lref: 111, edgeWeight: e => e.weight };
assert.deepStrictEqual(astar(graph, nodes, '0', '3', 0, opts).path, ['0', '1', '3'], 'fastest = shortest');
assert.deepStrictEqual(astar(graph, nodes, '0', '3', 0.95, opts).path, ['0', '2', '3'], 'safest avoids risk');

// hard block: edge 3 (2-3) blocked -> safest must use risky path; block both -> null
const blk = { Lref: 111, edgeWeight: e => (e.eid === 3 ? Infinity : e.weight) };
assert.deepStrictEqual(astar(graph, nodes, '0', '3', 0.95, blk).path, ['0', '1', '3']);
const blkAll = { Lref: 111, edgeWeight: e => (e.eid === 3 || e.eid === 2 ? Infinity : e.weight) };
assert.strictEqual(astar(graph, nodes, '0', '3', 0.95, blkAll), null);

const r = calculateRoutes(graph, nodes, '0', '3', opts);
assert.ok(r.safest.metrics.incidentProb < r.fastest.metrics.incidentProb);
assert.ok(Math.abs(r.fastest.metrics.incidentProb - (1 - (1 - 0.09) ** 2)) < 1e-9);
console.log('test_astar.js: all A* checks passed');
