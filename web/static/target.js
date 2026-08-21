// ═══════════════════════════════════════════════════════════════
// Noctua — target.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Target centering panel ──────────────────────────────────────

let _nudgeAmount = 1; // arcmin
let _centeringActive = false;
let _centeringMaxSteps = 10;
let _centeringThresholdArcmin = 0.5;
let _centeringWaitingSlew = false;  // la monture est en train de pointer

function initTargetPanel() {
    // Set target from inputs
    const setBtn = document.getElementById('target-set-btn');
    if (setBtn) setBtn.addEventListener('click', targetSetFromInputs);

    // GOTO
    const gotoBtn = document.getElementById('target-goto-btn');
    if (gotoBtn) gotoBtn.addEventListener('click', targetGoto);

    // Nudge amount buttons
    document.querySelectorAll('.nudge-amount-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nudge-amount-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _nudgeAmount = parseInt(btn.dataset.nudge) || 1;
        });
    });

    // Nudge direction buttons
    document.querySelectorAll('.nudge-dir-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dra = parseInt(btn.dataset.dra) * _nudgeAmount;
            const ddec = parseInt(btn.dataset.ddec) * _nudgeAmount;
            targetNudge(dra, ddec);
        });
    });

    // Center button
    const centerBtn = document.getElementById('target-center-btn');
    if (centerBtn) centerBtn.addEventListener('click', targetCenterStart);

    // Stop button
    const stopBtn = document.getElementById('target-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', targetCenterStop);

    // Fill RA/DEC from mount position if available
    _targetAutoFillFromMount();
}

function _targetAutoFillFromMount() {
    const m = findMount();
    const raEl = document.getElementById('target-ra');
    const decEl = document.getElementById('target-dec');
    if (m && m.dev.ra_hours != null && raEl && decEl) {
        raEl.value = decToSexa(m.dev.ra_hours, true);
        decEl.value = decToSexa(m.dev.dec_deg, false);
    }
}

function targetSetFromInputs() {
    const raStr = document.getElementById('target-ra')?.value;
    const decStr = document.getElementById('target-dec')?.value;
    if (!raStr || !decStr) return;

    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'target', i18n('log.target.format_invalid'));
        return;
    }

    const raDeg = raH * 15;
    setOffsetTarget(raDeg, decD);
    addLog('info', 'target', i18nFmt('log.target.defined', { ra: raDeg.toFixed(4), dec: decD.toFixed(4) }));

    // Update offset display if we already have a solve
    updateTargetOffset();
}

function targetGoto() {
    const raStr = document.getElementById('target-ra')?.value;
    const decStr = document.getElementById('target-dec')?.value;
    if (!raStr || !decStr) return;

    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'target', i18n('log.target.format_invalid_short'));
        return;
    }

    apiPost('/api/mount/slew', { ra_hours: raH, dec_deg: decD });
    addLog('info', 'target', i18nFmt('log.target.goto', { ra: raH.toFixed(4), dec: decD.toFixed(4) }));

    // Also set as offset target
    setOffsetTarget(raH * 15, decD);
}

function targetNudge(draArcmin, ddecArcmin) {
    if (_offsetSolvedRA == null || _offsetSolvedDEC == null) {
        addLog('warning', 'target', i18n('log.target.no_solve'));
        return;
    }

    // Convert arcmin delta to RA hours / DEC degrees
    const newRA = _offsetSolvedRA + draArcmin / 60.0;
    const newDEC = _offsetSolvedDEC + ddecArcmin / 60.0;

    const draStr = (draArcmin > 0 ? '+' : '') + draArcmin;
    const ddecStr = (ddecArcmin > 0 ? '+' : '') + ddecArcmin;
    apiPost('/api/mount/slew', { ra_hours: newRA / 15, dec_deg: newDEC });
    addLog('info', 'target', i18nFmt('log.target.nudge', { dra: draStr, ddec: ddecStr }));
}

