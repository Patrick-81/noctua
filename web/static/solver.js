// ═══════════════════════════════════════════════════════════════
// Noctua — solver.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Plate Solver panel ──────────────────────────────────────────

let _solverMode = 'hinted';
let _solverStatus = null;

function initSolverPanel() {
    // Mode buttons
    document.querySelectorAll('.solver-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.solver-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _solverMode = btn.dataset.solverMode;
            const hintedParams = document.getElementById('solver-hinted-params');
            const blindParams = document.getElementById('solver-blind-params');
            if (hintedParams) hintedParams.style.display = _solverMode === 'hinted' ? '' : 'none';
            if (blindParams) blindParams.style.display = _solverMode === 'blind' ? '' : 'none';
        });
    });

    // Auto hint checkbox
    const autoHint = document.getElementById('solver-auto-hint');
    const manualHints = document.getElementById('solver-manual-hints');
    if (autoHint && manualHints) {
        autoHint.addEventListener('change', () => {
            manualHints.style.display = autoHint.checked ? 'none' : '';
        });
    }

    // Solve button
    const solveBtn = document.getElementById('solver-solve-btn');
    if (solveBtn) {
        solveBtn.addEventListener('click', () => solverSolve('last_image'));
    }

    // Sync mount button
    const syncBtn = document.getElementById('solver-sync-btn');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const res = _lastSolverResult;
            if (res && res.ok) {
                apiPost('/api/mount/slew', { ra_hours: res.ra / 15, dec_deg: res.dec });
                addLog('info', 'solver', i18nFmt('log.solver.sync', { ra: res.ra.toFixed(4), dec: res.dec.toFixed(4) }));
            }
        });
    }

    // Center sky map button
    const centerBtn = document.getElementById('solver-center-btn');
    if (centerBtn) {
        centerBtn.addEventListener('click', () => {
            const res = _lastSolverResult;
            if (res && res.ok && skyEngine) {
                skyEngine.centerOnObject(res.ra, res.dec);
                addLog('info', 'solver', i18nFmt('log.solver.centered', { ra: res.ra.toFixed(2), dec: res.dec.toFixed(2) }));
            }
        });
    }

    // Test images button
    const testBtn = document.getElementById('solver-test-btn');
    const testDropdown = document.getElementById('solver-test-dropdown');
    const testList = document.getElementById('solver-test-list');
    if (testBtn && testDropdown && testList) {
        testBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const visible = testDropdown.style.display !== 'none';
            testDropdown.style.display = visible ? 'none' : '';
            if (!visible && testList.children.length === 0) {
                testList.innerHTML = '<div style="color:#666; font-size:0.6rem;">Chargement...</div>';
                const images = await loadTestImageList();
                testList.innerHTML = '';
                if (!images.length) {
                    testList.innerHTML = `<div style="color:#666; font-size:0.6rem;">${i18n('solver.no_image_fake')}</div>`;
                    return;
                }
                for (const img of images) {
                    const item = document.createElement('div');
                    item.className = 'solver-test-item';
                    item.innerHTML = `<span class="test-name">${img.name}</span><span class="test-meta">RA=${img.ra?.toFixed(1)}° DEC=${img.dec?.toFixed(1)}° ${img.scale}"</span>`;
                    item.addEventListener('click', () => {
                        loadTestFITS(img.file);
                        testDropdown.style.display = 'none';
                    });
                    testList.appendChild(item);
                }
            }
        });
    }

    // Load solver status
    refreshSolverStatus();
}

let _lastSolverResult = null;

async function refreshSolverStatus(retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await fetch('/api/solver/status');
            const status = await resp.json();
            _solverStatus = status;
            const led = document.getElementById('solver-led');
            const text = document.getElementById('solver-status-text');
            const solveBtn = document.getElementById('solver-solve-btn');

            if (status.available && status.catalogs_loaded) {
                if (led) led.className = 'solver-led solver-led-ok';
                if (text) text.textContent = i18n('solver.ready') + (status.has_blind_index ? ' (blind OK)' : '');
                if (solveBtn) solveBtn.disabled = false;
                return;
            } else if (status.available) {
                if (led) led.className = 'solver-led solver-led-warn';
                if (text) text.textContent = i18n('solver.catalogs_not_loaded');
                if (solveBtn) solveBtn.disabled = true;
                return;
            } else {
                if (led) led.className = 'solver-led solver-led-error';
                if (text) text.textContent = i18n('solver.seiza_not_installed');
                if (solveBtn) solveBtn.disabled = true;
                return;
            }
        } catch (e) {
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            const led = document.getElementById('solver-led');
            const text = document.getElementById('solver-status-text');
            if (led) led.className = 'solver-led solver-led-error';
            if (text) text.textContent = 'Erreur status';
        }
    }
}

function updateSolverHints() {
    const m = findMount();
    const cam = findCamera();
    const raEl = document.getElementById('solver-ra-hint');
    const decEl = document.getElementById('solver-dec-hint');
    const scaleEl = document.getElementById('solver-scale-hint');

    if (m && m.dev.ra_hours != null) {
        const raDeg = m.dev.ra_hours * 15;
        if (raEl) raEl.textContent = decToSexa(raDeg / 15, true);
        if (decEl) decEl.textContent = decToSexa(m.dev.dec_deg, false);
    } else {
        if (raEl) raEl.textContent = '--';
        if (decEl) decEl.textContent = '--';
    }

    if (cam && cam.dev.pixel_size_um && cam.dev.focal_length_mm) {
        const bx = cam.dev.binning_x || 1;
        const scale = (cam.dev.pixel_size_um / 1000) / (cam.dev.focal_length_mm / 1000) * 206.265 / bx;
        if (scaleEl) scaleEl.textContent = scale.toFixed(2) + ' arcsec/px';
    } else {
        if (scaleEl) scaleEl.textContent = '-- arcsec/px';
    }
}

