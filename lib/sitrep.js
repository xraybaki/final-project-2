// Threat record validation, military DTG, auto-generated one-line SITREPs, CSV export.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SOURCES = { manual_map: 'MANUAL MAP ENTRY', sitrep_text: 'SITREP TEXT', intel_feed: 'INTEL FEED' };
const STATUSES = ['pending', 'active', 'cleared', 'expired'];

/** Military date-time group, e.g. 270145Z NOV 26 (UTC). */
function dtg(date = new Date()) {
    const d = new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

function fmtLatLon(lat, lon) {
    return `${Math.abs(lat).toFixed(5)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(5)}${lon >= 0 ? 'E' : 'W'}`;
}

/** Standard one-line SITREP for any record. */
function sitrepLine(r, types, hardBlock) {
    const t = types[r.type] || { short: String(r.type).toUpperCase() };
    const impact = r.impact >= hardBlock ? `${r.impact} (ROAD CLOSED)` : String(r.impact);
    return [
        `SITREP ${dtg(r.created_at)}`,
        `TYPE: ${t.short}`,
        `LOC: ${fmtLatLon(r.lat, r.lon)}${r.location_label ? ` (${r.location_label})` : ''}`,
        `RADIUS: ${r.radius_m} m`,
        `IMPACT: ${impact}`,
        `SRC: ${SOURCES[r.source] || String(r.source).toUpperCase()}`,
        `BY: ${r.reported_by || 'Ops desk'}`,
        `STATUS: ${String(r.status).toUpperCase()}`,
        'SYNTHETIC'
    ].join(' | ');
}

/**
 * Validate a create (full=true) or patch (full=false) payload.
 * Returns an error string or null.
 */
function validate(body, cfg, full) {
    const has = (k) => body[k] !== undefined && body[k] !== null;
    if (full || has('type')) {
        if (!cfg.types[body.type]) return `type must be one of ${Object.keys(cfg.types).join(', ')}`;
    }
    if (full || has('impact')) {
        const v = Number(body.impact);
        if (!Number.isFinite(v) || v < 10 || v > 100) return 'impact must be a number between 10 and 100';
    }
    if (full || has('radius_m')) {
        const v = Number(body.radius_m);
        if (!Number.isFinite(v) || v < cfg.rMin || v > cfg.rMax) return `radius_m must be between ${cfg.rMin} and ${cfg.rMax}`;
    }
    if (full || has('lat') || has('lon')) {
        const lat = Number(body.lat), lon = Number(body.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'lat and lon are required numbers';
        if (cfg.bounds) {
            const [[s, w], [n, e]] = cfg.bounds;
            const pad = 0.01;
            if (lat < s - pad || lat > n + pad || lon < w - pad || lon > e + pad) return 'location is outside the operating area';
        }
    }
    if (has('status') && !STATUSES.includes(body.status)) return `status must be one of ${STATUSES.join(', ')}`;
    if (has('source') && !SOURCES[body.source]) return `source must be one of ${Object.keys(SOURCES).join(', ')}`;
    return null;
}

const CSV_COLS = ['id', 'dtg', 'created_at', 'status', 'type', 'impact', 'radius_m', 'lat', 'lon', 'location_label',
                  'resolution', 'confidence', 'source', 'reported_by', 'expires_at', 'sitrep_text', 'sitrep_line', 'notes'];

function toCSV(records) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [CSV_COLS.join(',')];
    for (const r of records) lines.push(CSV_COLS.map(c => esc(c === 'dtg' ? dtg(r.created_at) : r[c])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';   // BOM so Excel opens UTF-8 correctly
}

module.exports = { dtg, fmtLatLon, sitrepLine, validate, toCSV, STATUSES, SOURCES };
