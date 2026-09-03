// ═══════════════════════════════════════════════════════════════
// Noctua — aberration.js (atelier Aberration & Tilt)
// 1 onglet (mode aberration) + 2 sous-onglets : Aberrations | Tilt capteur
// Réutilise le viewer capture (captureViewer) + permet charger une image.
// ═══════════════════════════════════════════════════════════════

let _aberrLast = null;

function initAberrationPanel() {
    document.querySelectorAll('.aberr-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.aberr-tab').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.aberrTab;
            document.getElementById('aberr-pane-aber').style.display = tab==='aber' ? '' : 'none';
            document.getElementById('aberr-pane-tilt').style.display = tab==='tilt' ? '' : 'none';
        });
    });

    const btnLast = document.getElementById('aberr-btn-last');
    if (btnLast) btnLast.addEventListener('click', () => aberrAnalyze('last'));
    const btnPath = document.getElementById('aberr-btn-path');
    if (btnPath) btnPath.addEventListener('click', () => {
        const p=document.getElementById('aberr-inp-path')?.value.trim();
        if(p) aberrAnalyze('load_path', p);
    });
    const inpPath = document.getElementById('aberr-inp-path');
    if (inpPath) inpPath.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const p=inpPath.value.trim(); if(p) aberrAnalyze('load_path', p); }});
    const inpFile = document.getElementById('aberr-inp-file');
    if (inpFile) inpFile.addEventListener('change', e=>{ if(e.target.files.length) aberrUpload(e.target.files[0]); });

    // Viewer : brancher le canvas capture déjà existant (applet-capture-preview)
    // On affiche les étoiles détectées en overlay sur le viewer capture
    Hub.subscribe('mode:changed', 'aberration', (env)=>{
        if(env.payload.mode==='aberration') aberrRefreshStatus();
    });
    aberrRefreshStatus();
}

async function aberrRefreshStatus(){
    try{
        const s=await fetch('/api/aberration/status').then(r=>r.json());
        const hdr=document.getElementById('aberr-header-info');
        if(hdr){
            if(s.has_last_image){
                const h=s.last_header||{};
                const keys=['OBJECT','IMAGETYP','FILTER','EXPTIME','INSTRUME','FOCALLEN','XBINNING'];
                const parts=keys.filter(k=>h[k]).map(k=>`${k}=${h[k]}`);
                hdr.textContent = parts.length ? parts.join(' · ') : 'Dernière capture disponible — header minimal';
                hdr.style.color='#0f8';
            } else {
                hdr.textContent='Aucune capture — chargez un FITS ou capturez depuis Capture/Séquenceur';
                hdr.style.color='#888';
            }
        }
    }catch(e){ console.warn(e); }
}

