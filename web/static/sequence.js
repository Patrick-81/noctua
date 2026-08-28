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

    // Hub : consommateur des poussées de statut serveur.
    Hub.subscribe('sequence:update', 'sequence', (env) => seqApplyStatus(env.payload));
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

// ── Hub : consommateur capture:progress ───────────────────────
// La capture rapide du panneau Capture occupe la caméra. Tant qu'aucune
// séquence serveur n'est en cours, le panneau reflète sa progression en
// direct (au lieu d'attendre le poll 1 s) ; le bouton Démarrer est désactivé
// pour éviter deux processus d'acquisition simultanés.

Hub.subscribe('capture:progress', 'sequence', (env) => {
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

// ═══════════════════════════════════════════════════════════════
// Noctua — Séquenceur Nina-like (niveau 1 : simple)
// ═══════════════════════════════════════════════════════════════

function seqNewTarget() {
    return {
        id: ++seqTargetIdCounter,
        name: 'Cible ' + seqTargetIdCounter,
        ra: '', dec: '', rotation: 0,
        steps: [seqNewStep()],
        enabled: true,
    };
}

function seqNewStep() {
    return {
        id: Date.now() + Math.random(),
        type: 'exposure',
        frame_type: 'LIGHT',
        duration: 60,
        filter: '',
        count: 1,
        gain: -1,
        offset: -1,
        binning: 1,
        delay: 1,
    };
}

function seqInitSequencer() {
    const addBtn = document.getElementById('seq-add-target');
    if (addBtn) addBtn.addEventListener('click', () => {
        const t = seqNewTarget();
        seqData.targets.push(t);
        seqSelectedTargetId = t.id;
        seqRenderTargetList();
        seqRenderTargetDetail();
    });

    const dupBtn = document.getElementById('seq-dup-target');
    if (dupBtn) dupBtn.addEventListener('click', () => {
        if (!seqSelectedTargetId) return;
        const src = seqData.targets.find(t => t.id === seqSelectedTargetId);
        if (!src) return;
        const dup = JSON.parse(JSON.stringify(src));
        dup.id = ++seqTargetIdCounter;
        dup.name = src.name + ' (copie)';
        dup.steps.forEach(s => s.id = Date.now() + Math.random());
        seqData.targets.push(dup);
        seqSelectedTargetId = dup.id;
        seqRenderTargetList();
        seqRenderTargetDetail();
    });

    const delBtn = document.getElementById('seq-del-target');
    if (delBtn) delBtn.addEventListener('click', () => {
        if (!seqSelectedTargetId) return;
        seqData.targets = seqData.targets.filter(t => t.id !== seqSelectedTargetId);
        seqSelectedTargetId = seqData.targets.length ? seqData.targets[0].id : null;
        seqRenderTargetList();
        seqRenderTargetDetail();
    });

    const startBtn = document.getElementById('seq-start');
    if (startBtn) startBtn.addEventListener('click', seqStartSequence);

    const pauseBtn = document.getElementById('seq-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', () => {
        seqCallApi(seqStatus.paused ? '/api/sequence/resume' : '/api/sequence/pause');
    });

    const stopBtn = document.getElementById('seq-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => seqCallApi('/api/sequence/stop'));

    const resetBtn = document.getElementById('seq-reset');
    if (resetBtn) resetBtn.addEventListener('click', async () => {
        await seqCallApi('/api/sequence/reset');
        seqStatus = { running: false, paused: false, done: 0, total: 0, current: null };
        seqRenderTargetList();
        seqUpdateProgressUI();
    });

    const dithEl = document.getElementById('seq-dith-enabled');
    if (dithEl) dithEl.addEventListener('change', (e) => {
        seqData.dither.enabled = e.target.checked;
    });

    const dithAmt = document.getElementById('seq-dith-amount');
    if (dithAmt && seqData.dither) dithAmt.textContent = `±${seqData.dither.amount ?? 2} px`;

    const settleRmsEl = document.getElementById('seq-dith-settle-rms');
    if (settleRmsEl) settleRmsEl.addEventListener('change', (e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v) && seqData.dither) seqData.dither.settle_rms = v;
    });
    const settleToEl = document.getElementById('seq-dith-settle-timeout');
    if (settleToEl) settleToEl.addEventListener('change', (e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v) && seqData.dither) seqData.dither.settle_timeout = v;
    });

    Hub.subscribe('sequence:update', 'sequencer', (env) => seqApplyStatus(env.payload));
    Hub.subscribe('capture:progress', 'sequencer', (env) => {
        seqQuickCapture = env.payload || null;
        seqUpdateProgressUI();
    });

    seqLoadFromServer();
}

