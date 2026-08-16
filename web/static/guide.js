// ═══════════════════════════════════════════════════════════════
// Noctua — guide.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Guide (autoguidage) ─────────────────────────────────────

function initGuidePanel() {
    _guideDriftCanvas = document.getElementById('guide-drift-canvas');
    _guideStartBtn = document.getElementById('guide-start-btn');
    _guideStopBtn = document.getElementById('guide-stop-btn');
    _guidePauseBtn = document.getElementById('guide-pause-btn');
    _guideFrameCountEl = document.getElementById('guide-frame-count');
    _guideDriftRAEl = document.getElementById('guide-drift-ra');
    _guideDriftDECEl = document.getElementById('guide-drift-dec');
    _guideRmsRAEl = document.getElementById('guide-rms-ra');
    _guideRmsDECEl = document.getElementById('guide-rms-dec');
    _guideRmsTotalEl = document.getElementById('guide-rms-total');
    _guideCorrRAEl = document.getElementById('guide-corr-ra');
    _guideCorrDECEl = document.getElementById('guide-corr-dec');
    _guideCameraSelect = document.getElementById('guide-camera-select');

    if (_guideCameraSelect) {
        _refreshGuideCameraList();
    }

    const aggrSlider = document.getElementById('guide-aggressiveness');
    const aggrVal = document.getElementById('guide-aggr-val');
    if (aggrSlider && aggrVal) {
        aggrSlider.addEventListener('input', () => {
            aggrVal.textContent = aggrSlider.value;
        });
    }

    if (_guideStartBtn) _guideStartBtn.addEventListener('click', _guideStart);
    if (_guideStopBtn) _guideStopBtn.addEventListener('click', _guideStop);
    if (_guidePauseBtn) _guidePauseBtn.addEventListener('click', _guidePause);

    // Refresh button for drift graph
    const guideRefresh = document.getElementById('guide-refresh-btn');
    if (guideRefresh) guideRefresh.addEventListener('click', () => {
        _guideUpdateRms();
        _guideDrawDrift();
    });

    const resetBtn = document.getElementById('guide-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', _guideReset);

    // Guide camera binning
    const guideBin = document.getElementById('guide-binning');
    if (guideBin) {
        guideBin.addEventListener('change', () => {
            const v = parseInt(guideBin.value);
            const cam = _guideCameraSelect?.value;
            if (!cam) return;
            apiPost('/api/property', {
                device: cam,
                property: 'CCD_BINNING',
                items: [{ name: 'HOR_BIN', value: v }, { name: 'VER_BIN', value: v }]
            });
        });
    }

    // Capture button
    const captureBtn = document.getElementById('guide-capture-btn');
    if (captureBtn) captureBtn.addEventListener('click', _guideCapHandler);

    // Auto-select button
    const autoBtn = document.getElementById('guide-autoselect-btn');
    if (autoBtn) autoBtn.addEventListener('click', _guideAutoSelect);

    // Zoom controls for guide preview
    _initGuidePreviewZoom();

    // Checklist
    _guideChecklist = new ChecklistPanel('guide-checklist-body', [
        { label: i18n('guide.check_1_camera'), check: () => !!_guideCameraSelect?.value, action: () => {
            if (_guideCameraSelect) {
                _guideCameraSelect.focus();
                _guideCameraSelect.style.outline = '2px solid #ffaa00';
                setTimeout(() => _guideCameraSelect.style.outline = '', 2000);
            }
        }},
        { label: i18n('guide.check_2_mount'), check: () => !!findMount(), action: () => {
            const mount = findMount();
            if (!mount && devices) {
                const firstMount = Object.entries(devices).find(([n, d]) => d.type === 'mount');
                if (firstMount) selectDevice(firstMount[0]);
                else addLog('warn', 'guide', i18n('log.guide.no_mount'));
            }
        }},
        { label: i18n('guide.check_3_cal'), check: () => _calibrated, action: () => {
            const calBtn = document.getElementById('cal-start-btn');
            if (calBtn) { calBtn.click(); calBtn.scrollIntoView({ behavior: 'smooth' }); }
            else addLog('warn', 'guide', i18n('log.guide.open_calibration'));
        }}
    ]);
}

