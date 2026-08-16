// ═══════════════════════════════════════════════════════════════
// Noctua — polar.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Polar alignment (3-point method) ────────────────────────────

let _polarSolves = [null, null, null]; // { ra, dec, ha }
let _polarTargets = []; // { ra_hours, dec_deg } for each step
let _polarSiteLat = 43.952;
let _polarMode = 'auto'; // 'auto' | 'manual'
let _polarAutoRunning = false;
let _polarAbortFlag = false;

function _getLstDeg() {
    const now = new Date();
    const jd = (now.getTime() / 86400000) + 2440587.5;
    const t = (jd - 2451545.0) / 36525.0;
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t * t - (t * t * t) / 38710000.0;
    gmst = ((gmst % 360) + 360) % 360;
    const lng = skyEngine ? skyEngine.siteLng : 1.568;
    let lst = (gmst + lng) % 360;
    if (lst < 0) lst += 360;
    return lst;
}

function _polarGetAngleDeg() {
    const el = document.getElementById('polar-angle');
    const val = el ? parseFloat(el.value) : 30;
    return Math.max(5, Math.min(120, val || 30));
}

function _polarComputeTargets() {
    const lst = _getLstDeg();
    const lat = skyEngine ? skyEngine.siteLat : _polarSiteLat;
    const decDeg = 90.0 - lat + 20.0;
    const angleMin = _polarGetAngleDeg();
    const haOffsetDeg = angleMin / 4.0; // 1 min RA = 0.25° HA
    const haOffsets = [0, haOffsetDeg, -haOffsetDeg];
    _polarTargets = haOffsets.map(haOff => {
        const raDeg = ((lst - haOff) % 360 + 360) % 360;
        return { ra_hours: raDeg / 15, dec_deg: decDeg };
    });
    return _polarTargets;
}

