/**
 * Guide tab + ⓘ tooltips: plain-language meaning of every number in the UI.
 * Tables C (multiplier) and D (λ) are COMPUTED from the same formulas the router uses,
 * so the explanation can never drift from the code.
 */
(function () {
    'use strict';
    const { el, escapeHtml } = UI;

    const mult = (impact) => 1 + 3 * impact / 100;                    // threatWeight multiplier
    const detour = (lam, R = 80) => (lam >= 1 ? Infinity : 1 + lam * (R / 100) / (1 - lam));

    // one short sentence per tooltip key
    const TIPS = {
        risk: 'Segment risk 0–100: relative danger of a road segment predicted by the ML model. 100 = as risky as the top 1% of roads. Not a probability.',
        legend: 'Colours show segment risk bands: green Low, yellow Medium, orange High, red Critical, magenta closed by a live threat.',
        impact: 'Threat impact 10–100: how severely a reported threat affects roads inside its radius. 90+ closes the road (hard block).',
        radius: 'Threat radius: only the part of each road inside this circle is penalised (or closed if impact ≥ 90).',
        multiplier: 'Inside a threat circle a segment counts as ×(1 + 3·impact/100) more dangerous, e.g. ×2.5 at impact 50. This is a risk multiplier, not λ.',
        lambda: 'λ 0–1 is a preference: how much detour you accept to avoid danger. 0 = fastest, 0.6 = balanced, 0.95 = safest.',
        distance: 'Total road distance of the route.',
        eta: 'Drive time at the convoy speed.',
        prob: 'Chance of at least one incident on this trip: P = 1 − Π(1 − pᵢ) over segments (per-traversal probabilities; synthetic data).',
        mean: 'Length-weighted average segment risk along the route (scale 0–100).',
        max: 'Worst segment risk on the route (scale 0–100).',
        high: 'Number of segments with risk ≥ 60 (High or Critical).',
        exposure: 'Minutes the convoy spends on segments with risk ≥ 60 at convoy speed.',
        choke: 'Segments in the top 5% of network betweenness: bridges and single links whose loss cuts the network.',
        zone: 'Segments touching an active threat radius.',
        confidence: 'How sure the location is: high = coordinates / junction / precise landmark or operator pin; medium = offset or OSM gap; low = off-road.',
        hud: 'Live segment risk under the current threat picture (same 0–100 scale; ∞ = closed).',
        speed: 'Simulation clock multiplier: 10× means one real second is ten seconds of convoy movement.',
    };
    const SECTION_OF = { risk: 'risk', legend: 'risk', max: 'risk', mean: 'risk', high: 'risk', hud: 'risk',
                         impact: 'impact', radius: 'impact', confidence: 'impact', multiplier: 'mult', lambda: 'lambda',
                         distance: 'metrics', eta: 'metrics', prob: 'metrics', exposure: 'metrics', choke: 'metrics', zone: 'metrics', speed: 'metrics' };

    const Guide = {
        tip(key) {
            if (!TIPS[key]) return '';
            return `<span class="tip" tabindex="0" role="button" aria-label="What is this?" data-tip="${key}"><svg class="icon"><use href="#i-info"/></svg></span>`;
        },
        link(section, text) {
            return `<a href="#" class="guide-link" data-guide="${section}">${escapeHtml(text)}</a>`;
        },
        open(section) {
            Shell.switchTab('guide');
            const t = document.getElementById(`guide-${section}`);
            if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); }
        },
        lambdaSentence(lam) {
            lam = Number(lam);
            if (lam <= 0) return `λ = 0.00: risk is ignored - the planner takes the fastest road even through high-risk (80) segments.`;
            const d = detour(lam);
            return `λ = ${lam.toFixed(2)}: the planner will drive up to ${d >= 10 ? d.toFixed(0) : d.toFixed(1)} km to avoid 1 km of high-risk (80) road.`;
        },
        render() {
            const root = document.getElementById('guide-root');
            if (!root) return;
            root.innerHTML = '';
            const sec = (id, title, ...kids) => root.appendChild(el('div', { class: 'card guide-sec', id: `guide-${id}` }, el('h3', {}, title), ...kids));
            const table = (head, rows) => el('table', { class: 'guide-table' },
                el('thead', {}, el('tr', {}, head.map(h => el('th', {}, h)))),
                el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => (c instanceof Node ? el('td', {}, c) : el('td', { html: String(c) })))))));
            const sw = (cls) => el('i', { class: `sw ${cls}` });

            sec('risk', 'A. Segment risk (ML weight), scale 0–100',
                el('p', {}, 'The relative danger of one road segment, predicted by the XGBoost model from synthetic incident history and road features. It is ',
                    el('b', {}, 'relative, not a probability'), ': 100 = as risky as the top 1% of roads in the area (weight = 100 × risk ÷ 99th-percentile risk).'),
                table(['Band', 'Range', '', 'Operational meaning'], [
                    ['Low', '0–30', sw('sw-low'), 'Normal movement'],
                    ['Medium', '30–60', sw('sw-med'), 'Heightened alertness; standard drills'],
                    ['High', '60–80', sw('sw-high'), 'Avoid if an alternative exists; if used, road-opening party / escort recommended'],
                    ['Critical', '80–100', sw('sw-crit'), 'Avoid; route only with explicit clearance'],
                    ['Closed', 'live threat ≥ 90', sw('sw-closed'), 'Not routable (hard block)'],
                ]));

            sec('impact', 'B. Threat impact, scale 10–100 (for a live threat you add)',
                el('p', {}, 'How severely a reported threat affects roads inside its radius. Only the part of a road inside the circle is affected; a closure (90+) shuts the whole junction-to-junction link because a convoy must drive it end to end.'),
                table(['Impact', 'Meaning', 'Routing effect'], [
                    ['10–39', 'Minor (e.g. small accident)', 'Small penalty'],
                    ['40–69', 'Significant (e.g. stone pelting, blockade)', 'Strong penalty; Balanced / Safest usually avoid'],
                    ['70–89', 'Severe (e.g. ambush risk)', 'Very strong penalty; Safest almost always avoids'],
                    ['90–100', 'Road closed (IED, landslide)', '<b class="risk-closed">Hard block: no route will use it</b>'],
                ]),
                el('p', { class: 'muted' }, 'Default radius by type: ' + Object.values(Threats.types || {}).map(t => `${t.label} ${t.radius_m} m`).join(' · ') +
                    '. Location confidence: high = coordinates, junction, precise landmark or operator pin; medium = offset along a road or an OSM naming gap; low = placed off-road.'));

            const mrows = [17, 30, 50, 80].map(i => {
                const m = mult(i);
                const base = Math.max(20, i);
                return [String(i), `×${m.toFixed(1)}`, `max(20, ${i}) × ${m.toFixed(2)} = <b>${(base * m).toFixed(0)}</b>`];
            });
            mrows.push(['≥ 90', 'closed', '∞ (not routable)']);
            sec('mult', 'C. Threat multiplier (×1.5, ×2.5 …)',
                el('p', {}, 'Inside a threat radius a segment\'s risk becomes ', el('code', {}, 'max(segment risk, impact) × (1 + 3 × impact / 100)'),
                    '. The multiplier is "how many times more dangerous this segment now counts". If only part of the segment is inside the circle, it applies only to that fraction.'),
                table(['Impact', 'Multiplier', 'Example: segment risk 20 becomes'], mrows),
                el('p', { class: 'callout' }, el('b', {}, '×1.5 is a multiplier on risk'), ' (the segment counts as 1.5 times as dangerous). It is a different quantity from ',
                    el('b', {}, 'λ = 0.6'), ', which is your route preference (section D).'));

            const lrows = [[0, 'Fastest: ignore risk'], [0.2, 'Speed-first'], [0.35, 'Mild caution'], [0.6, 'Balanced'], [0.8, 'Cautious'], [0.95, 'Safest']]
                .map(([l, p]) => [l.toFixed(2).replace(/0$/, '').replace(/\.0$/, '.0'), p, `${detour(l) >= 10 ? detour(l).toFixed(0) : detour(l).toFixed(1)} km${l === 0 ? ' (no detour)' : ''}`]);
            sec('lambda', 'D. λ (risk weight), scale 0–1: "how much detour will you accept to avoid danger?"',
                el('p', {}, 'Cost per metre = ', el('code', {}, '(1 − λ) + λ × risk / 100'),
                    '. In plain words: to avoid 1 km of road with risk R (instead of a risk-0 road) the planner accepts a detour of up to ',
                    el('code', {}, '1 + λ·(R/100) / (1 − λ)'), ' km.'),
                table(['λ', 'Profile', 'Detour accepted to avoid 1 km of risk-80 road'], lrows),
                el('p', { class: 'muted' }, 'Presets: Fastest (λ 0) · Balanced (λ 0.6) · Safest (λ 0.95). The Balanced slider in the Plan tab changes only the Balanced route.'));

            sec('metrics', 'E. Route metrics in the comparison table',
                table(['Metric', 'Meaning'], [
                    ['Incident prob.', TIPS.prob],
                    ['Mean / max seg. risk', 'Average (length-weighted) and worst segment risk along the route (scale A).'],
                    ['High-risk segs', TIPS.high],
                    ['Exposure ≥ 60', TIPS.exposure],
                    ['Chokepoints', TIPS.choke],
                    ['Threat-zone segs', TIPS.zone],
                    ['ETA', TIPS.eta],
                ]),
                el('p', { class: 'muted' }, 'All incident and threat data is SYNTHETIC - for demonstration only.'));
        },
    };
    window.Guide = Guide;

    // ------------------------------------------------------------------ tooltip popover
    let pop = null, hideT = null;
    function show(target) {
        const key = target.dataset.tip;
        if (!TIPS[key]) return;
        clearTimeout(hideT);
        if (!pop) {
            pop = el('div', { class: 'tip-pop', role: 'tooltip' });
            pop.addEventListener('mouseenter', () => clearTimeout(hideT));
            pop.addEventListener('mouseleave', hide);
            document.body.appendChild(pop);
        }
        pop.innerHTML = `${escapeHtml(TIPS[key])} ${Guide.link(SECTION_OF[key] || 'risk', 'More in Guide')}`;
        const r = target.getBoundingClientRect();
        pop.style.left = `${Math.min(window.innerWidth - 290, Math.max(8, r.left - 10))}px`;
        pop.style.top = `${r.bottom + 6}px`;
        pop.classList.add('is-on');
    }
    function hide() { hideT = setTimeout(() => pop && pop.classList.remove('is-on'), 180); }

    document.addEventListener('mouseover', (e) => { const t = e.target.closest('.tip'); if (t) show(t); });
    document.addEventListener('mouseout', (e) => { if (e.target.closest('.tip')) hide(); });
    document.addEventListener('focusin', (e) => { const t = e.target.closest('.tip'); if (t) show(t); });
    document.addEventListener('focusout', (e) => { if (e.target.closest('.tip')) hide(); });
    document.addEventListener('click', (e) => {
        const a = e.target.closest('.guide-link');
        if (a) { e.preventDefault(); map && map.closePopup(); Guide.open(a.dataset.guide); if (pop) pop.classList.remove('is-on'); }
        const t = e.target.closest('.tip');
        if (t) { e.preventDefault(); e.stopPropagation(); show(t); }
    });

    // fill static placeholders <span data-tip-key="..."></span> in index.html
    function fillPlaceholders(root = document) {
        root.querySelectorAll('[data-tip-key]').forEach(n => { n.outerHTML = Guide.tip(n.dataset.tipKey); });
    }
    Guide.fillPlaceholders = fillPlaceholders;
    document.addEventListener('DOMContentLoaded', () => fillPlaceholders());
    document.addEventListener('graphready', () => Guide.render());
})();
