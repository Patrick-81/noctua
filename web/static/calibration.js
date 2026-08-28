// ═══════════════════════════════════════════════════════════════
// Noctua — calibration.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Calibration monture ─────────────────────────────────────

let _calRunning = false;
let _calibrated = false;
let _calStartBtn = null, _calStopBtn = null;
let _calGraphCanvas = null;
let _calPhaseEl = null, _calStepCountEl = null, _calQualityEl = null;
let _calResultsEl = null;
let _calXRatesEl = null, _calYRateEl = null, _calOrthoEl = null, _calBadgeEl = null;
let _calTimer = null;
let _calLastStatus = null;

function initCalibrationPanel() {
    _calStartBtn = document.getElementById('cal-start-btn');
    _calStopBtn = document.getElementById('cal-stop-btn');
    _calGraphCanvas = document.getElementById('cal-graph-canvas');
    _calPhaseEl = document.getElementById('cal-phase');
    _calStepCountEl = document.getElementById('cal-step-count');
    _calQualityEl = document.getElementById('cal-quality');
    _calResultsEl = document.getElementById('cal-results');
    _calXRatesEl = document.getElementById('cal-x-rate');
    _calYRateEl = document.getElementById('cal-y-rate');
    _calOrthoEl = document.getElementById('cal-ortho');
    _calBadgeEl = document.getElementById('cal-badge');

    if (_calStartBtn) _calStartBtn.addEventListener('click', _calibrateStart);
    if (_calStopBtn) _calStopBtn.addEventListener('click', _calibrateStop);

    // Refresh button
    const calRefresh = document.getElementById('cal-refresh-btn');
    if (calRefresh) {
        calRefresh.addEventListener('click', () => {
            const tabGraph = document.getElementById('cal-tab-graph');
            const isGraph = tabGraph?.classList.contains('cal-tab-active');
            if (isGraph) {
                _calibrateDrawGraph(_calLastStatus);
            } else {
                _calDrawCalCrosshair();
            }
        });
    }

    // Tab switching: Graphe / Cible
    const tabGraph = document.getElementById('cal-tab-graph');
    const tabCross = document.getElementById('cal-tab-crosshair');
    const crossCanvas = document.getElementById('cal-crosshair-canvas');
    if (tabGraph && tabCross && crossCanvas) {
        tabGraph.addEventListener('click', () => {
            tabGraph.classList.add('cal-tab-active');
            tabCross.classList.remove('cal-tab-active');
            _calGraphCanvas.style.display = '';
            crossCanvas.style.display = 'none';
            _calibrateDrawGraph(_calLastStatus);
        });
        tabCross.addEventListener('click', () => {
            tabCross.classList.add('cal-tab-active');
            tabGraph.classList.remove('cal-tab-active');
            _calGraphCanvas.style.display = 'none';
            crossCanvas.style.display = '';
            _calDrawCalCrosshair();
        });
    }
}

