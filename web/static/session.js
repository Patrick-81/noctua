// ═══════════════════════════════════════════════════════════════
// Noctua — session.js (module classique, bindings lexicaux globaux)
// Orchestrateur de session d'imagerie : surveille le méridien et
// exécute le flip complet (arrêt guidage → pause capture → flip →
// attente slew → recentrage → reprise).
// Dépendances globales : Hub, _guideStart/_guideStop
// (guide.js), seqCall/seqPollStatus (sequence.js), stkStart (stacking.js),
// solverSolve/_solverStatus (solver.js), apiPost/addLog (api.js).
// ═══════════════════════════════════════════════════════════════

let _sessionActive = false;
let _sessionAutoFlip = false;
let _sessionFlipRunning = false;
let _sessionTimer = null;
let _sessionPhase = 'idle';
let _sessionStatusText = '';
let _sessionRecenterCfg = true;

const SESSION_PHASE_KEYS = {
    idle:      'session.status_idle',
    monitor:   'session.status_monitor',
    stopping:  'session.status_stopping',
    flipping:  'session.status_flipping',
    slew:      'session.status_slew',
    recenter:  'session.status_recenter',
    resuming:  'session.status_resuming',
    done:      'session.status_done',
    error:     'session.status_error',
};

function initSessionPanel() {
    const activeEl = document.getElementById('session-active');
    const autoEl = document.getElementById('session-auto-flip');
    const flipBtn = document.getElementById('session-flip-btn');

    if (activeEl) activeEl.addEventListener('change', () => sessionSetActive(activeEl.checked));
    if (autoEl) autoEl.addEventListener('change', () => sessionSetAutoFlip(autoEl.checked));
    if (flipBtn) flipBtn.addEventListener('click', () => sessionFlip('manual'));

    // Charge la config flip (auto + recenter) depuis le serveur
    fetch('/api/config').then(r => r.json()).then(cfg => {
        const tel = cfg.telescope || {};
        _sessionAutoFlip = !!tel.flip_enabled;
        if (autoEl) autoEl.checked = _sessionAutoFlip;
        _sessionRecenterCfg = !!tel.recenter_after_flip;
        if (_sessionActive && !_sessionTimer) _sessionStartMonitor();
    }).catch(() => {});
}

function sessionSetActive(on) {
    _sessionActive = !!on;
    if (on) {
        _sessionStartMonitor();
        addLog('info', 'session', i18n('log.session.monitor_on'));
    } else {
        _sessionStopMonitor();
        _sessionSetStatus('idle');
        addLog('info', 'session', i18n('log.session.monitor_off'));
    }
}

function sessionSetAutoFlip(on) {
    _sessionAutoFlip = !!on;
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telescope: { flip_enabled: _sessionAutoFlip } }),
    }).catch(() => {});
    addLog('info', 'session', i18n(_sessionAutoFlip ? 'log.session.auto_flip_on' : 'log.session.auto_flip_off'));
}

function _sessionStartMonitor() {
    if (_sessionTimer) return;
    _sessionTimer = setInterval(_sessionMonitorTick, 5000);
    _sessionMonitorTick();
}

function _sessionStopMonitor() {
    if (_sessionTimer) { clearInterval(_sessionTimer); _sessionTimer = null; }
}

async function _sessionMonitorTick() {
    if (_sessionFlipRunning) return;
    let st = null;
    try {
        st = await fetch('/api/mount/flip/status').then(r => r.json());
    } catch (e) { return; }
    if (!st || st.flip_due === undefined) return;

    if (st.flip_due) {
        _sessionSetStatus('monitor', i18nFmt('session.phase.flip_due', { ha: st.ha_fmt || '---' }));
        if (_sessionAutoFlip) sessionFlip('auto');
    } else {
        _sessionSetStatus('monitor');
    }
}

function _sessionSetStatus(phase, text) {
    _sessionPhase = phase;
    _sessionStatusText = text || i18n(SESSION_PHASE_KEYS[phase] || 'session.status_idle');
    const el = document.getElementById('session-status');
    if (el) {
        el.textContent = _sessionStatusText;
        el.style.color = phase === 'error' ? '#ff5577'
            : (phase === 'monitor' && _sessionStatusText.includes('⚠')) ? '#ffaa00'
            : phase === 'done' ? '#44cc44' : '#888';
    }
}

function _sessionAddPhase(msg) {
    const list = document.getElementById('session-phases');
    if (!list) return;
    while (list.childElementCount >= 20) list.removeChild(list.firstChild);
    const div = document.createElement('div');
    div.className = 'session-phase';
    div.textContent = msg;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
}

// ── Séquence de flip ───────────────────────────────────────────

