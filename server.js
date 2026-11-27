// SANCHAR server (Smart AI Navigation for Convoy Hazard Avoidance & Rerouting) - Node built-ins only (http, fs, path, child_process).
//
//  static files            GET  /...
//  threat database (M11)   GET/POST /api/threats, PATCH/DELETE /api/threats/:id,
//                          GET /api/threats/export.csv, POST /api/intel/apply
//  live updates (M11)      GET  /api/stream   (Server-Sent Events)
//  event log (M13)         GET/POST /api/events
//  SITREP parsing          POST /parse-sitrep (spawns gemini_api.py)
//  intel feed (simple)     GET  /fetch-live-threats
//  health check            GET  /healthz
// Static files come from an allowlist only, gzip-compressed (cached in memory) with ETag / 304.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { JsonStore } = require('./lib/store');
const SR = require('./lib/sitrep');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STARTED = Date.now();
const ROOT = __dirname;
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DB_FILE = process.env.SITREP_DB || path.join(ROOT, 'data', 'sitrep_db.json');

// ------------------------------------------------------------------ config shared with the frontend
const TT = JSON.parse(fs.readFileSync(path.join(ROOT, 'threat_types.json'), 'utf8'));
function regionBounds() {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'region.json'), 'utf8')).region.bounds; } catch (e) { return null; }
}
const CFG = { types: TT.types, rMin: TT.radius_min_m, rMax: TT.radius_max_m, hardBlock: TT.hard_block_impact, bounds: regionBounds() };

// ------------------------------------------------------------------ stores
let seqDay = '', seqN = 0;
function newThreatId(db) {
    const d = new Date();
    const day = d.toISOString().slice(0, 10).replace(/-/g, '');
    if (day !== seqDay) {
        seqDay = day;
        seqN = db ? db.records.filter(r => r.id.startsWith(`THR-${day}-`)).length : 0;
    }
    seqN++;
    return `THR-${day}-${String(seqN).padStart(4, '0')}`;
}

function seedFromIntel() {
    try {
        const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live_threats.json'), 'utf8'));
        const now = new Date().toISOString();
        return live.events.map((e, i) => finalize({
            id: e.id || `INTEL-${String(i + 1).padStart(3, '0')}`,
            lat: e.lat, lon: e.lon, type: e.type, impact: e.impact,
            radius_m: e.radius_m || (TT.types[e.type] || {}).radius_m || 100,
            location_label: e.location_label || e.location || '', resolution: 'coordinates', confidence: 'high',
            source: 'intel_feed', description: e.description, sitrep_text: e.description,
            reported_by: 'Intel feed (synthetic)', notes: '', created_at: now, expires_at: null,
            status: 'pending', version: 1, history: [{ at: now, action: 'received', by: 'Intel feed' }]
        }));
    } catch (e) {
        return [];
    }
}

function finalize(r) {
    r.dtg = SR.dtg(r.created_at);
    r.sitrep_line = SR.sitrepLine(r, CFG.types, CFG.hardBlock);
    if (r.source !== 'sitrep_text' && r.source !== 'intel_feed') r.sitrep_text = r.sitrep_line;
    r.updated_at = new Date().toISOString();
    return r;
}

const db = new JsonStore(DB_FILE, seedFromIntel);
if (!db.data.events) db.data.events = [];

// ------------------------------------------------------------------ SSE
const clients = new Set();
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

// ------------------------------------------------------------------ expiry
function expireThreats() {
    const now = Date.now();
    for (const r of db.records) {
        if (r.status === 'active' && r.expires_at && Date.parse(r.expires_at) <= now) {
            r.status = 'expired';
            r.version = (r.version || 1) + 1;
            r.history.push({ at: new Date().toISOString(), action: 'expired', by: 'system' });
            finalize(r);
            db.save();
            broadcast('threat_updated', r);
        }
    }
}
setInterval(expireThreats, 15000).unref();