function _calDrawCalCrosshair() {
    const canvas = document.getElementById('cal-crosshair-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const hist = _guideDriftHistory;
    if (hist.length < 1) {
        ctx.fillStyle = '#555';
        ctx.font = `${11 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(i18n('cal.waiting_data'), w / 2, h / 2);
        return;
    }

    const pad = 48;
    const plotW = w - 2 * pad;
    const plotH = h - 2 * pad;
    const midX = pad + plotW / 2;
    const midY = pad + plotH / 2;
    const half = Math.max(5, parseFloat(document.getElementById('guide-tolerance')?.value || '10'));
    const maxR = Math.min(plotW, plotH) / 2 - 4 * dpr;
    const scale = maxR / half;

    // Tolerance zones
    const tolR = half * scale, safeR = tolR / 2;
    const gradOrg = ctx.createRadialGradient(midX, midY, safeR, midX, midY, tolR);
    gradOrg.addColorStop(0, 'rgba(255,165,0,0.0)');
    gradOrg.addColorStop(1, 'rgba(255,165,0,0.12)');
    ctx.fillStyle = gradOrg;
    ctx.beginPath(); ctx.arc(midX, midY, tolR, 0, Math.PI * 2); ctx.fill();
    const gradGrn = ctx.createRadialGradient(midX, midY, 0, midX, midY, safeR);
    gradGrn.addColorStop(0, 'rgba(0,255,100,0.08)');
    gradGrn.addColorStop(1, 'rgba(0,255,100,0.15)');
    ctx.fillStyle = gradGrn;
    ctx.beginPath(); ctx.arc(midX, midY, safeR, 0, Math.PI * 2); ctx.fill();

    // Concentric rings
    for (let r = 1; r <= 4; r++) {
        const radius = (tolR * r) / 4;
        const isB = r % 2 === 0;
        ctx.strokeStyle = isB ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.10)';
        ctx.lineWidth = isB ? 1.5 * dpr : 0.5 * dpr;
        ctx.setLineDash(isB ? [] : [3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.arc(midX, midY, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Crosshair lines
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(pad + plotW, midY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, pad); ctx.lineTo(midX, pad + plotH); ctx.stroke();

    // Data trail
    for (let i = 0; i < hist.length; i++) {
        const d = hist[i];
        const px = midX + (d.drift_arcsec_x || 0) * scale;
        const py = midY - (d.drift_arcsec_y || 0) * scale;
        const alpha = 0.15 + 0.85 * (i / hist.length);
        const radius = i === hist.length - 1 ? 5 * dpr : 2.5 * dpr;
        ctx.fillStyle = i === hist.length - 1 ? '#ffffff' : `rgba(180,200,255,${alpha * 0.6})`;
        ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
    }

    // Current crosshair
    if (hist.length > 0) {
        const last = hist[hist.length - 1];
        const cx = midX + (last.drift_arcsec_x || 0) * scale;
        const cy = midY - (last.drift_arcsec_y || 0) * scale;
        ctx.strokeStyle = cssVar('--accent');
        ctx.lineWidth = 2.5 * dpr;
        const ch = 10 * dpr;
        ctx.beginPath(); ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch); ctx.stroke();
        ctx.fillStyle = cssVar('--accent');
        ctx.beginPath(); ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2); ctx.fill();
        // Readout
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${11 * dpr}px monospace`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`RA: ${(last.drift_arcsec_x || 0).toFixed(2)}″`, w - pad, h - pad);
        ctx.fillText(`DEC: ${(last.drift_arcsec_y || 0).toFixed(2)}″`, w - pad, h - pad + 14 * dpr);
    }
}

async function _calibrateStart() {
    if (_calRunning) return;
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('error', 'calibration', i18n('log.calibration.select_camera')); return; }

    // Reset calibration state machine
    await fetch('/api/guide/calibrate/reset', { method: 'POST' }).catch(() => {});

    // Need a guide star — take a quick exposure to get centroid
    addLog('info', 'calibration', i18n('log.calibration.preview'));
    await fetch('/api/camera/expose', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device: cam, duration: 1.0})
    }).then(r => r.json()).catch(() => {});
    await sleep(2000);

    const metric = await fetch('/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : ''))
        .then(r => r.json()).catch(() => null);
    if (!metric?.ok || !metric.stars?.length) {
        addLog('error', 'calibration', i18n('log.calibration.no_star'));
        return;
    }

    const pulseMs = parseInt(document.getElementById('cal-pulse-ms')?.value || '500');
    const res = await fetch('/api/guide/calibrate/start', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({step_ms: pulseMs, target_px: 25})
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'calibration', res?.error || i18n('log.calibration.start_failed'));
        return;
    }

    // Set true origin from the pre-calibration star position
    await fetch('/api/guide/calibrate/set-origin', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({x: metric.stars[0].x, y: metric.stars[0].y})
    }).catch(() => {});

    _calRunning = true;
    if (_calStartBtn) _calStartBtn.disabled = true;
    if (_calStopBtn) _calStopBtn.disabled = false;
    if (_calResultsEl) _calResultsEl.style.display = 'none';
    const wrap = document.getElementById('cal-status-wrap');
    if (wrap) wrap.style.display = '';
    addLog('info', 'calibration', i18n('log.calibration.start'));
    _calibrateLoop();
}

