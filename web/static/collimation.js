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
    // rafraîchir status à chaque entrée dans le mode collimation
    Hub.subscribe('mode:changed', 'collimation', (env) => {
        if (env.payload.mode === 'collimation') refreshCollimStatus();
    });
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
        // Griser apprentissage sur RPi
        if (learnPane) {
            learnPane.style.opacity = s.is_rpi ? '0.45' : '1';
            learnPane.style.pointerEvents = s.is_rpi ? 'none' : '';
        }
        if (learnTab) {
            learnTab.style.opacity = s.is_rpi ? '0.5' : '1';
            learnTab.title = s.is_rpi ? 'Désactivé sur RPi — lancer sur Orion' : '';
        }
        // Désactiver boutons apprentissage
        document.querySelectorAll('#collim-pane-learn button, #collim-pane-learn input').forEach(el => {
            if (s.is_rpi) el.setAttribute('disabled','');
            else el.removeAttribute('disabled');
        });
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
