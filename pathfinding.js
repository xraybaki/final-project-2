/**
 * A* Pathfinding for Convoy Route Planning
 * Computes Fastest / Balanced / Safest routes over the ML-weighted road graph
 * and reports convoy metrics for each.
 *
 * Cost per edge (both terms on comparable, dimensionless scales):
 *     cost = (1 - λ) * (length_m / L_ref)  +  λ * (weight / 100) * (length_m / L_ref)
 * where L_ref = median edge length. Risk is per-metre exposure, so a long risky road
 * costs more than a short one. Heuristic h = straight_line / L_ref * (1 - λ) is admissible
 * because weight >= 0.
 *
 * Route incident probability uses the independent-Bernoulli model
 *     P(route) = 1 - Π (1 - p_i)
 * (Krumm & Horvitz, "Risk-Aware Planning: Methods and Case Study for Safer Driving Routes", AAAI 2017).
 */

const ROUTING_DEBUG = false;  // set true to log search statistics
const ROUTE_LAMBDAS = { fastest: 0.0, balanced: 0.6, safest: 0.95 };

// ---------------------------------------------------------------- binary min-heap
class PriorityQueue {
    constructor() {
        this.items = [];
    }

    enqueue(element, priority) {
        const items = this.items;
        items.push({ element, priority });
        let i = items.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (items[p].priority <= items[i].priority) break;
            [items[p], items[i]] = [items[i], items[p]];
            i = p;
        }
    }

    dequeue() {
        const items = this.items;
        if (items.length === 0) return undefined;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            const n = items.length;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < n && items[l].priority < items[m].priority) m = l;
                if (r < n && items[r].priority < items[m].priority) m = r;
                if (m === i) break;
                [items[m], items[i]] = [items[i], items[m]];
                i = m;
            }
        }
        return top;
    }

    isEmpty() {
        return this.items.length === 0;
    }

    size() {
        return this.items.length;
    }
}

/**
 * Distance between two points in metres (Haversine)
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1000;
}

/**
 * Find nearest node to a point
 */
function findNearestNode(lat, lon, nodes) {
    let nearest = null;
    let minDist = Infinity;
    for (const node of nodes) {
        const dist = getDistance(lat, lon, node.lat, node.lon);
        if (dist < minDist) {
            minDist = dist;
            nearest = node;
        }
    }
    return nearest;
}

/**
 * Default edge-weight provider (no live threats). Returns the effective risk weight
 * (0-100+, Infinity = blocked) for an adjacency entry.
 */
function defaultEdgeWeight(edge) {
    return edge.weight;
}

/**
 * A* search.
 * @param {object} graph        adjacency list {"nodeId": [{target, weight, length_m, ...}]}
 * @param {object} nodes        node lookup {"id": {lat, lon, weight}}
 * @param {string} startId
 * @param {string} endId
 * @param {number} weightFactor λ in [0,1]: 0 = fastest, ~1 = safest
 * @param {object} opts         {Lref, edgeWeight(edge, fromId, toId) -> weight|Infinity}
 */
function astar(graph, nodes, startId, endId, weightFactor = 0.5, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    startId = String(startId);
    endId = String(endId);
    const Lref = opts.Lref || 100;
    const edgeWeight = opts.edgeWeight || (typeof window !== 'undefined' && window.getAdjustedEdgeWeight) || defaultEdgeWeight;
    const lam = weightFactor;

    const startNode = nodes[startId];
    const endNode = nodes[endId];
    if (!startNode || !endNode) return null;

    const openSet = new PriorityQueue();
    const closed = new Set();
    const cameFrom = {};
    const gScore = { [startId]: 0 };
    const h = (n) => getDistance(n.lat, n.lon, endNode.lat, endNode.lon) / Lref * (1 - lam);

    openSet.enqueue(startId, h(startNode));
    let iterations = 0;

    while (!openSet.isEmpty()) {
        const current = openSet.dequeue().element;
        if (closed.has(current)) continue;
        closed.add(current);
        iterations++;

        if (current === endId) {
            if (ROUTING_DEBUG) {
                const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
                console.log(`A* λ=${lam}: ${iterations} expansions, ${ms.toFixed(1)} ms`);
            }
            return reconstructPath(cameFrom, current, nodes);
        }

        const g = gScore[current];
        for (const edge of graph[current] || []) {
            const neighbor = String(edge.target);
            if (closed.has(neighbor)) continue;
            const w = edgeWeight(edge, current, neighbor);
            if (w === Infinity) continue;  // hard block: convoy must not pass
            const lenN = edge.length_m / Lref;
            const tentative = g + (1 - lam) * lenN + lam * (w / 100) * lenN;
            if (tentative < (gScore[neighbor] ?? Infinity)) {
                const nn = nodes[neighbor];
                if (!nn) continue;
                gScore[neighbor] = tentative;
                cameFrom[neighbor] = { from: current, edge };
                openSet.enqueue(neighbor, tentative + h(nn));
            }
        }
    }
    if (ROUTING_DEBUG) console.log(`A* λ=${lam}: no path (${iterations} expansions)`);
    return null;
}