async function _calibrateLoop() {
    if (!_calRunning) return;
    const status = await fetch('/api/guide/calibrate/status', {method: 'GET'})
        .then(r => r.json()).catch(() => null);
    if (!status?.ok) { _calibrateAbort('Erreur statut'); return; }

    const dir = status.next_direction;
    const stepMs = status.step_ms || 500;
    const cam = _guideCameraSelect?.value || '';

    if (_calPhaseEl) {
        const phaseNames = {W:'→ WEST', E:'← EAST', N:'↑ NORTH', S:'↓ SOUTH'};
        _calPhaseEl.textContent = `Phase: ${phaseNames[dir] || dir}`;
    }
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${status.step_count}`;
    _calibrateDrawGraph(status);

    // Mount pulse
    const mountDir = {W:'WEST', E:'EAST', N:'NORTH', S:'SOUTH'}[dir];
    if (mountDir) {
        await fetch('/api/mount/move', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({direction: mountDir, rate: 'Guide'})
        }).then(r => r.json()).catch(() => {});
        await sleep(stepMs);
        await fetch('/api/mount/halt', {method: 'POST'}).catch(() => {});
    }

    // Expose guide camera
    await fetch('/api/camera/expose', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device: cam, duration: 0.5})
    }).then(r => r.json()).catch(() => {});
    await sleep(1500);

    // Get centroid — retry a few times to absorb transient image-delivery failures
    let metric = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        metric = await fetch('/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : ''))
            .then(r => r.json()).catch(() => null);
        if (metric?.ok && metric.stars?.length) break;
        addLog('warning', 'calibration',
            i18nFmt('log.calibration.started_retry', { attempt: attempt + 1, max: 3 }));
        await sleep(800);
    }

    if (!metric?.ok || !metric.stars?.length) {
        _calibrateAbort(i18n('log.calibration.star_lost'));
        return;
    }
    const star = metric.stars[0];

    // Record step
    const stepRes = await fetch('/api/guide/calibrate/step', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({direction: dir, x: star.x, y: star.y, pulse_ms: stepMs})
    }).then(r => r.json()).catch(() => null);

    if (!stepRes?.ok) { _calibrateAbort(stepRes?.error || 'Erreur step'); return; }

    // Update UI
    if (_calPhaseEl) {
        const phaseNames = {W:'→ WEST', E:'← EAST', N:'↑ NORTH', S:'↓ SOUTH'};
        _calPhaseEl.textContent = `Phase: ${phaseNames[stepRes.next_direction] || stepRes.next_direction}`;
    }
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${stepRes.step_count}`;
    _calibrateDrawGraph(stepRes);

    // Check completion / failure
    if (stepRes.state === 'complete') {
        _calibrateDone(stepRes);
        return;
    }
    if (stepRes.state === 'failed') {
        _calibrateAbort(stepRes.error || 'Échec calibration');
        return;
    }

    if (_calRunning) {
        _calTimer = setTimeout(() => _calibrateLoop(), 50);
    }
}