// ------------------------------------------------------------------ helpers
const mimeTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.geojson': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8'
};

function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
        size += c.length;
        if (size > 1e6) { req.destroy(); return; }
        chunks.push(c);
    });
    req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

function readJSONBody(req, res, cb) {
    readBody(req, (body) => {
        try { cb(body ? JSON.parse(body) : {}); } catch (e) { sendJSON(res, 400, { error: 'invalid JSON body' }); }
    });
}

function runPython(script, input, cb, exe = PYTHON) {
    const py = spawn(exe, [path.join(ROOT, script)], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) py.kill(); }, 30000);
    py.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (e.code === 'ENOENT' && exe !== 'python') return runPython(script, input, cb, 'python');
        cb(e);
    });
    py.stdout.on('data', d => out += d.toString('utf8'));
    py.stderr.on('data', d => err += d.toString('utf8'));
    py.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) console.error(`[${script}]`, err.trim().slice(0, 500));
        if (code !== 0) return cb(new Error(`exit ${code}`));
        cb(null, out);
    });
    py.stdin.write(Buffer.from(input, 'utf8'));
    py.stdin.end();
}

const PATCHABLE = ['lat', 'lon', 'radius_m', 'type', 'impact', 'location_label', 'resolution', 'confidence',
                   'status', 'notes', 'description', 'expires_at', 'reported_by'];

// ------------------------------------------------------------------ threat API
function handleThreats(req, res, url, q) {
    // list
    if (url === '/api/threats' && req.method === 'GET') {
        let recs = db.records;
        for (const k of ['status', 'source', 'type']) {
            if (q.get(k)) { const vals = q.get(k).split(','); recs = recs.filter(r => vals.includes(r[k])); }
        }
        return sendJSON(res, 200, { records: recs, count: recs.length, data_label: 'SYNTHETIC - for demonstration only' });
    }
    if (url === '/api/threats/export.csv' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sanchar_sitrep_log.csv"' });
        return res.end(SR.toCSV(db.records));
    }
    // create
    if (url === '/api/threats' && req.method === 'POST') {
        return readJSONBody(req, res, (b) => {
            const info = CFG.types[b.type] || {};
            b.impact = b.impact ?? info.impact;
            b.radius_m = b.radius_m ?? info.radius_m;
            const err = SR.validate(b, CFG, true);
            if (err) return sendJSON(res, 422, { error: err });
            const now = new Date();
            const by = b.reported_by || 'Ops desk';
            const ttl = info.ttl_min;
            const rec = finalize({
                id: newThreatId(db), lat: +(+b.lat).toFixed(6), lon: +(+b.lon).toFixed(6),
                radius_m: Math.round(+b.radius_m), type: b.type, impact: Math.round(+b.impact),
                location_label: String(b.location_label || '').slice(0, 200),
                resolution: b.resolution || 'map_click', confidence: b.confidence || 'high',
                source: b.source || 'manual_map', description: String(b.description || '').slice(0, 1000),
                sitrep_text: String(b.sitrep_text || '').slice(0, 2000), reported_by: String(by).slice(0, 80),
                notes: String(b.notes || '').slice(0, 1000),
                created_at: now.toISOString(),
                expires_at: b.expires_at !== undefined ? b.expires_at : (ttl ? new Date(now.getTime() + ttl * 60000).toISOString() : null),
                status: 'active', version: 1,
                history: [{ at: now.toISOString(), action: 'created', by }]
            });
            db.insert(rec);
            broadcast('threat_created', rec);
            sendJSON(res, 201, rec);
        });
    }
    // activate pending intel-feed records ("Fetch intel reports")
    if (url === '/api/intel/apply' && req.method === 'POST') {
        const now = new Date().toISOString();
        const changed = [];
        for (const r of db.records) {
            if (r.source === 'intel_feed' && r.status === 'pending') {
                r.status = 'active';
                r.version = (r.version || 1) + 1;
                r.history.push({ at: now, action: 'activated', by: 'Ops desk' });
                finalize(r);
                changed.push(r);
            }
        }
        if (changed.length) db.save();
        changed.forEach(r => broadcast('threat_updated', r));
        const active = db.records.filter(r => r.source === 'intel_feed' && r.status === 'active');
        return sendJSON(res, 200, { activated: changed.length, records: active });
    }
    const m = url.match(/^\/api\/threats\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'PATCH') {
        return readJSONBody(req, res, (b) => {
            const cur = db.find(m[1]);
            if (!cur) return sendJSON(res, 404, { error: 'not found' });
            const changes = {};
            for (const k of PATCHABLE) if (b[k] !== undefined) changes[k] = b[k];
            const err = SR.validate({ ...changes, lat: changes.lat ?? (changes.lon !== undefined ? cur.lat : undefined),
                                      lon: changes.lon ?? (changes.lat !== undefined ? cur.lon : undefined) }, CFG, false);
            if (err) return sendJSON(res, 422, { error: err });
            const diff = {};
            for (const [k, v] of Object.entries(changes)) if (cur[k] !== v) diff[k] = { from: cur[k], to: v };
            if (!Object.keys(diff).length) return sendJSON(res, 200, cur);
            const action = diff.status ? (changes.status === 'cleared' ? 'cleared' : `status:${changes.status}`)
                : (diff.lat || diff.lon) ? 'moved' : 'edited';
            const rec = db.update(m[1], (r) => {
                Object.assign(r, changes);
                if (changes.radius_m !== undefined) r.radius_m = Math.round(+r.radius_m);
                if (changes.impact !== undefined) r.impact = Math.round(+r.impact);
                r.version = (r.version || 1) + 1;
                r.history.push({ at: new Date().toISOString(), action, by: b.by || 'Ops desk', changes: diff });
                finalize(r);
            });
            broadcast(rec.status === 'active' ? 'threat_updated' : 'threat_cleared', rec);
            sendJSON(res, 200, rec);
        });
    }
    if (m && req.method === 'DELETE') {
        const cur = db.find(m[1]);
        if (!cur) return sendJSON(res, 404, { error: 'not found' });
        const rec = db.update(m[1], (r) => {     // soft delete: kept in history
            if (r.status !== 'cleared') {
                r.status = 'cleared';
                r.version = (r.version || 1) + 1;
                r.history.push({ at: new Date().toISOString(), action: 'cleared', by: q.get('by') || 'Ops desk' });
                finalize(r);
            }
        });
        broadcast('threat_cleared', rec);
        return sendJSON(res, 200, rec);
    }
    return false;
}

