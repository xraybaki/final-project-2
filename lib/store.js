// Tiny JSON-file store: in-memory copy + atomic writes (tmp file + rename). Node built-ins only.
const fs = require('fs');
const path = require('path');

class JsonStore {
    /**
     * @param {string} file     path of the JSON file, shaped {version, records: [...]}
     * @param {function} seed   optional () => records[] used when the file does not exist
     */
    constructor(file, seed) {
        this.file = file;
        this.data = { version: 1, records: [] };
        if (fs.existsSync(file)) {
            try {
                this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!Array.isArray(this.data.records)) this.data.records = [];
            } catch (e) {
                const bad = `${file}.corrupt-${Date.now()}`;
                fs.renameSync(file, bad);   // keep the evidence, start clean
                console.error(`[store] ${file} was not valid JSON - moved to ${bad}`);
            }
        } else if (seed) {
            this.data.records = seed() || [];
            this.save();
        }
    }

    get records() { return this.data.records; }
    find(id) { return this.data.records.find(r => r.id === id); }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
        fs.renameSync(tmp, this.file);
    }

    insert(rec) { this.data.records.push(rec); this.save(); return rec; }

    update(id, fn) {
        const r = this.find(id);
        if (!r) return null;
        fn(r);
        this.save();
        return r;
    }

    remove(id) {
        const i = this.data.records.findIndex(r => r.id === id);
        if (i < 0) return null;
        const [r] = this.data.records.splice(i, 1);
        this.save();
        return r;
    }
}

module.exports = { JsonStore };
