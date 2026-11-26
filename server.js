// Convoy Route Planner server - Node built-ins only (http, fs, path, child_process).
//
//  static files            GET  /...
//  threat database (M11)   GET/POST /api/threats, PATCH/DELETE /api/threats/:id,
//                          GET /api/threats/export.csv, POST /api/intel/apply
//  live updates (M11)      GET  /api/stream   (Server-Sent Events)
//  event log (M13)         GET/POST /api/events
//  SITREP parsing          POST /parse-sitrep (spawns gemini_api.py)
//  legacy aliases          GET  /fetch-live-threats, /fetch-live-crimes
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { JsonStore } = require('./lib/store');
const SR = require('./lib/sitrep');

const PORT = process.env.PORT || 3000;
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
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sitrep_log.csv"' });
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
    if (typeof extraRoutes === 'function' && extraRoutes(req, res, url, u.searchParams) !== false) return;
    if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown API route' });

    // legacy alias: intel-feed records from the database, in the old frontend format
    if ((url === '/fetch-live-threats' || url === '/fetch-live-crimes') && req.method === 'GET') {
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

    if (url === '/chat' && req.method === 'POST') {   // legacy Toronto assistant
        return readBody(req, (body) => runPython(path.join('legacy_toronto', 'gemini_api.py'), body, (err, out) => {
            if (err) return sendJSON(res, 500, { error: 'Python script error' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(out);
        }));
    }

    // static files (no traversal outside ROOT; never serve the databases)
    let filePath;
    try { filePath = path.normalize(path.join(ROOT, decodeURIComponent(url === '/' ? '/index.html' : url))); } catch (e) { res.writeHead(400); return res.end(); }
    if (!filePath.startsWith(ROOT) || /sitrep_db|convoys\.json/.test(filePath)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end('<h1>404 - File Not Found</h1>');
        }
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': st.size });
        fs.createReadStream(filePath).pipe(res);
    });
});

let extraRoutes = null;   // set by later milestones (convoys, positions)
server.setExtraRoutes = (fn) => { extraRoutes = fn; };
server.db = db;
server.broadcast = broadcast;
server.sendJSON = sendJSON;
server.readJSONBody = readJSONBody;

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}/`);
        console.log('AI-Based Safest Route Planner for Mobile Convoys');
        console.log(`SITREP database: ${path.relative(ROOT, DB_FILE)} (${db.records.length} records)`);
    });
}

module.exports = server;