// ------------------------------------------------------------------ event log (reroutes, live events)
function handleEvents(req, res, url) {
    if (url !== '/api/events') return false;
    if (req.method === 'GET') return sendJSON(res, 200, { events: db.data.events.slice(-500) });
    if (req.method === 'POST') {
        return readJSONBody(req, res, (b) => {
            const ev = { id: `EVT-${Date.now()}-${Math.floor(Math.random() * 1000)}`, at: new Date().toISOString(),
                         dtg: SR.dtg(), kind: String(b.kind || 'note').slice(0, 40), convoy: b.convoy || null,
                         text: String(b.text || '').slice(0, 500), data: b.data || null };
            db.data.events.push(ev);
            if (db.data.events.length > 2000) db.data.events.splice(0, db.data.events.length - 2000);
            db.save();
            broadcast('event_logged', ev);
            sendJSON(res, 201, ev);
        });
    }
    return false;
}

// ------------------------------------------------------------------ live (M13): scenarios + external position feed
const positions = {};   // convoy id -> last reported position
function handleLive(req, res, url) {
    if (url === '/api/scenarios' && req.method === 'GET') {
        const dir = path.join(ROOT, 'data', 'scenarios');
        let list = [];
        try {
            list = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
                const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                return { file: f, name: j.name || f, description: j.description || '' };
            });
        } catch (e) { /* no scenarios */ }
        return sendJSON(res, 200, { scenarios: list });
    }
    const m = url.match(/^\/api\/convoys\/([A-Za-z0-9_-]+)\/position$/);
    if (m && req.method === 'POST') {
        return readJSONBody(req, res, (b) => {
            const lat = Number(b.lat), lon = Number(b.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJSON(res, 422, { error: 'lat and lon are required numbers' });
            const p = { id: m[1], lat, lon, speed_kmph: Number.isFinite(+b.speed_kmph) ? +b.speed_kmph : null,
                        heading: Number.isFinite(+b.heading) ? +b.heading : null, ts: b.ts || new Date().toISOString() };
            positions[m[1]] = p;
            broadcast('convoy_position', p);
            sendJSON(res, 202, p);
        });
    }
    if (url === '/api/convoys/positions' && req.method === 'GET') return sendJSON(res, 200, { positions });
    return false;
}

