// ═══════════════════════════════════════════════════════════════
// Noctua — collimation.js (atelier Collimation — CollimAI)
// 2 sous-onglets : Inférence (actif partout) | Apprentissage (grisé sur RPi)
// ═══════════════════════════════════════════════════════════════

let _collimStatus = null;
let _collimStars = [];
let _collimSel = -1;
let _collimAuto = -1;

function initCollimationPanel() {
    // Sous-onglets Inférence / Apprentissage
    document.querySelectorAll('.collim-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.collim-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.collimTab;
            document.getElementById('collim-pane-infer').style.display = tab === 'infer' ? '' : 'none';
            document.getElementById('collim-pane-learn').style.display = tab === 'learn' ? '' : 'none';
        });
    });

    const btnPath = document.getElementById('collim-btn-path');
    if (btnPath) btnPath.addEventListener('click', collimLoadByPath);
    const inpPath = document.getElementById('collim-inp-path');
    if (inpPath) inpPath.addEventListener('keydown', e => { if (e.key === 'Enter') collimLoadByPath(); });

    const inpFile = document.getElementById('collim-inp-file');
    if (inpFile) inpFile.addEventListener('change', e => {
        if (e.target.files.length) collimUpload(e.target.files[0]);
    });

    const btnInfer = document.getElementById('collim-btn-infer');
    if (btnInfer) btnInfer.addEventListener('click', collimRunInfer);

    // Charger dernier bouton
    const btnReload = document.getElementById('collim-btn-reload');
    if (btnReload) btnReload.addEventListener('click', () => {
        const p = document.getElementById('collim-inp-path')?.value.trim();
        if (p) collimLoadByPath();
    });

    // Canvas click -> sélection étoile
    const cvs = document.getElementById('collim-field-canvas');
    if (cvs) cvs.addEventListener('click', collimFieldClick);

    refreshCollimStatus();
    loadCollimConfig();
    const btnSave = document.getElementById('collim-btn-save-config');
    if (btnSave) btnSave.addEventListener('click', saveCollimConfig);
    ['collim-hw-D','collim-hw-f'].forEach(id=>{
        const el=document.getElementById(id);
        if(el) el.addEventListener('input', updateCollimFd);
    });
    // rafraîchir status à chaque entrée dans le mode collimation
    Hub.subscribe('mode:changed', 'collimation', (env) => {
        if (env.payload.mode === 'collimation') { refreshCollimStatus(); loadCollimConfig(); }
    });
}

function updateCollimFd(){
    const D=parseFloat(document.getElementById('collim-hw-D')?.value||203);
    const f=parseFloat(document.getElementById('collim-hw-f')?.value||800);
    const fd=document.getElementById('collim-hw-fd');
    if(fd) fd.value = (f/D).toFixed(2);
}

async function loadCollimConfig(){
    try{
        const cfg = await fetch('/api/collimation/config').then(r=>r.json());
        if(cfg.error) return;
        const hw=cfg.hardware||{}, vis=cfg.vis||{}, ds=cfg.dataset||{};
        const set=(id,v)=>{ const e=document.getElementById(id); if(e&&v!==undefined) e.value=v; };
        set('collim-hw-D', hw.diametre_mm); set('collim-hw-f', hw.focale_mm);
        set('collim-hw-obs', hw.obstruction_ratio); set('collim-hw-ara', hw.n_araignees);
        set('collim-hw-ep', hw.epaisseur_araignee!==undefined? (hw.epaisseur_araignee*1000).toFixed(1) : 0.5);
        set('collim-hw-px', hw.pixel_size_um); set('collim-hw-patch', hw.patch_size_px);
        set('collim-hw-def', hw.defocus_waves); set('collim-hw-wl', hw.wavelength_um);
        set('collim-vis-s', vis.pas_secondaire_mm); set('collim-vis-p', vis.pas_primaire_mm);
        set('collim-vis-lev', vis.rayon_levier_mm);
        set('collim-ds-n', ds.n_samples); set('collim-ds-dec', ds.decenter_max_mm); set('collim-ds-tilt', ds.tilt_max_deg);
        updateCollimFd();
        // RPi -> disable inputs
        const isRpi = _collimStatus?.is_rpi;
        document.querySelectorAll('#collim-config-card input, #collim-btn-save-config').forEach(el=>{
            if(isRpi) el.setAttribute('disabled',''); else el.removeAttribute('disabled');
        });
        const warn=document.getElementById('collim-config-rpi-warn');
        if(warn) warn.style.display = isRpi ? '' : 'none';
    }catch(e){ console.warn('load config failed',e); }
}

