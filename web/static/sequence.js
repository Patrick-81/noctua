// ═══════════════════════════════════════════════════════════════
// Noctua — sequence.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── SÉQUENCE (plan d'acquisition multi-poses) ───────────────────

const SEQ_FRAME_TYPES = ['LIGHT', 'DARK', 'BIAS', 'FLAT'];
const SEQ_DEFAULT_FRAME = () => ({ duration: 60, frame_type: 'LIGHT', filter: '', count: 1, delay: 1 });

let _seqFrames = [];
let _seqDefaults = { frames: [], save_dir: '', dither: { enabled: false, amount: 2.0 } };
let _seqStatus = { running: false, paused: false, done: 0, total: 0 };
let _seqQuickCapture = null;        // { running, done, total } — capture rapide (capture.js)

function initSequencePanel() {
    const list = document.getElementById('seq-frame-list');

    // Load defaults from server config, then render
    fetch('/api/sequence/defaults').then(r => r.json()).then(data => {
        if (!data) return;
        _seqDefaults = data;
        _seqFrames = (data.frames && data.frames.length ? data.frames : [SEQ_DEFAULT_FRAME()])
            .map(f => ({ ...f }));
        const dirEl = document.getElementById('seq-save-dir');
        if (dirEl) dirEl.value = data.save_dir || '';
        const dithEl = document.getElementById('seq-dith-enabled');
        if (dithEl) dithEl.checked = !!(data.dither && data.dither.enabled);
        renderSequenceTable();
    }).catch(() => renderSequenceTable());

    const addBtn = document.getElementById('seq-add-row');
    if (addBtn) addBtn.addEventListener('click', () => {
        if (_seqStatus.running) return;
        _seqFrames.push(SEQ_DEFAULT_FRAME());
        renderSequenceTable();
    });

    const delLastBtn = document.getElementById('seq-del-last');
    if (delLastBtn) delLastBtn.addEventListener('click', () => {
        if (_seqStatus.running) return;
        if (!_seqFrames.length) return;
        _seqFrames.pop();
        renderSequenceTable();
    });

    if (list) list.addEventListener('change', (e) => {
        const rowEl = e.target.closest('.seq-frame-row');
        if (!rowEl || rowEl.dataset.idx == null) return;
        const i = parseInt(rowEl.dataset.idx);
        const f = _seqFrames[i];
        if (!f) return;
        const field = e.target.dataset.field;
        const v = e.target.value;
        if (field === 'duration') f.duration = parseFloat(v) || 0;
        else if (field === 'frame_type') f.frame_type = v;
        else if (field === 'filter') f.filter = v;
        else if (field === 'count') f.count = parseInt(v) || 1;
        else if (field === 'delay') f.delay = parseFloat(v) || 0;
        updateSequenceTotals();
    });
    if (list) list.addEventListener('click', (e) => {
        const del = e.target.closest('.seq-row-del');
        if (!del || del.dataset.idx == null) return;
        if (_seqStatus.running) return;
        const i = parseInt(del.dataset.idx);
        _seqFrames.splice(i, 1);
        renderSequenceTable();
    });

    const startBtn = document.getElementById('seq-start');
    if (startBtn) startBtn.addEventListener('click', seqStart);
    const pauseBtn = document.getElementById('seq-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', () => {
        seqCall(_seqStatus.paused ? '/api/sequence/resume' : '/api/sequence/pause');
    });
    const stopBtn = document.getElementById('seq-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => seqCall('/api/sequence/stop'));
    const resetBtn = document.getElementById('seq-reset');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
        await seqCall('/api/sequence/reset');
        _seqFrames = (Array.isArray(_seqDefaults.frames) && _seqDefaults.frames.length
            ? _seqDefaults.frames : [SEQ_DEFAULT_FRAME()]).map(f => ({ ...f }));
        renderSequenceTable();
        const errEl = document.getElementById('seq-error');
        if (errEl) errEl.style.display = 'none';
    });

    // Le statut arrive par poussée WebSocket (sequence:update) ; on ne fait
    // qu'un rafraîchissement initial + une requête si la poussée manque.
    seqRefreshStatus();

    // Bus : consommateur des poussées de statut serveur.
    Bus.on('sequence:update', (env) => seqApplyStatus(env.payload));
}

async function seqRefreshStatus() {
    try {
        const st = await fetch('/api/sequence/status').then(r => r.json());
        if (st) seqApplyStatus(st);
    } catch (e) { /* server not reachable — ignore */ }
}

function seqFramesFromUi() {
    return _seqFrames.map(f => ({
        duration: parseFloat(f.duration) || 0,
        frame_type: f.frame_type || 'LIGHT',
        filter: f.filter || '',
        count: parseInt(f.count) || 1,
        delay: parseFloat(f.delay) || 0,
    }));
}