function updateTargetOffset() {
    if (_offsetTargetRA == null || _offsetSolvedRA == null) return;

    const section = document.getElementById('target-offset-section');
    if (section) section.style.display = '';

    const deltaRA = (_offsetTargetRA - _offsetSolvedRA) * 60; // arcmin
    const deltaDEC = (_offsetTargetDEC - _offsetSolvedDEC) * 60; // arcmin
    const dist = Math.sqrt(deltaRA * deltaRA + deltaDEC * deltaDEC);

    const draEl = document.getElementById('target-dra');
    const ddecEl = document.getElementById('target-ddec');
    const distEl = document.getElementById('target-dist');
    const dirEl = document.getElementById('target-dir');

    if (draEl) {
        draEl.textContent = `${deltaRA > 0 ? '+' : ''}${deltaRA.toFixed(1)}'`;
        draEl.style.color = Math.abs(deltaRA) < _centeringThresholdArcmin ? '#00ff88' : '#00ffcc';
    }
    if (ddecEl) {
        ddecEl.textContent = `${deltaDEC > 0 ? '+' : ''}${deltaDEC.toFixed(1)}'`;
        ddecEl.style.color = Math.abs(deltaDEC) < _centeringThresholdArcmin ? '#00ff88' : '#00ffcc';
    }
    if (distEl) {
        distEl.textContent = dist < 10 ? dist.toFixed(1) + "'" : dist.toFixed(0) + "'";
        distEl.style.color = dist < _centeringThresholdArcmin ? '#00ff88' : dist < 5 ? '#ffcc00' : '#ff5577';
    }

    // Direction (compass bearing)
    if (dirEl) {
        const angle = (Math.atan2(deltaRA, deltaDEC) * 180 / Math.PI + 360) % 360;
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        dirEl.textContent = dirs[Math.round(angle / 22.5) % 16];
    }
}

// ── Centering loop ──────────────────────────────────────────────

function targetCenterStart() {
    if (_centeringActive) return;

    if (_offsetTargetRA == null) {
        addLog('error', 'target', i18n('log.target.define_first'));
        return;
    }

    _centeringActive = true;
    _centeringStepNum = 0;

    const centerBtn = document.getElementById('target-center-btn');
    const stopBtn = document.getElementById('target-stop-btn');
    const statusSection = document.getElementById('target-center-status');
    if (centerBtn) centerBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    if (statusSection) statusSection.style.display = '';

    addLog('info', 'target', i18n('log.target.center_start'));
    _centeringNextStep();
}

function targetCenterStop() {
    _centeringActive = false;
    const centerBtn = document.getElementById('target-center-btn');
    const stopBtn = document.getElementById('target-stop-btn');
    if (centerBtn) centerBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    addLog('info', 'target', i18n('log.target.center_stop'));
}

let _centeringStepNum = 0;

function _centeringNextStep() {
    if (!_centeringActive) return;

    _centeringStepNum++;
    if (_centeringStepNum > _centeringMaxSteps) {
        addLog('warning', 'target', i18nFmt('log.target.center_max', { n: _centeringMaxSteps }));
        targetCenterStop();
        return;
    }

    // Update progress
    const fill = document.getElementById('target-center-fill');
    const text = document.getElementById('target-center-text');
    if (fill) fill.style.width = ((_centeringStepNum / _centeringMaxSteps) * 100) + '%';
    if (text) text.textContent = `Étape ${_centeringStepNum}/${_centeringMaxSteps} — résolution...`;

    // Solve last image
    solverSolve('last_image');
}

function _centeringStep(result) {
    if (!_centeringActive) return;

    if (!result || !result.ok) {
        addLog('error', 'target', i18n('log.target.center_fail'));
        targetCenterStop();
        return;
    }

    updateTargetOffset();

    // Check if close enough
    if (_offsetTargetRA != null && _offsetSolvedRA != null) {
        const deltaRA = (_offsetTargetRA - _offsetSolvedRA) * 60;
        const deltaDEC = (_offsetTargetDEC - _offsetSolvedDEC) * 60;
        const dist = Math.sqrt(deltaRA * deltaRA + deltaDEC * deltaDEC);

        const text = document.getElementById('target-center-text');
        if (text) text.textContent = `Étape ${_centeringStepNum} — offset ${dist.toFixed(1)}'`;

        if (dist < _centeringThresholdArcmin) {
            addLog('info', 'target', i18nFmt('log.target.center_done', { dist: dist.toFixed(2), thr: _centeringThresholdArcmin }));
            targetCenterStop();
            return;
        }

        // Nudge mount toward target
        targetNudge(deltaRA, deltaDEC);

        // Relance la boucle dès que la monture a fini de pointer
        // (événement mount:slewed), avec un filet de sécurité temporel
        // si l'événement est manqué.
        _centeringWaitingSlew = true;
        setTimeout(() => {
            _centeringWaitingSlew = false;
            if (_centeringActive) _centeringNextStep();
        }, 5000);
    }
}

// ── Bus : consommateur solver:result (boucle de centrage) ─────

Bus.on('solver:result', (env) => _centeringStep(env.payload.result));

// Consommateur Hub device:connected : une caméra connectée peut servir de
// source d'image pour la boucle de centrage — on marque la notification.
Hub.subscribe('device:connected', 'target', (env) => {
    window.__hubTargetNotified = (window.__hubTargetNotified || 0) + 1;
});

// ── Bus : consommateur mount:slewed (fin de nudge) ────────────

Bus.on('mount:slewed', () => {
    if (_centeringActive && _centeringWaitingSlew) {
        _centeringWaitingSlew = false;
        _centeringNextStep();
    }
});