function _refreshGuideCameraList() {
    fetch('/api/cameras').then(r => r.json()).then(cameras => {
        if (!_guideCameraSelect) return;
        const prev = _guideCameraSelect.value;
        _guideCameraSelect.innerHTML = `<option value="">${i18n('guide.no_camera')}</option>`;
        for (const c of cameras) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name + (c.connected ? '' : i18n('guide.deco'));
            _guideCameraSelect.appendChild(opt);
        }
        if (prev && [..._guideCameraSelect.options].some(o => o.value === prev)) {
            _guideCameraSelect.value = prev;
        }
    }).catch(() => {});
}

function _guideApplyPreviewTransform() { guideViewer?._applyTransform(); }
function _guideResetPreviewZoom() { guideViewer?.resetZoom(); }
function _guideFitPreviewZoom() { guideViewer?.fitZoom(); }
function _initGuidePreviewZoom() { guideViewer?.initZoomPan(); }

async function _guideCapHandler() {
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('warn', 'guide', i18n('log.guide.select_camera')); return; }
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const statusEl = document.getElementById('guide-preview-status');
    if (statusEl) { statusEl.textContent = i18n('guide.capturing'); statusEl.style.color = '#ffaa00'; }
    addLog('info', 'guide', i18nFmt('log.guide.capture_preview', { exposure }));
    const res = await fetch('/api/camera/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: cam, duration: exposure })
    }).then(r => r.json()).catch(() => null);
    if (!res?.ok) {
        const msg = res?.error || i18n('guide.capture_fail');
        if (statusEl) { statusEl.textContent = `❌ ${msg}`; statusEl.style.color = '#ff4444'; }
        addLog('error', 'guide', msg);
    }
}

async function _guideStart() {
    if (_guideRunning) return;
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('error', 'guide', i18n('log.guide.select_camera')); return; }

    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const aggr = parseFloat(document.getElementById('guide-aggressiveness')?.value || '0.8');
    const raGain = parseFloat(document.getElementById('guide-ra-gain')?.value || '1.0');
    const decGain = parseFloat(document.getElementById('guide-dec-gain')?.value || '1.0');
    const maxPulse = parseInt(document.getElementById('guide-max-pulse')?.value || '2000');

    _guideRunning = true;
    _guideDriftHistory = [];
    if (_guideStartBtn) _guideStartBtn.disabled = true;
    if (_guideStopBtn) _guideStopBtn.disabled = false;
    if (_guidePauseBtn) _guidePauseBtn.disabled = false;

    const res = await fetch('/api/guide/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            exposure, aggressiveness: aggr,
            ra_gain: raGain, dec_gain: decGain,
            max_pulse_ms: maxPulse
        })
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'guide', res?.error || i18n('log.guide.start_failed'));
        _guideCleanup();
        return;
    }
    addLog('info', 'guide', i18nFmt('log.guide.started', { expo: exposure, aggr }));
    _guideLoop();
}