/**
 * Reconstruct path from A* result
 */
function reconstructPath(cameFrom, current, nodes) {
    const path = [current];
    const edges = [];
    while (cameFrom[current]) {
        edges.unshift(cameFrom[current].edge);
        current = cameFrom[current].from;
        path.unshift(current);
    }
    const coordinates = path.map(id => [nodes[id].lon, nodes[id].lat]);
    const totalDistance = edges.reduce((s, e) => s + e.length_m, 0);
    const totalWeight = edges.reduce((s, e) => s + e.weight, 0);
    const avgWeight = edges.length ? totalWeight / edges.length : 0;
    return {
        path,
        coordinates,
        edges,
        distance: totalDistance / 1000,  // km
        totalWeight,
        avgWeight,
        dangerScore: Math.min(100, avgWeight),
        numSegments: edges.length
    };
}

/**
 * Convoy metrics for a route under the current threat picture.
 * @param {object} route   result of astar
 * @param {object} opts    {edgeWeight, edgeProb(edge, w) -> p, speedKmph, highRisk}
 */
function computeRouteMetrics(route, opts = {}) {
    const speed = opts.speedKmph || 30;
    const highRisk = opts.highRisk || 60;
    const edgeWeight = opts.edgeWeight || defaultEdgeWeight;
    const edgeProb = opts.edgeProb || ((e) => e.p_traverse ?? 0);
    const mps = speed / 3.6;

    let logSurvive = 0, lenW = 0, maxW = 0, nHigh = 0, exposure = 0, choke = 0, blocked = 0, zones = 0;
    route.path.slice(0, -1).forEach((from, i) => {
        const e = route.edges[i];
        const to = route.path[i + 1];
        const w = edgeWeight(e, from, to);
        if (w === Infinity) { blocked++; return; }
        if (w > e.weight) zones++;
        const p = Math.min(0.999999, Math.max(0, edgeProb(e, w)));
        logSurvive += Math.log1p(-p);
        lenW += Math.min(100, w) * e.length_m;
        maxW = Math.max(maxW, w);
        if (w >= highRisk) {
            nHigh++;
            exposure += e.length_m / mps;
        }
        if (e.chokepoint) choke++;
    });
    const distM = route.distance * 1000;
    return {
        distanceKm: route.distance,
        etaMin: distM / mps / 60,
        incidentProb: blocked ? 1 : 1 - Math.exp(logSurvive),
        meanRisk: distM ? lenW / distM : 0,
        maxRisk: Math.min(100, maxW),
        highRiskSegments: nHigh,
        exposureMin: exposure / 60,
        chokepoints: choke,
        threatSegments: zones,
        blockedSegments: blocked
    };
}

/**
 * Calculate the three convoy route options.
 */
function calculateRoutes(graph, nodes, startId, endId, opts = {}) {
    const lambdas = { ...ROUTE_LAMBDAS, ...(opts.lambdas || {}) };
    const fastest = astar(graph, nodes, startId, endId, lambdas.fastest, opts);
    if (!fastest) return null;
    const balanced = astar(graph, nodes, startId, endId, lambdas.balanced, opts) || fastest;
    const safest = astar(graph, nodes, startId, endId, lambdas.safest, opts) || balanced;

    const style = {
        fastest: { name: '🔵 Fastest', color: '#3b9dff', description: `λ=${lambdas.fastest} · minimum travel time; ignores risk (respects road closures)` },
        balanced: { name: '🟡 Balanced', color: '#ffb000', description: `λ=${lambdas.balanced} · trades time against threat exposure` },
        safest: { name: '🟢 Safest', color: '#00e676', description: `λ=${lambdas.safest} · minimises threat exposure` }
    };
    const out = {};
    for (const [k, r] of Object.entries({ fastest, balanced, safest })) {
        out[k] = { ...r, ...style[k], key: k, lambda: lambdas[k], metrics: computeRouteMetrics(r, opts) };
    }
    return out;
}

/**
 * Format distance for display (input km)
 */
function formatDistance(km) {
    const meters = km * 1000;
    return meters < 1000 ? `${Math.round(meters)} m` : `${km.toFixed(2)} km`;
}

/**
 * Danger level description for a 0-100 risk score
 */
function getDangerLevel(score) {
    if (score < 20) return { label: 'Very Low', color: '#00ff00' };
    if (score < 40) return { label: 'Low', color: '#7fff00' };
    if (score < 60) return { label: 'Moderate', color: '#ffaa00' };
    if (score < 80) return { label: 'High', color: '#ff6600' };
    return { label: 'Critical', color: '#ff0000' };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PriorityQueue, getDistance, findNearestNode, astar, reconstructPath,
                       computeRouteMetrics, calculateRoutes, formatDistance, getDangerLevel, ROUTE_LAMBDAS };
}