function _polarDecToSexa(deg) {
    const sign = deg < 0 ? '-' : '+';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mf = (abs - d) * 60;
    const m = Math.floor(mf);
    const s = Math.floor((mf - m) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${sign}${pad(d)}°${pad(m)}'${pad(s)}"`;
}

function _polarRaToSexa(raDeg) {
    const h = raDeg / 15;
    const hh = Math.floor(h);
    const mf = (h - hh) * 60;
    const mm = Math.floor(mf);
    const ss = Math.floor((mf - mm) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hh)}h${pad(mm)}m${pad(ss)}s`;
}

function initPolarPanel() {
    // Manual capture buttons
    document.querySelectorAll('.polar-capture-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const step = parseInt(btn.dataset.step);
            polarCapture(step);
        });
    });

    // Mode toggle
    document.querySelectorAll('.polar-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _polarMode = btn.dataset.polarMode;
            document.querySelectorAll('.polar-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
            _polarUpdateModeUI();
        });
    });

    // Angle input — recompute targets on change
    const angleEl = document.getElementById('polar-angle');
    if (angleEl) {
        angleEl.addEventListener('change', () => {
            _polarComputeTargets();
            _polarUpdateTargetDisplay();
        });
    }

    // Mount controls
    const trackBtn = document.getElementById('polar-track-btn');
    if (trackBtn) trackBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/mount/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
            addLog('info', 'polar', i18n('log.polar.tracking_on'));
        } catch (e) { addLog('error', 'polar', i18nFmt('log.polar.auto_error', { err: `Tracking: ${e.message}` })); }
    });
    const unparkBtn = document.getElementById('polar-unpark-btn');
    if (unparkBtn) unparkBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/mount/unpark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            addLog('info', 'polar', i18n('log.polar.unparked'));
        } catch (e) { addLog('error', 'polar', i18nFmt('log.polar.auto_error', { err: `Unpark: ${e.message}` })); }
    });
    const abortBtn = document.getElementById('polar-abort-btn');
    if (abortBtn) abortBtn.addEventListener('click', async () => {
        _polarAbortFlag = true;
        try {
            await fetch('/api/mount/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            addLog('warning', 'polar', i18n('log.polar.stop_req'));
        } catch (e) { addLog('error', 'polar', i18nFmt('log.polar.auto_error', { err: `Abort: ${e.message}` })); }
    });

    // Start / Stop auto sequence
    const startBtn = document.getElementById('polar-start-btn');
    if (startBtn) startBtn.addEventListener('click', _polarAutoSequence);
    const stopBtn = document.getElementById('polar-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => { _polarAbortFlag = true; });

    // Recalculate
    const recalcBtn = document.getElementById('polar-recalc-btn');
    if (recalcBtn) recalcBtn.addEventListener('click', polarReset);

    // Reset
    const resetBtn = document.getElementById('polar-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', polarReset);

    // Compute initial targets
    _polarComputeTargets();
    _polarUpdateTargetDisplay();
    _polarUpdateModeUI();
}

function _polarUpdateModeUI() {
    const isManual = _polarMode === 'manual';
    document.querySelectorAll('.polar-manual-only').forEach(el => {
        el.style.display = isManual ? '' : 'none';
    });
    const startBtn = document.getElementById('polar-start-btn');
    if (startBtn) startBtn.style.display = isManual ? 'none' : '';
}

function _polarUpdateTargetDisplay() {
    const angleMin = _polarGetAngleDeg();
    const formatAngle = (m) => {
        if (m >= 60) return `${(m/60).toFixed(1)}h`;
        return `${m}min`;
    };
    // Update step labels
    const label1 = document.getElementById('polar-step1-label');
    const label2 = document.getElementById('polar-step2-label');
    const label3 = document.getElementById('polar-step3-label');
    if (label1) label1.textContent = 'Centre (0h)';
    if (label2) label2.textContent = `+${formatAngle(angleMin)} Est`;
    if (label3) label3.textContent = `-${formatAngle(angleMin)} Ouest`;

    // Update DEC target
    const decEl = document.getElementById('polar-dec-target');
    if (decEl && _polarTargets.length) {
        decEl.textContent = _polarDecToSexa(_polarTargets[0].dec_deg);
    }

    // Update target RA/DEC for each step
    for (let i = 0; i < 3; i++) {
        const t = _polarTargets[i];
        if (!t) continue;
        const raEl = document.getElementById(`polar-s${i+1}-ra`);
        const decEl = document.getElementById(`polar-s${i+1}-dec`);
        if (raEl) raEl.textContent = _polarRaToSexa(t.ra_hours * 15);
        if (decEl) decEl.textContent = _polarDecToSexa(t.dec_deg);
    }
}

async function _polarAutoSequence() {
    if (_polarAutoRunning) return;
    _polarAutoRunning = true;
    _polarAbortFlag = false;

    const startBtn = document.getElementById('polar-start-btn');
    const stopBtn = document.getElementById('polar-stop-btn');
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';

    const progressSection = document.getElementById('polar-progress');
    const progressFill = document.getElementById('polar-progress-fill');
    const progressText = document.getElementById('polar-progress-text');
    if (progressSection) progressSection.style.display = '';

    // Reset any previous solves
    polarReset();
    _polarAutoRunning = true;

    const steps = [
        i18n('polar.goto_center'),
        i18nFmt('polar.cap_solve', { n: 1 }),
        i18n('polar.goto_east'),
        i18nFmt('polar.cap_solve', { n: 2 }),
        i18n('polar.goto_west'),
        i18nFmt('polar.cap_solve', { n: 3 }),
    ];
    const totalSteps = steps.length;

    try {
        // Ensure tracking is on
        addLog('info', 'polar', i18n('log.polar.auto_tracking'));
        await fetch('/api/mount/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });

        for (let i = 0; i < 3; i++) {
            if (_polarAbortFlag) break;

            // Progress: GOTO step
            const gotoIdx = i * 2;
            if (progressFill) progressFill.style.width = `${(gotoIdx / totalSteps) * 100}%`;
            if (progressText) progressText.textContent = steps[gotoIdx];

            await polarCapture(i);
            if (_polarAbortFlag) break;

            // Progress: solve step
            const solveIdx = i * 2 + 1;
            if (progressFill) progressFill.style.width = `${(solveIdx / totalSteps) * 100}%`;
            if (progressText) progressText.textContent = steps[solveIdx];

            if (!_polarSolves[i]) {
                if (progressText) progressText.textContent = i18nFmt('polar.step_failed', { n: i + 1 });
                break;
            }
        }

        if (!_polarAbortFlag && _polarSolves.every(s => s !== null)) {
            if (progressFill) progressFill.style.width = '100%';
            if (progressText) progressText.textContent = i18n('polar.computing');
            polarCompute();
            if (progressText) progressText.textContent = i18n('polar.done');
        } else if (_polarAbortFlag) {
            if (progressText) progressText.textContent = i18n('polar.aborted');
        }
    } catch (e) {
        addLog('error', 'polar', i18nFmt('log.polar.auto_error', { err: e.message }));
        if (progressText) progressText.textContent = `Erreur: ${e.message}`;
    }

    _polarAutoRunning = false;
    if (startBtn) startBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
}

async function polarCapture(step) {
    if (step < 0 || step > 2) return;
    const target = _polarTargets[step];
    if (!target) return;

    const statusEl = document.getElementById(`polar-step${step+1}-status`);
    const stepEl = document.getElementById(`polar-step${step+1}`);
    if (statusEl) statusEl.textContent = '⟳';
    if (stepEl) { stepEl.classList.add('polar-step-active'); stepEl.classList.remove('polar-step-done'); }

    // Slew to target
    addLog('info', 'polar', i18nFmt('log.polar.step_goto', { step: step + 1, ra: target.ra_hours.toFixed(4), dec: target.dec_deg.toFixed(4) }));
    apiPost('/api/mount/slew', { ra_hours: target.ra_hours, dec_deg: target.dec_deg });

    // Wait for mount to settle (poll position)
    const settled = await _polarWaitSettle(30000);
    if (!settled) {
        if (statusEl) statusEl.textContent = '✕';
        if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
        addLog('error', 'polar', i18nFmt('log.polar.step_not_reached', { step: step + 1 }));
        return;
    }

    // Solve
    addLog('info', 'polar', i18nFmt('log.polar.step_solving', { step: step + 1 }));
    try {
        const result = await fetch('/api/solver/solve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'last_image' }),
        }).then(r => r.json());

        if (result.ok) {
            const lst = _getLstDeg();
            const haDeg = (lst - result.ra + 360) % 360;
            _polarSolves[step] = { ra: result.ra, dec: result.dec, ha: haDeg };
            if (statusEl) statusEl.textContent = '✓';
            if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-done'); }
            addLog('info', 'polar', i18nFmt('log.polar.step_solved', { step: step + 1, ra: result.ra.toFixed(4), dec: result.dec.toFixed(4), n: result.matches }));

            // Check if all 3 done
            if (_polarSolves.every(s => s !== null)) {
                polarCompute();
            }
        } else {
            if (statusEl) statusEl.textContent = '✕';
            if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
            addLog('error', 'polar', i18nFmt('log.polar.step_failed', { step: step + 1, err: result.error || i18n('log.solver.failed') }));
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = '✕';
        if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
        addLog('error', 'polar', i18nFmt('log.polar.step_failed', { step: step + 1, err: e.message }));
    }
}

function _polarWaitSettle(timeoutMs) {
    return new Promise(resolve => {
        const start = Date.now();
        let lastRA = null, stableCount = 0;
        const poll = setInterval(async () => {
            try {
                const resp = await fetch('/api/mount');
                const data = await resp.json();
                const ra = data.ra_hours;
                if (lastRA !== null && Math.abs(ra - lastRA) < 0.001) {
                    stableCount++;
                } else {
                    stableCount = 0;
                }
                lastRA = ra;
                if (stableCount >= 3) {
                    clearInterval(poll);
                    resolve(true);
                }
            } catch (e) { /* retry */ }
            if (Date.now() - start > timeoutMs) {
                clearInterval(poll);
                resolve(false);
            }
        }, 500);
    });
}

function polarCompute() {
    // Convert solved positions to unit vectors
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const vecs = _polarSolves.map(s => {
        const ra = toRad(s.ra);
        const dec = toRad(s.dec);
        return [
            Math.cos(dec) * Math.cos(ra),
            Math.cos(dec) * Math.sin(ra),
            Math.sin(dec)
        ];
    });

    // Center of circumscribed circle on sphere
    // = normalize((u1-u2) × (u1-u3))
    const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const cross = (a, b) => [
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0]
    ];
    const norm = v => Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    const normalize = v => { const n = norm(v); return [v[0]/n, v[1]/n, v[2]/n]; };

    let pole = normalize(cross(sub(vecs[0], vecs[1]), sub(vecs[0], vecs[2])));

    // Ensure pole points to the correct hemisphere
    if (pole[2] < 0) pole = pole.map(v => -v);

    // Convert pole back to RA/DEC
    const poleRA = ((toDeg(Math.atan2(pole[1], pole[0])) % 360) + 360) % 360;
    const poleDEC = toDeg(Math.asin(pole[2]));

    // Error from true pole (DEC=+90°)
    const errDec = 90.0 - poleDEC; // positive = pole too low (altitude error)
    // Azimuth error: project offset onto E-W direction at the pole
    // For northern hemisphere: E-W direction at the pole is along RA
    const lat = skyEngine ? skyEngine.siteLat : _polarSiteLat;
    const errAz = errDec * Math.sin(toRad(poleRA)) * Math.cos(toRad(lat));

    // Alternative: use the hour angle of the pole to determine E-W offset
    const lst = _getLstDeg();
    const poleHA = ((lst - poleRA) % 360 + 360) % 360;
    // For small errors, azimuth correction ≈ errDec * sin(HA) * cos(lat)
    // But a simpler approach: the offset direction on the sky
    const errAzSimple = (90 - poleDEC) * Math.cos(toRad(poleRA - 0)); // rough E-W component

    // Total error in arcmin
    const errTotal = Math.sqrt(errDec * errDec + errAz * errAz) * 60;

    // Display
    const errAltEl = document.getElementById('polar-err-alt');
    const errAzEl = document.getElementById('polar-err-az');
    const errTotalEl = document.getElementById('polar-err-total');
    const poleRAEl = document.getElementById('polar-pole-ra');
    const poleDecEl = document.getElementById('polar-pole-dec');
    const arrowAlt = document.getElementById('polar-arrow-alt');
    const arrowAz = document.getElementById('polar-arrow-az');
    const resultsEl = document.getElementById('polar-results');

    if (resultsEl) resultsEl.style.display = '';
    if (errAltEl) {
        const sign = errDec > 0 ? '↑' : '↓';
        errAltEl.textContent = `${errDec > 0 ? '+' : ''}${(errDec * 60).toFixed(1)}'`;
        errAltEl.style.color = Math.abs(errDec * 60) < 2 ? '#00ff88' : '#ffcc00';
    }
    if (arrowAlt) arrowAlt.textContent = errDec > 0 ? '↑ trop bas' : '↓ trop haut';
    if (errAzEl) {
        errAzEl.textContent = `${errAz > 0 ? '+' : ''}${(errAz * 60).toFixed(1)}'`;
        errAzEl.style.color = Math.abs(errAz * 60) < 2 ? '#00ff88' : '#ffcc00';
    }
    if (arrowAz) arrowAz.textContent = errAz > 0 ? '→ droite' : '← gauche';
    if (errTotalEl) {
        errTotalEl.textContent = `${errTotal.toFixed(1)}'`;
        errTotalEl.style.color = errTotal < 2 ? '#00ff88' : errTotal < 10 ? '#ffcc00' : '#ff5577';
    }
    if (poleRAEl) poleRAEl.textContent = _polarRaToSexa(poleRA);
    if (poleDecEl) poleDecEl.textContent = _polarDecToSexa(poleDEC);

    // Draw correction diagram
    _polarDrawDiagram(errDec * 60, errAz * 60);

    addLog('info', 'polar', i18nFmt('log.polar.pole_found', { ra: poleRA.toFixed(4), dec: poleDEC.toFixed(4), total: errTotal.toFixed(1) }));
}