async function seqLoadFromServer() {
    try {
        const data = await fetch('/api/sequence/defaults').then(r => r.json());
        if (!data) return;
        if (data.dither) seqData.dither = data.dither;
        if (data.save_dir) seqData.save_dir = data.save_dir;
        if (data.stacking) seqData.stacking = data.stacking;
        const dirEl = document.getElementById('seq-save-dir');
        if (dirEl) dirEl.value = seqData.save_dir || '';
        const dithEl = document.getElementById('seq-dith-enabled');
        if (dithEl) dithEl.checked = !!seqData.dither.enabled;
        const dithAmt = document.getElementById('seq-dith-amount');
        if (dithAmt) dithAmt.textContent = `±${seqData.dither.amount ?? 2} px`;
        const rmsEl = document.getElementById('seq-dith-settle-rms');
        if (rmsEl && seqData.dither) rmsEl.value = seqData.dither.settle_rms ?? 1;
        const toEl = document.getElementById('seq-dith-settle-timeout');
        if (toEl && seqData.dither) toEl.value = seqData.dither.settle_timeout ?? 20;
        // Si l'ancien format (frames) est présent, convertir en targets
        if (data.frames && data.frames.length && !seqData.targets.length) {
            const t = seqNewTarget();
            t.steps = data.frames.map(f => ({
                id: Date.now() + Math.random(),
                type: 'exposure',
                frame_type: f.frame_type || 'LIGHT',
                duration: f.duration || 60,
                filter: f.filter || '',
                count: f.count || 1,
                gain: f.gain ?? -1,
                offset: f.offset ?? -1,
                binning: f.binning || 1,
                delay: f.delay || 1,
            }));
            seqData.targets = [t];
            seqSelectedTargetId = t.id;
        }
        seqRenderTargetList();
        seqRenderTargetDetail();
        seqRefreshStatus();
    } catch (e) { /* ignore */ }
}

function seqRenderTargetList() {
    const list = document.getElementById('seq-target-list');
    if (!list) return;
    list.innerHTML = '';
    if (!seqData.targets.length) {
        list.innerHTML = '<div style="color:var(--text-muted); font-size:0.6rem; padding:8px; text-align:center;">Aucune cible. Cliquez ＋ pour en ajouter une.</div>';
        return;
    }
    seqData.targets.forEach(t => {
        const el = document.createElement('div');
        el.className = 'seq-target-item' + (t.id === seqSelectedTargetId ? ' selected' : '') + (!t.enabled ? ' disabled' : '');
        const totalFrames = t.steps.reduce((s, st) => s + (parseInt(st.count) || 1), 0);
        const totalTime = t.steps.reduce((s, st) => s + (parseFloat(st.duration) || 0) * (parseInt(st.count) || 1), 0);
        const filters = [...new Set(t.steps.map(st => st.filter).filter(Boolean))].join(', ') || '—';
        el.innerHTML = `
            <div class="seq-target-name">${escapeAttr(t.name)}</div>
            <div class="seq-target-meta">${escapeAttr(filters)} · ${totalFrames} poses · ${seqFormatTime(totalTime)}</div>
        `;
        el.addEventListener('click', () => {
            seqSelectedTargetId = t.id;
            seqRenderTargetList();
            seqRenderTargetDetail();
        });
        list.appendChild(el);
    });
}