async function sessionFlip(reason) {
    if (_sessionFlipRunning) return;
    _sessionFlipRunning = true;
    _sessionAddPhase('─');
    addLog('info', 'session', i18n(reason === 'auto' ? 'log.session.flip_auto' : 'log.session.flip_manual'));
    _sessionSetStatus('stopping');

    // 1. Snapshot de l'état courant (séquence / stacking / guidage)
    const snap = await _sessionSnapshotState();
    if (snap === null) { _sessionFail('log.session.error_snapshot'); return; }

    // 2. Arrêt propre : guidage, séquence (pause), stacking (stop)
    try {
        if (snap.guideRunning && typeof _guideStop === 'function') {
            await _guideStop();
            _sessionAddPhase(i18n('log.session.stop_guide'));
        }
    } catch (e) { addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message })); }
    try {
        if (snap.seqRunning) {
            const res = await fetch('/api/sequence/pause', { method: 'POST' }).then(r => r.json()).catch(() => null);
            _sessionAddPhase(i18n('log.session.pause_seq'));
            if (res) seqApplyStatus(res);
        }
    } catch (e) { addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message })); }
    try {
        if (snap.stkRunning) {
            await fetch('/api/stacking/stop', { method: 'POST' }).then(r => r.json()).catch(() => null);
            _sessionAddPhase(i18n('log.session.stop_stk'));
        }
    } catch (e) { addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message })); }

    // 3. Flip (abort + slew vers la même cible)
    _sessionSetStatus('flipping');
    let flipRes = null;
    try {
        flipRes = await fetch('/api/mount/flip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }).then(r => r.json());
    } catch (e) {
        _sessionFail('log.session.error', { err: e.message });
        return;
    }
    if (flipRes && flipRes.ok === false) {
        _sessionFail('log.session.flip_failed', { err: flipRes.error || '?' });
        return;
    }
    if (flipRes) {
        _sessionAddPhase(i18nFmt('log.session.flip_done', { phases: (flipRes.phases || []).join(' → ') || '—' }));
    }

    // 4. Attente de la fin du slew (mount:slewed ou poll)
    _sessionSetStatus('slew');
    await _sessionWaitSlew(60000);

    // 5. Recentrage par solve (optionnel)
    if (_sessionRecenterCfg) {
        _sessionSetStatus('recenter');
        await _sessionRecenter();
    }

    // 6. Reprise guidage / séquence / stacking
    _sessionSetStatus('resuming');
    await _sessionResume(snap);

    _sessionFlipRunning = false;
    _sessionSetStatus('done');
    _sessionAddPhase(i18n('log.session.done'));
    addLog('info', 'session', i18n('log.session.done'));
}

function _sessionFail(key, params) {
    _sessionFlipRunning = false;
    _sessionSetStatus('error');
    const msg = i18nFmt(key, params || {});
    _sessionAddPhase('⚠ ' + msg);
    addLog('error', 'session', msg);
}

async function _sessionSnapshotState() {
    let seq = { running: false, paused: false };
    let stk = { running: false };
    try { seq = await fetch('/api/sequence/status').then(r => r.json()); } catch (e) { seq = { running: false, paused: false }; }
    try { stk = await fetch('/api/stacking/status').then(r => r.json()); } catch (e) { stk = { running: false }; }
    const guideRunning = !!(typeof _guideRunning !== 'undefined' && _guideRunning);
    return {
        seqRunning: !!seq.running,
        seqPaused: !!seq.paused,
        stkRunning: !!(stk.session && stk.session.running),
        guideRunning,
    };
}

function _sessionWaitSlew(timeoutMs) {
    // L'endpoint /api/mount/flip attend la fin du slew avant de répondre,
    // mais on garde un délai de grâce + un poll pour absorber les retards
    // de propagation ws:state → mount:slewed.
    return new Promise(resolve => {
        let done = false;
        const t0 = Date.now();
        const finish = () => { if (done) return; done = true; off(); clearTimeout(to); clearInterval(poll); resolve(); };
        const off = Hub.subscribe('mount:slewed', 'session', () => {
            if (Date.now() - t0 > 1500) finish();
        });
        const to = setTimeout(finish, timeoutMs);
        const poll = setInterval(async () => {
            try {
                const m = await fetch('/api/mount').then(r => r.json());
                if (m && m.slewing === false && Date.now() - t0 > 2000) finish();
            } catch (e) { /* ignore */ }
        }, 1000);
    });
}

async function _sessionRecenter() {
    const solverReady = _solverStatus && _solverStatus.available && _solverStatus.catalogs_loaded;
    if (!solverReady) {
        addLog('info', 'session', i18n('log.session.recenter_skip'));
        return;
    }
    try {
        await solverSolve('last_image');
        addLog('info', 'session', i18n('log.session.recenter_done'));
        _sessionAddPhase(i18n('log.session.recenter_done'));
    } catch (e) {
        addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message }));
    }
}

async function _sessionResume(snap) {
    if (snap.guideRunning && typeof _guideStart === 'function') {
        try { await _guideStart(); _sessionAddPhase(i18n('log.session.resume_guide')); }
        catch (e) { addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message })); }
    }
    if (snap.seqRunning) {
        const res = await fetch('/api/sequence/resume', { method: 'POST' }).then(r => r.json()).catch(() => null);
        if (res) seqApplyStatus(res);
        _sessionAddPhase(i18n('log.session.resume_seq'));
    }
    if (snap.stkRunning && typeof stkStart === 'function') {
        try { await stkStart(); _sessionAddPhase(i18n('log.session.resume_stk')); }
        catch (e) { addLog('warning', 'session', i18nFmt('log.session.error', { err: e.message })); }
    }
}