function _polarDrawDiagram(errAltArcmin, errAzArcmin) {
    const canvas = document.getElementById('polar-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    // Scale: 1 arcmin = 2px, max ±60' → ±120px
    const scale = 2;
    const maxErr = Math.max(Math.abs(errAltArcmin), Math.abs(errAzArcmin), 10);

    // Draw crosshairs (true pole)
    ctx.strokeStyle = 'rgba(0,255,204,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // True pole label
    ctx.fillStyle = 'rgba(0,255,204,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(i18n('polar.pole_true'), cx, 10);

    // Draw found pole offset
    // errAltArcmin: positive = pole too low (south)
    // errAzArcmin: positive = pole too far east
    const dx = errAzArcmin * scale; // E-W
    const dy = -errAltArcmin * scale; // N-S (canvas Y inverted)

    const poleX = cx + dx;
    const poleY = cy + dy;

    // Line from true to found
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(poleX, poleY);
    ctx.stroke();

    // Arrow head
    const angle = Math.atan2(poleY - cy, poleX - cx);
    const arrowLen = 10;
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.moveTo(poleX, poleY);
    ctx.lineTo(poleX - arrowLen * Math.cos(angle - 0.4), poleY - arrowLen * Math.sin(angle - 0.4));
    ctx.lineTo(poleX - arrowLen * Math.cos(angle + 0.4), poleY - arrowLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();

    // Found pole dot
    ctx.fillStyle = '#ff5577';
    ctx.beginPath();
    ctx.arc(poleX, poleY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Correction arrows (what the user should do)
    // To correct: move pole UP by errAlt, move pole LEFT by errAz
    const corrAlt = -errAltArcmin * scale; // correction direction
    const corrAz = -errAzArcmin * scale;

    if (Math.abs(corrAlt) > 3) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(poleX, poleY);
        ctx.lineTo(poleX, poleY + corrAlt);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#00ff88';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('↑ Alt', poleX + 6, poleY + corrAlt / 2);
    }
    if (Math.abs(corrAz) > 3) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(poleX, poleY);
        ctx.lineTo(poleX + corrAz, poleY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#00ff88';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Az →', poleX + corrAz / 2, poleY - 8);
    }

    // Scale bar
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(30)}'`, 4, h - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, h - 14);
    ctx.lineTo(4 + 30 * scale, h - 14);
    ctx.stroke();
}

function polarReset() {
    _polarSolves = [null, null, null];
    _polarAbortFlag = false;
    for (let i = 1; i <= 3; i++) {
        const statusEl = document.getElementById(`polar-step${i}-status`);
        const stepEl = document.getElementById(`polar-step${i}`);
        if (statusEl) statusEl.textContent = '◻';
        if (stepEl) {
            stepEl.classList.remove('polar-step-done', 'polar-step-active', 'polar-step-fail');
        }
    }
    const resultsEl = document.getElementById('polar-results');
    if (resultsEl) resultsEl.style.display = 'none';
    const progressSection = document.getElementById('polar-progress');
    const progressFill = document.getElementById('polar-progress-fill');
    const progressText = document.getElementById('polar-progress-text');
    if (progressSection) progressSection.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = i18n('polar.ready');
    _polarComputeTargets();
    _polarUpdateTargetDisplay();
    addLog('info', 'polar', i18n('log.polar.reset'));
}
