// Static serving for deployment (R2): gzip, ETag/304, allowlist, health check.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanchar-srv-'));
process.env.SITREP_DB = path.join(tmp, 'sitrep_db.json');
process.env.CONVOYS_DB = path.join(tmp, 'convoys.json');
const server = require('../server.js');

function get(port, p, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on('error', reject);
        r.end();
    });
}

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    try {
        // health check without touching big files
        let r = await get(port, '/healthz');
        assert.strictEqual(r.status, 200);
        const h = JSON.parse(r.body);
        assert.strictEqual(h.status, 'ok'); assert.strictEqual(h.name, 'SANCHAR'); assert.ok(h.uptime_s >= 0);

        // big data file gzip-compressed, valid JSON after gunzip, much smaller on the wire
        const raw = fs.statSync(path.join(__dirname, '..', 'routing_graph.json')).size;
        r = await get(port, '/routing_graph.json', { 'Accept-Encoding': 'gzip, deflate' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-encoding'], 'gzip');
        assert.ok(/Accept-Encoding/i.test(r.headers.vary));
        assert.strictEqual(r.headers['cache-control'], 'public, max-age=3600');
        assert.strictEqual(Number(r.headers['x-uncompressed-length']), raw);
        const g = JSON.parse(zlib.gunzipSync(r.body).toString('utf8'));
        assert.ok(Array.isArray(g.nodes) && g.adjacency_list);
        assert.ok(r.body.length < raw / 3, `gzip ${r.body.length} vs ${raw}`);
        const etag = r.headers.etag;
        assert.ok(etag);

        // conditional request -> 304, no body
        r = await get(port, '/routing_graph.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
        assert.strictEqual(r.status, 304);
        assert.strictEqual(r.body.length, 0);

        // without Accept-Encoding: identity
        r = await get(port, '/threat_types.json');
        assert.strictEqual(r.status, 200);
        assert.ok(!r.headers['content-encoding']);
        JSON.parse(r.body);

        // HEAD works (curl -I)
        r = await get(port, '/routing_edges.geojson', { 'Accept-Encoding': 'gzip' }, 'HEAD');
        assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-encoding'], 'gzip'); assert.strictEqual(r.body.length, 0);

        // index: no-cache; app code is served
        r = await get(port, '/', { 'Accept-Encoding': 'gzip' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['cache-control'], 'no-cache');
        assert.ok(zlib.gunzipSync(r.body).toString().includes('SANCHAR'));
        for (const p of ['/app.js', '/js/threats.js', '/favicon.svg', '/data/scenarios/srinagar_ied_then_stone_pelting.json']) {
            assert.strictEqual((await get(port, p)).status, 200, p);
        }

        // never serve server code, config, secrets or databases; traversal blocked
        for (const p of ['/../package.json', '/package.json', '/server.js', '/.env', '/gemini_api.py', '/lib/store.js',
                         '/data/sitrep_db.json', '/pipeline/config.py', '/%2e%2e/package.json', '/js/../server.js']) {
            const s = (await get(port, p)).status;
            assert.ok(s === 403 || s === 404, `${p} -> ${s}`);
        }
        console.log('test_server.js: all static-serving checks passed');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
});
