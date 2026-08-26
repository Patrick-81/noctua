// ═══════════════════════════════════════════════════════════════
// Noctua — focuser.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Focuser panel ─────────────────────────────────────────────

const _focHistory = [];
let _focHistoryTimer = null;
const _focHfrData = [];    // [{step, position, hfr, fwhm, timestamp}]
let _focHfrStep = 0;

let _selectedFocCamera = '';
let _focCameraSelect = null;

// Autofocus state
let _afStartBtn = null, _afStopBtn = null;
let _afProgressBar = null, _afProgressText = null, _afStatusText = null;
let _afProgressWrap = null, _afResult = null;
let _afBestPos = null, _afBestHfr = null;
let _afVcurveCanvas = null;
let _afRunning = false;
let _afPositions = [];
let _afResults = [];
let _afIndex = 0;
let _afTimer = null;
let _afExposureSec = 1.0;

// Guide state
let _guideRunning = false;
let _guideTimer = null;
let _guideDriftHistory = [];
let _guideDriftCanvas = null;
let _guideChecklist = null;
let _guideStartBtn = null, _guideStopBtn = null, _guidePauseBtn = null;
let _guideFrameCountEl = null, _guideDriftRAEl = null, _guideDriftDECEl = null;
let _guideRmsRAEl = null, _guideRmsDECEl = null, _guideRmsTotalEl = null;
let _guideCorrRAEl = null, _guideCorrDECEl = null;
let _guideCameraSelect = null;

function findFocuser() {
    for (const [name, dev] of Object.entries(devices)) {
        if (dev.type === 'focuser') return { name, dev };
    }
    return null;
}

function renderFocuserPanel() {
    const f = findFocuser();
    const posEl = document.getElementById('foc-pos-current');
    const tgtEl = document.getElementById('foc-pos-target');
    const dotEl = document.getElementById('foc-moving-dot');
    const barEl = document.getElementById('foc-pos-bar');
    const speedEl = document.getElementById('foc-speed-input');
    if (!posEl) return;

    if (!f) {
        posEl.textContent = '—';
        tgtEl.textContent = '—';
        dotEl.textContent = '●';
        dotEl.className = 'foc-idle';
        if (barEl) barEl.style.width = '0%';
        return;
    }

    posEl.textContent = f.dev.position ?? '—';
    tgtEl.textContent = f.dev.target_position ?? '—';
    if (f.dev.is_moving) {
        dotEl.textContent = '●';
        dotEl.className = 'foc-moving';
    } else {
        dotEl.textContent = '●';
        dotEl.className = 'foc-idle';
    }

    // Position bar (relative to target if known, else static)
    if (barEl) {
        if (f.dev.target_position != null && f.dev.position != null) {
            const min = Math.min(f.dev.position, f.dev.target_position);
            const max = Math.max(f.dev.position, f.dev.target_position);
            const range = max - min || 1;
            const pct = Math.abs(f.dev.position - f.dev.target_position) / range * 100;
            barEl.style.width = (f.dev.is_moving ? pct : 0) + '%';
            barEl.style.background = f.dev.is_moving ? cssVar('--accent') : ('rgba(' + cssVar('--accent-rgb') + ',0.3)');
        } else {
            barEl.style.width = '0%';
        }
    }

    // Sync speed input (only if not focused)
    if (speedEl && document.activeElement !== speedEl && f.dev.speed != null) {
        speedEl.value = f.dev.speed;
    }

    _focHistory.push(f.dev.position ?? 0);
    if (_focHistory.length > 100) _focHistory.shift();
    _focDrawHistory();
}