async function _guideLoop() {
    if (!_guideRunning) return;
    const cam = _guideCameraSelect?.value || '';
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');

    // Expose guide camera
    apiPost('/api/camera/expose', { device: cam, duration: exposure });

    // Wait for image
    await new Promise(r => setTimeout(r, Math.max(500, exposure * 1000 + 500)));

    // Measure star centroid via focus-metric
    const metricUrl = '/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : '');
    const metric = await fetch(metricUrl).then(r => r.json()).catch(() => null);

    if (metric?.ok && metric.stars?.length > 0) {
        const star = metric.stars[0];
        const x = star.x;
        const y = star.y;
        _guideLastCentroid = { x, y, imgW: metric.width || null, imgH: metric.height || null };

        // Report to guide backend
        const step = await fetch('/api/guide/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x, y, snr: star.snr ?? null })
        }).then(r => r.json()).catch(() => null);

        if (step?.ok) {
            _guideRefSet = step.ref_set;
            _guideUpdateUI(step);

            // Send correction pulses to mount
            if (step.ra_pulse_ms > 0 && step.ra_direction) {
                const dir = step.ra_direction === 'E' ? 'EAST' : 'WEST';
                apiPost('/api/mount/move', { direction: dir, rate: 'Guide' });
                setTimeout(() => apiPost('/api/mount/halt'), step.ra_pulse_ms);
            }
            if (step.dec_pulse_ms > 0 && step.dec_direction) {
                const dir = step.dec_direction === 'N' ? 'NORTH' : 'SOUTH';
                apiPost('/api/mount/move', { direction: dir, rate: 'Guide' });
                setTimeout(() => apiPost('/api/mount/halt'), step.dec_pulse_ms);
            }
        }
    }

    // Next frame
    if (_guideRunning) {
        _guideTimer = setTimeout(() => _guideLoop(), 200);
    }
}

function _guideUpdateUI(status) {
    if (_guideFrameCountEl) _guideFrameCountEl.textContent = status.frame_count;
    if (_guideDriftRAEl) _guideDriftRAEl.textContent = status.drift_arcsec_x?.toFixed(1) ?? '0.0';
    if (_guideDriftDECEl) _guideDriftDECEl.textContent = status.drift_arcsec_y?.toFixed(1) ?? '0.0';
    if (_guideCorrRAEl) _guideCorrRAEl.textContent = `${status.ra_pulse_ms}ms ${status.ra_direction || '—'}`;
    if (_guideCorrDECEl) _guideCorrDECEl.textContent = `${status.dec_pulse_ms}ms ${status.dec_direction || '—'}`;

    if (status.history) {
        _guideDriftHistory = status.history;
        _guideDrawDrift();
        _calDrawCalCrosshair();
        _guideUpdateRms();
    }

    // Beep if outside tolerance
    const tolInput = document.getElementById('guide-tolerance');
    const tol = parseFloat(tolInput?.value || '10');
    if (tol > 0) {
        const ra = Math.abs(status.drift_arcsec_x || 0);
        const dec = Math.abs(status.drift_arcsec_y || 0);
        if (ra > tol || dec > tol) _guideBeep();
    }
}

let _guideDriftLastCSSW = 0, _guideDriftLastCSSH = 0;
let _guideAudioCtx = null;


