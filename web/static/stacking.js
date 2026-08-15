// ═══════════════════════════════════════════════════════════════
// Noctua — stacking.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── LIVE STACKING (accumulation en direct, poses courtes) ──────

let _stkRunning = false;
let _stkPollTimer = null;

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
        const refreshToggle = () => {
            const visible = stackingPanel.style.display !== 'none' && stackingPanel.offsetParent !== null;
            toggleBtn.classList.toggle('stacking-on', visible);
        };
        toggleBtn.addEventListener('click', () => {
            const visible = stackingPanel.style.display !== 'none' && stackingPanel.offsetParent !== null;
            if (visible) {
                stackingPanel.style.display = 'none';
            } else {
                stackingPanel.style.display = '';
                requestAnimationFrame(() => resolvePanelLayout());
            }
            refreshToggle();
        });
        refreshToggle();
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

    if (_stkPollTimer) clearInterval(_stkPollTimer);
    _stkPollTimer = setInterval(stkPollStatus, 1000);
}

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
    const running = st.session && st.session.running;
    const prevRunning = _stkRunning;
    _stkRunning = !!running;
    if (prevRunning && !_stkRunning && st.complete) {
        addLog('info', 'stacking', i18nFmt('log.stacking.done', { n: st.accepted }));
    }

    const startBtn = document.getElementById('stk-start');
    const stopBtn = document.getElementById('stk-stop');
    const resetBtn = document.getElementById('stk-reset');
    const saveBtn = document.getElementById('stk-save-master');
    const savePngBtn = document.getElementById('stk-save-png');
    if (startBtn) startBtn.disabled = !!running;
    if (stopBtn) stopBtn.disabled = !running;
    const hasStack = (st.accepted || 0) > 0;
    if (resetBtn) resetBtn.disabled = !!running || !hasStack;
    if (saveBtn) saveBtn.disabled = !hasStack;
    if (savePngBtn) savePngBtn.disabled = !hasStack;

    const statusEl = document.getElementById('stk-status');
    if (statusEl) {
        let txt = running ? '⏳ Accumulation en cours…' : (st.complete ? '✓ Terminé' : 'Ready');
        if (hasStack) txt += ` — ${st.accepted} LIGHT empilées, ${st.rejected} rejetées`;
        if (st.max_frames) txt += ` (cible ${st.max_frames})`;
        if (st.error) txt += ` — ${st.error}`;
        statusEl.textContent = txt;
    }
    const dirEl = document.getElementById('stk-session-dir');
    if (dirEl && st.session_dir && !running) {
        dirEl.textContent = 'Session → ' + st.session_dir;
    }
}