async function saveCollimConfig(){
    const get=(id)=> parseFloat(document.getElementById(id)?.value);
    const cfg={
        hardware:{
            diametre_mm: get('collim-hw-D'), focale_mm: get('collim-hw-f'),
            obstruction_ratio: parseFloat(document.getElementById('collim-hw-obs')?.value||0.345),
            n_araignees: parseInt(document.getElementById('collim-hw-ara')?.value||4),
            epaisseur_araignee: get('collim-hw-ep')/1000,
            pixel_size_um: get('collim-hw-px'), patch_size_px: parseInt(document.getElementById('collim-hw-patch')?.value||128),
            defocus_waves: get('collim-hw-def'), wavelength_um: get('collim-hw-wl'),
            npix_pupil: 256
        },
        vis:{
            pas_secondaire_mm: get('collim-vis-s'), pas_primaire_mm: get('collim-vis-p'),
            rayon_levier_mm: get('collim-vis-lev')
        },
        dataset:{
            n_samples: parseInt(document.getElementById('collim-ds-n')?.value||10000),
            decenter_max_mm: get('collim-ds-dec'), tilt_max_deg: get('collim-ds-tilt')
        },
        train:{ epochs:40, batch_size:32, lr:1e-3 }
    };
    try{
        const r=await fetch('/api/collimation/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}).then(r=>r.json());
        if(r.error){ addLog('error','collimation', r.error); return; }
        const ok=document.getElementById('collim-config-saved');
        if(ok){ ok.style.display=''; setTimeout(()=>ok.style.display='none',2000); }
        addLog('info','collimation','Config instrument sauvegardée');
        refreshCollimStatus();
    }catch(e){ addLog('error','collimation', e.message); }
}

async function refreshCollimStatus() {
    try {
        const s = await fetch('/api/collimation/status').then(r => r.json());
        _collimStatus = s;
        const warn = document.getElementById('collim-warn-rpi');
        const learnPane = document.getElementById('collim-pane-learn');
        const learnTab = document.querySelector('.collim-tab[data-collim-tab="learn"]');
        const badgeRpi = document.getElementById('collim-badge-rpi');
        const badgeModel = document.getElementById('collim-badge-model');
        if (warn) warn.style.display = s.is_rpi ? '' : 'none';
        if (badgeRpi) {
            badgeRpi.style.display = s.is_rpi ? '' : 'none';
            badgeRpi.textContent = s.is_rpi ? '● RPi — apprentissage désactivé' : '';
        }
        if (badgeModel) {
            badgeModel.style.display = s.model_done ? '' : 'none';
            badgeModel.textContent = s.model_done ? '● Modèle prêt' : '○ Modèle manquant';
            badgeModel.style.color = s.model_done ? '#4a4' : '#a44';
        }
        // Griser apprentissage sur RPi (mais laisser visible en lecture)
        if (learnPane) {
            learnPane.style.opacity = s.is_rpi ? '0.55' : '1';
            // ne pas bloquer pointerEvents : lecture seule autorisée même sur RPi
        }
        if (learnTab) {
            learnTab.style.opacity = '1';
            learnTab.title = s.is_rpi ? 'Lecture seule sur RPi — génération sur Orion' : '';
        }

        // ── Instrument recap (inférence) ──
        const ds = s.dataset_info || {};
        const hw = ds.hardware || {};
        const vis = ds.vis || {};
        const recap = document.getElementById('collim-instrument-recap');
        if (recap) {
            const tel = ds.telescope || 'GSO Photon 8\" F4 — 203mm/800mm';
            const fd = (hw.focale_mm && hw.diametre_mm) ? (hw.focale_mm/hw.diametre_mm).toFixed(2) : '4.0';
            recap.innerHTML = `<b>Instrument modèle :</b> ${tel} — F/${fd} — Obstr. ${(hw.obstruction_ratio*100).toFixed(1)}% — Pixel ${hw.pixel_size_um}µm — Patch ${hw.patch_size_px}×${hw.patch_size_px} — Défocus ${hw.defocus_waves}λ — <b>Vis</b> sec M4 ${vis.pas_secondaire_mm}mm/tr / prim M6 ${vis.pas_primaire_mm}mm/tr — levier ${vis.rayon_levier_mm}mm`
                + (s.model_done ? ' <span style="color:#4a4">● modèle 200/800 prêt</span>' : ' <span style="color:#a44">○ modèle manquant</span>');
        }

        // ── Dataset recap (apprentissage) ──
        const dsRecap = document.getElementById('collim-dataset-recap');
        if (dsRecap) {
            if (ds.exists) {
                dsRecap.innerHTML = `<b>Dataset artificiel 200/800 déjà généré :</b> ${ds.n_samples} PSF 128×128 (decenter ±${ds.decenter_range}mm, tilt ±${ds.tilt_range}°) — <b>Optique</b> Ø${hw.diametre_mm}mm F${hw.focale_mm}mm F/${(hw.focale_mm/hw.diametre_mm).toFixed(2)} — Obstr ${Math.round(hw.obstruction_ratio*100)}% — Pixel ${hw.pixel_size_um}µm — Défocus ${hw.defocus_waves}λ`;
            } else {
                dsRecap.innerHTML = `Aucun dataset local — générez sur Orion : <code>python generate_psf_dataset.py --n 10000</code>`;
            }
        }
        const dsStats = document.getElementById('collim-dataset-stats');
        if (dsStats) {
            dsStats.innerHTML = ds.exists
                ? `Échantillons : <b>${ds.n_samples}</b> (3969 dispo, 268M)<br>Patch ${hw.patch_size_px}×${hw.patch_size_px} — Défocus ${hw.defocus_waves}λ<br>Preview : <a href="/api/collimation/dataset/preview" target="_blank" style="color:#0af">preview.png 2.7M</a>`
                : `Aucun — à générer sur Orion`;
        }
        const trStats = document.getElementById('collim-train-stats');
        if (trStats) {
            const m = s.metrics;
            if (m) {
                trStats.innerHTML = `best_model.pt 3.2M — ${m.n_params||812900} params<br>Val loss ${Number(m.best_val_loss||0).toFixed(4)} — err dec ${Number(m.err_decenter_mm||0).toFixed(2)}mm — tilt ${Number(m.err_tilt_deg||0).toFixed(3)}°`;
            } else if (s.model_done) {
                trStats.innerHTML = `Modèle présent (metrics.json manquant)`;
            } else {
                trStats.innerHTML = `Modèle à entraîner`;
            }
        }
        const previewMeta = document.getElementById('collim-preview-meta');
        if (previewMeta && ds.exists) {
            previewMeta.textContent = `${ds.n_samples} PSF simulées Poppy — hardware ${hw.diametre_mm}mm/${hw.focale_mm}mm — 268M sur disque`;
        }
    } catch (e) {
        console.warn('collim status failed', e);
    }
}

async function collimLoadByPath() {
    const inp = document.getElementById('collim-inp-path');
    const path = inp ? inp.value.trim() : '';
    if (!path) { addLog('warning','collimation','Chemin vide'); return; }
    await collimProcessPath(path);
}

async function collimUpload(file) {
    const fd = new FormData();
    fd.append('file', file);
    setCollimStep(1, 'active');
    document.getElementById('collim-field-info').textContent = 'Upload + détection...';
    try {
        const r = await fetch('/api/collimation/infer/upload', { method: 'POST', body: fd }).then(r=>r.json());
        if (r.error) { addLog('error','collimation', r.error); setCollimStep(1,'error'); return; }
        collimHandleStars(r);
    } catch (e) {
        addLog('error','collimation', e.message);
    }
}

async function collimProcessPath(path) {
    setCollimStep(1, 'active');
    const info = document.getElementById('collim-field-info');
    if (info) info.textContent = 'Chargement + détection...';
    try {
        const r = await fetch('/api/collimation/infer/load_path', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({path})
        }).then(r=>r.json());
        if (r.error) {
            addLog('error','collimation', r.error);
            setCollimStep(1,'error');
            if (info) info.textContent = 'Erreur: ' + r.error;
            return;
        }
        collimHandleStars(r);
    } catch (e) {
        addLog('error','collimation', e.message);
    }
}

