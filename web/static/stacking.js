// ═══════════════════════════════════════════════════════════════
// Noctua — stacking.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── LIVE STACKING (accumulation en direct, poses courtes) ──────

let _stkRunning = false;
let _stkStatus = null;              // dernier statut serveur reçu
let _stkQuickCapture = null;        // { running, done, total } — capture rapide (capture.js)
let _stkPanelHidden = true;         // état du toggle LIVE STACKING (masqué par défaut, persisté entre modes)

function stkToggleRefresh() {
    const toggleBtn = document.getElementById('cap-stacking-toggle');
    if (toggleBtn) toggleBtn.classList.toggle('stacking-on', !_stkPanelHidden);
}

function initStackingPanel() {
    const defaults = document.getElementById('stk-save-dir');
    if (defaults) {
        fetch('/api/sequence/defaults').then(r => r.json()).then(data => {
            if (data && data.save_dir) defaults.value = data.save_dir;
        }).catch(() => {});
    }

    const toggleBtn = document.getElementById('cap-stacking-toggle');
    const stackingPanel = document.getElementById('applet-stacking');
    if (toggleBtn && stackingPanel) {
        toggleBtn.addEventListener('click', () => {
            _stkPanelHidden = !_stkPanelHidden;
            if (_stkPanelHidden) {
                stackingPanel.style.display = 'none';
            } else {
                stackingPanel.style.display = '';
                requestAnimationFrame(() => resolvePanelLayout());
            }
            stkToggleRefresh();
        });
        stkToggleRefresh();
    }

    const startBtn = document.getElementById('stk-start');
    if (startBtn) startBtn.addEventListener('click', stkStart);
    const stopBtn = document.getElementById('stk-stop');
    if (stopBtn) stopBtn.addEventListener('click', stkStop);
    const resetBtn = document.getElementById('stk-reset');
    if (resetBtn) resetBtn.addEventListener('click', stkReset);
    const saveBtn = document.getElementById('stk-save-master');
    if (saveBtn) saveBtn.addEventListener('click', () => stkSaveMaster('fits'));
    const savePngBtn = document.getElementById('stk-save-png');
    if (savePngBtn) savePngBtn.addEventListener('click', () => stkSaveMaster('png'));

    // Live status via WebSocket push (stacking:update) — plus de polling.
    // Un fetch initial hydrate le panneau avant le premier événement.
    stkPollStatus();
}

// ── Bus : consommateur stacking:update (push WS du serveur) ────

Bus.on('stacking:update', (env) => {
    _stkQuickCapture = null;
    stkApplyStatus(env.payload);
});

// Rafraîchit une fois à l'entrée en mode capture (rattrapage si des
// événements ont été manqués pendant qu'on était dans un autre mode).
// Le panneau n'est PAS dans les applets auto-visibles du mode capture :
// on ré-applique ici l'état du toggle (masqué par défaut, ou le choix de
// l'utilisateur) après le changement de mode.
Bus.on('mode:changed', (env) => {
    if (env.payload.mode === 'capture') {
        const panel = document.getElementById('applet-stacking');
        if (panel) panel.style.display = _stkPanelHidden ? 'none' : '';
        stkToggleRefresh();
        stkPollStatus();
    }
});

function stkGetVal(id) { return document.getElementById(id)?.value?.trim() || ''; }

async function stkStart() {
    const duration = parseFloat(stkGetVal('stk-duration') || '5');
    const max_frames = parseInt(stkGetVal('stk-max-frames') || '0');
    addLog('info', 'stacking', i18nFmt('log.stacking.start', { duration, max_frames: max_frames || '∞' }));
    let res = null;
    try {
        res = await fetch('/api/stacking/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                duration,
                max_frames,
                filter: stkGetVal('stk-filter'),
                save_dir: stkGetVal('stk-save-dir'),
                dark_dir: stkGetVal('stk-dark-dir'),
                flat_dir: stkGetVal('stk-flat-dir'),
            }),
        }).then(r => r.json());
    } catch (e) {
        addLog('error', 'stacking', i18n('log.stacking.start_failed'));
        return;
    }
    if (res.ok === false && res.error) {
        addLog('error', 'stacking', i18nFmt('log.stacking.start_refused', { err: res.error }));
        stkShowError(res.error);
        return;
    }
    if (res.session_dir) {
        const d = document.getElementById('stk-session-dir');
        if (d) d.textContent = 'Session → ' + res.session_dir;
    }
    const errEl = document.getElementById('stk-error');
    if (errEl) errEl.style.display = 'none';
    stkApplyStatus(res.status || { running: true });
}