// ------------------------------------------------------------------ convoys (M14)
const CONVOYS_FILE = process.env.CONVOYS_DB || path.join(ROOT, 'data', 'convoys.json');
const convoysDb = new JsonStore(CONVOYS_FILE, () => []);
const PROFILES = ['fastest', 'balanced', 'safest'];
const CONVOY_FIELDS = ['call_sign', 'color', 'start', 'dest', 'sp_time', 'priority', 'vehicles', 'spacing_m', 'speed_kmph', 'profile'];

function validateConvoy(b, full) {
    const has = (k) => b[k] !== undefined;
    if ((full || has('call_sign')) && !(typeof b.call_sign === 'string' && b.call_sign.trim().length >= 1 && b.call_sign.length <= 24)) return 'call_sign is required (1-24 chars)';
    if (has('sp_time') && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(b.sp_time))) return 'sp_time must be HH:MM';
    if (has('priority') && ![1, 2, 3].includes(Number(b.priority))) return 'priority must be 1, 2 or 3';
    if (has('vehicles') && !(Number(b.vehicles) >= 1 && Number(b.vehicles) <= 200)) return 'vehicles must be 1-200';
    if (has('spacing_m') && !(Number(b.spacing_m) >= 10 && Number(b.spacing_m) <= 500)) return 'spacing_m must be 10-500';
    if (has('speed_kmph') && !(Number(b.speed_kmph) >= 5 && Number(b.speed_kmph) <= 80)) return 'speed_kmph must be 5-80';
    if (has('profile') && !PROFILES.includes(b.profile)) return `profile must be one of ${PROFILES.join(', ')}`;
    for (const k of ['start', 'dest']) {
        if (has(k) && b[k] !== null && !(Number.isFinite(+b[k].lat) && Number.isFinite(+b[k].lon))) return `${k} must be {lat, lon} or null`;
    }
    return null;
}

