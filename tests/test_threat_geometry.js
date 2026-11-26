// Threat geometry checks (M9): `node tests/test_threat_geometry.js`
const assert = require('assert');
const G = require('../js/threat-geo.js');

const lat0 = 34.08, lon0 = 74.80;
const mPerDegLon = 111320 * Math.cos(lat0 * Math.PI / 180);
const east = (m) => lon0 + m / mPerDegLon;   // point m metres east of origin on the same latitude

// 2 km straight road running east from the origin
const road = [[lon0, lat0], [east(1000), lat0], [east(2000), lat0]];
assert.ok(Math.abs(G.polylineLength(road) - 2000) < 1, 'length');

// circle of r=100 m centred on the road at 1000 m -> 200 m inside
let c = G.clipPolylineToCircle(road, lat0, east(1000), 100);
assert.ok(Math.abs(c.insideLen - 200) < 0.5, `inside length ${c.insideLen}`);
assert.ok(c.fIn < 0.11 && c.fIn > 0.09, 'fIn of long edge with small circle < 0.1(ish)');
assert.strictEqual(c.pieces.length, 1, 'one contiguous piece across a vertex');

// small circle on a long edge: fIn < 0.1
c = G.clipPolylineToCircle(road, lat0, east(500), 50);
assert.ok(c.fIn < 0.1, `fIn=${c.fIn}`);

// circle offset 60 m north with r=100: chord = 2*sqrt(100^2-60^2) = 160 m
c = G.clipPolylineToCircle(road, lat0 + 60 / 110540, east(1000), 100);
assert.ok(Math.abs(c.insideLen - 160) < 1, `chord ${c.insideLen}`);

// circle that misses the road
c = G.clipPolylineToCircle(road, lat0 + 200 / 110540, east(1000), 100);
assert.strictEqual(c.insideLen, 0);

// snapping returns a point ON the polyline (perpendicular foot)
const grid = new G.SpatialGrid(250);
grid.insert(7, road);
grid.insert(8, [[east(0), lat0 + 0.01], [east(500), lat0 + 0.01]]);  // ~1.1 km north, far away
const s = grid.snap(lat0 + 40 / 110540, east(730), 150);
assert.strictEqual(s.eid, 7);
assert.ok(Math.abs(s.dist - 40) < 0.5, `snap dist ${s.dist}`);
assert.ok(G.nearestOnPolyline(s.lat, s.lon, road).dist < 0.01, 'snapped point lies on polyline');
assert.ok(Math.abs(s.along - 730) < 1, 'along');
assert.strictEqual(grid.snap(lat0 + 300 / 110540, east(730), 150), null, 'nothing within 150 m');

// effects: soft threat -> fractional penalty; hard threat -> Infinity
let eff = G.computeThreatEffects([{ id: 'a', lat: lat0, lon: east(1000), radius_m: 100, impact: 60 }], grid, 90);
const e7 = eff.get(7);
assert.ok(e7 && !e7.hard && !eff.has(8));
const w = 20, wThreat = G.threatWeight(w, 60);         // max(20,60) * (1 + 3*0.6) = 168
assert.ok(Math.abs(wThreat - 168) < 1e-6);
const wEff = G.effectiveWeight(w, e7);
assert.ok(Math.abs(wEff - (w * 0.9 + wThreat * 0.1)) < 0.2, `w_eff=${wEff}`);
assert.ok(wEff < 40 && wEff < wThreat / 4, 'a small threat on a 2 km road is only a small bump (~35 vs 168)');

eff = G.computeThreatEffects([{ id: 'b', lat: lat0, lon: east(1000), radius_m: 30, impact: 92 }], grid, 90);
assert.strictEqual(G.effectiveWeight(w, eff.get(7)), Infinity, 'hard block: edge impassable');
assert.strictEqual(G.effectiveProb(0.01, eff.get(7)), 1);

// cleared threats have no effect
eff = G.computeThreatEffects([{ id: 'c', lat: lat0, lon: east(1000), radius_m: 100, impact: 92, status: 'cleared' }], grid, 90);
assert.strictEqual(eff.size, 0);

console.log('test_threat_geometry.js: all threat-geometry checks passed');
