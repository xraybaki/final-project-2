// Threat API (M11): start the server on a random port with a temp DB; CRUD, validation, SSE.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-'));
process.env.SITREP_DB = path.join(tmp, 'sitrep_db.json');
process.env.CONVOYS_DB = path.join(tmp, 'convoys.json');
const server = require('../server.js');

function req(port, method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const r = http.request({ host: '127.0.0.1', port, method, path: p,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
            let s = '';
            res.on('data', c => s += c);
            res.on('end', () => resolve({ status: res.statusCode, body: s, json: () => JSON.parse(s) }));
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const dbValid = () => JSON.parse(fs.readFileSync(process.env.SITREP_DB, 'utf8'));

server.listen(0, async () => {
    const port = server.address().port;
    try {
        // seeded from data/live_threats.json as pending intel records
        let r = await req(port, 'GET', '/api/threats');
        assert.strictEqual(r.status, 200);
        const seeded = r.json().records;
        assert.ok(seeded.length >= 1 && seeded.every(x => x.source === 'intel_feed' && x.status === 'pending'), 'seeded intel feed');

        // SSE: subscribe and collect events
        const events = [];
        const sse = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
            res.on('data', (c) => { const m = String(c).match(/event: (\w+)/g); if (m) events.push(...m.map(x => x.slice(7))); });
        });
        await new Promise(res => setTimeout(res, 150));

        // create (lat/lon inside the operating box)
        const region = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'region.json'), 'utf8')).region;
        const [lat, lon] = region.center;
        r = await req(port, 'POST', '/api/threats', { lat, lon, type: 'IED', radius_m: 100, location_label: 'Test Rd', source: 'manual_map' });
        assert.strictEqual(r.status, 201, r.body);
        const t = r.json();
        assert.ok(/^THR-\d{8}-\d{4}$/.test(t.id), t.id);
        assert.strictEqual(t.impact, 92, 'default impact from threat_types.json');
        assert.ok(t.sitrep_line.startsWith('SITREP ') && t.sitrep_line.includes('IMPACT: 92 (ROAD CLOSED)') && t.sitrep_line.endsWith('SYNTHETIC'));
        assert.strictEqual(t.sitrep_text, t.sitrep_line, 'manual threats get an auto-generated SITREP');
        dbValid();

        // list active
        r = await req(port, 'GET', '/api/threats?status=active');
        assert.deepStrictEqual(r.json().records.map(x => x.id), [t.id]);

        // patch radius
        r = await req(port, 'PATCH', `/api/threats/${t.id}`, { radius_m: 250 });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json().radius_m, 250);
        assert.strictEqual(r.json().history.slice(-1)[0].action, 'edited');
        assert.ok(r.json().sitrep_line.includes('RADIUS: 250 m'));
        dbValid();

        // move -> 'moved' history entry
        r = await req(port, 'PATCH', `/api/threats/${t.id}`, { lat: lat + 0.001, lon });
        assert.strictEqual(r.json().history.slice(-1)[0].action, 'moved');

        // validation
        r = await req(port, 'POST', '/api/threats', { lat, lon, type: 'IED', impact: 150 });
        assert.strictEqual(r.status, 422);
        r = await req(port, 'POST', '/api/threats', { lat, lon, type: 'IED', radius_m: 5 });
        assert.strictEqual(r.status, 422);
        r = await req(port, 'POST', '/api/threats', { lat: 51.5, lon: -0.12, type: 'IED' });
        assert.strictEqual(r.status, 422, 'outside operating area');
        r = await req(port, 'POST', '/api/threats', { lat, lon, type: 'alien' });
        assert.strictEqual(r.status, 422);
        r = await req(port, 'PATCH', `/api/threats/${t.id}`, { impact: 5 });
        assert.strictEqual(r.status, 422);

        // delete = soft delete
        r = await req(port, 'DELETE', `/api/threats/${t.id}`);
        assert.strictEqual(r.json().status, 'cleared');
        r = await req(port, 'GET', '/api/threats?status=active');
        assert.strictEqual(r.json().records.length, 0);
        assert.ok(dbValid().records.find(x => x.id === t.id).history.some(h => h.action === 'cleared'), 'kept in history');

        // intel apply activates pending feed records; /fetch-live-threats lists them
        r = await req(port, 'POST', '/api/intel/apply');
        assert.strictEqual(r.json().activated, seeded.length);
        r = await req(port, 'GET', '/fetch-live-threats');
        assert.ok(r.json().success && r.json().events.length === seeded.length);

        // CSV export
        r = await req(port, 'GET', '/api/threats/export.csv');
        assert.ok(r.body.includes('id,dtg,created_at,status') && r.body.includes(t.id));

        // database file is never served statically
        r = await req(port, 'GET', '/data/sitrep_db.json');
        assert.strictEqual(r.status, 403);

        await new Promise(res => setTimeout(res, 200));
        assert.ok(events.includes('threat_created') && events.includes('threat_updated') && events.includes('threat_cleared'), events.join(','));
        sse.destroy();
        console.log('test_threat_api.js: all threat-API checks passed');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
});