function handleConvoys(req, res, url) {
    if (url === '/api/convoys' && req.method === 'GET') return sendJSON(res, 200, { records: convoysDb.records });
    if (url === '/api/convoys' && req.method === 'POST') {
        return readJSONBody(req, res, (b) => {
            const err = validateConvoy(b, true);
            if (err) return sendJSON(res, 422, { error: err });
            const n = convoysDb.records.reduce((m, r) => Math.max(m, +(r.id.split('-')[1]) || 0), 0) + 1;
            const now = new Date().toISOString();
            const rec = { id: `CVY-${String(n).padStart(3, '0')}`, call_sign: b.call_sign.trim(), color: b.color || '#4ea1ff',
                          start: b.start || null, dest: b.dest || null, sp_time: b.sp_time || '07:30', priority: Number(b.priority || 2),
                          vehicles: Number(b.vehicles || 10), spacing_m: Number(b.spacing_m || 50), speed_kmph: Number(b.speed_kmph || 30),
                          profile: b.profile || 'balanced', created_at: now, updated_at: now, version: 1 };
            convoysDb.insert(rec);
            broadcast('convoys_changed', { action: 'created', record: rec });
            sendJSON(res, 201, rec);
        });
    }
    const m = url.match(/^\/api\/convoys\/(CVY-\d+)$/);
    if (m && req.method === 'PATCH') {
        return readJSONBody(req, res, (b) => {
            if (!convoysDb.find(m[1])) return sendJSON(res, 404, { error: 'not found' });
            const err = validateConvoy(b, false);
            if (err) return sendJSON(res, 422, { error: err });
            const rec = convoysDb.update(m[1], (r) => {
                for (const k of CONVOY_FIELDS) if (b[k] !== undefined) r[k] = ['priority', 'vehicles', 'spacing_m', 'speed_kmph'].includes(k) ? Number(b[k]) : b[k];
                r.updated_at = new Date().toISOString();
                r.version = (r.version || 1) + 1;
            });
            broadcast('convoys_changed', { action: 'updated', record: rec });
            sendJSON(res, 200, rec);
        });
    }
    if (m && req.method === 'DELETE') {
        const rec = convoysDb.remove(m[1]);
        if (!rec) return sendJSON(res, 404, { error: 'not found' });
        broadcast('convoys_changed', { action: 'deleted', record: rec });
        return sendJSON(res, 200, rec);
    }
    return false;
}

// ------------------------------------------------------------------ server
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const url = u.pathname;
    if (!url.startsWith('/api/stream')) console.log(`${req.method} ${url}`);

    if (url === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }
    if (url.startsWith('/api/threats') || url === '/api/intel/apply') {
        if (handleThreats(req, res, url, u.searchParams) !== false) return;
    }
    if (url === '/api/events') {
        if (handleEvents(req, res, url) !== false) return;
    }
    if ((url === '/api/scenarios' || url.startsWith('/api/convoys/')) && handleLive(req, res, url) !== false) return;
    if (url.startsWith('/api/convoys') && handleConvoys(req, res, url) !== false) return;
    if (typeof extraRoutes === 'function' && extraRoutes(req, res, url, u.searchParams) !== false) return;
    if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown API route' });

    // intel-feed records from the database in a compact format
    if (url === '/fetch-live-threats' && req.method === 'GET') {
        const recs = db.records.filter(r => r.source === 'intel_feed' && (r.status === 'active' || r.status === 'pending'));
        return sendJSON(res, 200, {
            success: recs.length > 0,
            events: recs.map(r => ({ id: r.id, lat: r.lat, lon: r.lon, type: r.type, impact: r.impact, radius_m: r.radius_m,
                                     location: r.location_label, location_label: r.location_label, description: r.description, status: r.status })),
            source: 'SYNTHETIC - for demonstration only', timestamp: new Date().toISOString()
        });
    }

    if (url === '/parse-sitrep' && req.method === 'POST') {
        return readBody(req, (body) => {
            runPython('gemini_api.py', body, (err, out) => {
                if (err) return sendJSON(res, 500, { status: 'error', message: `SITREP parser failed (${err.message})` });
                try {
                    const parsed = JSON.parse(out.trim().split('\n').pop());
                    sendJSON(res, parsed.status === 'error' ? 422 : 200, parsed);
                } catch (e) {
                    sendJSON(res, 500, { status: 'error', message: 'SITREP parser returned invalid JSON' });
                }
            });
        });
    }

    if (url === '/healthz') {
        return sendJSON(res, 200, { status: 'ok', name: 'SANCHAR', uptime_s: Math.round((Date.now() - STARTED) / 1000) });
    }

    serveStatic(req, res, url);
});

// ------------------------------------------------------------------ static files: allowlist + gzip + ETag
// Only these files / folders are public. Everything else (server code, .env, databases,
// pipeline, models, package.json ...) is never served.
const PUBLIC_FILES = new Set(['/index.html', '/style.css', '/app.js', '/pathfinding.js', '/favicon.svg',
    '/threat_types.json', '/routing_graph.json', '/routing_edges.geojson', '/routing_edges.csv',
    '/data/landmarks.json', '/data/live_threats.json', '/data/region.json']);
