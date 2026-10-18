// ═══════════════════════════════════════════════════════════════
// Noctua — aberration.js (atelier Aberration & Tilt)
// 1 onglet (mode aberration) + 2 sous-onglets : Aberrations | Tilt capteur
// Réutilise le viewer capture (captureViewer) + overlay aberr sur l'aperçu.
// Grille déformée (tilt) + flèches coma + ellipses (options)
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
            document.getElementById('aberr-pane-dist').style.display = tab==='dist' ? '' : 'none';
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
    if (inpFile) inpFile.addEventListener('change', e=>{
        if(e.target.files.length){
            const f=e.target.files[0];
            aberrUpload(f);
            // reset pour permettre re-sélection du même fichier
            e.target.value='';
        }
    });

    // Drag & drop sur l'aperçu et sur l'applet aberration
    const dropTargets = [document.getElementById('cap-preview-viewport'), document.getElementById('applet-aberration')].filter(Boolean);
    dropTargets.forEach(el=>{
        el.addEventListener('dragover', e=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; el.style.outline='2px dashed #0ff'; });
        el.addEventListener('dragleave', ()=>{ el.style.outline=''; });
        el.addEventListener('drop', e=>{
            e.preventDefault(); el.style.outline='';
            const f=e.dataTransfer.files && e.dataTransfer.files[0];
            if(f) aberrUpload(f);
        });
    });

    // Options overlay
    ['aberr-opt-grid','aberr-opt-arrows','aberr-opt-ellip'].forEach(id=>{
        const el=document.getElementById(id);
        if(el) el.addEventListener('change', ()=>{ if(_aberrLast) aberrDrawPreviewOverlay(_aberrLast); });
    });

    // Distorsion (solve astrométrique)
    const btnDist=document.getElementById('aberr-btn-dist');
    if(btnDist) btnDist.addEventListener('click', ()=>aberrDistAnalyze());

    Hub.subscribe('mode:changed', 'aberration', (env)=>{
        if(env.payload.mode==='aberration'){
            aberrRefreshStatus();
            // s'assure que le viewer est en mode aberration (preview + overlays)
            if(window.captureViewer) captureViewer.configure('aberration');
            // redessine l'overlay si on revient sur l'atelier
            if(_aberrLast) setTimeout(()=>aberrDrawPreviewOverlay(_aberrLast), 150);
        }
    });
    Hub.subscribe('ws:image', 'aberration', (env)=>{
        if(currentMode==='aberration' && env.payload.device){
            aberrRefreshStatus();
        }
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

// ── Preview helpers ───────────────────────────────────────────
async function aberrShowPreviewFile(file){
    try{
        if(window.captureViewer && currentMode==='aberration'){
            captureViewer.configure('aberration');
        }
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const ext = (file.name.split('.').pop()||'').toLowerCase();
        const fmt = (ext==='fit'||ext==='fits') ? 'image/fits' : (file.type||'application/octet-stream');
        if(window.captureViewer){
            captureViewer.render(bytes, fmt);
            // Assure que l'applet est visible
            const appCap = document.getElementById('applet-capture-preview');
            if(appCap && appCap.style.display==='none'){
                appCap.style.display='';
                if(appCap.classList.contains('collapsed')) appCap.classList.remove('collapsed');
            }
        }
        addLog('info','aberration',`Aperçu: ${file.name} ${(bytes.length/1048576).toFixed(1)} Mo`);
    }catch(e){
        console.warn('preview file failed', e);
        addLog('error','aberration',`Aperçu échoué: ${e.message}`);
    }
}

async function aberrShowPreviewPath(path){
    try{
        if(window.captureViewer && currentMode==='aberration'){
            captureViewer.configure('aberration');
        }
        let fetchPath = path.trim();
        // Nettoie les guillemets éventuels copiés depuis un terminal
        if(fetchPath.startsWith('"') && fetchPath.endsWith('"')) fetchPath=fetchPath.slice(1,-1);
        if(fetchPath.startsWith("'") && fetchPath.endsWith("'")) fetchPath=fetchPath.slice(1,-1);
        const resp = await fetch(`/api/aberration/image?path=${encodeURIComponent(fetchPath)}`);
        if(!resp.ok){
            const txt=await resp.text().catch(()=>resp.statusText);
            console.warn('preview path failed', resp.status, txt);
            // Si dossier, on ne peut pas prévisualiser directement ; l'analyse choisira le fichier
            if(resp.status===404){
                addLog('warning','aberration',`Aperçu: ${fetchPath} introuvable côté serveur — vérifiez le chemin (serveur) ou utilisez «Fichier FITS...» pour un fichier local`);
            }
            return;
        }
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const ext = (fetchPath.split('.').pop()||'').toLowerCase();
        const fmt = (ext==='fit'||ext==='fits') ? 'image/fits' : 'application/octet-stream';
        if(window.captureViewer){
            captureViewer.render(bytes, fmt);
            const appCap = document.getElementById('applet-capture-preview');
            if(appCap && appCap.style.display==='none') appCap.style.display='';
        }
        addLog('info','aberration',`Aperçu serveur: ${fetchPath} ${(bytes.length/1048576).toFixed(1)} Mo`);
    }catch(e){ console.warn('preview path failed', e); addLog('error','aberration',`Aperçu échoué: ${e.message}`); }
}

async function aberrShowPreviewLast(){
    if(window.captureViewer && window.captureViewer.pixels){
        if(currentMode==='aberration') captureViewer.configure('aberration');
        return;
    }
    // Demande le statut pour vérifier qu'il y a bien une image
    try{
        const s=await fetch('/api/aberration/status').then(r=>r.json());
        if(!s.has_last_image){
            addLog('warning','aberration','Aucune image en mémoire — capturez d’abord ou chargez un FITS');
        }
    }catch{}
}

async function aberrAnalyze(source, pathOrData){
    const info=document.getElementById('aberr-info');
    const resEl=document.getElementById('aberr-results');
    if(info) info.textContent='Analyse en cours...';
    if(resEl) resEl.style.display='none';
    // Preview en parallèle (pour file on a déjà, pour path on fetch)
    if(source==='load_path' && pathOrData){
        aberrShowPreviewPath(pathOrData);
    } else if(source==='last'){
        aberrShowPreviewLast();
    }
    try{
        let body={source};
        if(source==='load_path') body.path=pathOrData;
        if(source==='base64') { body.data=pathOrData; body.filename='upload.fits'; }
        const resp=await fetch('/api/aberration/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const r=await resp.json().catch(async()=>({ok:false,error:await resp.text()}));
        if(!r.ok){
            let msg=r.error||`HTTP ${resp.status}`;
            // Message plus explicite pour 404 serveur vs fichier local
            if(resp.status===404) msg+= ' — vérifiez le chemin côté serveur (ex: /media/... sur la machine où tourne Noctua) ou utilisez «Fichier FITS...» pour un fichier de votre PC';
            if(info) info.textContent='Erreur: '+msg;
            addLog('error','aberration', msg);
            aberrClearPreviewOverlay();
            return;
        }
        _aberrLast=r;
        // Si load_path était un dossier, on a maintenant le vrai fichier dans r.path
        if(source==='load_path' && r.path){
            aberrShowPreviewPath(r.path);
            // met à jour le champ texte avec le fichier choisi
            const inp=document.getElementById('aberr-inp-path');
            if(inp && r.path!==pathOrData) inp.value=r.path;
        }
        renderAberrResults(r);
        // Attend que le viewer ait fini de rendre l'image avant d'overlay
        setTimeout(()=>aberrDrawPreviewOverlay(r), 300);
        if(info) info.textContent=`${r.global.star_count} étoiles (${r.global.usable_count} utilisables) — ${r.filename} — ${r.width}×${r.height}`;
        addLog('info','aberration',`Analyse ${r.global.star_count} étoiles — HFR ${r.global.hfr_mean} — tilt ${r.global.tilt_mag}`);
    }catch(e){
        if(info) info.textContent='Erreur: '+e.message;
        addLog('error','aberration', e.message);
    }
}

async function aberrUpload(file){
    const info=document.getElementById('aberr-info');
    if(info) info.textContent=`Chargement ${file.name} ${(file.size/1048576).toFixed(1)} Mo...`;
    // Affiche immédiatement dans le viewer (avant upload, pour feedback instantané)
    await aberrShowPreviewFile(file);
    if(info) info.textContent='Upload + analyse...';
    try{
        const fd=new FormData(); fd.append('file', file);
        const resp=await fetch('/api/aberration/upload',{method:'POST', body:fd});
        const r=await resp.json().catch(async()=>({ok:false,error:await resp.text()}));
        if(!r.ok){
            let msg=r.error||`HTTP ${resp.status}`;
            if(resp.status===413) msg+=' — fichier trop volumineux (>50 Mo, utilisez un chemin serveur)';
            if(info) info.textContent='Erreur: '+msg;
            addLog('error','aberration',`Upload ${file.name}: ${msg}`);
            aberrClearPreviewOverlay();
            return;
        }
        _aberrLast=r;
        renderAberrResults(r);
        setTimeout(()=>aberrDrawPreviewOverlay(r), 300);
        if(info) info.textContent=`${r.global.star_count} étoiles (${r.global.usable_count} utilisables) — ${r.filename}`;
        addLog('info','aberration',`Upload ${r.filename}: ${r.global.star_count} étoiles`);
    }catch(e){
        if(info) info.textContent='Erreur: '+e.message;
        addLog('error','aberration',`Upload échoué: ${e.message}`);
    }
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
        const col = g.quality==='good' ? '#4a4' : g.quality==='tilt' ? '#fa0' : g.quality==='coma' ? '#f66' : g.quality==='saturated' ? '#f0f' : '#88f';
        qEl.style.color=col;
        qEl.title = g.quality==='saturated' ? 'Toutes étoiles saturées — pose trop longue, tilt non mesurable' : '';
    }
    const tb=document.getElementById('aberr-star-tbody');
    if(tb){
        tb.innerHTML='';
        (r.stars||[]).slice(0,30).forEach((s,i)=>{
            const tr=document.createElement('tr');
            const ang = s.ellip_angle!=null ? ` ${s.ellip_angle}°` : '';
            tr.innerHTML=`<td>${i+1}</td><td style="font-family:monospace">${s.x},${s.y}</td><td>${s.hfr}</td><td>${s.fwhm}</td><td>${s.ellip}${ang}</td><td>${s.coma_mag}</td><td>${s.snr}${s.saturated?' ⚠':''}</td>`;
            if(s.saturated) tr.style.color='#f0f';
            tb.appendChild(tr);
        });
    }
    const hdrEl=document.getElementById('aberr-header-detail');
    if(hdrEl){
        const hdr=r.header||{};
        const keys=Object.keys(hdr).slice(0,16);
        hdrEl.innerHTML = keys.length ? keys.map(k=>`<span style="color:#0af">${k}</span>=${hdr[k]}`).join(' · ') : 'Header minimal';
    }
    drawTiltCanvas(r);
    renderAberrExtra(r);
}

// ── Courbure / résidus / grille (onglet Tilt) ──────────────────
function renderAberrExtra(r){
    const box=document.getElementById('aberr-extra');
    if(box) box.style.display='';
    const g=r.global||{};
    const c=g.curvature||{}; const t=g.tilt||{};
    const set=(id,val)=>{ const e=document.getElementById(id); if(e&&val!=null) e.textContent=val; };
    set('aberr-curv-center', c.center_hfr); set('aberr-curv-edge', c.edge_hfr);
    set('aberr-curv-k', c.k); set('aberr-curv-ratio', c.edge_ratio);
    set('aberr-tilt-r2', t.r2); set('aberr-tilt-rms', t.rms);
    drawCurvatureCanvas(r);
    drawResidCanvas(r);
    drawGridCanvas(r);
}

function drawCurvatureCanvas(r){
    const cvs=document.getElementById('aberr-curv-canvas'); if(!cvs) return;
    const ctx=cvs.getContext('2d'); const W=cvs.width, H=cvs.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const cx=r.width/2, cy=r.height/2, rmax=Math.hypot(cx,cy)||1;
    const stars=(r.stars||[]).filter(s=>s.hfr>0);
    const c=r.global.curvature||{};
    if(!stars.length) return;
    let hmin=Infinity, hmax=-Infinity;
    stars.forEach(s=>{ hmin=Math.min(hmin,s.hfr); hmax=Math.max(hmax,s.hfr); });
    if(c.center_hfr!=null){ hmin=Math.min(hmin,c.center_hfr); hmax=Math.max(hmax,c.edge_hfr||c.center_hfr); }
    hmax=Math.max(hmax,hmin+0.5);
    const pad=28;
    const X=u=>pad+(W-2*pad)*u;
    const Y=h=>H-pad-(H-2*pad)*((h-hmin)/(hmax-hmin));
    ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.beginPath(); ctx.moveTo(pad,H-pad); ctx.lineTo(W-pad,H-pad); ctx.moveTo(pad,pad); ctx.lineTo(pad,H-pad); ctx.stroke();
    ctx.fillStyle='#888'; ctx.font='9px monospace';
    ctx.fillText('HFR',4,pad-8); ctx.fillText('u (0→1)',W-46,H-6);
    stars.forEach(s=>{ const u=Math.hypot(s.x-cx,s.y-cy)/rmax; ctx.fillStyle=s.saturated?'#f0f':'#0af'; ctx.beginPath(); ctx.arc(X(u),Y(s.hfr),2.4,0,Math.PI*2); ctx.fill(); });
    if(c.center_hfr!=null){
        ctx.strokeStyle='#fa0'; ctx.lineWidth=1.6; ctx.beginPath();
        for(let i=0;i<=40;i++){ const u=i/40; const h=c.center_hfr+(c.k||0)*u*u; if(i===0)ctx.moveTo(X(u),Y(h)); else ctx.lineTo(X(u),Y(h)); }
        ctx.stroke();
        ctx.fillStyle='#fa0'; ctx.fillText(`k=${c.k}  R²=${c.r2}`, pad+6, pad+12);
    }
}

function drawResidCanvas(r){
    const cvs=document.getElementById('aberr-resid-canvas'); if(!cvs) return;
    const ctx=cvs.getContext('2d'); const W=cvs.width, H=cvs.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const stars=(r.stars||[]).filter(s=>s.tilt_resid!=null);
    if(!stars.length) return;
    const pad=24, mid=H/2;
    const rms=(r.global.tilt||{}).rms||0;
    let m=0; stars.forEach(s=>m=Math.max(m,Math.abs(s.tilt_resid))); m=Math.max(m,rms*2,0.5);
    const Y=v=>mid-(v/m)*(H/2-pad);
    const X=i=>pad+(W-2*pad)*(stars.length===1?0.5:i/(stars.length-1));
    ctx.fillStyle='rgba(250,170,0,0.10)'; ctx.fillRect(pad,Y(rms),W-2*pad,Math.max(1,Y(-rms)-Y(rms)));
    ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(pad,mid); ctx.lineTo(W-pad,mid); ctx.stroke();
    stars.forEach((s,i)=>{ ctx.fillStyle=Math.abs(s.tilt_resid)>rms*2?'#f66':'#0f8'; ctx.beginPath(); ctx.arc(X(i),Y(s.tilt_resid),2.2,0,Math.PI*2); ctx.fill(); });
    ctx.fillStyle='#fa0'; ctx.font='9px monospace'; ctx.fillText(`±${rms} HFR (RMS)`, pad+6, pad+10);
    ctx.fillStyle='#888'; ctx.fillText(`${stars.length} étoiles`, W-84, H-6);
}

function drawGridCanvas(r){
    const cvs=document.getElementById('aberr-grid-canvas'); if(!cvs) return;
    const ctx=cvs.getContext('2d'); const W=cvs.width, H=cvs.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const grid=r.global.grid||[]; if(!grid.length) return;
    const vals=grid.filter(c=>c.count>0).map(c=>c.median_hfr);
    const vmin=vals.length?Math.min(...vals):0, vmax=vals.length?Math.max(...vals):1;
    const pad=10, cw=(W-2*pad)/3, ch=(H-2*pad-12)/3;
    grid.forEach(cell=>{
        const x=pad+cell.col*cw, y=pad+cell.row*ch;
        let col='#12202a';
        if(cell.count>0){
            const t=(cell.median_hfr-vmin)/((vmax-vmin)||1);
            const rr=Math.round(40+215*t), gg=Math.round(120+80*(1-Math.abs(t-0.5)*2)), bb=Math.round(200-180*t);
            col=`rgb(${rr},${gg},${bb})`;
        }
        ctx.fillStyle=col; ctx.fillRect(x+1,y+1,cw-2,ch-2);
        ctx.textAlign='center';
        if(cell.count>0){ ctx.fillStyle='#fff'; ctx.font='11px monospace'; ctx.fillText(cell.median_hfr.toFixed(2), x+cw/2, y+ch/2+4); }
        ctx.fillStyle='#888'; ctx.font='8px monospace'; ctx.fillText(`n=${cell.count}`, x+cw/2, y+ch-6);
        ctx.textAlign='left';
    });
    ctx.fillStyle='#fa0'; ctx.font='9px monospace'; ctx.fillText(`HFR médian par cellule · min ${vmin.toFixed(2)} → max ${vmax.toFixed(2)}`, pad+2, H-3);
}

// ── Distorsion (solve astrométrique) ───────────────────────────
async function aberrDistAnalyze(){
    const info=document.getElementById('aberr-dist-info');
    const results=document.getElementById('aberr-dist-results');
    if(info) info.textContent='Résolution astrométrique...';
    if(results) results.style.display='none';
    const path=(document.getElementById('aberr-inp-path')?.value||'').trim();
    const body = path ? {source:'load_path', path} : {source:'last'};
    body.order=parseInt(document.getElementById('aberr-dist-order')?.value||'2',10);
    try{
        const resp=await fetch('/api/aberration/distortion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const r=await resp.json().catch(async()=>({ok:false,error:await resp.text()}));
        if(!r.ok){ const msg=r.error||`HTTP ${resp.status}`; if(info) info.textContent='Erreur: '+msg; addLog('error','aberration',`Distorsion: ${msg}`); return; }
        renderDistortion(r);
        if(info) info.textContent=`${r.pairs} paires · ${r.matched_stars} matches · ${r.width}×${r.height}`;
        addLog('info','aberration',`Distorsion: max ${r.distortion.max_distortion_percent}% — RMS ${r.distortion.rms_relative}`);
    }catch(e){ if(info) info.textContent='Erreur: '+e.message; addLog('error','aberration',`Distorsion échouée: ${e.message}`); }
}

function renderDistortion(r){
    const res=document.getElementById('aberr-dist-results'); if(res) res.style.display='';
    const d=r.distortion||{}; const coeff=d.coefficients||[];
    const fmt=v=>(v==null?'—':Number(v).toFixed(6));
    const set=(id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=(v==null?'—':v); };
    set('aberr-dist-k1', coeff[0]!=null?fmt(coeff[0]):'—');
    set('aberr-dist-k2', coeff[1]!=null?fmt(coeff[1]):'—');
    set('aberr-dist-k3', coeff[2]!=null?fmt(coeff[2]):'—');
    set('aberr-dist-max', d.max_distortion_percent!=null?d.max_distortion_percent+' %':'—');
    set('aberr-dist-rms', d.rms_relative);
    set('aberr-dist-pairs', r.pairs);
    set('aberr-dist-scale', r.scale_arcsec_px!=null?r.scale_arcsec_px+' ″/px':'—');
    set('aberr-dist-rot', r.rotation_deg!=null?r.rotation_deg+'°':'—');
    set('aberr-dist-solverms', r.rms_arcsec!=null?r.rms_arcsec+' ″':'—');
    drawDistortionCanvas(r);
}

function drawDistortionCanvas(r){
    const cvs=document.getElementById('aberr-dist-canvas'); if(!cvs) return;
    const ctx=cvs.getContext('2d'); const W=cvs.width, H=cvs.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const d=r.distortion||{}; const prof=d.radial_profile||[];
    if(!prof.length) return;
    const pad=34;
    const vals=prof.map(p=>p[1]);
    let vmin=Math.min(0,...vals), vmax=Math.max(0,...vals);
    if(vmax-vmin<1e-6) vmax=vmin+1;
    const X=u=>pad+(W-2*pad)*u;
    const Y=v=>H-pad-(H-2*pad)*((v-vmin)/(vmax-vmin));
    ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(pad,H-pad); ctx.lineTo(W-pad,H-pad); ctx.moveTo(pad,pad); ctx.lineTo(pad,H-pad); ctx.stroke();
    if(vmin<0&&vmax>0){ ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.moveTo(pad,Y(0)); ctx.lineTo(W-pad,Y(0)); ctx.stroke(); }
    const cx=r.width/2, cy=r.height/2, rmax=Math.hypot(cx,cy)||1;
    (r.pairs_xy||[]).forEach(p=>{ const [xm,ym,xr,yr]=p; const rr=Math.hypot(xr-cx,yr-cy); if(rr<1e-6) return; const u=rr/rmax; const rm=Math.hypot(xm-cx,ym-cy); const dist=(rm-rr)/rr*100; ctx.fillStyle='rgba(0,170,255,0.5)'; ctx.beginPath(); ctx.arc(X(u),Y(dist),2,0,Math.PI*2); ctx.fill(); });
    ctx.strokeStyle='#0af'; ctx.lineWidth=1.6; ctx.beginPath();
    prof.forEach((p,i)=>{ const x=X(p[0]), y=Y(p[1]); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
    ctx.fillStyle='#0af'; ctx.font='9px monospace'; ctx.fillText('distorsion %',4,pad-8);
    ctx.fillStyle='#888'; ctx.fillText('u = r/r_max',W-70,H-6);
    ctx.fillStyle='#fa0'; ctx.fillText(`max ${d.max_distortion_percent}% · ${r.pairs} paires`, pad+6, pad+10);
}

function drawTiltCanvas(r){
    const cvs=document.getElementById('aberr-tilt-canvas');
    if(!cvs) return;
    const ctx=cvs.getContext('2d');
    const W=cvs.width, H=cvs.height;
    ctx.fillStyle='#05080f'; ctx.fillRect(0,0,W,H);
    const g=r.global;
    if(g && (g.tilt_dx||g.tilt_dy)){
        const cx=W/2, cy=H/2;
        const scale=80;
        const dx=g.tilt_dx*scale, dy=g.tilt_dy*scale;
        ctx.strokeStyle='#fa0'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+dx, cy+dy); ctx.stroke();
        ctx.fillStyle='#fa0'; ctx.beginPath(); ctx.arc(cx+dx, cy+dy, 4, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle='#888'; ctx.font='10px monospace'; ctx.fillText(`tilt ${g.tilt_mag}`, 6, 12);
    } else if(g && g.quality==='saturated'){
        ctx.fillStyle='#f0f'; ctx.font='12px monospace'; ctx.fillText('Saturé — tilt non mesurable (pose trop longue)', 10, H/2);
    }
    (r.stars||[]).forEach(s=>{
        const x=s.x / r.width * W;
        const y=s.y / r.height * H;
        const hfr=s.hfr||0;
        const col = s.saturated ? '#f0f' : hfr>4 ? '#f66' : hfr>2.5 ? '#fa0' : '#0f8';
        ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
        // petite flèche coma sur le mini canvas
        if(s.coma_mag>0.3){
            const sc=6;
            ctx.strokeStyle='rgba(255,100,100,0.9)'; ctx.lineWidth=1;
            ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+s.coma_dx*sc, y+s.coma_dy*sc); ctx.stroke();
        }
    });
}

// ── Overlay aperçu (grille + flèches) ──────────────────────────
function aberrClearPreviewOverlay(){
    const ovl=document.getElementById('aberr-overlay-canvas');
    if(!ovl) return;
    const ctx=ovl.getContext('2d');
    ctx.clearRect(0,0,ovl.width, ovl.height);
    ovl.style.display='none';
}

function aberrDrawPreviewOverlay(r){
    const ovl=document.getElementById('aberr-overlay-canvas');
    const capCanvas=document.getElementById('cap-preview-canvas');
    if(!ovl || !capCanvas) return;
    if(!r || !r.stars || !r.width || !r.height){
        aberrClearPreviewOverlay();
        return;
    }
    const W=r.width, H=r.height;
    // Taille overlay = taille image (comme focus/offset)
    ovl.width = W; ovl.height = H;
    ovl.style.width = W+'px'; ovl.style.height = H+'px';
    ovl.style.display='block';
    // Synchronise le transform avec le viewer (zoom/pan)
    // Le viewer applique déjà via _applyTransform si overlayId est listé, mais on force au cas où
    if(window.captureViewer){
        const t=`translate(${captureViewer.panX||0}px, ${captureViewer.panY||0}px) scale(${captureViewer.zoom||1})`;
        ovl.style.transform = t;
    }
    const ctx=ovl.getContext('2d');
    ctx.clearRect(0,0,W,H);

    const g=r.global;
    const showGrid = document.getElementById('aberr-opt-grid')?.checked ?? true;
    const showArrows = document.getElementById('aberr-opt-arrows')?.checked ?? true;
    const showEllip = document.getElementById('aberr-opt-ellip')?.checked ?? true;

    // Grille déformée (tilt)
    if(showGrid){
        drawAberrGrid(ctx, W, H, g);
    }

    // Étoiles + flèches
    (r.stars||[]).forEach(s=>{
        const x=s.x, y=s.y; // image coords top-origin
        // Cercles HFR
        const hfr=s.hfr||0;
        const col = s.saturated ? 'rgba(255,0,255,0.9)' : hfr>4 ? 'rgba(255,80,80,0.9)' : hfr>2.5 ? 'rgba(255,180,0,0.9)' : 'rgba(0,255,140,0.9)';
        ctx.strokeStyle=col; ctx.lineWidth=1.2; ctx.beginPath(); ctx.arc(x,y, Math.max(6, hfr*2), 0, Math.PI*2); ctx.stroke();
        if(s.saturated){
            ctx.fillStyle='rgba(255,0,255,0.7)'; ctx.font='8px monospace'; ctx.textAlign='center'; ctx.fillText('SAT', x, y-10);
        }
        // Ellipse
        if(showEllip && s.ellip>0.08){
            const a = Math.max(6, hfr*2.2);
            const b = a * (1 - s.ellip);
            const ang = (s.ellip_angle||0) * Math.PI/180;
            ctx.strokeStyle='rgba(0,180,255,0.7)'; ctx.lineWidth=1;
            ctx.beginPath(); ctx.ellipse(x,y, a, b, ang, 0, Math.PI*2); ctx.stroke();
        }
        // Flèche coma
        if(showArrows && s.coma_mag>0.25){
            const sc = 10; // échelle coma
            const x2 = x + s.coma_dx * sc;
            const y2 = y + s.coma_dy * sc;
            ctx.strokeStyle='rgba(255,60,60,0.85)'; ctx.lineWidth=1.3;
            ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x2,y2); ctx.stroke();
            // tête de flèche
            const ang=Math.atan2(y2-y, x2-x);
            const al=6;
            ctx.beginPath(); ctx.moveTo(x2,y2);
            ctx.lineTo(x2 - al*Math.cos(ang-0.45), y2 - al*Math.sin(ang-0.45));
            ctx.moveTo(x2,y2);
            ctx.lineTo(x2 - al*Math.cos(ang+0.45), y2 - al*Math.sin(ang+0.45));
            ctx.stroke();
        }
    });

    // Flèche tilt globale au centre
    if(showArrows && g && (g.tilt_dx||g.tilt_dy) && g.quality!=='saturated'){
        const cx=W/2, cy=H/2;
        const scale = Math.min(W,H)*0.18; // longueur max ~18% du champ
        const mag = g.tilt_mag || Math.hypot(g.tilt_dx, g.tilt_dy);
        const nx = g.tilt_dx/(mag||1), ny=g.tilt_dy/(mag||1);
        const dx = nx * mag * scale * 4;
        const dy = ny * mag * scale * 4;
        ctx.strokeStyle='#ffaa00'; ctx.lineWidth=2.5;
        ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+dx, cy+dy); ctx.stroke();
        ctx.fillStyle='#ffaa00'; ctx.beginPath(); ctx.arc(cx+dx, cy+dy, 5,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(cx+dx+6, cy+dy-14, 70, 14);
        ctx.fillStyle='#ffaa00'; ctx.font='10px monospace'; ctx.textAlign='left'; ctx.fillText(`tilt ${mag.toFixed(2)}`, cx+dx+8, cy+dy-4);
        // point centre
        ctx.fillStyle='#ffaa00'; ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fill();
    }
}

function drawAberrGrid(ctx, W, H, g){
    const cols=8, rows=6;
    const tiltMag = g ? Math.hypot(g.tilt_dx||0, g.tilt_dy||0) : 0;
    const showDeform = tiltMag>0.05 && g.quality!=='saturated';
    // Couleur grille
    ctx.strokeStyle = showDeform ? 'rgba(255,170,0,0.35)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = showDeform ? 1.2 : 0.8;
    ctx.setLineDash(showDeform ? [] : [4,4]);

    // Calcul déformation : étire le long de la direction de tilt
    // On projette chaque point (x,y) sur la direction tilt
    const dirX = showDeform ? (g.tilt_dx/tiltMag) : 0;
    const dirY = showDeform ? (g.tilt_dy/tiltMag) : 0;
    const exaggerate = 60; // px par unité tilt
    const cx=W/2, cy=H/2;

    function deform(x,y){
        if(!showDeform) return [x,y];
        // offset proportionnel à la projection sur l'axe tilt
        const dx = x - cx, dy = y - cy;
        const proj = dx*dirX + dy*dirY;
        const off = proj * tiltMag * 0.08; // 8% par unité tilt*proj
        // aussi léger effet perspective Z
        const z = (x/W -0.5)*g.tilt_dx*exaggerate*0.02 + (y/H -0.5)*g.tilt_dy*exaggerate*0.02;
        const s = 1/(1+z*0.01);
        return [cx + (dx+off*dirX*exaggerate*0.3)*s, cy + (dy+off*dirY*exaggerate*0.3)*s];
    }

    // Lignes verticales
    for(let c=0;c<=cols;c++){
        const gx = c*W/cols;
        ctx.beginPath();
        for(let r=0;r<=rows;r++){
            const gy=r*H/rows;
            const [x,y]=deform(gx,gy);
            if(r===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
    }
    // Lignes horizontales
    for(let r=0;r<=rows;r++){
        const gy=r*H/rows;
        ctx.beginPath();
        for(let c=0;c<=cols;c++){
            const gx=c*W/cols;
            const [x,y]=deform(gx,gy);
            if(c===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // Légende grille
    if(showDeform){
        ctx.fillStyle='rgba(255,170,0,0.9)'; ctx.font='9px monospace'; ctx.textAlign='left';
        ctx.fillText(`grille tilt ×${exaggerate.toFixed(0)}`, 6, 14);
    }
    // Coins
    ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.font='7px monospace';
    ctx.fillText('0,0', 4, 10); ctx.fillText(`${W},${H}`, W-50, H-4);
}

// Compat legacy overlayStarsOnViewer (utilisé par ancien code, on redirige)
function overlayStarsOnViewer(stars){
    if(_aberrLast) aberrDrawPreviewOverlay(_aberrLast);
    else {
        const ovl=document.getElementById('aberr-viewer-overlay');
        if(ovl){ const c=ovl.getContext('2d'); c.clearRect(0,0,ovl.width,ovl.height); }
    }
}
