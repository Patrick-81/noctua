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