const PUBLIC_DIRS = [/^\/js\/[\w.-]+\.js$/, /^\/data\/scenarios\/[\w.-]+\.json$/];
const COMPRESSIBLE = new Set(['.json', '.geojson', '.js', '.css', '.html', '.csv', '.svg']);
const DATA_EXT = new Set(['.json', '.geojson', '.csv']);
const gzCache = new Map();   // path -> {mtimeMs, size, buf, pending}

function isPublic(p) {
    return PUBLIC_FILES.has(p) || PUBLIC_DIRS.some(re => re.test(p));
}

function gzipCached(filePath, st) {
    const hit = gzCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.buf ? Promise.resolve(hit.buf) : hit.pending;
    const pending = fs.promises.readFile(filePath).then(raw => new Promise((resolve, reject) =>
        zlib.gzip(raw, { level: 6 }, (err, buf) => (err ? reject(err) : resolve(buf)))))
        .then(buf => { gzCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, buf }); return buf; })
        .catch(e => { gzCache.delete(filePath); throw e; });
    gzCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, pending });
    return pending;
}

function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (req.url.includes('..') || req.url.includes('\\')) { res.writeHead(403); return res.end('Forbidden'); }
    let rel;
    try { rel = decodeURIComponent(url === '/' ? '/index.html' : url); } catch (e) { res.writeHead(400); return res.end(); }
    if (!isPublic(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h1>404 - File Not Found</h1>');
    }
    const filePath = path.join(ROOT, rel);
    if (!filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<h1>404 - File Not Found</h1>');
        }
        const ext = path.extname(filePath).toLowerCase();
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        const headers = {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'ETag': etag,
            'Cache-Control': DATA_EXT.has(ext) ? 'public, max-age=3600' : 'no-cache',
            'Vary': 'Accept-Encoding',
            'X-Uncompressed-Length': String(st.size),   // lets the loading bar show real progress under gzip
        };
        if ((req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
            res.writeHead(304, headers);
            return res.end();
        }
        const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext) && st.size > 1024;
        if (!wantsGzip) {
            res.writeHead(200, { ...headers, 'Content-Length': st.size });
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(filePath).pipe(res);
        }
        gzipCached(filePath, st).then(buf => {
            res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
            res.end(req.method === 'HEAD' ? undefined : buf);
        }).catch(() => {
            res.writeHead(200, { ...headers, 'Content-Length': st.size });
            fs.createReadStream(filePath).pipe(res);
        });
    });
}

/** Pre-compress the two big data files so the first visitor does not wait for gzip. */
function warmGzip() {
    for (const f of ['routing_graph.json', 'routing_edges.geojson']) {
        const fp = path.join(ROOT, f);
        fs.stat(fp, (err, st) => {
            if (err) return;
            const t0 = Date.now();
            gzipCached(fp, st).then(buf => console.log(`${f} ${(st.size / 1e6).toFixed(1)} MB -> ${(buf.length / 1e6).toFixed(1)} MB gzip (${Date.now() - t0} ms)`))
                .catch(e => console.error(`gzip ${f} failed: ${e.message}`));
        });
    }
}

let extraRoutes = null;   // set by later milestones (convoys, positions)
server.setExtraRoutes = (fn) => { extraRoutes = fn; };
server.db = db;
server.broadcast = broadcast;
server.sendJSON = sendJSON;
server.readJSONBody = readJSONBody;

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        console.log(`Server running at http://localhost:${PORT}/ (listening on ${HOST})`);
        console.log('SANCHAR · Smart AI Navigation for Convoy Hazard Avoidance & Rerouting');
        console.log(`SITREP database: ${path.relative(ROOT, DB_FILE)} (${db.records.length} records)`);
        warmGzip();
    });
}

module.exports = server;