function renderSequenceTable() {
    const list = document.getElementById('seq-frame-list');
    if (!list) return;
    list.innerHTML = '';
    if (!_seqFrames.length) {
        list.innerHTML = '<div style="color:#666; font-size:0.6rem; padding:6px 8px;">Aucune pose — ajoutez-en une.</div>';
    }
    _seqFrames.forEach((f, i) => {
        const dur = (parseFloat(f.duration) || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
        const row = document.createElement('div');
        row.className = 'seq-frame-row';
        row.dataset.idx = i;
        row.innerHTML =
            `<div class="seq-col seq-col-type">
                <span class="seq-col-label">Type</span>
                <select class="seq-col-input" data-field="frame_type" ${_seqStatus.running ? 'disabled' : ''}>
                    ${SEQ_FRAME_TYPES.map(t => `<option ${t === (f.frame_type || 'LIGHT') ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>` +
            `<div class="seq-col seq-col-dur">
                <span class="seq-col-label">Durée (s)</span>
                <input type="number" class="seq-col-input" data-field="duration" value="${dur}" min="0.1" step="0.5" ${_seqStatus.running ? 'disabled' : ''}>
            </div>` +
            `<div class="seq-col seq-col-filter">
                <span class="seq-col-label">Filtre</span>
                <input type="text" class="seq-col-input" data-field="filter" value="${escapeAttr(f.filter || '')}" placeholder="L, R, Ha…" ${_seqStatus.running ? 'disabled' : ''}>
            </div>` +
            `<div class="seq-col seq-col-count">
                <span class="seq-col-label">×</span>
                <input type="number" class="seq-col-input" data-field="count" value="${parseInt(f.count) || 1}" min="1" step="1" ${_seqStatus.running ? 'disabled' : ''}>
            </div>` +
            `<div class="seq-col seq-col-delay">
                <span class="seq-col-label">Pause</span>
                <input type="number" class="seq-col-input" data-field="delay" value="${parseFloat(f.delay) || 0}" min="0" step="0.5" ${_seqStatus.running ? 'disabled' : ''}>
            </div>` +
            `<button class="seq-row-del" data-idx="${i}" title="Retirer cette pose" ${_seqStatus.running ? 'disabled' : ''}>✕</button>`;
        list.appendChild(row);
    });
    updateSequenceTotals();
    const amtEl = document.getElementById('seq-dith-amount');
    if (amtEl && _seqDefaults.dither) amtEl.textContent = `±${_seqDefaults.dither.amount ?? 2} px`;
}

function updateSequenceTotals() {
    const pt = document.getElementById('seq-progress-text');
    if (!pt) return;
    if (_seqQuickCapture && _seqQuickCapture.running && !_seqStatus.running) {
        pt.textContent = `${_seqQuickCapture.done} / ${_seqQuickCapture.total}`;
        return;
    }
    const currentTotal = _seqStatus.total || _seqFrames.reduce((s, f) => s + (parseInt(f.count) || 1), 0);
    pt.textContent = `${_seqStatus.done} / ${currentTotal}`;
}

async function seqStart() {
    const frames = seqFramesFromUi();
    const total = frames.reduce((s, f) => s + f.count, 0);
    if (!total) { addLog('warning', 'sequence', 'Plan vide — ajoutez au moins une pose'); return; }
    const saveDir = document.getElementById('seq-save-dir')?.value.trim() || '';
    const dith = document.getElementById('seq-dith-enabled')?.checked;
    addLog('info', 'sequence', i18nFmt('log.capture.start', { n: total, dither: dith ? 'ON' : 'OFF' }));
    let res = null;
    try {
        res = await fetch('/api/sequence/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                frames, save_dir: saveDir,
                dither: { enabled: !!dith, amount: (_seqDefaults.dither && _seqDefaults.dither.amount) ?? 2.0 },
            }),
        }).then(r => r.json());
    } catch (e) {
        addLog('error', 'sequence', i18n('log.capture.start_failed'));
        return;
    }
    if (!res) { addLog('error', 'sequence', i18n('log.capture.start_failed')); return; }
    if (res.ok === false && res.error) {
        addLog('error', 'sequence', i18nFmt('log.capture.start_refused', { err: res.error }));
        return;
    }
    renderSequenceTable();
    seqApplyStatus(res.status || { running: true });
}

async function seqCall(url) {
    const res = await fetch(url, { method: 'POST' }).then(r => r.json()).catch(() => null);
    if (res) seqApplyStatus(res);
    return res;
}

let _seqPrevRunning = false;
let _seqLoggedFinish = false;

function seqApplyStatus(st) {
    if (!st) return;
    const started = !_seqPrevRunning && st.running;
    const finished = _seqPrevRunning && !st.running;
    // Robustness: a very fast run can start+finish between two polls, so the
    // running→idle transition is never observed. Detect completion from the
    // counters instead (run fully done and no longer running).
    const doneRun = !st.running && st.total > 0 && st.done >= st.total;
    _seqPrevRunning = st.running;
    _seqStatus = st;

    // La capture rapide du panneau Capture occupe la caméra : on se met en
    // attente (bouton désactivé) et on laisse l'événement capture:progress
    // piloter l'affichage de progression.
    const quickActive = !!(_seqQuickCapture && _seqQuickCapture.running);

    if ((finished || doneRun) && !_seqLoggedFinish) {
        _seqLoggedFinish = true;
        addLog('info', 'sequence', i18nFmt('log.capture.seq_finished', { done: st.done, total: st.total }));
    }
    if (started) _seqLoggedFinish = false;

    const startBtn = document.getElementById('seq-start');
    const pauseBtn = document.getElementById('seq-pause');
    const stopBtn = document.getElementById('seq-stop');
    const resetBtn = document.getElementById('seq-reset');
    if (startBtn) startBtn.disabled = !!st.running || quickActive;
    if (stopBtn) stopBtn.disabled = !st.running;
    if (resetBtn) resetBtn.disabled = !!st.running;
    if (pauseBtn) {
        pauseBtn.disabled = !st.running;
        pauseBtn.textContent = st.paused ? '▶ Reprendre' : '⏸ Pauser';
    }

    if (!quickActive) {
        const fill = document.getElementById('seq-progress-fill');
        if (fill) fill.style.width = Math.round((st.progress || 0) * 100) + '%';
        const pt = document.getElementById('seq-progress-text');
        if (pt) pt.textContent = `${st.done} / ${st.total}`;

        const cur = document.getElementById('seq-current');
        if (cur) {
            if (st.running && st.current) {
                const c = st.current;
                cur.textContent = `Pose ${st.done + 1}/${st.total} — ${c.frame_type || 'LIGHT'} ${c.duration ?? ''}s${c.filter ? ' [' + c.filter + ']' : ''}${st.paused ? ' (PAUSÉE)' : ''}`;
            } else if (st.running) {
                cur.textContent = `Pose ${st.done + 1}/${st.total}${st.paused ? ' (PAUSÉE)' : ''}`;
            } else if (finished || doneRun) {
                cur.textContent = i18n('seq.done');
            } else {
                cur.textContent = '—';
            }
        }
    }

    const dithEl = document.getElementById('seq-dither-status');
    if (dithEl && st.last_dither && st.last_dither.dx != null) {
        const d = st.last_dither;
        dithEl.style.display = '';
        const guided = (d.guided === undefined || d.guided) ? '' : ' — pas de guidage';
        dithEl.textContent = `Dither : Δ(${d.dx.toFixed(1)}, ${d.dy.toFixed(1)})${guided}`;
    }

    const svEl = document.getElementById('seq-last-saved');
    if (svEl && st.last_saved) {
        svEl.style.display = '';
        svEl.textContent = '💾 ' + st.last_saved;
    }

    const errEl = document.getElementById('seq-error');
    if (errEl) {
        if (st.last_error) {
            errEl.style.display = '';
            errEl.textContent = '⚠ ' + st.last_error;
        } else {
            errEl.style.display = 'none';
        }
    }
    updateSequenceTotals();
}

// ── Bus : consommateur capture:progress ───────────────────────
// La capture rapide du panneau Capture occupe la caméra. Tant qu'aucune
// séquence serveur n'est en cours, le panneau reflète sa progression en
// direct (au lieu d'attendre le poll 1 s) ; le bouton Démarrer est désactivé
// pour éviter deux processus d'acquisition simultanés.

Bus.on('capture:progress', (env) => {
    _seqQuickCapture = env.payload || null;
    if (_seqStatus.running) return;
    const p = _seqQuickCapture;
    const fill = document.getElementById('seq-progress-fill');
    const pt = document.getElementById('seq-progress-text');
    const cur = document.getElementById('seq-current');
    if (p && p.running) {
        if (pt) pt.textContent = `${p.done} / ${p.total}`;
        if (fill) fill.style.width = Math.round((p.total > 0 ? p.done / p.total : 0) * 100) + '%';
        if (cur) cur.textContent = i18n('seq.quick_capture');
    } else {
        if (cur) cur.textContent = '—';
        updateSequenceTotals();
    }
});

