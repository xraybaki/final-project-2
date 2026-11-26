/**
 * Log tab (M11): the SITREP database as a sortable, filterable table.
 * Rows: time, DTG, type, location, radius, impact, source, status + Locate / Edit / Clear.
 * Expanding a row shows its standard SITREP line, the original text and the full history.
 * Also lists live events (reroutes etc., M13) from /api/events.
 */
(function () {
    'use strict';
    const { el, toast, escapeHtml } = UI;
    const Log = { records: [], events: [], sort: { key: 'created_at', dir: -1 }, filter: { q: '', status: '', source: '', type: '' }, open: new Set() };
    window.Log = Log;

    const COLS = [
        { key: 'created_at', label: 'Time' },
        { key: 'dtg', label: 'DTG' },
        { key: 'type', label: 'Type' },
        { key: 'location_label', label: 'Location' },
        { key: 'radius_m', label: 'Radius' },
        { key: 'impact', label: 'Impact' },
        { key: 'source', label: 'Source' },
        { key: 'status', label: 'Status' },
    ];

    Log.refresh = async function () {
        try {
            const [t, e] = await Promise.all([fetch('/api/threats').then(r => r.json()), fetch('/api/events').then(r => r.json())]);
            Log.records = t.records || [];
            Log.events = e.events || [];
        } catch (err) {
            toast('Could not load the SITREP log', { type: 'danger' });
        }
        Log.render();
    };

    function filtered() {
        const f = Log.filter;
        const q = f.q.toLowerCase();
        let rows = Log.records.filter(r =>
            (!f.status || r.status === f.status) && (!f.source || r.source === f.source) && (!f.type || r.type === f.type) &&
            (!q || [r.id, r.location_label, r.sitrep_text, r.sitrep_line, r.reported_by, r.type].join(' ').toLowerCase().includes(q)));
        const { key, dir } = Log.sort;
        rows.sort((a, b) => {
            const va = a[key], vb = b[key];
            return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir;
        });
        return rows;
    }

    function select(id, label, opts, value) {
        const s = el('select', { class: 'input input-sm', id, 'aria-label': label });
        s.appendChild(el('option', { value: '' }, `All ${label}`));
        opts.forEach(o => s.appendChild(el('option', { value: o, selected: o === value }, o.replace('_', ' '))));
        s.addEventListener('change', () => { Log.filter[id.replace('log-', '')] = s.value; Log.renderTable(); });
        return s;
    }

    Log.render = function () {
        const root = document.getElementById('log-root');
        if (!root) return;
        root.innerHTML = '';
        const types = Threats.types ? Object.keys(Threats.types) : [];
        const search = el('input', { class: 'input input-sm grow', placeholder: 'Search id, location, SITREP text…', value: Log.filter.q, 'aria-label': 'Search' });
        search.addEventListener('input', () => { Log.filter.q = search.value; Log.renderTable(); });
        const counts = ['active', 'pending', 'cleared', 'expired'].map(s => `${Log.records.filter(r => r.status === s).length} ${s}`).join(' · ');
        root.appendChild(el('div', { class: 'card' },
            el('div', { class: 'row-between' }, el('span', { class: 'muted' }, `${Log.records.length} records · ${counts}`),
                el('a', { class: 'btn btn-secondary btn-sm', href: '/api/threats/export.csv', download: 'sitrep_log.csv',
                          html: '<svg class="icon"><use href="#i-download"/></svg><span>Export CSV</span>' })),
            el('div', { class: 'log-filters' }, search,
                select('log-status', 'statuses', ['active', 'pending', 'cleared', 'expired'], Log.filter.status),
                select('log-source', 'sources', ['manual_map', 'sitrep_text', 'intel_feed'], Log.filter.source),
                select('log-type', 'types', types, Log.filter.type))));
        root.appendChild(el('div', { class: 'card log-card' }, el('div', { id: 'log-table-wrap', class: 'log-table-wrap' })));
        root.appendChild(el('div', { class: 'card' }, el('div', { class: 'card-title' }, 'Live events (reroutes, arrivals)'), el('div', { id: 'event-list', class: 'event-list' })));
        Log.renderTable();
        Log.renderEvents();
    };

    Log.renderTable = function () {
        const wrap = document.getElementById('log-table-wrap');
        if (!wrap) return;
        const rows = filtered();
        const table = el('table', { class: 'log-table' });
        const head = el('tr', {});
        COLS.forEach(c => {
            const arrow = Log.sort.key === c.key ? (Log.sort.dir > 0 ? ' ▲' : ' ▼') : '';
            head.appendChild(el('th', { class: 'sortable', onclick: () => {
                Log.sort = { key: c.key, dir: Log.sort.key === c.key ? -Log.sort.dir : (c.key === 'created_at' ? -1 : 1) };
                Log.renderTable();
            } }, c.label + arrow));
        });
        head.appendChild(el('th', {}, ''));
        table.appendChild(el('thead', {}, head));
        const body = el('tbody', {});
        if (!rows.length) body.appendChild(el('tr', {}, el('td', { colspan: COLS.length + 1, class: 'muted center' }, 'No records match.')));
        rows.forEach(r => {
            const info = Threats.typeInfo(r.type);
            const isOpen = Log.open.has(r.id);
            const tr = el('tr', { class: `log-row status-${r.status} ${isOpen ? 'is-open' : ''}`, onclick: (e) => {
                if (e.target.closest('button')) return;
                if (isOpen) Log.open.delete(r.id); else Log.open.add(r.id);
                Log.renderTable();
            } },
                el('td', { class: 'nowrap' }, new Date(r.created_at).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })),
                el('td', { class: 'mono nowrap' }, r.dtg),
                el('td', { class: 'nowrap' }, `${info.emoji} ${info.label}`),
                el('td', { class: 'log-loc', title: r.location_label }, r.location_label || '-'),
                el('td', { class: 'num-cell' }, `${r.radius_m} m`),
                el('td', { class: `num-cell ${r.impact >= Threats.hardBlock ? 'is-closed' : ''}` }, r.impact),
                el('td', { class: 'nowrap' }, r.source.replace('_', ' ')),
                el('td', {}, el('span', { class: `badge st-${r.status}` }, r.status)),
                el('td', { class: 'nowrap' },
                    el('button', { class: 'btn btn-ghost btn-icon', title: 'Locate', 'aria-label': 'Locate', onclick: () => locate(r),
                                   html: '<svg class="icon"><use href="#i-locate"/></svg>' }),
                    r.status === 'active' ? el('button', { class: 'btn btn-ghost btn-icon', title: 'Edit', 'aria-label': 'Edit',
                                   onclick: () => { locate(r); }, html: '<svg class="icon"><use href="#i-pin"/></svg>' }) : null,
                    r.status === 'active' || r.status === 'pending' ? el('button', { class: 'btn btn-ghost btn-icon', title: 'Clear', 'aria-label': 'Clear',
                                   onclick: () => Threats.remove(r.id), html: '<svg class="icon"><use href="#i-trash"/></svg>' }) : null));
            body.appendChild(tr);
            if (isOpen) {
                const hist = el('ol', { class: 'hist' });
                (r.history || []).slice().reverse().forEach(h => hist.appendChild(el('li', {},
                    el('span', { class: 'mono' }, new Date(h.at).toLocaleString()), ` · ${h.action} · ${h.by || ''}`,
                    h.changes ? el('span', { class: 'muted' }, ' · ' + Object.entries(h.changes).map(([k, v]) =>
                        `${k}: ${fmt(v.from)} → ${fmt(v.to)}`).join(', ')) : null)));
                body.appendChild(el('tr', { class: 'log-detail' }, el('td', { colspan: COLS.length + 1 },
                    el('div', { class: 'mono sitrep-line' }, r.sitrep_line),
                    r.source !== 'manual_map' && r.sitrep_text && r.sitrep_text !== r.sitrep_line
                        ? el('div', { class: 'orig-text' }, `Original: “${r.sitrep_text}”`) : null,
                    el('div', { class: 'muted' }, `${r.id} · ${r.resolution} / ${r.confidence} · reported by ${r.reported_by}` +
                        (r.expires_at ? ` · expires ${new Date(r.expires_at).toLocaleString()}` : ' · until cleared')),
                    hist)));
            }
        });
        table.appendChild(body);
        wrap.innerHTML = '';
        wrap.appendChild(table);
    };

    function fmt(v) {
        if (typeof v === 'number') return Math.abs(v) < 1000 && !Number.isInteger(v) ? v.toFixed(5) : String(v);
        return v == null ? '–' : String(v);
    }

    function locate(r) {
        if (r.status === 'active' && Threats.get(r.id)) Threats.locate(r.id);
        else {
            map.setView([r.lat, r.lon], 16);
            L.popup().setLatLng([r.lat, r.lon]).setContent(`<b>${escapeHtml(r.id)}</b><br>${escapeHtml(r.status)} · ${escapeHtml(r.location_label)}`).openOn(map);
        }
    }

    Log.renderEvents = function () {
        const host = document.getElementById('event-list');
        if (!host) return;
        host.innerHTML = '';
        const evs = Log.events.slice(-60).reverse();
        if (!evs.length) { host.appendChild(el('p', { class: 'muted' }, 'No live events yet.')); return; }
        evs.forEach(e => host.appendChild(el('div', { class: `event-row ev-${e.kind}` },
            el('span', { class: 'mono' }, e.dtg), el('b', {}, e.kind), el('span', {}, `${e.convoy && !String(e.text).startsWith(e.convoy) ? e.convoy + ': ' : ''}${e.text}`))));
    };

    // keep the table live
    let pending = null;
    const soon = () => { clearTimeout(pending); pending = setTimeout(() => { if (Shell.current === 'log') Log.refresh(); }, 250); };
    document.addEventListener('DOMContentLoaded', () => {
        Threats.on((ev) => { if (ev.startsWith('threat_') || ev === 'event_logged' || ev === 'intel_loaded') soon(); });
        document.addEventListener('tabchange', (e) => {
            document.getElementById('sidebar').dataset.tab = e.detail;
            if (e.detail === 'log') Log.refresh();
        });
        const rb = document.getElementById('reported-by');
        if (rb) {
            try { rb.value = localStorage.getItem('reportedBy') || rb.value; } catch (e) { /* storage blocked */ }
            rb.addEventListener('change', () => { try { localStorage.setItem('reportedBy', rb.value); } catch (e) { /* ignore */ } });
        }
    });
})();