function collimHandleStars(data) {
    _collimStars = data.stars || [];
    _collimAuto = -1; _collimSel = -1;
    let best=-1, bestS=0;
    _collimStars.forEach((s,i)=>{
        if (!s.candidate) return;
        const sc = (1 - s.ellip/0.2) * (Math.min(s.adu,52000)/52000);
        if (sc > bestS) {bestS=sc; best=i;}
    });
    _collimAuto = best; _collimSel = best;
    setCollimStep(1,'done'); setCollimStep(2,'done');
    if (best>=0) setCollimStep(3,'done'); else setCollimStep(3,'active');
    const info = document.getElementById('collim-field-info');
    if (info) info.textContent = `${_collimStars.length} étoiles — ${ _collimStars.filter(s=>s.candidate).length} candidates — ${data.width||'?'}x${data.height||'?'} px`;
    buildCollimStarTable(); drawCollimField();
    const selCard = document.getElementById('collim-star-table-card');
    if (selCard) selCard.style.display = _collimStars.length ? '' : 'none';
    const reload = document.getElementById('collim-btn-reload');
    if (reload) reload.style.display = '';
    if (best>=0) showCollimStar(best);
    else {
        document.getElementById('collim-psf-panel').style.display='none';
    }
}

function buildCollimStarTable() {
    const tb = document.getElementById('collim-star-tbody');
    if (!tb) return;
    tb.innerHTML='';
    _collimStars.forEach((s,i)=>{
        const tr=document.createElement('tr');
        if (i===_collimSel) tr.className='sel';
        tr.style.cursor='pointer';
        tr.addEventListener('click', ()=>{ _collimSel=i; showCollimStar(i); drawCollimField(); buildCollimStarTable(); });
        const isAuto = _collimAuto===i;
        tr.innerHTML=`<td>${i+1}</td><td>${s.zone}</td><td>${(s.adu/1000).toFixed(1)}k</td><td style="color:${s.ellip>0.15?'#f66':'inherit'}">${s.ellip.toFixed(3)}</td><td>${s.dist_r}%</td><td>${isAuto?'<span style="color:#4a4">● auto</span>':(i===_collimSel?'<span style="color:#88f">sélect.</span>':'')}</td>`;
        tb.appendChild(tr);
    });
}