function _calibrateDrawGraph(status) {
    if (status) _calLastStatus = status;
    const canvas = _calGraphCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const steps = status.steps || [];
    const west = steps.filter(s => s.direction === 'W');
    const east = steps.filter(s => s.direction === 'E');
    const north = steps.filter(s => s.direction === 'N');
    const south = steps.filter(s => s.direction === 'S');

    if (steps.length < 1) {
        ctx.fillStyle = '#555';
        ctx.font = `${11 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('En attente...', w / 2, h / 2);
        return;
    }

    const pad = 44;
    const plotW = w - 2 * pad;
    const plotH = h - 2 * pad;
    const midX = pad + plotW / 2;
    const midY = pad + plotH / 2;

    // Data bounds — use a fixed minimum range so points don't jump
    const allX = steps.map(s => s.dx);
    const allY = steps.map(s => s.dy);
    const targetPx = status.target_px || 25;
    const maxAbs = Math.max(1, ...allX.map(Math.abs), ...allY.map(Math.abs));
    const range = Math.max(maxAbs * 1.3, targetPx * 2);
    const scale = Math.min(plotW, plotH) / (2 * range);

    // Grid with graduation labels
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        const frac = i / 4;
        const val = (frac * range).toFixed(0);
        const x = midX + frac * range * scale;
        const y = midY - frac * range * scale;
        ctx.strokeStyle = '#2a2a3e';
        ctx.lineWidth = 0.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, pad + plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + plotW, y); ctx.stroke();
        // X tick label
        ctx.fillStyle = '#555';
        ctx.fillText(val, x, pad + plotH + 2 * dpr);
        // Y tick label
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(val, pad - 4 * dpr, y);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
    }

    // Zero cross
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(pad + plotW, midY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, pad); ctx.lineTo(midX, pad + plotH); ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('0', pad - 4 * dpr, midY + 3 * dpr);

    // Axis labels
    const labelStyle = '#777';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = labelStyle;
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillText('W ← dx (px) → E', w / 2, pad + plotH + 14 * dpr);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('S ← dy (px) → N', pad - 2 * dpr, h / 2);

    // Helper: draw step series
    function drawSteps(series, color, label, showLabels) {
        if (series.length < 1) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * dpr;
        if (series.length >= 2) {
            ctx.beginPath();
            for (let i = 0; i < series.length; i++) {
                const x = midX + series[i].dx * scale;
                const y = midY - series[i].dy * scale;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        for (let i = 0; i < series.length; i++) {
            const x = midX + series[i].dx * scale;
            const y = midY - series[i].dy * scale;
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
            if (showLabels) {
                ctx.fillStyle = '#aaa';
                ctx.font = `${7 * dpr}px monospace`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.fillText((i + 1).toString(), x + 4 * dpr, y - 2 * dpr);
            }
        }
        // Legend entry
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        const lx = pad + 2 * dpr;
        const ly = pad + 2 * dpr + ([cssVar('--status-online'),'#4488ff'].indexOf(color) * 12 * dpr);
        ctx.fillRect(lx, ly, 70 * dpr, 10 * dpr);
        ctx.fillStyle = color;
        ctx.font = `${8 * dpr}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('●', lx + 2 * dpr, ly + 1 * dpr);
        ctx.fillStyle = '#ccc';
        ctx.fillText(label, lx + 14 * dpr, ly + 1 * dpr);
    }

    drawSteps(west, cssVar('--status-online'), 'WEST (RA)', true);
    drawSteps(east, cssVar('--status-online'), 'EAST (RA)', false);
    drawSteps(north, '#4488ff', 'NORTH (DEC)', true);
    drawSteps(south, '#4488ff', 'SOUTH (DEC)', false);
}

function _calibrateDone(status) {
    _calRunning = false;
    _calibrated = true;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;

    if (_calPhaseEl) _calPhaseEl.textContent = i18n('cal.phase_done');
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${status.step_count}`;

    // Results
    if (_calResultsEl) _calResultsEl.style.display = '';
    if (_calXRatesEl) _calXRatesEl.textContent = status.x_rate != null ? status.x_rate.toFixed(6) : '—';
    if (_calYRateEl) _calYRateEl.textContent = status.y_rate != null ? status.y_rate.toFixed(6) : '—';
    if (_calOrthoEl) _calOrthoEl.textContent = status.orthogonality != null ? status.orthogonality.toFixed(1) : '—';

    const qColors = {good: '#4a4', acceptable: '#fa0', poor: '#f44', insufficient_data: '#888'};
    if (_calBadgeEl) {
        _calBadgeEl.textContent = status.quality || '—';
        _calBadgeEl.style.color = qColors[status.quality] || '#888';
    }
    if (_calQualityEl) {
        const flaws = status.quality_flaws || [];
        _calQualityEl.textContent = flaws.length ? flaws.join(' ') : '';
    }

    // Auto-populate guide gains from calibration results (consommateur guide.js)
    // + confirmation popup (consommateur app.js) : émission via le Hub ci-dessous.

    _calibrateDrawGraph(status);
    addLog('info', 'calibration', i18nFmt('log.calibration.done', { q: status.quality }));

    Hub.emit('calibration:done', {
        quality: status.quality,
        x_rate: status.x_rate,
        y_rate: status.y_rate,
        step_count: status.step_count,
        orthogonality: status.orthogonality,
        quality_flaws: status.quality_flaws,
    }, { source: 'calibration' });
}

function _calibrateAbort(msg) {
    _calRunning = false;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;
    fetch('/api/guide/calibrate/stop', {method: 'POST'}).catch(() => {});
    if (_calPhaseEl) _calPhaseEl.textContent = 'Phase: ❌ ' + msg;
    addLog('error', 'calibration', msg);
}

async function _calibrateStop() {
    if (!_calRunning) return;
    _calRunning = false;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    await fetch('/api/guide/calibrate/stop', {method: 'POST'}).catch(() => {});
    if (_calPhaseEl) _calPhaseEl.textContent = i18n('cal.phase_stopped');
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;
    addLog('warning', 'calibration', i18n('log.calibration.stopped'));
}