function _guideBeep() {
    try {
        if (!_guideAudioCtx) _guideAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = _guideAudioCtx.createOscillator();
        const gain = _guideAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(_guideAudioCtx.destination);
        osc.frequency.value = 880;
        osc.type = 'square';
        gain.gain.setValueAtTime(0.15, _guideAudioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, _guideAudioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(_guideAudioCtx.currentTime + 0.3);
    } catch (e) { /* audio not available */ }
}

function _guideRenderStarMedallion() {
    const canvas = document.getElementById('guide-star-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = 140, ch = 140;
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, bw, bh);

    const cap = _guideCap();
    if (!cap || !cap.pixels) {
        ctx.fillStyle = '#555';
        ctx.font = `${10 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('Pas d\'image', bw / 2, bh / 2);
        return;
    }

    // Determine zoom center: use selected star, or current centroid, or image center
    let centerX, centerY;
    if (_guideSelectedStar) {
        centerX = _guideSelectedStar.x;
        centerY = _guideSelectedStar.y;
    } else if (_guideLastCentroid) {
        centerX = _guideLastCentroid.x;
        centerY = _guideLastCentroid.y;
    } else {
        // No star: render full frame
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
        return;
    }

    // Zoom crop centered on reference star
    const zoomPixels = 28;
    const cropSize = zoomPixels * 2;
    const sx = Math.max(0, Math.min(cap.width - cropSize, Math.round(centerX - zoomPixels)));
    const sy = Math.max(0, Math.min(cap.height - cropSize, Math.round(centerY - zoomPixels)));

    const tmp = document.createElement('canvas');
    tmp.width = cropSize; tmp.height = cropSize;
    const tctx = tmp.getContext('2d');
    const imgData = tctx.createImageData(cropSize, cropSize);
    const data = imgData.data;
    for (let dy = 0; dy < cropSize; dy++) {
        for (let dx = 0; dx < cropSize; dx++) {
            const px = sx + dx;
            const py = sy + dy;
            if (px < 0 || px >= cap.width || py < 0 || py >= cap.height) continue;
            const raw = cap.pixels[py * cap.width + px];
            const v = Math.asinh(Math.max(0, raw - cap.sky) / cap.soft) / Math.asinh(cap.k);
            const val = Math.max(0, Math.min(255, Math.round(v * 255)));
            const dst = ((cropSize - 1 - dy) * cropSize + dx) * 4;
            data[dst] = val; data[dst + 1] = val; data[dst + 2] = val; data[dst + 3] = 255;
        }
    }
    tctx.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, bw, bh);

    const midX = bw / 2, midY = bh / 2;

    // Reticle fixe au centre = position du télescope
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.7)';
    ctx.lineWidth = 1.5 * dpr;
    const rl = 12 * dpr;
    ctx.beginPath();
    ctx.moveTo(midX - rl, midY); ctx.lineTo(midX + rl, midY);
    ctx.moveTo(midX, midY - rl); ctx.lineTo(midX, midY + rl);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 255, 204, 0.25)';
    ctx.lineWidth = 0.5 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.arc(midX, midY, 6 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Indicateur de dérive (position courante de l'étoile)
    if (_guideSelectedStar && _guideLastCentroid) {
        const dxPx = _guideLastCentroid.x - _guideSelectedStar.x;
        const dyPx = _guideLastCentroid.y - _guideSelectedStar.y;
        const drx = dxPx / cropSize * bw;
        const dry = dyPx / cropSize * bh;

        const clampX = Math.max(rl, Math.min(bw - rl, midX + drx));
        const clampY = Math.max(rl, Math.min(bh - rl, midY + dry));

        // Ligne pointillée du centre vers la dérive
        ctx.strokeStyle = 'rgba(255, 102, 0, 0.25)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([2 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        ctx.lineTo(clampX, clampY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Repère orange à la position courante
        ctx.strokeStyle = '#ff6600';
        ctx.lineWidth = 2 * dpr;
        const dl = 6 * dpr;
        ctx.beginPath();
        ctx.moveTo(clampX - dl, clampY); ctx.lineTo(clampX + dl, clampY);
        ctx.moveTo(clampX, clampY - dl); ctx.lineTo(clampX, clampY + dl);
        ctx.stroke();

        ctx.fillStyle = '#ff6600';
        ctx.beginPath();
        ctx.arc(clampX, clampY, 2.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
    }
}


function _guideDrawDrift() {
    const canvas = _guideDriftCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const dw = canvas.clientWidth;
    const dh = canvas.clientHeight;
    if (!dw || !dh) return;
    const bw = Math.round(dw * dpr);
    const bh = Math.round(dh * dpr);
    if (canvas.width !== bw || canvas.height !== bh || dw !== _guideDriftLastCSSW || dh !== _guideDriftLastCSSH) {
        canvas.width = bw;
        canvas.height = bh;
        _guideDriftLastCSSW = dw;
        _guideDriftLastCSSH = dh;
    }
    const ctx = canvas.getContext('2d');
    const w = bw, h = bh;
    ctx.clearRect(0, 0, w, h);

    const hist = _guideDriftHistory;
    const pad = 42;
    const padBottom = 18;
    const midY = h / 2;

    // Dynamic yMax from tolerance input (minimum ±5)
    const tolInput = document.getElementById('guide-tolerance');
    const tolArcsec = parseFloat(tolInput?.value || '10');
    const yMax = Math.max(5, tolArcsec);

    // Grid lines
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1 * dpr;
    const gridSteps = 4;
    for (let i = -gridSteps; i <= gridSteps; i++) {
        const y = midY + (i / gridSteps) * (midY - pad);
        if (y < pad || y > h - padBottom) continue;
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    // Zero line (target) — brighter
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(w - pad, midY); ctx.stroke();

    // Tolerance zone from input value
    const tol = tolArcsec / yMax * (midY - pad);
    ctx.fillStyle = 'rgba(255,68,68,0.12)';
    ctx.fillRect(pad, midY - tol, w - 2 * pad, tol * 2);
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(pad, midY - tol); ctx.lineTo(w - pad, midY - tol); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, midY + tol); ctx.lineTo(w - pad, midY + tol); ctx.stroke();
    ctx.setLineDash([]);

    // Tolerance label
    ctx.fillStyle = '#ff6666';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`±${tolArcsec}″`, pad + 2 * dpr, midY - tol - 4 * dpr);

    if (hist.length < 1) {
        ctx.fillStyle = '#777';
        ctx.font = `${12 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(i18n('guide.waiting'), w / 2, midY);
        return;
    }

    // ── Fixed-size sliding window (60s) ──
    const windowSec = 60;
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const windowFrames = Math.max(2, Math.ceil(windowSec / exposure));
    const plotWidth = w - 2 * pad;
    const xStep = plotWidth / (windowFrames - 1);

    // Determine which history indices fall in the window
    const startIdx = Math.max(0, hist.length - windowFrames);

    // Pre-allocate fixed-size array (null = no data yet)
    const slots = new Array(windowFrames).fill(null);
    for (let i = 0; i < windowFrames; i++) {
        const hi = startIdx + i;
        if (hi >= 0 && hi < hist.length) slots[i] = hist[hi];
    }

    // Find first/last non-null
    let firstSlot = -1, lastSlot = -1;
    for (let i = 0; i < windowFrames; i++) {
        if (slots[i] !== null) {
            if (firstSlot === -1) firstSlot = i;
            lastSlot = i;
        }
    }
    if (firstSlot === -1) return;

    function drawLine(getVal, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        let started = false;
        for (let i = firstSlot; i <= lastSlot; i++) {
            const d = slots[i];
            if (d === null) continue;
            const x = pad + i * xStep;
            const y = midY - (getVal(d) / yMax) * (midY - pad);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Last value dot + label
        const last = slots[lastSlot];
        if (last) {
            const lx = pad + lastSlot * xStep;
            const ly = midY - (getVal(last) / yMax) * (midY - pad);
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(lx, ly, 4 * dpr, 0, Math.PI * 2); ctx.fill();
            ctx.font = `bold ${10 * dpr}px monospace`;
            ctx.textAlign = 'left';
            ctx.fillText(`${getVal(last).toFixed(1)}″`, lx + 6 * dpr, ly - 6 * dpr);
        }
    }

    drawLine(d => d.drift_arcsec_x, '#44cc44');
    drawLine(d => d.drift_arcsec_y, '#4488ff');

    // ── Pulse overlay bars (semi-transparent, signed, from baseline) ──
    let maxPulse = 0;
    for (let i = firstSlot; i <= lastSlot; i++) {
        const d = slots[i];
        if (!d) continue;
        const r = Math.abs(d.ra_pulse_ms || 0), dec = Math.abs(d.dec_pulse_ms || 0);
        if (r > maxPulse) maxPulse = r;
        if (dec > maxPulse) maxPulse = dec;
    }
    if (maxPulse < 1) maxPulse = 1;
    const pulseMaxH = 30 * dpr;
    for (let i = firstSlot; i <= lastSlot; i++) {
        const d = slots[i];
        if (!d) continue;
        const x = pad + i * xStep;
        const bw2 = Math.max(2, xStep - 1 * dpr);
        const raMag = d.ra_pulse_ms || 0;
        if (raMag > 0) {
            const barH = (raMag / maxPulse) * pulseMaxH;
            const up = d.ra_direction === 'W';
            ctx.fillStyle = 'rgba(68, 204, 68, 0.2)';
            ctx.fillRect(x - bw2 / 2, up ? midY - barH : midY, bw2, barH);
        }
        const decMag = d.dec_pulse_ms || 0;
        if (decMag > 0) {
            const barH = (decMag / maxPulse) * pulseMaxH;
            const up = d.dec_direction === 'N';
            ctx.fillStyle = 'rgba(68, 136, 255, 0.2)';
            ctx.fillRect(x - bw2 / 2, up ? midY - barH : midY, bw2, barH);
        }
    }

    // ── SNR overlay (yellow) — superposed on the drift curves ──
    // Plotted on a right-side axis (0 = bottom, snrMax = top); shares the
    // time x-axis with the AD/DEC drift curves.
    const snrMax = 50;
    const snrTop = pad, snrBottom = h - padBottom;
    const snrScale = (snrBottom - snrTop) / snrMax;
    const snrY = (snr) => snrBottom - (snr / snrMax) * (snrBottom - snrTop);
    const sFirst = Math.max(0, Math.min(firstSlot, windowFrames - 1));
    const sLast = Math.max(sFirst, lastSlot);
    let hasSnr = false;
    for (let i = sFirst; i <= sLast; i++) { const d = slots[i]; if (d && d.snr != null) { hasSnr = true; break; } }
    if (hasSnr) {
        // Right axis + ticks
        ctx.strokeStyle = 'rgba(255,170,0,0.45)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(w - pad, snrTop); ctx.lineTo(w - pad, snrBottom); ctx.stroke();
        ctx.fillStyle = '#ffaa00';
        ctx.font = `${7.5 * dpr}px monospace`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const t of [0, 25, 50]) {
            const y = snrY(t);
            ctx.strokeStyle = 'rgba(255,170,0,0.18)';
            ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
            ctx.fillStyle = '#ffaa00';
            ctx.fillText(t.toString(), w - pad - 3 * dpr, y + 3 * dpr);
        }
        ctx.fillStyle = '#ffaa00';
        ctx.font = `${7 * dpr}px monospace`;
        ctx.textAlign = 'right';
        ctx.fillText('SNR', w - pad - 3 * dpr, snrTop - 6 * dpr);
        // Curve
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        let started = false;
        for (let i = sFirst; i <= sLast; i++) {
            const d = slots[i];
            if (!d || d.snr == null) continue;
            const x = pad + i * xStep;
            const y = snrY(d.snr);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Last value dot
        let ls = null, li = -1;
        for (let i = sLast; i >= sFirst; i--) { const d = slots[i]; if (d && d.snr != null) { ls = d.snr; li = i; break; } }
        if (ls != null) {
            ctx.fillStyle = '#ffaa00';
            ctx.beginPath(); ctx.arc(pad + li * xStep, snrY(ls), 3.5 * dpr, 0, Math.PI * 2); ctx.fill();
            ctx.font = `bold ${9 * dpr}px monospace`;
            ctx.textAlign = 'left';
            ctx.fillStyle = '#ffcc66';
            ctx.fillText(`${ls.toFixed(1)}`, pad + li * xStep + 6 * dpr, snrY(ls) - 4 * dpr);
        }
    }

    // Y axis labels
    ctx.fillStyle = '#999';
    ctx.font = `bold ${10 * dpr}px monospace`;
    ctx.textAlign = 'right';
    for (let i = -gridSteps; i <= gridSteps; i++) {
        const y = midY + (i / gridSteps) * (midY - pad);
        if (y < pad - 4 * dpr || y > h - padBottom + 4 * dpr) continue;
        const val = (i / gridSteps) * yMax;
        ctx.fillStyle = val === 0 ? '#bbb' : '#777';
        ctx.fillText(val.toFixed(0), pad - 6 * dpr, y + 3.5 * dpr);
    }

    // X axis — time ticks (relative to now)
    ctx.textAlign = 'center';
    const tickCount = Math.min(6, windowFrames);
    for (let i = 0; i <= tickCount; i++) {
        const idx = Math.round((i / tickCount) * (windowFrames - 1));
        const x = pad + idx * xStep;
        const relSec = -(windowFrames - 1 - idx) * exposure;
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 0.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, h - padBottom); ctx.lineTo(x, h - padBottom + 4 * dpr); ctx.stroke();
        ctx.fillStyle = '#666';
        ctx.font = `${7.5 * dpr}px monospace`;
        ctx.fillText(`${relSec}s`, x, h - padBottom + 14 * dpr);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#555';
    ctx.font = `${7.5 * dpr}px monospace`;
    ctx.fillText(`-${(windowFrames - 1) * exposure}s`, pad + 2 * dpr, h - padBottom + 4 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(`0s`, w - pad - 2 * dpr, h - padBottom + 4 * dpr);
}

function _guideRmsWindow() {
    const hist = _guideDriftHistory;
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const windowSec = 60;
    const windowFrames = Math.max(2, Math.ceil(windowSec / exposure));
    return hist.slice(-windowFrames);
}

function _guideUpdateRms() {
    const win = _guideRmsWindow();
    const raSq = win.reduce((a, d) => a + (d.drift_arcsec_x ?? 0) ** 2, 0);
    const decSq = win.reduce((a, d) => a + (d.drift_arcsec_y ?? 0) ** 2, 0);
    const n = win.length;
    const fmt = v => n > 0 ? v.toFixed(2) : '0.00';
    if (_guideRmsRAEl) _guideRmsRAEl.textContent = fmt(Math.sqrt(raSq / n));
    if (_guideRmsDECEl) _guideRmsDECEl.textContent = fmt(Math.sqrt(decSq / n));
    if (_guideRmsTotalEl) _guideRmsTotalEl.textContent = fmt(Math.sqrt((raSq + decSq) / n));
}

async function _guideStop() {
    _guideRunning = false;
    _guideRefSet = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/stop', { method: 'POST' }).catch(() => {});
    addLog('warning', 'guide', i18n('log.guide.stopped'));
    _guideCleanup();
}

async function _guidePause() {
    if (!_guideRunning) return;
    _guideRunning = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/pause', { method: 'POST' }).catch(() => {});
    addLog('info', 'guide', i18n('log.guide.paused'));
    if (_guideStartBtn) _guideStartBtn.disabled = false;
    if (_guideStopBtn) _guideStopBtn.disabled = true;
    if (_guidePauseBtn) _guidePauseBtn.disabled = true;
}

async function _guideReset() {
    _guideRunning = false;
    _guideRefSet = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/reset', { method: 'POST' }).catch(() => {});
    _guideDriftHistory = [];
    _guideUpdateRms();
    _guideDrawDrift();
    _guideCleanup();
    addLog('info', 'guide', i18n('log.guide.reset'));
}

function _guideCleanup() {
    _guideRunning = false;
    if (_guideStartBtn) _guideStartBtn.disabled = false;
    if (_guideStopBtn) _guideStopBtn.disabled = true;
    if (_guidePauseBtn) _guidePauseBtn.disabled = true;
}

// ── Bus ───────────────────────────────────────────────────────

// Consommateur ws:state : rafraîchit la liste des caméras guide.
Bus.on('ws:state', () => _refreshGuideCameraList());

// Consommateur guide:starSelected : l'étoile guide a été choisie dans
// l'aperçu (clic ou sélection auto) — recentre le médaillon zoomé.
Bus.on('guide:starSelected', (env) => {
    const star = env.payload && env.payload.star;
    if (!star) return;
    _guideSelectedStar = star;
    _guideRenderStarMedallion();
});

// Consommateur calibration:done : auto-popule les gains RA/DEC.
Bus.on('calibration:done', (env) => {
    const s = env.payload;
    if (s.x_rate != null && s.x_rate > 0) {
        const raGain = document.getElementById('guide-ra-gain');
        if (raGain) raGain.value = (1 / s.x_rate).toFixed(1);
    }
    if (s.y_rate != null && s.y_rate > 0) {
        const decGain = document.getElementById('guide-dec-gain');
        if (decGain) decGain.value = (1 / s.y_rate).toFixed(1);
    }
});