function drawCollimField() {
    const cvs = document.getElementById('collim-field-canvas');
    if (!cvs) return;
    const ctx=cvs.getContext('2d'); const S=cvs.width;
    ctx.fillStyle='#05080f'; ctx.fillRect(0,0,S,S);
    // étoiles de fond
    for(let i=0;i<120;i++){ ctx.beginPath(); ctx.arc(Math.random()*S,Math.random()*S,Math.random()*0.7+0.2,0,Math.PI*2); ctx.fillStyle=`rgba(255,255,255,${Math.random()*0.4+0.1})`; ctx.fill(); }
    // zone centrale
    ctx.beginPath(); ctx.arc(S/2,S/2,S*0.2,0,Math.PI*2); ctx.strokeStyle='rgba(0,255,180,0.35)'; ctx.setLineDash([4,3]); ctx.lineWidth=1; ctx.stroke(); ctx.setLineDash([]);
    if (!_collimStars.length) return;
    // Déduire dimensions image
    const W = _collimStatus?.infer?.width || S;
    const H = _collimStatus?.infer?.height || S;
    // fallback data.width stocké dans _collimStars ? use W from last detection
    const imgW = W || S, imgH = H || S;
    _collimStars.forEach((s,i)=>{
        const px=s.x/imgW*S, py=s.y/imgH*S;
        const isSel=_collimSel===i;
        const r=Math.max(2,Math.min(6,s.adu/65535*6+1.5));
        ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2); ctx.fillStyle=isSel?'#fff':'rgba(255,215,140,0.9)'; ctx.fill();
        if(isSel){ ctx.beginPath(); ctx.arc(px,py,r+5,0,Math.PI*2); ctx.strokeStyle='#0f8'; ctx.lineWidth=1.2; ctx.stroke(); }
        else if(s.candidate){ ctx.beginPath(); ctx.arc(px,py,r+4,0,Math.PI*2); ctx.strokeStyle='rgba(0,255,140,0.45)'; ctx.lineWidth=1; ctx.stroke(); }
    });
}

function collimFieldClick(e) {
    if (!_collimStars.length) return;
    const cvs=e.target; const rect=cvs.getBoundingClientRect();
    const S=cvs.width;
    const mx=(e.clientX-rect.left)/rect.width*S, my=(e.clientY-rect.top)/rect.height*S;
    const W=_collimStatus?.infer?.width||S, H=_collimStatus?.infer?.height||S;
    let best=-1,bd=22;
    _collimStars.forEach((s,i)=>{
        const px=s.x/W*S, py=s.y/H*S;
        const d=Math.hypot(mx-px, my-py);
        if(d<bd){bd=d; best=i;}
    });
    if(best>=0){ _collimSel=best; showCollimStar(best); drawCollimField(); buildCollimStarTable(); }
}