async function stkStop() {
    const res = await fetch('/api/stacking/stop', { method: 'POST' }).then(r => r.json()).catch(() => null);
    if (res) stkApplyStatus(res);
}

async function stkReset() {
    const res = await fetch('/api/stacking/reset', { method: 'POST' }).then(r => r.json()).catch(() => null);
    if (res) stkApplyStatus(res);
}

async function stkSaveMaster(fmt) {
    const res = await fetch('/api/stacking/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: stkGetVal('stk-save-dir'), format: fmt, name: 'master' }),
    }).then(r => r.json()).catch(() => null);
    if (res && res.ok) addLog('info', 'stacking', i18nFmt('log.stacking.master_saved', { path: res.path }));
    else addLog('error', 'stacking', i18nFmt('log.stacking.master_failed', { err: res?.error || '?' }));
}

async function stkPollStatus() {
    try {
        const st = await fetch('/api/stacking/status').then(r => r.json());
        if (st) stkApplyStatus(st);
    } catch (e) { /* ignore */ }
}

function stkShowError(msg) {
    const errEl = document.getElementById('stk-error');
    if (errEl) { errEl.style.display = ''; errEl.textContent = '⚠ ' + msg; }
}

function stkApplyStatus(st) {
    if (!st) return;
    _stkStatus = st;
    const running = st.session && st.session.running;
    const prevRunning = _stkRunning;
    _stkRunning = !!running;
    // La capture rapide occupe la caméra : on attend qu'elle se termine
    // (statut affiché par l'événement capture:progress), start désactivé.
    const quickActive = !!(_stkQuickCapture && _stkQuickCapture.running);
    if (prevRunning && !_stkRunning && st.complete) {
        addLog('info', 'stacking', i18nFmt('log.stacking.done', { n: st.accepted }));
        if (st.master_path) {
            addLog('info', 'stacking', i18nFmt('log.stacking.master_auto', { path: st.master_path }));
        }
    }

    const startBtn = document.getElementById('stk-start');
    const stopBtn = document.getElementById('stk-stop');
    const resetBtn = document.getElementById('stk-reset');
    const saveBtn = document.getElementById('stk-save-master');
    const savePngBtn = document.getElementById('stk-save-png');
    if (startBtn) startBtn.disabled = !!running || quickActive;
    if (stopBtn) stopBtn.disabled = !running;
    const hasStack = (st.accepted || 0) > 0;
    if (resetBtn) resetBtn.disabled = !!running || !hasStack;
    if (saveBtn) saveBtn.disabled = !hasStack;
    if (savePngBtn) savePngBtn.disabled = !hasStack;

    if (!quickActive) {
        const statusEl = document.getElementById('stk-status');
        if (statusEl) {
            let txt = running ? i18n('stk.accumulating') : (st.complete ? i18n('stk.done') : 'Ready');
            if (hasStack) txt += ` — ${st.accepted} LIGHT empilées, ${st.rejected} rejetées`;
            if (st.max_frames) txt += ` (cible ${st.max_frames})`;
            if (st.error) txt += ` — ${st.error}`;
            if (st.master_path) txt += ` — 💾 ${st.master_path}`;
            statusEl.textContent = txt;
        }
    }
    const dirEl = document.getElementById('stk-session-dir');
    if (dirEl && st.session_dir && !running) {
        dirEl.textContent = 'Session → ' + st.session_dir;
    }
}

// ── Bus : consommateur capture:progress ───────────────────────
// La capture rapide du panneau Capture occupe la caméra : le stacking attend
// (start désactivé) et affiche l'occupation au lieu de son statut serveur.

Bus.on('capture:progress', (env) => {
    _stkQuickCapture = env.payload || null;
    if (!(_stkQuickCapture && _stkQuickCapture.running)) {
        if (_stkStatus) stkApplyStatus(_stkStatus);
        return;
    }
    const statusEl = document.getElementById('stk-status');
    if (statusEl) statusEl.textContent = i18n('stk.quick_capture');
    const startBtn = document.getElementById('stk-start');
    if (startBtn) startBtn.disabled = true;
});
