// Simple Node.js server: static files + convoy threat endpoints
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// Windows usually has `python`, Linux/macOS `python3`; override with PYTHON=...
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.geojson': 'application/json',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
};

function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// Run a python script with JSON on stdin; falls back from python3 -> python if not found
function runPython(script, input, cb, exe = PYTHON) {
    const py = spawn(exe, [path.join(ROOT, script)], { cwd: ROOT });
    let out = '', err = '';
    let done = false;
    const timer = setTimeout(() => { if (!done) { py.kill(); } }, 30000);
    py.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (e.code === 'ENOENT' && exe !== 'python') return runPython(script, input, cb, 'python');
        cb(e);
    });
    py.stdout.on('data', d => out += d.toString());
    py.stderr.on('data', d => err += d.toString());
    py.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) console.error(`[${script}]`, err.trim().slice(0, 500));
        if (code !== 0) return cb(new Error(`exit ${code}`));
        cb(null, out);
    });
    py.stdin.write(input);
    py.stdin.end();
}

function readBody(req, cb) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    console.log(`${req.method} ${url}`);

    // Live threat reports (SYNTHETIC) - served instantly from data/live_threats.json
    if ((url === '/fetch-live-threats' || url === '/fetch-live-crimes') && req.method === 'GET') {
        fs.readFile(path.join(ROOT, 'data', 'live_threats.json'), 'utf8', (error, content) => {
            if (error) {
                return sendJSON(res, 200, { success: false, events: [],
                    error: 'data/live_threats.json not found - run: python -m pipeline.run_all' });
            }
            const data = JSON.parse(content);
            data.timestamp = new Date().toISOString();
            sendJSON(res, 200, data);
        });
        return;
    }

    // SITREP -> structured threat (Gemini if GEMINI_API_KEY, otherwise rule-based fallback)
    if (url === '/parse-sitrep' && req.method === 'POST') {
        readBody(req, (body) => {
            runPython('gemini_api.py', body, (err, out) => {
                if (err) return sendJSON(res, 500, { error: `SITREP parser failed (${err.message})` });
                try {
                    const parsed = JSON.parse(out.trim().split('\n').pop());
                    sendJSON(res, parsed.error ? 422 : 200, parsed);
                } catch (e) {
                    sendJSON(res, 500, { error: 'SITREP parser returned invalid JSON' });
                }
            });
        });
        return;
    }

    // Legacy Toronto chat assistant (needs google-genai, bs4, GEMINI_API_KEY)
    if (url === '/chat' && req.method === 'POST') {
        readBody(req, (body) => {
            runPython(path.join('legacy_toronto', 'gemini_api.py'), body, (err, out) => {
                if (err) return sendJSON(res, 500, { error: 'Python script error' });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(out);
            });
        });
        return;
    }

    // Static files (no directory traversal outside ROOT)
    let filePath = path.normalize(path.join(ROOT, decodeURIComponent(url === '/' ? '/index.html' : url)));
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT' || error.code === 'EISDIR') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`, 'utf-8');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🚀 Server running at http://localhost:${PORT}/`);
        console.log(`🛡️  AI-Based Safest Route Planner for Mobile Convoys`);
        console.log(`Press Ctrl+C to stop the server`);
    });
}

module.exports = server;