async function aberrAnalyze(source, pathOrData){
    const info=document.getElementById('aberr-info');
    const resEl=document.getElementById('aberr-results');
    if(info) info.textContent='Analyse en cours...';
    if(resEl) resEl.style.display='none';
    try{
        let body={source};
        if(source==='load_path') body.path=pathOrData;
        if(source==='base64') { body.data=pathOrData; body.filename='upload.fits'; }
        const r=await fetch('/api/aberration/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
        if(!r.ok){ if(info) info.textContent='Erreur: '+(r.error||'?'); addLog('error','aberration', r.error); return; }
        _aberrLast=r;
        renderAberrResults(r);
        if(info) info.textContent=`${r.global.star_count} étoiles — ${r.filename} — ${r.width}×${r.height}`;
        addLog('info','aberration',`Analyse ${r.global.star_count} étoiles — HFR ${r.global.hfr_mean} — tilt ${r.global.tilt_mag}`);
    }catch(e){
        if(info) info.textContent='Erreur: '+e.message;
        addLog('error','aberration', e.message);
    }
}

async function aberrUpload(file){
    const info=document.getElementById('aberr-info');
    if(info) info.textContent='Upload + analyse...';
    try{
        const fd=new FormData(); fd.append('file', file);
        const r=await fetch('/api/aberration/upload',{method:'POST', body:fd}).then(r=>r.json());
        if(!r.ok){ if(info) info.textContent='Erreur: '+(r.error||'?'); return; }
        _aberrLast=r;
        renderAberrResults(r);
        if(info) info.textContent=`${r.global.star_count} étoiles — ${r.filename}`;
    }catch(e){ if(info) info.textContent='Erreur: '+e.message; }
}

function renderAberrResults(r){
    const resEl=document.getElementById('aberr-results');
    if(!resEl) return;
    resEl.style.display='';
    const g=r.global;
    const set=(id,val)=>{ const e=document.getElementById(id); if(e) e.textContent=val; };
    set('aberr-hfr', g.hfr_mean); set('aberr-fwhm', g.fwhm_mean);
    set('aberr-ellip', g.ellip_mean); set('aberr-coma', g.coma_mean);
    set('aberr-tilt-mag', g.tilt_mag); set('aberr-tilt-dx', g.tilt_dx); set('aberr-tilt-dy', g.tilt_dy);
    set('aberr-quality', g.quality);
    const qEl=document.getElementById('aberr-quality');
    if(qEl){
        const col = g.quality==='good' ? '#4a4' : g.quality==='tilt' ? '#fa0' : g.quality==='coma' ? '#f66' : '#88f';
        qEl.style.color=col;
    }
    // Tableau étoiles
    const tb=document.getElementById('aberr-star-tbody');
    if(tb){
        tb.innerHTML='';
        (r.stars||[]).slice(0,30).forEach((s,i)=>{
            const tr=document.createElement('tr');
            tr.innerHTML=`<td>${i+1}</td><td style="font-family:monospace">${s.x},${s.y}</td><td>${s.hfr}</td><td>${s.fwhm}</td><td>${s.ellip}</td><td>${s.coma_mag}</td><td>${s.snr}</td>`;
            tb.appendChild(tr);
        });
    }
    // Header FITS
    const hdrEl=document.getElementById('aberr-header-detail');
    if(hdrEl){
        const hdr=r.header||{};
        const keys=Object.keys(hdr).slice(0,16);
        hdrEl.innerHTML = keys.length ? keys.map(k=>`<span style="color:#0af">${k}</span>=${hdr[k]}`).join(' · ') : 'Header minimal';
    }
    // Tilt canvas heatmap simple (HFR gradient)
    drawTiltCanvas(r);

    // Met à jour le viewer capture avec l'image analysée si possible
    // Le viewer affiche déjà la dernière capture ; on overlay les étoiles
    overlayStarsOnViewer(r.stars||[]);
}

function drawTiltCanvas(r){
    const cvs=document.getElementById('aberr-tilt-canvas');
    if(!cvs) return;
    const ctx=cvs.getContext('2d');
    const W=cvs.width, H=cvs.height;
    ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const g=r.global;
    // flèche tilt
    if(g && (g.tilt_dx||g.tilt_dy)){
        const cx=W/2, cy=H/2;
        const scale=80;
        const dx=g.tilt_dx*scale, dy=g.tilt_dy*scale;
        ctx.strokeStyle='#fa0'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+dx, cy+dy); ctx.stroke();
        ctx.fillStyle='#fa0'; ctx.beginPath(); ctx.arc(cx+dx, cy+dy, 4, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle='#888'; ctx.font='10px monospace'; ctx.fillText(`tilt ${g.tilt_mag}`, 6, 12);
    }
    // points étoiles colorés par HFR
    (r.stars||[]).forEach(s=>{
        const x=s.x / r.width * W;
        const y=s.y / r.height * H;
        const hfr=s.hfr||0;
        const col = hfr>4 ? '#f66' : hfr>2.5 ? '#fa0' : '#0f8';
        ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
    });
}

function overlayStarsOnViewer(stars){
    // Utilise le canvas overlay du viewer capture si dispo
    const ovl=document.getElementById('aberr-viewer-overlay');
    if(!ovl || !stars.length) return;
    const ctx=ovl.getContext('2d');
    const W=ovl.width, H=ovl.height;
    ctx.clearRect(0,0,W,H);
    // On suppose que l'image viewer est à l'échelle ; on mappe simplement
    // Ici on dessine des cercles pour debug
    ctx.strokeStyle='rgba(0,255,140,0.7)'; ctx.lineWidth=1;
    stars.slice(0,40).forEach(s=>{
        // Approximate mapping : stars coords sont en px image, viewer peut être stretch
        // On dessine en overlay 1:1 pour l'instant
        ctx.beginPath(); ctx.arc(s.x % W, s.y % H, 6, 0, Math.PI*2); ctx.stroke();
    });
}
