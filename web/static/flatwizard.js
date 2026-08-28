// ═══════════════════════════════════════════════════════════════
// Noctua — flatwizard.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── FLAT WIZARD (auto-calibration des flats vers un ADU cible) ─

let _fwAutoRunning = false;

function fwCamera() {
    if (typeof selectedCamera !== 'undefined' && selectedCamera?.name) return selectedCamera.name;
    return document.getElementById('fw-device')?.value || undefined;
}

function fwSetMsg(txt) {
    const el = document.getElementById('fw-status');
    if (el) el.textContent = txt || '';
}

function fwApply(st) {
    if (!st) return;
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el && v !== undefined && v !== null) el.textContent = v;
    };
    set('fw-st-toptext', `Cible ${st.target_adu} ADU ±${(st.tolerance * 100).toFixed(0)}%`);
    set('fw-st-duration', st.duration + ' s');
    set('fw-st-lastadu', st.last_adu != null ? st.last_adu + ' ADU' : '—');
    set('fw-st-step', `${st.step} / ${st.max_steps}`);
    set('fw-st-done', st.done ? 'OUI' : 'non');
    const btn = document.getElementById('fw-step');
    if (btn) btn.disabled = !!st.done;
    if (st.done) fwSetMsg(st.msg || 'Convergé.');
}

function initFlatWizard() {
    const toggleBtn = document.getElementById('fw-config-toggle');
    const fwBody = document.getElementById('fw-body');
    if (toggleBtn && fwBody) {
        toggleBtn.addEventListener('click', () => {
            const open = fwBody.style.display !== 'none';
            fwBody.style.display = open ? 'none' : '';
            fwToggleRefresh(!open);
        });
    }

    document.getElementById('fw-configure')?.addEventListener('click', fwConfigure);
    document.getElementById('fw-step')?.addEventListener('click', fwStep);
    document.getElementById('fw-auto')?.addEventListener('click', fwToggleAuto);
    document.getElementById('fw-reset')?.addEventListener('click', fwReset);
    fwPollStatus();
}

function fwToggleRefresh(open) {
    const t = document.getElementById('fw-config-toggle');
    if (!t) return;
    t.classList.toggle('stacking-on', !!open);
    if (open) requestAnimationFrame(() => { if (typeof resolvePanelLayout === 'function') resolvePanelLayout(); });
}

async function fwPollStatus() {
    try {
        const st = await fetch('/api/camera/flat-wizard/status').then(r => r.json());
        fwApply(st);
    } catch (e) { /* caméra pas prête */ }
}

async function fwConfigure() {
    const body = {
        target_adu: parseFloat(document.getElementById('fw-adu')?.value) || 22000,
        tolerance: (parseFloat(document.getElementById('fw-tolerance')?.value) || 5) / 100,
        start_duration: parseFloat(document.getElementById('fw-start')?.value) || 1.0,
        min_duration: parseFloat(document.getElementById('fw-min')?.value) || 0,
        max_duration: parseFloat(document.getElementById('fw-max')?.value) || 30,
        filter: document.getElementById('fw-filter')?.value || null,
        binning: document.getElementById('fw-binning')?.value || '1x1',
    };
    try {
        const st = await fetch('/api/camera/flat-wizard/configure', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());
        fwApply(st);
        fwSetMsg('Configuration enregistrée — prêt à poser.');
    } catch (e) {
        fwSetMsg('Erreur de configuration : ' + e);
    }
}

async function fwStep() {
    const btn = document.getElementById('fw-step');
    if (btn) btn.disabled = true;
    fwSetMsg('Pose en cours, veuillez patienter…');
    try {
        const r = await fetch('/api/camera/flat-wizard/step', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: fwCamera() }),
        }).then(r => r.json());
        if (r.ok === false || r.error) {
            fwSetMsg('❌ ' + (r.error || 'Erreur de pose'));
        } else {
            fwApply(r);
            if (r.done) fwSetMsg('✅ ' + (r.msg || 'Convergé / terminé'));
            else fwSetMsg(`ADU mesuré ${r.measured_adu} → prochaine durée ${r.duration}s`);
        }
    } catch (e) {
        fwSetMsg('❌ Pose impossible : ' + e);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function fwToggleAuto() {
    const btn = document.getElementById('fw-auto');
    const stBtn = document.getElementById('fw-step');
    if (_fwAutoRunning) {
        _fwAutoRunning = false;
        if (btn) { btn.textContent = '⏵ AUTO'; btn.classList.remove('danger'); }
        if (stBtn) stBtn.disabled = false;
        return;
    }
    _fwAutoRunning = true;
    if (btn) { btn.textContent = '⏹ STOP'; btn.classList.add('danger'); }
    try {
        let current = await fetch('/api/camera/flat-wizard/status').then(r => r.json());
        while (_fwAutoRunning && current && !current.done) {
            const r = await fetch('/api/camera/flat-wizard/step', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: fwCamera() }),
            }).then(x => x.json());
            if (r.ok === false || r.error) { fwSetMsg('❌ ' + (r.error || 'Erreur')); break; }
            fwApply(r);
            current = r;
            if (!r.done) {
                await new Promise(res => setTimeout(res, 400));
            }
        }
    } catch (e) {
        fwSetMsg('❌ ' + e);
    } finally {
        _fwAutoRunning = false;
        if (btn) { btn.textContent = '⏵ AUTO'; btn.classList.remove('danger'); }
        if (stBtn) stBtn.disabled = false;
    }
}

async function fwReset() {
    try {
        const st = await fetch('/api/camera/flat-wizard/reset', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).then(r => r.json());
        fwApply(st);
        fwSetMsg('Wizard réinitialisé.');
    } catch (e) {
        fwSetMsg('Erreur reset : ' + e);
    }
}
