// Runs every tests/test_*.js file (npm test). Exits non-zero if any fails.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = fs.readdirSync(__dirname).filter(f => /^test_.*\.js$/.test(f)).sort();
let failed = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.error(`FAILED: ${f}`); }
}
console.log(`${files.length - failed}/${files.length} JS test files passed`);
process.exit(failed ? 1 : 0);