function showCollimStar(i) {
    const s=_collimStars[i];
    const pane=document.getElementById('collim-psf-panel');
    if(pane) pane.style.display='';
    const info=document.getElementById('collim-star-info');
    if(info) info.innerHTML=`<div>Étoile #${i+1} — ${s.zone} — ADU ${(s.adu).toLocaleString('fr-FR')} — ellip ${s.ellip.toFixed(3)}</div><div>dist ${s.dist_r}% — flux ${s.flux}</div>`;
    setCollimStep(3,'done'); setCollimStep(4,'idle');
}

function setCollimStep(n, cls) {
    const sn=document.getElementById('collim-sn'+n);
    const sl=document.getElementById('collim-sl'+n);
    if(sn){ sn.className='collim-sn s-'+cls; sn.textContent=cls==='done'?'✓':cls==='error'?'✗':n; }
    if(sl){ sl.style.color=cls==='idle'?'#666':cls==='done'?'#aaa':cls==='error'?'#f66':cls==='active'?'#0ff':'#ccc'; }
}

async function collimRunInfer() {
    if (_collimSel<0) { addLog('warning','collimation','Sélectionnez une étoile'); return; }
    const btn=document.getElementById('collim-btn-infer');
    if(btn) btn.disabled=true;
    setCollimStep(4,'active');
    const prog=document.getElementById('collim-infer-prog');
    if(prog) prog.style.display='';
    try {
        const r=await fetch('/api/collimation/infer/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({star_idx:_collimSel})}).then(r=>r.json());
        if(prog) prog.style.display='none';
        if(btn) btn.disabled=false;
        if(r.error){ addLog('error','collimation', r.error); setCollimStep(4,'error'); return; }
        setCollimStep(4,'done');
        showCollimResult(r.result);
        addLog('info','collimation',`ColScore ${(r.result.collimation_score*100).toFixed(0)}% — dx ${r.result.decenter_x_mm}mm dy ${r.result.decenter_y_mm}mm`);
    } catch(e){
        if(prog) prog.style.display='none';
        if(btn) btn.disabled=false;
        setCollimStep(4,'error');
        addLog('error','collimation', e.message);
    }
}

function showCollimResult(r) {
    const pane=document.getElementById('collim-result-panel');
    if(pane) pane.style.display='';
    const fmt=(v,u)=>`${v>0?'+':''}${v} ${u}`;
    const el=(id,val)=>{ const e=document.getElementById(id); if(e) e.textContent=val; };
    el('collim-r-dx', fmt(r.decenter_x_mm,'mm'));
    el('collim-r-dy', fmt(r.decenter_y_mm,'mm'));
    el('collim-r-tx', fmt(r.tilt_x_deg,'°'));
    el('collim-r-ty', fmt(r.tilt_y_deg,'°'));
    el('collim-r-score', r.collimation_score);
    const badge=document.getElementById('collim-result-badge');
    if(badge){
        const sc=r.collimation_score;
        if(sc<0.15){ badge.textContent='● Excellent'; badge.style.color='#4a4'; }
        else if(sc<0.45){ badge.textContent='● Correction légère'; badge.style.color='#fa0'; }
        else{ badge.textContent='● Recollimation nécessaire'; badge.style.color='#f44'; }
    }
    const vis=document.getElementById('collim-vis-list');
    if(vis){
        const cv=r.correction_vis||{};
        const rows=[
            ['S vis1 (haut)', cv.secondaire_vis1_tours],
            ['S vis2 (bas-G)', cv.secondaire_vis2_tours],
            ['S vis3 (bas-D)', cv.secondaire_vis3_tours],
            ['P vis1 (haut)', cv.primaire_vis1_tours],
            ['P vis2 (bas-G)', cv.primaire_vis2_tours],
            ['P vis3 (bas-D)', cv.primaire_vis3_tours],
        ];
        vis.innerHTML = rows.map(([name,v])=>{
            const col = Math.abs(v)<0.05 ? '#666' : (v>0?'#4af':'#f66');
            return `<div style="display:flex;justify-content:space-between;font-size:0.65rem;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04)"><span>${name}</span><span style="color:${col};font-family:monospace">${v>0?'+':''}${v} tr (${Math.round(v*360)}°)</span></div>`;
        }).join('');
    }
}
