/**
 * Small UI helpers shared by all modules: HTML escaping, toasts (with optional action
 * buttons), inline SVG icons, DOM builder.
 */
(function () {
    'use strict';

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function el(tag, attrs = {}, ...children) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'html') n.innerHTML = v;
            else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
            else if (k === 'dataset') Object.assign(n.dataset, v);
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c == null || c === false) continue;
            n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
        }
        return n;
    }

    function toastHost() {
        let h = document.getElementById('toast-host');
        if (!h) {
            h = el('div', { id: 'toast-host', class: 'toast-host', role: 'status', 'aria-live': 'polite' });
            document.body.appendChild(h);
        }
        return h;
    }

    /**
     * toast('Saved', {type: 'ok'|'info'|'warn'|'danger', timeout: ms (0 = sticky),
     *                 actions: [{label, primary, onClick}]})  -> {close()}
     */
    function toast(message, opts = {}) {
        const type = opts.type || 'info';
        const t = el('div', { class: `toast toast-${type}` });
        t.appendChild(el('div', { class: 'toast-msg', html: opts.html ? message : escapeHtml(message) }));
        const close = () => {
            t.classList.add('toast-out');
            setTimeout(() => t.remove(), 180);
        };
        if (opts.actions && opts.actions.length) {
            const row = el('div', { class: 'toast-actions' });
            opts.actions.forEach(a => row.appendChild(el('button', {
                class: `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`,
                onclick: () => { close(); a.onClick && a.onClick(); }
            }, a.label)));
            t.appendChild(row);
        }
        t.appendChild(el('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: close }, '×'));
        toastHost().appendChild(t);
        const timeout = opts.timeout ?? (opts.actions ? 0 : (type === 'danger' ? 6000 : 3500));
        if (timeout) setTimeout(close, timeout);
        return { close };
    }

    function confirmToast(message, onYes, opts = {}) {
        return toast(message, {
            type: opts.type || 'warn', timeout: 0,
            actions: [{ label: opts.yes || 'Yes', primary: true, onClick: onYes },
                      { label: opts.no || 'Cancel', onClick: opts.onNo }]
        });
    }

    window.UI = { escapeHtml, el, toast, confirmToast };
    window.escapeHtml = escapeHtml;
})();