function _focDrawHistory() {
    const canvas = document.getElementById('foc-history-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (_focHistory.length < 2) return;

    const min = Math.min(..._focHistory);
    const max = Math.max(..._focHistory);
    const range = max - min || 1;
    const step = w / (_focHistory.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,255,204,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < _focHistory.length; i++) {
        const x = i * step;
        const y = h - 4 - ((_focHistory[i] - min) / range) * (h - 8);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function _focDrawHfrChart() {
    const canvas = document.getElementById('foc-hfr-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const countEl = document.getElementById('foc-hfr-count');
    const bestEl = document.getElementById('foc-hfr-best');
    if (countEl) countEl.textContent = _focHfrData.length;

    if (_focHfrData.length === 0) {
        if (bestEl) bestEl.textContent = '—';
        return;
    }

    const hfrs = _focHfrData.map(d => d.hfr);
    const min = Math.min(...hfrs);
    const max = Math.max(...hfrs);
    const range = max - min || 1;
    const pad = 20;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;
    const bestIdx = hfrs.indexOf(min);

    if (bestEl) bestEl.textContent = min.toFixed(1) + 'px';

    // Y axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(max.toFixed(1), pad - 3, pad + 4);
    ctx.fillText(min.toFixed(1), pad - 3, h - pad + 4);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(w - pad, y);
        ctx.stroke();
    }

    // Data line
    if (_focHfrData.length >= 2) {
        const xStep = plotW / (_focHfrData.length - 1);
        ctx.beginPath();
        ctx.strokeStyle = cssVar('--accent');
        ctx.lineWidth = 1.5;
        for (let i = 0; i < _focHfrData.length; i++) {
            const x = pad + i * xStep;
            const y = pad + plotH - ((hfrs[i] - min) / range) * plotH;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Data points + best marker
    const xStep = _focHfrData.length > 1 ? plotW / (_focHfrData.length - 1) : 0;
    for (let i = 0; i < _focHfrData.length; i++) {
        const x = pad + i * xStep;
        const y = pad + plotH - ((hfrs[i] - min) / range) * plotH;

        if (i === bestIdx) {
            // Best point: filled cyan diamond
            ctx.fillStyle = cssVar('--accent');
            ctx.beginPath();
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x + 5, y);
            ctx.lineTo(x, y + 5);
            ctx.lineTo(x - 5, y);
            ctx.closePath();
            ctx.fill();
        } else {
            // Normal point: small dot
            ctx.fillStyle = 'rgba(0,255,204,0.6)';
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Position labels on X axis (show first and last)
    ctx.fillStyle = '#666';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    if (_focHfrData.length > 0) {
        ctx.fillText('pos:' + _focHfrData[0].position, pad, h - 2);
        if (_focHfrData.length > 1) {
            ctx.textAlign = 'right';
            ctx.fillText('pos:' + _focHfrData[_focHfrData.length - 1].position, w - pad, h - 2);
        }
    }
}

// ── Camera selector for focuser ─────────────────────────────

function _refreshCameraList() {
    fetch('/api/cameras').then(r => r.json()).then(cameras => {
        if (!_focCameraSelect) return;
        const prev = _focCameraSelect.value;
        _focCameraSelect.innerHTML = `<option value="">${i18n('focuser.no_camera')}</option>`;
        for (const c of cameras) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name + (c.connected ? '' : i18n('focuser.deco'));
            _focCameraSelect.appendChild(opt);
        }
        if (prev && [..._focCameraSelect.options].some(o => o.value === prev)) {
            _focCameraSelect.value = prev;
        }
    }).catch(() => {});
}

function _getSelectedCamera() {
    return _selectedFocCamera || '';
}

// ── Autofocus sequence ──────────────────────────────────────

async function _autofocusStart() {
    if (_afRunning) return;
    const f = findFocuser();
    if (!f) { addLog('error', 'autofocus', i18n('log.autofocus.no_focuser')); return; }

    const range = parseInt(document.getElementById('af-range')?.value || '2000');
    const points = parseInt(document.getElementById('af-points')?.value || '25');
    const center = f.dev.position ?? 0;

    _afRunning = true;
    _afResults = [];
    _afIndex = 0;
    _afPositions = [];
    const currHfrEl = document.getElementById('af-curr-hfr');
    if (currHfrEl) currHfrEl.textContent = 'HFR: —';
    const currPosEl = document.getElementById('af-curr-pos');
    if (currPosEl) currPosEl.textContent = 'Pos: —';
    if (_afStartBtn) _afStartBtn.disabled = true;
    if (_afStopBtn) _afStopBtn.disabled = false;
    if (_afProgressWrap) _afProgressWrap.style.display = '';
    if (_afResult) _afResult.style.display = 'none';

    // Start autofocus on server
    const res = await fetch('/api/focuser/autofocus/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ center, range, points })
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'autofocus', res?.error || i18n('log.autofocus.start_failed'));
        _autofocusCleanup();
        return;
    }
    _afPositions = res.positions || [];
    _afExposureSec = 1.0;
    addLog('info', 'autofocus', i18nFmt('log.autofocus.vcurve', { n: _afPositions.length, center, range }));
    _autofocusStep();
}

async function _autofocusStep() {
    if (!_afRunning || _afIndex >= _afPositions.length) {
        _autofocusFinish();
        return;
    }
    const pos = _afPositions[_afIndex];
    const total = _afPositions.length;

    if (_afProgressText) _afProgressText.textContent = `${_afIndex + 1}/${total}`;
    if (_afProgressBar) _afProgressBar.style.width = `${((_afIndex) / total) * 100}%`;
    if (_afStatusText) _afStatusText.textContent = `→ ${pos}`;
    _autofocusDrawVcurve();

    // Move focuser
    await fetch('/api/focuser/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos })
    }).then(r => r.json()).catch(() => {});

    // Wait for focuser to arrive
    const arrived = await _autofocusWaitFocuser(pos, 15000);
    if (!arrived) { _autofocusAbort(i18n('focuser.not_arrived') + pos); return; }

    // Expose (short exposure)
    if (_afStatusText) _afStatusText.textContent = `Expose ${pos}`;
    await fetch('/api/camera/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: _getSelectedCamera(), duration: _afExposureSec })
    }).then(r => r.json()).catch(() => {});

    // Wait for image
    const imgReady = await _autofocusWaitImage(30000);
    if (!imgReady) { _autofocusAbort(i18n('focuser.no_image')); return; }

    // Measure HFR
    if (_afStatusText) _afStatusText.textContent = `Mesure ${pos}`;
    const metric = await fetch('/api/focuser/focus-metric' + (_getSelectedCamera() ? `?device=${encodeURIComponent(_getSelectedCamera())}` : ''))
        .then(r => r.json()).catch(() => null);

    if (!metric?.ok) { _autofocusAbort('Focus metric failed'); return; }

    // Record step
    await fetch('/api/focuser/autofocus/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos, hfr: metric.hfr, fwhm: metric.fwhm })
    }).then(r => r.json()).catch(() => {});

    _afResults.push({ position: pos, hfr: metric.hfr, fwhm: metric.fwhm });
    _autofocusDrawVcurve();
    _afIndex++;

    // Update info line with current HFR and position
    const currHfrEl = document.getElementById('af-curr-hfr');
    if (currHfrEl) {
        const bestMin = _afResults.reduce((m, r) => r.hfr < m.hfr ? r : m, _afResults[0]);
        currHfrEl.textContent = `HFR: ${metric.hfr.toFixed(2)} → meilleur: ${bestMin.hfr.toFixed(2)}`;
    }
    const currPosEl = document.getElementById('af-curr-pos');
    if (currPosEl) currPosEl.textContent = `Pos: ${pos}`;

    // Also record in HFR history
    _focHfrData.push({
        step: _focHfrStep++,
        position: pos,
        hfr: metric.hfr,
        fwhm: metric.fwhm,
        timestamp: Date.now()
    });
    if (_focHfrData.length > 200) _focHfrData.shift();
    _focDrawHfrChart();

    // Next step
    setTimeout(() => _autofocusStep(), 100);
}

async function _autofocusWaitFocuser(targetPos, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const f = findFocuser();
        if (f && !f.dev.is_moving) return true;
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

function _autofocusWaitImage(timeoutMs) {
    const camName = _getSelectedCamera();
    const t0 = Date.now();
    return new Promise(resolve => {
        const check = () => {
            if (!_afRunning) { resolve(false); return; }
            const elapsed = Date.now() - t0;
            if (elapsed > timeoutMs) { resolve(false); return; }
            const cam = devices[camName];
            if (cam && cam.exposure_time != null && cam.exposure_time <= 0) {
                resolve(true);
                return;
            }
            setTimeout(check, 200);
        };
        setTimeout(check, 200);
    });
}

async function _autofocusFinish() {
    if (_afStatusText) _afStatusText.textContent = 'Analyse...';
    const res = await fetch('/api/focuser/autofocus/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()).catch(() => null);

    if (res?.ok) {
        if (_afBestPos) _afBestPos.textContent = res.best_position;
        if (_afBestHfr) _afBestHfr.textContent = res.best_hfr ? res.best_hfr.toFixed(2) : '—';
        if (_afResult) _afResult.style.display = '';
        if (_afProgressBar) _afProgressBar.style.width = '100%';
        addLog('info', 'autofocus', i18nFmt('log.autofocus.best', { pos: res.best_position, hfr: res.best_hfr ? res.best_hfr.toFixed(2) : '—' }));

        // Move focuser to best position
        if (res.best_position != null) {
            if (_afStatusText) _afStatusText.textContent = `→ meilleur: ${res.best_position}`;
            await fetch('/api/focuser/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position: res.best_position })
            }).then(r => r.json()).catch(() => {});
            await _autofocusWaitFocuser(res.best_position, 30000);

            // Verification capture
            if (_afStatusText) _afStatusText.textContent = i18n('focuser.checking');
            await fetch('/api/camera/expose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: _getSelectedCamera(), duration: _afExposureSec })
            }).then(r => r.json()).catch(() => {});
            await _autofocusWaitImage(30000);
        }
    } else {
        addLog('error', 'autofocus', res?.error || i18n('log.autofocus.analysis_failed'));
    }
    _autofocusDrawVcurve();
    if (_afStatusText) _afStatusText.textContent = i18n('focuser.done');
    _autofocusCleanup();
}

function _autofocusAbort(msg) {
    addLog('error', 'autofocus', msg);
    fetch('/api/focuser/autofocus/stop', { method: 'POST' }).catch(() => {});
    _autofocusCleanup();
}

async function _autofocusStop() {
    if (!_afRunning) return;
    _afRunning = false;
    if (_afTimer) { clearTimeout(_afTimer); _afTimer = null; }
    await fetch('/api/focuser/autofocus/stop', { method: 'POST' }).catch(() => {});
    addLog('warning', 'autofocus', i18n('log.autofocus.stopped'));
    _autofocusCleanup();
}

function _autofocusCleanup() {
    _afRunning = false;
    if (_afStartBtn) _afStartBtn.disabled = false;
    if (_afStopBtn) _afStopBtn.disabled = true;
}

function _autofocusDrawVcurve() {
    const canvas = _afVcurveCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (_afResults.length < 2) {
        ctx.fillStyle = '#555';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(i18n('focuser.waiting'), w / 2, h / 2);
        return;
    }

    const pad = 30;
    const positions = _afResults.map(r => r.position);
    const hfrs = _afResults.map(r => r.hfr);
    const minPos = Math.min(...positions), maxPos = Math.max(...positions);
    const minHfr = Math.min(...hfrs), maxHfr = Math.max(...hfrs);
    const posRange = maxPos - minPos || 1;
    const hfrRange = (maxHfr - minHfr) || 1;

    // Grid
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (h - 2 * pad) * (i / 4);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    // Data points
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < _afResults.length; i++) {
        const x = pad + ((positions[i] - minPos) / posRange) * (w - 2 * pad);
        const y = pad + ((hfrs[i] - minHfr) / hfrRange) * (h - 2 * pad);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Dots
    for (let i = 0; i < _afResults.length; i++) {
        const x = pad + ((positions[i] - minPos) / posRange) * (w - 2 * pad);
        const y = pad + ((hfrs[i] - minHfr) / hfrRange) * (h - 2 * pad);
        ctx.fillStyle = cssVar('--accent');
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }

    // Best point
    if (_afResults.length >= 3) {
        let bestI = 0;
        for (let i = 1; i < _afResults.length; i++) {
            if (_afResults[i].hfr < _afResults[bestI].hfr) bestI = i;
        }
        const bx = pad + ((positions[bestI] - minPos) / posRange) * (w - 2 * pad);
        const by = pad + ((hfrs[bestI] - minHfr) / hfrRange) * (h - 2 * pad);
        ctx.strokeStyle = cssVar('--status-error');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = cssVar('--status-error');
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(positions[bestI], bx, by - 10);
    }

    // Axis labels
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${minPos}`, pad, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${maxPos}`, w - pad, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(minHfr.toFixed(1), pad - 4, pad + 4);
    ctx.fillText(maxHfr.toFixed(1), pad - 4, h - pad + 4);
}

function initFocuserPanel() {
    document.querySelectorAll('.foc-rel').forEach(btn => {
        btn.addEventListener('click', () => {
            const steps = parseInt(btn.dataset.steps);
            const dir = steps > 0 ? 'OUT' : 'IN';
            apiPost('/api/focuser/move_relative', { direction: dir, steps: Math.abs(steps) });
        });
    });

    const goBtn = document.getElementById('foc-abs-go');
    if (goBtn) {
        goBtn.addEventListener('click', () => {
            const input = document.getElementById('foc-abs-input');
            const pos = parseInt(input?.value);
            if (!isNaN(pos)) {
                apiPost('/api/focuser/move', { position: pos });
                input.value = '';
            }
        });
    }

    const absInput = document.getElementById('foc-abs-input');
    if (absInput) {
        absInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                goBtn?.click();
            }
        });
    }

    const haltBtn = document.getElementById('foc-halt-btn');
    if (haltBtn) {
        haltBtn.addEventListener('click', () => {
            apiPost('/api/focuser/halt');
        });
    }

    // Speed control
    const speedSet = document.getElementById('foc-speed-set');
    const speedInput = document.getElementById('foc-speed-input');
    if (speedSet && speedInput) {
        const sendSpeed = () => {
            const val = parseInt(speedInput.value);
            if (!isNaN(val) && val > 0) apiPost('/api/focuser/speed', { speed: val });
        };
        speedSet.addEventListener('click', sendSpeed);
        speedInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); sendSpeed(); }
        });
    }

    // HFR chart reset
    const hfrReset = document.getElementById('foc-hfr-reset');
    if (hfrReset) {
        hfrReset.addEventListener('click', () => {
            _focHfrData.length = 0;
            _focHfrStep = 0;
            _focDrawHfrChart();
            clearFocusOverlay();
        });
    }

    // Camera selector for focuser mode
    _focCameraSelect = document.getElementById('foc-camera-select');
    if (_focCameraSelect) {
        _refreshCameraList();
        _focCameraSelect.addEventListener('change', () => {
            _selectedFocCamera = _focCameraSelect.value;
            addLog('info', 'focuser', i18nFmt('log.focuser.camera', { name: _selectedFocCamera || '—' }));
        });
    }

    // Autofocus wiring
    _afStartBtn = document.getElementById('af-start');
    _afStopBtn = document.getElementById('af-stop');
    _afProgressBar = document.getElementById('af-progress-bar');
    _afProgressText = document.getElementById('af-progress-text');
    _afStatusText = document.getElementById('af-status-text');
    _afProgressWrap = document.getElementById('af-progress-wrap');
    _afResult = document.getElementById('af-result');
    _afBestPos = document.getElementById('af-best-pos');
    _afBestHfr = document.getElementById('af-best-hfr');
    _afVcurveCanvas = document.getElementById('af-vcurve-canvas');

    if (_afStartBtn) {
        _afStartBtn.addEventListener('click', _autofocusStart);
    }
    if (_afStopBtn) {
        _afStopBtn.addEventListener('click', _autofocusStop);
    }
}

// ── Hub : consommateur ws:state ───────────────────────────────

Hub.subscribe('ws:state', 'focuser', () => {
    renderFocuserPanel();
    _refreshCameraList();
});