function seqRenderTargetDetail() {
    const det = document.getElementById('seq-target-detail');
    if (!det) return;
    const t = seqData.targets.find(t => t.id === seqSelectedTargetId);
    if (!t) {
        det.innerHTML = '<div style="color:var(--text-muted); font-size:0.65rem; padding:20px; text-align:center;">Sélectionnez une cible ou ajoutez-en une nouvelle.</div>';
        return;
    }
    const running = seqStatus.running;
    det.innerHTML = `
        <div class="seq-detail-section">
            <div class="hw-row">
                <span class="hw-label" style="width:60px;">Nom</span>
                <input type="text" class="cap-input seq-detail-name" value="${escapeAttr(t.name)}" ${running ? 'disabled' : ''} style="flex:1;">
            </div>
            <div class="hw-row">
                <span class="hw-label" style="width:60px;">RA</span>
                <input type="text" class="cap-input seq-detail-ra" value="${escapeAttr(t.ra)}" placeholder="00:42:44" ${running ? 'disabled' : ''} style="flex:1;">
                <span class="hw-label" style="width:40px; margin-left:8px;">Dec</span>
                <input type="text" class="cap-input seq-detail-dec" value="${escapeAttr(t.dec)}" placeholder="+41:16:09" ${running ? 'disabled' : ''} style="flex:1;">
                <span class="hw-label" style="width:20px; margin-left:8px;">°</span>
                <input type="number" class="cap-input seq-detail-rot" value="${t.rotation || 0}" min="0" max="360" step="0.1" ${running ? 'disabled' : ''} style="width:50px;">
            </div>
            <div class="hw-row">
                <label class="seq-chk"><input type="checkbox" class="seq-detail-enabled" ${t.enabled ? 'checked' : ''} ${running ? 'disabled' : ''}> Activée</label>
            </div>
        </div>
        <div class="seq-detail-section" style="margin-top:8px;">
            <div class="hw-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>Étapes d'exposition</span>
                <button class="btn-glass seq-add-step" style="font-size:0.6rem; padding:2px 6px;" ${running ? 'disabled' : ''}>＋ Ajouter</button>
            </div>
            <div class="seq-steps-list">
                ${t.steps.map((st, i) => seqRenderStep(t, st, i, running)).join('')}
            </div>
        </div>
        <div class="seq-detail-section" style="margin-top:8px;">
            <div class="hw-section-title">Catalogue</div>
            <input type="text" id="seq-catalog-search" class="cap-input" placeholder="Rechercher (M31, NGC7000, Aldébaran…)" style="width:100%; margin-bottom:6px;">
            <div id="seq-catalog-tree" class="seq-catalog-tree"></div>
        </div>
    `;
    det.querySelectorAll('.seq-detail-name').forEach(el => el.addEventListener('change', (e) => { t.name = e.target.value; seqRenderTargetList(); }));
    det.querySelectorAll('.seq-detail-ra').forEach(el => el.addEventListener('change', (e) => { t.ra = e.target.value; }));
    det.querySelectorAll('.seq-detail-dec').forEach(el => el.addEventListener('change', (e) => { t.dec = e.target.value; }));
    det.querySelectorAll('.seq-detail-rot').forEach(el => el.addEventListener('change', (e) => { t.rotation = parseFloat(e.target.value) || 0; }));
    det.querySelectorAll('.seq-detail-enabled').forEach(el => el.addEventListener('change', (e) => { t.enabled = e.target.checked; seqRenderTargetList(); }));
    det.querySelectorAll('.seq-add-step').forEach(el => el.addEventListener('click', () => {
        t.steps.push(seqNewStep());
        seqRenderTargetDetail();
    }));
    det.querySelectorAll('.seq-del-step').forEach(el => el.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        t.steps.splice(idx, 1);
        if (!t.steps.length) t.steps.push(seqNewStep());
        seqRenderTargetDetail();
    }));
    det.querySelectorAll('.seq-step-input').forEach(el => {
        el.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const field = e.target.dataset.field;
            const step = t.steps[idx];
            if (!step) return;
            if (field === 'duration' || field === 'delay') step[field] = parseFloat(e.target.value) || 0;
            else if (field === 'count') step[field] = parseInt(e.target.value) || 1;
            else if (field === 'gain' || field === 'offset' || field === 'binning') step[field] = parseInt(e.target.value) || -1;
            else step[field] = e.target.value;
            seqRenderTargetList();
        });
    });
    seqInitCatalogTree(t);
}