async function solverSolve(mode) {
    const solveBtn = document.getElementById('solver-solve-btn');
    const progress = document.getElementById('solver-progress');
    const progressFill = document.getElementById('solver-progress-fill');
    const progressText = document.getElementById('solver-progress-text');
    const resultsEl = document.getElementById('solver-results');
    const errorEl = document.getElementById('solver-error');

    if (solveBtn) solveBtn.disabled = true;
    if (progress) progress.style.display = '';
    if (resultsEl) resultsEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';

    // Animate progress bar
    let pct = 0;
    const progressInterval = setInterval(() => {
        pct = Math.min(95, pct + 1);
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) {
            const elapsed = (pct / 100) * (_solverMode === 'blind' ? 30 : 3);
            progressText.textContent = `Résolution en cours... ${elapsed.toFixed(1)}s`;
        }
    }, _solverMode === 'blind' ? 300 : 30);

    // Build request body
    const body = { mode };

    if (_solverMode === 'hinted') {
        const autoHint = document.getElementById('solver-auto-hint');
        if (autoHint && autoHint.checked) {
            // Auto: server will use mount + camera
            body.mode = 'last_image';
        } else {
            // Manual hints
            const ra = parseFloat(document.getElementById('solver-ra-manual')?.value);
            const dec = parseFloat(document.getElementById('solver-dec-manual')?.value);
            const scale = parseFloat(document.getElementById('solver-scale-manual')?.value);
            if (!isNaN(ra)) body.ra_hint = ra;
            if (!isNaN(dec)) body.dec_hint = dec;
            if (!isNaN(scale)) body.scale_hint = scale;
        }
    } else {
        body.min_scale = parseFloat(document.getElementById('solver-min-scale')?.value || '0.5');
        body.max_scale = parseFloat(document.getElementById('solver-max-scale')?.value || '15.0');
    }

    try {
        const result = await fetch('/api/solver/solve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());

        clearInterval(progressInterval);

        if (result.ok) {
            _lastSolverResult = result;
            renderSolverResult(result);
            setOffsetSolved(result.ra, result.dec, result.scale, result.rotation);
        } else {
            if (errorEl) {
                errorEl.style.display = '';
                errorEl.textContent = result.error || i18n('solver.failed_default');
            }
            addLog('error', 'solver', result.error || i18n('log.solver.failed'));
        }
    } catch (e) {
        clearInterval(progressInterval);
        if (errorEl) {
            errorEl.style.display = '';
            errorEl.textContent = e.message;
        }
        addLog('error', 'solver', i18nFmt('log.ws.error', { err: e.message }));
    } finally {
        if (progress) progress.style.display = 'none';
        if (solveBtn) solveBtn.disabled = false;
    }
}

function renderSolverResult(result) {
    const resultsEl = document.getElementById('solver-results');
    if (resultsEl) resultsEl.style.display = '';

    const raDeg = result.ra;
    const decDeg = result.dec;

    const el = (id, val) => {
        const e = document.getElementById(id);
        if (e) e.textContent = val;
    };

    el('solver-res-ra', decToSexa(raDeg / 15, true));
    el('solver-res-dec', decToSexa(decDeg, false));
    el('solver-res-scale', result.scale.toFixed(2) + ' arcsec/px');
    el('solver-res-rotation', result.rotation.toFixed(1) + '°' + (result.flipped ? ' (mirrored)' : ''));
    el('solver-res-matches', `${result.matches} / ${result.stars_detected} détectées`);
    el('solver-res-rms', result.rms.toFixed(2) + '"');

    // Calculate FoV
    const cam = findCamera();
    if (cam && cam.dev.width_px && cam.dev.height_px) {
        const fovX = (cam.dev.width_px * result.scale / 3600).toFixed(2);
        const fovY = (cam.dev.height_px * result.scale / 3600).toFixed(2);
        el('solver-res-fov', `${fovX}° × ${fovY}°`);
    } else {
        el('solver-res-fov', '--');
    }

    el('solver-res-mode', result.mode === 'hinted' ? 'Indice' : 'Blind');
    el('solver-res-time', result.elapsed_ms < 1000 ? result.elapsed_ms.toFixed(0) + 'ms' : (result.elapsed_ms / 1000).toFixed(1) + 's');

    addLog('info', 'solver', i18nFmt('log.solver.solved', { ra: raDeg.toFixed(4), dec: decDeg.toFixed(4), n: result.matches, rms: result.rms.toFixed(2) }));
}

function handleSolverWsResult(result) {
    _lastSolverResult = result;
    renderSolverResult(result);
    if (result.ok) {
        setOffsetSolved(result.ra, result.dec, result.scale, result.rotation);
        updateTargetOffset();
    }
}

// ── Hub ───────────────────────────────────────────────────────

// Consommateur solver:result (produit par le traducteur ws.js).
Hub.subscribe('solver:result', 'solver', (env) => handleSolverWsResult(env.payload.result));

// Consommateur ws:state : rafraîchit les indices RA/DEC/scale.
Hub.subscribe('ws:state', 'solver', () => updateSolverHints());

// Consommateur mode:changed : recharge le statut solver à l'entrée en astrométrie.
Hub.subscribe('mode:changed', 'solver', (env) => {
    if (env.payload.mode === 'astrometry') refreshSolverStatus(1);
});
