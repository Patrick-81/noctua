// ═══════════════════════════════════════════════════════════════
// Noctua — visibility.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── 24h visibility popup (altitude curve + catalog info) ─────

function _visOpen() {
    const ov = document.getElementById('vis-overlay');
    if (ov) ov.style.display = 'flex';
}

function visClose() {
    const ov = document.getElementById('vis-overlay');
    if (ov) ov.style.display = 'none';
}

function _visFmtTime(epoch) {
    if (epoch == null) return '—';
    return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function _visFmtSize(size) {
    if (!size || !size.length) return '—';
    return size.map(v => `${v}'`).join('×');
}

// Show the visibility popup for a selected target.
async function showVisibility(obj) {
    if (!obj || obj.ra == null || obj.dec == null) return;
    const overlay = document.getElementById('vis-overlay');
    const nameEl = document.getElementById('vis-obj-name');
    if (!overlay || !nameEl) return;
    nameEl.textContent = obj.id || obj.name || '';
    try {
        const q = new URLSearchParams({
            ra: String(obj.ra), dec: String(obj.dec),
        });
        if (obj.id) q.set('id', obj.id);
        const data = await fetch('/api/visibility?' + q.toString()).then(r => r.json());
        if (!data.ok) { nameEl.textContent += ' (erreur)'; return; }
        _visRenderObject(data.object);
        _visRenderChart(data.visibility);
        _visRenderTimes(data.visibility);
    } catch (e) {
        nameEl.textContent += ' (erreur)';
    }
    overlay.style.display = 'flex';
}

function _visRenderObject(o) {
    const el = document.getElementById('vis-object');
    if (!el) return;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('vis-mag', o.mag != null ? o.mag.toFixed(2) + ' mag' : '—');
    set('vis-sb', o.surface_brightness != null
        ? o.surface_brightness.toFixed(2) + ' mag/″²' : '—');
    set('vis-size', _visFmtSize(o.size_arcmin));
    const bits = [];
    if (o.catalog) bits.push(o.catalog);
    if (o.type) bits.push(String(o.type).replace(/_/g, ' '));
    if (o.constellation) bits.push('Const. ' + o.constellation);
    const first = o.names && o.names.length ? o.names[0] : (o.id || '');
    el.innerHTML = `<div style="font-size:0.7rem; color:#ccc;">${escapeHTML(first)}</div>` +
        `<div style="font-size:0.6rem; color:#888;">${escapeHTML(bits.join(' · '))}</div>` +
        `<div style="font-size:0.6rem; color:#888;">RA ${(o.ra_deg / 15).toFixed(3)}h · DEC ${o.dec_deg.toFixed(2)}°</div>`;
}

function _visRenderChart(vis) {
    const svg = document.getElementById('vis-chart');
    if (!svg || !vis || !vis.curve) return;
    const W = 560, H = 200, padL = 30, padR = 10, padT = 10, padB = 20;
    const iw = W - padL - padR, ih = H - padT - padB;
    const yMin = -20, yMax = 90;
    const x = (t) => padL + (t / 24.0) * iw;
    const y = (a) => padT + ((yMax - a) / (yMax - yMin)) * ih;

    let out = '';
    // horizon filling
    const hzY = y(0);
    out += `<rect x="${padL}" y="${hzY}" width="${iw}" height="${padT + ih - hzY}" fill="rgba(60,60,80,0.18)"></rect>`;
    // min_alt line
    const maY = y(vis.min_alt_deg);
    out += `<line x1="${padL}" y1="${maY}" x2="${padL + iw}" y2="${maY}" stroke="rgba(255,180,60,0.6)" stroke-width="1" stroke-dasharray="4 3"></line>`;
    out += `<text x="${padL}" y="${maY - 3}" font-size="9" fill="rgba(255,180,60,0.8)">min alt ${vis.min_alt_deg}°</text>`;
    // horizon line
    out += `<line x1="${padL}" y1="${hzY}" x2="${padL + iw}" y2="${hzY}" stroke="rgba(255,255,255,0.4)" stroke-width="1"></line>`;

    // grid (hours)
    for (let h = 0; h <= 24; h += 4) {
        const gx = x(h);
        out += `<line x1="${gx}" y1="${padT}" x2="${gx}" y2="${padT + ih}" stroke="rgba(255,255,255,0.08)"></line>`;
        out += `<text x="${gx}" y="${H - 6}" font-size="9" fill="#888" text-anchor="middle">${String(h).padStart(2, '0')}h</text>`;
    }
    // y grid
    for (let a = yMin; a <= yMax; a += 30) {
        const gy = y(a);
        out += `<text x="${padL - 4}" y="${gy + 3}" font-size="9" fill="#888" text-anchor="end">${a}°</text>`;
    }

    // curve
    const pts = vis.curve.map((p, i) => {
        const tx = x((i / vis.steps) * 24);
        return `${tx.toFixed(1)},${y(p.alt_deg).toFixed(1)}`;
    }).join(' ');
    if (pts) {
        out += `<polyline points="${pts}" fill="none" stroke="#4cc9f0" stroke-width="2"></polyline>`;
        out += `<polygon points="${x(0)},${y(0)} ${pts} ${x(24)},${y(0)}" fill="rgba(76,201,240,0.12)"></polygon>`;
    }

    // markers: rise / transit / set (times within 24h window → x offset from start)
    const start = vis.start_epoch;
    const marker = (epoch, color, label, dy) => {
        if (epoch == null) return '';
        const t = (epoch - start) / 3600.0;
        if (t < 0 || t > 24) return '';
        const mx = x(t);
        return `<line x1="${mx}" y1="${padT}" x2="${mx}" y2="${padT + ih}" stroke="${color}" stroke-width="1" stroke-dasharray="2 2"></line>` +
            `<text x="${mx}" y="${padT + (dy || 8)}" font-size="9" fill="${color}" text-anchor="middle">${label}</text>`;
    };
    out += marker(vis.rise_epoch, '#7cf29c', 'Lev.', 10);
    out += marker(vis.transit_epoch, '#f2c97c', 'Transit', 22);
    out += marker(vis.set_epoch, '#f28c8c', 'Cou.', 34);

    svg.innerHTML = out;
}

function _visRenderTimes(vis) {
    const el = document.getElementById('vis-times');
    if (!el) return;
    const rise = vis.rise_epoch != null ? _visFmtTime(vis.rise_epoch) : 'circumpolaire/incassable';
    const trans = _visFmtTime(vis.transit_epoch);
    const set = vis.set_epoch != null ? _visFmtTime(vis.set_epoch) : 'circumpolaire/incassable';
    el.innerHTML = `<div class="vis-time"><span class="vis-metric-label">Lever</span><span>${rise}</span></div>` +
        `<div class="vis-time"><span class="vis-metric-label">Transit</span><span>${trans}</span></div>` +
        `<div class="vis-time"><span class="vis-metric-label">Coucher</span><span>${set}</span></div>`;

    const win = document.getElementById('vis-window');
    if (win) {
        if (vis.best_observable) {
            const b = vis.best_observable;
            win.innerHTML = `<span class="vis-metric-label">Mieux observable</span>` +
                `<span>${_visFmtTime(b.start_epoch)} – ${_visFmtTime(b.end_epoch)} · max ${b.max_alt_deg.toFixed(1)}°</span>`;
        } else {
            win.innerHTML = `<span class="vis-metric-label">Observable</span><span>Sous l'horizon (${vis.min_alt_deg}°) sur 24h</span>`;
        }
    }
}

function initVisibilityPanel() {
    document.getElementById('vis-close')?.addEventListener('click', visClose);
    document.getElementById('vis-cancel')?.addEventListener('click', visClose);
    const ov = document.getElementById('vis-overlay');
    if (ov) ov.addEventListener('mousedown', (e) => { if (e.target === ov) visClose(); });
    document.getElementById('vis-goto')?.addEventListener('click', () => {
        visClose();
        if (typeof mountGoto === 'function') mountGoto();
    });
}
