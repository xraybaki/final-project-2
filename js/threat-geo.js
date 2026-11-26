/**
 * Threat geometry (M9) - pure functions, usable in the browser and in Node tests.
 *
 *  - SpatialGrid: 250 m cells -> edge ids, so snapping / zone checks never scan all edges
 *  - nearestOnPolyline / snapToRoad: perpendicular projection onto road geometry
 *  - clipPolylineToCircle: length (and pieces) of a polyline inside a circle
 *  - computeThreatEffects: per-edge effect of all active threats
 *  - effectiveWeight / effectiveProb: fractional soft penalty, hard block for impact >= 90
 *
 * Coordinates are [lon, lat] (GeoJSON order) for polylines; points are {lat, lon}.
 * A local equirectangular projection (metres) is used - accurate to <0.5% at city scale.
 */
(function (root) {
    'use strict';

    const KY = 110540;
    const kx = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

    function toXY(lat, lon, ref) {
        return [(lon - ref.lon) * kx(ref.lat), (lat - ref.lat) * KY];
    }

    function fromXY(x, y, ref) {
        return { lat: ref.lat + y / KY, lon: ref.lon + x / kx(ref.lat) };
    }

    function polylineLength(coords) {
        let L = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const ref = { lat: coords[i][1], lon: coords[i][0] };
            const b = toXY(coords[i + 1][1], coords[i + 1][0], ref);
            L += Math.hypot(b[0], b[1]);
        }
        return L;
    }

    /** Nearest point on a polyline to (lat, lon): {dist, lat, lon, seg, t, along} */
    function nearestOnPolyline(lat, lon, coords) {
        const ref = { lat, lon };
        let best = { dist: Infinity }, along = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = toXY(coords[i][1], coords[i][0], ref);
            const b = toXY(coords[i + 1][1], coords[i + 1][0], ref);
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L2)) : 0;
            const px = a[0] + t * dx, py = a[1] + t * dy;
            const d = Math.hypot(px, py);
            if (d < best.dist) {
                const p = fromXY(px, py, ref);
                best = { dist: d, lat: p.lat, lon: p.lon, seg: i, t, along: along + t * Math.sqrt(L2) };
            }
            along += Math.sqrt(L2);
        }
        return best;
    }

    /** Circle / polyline clip: {insideLen, totalLen, fIn, pieces: [[[lat,lon],...], ...]} */
    function clipPolylineToCircle(coords, clat, clon, r) {
        const ref = { lat: clat, lon: clon };
        let inside = 0, total = 0;
        const pieces = [];
        let cur = null;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = toXY(coords[i][1], coords[i][0], ref);
            const b = toXY(coords[i + 1][1], coords[i + 1][0], ref);
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L = Math.hypot(dx, dy);
            total += L;
            if (L === 0) continue;
            // |a + t d|^2 = r^2  ->  A t^2 + B t + C = 0
            const A = dx * dx + dy * dy, B = 2 * (a[0] * dx + a[1] * dy), Cc = a[0] * a[0] + a[1] * a[1] - r * r;
            const disc = B * B - 4 * A * Cc;
            if (disc <= 0) { cur = null; continue; }
            const s = Math.sqrt(disc);
            const t0 = Math.max(0, (-B - s) / (2 * A)), t1 = Math.min(1, (-B + s) / (2 * A));
            if (t1 <= t0) { cur = null; continue; }
            inside += (t1 - t0) * L;
            const p0 = fromXY(a[0] + t0 * dx, a[1] + t0 * dy, ref);
            const p1 = fromXY(a[0] + t1 * dx, a[1] + t1 * dy, ref);
            if (cur && t0 === 0) {
                cur.push([p1.lat, p1.lon]);
            } else {
                cur = [[p0.lat, p0.lon], [p1.lat, p1.lon]];
                pieces.push(cur);
            }
            if (t1 < 1) cur = null;
        }
        return { insideLen: inside, totalLen: total, fIn: total > 0 ? Math.min(1, inside / total) : 0, pieces };
    }

    /** Uniform grid over edge bounding boxes (cell size in metres). */
    class SpatialGrid {
        constructor(cellM = 250, ref = null) {
            this.cell = cellM;
            this.ref = ref;
            this.cells = new Map();
            this.geoms = new Map();
        }
        _key(ix, iy) { return ix * 100003 + iy; }
        _ix(lat, lon) {
            const p = toXY(lat, lon, this.ref);
            return [Math.floor(p[0] / this.cell), Math.floor(p[1] / this.cell)];
        }
        insert(id, coords) {
            if (!this.ref) this.ref = { lat: coords[0][1], lon: coords[0][0] };
            this.geoms.set(id, coords);
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (const c of coords) {
                const [ix, iy] = this._ix(c[1], c[0]);
                minx = Math.min(minx, ix); maxx = Math.max(maxx, ix);
                miny = Math.min(miny, iy); maxy = Math.max(maxy, iy);
            }
            for (let ix = minx; ix <= maxx; ix++) {
                for (let iy = miny; iy <= maxy; iy++) {
                    const k = this._key(ix, iy);
                    if (!this.cells.has(k)) this.cells.set(k, []);
                    this.cells.get(k).push(id);
                }
            }
        }
        /** ids whose bbox cells intersect the square of half-size r around (lat, lon) */
        query(lat, lon, r) {
            const out = new Set();
            if (!this.ref) return out;
            const [cx, cy] = this._ix(lat, lon);
            const n = Math.ceil(r / this.cell);
            for (let ix = cx - n; ix <= cx + n; ix++) {
                for (let iy = cy - n; iy <= cy + n; iy++) {
                    const ids = this.cells.get(this._key(ix, iy));
                    if (ids) for (const id of ids) out.add(id);
                }
            }
            return out;
        }
        /** Snap to nearest road within maxDist: {eid, dist, lat, lon, along} or null */
        snap(lat, lon, maxDist = 150, allowed = null) {
            let best = null;
            for (const id of this.query(lat, lon, maxDist)) {
                if (allowed && !allowed.has(id)) continue;
                const p = nearestOnPolyline(lat, lon, this.geoms.get(id));
                if (p.dist <= maxDist && (!best || p.dist < best.dist)) best = { eid: id, ...p };
            }
            return best;
        }
    }

    /**
     * Per-edge effect of threats.
     * threats: [{id, lat, lon, radius_m, impact, status}]
     * returns Map eid -> {hard, maxImpact, parts: [{threatId, impact, fIn}], pieces: [{threatId, impact, latlngs}]}
     */
    function computeThreatEffects(threats, grid, hardBlockImpact = 90) {
        const effects = new Map();
        for (const t of threats) {
            if (t.status && t.status !== 'active') continue;
            for (const eid of grid.query(t.lat, t.lon, t.radius_m)) {
                const clip = clipPolylineToCircle(grid.geoms.get(eid), t.lat, t.lon, t.radius_m);
                if (clip.insideLen <= 0) continue;
                let e = effects.get(eid);
                if (!e) { e = { hard: false, maxImpact: 0, parts: [], pieces: [] }; effects.set(eid, e); }
                if (t.impact >= hardBlockImpact) e.hard = true;
                e.maxImpact = Math.max(e.maxImpact, t.impact);
                e.parts.push({ threatId: t.id, impact: t.impact, fIn: clip.fIn });
                clip.pieces.forEach(p => e.pieces.push({ threatId: t.id, impact: t.impact, latlngs: p }));
            }
        }
        return effects;
    }

    /** Risk weight of a segment fully inside a threat of this impact (unchanged M6 formula). */
    function threatWeight(w, impact) {
        return Math.max(w, impact) * (1 + 3 * impact / 100);
    }

    /**
     * Effective weight: Infinity if hard-blocked; otherwise the penalty applies only to the
     * fraction of the edge inside threat circles:  w_eff = w(1 - f) + w_threat * f.
     * Several overlapping threats: highest impact first, fractions capped at 1 in total.
     */
    function effectiveWeight(w, effect) {
        if (!effect) return w;
        if (effect.hard) return Infinity;
        let remaining = 1, out = 0;
        for (const p of effect.parts.slice().sort((a, b) => b.impact - a.impact)) {
            const f = Math.min(p.fIn, remaining);
            out += f * threatWeight(w, p.impact);
            remaining -= f;
            if (remaining <= 0) break;
        }
        return out + remaining * w;
    }

    /** Per-traversal incident probability under threats (same fractional logic). */
    function effectiveProb(p, effect) {
        if (!effect) return p;
        if (effect.hard) return 1;
        let surv = 1 - p;
        for (const part of effect.parts) surv *= 1 - 0.5 * (part.impact / 100) * part.fIn;
        return 1 - surv;
    }

    const api = { toXY, fromXY, polylineLength, nearestOnPolyline, clipPolylineToCircle, SpatialGrid,
                  computeThreatEffects, threatWeight, effectiveWeight, effectiveProb };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ThreatGeo = api;
})(typeof window !== 'undefined' ? window : globalThis);
