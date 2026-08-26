// ═══════════════════════════════════════════════════════════════
// Noctua — dashboard.js (tableau de bord synthétique)
// Vue mini du guidage et de la séquence dans #applet-status.
// Dépendances : hub.js, guide.js (globals), capture.js,
//               sequence.js (_seqStatus), preview.js (_guideCap).
// ═══════════════════════════════════════════════════════════════

let _dashView = 'drift';   // 'drift' | 'medallion' | 'camera'
let _dashCanvas = null;
let _dashSeqStart = null;  // timestamp ms quand la séquence a démarré
let _dashFrameDuration = 60;
let _dashUpdateTimer = null;

// ── Init ─────────────────────────────────────────────────────

function initDashboard() {
    _dashCanvas = document.getElementById('dash-canvas');

    document.querySelectorAll('.dash-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelector('.dash-toggle-btn.active')?.classList.remove('active');
            btn.classList.add('active');
            _dashView = btn.dataset.dash;
            _dashDraw();
        });
    });

    Hub.subscribe('sequence:update', 'dashboard', (env) => {
        const st = env.payload;
        if (st.running && !_dashSeqStart) {
            _dashSeqStart = Date.now();
            _dashFrameDuration = st.current?.duration || 60;
        }
        if (!st.running) _dashSeqStart = null;
        _dashUpdateStats(st);
    });

    Hub.subscribe('capture:progress', 'dashboard', (env) => {
        const p = env.payload;
        if (p.running && !_dashSeqStart) {
            _dashSeqStart = Date.now();
        }
        if (!p.running && !p.done) _dashSeqStart = null;
    });

    _dashUpdateTimer = setInterval(_dashTick, 1000);
    _dashDraw();
}

// ── Timer tick (countdown + redraw) ──────────────────────────

function _dashTick() {
    _dashUpdateStats(null);
    _dashDraw();
}

// ── Stats update ─────────────────────────────────────────────

function _dashUpdateStats(seqSt) {
    const st = seqSt || (typeof _seqStatus !== 'undefined' ? _seqStatus : null);

    // Frames
    const framesEl = document.getElementById('dash-frames');
    if (framesEl) {
        if (st && (st.running || st.done > 0)) {
            framesEl.textContent = `${st.done} / ${st.total}`;
        } else {
            framesEl.textContent = '— / —';
        }
    }

    // Countdown
    const countdownEl = document.getElementById('dash-countdown');
    if (countdownEl) {
        if (st && st.running && _dashSeqStart) {
            const elapsed = (Date.now() - _dashSeqStart) / 1000;
            const remaining = Math.max(0, (st.total - st.done) * _dashFrameDuration - elapsed);
            countdownEl.textContent = _fmtDuration(remaining);
            countdownEl.style.color = remaining < 60 ? '#ff5577' : '#00ffcc';
        } else if (st && st.done > 0 && !st.running) {
            countdownEl.textContent = '✓';
            countdownEl.style.color = '#88ff88';
        } else {
            countdownEl.textContent = '—';
            countdownEl.style.color = '#00ffcc';
        }
    }

    // Filter (from capture or sequence current frame)
    const filterEl = document.getElementById('dash-filter');
    if (filterEl) {
        let filter = '';
        if (st?.current?.filter) filter = st.current.filter;
        else if (typeof _captureFilter !== 'undefined') filter = _captureFilter;
        filterEl.textContent = filter || '—';
        filterEl.style.color = filter ? '#ffcc00' : '#666';
    }

    // RMS (from guide drift history)
    const rmsRA = document.getElementById('dash-rms-ra');
    const rmsDEC = document.getElementById('dash-rms-dec');
    const rmsTOT = document.getElementById('dash-rms-total');
    if (rmsRA && rmsDEC && rmsTOT) {
        const win = _dashRmsWindow();
        const n = win.length;
        if (n > 0) {
            const raSq = win.reduce((a, d) => a + (d.drift_arcsec_x ?? 0) ** 2, 0);
            const decSq = win.reduce((a, d) => a + (d.drift_arcsec_y ?? 0) ** 2, 0);
            const fmt = v => v.toFixed(2) + '″';
            rmsRA.textContent = fmt(Math.sqrt(raSq / n));
            rmsDEC.textContent = fmt(Math.sqrt(decSq / n));
            rmsTOT.textContent = fmt(Math.sqrt((raSq + decSq) / n));
            rmsRA.style.color = rmsDEC.style.color = rmsTOT.style.color = '#ffcc00';
        } else {
            rmsRA.textContent = rmsDEC.textContent = rmsTOT.textContent = '—';
            rmsRA.style.color = rmsDEC.style.color = rmsTOT.style.color = '#666';
        }
    }
}

function _dashRmsWindow() {
    if (typeof _guideDriftHistory === 'undefined' || !_guideDriftHistory.length) return [];
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const frames = Math.max(2, Math.ceil(60 / exposure));
    return _guideDriftHistory.slice(-frames);
}

