// ═══════════════════════════════════════════════════════════════
// Noctua — pointing.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── POINTING MODEL (collecte des erreurs de pointage, IDW) ─────

function ptSetStatus(txt) {
    const el = document.getElementById('pt-status');
    if (el) el.textContent = txt || '';
}

function ptApply(st) {
    if (!st) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pt-count', st.sample_count ?? '0');
    const rows = st.samples || [];
    const tbody = document.getElementById('pt-rows');
    if (tbody) {
        tbody.innerHTML = rows.map(s =>
            `<tr><td>${s.ra.toFixed(2)}°</td><td>${s.dec.toFixed(2)}°</td>` +
            `<td>${s.dra.toFixed(3)}°</td><td>${s.ddec.toFixed(3)}°</td></tr>`
        ).join('') || '<tr><td colspan="4" style="opacity:.5">Aucun échantillon</td></tr>';
    }
    ptApplyFit(st.model_fit);
}

function ptApplyFit(fit) {
    const info = document.getElementById('pt-fit-info');
    const coefs = document.getElementById('pt-fit-coefs');
    if (!info) return;
    if (!fit || !fit.active) {
        info.textContent = fit && fit.error
            ? 'Modèle inactif : ' + fit.error
            : 'Ajuster le modèle après avoir collecté des échantillons.';
        if (coefs) coefs.style.display = 'none';
        return;
    }
    info.textContent = `Actif · ${fit.fit_n} étoiles · RMS ${fit.rms_arcmin?.toFixed(2) ?? '—'}'`;
    if (coefs) {
        const fmt = (arr, lbl) => arr
            ? `${lbl}: [${arr.map(c => c.toFixed(3)).join(', ')}]`
            : '';
        coefs.textContent = [fmt(fit.coefs_ra, 'ΔRA'), fmt(fit.coefs_dec, 'ΔDEC')]
            .filter(Boolean).join('\n');
        coefs.style.display = 'block';
    }
}

function initPointingPanel() {
    document.getElementById('pt-add')?.addEventListener('click', ptAdd);
    document.getElementById('pt-correct')?.addEventListener('click', ptCorrect);
    document.getElementById('pt-clear')?.addEventListener('click', ptClear);
    document.getElementById('pt-fit')?.addEventListener('click', ptFit);
    ptPollStatus();
}

async function ptPollStatus() {
    try {
        const st = await fetch('/api/pointing/status').then(r => r.json());
        ptApply(st);
    } catch (e) { /* ignoré */ }
}

async function ptAdd() {
    const body = {
        ra_deg: parseFloat(document.getElementById('pt-ra')?.value) || 0,
        dec_deg: parseFloat(document.getElementById('pt-dec')?.value) || 0,
        delta_ra_deg: parseFloat(document.getElementById('pt-dra')?.value) || 0,
        delta_dec_deg: parseFloat(document.getElementById('pt-ddec')?.value) || 0,
    };
    try {
        const r = await fetch('/api/pointing/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(x => x.json());
        if (r.ok) { ptApply(r); ptSetStatus('Échantillon ajouté.'); }
        else ptSetStatus('❌ ' + (r.error || 'Erreur'));
    } catch (e) { ptSetStatus('❌ ' + e); }
}

async function ptCorrect() {
    const body = {
        ra_deg: parseFloat(document.getElementById('pt-c-ra')?.value) || 0,
        dec_deg: parseFloat(document.getElementById('pt-c-dec')?.value) || 0,
    };
    try {
        const r = await fetch('/api/pointing/correct', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(x => x.json());
        if (r.ok === false) ptSetStatus('Pas encore d’échantillons pour interpeler.');
        else {
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('pt-c-dra', r.delta_ra.toFixed(3) + '°');
            set('pt-c-ddec', r.delta_dec.toFixed(3) + '°');
            ptSetStatus(`Interpolation sur ${r.samples} échantillons (poids ${r.weight?.toFixed(3) ?? '—'}).`);
        }
    } catch (e) { ptSetStatus('❌ ' + e); }
}

async function ptClear() {
    try {
        const r = await fetch('/api/pointing/clear', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).then(x => x.json());
        ptApply(r);
        ptSetStatus('Modèle de pointage vidé.');
    } catch (e) { ptSetStatus('❌ ' + e); }
}

async function ptFit() {
    try {
        const r = await fetch('/api/pointing/fit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).then(x => x.json());
        ptApply(r);
        if (r.ok) ptSetStatus(`Modèle ajusté sur ${r.model_fit?.fit_n ?? r.fit_n ?? 0} étoiles (RMS ${r.rms_arcmin?.toFixed(2) ?? '—'}' ).`);
        else ptSetStatus('❌ ' + (r.error || 'Ajustement impossible'));
    } catch (e) { ptSetStatus('❌ ' + e); }
}