// ── Catalogue arborescent ────────────────────────────────────

function seqInitCatalogTree(target) {
    const searchEl = document.getElementById('seq-catalog-search');
    const treeEl = document.getElementById('seq-catalog-tree');
    if (!searchEl || !treeEl) return;

    renderCatalogTree(searchEl, treeEl, (o) => {
        target.name = o.id + (o.name && o.name !== o.id ? ' — ' + o.name : '');
        target.ra = decToSexa(o.ra / 15, true);
        target.dec = decToSexa(o.dec, false);
        seqRenderTargetDetail();
        seqRenderTargetList();
    });
}

function seqRenderStep(target, step, idx, running) {
    return `
        <div class="seq-step-row">
            <select class="cap-input seq-step-input" data-idx="${idx}" data-field="frame_type" ${running ? 'disabled' : ''} style="width:60px;">
                ${SEQ_FRAME_TYPES.map(t => `<option ${step.frame_type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <input type="number" class="cap-input seq-step-input" data-idx="${idx}" data-field="duration" value="${step.duration}" min="0.1" step="0.5" ${running ? 'disabled' : ''} style="width:55px;" title="Durée (s)">
            <span style="font-size:0.6rem; color:var(--text-muted);">s</span>
            <input type="text" class="cap-input seq-step-input" data-idx="${idx}" data-field="filter" value="${escapeAttr(step.filter || '')}" placeholder="filtre" ${running ? 'disabled' : ''} style="width:65px;">
            <span style="font-size:0.6rem; color:var(--text-muted);">×</span>
            <input type="number" class="cap-input seq-step-input" data-idx="${idx}" data-field="count" value="${step.count}" min="1" step="1" ${running ? 'disabled' : ''} style="width:40px;">
            <button class="seq-del-step btn-glass danger" data-idx="${idx}" title="Supprimer cette étape" ${running ? 'disabled' : ''} style="font-size:0.6rem; padding:1px 4px; margin-left:auto;">✕</button>
        </div>
    `;
}

function seqFormatTime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

function seqFlattenFrames() {
    const frames = [];
    seqData.targets.forEach(t => {
        if (!t.enabled) return;
        t.steps.forEach(st => {
            frames.push({
                duration: parseFloat(st.duration) || 0,
                frame_type: st.frame_type || 'LIGHT',
                filter: st.filter || '',
                count: parseInt(st.count) || 1,
                delay: parseFloat(st.delay) || 0,
                gain: st.gain,
                offset: st.offset,
                binning: st.binning,
                target_name: t.name,
            });
        });
    });
    return frames;
}

// Associe l'état du panneau (checkbox + inputs settle) à l'objet dither envoyé au serveur.
function seqDitherFromUi() {
    const d = {
        enabled: !!document.getElementById('seq-dith-enabled')?.checked,
        amount: seqData.dither.amount ?? 2.0,
    };
    const rms = parseFloat(document.getElementById('seq-dith-settle-rms')?.value);
    const to = parseFloat(document.getElementById('seq-dith-settle-timeout')?.value);
    if (!Number.isNaN(rms)) d.settle_rms = rms;
    if (!Number.isNaN(to)) d.settle_timeout = to;
    if (seqData.dither.settle_stable != null) d.settle_stable = seqData.dither.settle_stable;
    return d;
}

async function seqStartSequence() {
    const frames = seqFlattenFrames();
    const total = frames.reduce((s, f) => s + f.count, 0);
    if (!total) { addLog('warning', 'sequencer', 'Plan vide — ajoutez au moins une pose'); return; }
    const saveDir = document.getElementById('seq-save-dir')?.value.trim() || '';
    const dith = document.getElementById('seq-dith-enabled')?.checked;
    addLog('info', 'sequencer', i18nFmt('log.capture.start', { n: total, dither: dith ? 'ON' : 'OFF' }));
    let res = null;
    try {
        res = await fetch('/api/sequence/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                frames, save_dir: saveDir,
                dither: seqDitherFromUi(),
            }),
        }).then(r => r.json());
    } catch (e) {
        addLog('error', 'sequencer', i18n('log.capture.start_failed'));
        return;
    }
    if (!res) { addLog('error', 'sequencer', i18n('log.capture.start_failed')); return; }
    if (res.ok === false && res.error) {
        addLog('error', 'sequencer', i18nFmt('log.capture.start_refused', { err: res.error }));
        return;
    }
    seqApplyStatus(res.status || { running: true });
}

async function seqCallApi(url) {
    const res = await fetch(url, { method: 'POST' }).then(r => r.json()).catch(() => null);
    if (res) seqApplyStatus(res);
    return res;
}

async function seqRefreshStatus() {
    try {
        const st = await fetch('/api/sequence/status').then(r => r.json());
        if (st) seqApplyStatus(st);
    } catch (e) { /* ignore */ }
}

let _seqPrevRunning2 = false;
let _seqLoggedFinish2 = false;

function seqApplyStatus(st) {
    if (!st) return;
    const started = !_seqPrevRunning2 && st.running;
    const finished = _seqPrevRunning2 && !st.running;
    const doneRun = !st.running && st.total > 0 && st.done >= st.total;
    _seqPrevRunning2 = st.running;
    seqStatus = st;

    const quickActive = !!(seqQuickCapture && seqQuickCapture.running);

    if ((finished || doneRun) && !_seqLoggedFinish2) {
        _seqLoggedFinish2 = true;
        addLog('info', 'sequencer', i18nFmt('log.capture.seq_finished', { done: st.done, total: st.total }));
    }
    if (started) _seqLoggedFinish2 = false;

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

    seqUpdateProgressUI();
    seqRenderTargetList();
}

function seqUpdateProgressUI() {
    const st = seqStatus;
    const quickActive = !!(seqQuickCapture && seqQuickCapture.running);
    const doneRun = !st.running && st.total > 0 && st.done >= st.total;

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
            } else if (doneRun) {
                cur.textContent = i18n('seq.done');
            } else {
                cur.textContent = '—';
            }
        }
    } else {
        const p = seqQuickCapture;
        const fill = document.getElementById('seq-progress-fill');
        const pt = document.getElementById('seq-progress-text');
        const cur = document.getElementById('seq-current');
        if (p && p.running) {
            if (pt) pt.textContent = `${p.done} / ${p.total}`;
            if (fill) fill.style.width = Math.round((p.total > 0 ? p.done / p.total : 0) * 100) + '%';
            if (cur) cur.textContent = i18n('seq.quick_capture');
        } else {
            if (cur) cur.textContent = '—';
        }
    }

    const dithEl = document.getElementById('seq-dither-status');
    if (dithEl && st.last_dither && st.last_dither.dx != null) {
        const d = st.last_dither;
        dithEl.style.display = '';
        let extra = '';
        if (d.guided === false) extra = ' — pas de guidage';
        else if (d.settle) {
            const s = d.settle;
            const rms = (s.rms != null) ? s.rms.toFixed(2) + '″' : '—';
            if (s.timed_out) extra = ` — settle non atteint (${s.waited}s, rms ${rms})`;
            else if (s.aborted) extra = ' — guidage interrompu';
            else if (s.waited && s.waited > 0) extra = ` — settlé ${s.waited}s (rms ${rms})`;
        }
        dithEl.textContent = `Dither : Δ(${d.dx.toFixed(1)}, ${d.dy.toFixed(1)})${extra}`;
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
}