// ── Canvas drawing ───────────────────────────────────────────

function _dashDraw() {
    if (!_dashCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = _dashCanvas.clientWidth || 480;
    const ch = _dashCanvas.clientHeight || 160;
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (_dashCanvas.width !== bw || _dashCanvas.height !== bh) {
        _dashCanvas.width = bw;
        _dashCanvas.height = bh;
    }
    const ctx = _dashCanvas.getContext('2d');
    ctx.clearRect(0, 0, bw, bh);

    if (_dashView === 'drift') _dashDrawDrift(ctx, bw, bh, dpr);
    else if (_dashView === 'medallion') _dashDrawMedallion(ctx, bw, bh, dpr);
    else if (_dashView === 'camera') _dashDrawCamera(ctx, bw, bh, dpr);
}

// ── Drift mini-graph ─────────────────────────────────────────

function _dashDrawDrift(ctx, bw, bh, dpr) {
    const hist = (typeof _guideDriftHistory !== 'undefined') ? _guideDriftHistory : [];
    if (!hist.length) {
        ctx.fillStyle = '#555';
        ctx.font = `${15 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(i18n('dash.no_guide'), bw / 2, bh / 2);
        return;
    }

    const pad = 40 * dpr, padBottom = 18 * dpr;
    const midY = (bh - padBottom) / 2;
    const tolInput = document.getElementById('guide-tolerance');
    let yMax = Math.max(5, parseFloat(tolInput?.value || '5'));
    for (const d of hist) {
        const ra = Math.abs(d.drift_arcsec_x || 0);
        const dec = Math.abs(d.drift_arcsec_y || 0);
        if (ra > yMax * 0.9) yMax = ra * 1.2;
        if (dec > yMax * 0.9) yMax = dec * 1.2;
    }

    // Tolerance zone
    const tol = parseFloat(tolInput?.value || '0');
    if (tol > 0) {
        const ty1 = midY - (tol / yMax) * (midY - pad);
        const ty2 = midY + (tol / yMax) * (midY - pad);
        ctx.fillStyle = 'rgba(255, 68, 68, 0.06)';
        ctx.fillRect(pad, ty1, bw - pad - 10 * dpr, ty2 - ty1);
    }

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(pad, midY);
    ctx.lineTo(bw - 10 * dpr, midY);
    ctx.stroke();

    const xStep = (bw - pad - 10 * dpr) / Math.max(1, hist.length - 1);

    function drawMini(getVal, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < hist.length; i++) {
            const x = pad + i * xStep;
            const y = midY - (getVal(hist[i]) / yMax) * (midY - pad);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Last dot + value
        const last = hist[hist.length - 1];
        if (last) {
            const lx = pad + (hist.length - 1) * xStep;
            const ly = midY - (getVal(last) / yMax) * (midY - pad);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(lx, ly, 4 * dpr, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = `bold ${12 * dpr}px monospace`;
            ctx.textAlign = 'left';
            ctx.fillText(`${getVal(last).toFixed(1)}″`, lx + 5 * dpr, ly - 5 * dpr);
        }
    }

    drawMini(d => d.drift_arcsec_x, '#44cc44');
    drawMini(d => d.drift_arcsec_y, '#4488ff');

    // Y-axis labels
    ctx.fillStyle = '#666';
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(`+${yMax.toFixed(0)}″`, pad - 4 * dpr, pad + 5 * dpr);
    ctx.fillText(`-${yMax.toFixed(0)}″`, pad - 4 * dpr, bh - padBottom);
    ctx.fillText('0″', pad - 4 * dpr, midY + 4 * dpr);
}

// ── Star medallion (zoomed star + crosshair + drift indicator) ──

function _dashDrawMedallion(ctx, bw, bh, dpr) {
    const cap = (typeof _guideCap === 'function') ? _guideCap() : null;
    if (!cap || !cap.pixels) {
        ctx.fillStyle = '#555';
        ctx.font = `${15 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(i18n('dash.no_star'), bw / 2, bh / 2);
        return;
    }

    const size = Math.min(bw, bh);
    const zoomPixels = 28;
    const cropSize = zoomPixels * 2;

    let centerX, centerY;
    if (typeof _guideSelectedStar !== 'undefined' && _guideSelectedStar) {
        centerX = _guideSelectedStar.x;
        centerY = _guideSelectedStar.y;
    } else if (typeof _guideLastCentroid !== 'undefined' && _guideLastCentroid) {
        centerX = _guideLastCentroid.x;
        centerY = _guideLastCentroid.y;
    } else {
        centerX = cap.width / 2;
        centerY = cap.height / 2;
    }

    const sx = Math.max(0, Math.min(cap.width - cropSize, Math.round(centerX - zoomPixels)));
    const sy = Math.max(0, Math.min(cap.height - cropSize, Math.round(centerY - zoomPixels)));

    const tmp = document.createElement('canvas');
    tmp.width = cropSize; tmp.height = cropSize;
    const tctx = tmp.getContext('2d');
    const imgData = tctx.createImageData(cropSize, cropSize);
    const data = imgData.data;
    for (let dy = 0; dy < cropSize; dy++) {
        for (let dx = 0; dx < cropSize; dx++) {
            const px = sx + dx, py = sy + dy;
            if (px < 0 || px >= cap.width || py < 0 || py >= cap.height) continue;
            const raw = cap.pixels[py * cap.width + px];
            const v = Math.asinh(Math.max(0, raw - cap.sky) / cap.soft) / Math.asinh(cap.k);
            const val = Math.max(0, Math.min(255, Math.round(v * 255)));
            const dst = ((cropSize - 1 - dy) * cropSize + dx) * 4;
            data[dst] = val; data[dst + 1] = val; data[dst + 2] = val; data[dst + 3] = 255;
        }
    }
    tctx.putImageData(imgData, 0, 0);

    const ox = Math.round((bw - size) / 2);
    const oy = Math.round((bh - size) / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, ox, oy, size, size);

    const midX = ox + size / 2, midY = oy + size / 2;

    // Crosshair
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.7)';
    ctx.lineWidth = 2 * dpr;
    const rl = 12 * dpr;
    ctx.beginPath();
    ctx.moveTo(midX - rl, midY); ctx.lineTo(midX + rl, midY);
    ctx.moveTo(midX, midY - rl); ctx.lineTo(midX, midY + rl);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 255, 204, 0.25)';
    ctx.lineWidth = 0.7 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.arc(midX, midY, 7 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Drift indicator
    if (typeof _guideSelectedStar !== 'undefined' && _guideSelectedStar &&
        typeof _guideLastCentroid !== 'undefined' && _guideLastCentroid) {
        const dxPx = _guideLastCentroid.x - _guideSelectedStar.x;
        const dyPx = _guideLastCentroid.y - _guideSelectedStar.y;
        const drx = dxPx / cropSize * size;
        const dry = dyPx / cropSize * size;

        const clampX = Math.max(rl, Math.min(size - rl, midX + drx));
        const clampY = Math.max(rl, Math.min(size - rl, midY + dry));

        ctx.strokeStyle = 'rgba(255, 102, 0, 0.25)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        ctx.lineTo(clampX, clampY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = '#ff6600';
        ctx.lineWidth = 2.5 * dpr;
        const dl = 7 * dpr;
        ctx.beginPath();
        ctx.moveTo(clampX - dl, clampY); ctx.lineTo(clampX + dl, clampY);
        ctx.moveTo(clampX, clampY - dl); ctx.lineTo(clampX, clampY + dl);
        ctx.stroke();
    }
}

// ── Guide camera full-frame ──────────────────────────────────

function _dashDrawCamera(ctx, bw, bh, dpr) {
    const cap = (typeof _guideCap === 'function') ? _guideCap() : null;
    if (!cap || !cap.pixels) {
        ctx.fillStyle = '#555';
        ctx.font = `${15 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(i18n('dash.no_image'), bw / 2, bh / 2);
        return;
    }

    const sc = Math.min(bw / cap.width, bh / cap.height);
    const dw = Math.round(cap.width * sc), dh = Math.round(cap.height * sc);
    const ox = Math.round((bw - dw) / 2), oy = Math.round((bh - dh) / 2);

    const tmp = document.createElement('canvas');
    tmp.width = cap.width; tmp.height = cap.height;
    const tctx = tmp.getContext('2d');
    const imgData = tctx.createImageData(cap.width, cap.height);
    const data = imgData.data;
    for (let y = 0; y < cap.height; y++) {
        for (let x = 0; x < cap.width; x++) {
            const raw = cap.pixels[y * cap.width + x];
            const v = Math.asinh(Math.max(0, raw - cap.sky) / cap.soft) / Math.asinh(cap.k);
            const val = Math.max(0, Math.min(255, Math.round(v * 255)));
            const dst = ((cap.height - 1 - y) * cap.width + x) * 4;
            data[dst] = val; data[dst + 1] = val; data[dst + 2] = val; data[dst + 3] = 255;
        }
    }
    tctx.putImageData(imgData, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, ox, oy, dw, dh);

    // Crosshair at center
    const cx = ox + dw / 2, cy = oy + dh / 2;
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.5)';
    ctx.lineWidth = 1.5 * dpr;
    const rl = 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - rl, cy); ctx.lineTo(cx + rl, cy);
    ctx.moveTo(cx, cy - rl); ctx.lineTo(cx, cy + rl);
    ctx.stroke();
}

// ── Helpers ──────────────────────────────────────────────────

function _fmtDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`;
}
