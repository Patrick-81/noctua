// ═══════════════════════════════════════════════════════════════
// Noctua — preview.js (module classique, bindings lexicaux globaux)
console.log('preview.js v3 pleine 8192 — vignette filtrée <3000px, histo+ADU');
// ═══════════════════════════════════════════════════════════════

// ── FITS image handling ──────────────────────────────────────

function handleGuideImage(b64Data, fmt) {
    try {
    const raw = atob(b64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    if (guideViewer) {
        guideViewer.renderGuide(bytes, fmt, () => {
            const w = guideViewer.imgW, h = guideViewer.imgH;
            if (w && h) {
                _guideRenderStarMedallion();
                _guideDetectStars(w, h);
            }
        });
    }
    } catch (e) { console.error('handleGuideImage error:', e); }
}

function _guideDetectStars(w, h) {
    if (!_guideCap()) return;
    const overlay = document.getElementById('guide-preview-overlay');
    if (!overlay) return;
    const { pixels, sky, soft, k, scale, offX, offY, canvasW, canvasH, dpr } = _guideCap();

    // Detect stars using centroid + peak search on the Asinh-stretched data
    // We stretch once for display, then find local maxima in the stretched version
    const stretched = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const raw = pixels[y * w + x];
            const v = Math.asinh((raw - sky) / soft) / Math.asinh(k);
            stretched[y * w + x] = (v + 1) * 0.5; // normalize to 0..1
        }
    }

    // Find local maxima in stretched image
    const threshold = 0.45; // 45% of stretched range
    const minDist = 5;
    const stars = [];
    for (let y = minDist; y < h - minDist; y++) {
        for (let x = minDist; x < w - minDist; x++) {
            const val = stretched[y * w + x];
            if (val < threshold) continue;
            let isMax = true;
            for (let dy = -minDist; dy <= minDist && isMax; dy++) {
                for (let dx = -minDist; dx <= minDist && isMax; dx++) {
                    if (dy === 0 && dx === 0) continue;
                    if (stretched[(y + dy) * w + (x + dx)] > val) isMax = false;
                }
            }
            if (isMax) {
                // Compute quality: peak height * isolation
                const peak = val;
                // Look at radial falloff
                let falloffScore = 0;
                const outer = stretched[(y - 3) * w + x] + stretched[(y + 3) * w + x] +
                              stretched[y * w + (x - 3)] + stretched[y * w + (x + 3)];
                if (outer > 0) {
                    const core = stretched[(y - 1) * w + x] + stretched[(y + 1) * w + x] +
                                 stretched[y * w + (x - 1)] + stretched[y * w + (x + 1)];
                    falloffScore = Math.min(core / outer, 5) / 5;
                }
                const gaussianQuality = Math.min(peak * 0.5 + falloffScore * 0.5, 1.0);
                stars.push({ x, y, quality: gaussianQuality, peak: val });
            }
        }
    }

    stars.sort((a, b) => b.quality - a.quality);
    _guideStarList = stars.slice(0, 50);

    // Draw markers
    const ovCtx = overlay.getContext('2d');
    // Sync overlay size to match canvas
    const refCanvas = document.getElementById('guide-preview-canvas');
    const syncW = refCanvas ? refCanvas.width : canvasW;
    const syncH = refCanvas ? refCanvas.height : canvasH;
    if (overlay.width !== syncW || overlay.height !== syncH) {
        overlay.width = syncW;
        overlay.height = syncH;
    }
    ovCtx.clearRect(0, 0, overlay.width, overlay.height);

    for (let i = 0; i < _guideStarList.length; i++) {
        const s = _guideStarList[i];
        const px = offX + s.x * scale;
        const py = offY + (h - 1 - s.y) * scale;
        const selected = _guideSelectedStar && _guideSelectedStar.x === s.x && _guideSelectedStar.y === s.y;
        const radius = selected ? 8 * dpr : 5 * dpr;
        ovCtx.strokeStyle = selected ? cssVar('--status-warning') : ('rgba(' + cssVar('--accent-rgb') + ',0.8)');
        ovCtx.lineWidth = selected ? 2.5 * dpr : 1.5 * dpr;
        ovCtx.beginPath(); ovCtx.arc(px, py, radius, 0, Math.PI * 2); ovCtx.stroke();

        // Crosshair
        const ch = radius + 3 * dpr;
        ovCtx.beginPath(); ovCtx.moveTo(px - ch, py); ovCtx.lineTo(px + ch, py); ovCtx.stroke();
        ovCtx.beginPath(); ovCtx.moveTo(px, py - ch); ovCtx.lineTo(px, py + ch); ovCtx.stroke();

        // Dimmest stars: smaller, fainter markers
        if (i >= 5 && !selected) {
            ovCtx.strokeStyle = ('rgba(' + cssVar('--accent-rgb') + ',0.3)');
            ovCtx.lineWidth = 1 * dpr;
            ovCtx.beginPath(); ovCtx.arc(px, py, 3 * dpr, 0, Math.PI * 2); ovCtx.stroke();
        }

        // Label top 5 or selected
        if (i < 5 || selected) {
            ovCtx.fillStyle = selected ? cssVar('--status-warning') : '#aaa';
            ovCtx.font = `${selected ? 9 : 7}px monospace`;
            ovCtx.textAlign = 'left';
            ovCtx.fillText(`#${i + 1}`, px + radius + 4 * dpr, py + 3 * dpr);
        }
    }

    // Update status
    const statusEl = document.getElementById('guide-preview-status');
    if (statusEl) {
        if (_guideSelectedStar) {
            const idx = _guideStarList.indexOf(_guideSelectedStar) + 1;
            statusEl.textContent = i18nFmt('preview.star_selected', { idx, x: _guideSelectedStar.x, y: _guideSelectedStar.y });
            statusEl.style.color = cssVar('--accent');
        } else if (_guideStarList.length > 0) {
            statusEl.textContent = i18nFmt('preview.star_list', { n: _guideStarList.length });
            statusEl.style.color = cssVar('--status-warning');
        } else {
            statusEl.textContent = i18n('preview.no_star');
            statusEl.style.color = cssVar('--status-error');
        }
    }
}

function _guideSetStar(star) {
    _guideSelectedStar = star;
    if (star) {
        const w = _guideCap()?.width || 1;
        const h = _guideCap()?.height || 1;
        apiPost('/api/guide/set-reference', { x: star.x, y: h - 1 - star.y });
        Hub.emit('guide:starSelected', { star }, { source: 'preview' });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            const idx = _guideStarList.indexOf(star) + 1;
            statusEl.textContent = `⭐ Étoile #${idx} (${star.x}, ${star.y}) — Prêt pour guidage`;
            statusEl.style.color = cssVar('--accent');
        }
    }
    if (_guideCap()) _guideDetectStars(_guideCap().width, _guideCap().height);
}

function _guideAutoSelect() {
    // Dedicated button handler: re-fetch via API and pick best gaussian_quality star
    const cam = _guideCameraSelect?.value || '';
    if (!cam) { addLog('warn', 'guide', i18n('log.guide.no_camera')); return; }
    const metricUrl = '/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : '');
    fetch(metricUrl).then(r => r.json()).then(metric => {
        if (!metric?.ok || !metric.stars?.length) {
            addLog('warn', 'guide', i18n('log.guide.no_star'));
            return;
        }
        // Pick best by gaussian_quality (already sorted server-side)
        const best = metric.stars[0];
        const imgH = metric.height || 1;
        _guideSelectedStar = { x: best.x, y: best.y, quality: best.gaussian_quality || 0 };
        apiPost('/api/guide/set-reference', { x: best.x, y: imgH - 1 - best.y });
        Hub.emit('guide:starSelected', { star: _guideSelectedStar }, { source: 'preview' });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            statusEl.textContent = `⭐ Auto: étoile (${best.x}, ${best.y}) qualité=${best.gaussian_quality} — Prêt`;
            statusEl.style.color = cssVar('--accent');
        }
        if (_guideCap()) _guideDetectStars(_guideCap().width, _guideCap().height);
        addLog('info', 'guide', i18nFmt('log.guide.star_selected', { x: best.x, y: best.y, q: best.gaussian_quality }));
    }).catch(e => {
        addLog('error', 'guide', i18nFmt('log.guide.auto_error', { err: e.message }));
    });
}

let _guideRefSet = false;
let _guideLastCentroid = null;
function _guideClick(vpX, vpY) {
    if (!_guideStarList.length || !_guideCap()) return;
    const data = _guideCap();
    const { scale, offX, offY, width: imgW, height: imgH, dpr } = data;
    const zoom = guideViewer?.zoom || 1;
    const panX = guideViewer?.panX || 0;
    const panY = guideViewer?.panY || 0;
    const imgX = ((vpX - panX) / zoom * dpr - offX) / scale;
    const imgY = imgH - 1 - ((vpY - panY) / zoom * dpr - offY) / scale;
    let bestDist = Infinity, bestStar = null;
    for (const s of _guideStarList) {
        const dx = s.x - imgX, dy = s.y - imgY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; bestStar = s; }
    }
    if (bestStar && bestDist < 15) _guideSetStar(bestStar);
}

// Expose _guideClick au global pour la classe Viewer (viewer.js, script classique).
window._guideClick = _guideClick;

// ── Hub ───────────────────────────────────────────────────────

// Consommateur ws:image : route l'image vers le viewer guide ou capture.
// UN SEUL affichage par pose : la FINALE (dérivée du FITS : dématricée,
// balance des blancs, pleine dynamique). Le preview driver est plus rapide
// mais sa balance est fausse (ex. plafond blanc → orange) — il ne sert que
// de roue de secours si aucune finale n'arrive sous 20 s (jamais d'écran
// noir). Les images guide (temps réel) s'affichent toujours aussitôt.
var _shownExposureByDev = {};
var _pendingPreviewByDev = {};
// Appelé à tout changement de caméra (capture, MAP, guide) : on purge
// image, stats, histo et déduplication — rien de périmé ne survit.
function notifyCameraChanged() {
    _shownExposureByDev = {};
    for (const k of Object.keys(_pendingPreviewByDev)) {
        try { clearTimeout(_pendingPreviewByDev[k].timer); } catch (e) {}
        delete _pendingPreviewByDev[k];
    }
    try {
        if (typeof captureViewer !== 'undefined' && captureViewer) captureViewer.clear();
        if (typeof guideViewer !== 'undefined' && guideViewer) guideViewer.clear();
    } catch (e) { /* viewers pas encore montés */ }
    try {
        const info = document.getElementById('cap-preview-info');
        if (info) { info.textContent = '—'; }
        const histo = document.getElementById('cap-histo-canvas');
        if (histo) histo.getContext('2d')?.clearRect(0, 0, histo.width, histo.height);
        const adu = document.getElementById('cap-adu-cursor');
        if (adu) adu.textContent = ' ';
        const metric = document.getElementById('focus-metric-info');
        if (metric) metric.textContent = '';
    } catch (e) { /* DOM pas encore monté */ }
}
Hub.subscribe('ws:image', 'preview', (env) => {
    const { device, format, data, variant, stage, exposure, xfer } = env.payload;
    if (device) _lastWsImageByDev[device] = Date.now();
    const guideCam = _guideCameraSelect?.value || '';
    console.log('WS image: device=%s format=%s variant=%s stage=%s exposure=%s guideCam=%s match=%s', device, format, variant||'', stage||'', exposure||0, guideCam, device === guideCam);
    const isGuideImg = !!(guideCam && device === guideCam);
    const isPreview = String(stage || 'final') === 'preview';
    if (isPreview && !isGuideImg) {
        // Preview mis en attente : la finale (meilleure) arrive juste
        // derrière. Secours : affiché si rien ne suit sous 20 s.
        if (device) {
            const _old = _pendingPreviewByDev[device];
            if (_old) clearTimeout(_old.timer);
            const _entry = { exposure };
            _entry.timer = setTimeout(() => {
                if (_pendingPreviewByDev[device] !== _entry) return;
                delete _pendingPreviewByDev[device];
                if (exposure && _shownExposureByDev[device] === exposure) return;
                console.log(`WS image: preview affiché (pas de finale sous 20s, pose ${exposure || '?'})`);
                try {
                    if (handleCameraImage(data, format, variant, stage, device, xfer) !== false
                        && exposure && device) _shownExposureByDev[device] = exposure;
                } catch (e) { console.warn('WS image: preview secours raté', e); }
            }, 20000);
            _pendingPreviewByDev[device] = _entry;
        }
        console.log(`WS image: preview en attente (finale attendue, pose ${exposure || '?'})`);
        return;
    }
    if (exposure && device && _shownExposureByDev[device] === exposure) {
        console.log(`WS image: ignorée (pose ${exposure} déjà affichée)`);
        return;
    }
    // Une finale arrive : le preview en attente (s'il y en a un) est périmé.
    if (device && _pendingPreviewByDev[device]) {
        clearTimeout(_pendingPreviewByDev[device].timer);
        delete _pendingPreviewByDev[device];
    }
    try {
        let _painted = true;
        if (isGuideImg) {
            handleGuideImage(data, format);
        } else {
            _painted = handleCameraImage(data, format, variant, stage, device, xfer);
        }
        // Ne marque la pose que si quelque chose s'est affiché : une image
        // filtrée (mauvais variant) ne doit pas condamner toute la pose.
        if (exposure && device && _painted !== false) _shownExposureByDev[device] = exposure;
    } catch (e) {
        // Un rendu raté ne doit jamais geler le flux : on ne marque pas la
        // pose comme affichée, la prochaine image réessaiera.
        console.warn('WS image: rendu raté, pose non marquée', e);
        return;
    }
});

let _guideStarList = [];
let _guideSelectedStar = null;
function _guideCap() { return guideViewer?._guideCaptureData || _guideLegacyCapture; }
let _guideLegacyCapture = null;
let _guideAutoStar = null;

var _lastWsImageAt = 0;
var _lastWsImageByDev = {};

// Rapatrie le FITS brut (thumb=0) de la caméra et l'affiche dans le viewer
// capture. Utilisé par le mode d'aperçu « FITS brut » : pleine dynamique,
// dématriçage côté navigateur (BAYERPAT), sans passage 8 bits.
let _rawFetching = false;
let _rawWarned = false;
async function _rawFetchFull(devName, bin) {
    if (_rawFetching) return false;
    if (typeof captureViewer === 'undefined' || !captureViewer) return false;
    _rawFetching = true;
    try {
        const cam = devName || (typeof findCamera === 'function' ? (findCamera()?.name || '') : '');
        const b = (bin && bin >= 2) ? `&bin=${bin}` : '';
        const q = `?thumb=0${cam ? `&device=${encodeURIComponent(cam)}` : ''}${b}`;
        const j = await fetch('/api/camera/last_image' + q).then(r => r.json()).catch(() => null);
        if (!j?.ok || !j.data) return false;
        // Garde-fou gros capteurs : prévient une fois si le FITS complet est
        // très lourd (ex. RisingCam ~58 Mo) et que le binning ×2 n'est pas actif.
        if (!b && !_rawWarned && j.size > 24 * 1024 * 1024) {
            _rawWarned = true;
            if (typeof addLog === 'function')
                addLog('warning', 'capture', `FITS lourd (${(j.size / 1048576).toFixed(0)} Mo) — activez « ×2 » pour réduire le transfert`);
        }
        const raw = atob(j.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        _lastWsImageAt = Date.now();
        captureViewer.render(bytes, j.format || 'fits');
        return true;
    } catch (e) {
        console.warn('raw full-FITS fetch failed', e);
        return false;
    } finally {
        _rawFetching = false;
    }
}

// Ligne de stats compacte du bandeau viewer (min/méd/moy/max/σ/saturation).
function renderStatsLine(s) {
    const el = document.getElementById('cap-stats-line');
    if (!el) return;
    if (!s || !s.ok) { el.textContent = '—'; return; }
    const fmtV = v => Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)) : '?';
    const parts = [
        `min ${fmtV(s.min)}`,
        `méd ${fmtV(s.median)}`,
        s.mean != null ? `moy ${fmtV(s.mean)}` : null,
        `max ${fmtV(s.max)}`,
        s.std != null ? `σ ${fmtV(s.std)}` : null,
        s.saturation_pct != null ? `sat ${s.saturation_pct.toFixed(2)}%` : null,
        `${s.w}×${s.h}`,
    ].filter(Boolean);
    // Stats = FITS complet (analyses intactes) ; préciser si l'image est binnée.
    if (typeof _captureBin2 !== 'undefined' && _captureBin2 &&
        typeof _capturePreviewFormat !== 'undefined' && _capturePreviewFormat === 'raw')
        parts.push('image ×2');
    el.textContent = parts.join(' · ');
}

function handleCameraImage(b64Data, fmt, variant, stage = 'final', devName = '', xferS = null) {
    const norm = String(fmt||'').toLowerCase();
    const isFits = norm.includes('fits');
    const wantVignette = (typeof _capturePreviewFormat !== 'undefined' && _capturePreviewFormat === 'vignette');
    const wantRaw = (typeof _capturePreviewFormat !== 'undefined' && _capturePreviewFormat === 'raw');
    const varNorm = String(variant||'').toLowerCase();
    // Mode « FITS brut » : on ignore les JPEG (vignette/pleine) et on
    // rapatrie le FITS natif (pleine dynamique), dématricé par le viewer.
    if (wantRaw && !isFits) {
        const _fallback = () => { try { _paintBytes(b64Data, fmt); } catch (e) { /* ignore */ } };
        if (typeof _rawFetchFull === 'function') {
            if (captureViewer && xferS != null) captureViewer.pendingXfer = xferS;
            _rawFetchFull(devName, (typeof _captureBin2 !== 'undefined' && _captureBin2) ? 2 : 1).then(ok => { if (!ok) _fallback(); });
        } else _fallback();
        document.getElementById('applet-capture-settings')?.classList.remove('cap-loading');
        document.getElementById('applet-capture-preview')?.classList.remove('cap-preview-loading');
        setTimeout(() => fetchStatsWithRetry(3), 700);
        return true;
    }
    function _paintBytes(b64, f) {
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        _lastWsImageAt = Date.now();
        console.log(`handleCameraImage: affichée ${f} ${variant||''} ${stage||''} ${Math.round(b64.length*0.75/1024)}Ko`);
        if (captureViewer) {
            if (xferS != null) captureViewer.pendingXfer = xferS;
            captureViewer.render(bytes, f);
        }
    }
    function _renderAndFetch(b64, f) {
        // Retourne true si quelque chose a été affiché (ou va l'être :
        // fetch FITS / fallback) — la déduplication par pose ne marque
        // que les poses réellement rendues, sinon une vignette filtrée
        // condamnerait toute la pose en mode pleine.
        // MAP + Lin : on préfère le FITS (pleine dynamique, dématricé) en
        // un seul rendu. Mais si le fetch échoue, on affiche le JPEG plutôt
        // que rien (filet anti-écran-noir).
        const _linActive = (typeof _linOn !== 'undefined' && _linOn
            && typeof currentMode !== 'undefined' && currentMode === 'focuser');
        const _fitsIn = String(f || '').toLowerCase().includes('fits');
        if (_linActive && !_fitsIn) {
            _lastWsImageAt = Date.now();
            const _fallback = () => {
                try { _paintBytes(b64, f); }
                catch (e) { console.warn('handleCameraImage fallback failed', e); }
            };
            if (typeof _linFetchFull === 'function') {
                // FITS de la caméra qui vient d'imager, pas forcément la MAP.
                if (typeof captureViewer !== 'undefined' && captureViewer && xferS != null)
                    captureViewer.pendingXfer = xferS;
                _linFetchFull(devName).then(ok => {
                    if (!ok) { _lastWsImageAt = 0; _fallback(); }
                });
            } else _fallback();
            document.getElementById('applet-capture-settings')?.classList.remove('cap-loading');
            document.getElementById('applet-capture-preview')?.classList.remove('cap-preview-loading');
            setTimeout(() => fetchStatsWithRetry(3), 700);
            return true;
        }
        try {
            clearOffsetOverlay();
            clearFocusOverlay();
            _paintBytes(b64, f);
            // NB : pas de _linFollow() ici — le cas Lin+JPEG est géré plus
            // haut (fetch FITS unique), le cas Lin+FITS est déjà complet.
        } catch (e) {
            console.warn('handleCameraImage render failed', e);
            if (typeof addLog === 'function') addLog('warning', 'capture', `Affichage image impossible: ${e.message}`);
            return false;
        } finally {
            document.getElementById('applet-capture-settings')?.classList.remove('cap-loading');
            document.getElementById('applet-capture-preview')?.classList.remove('cap-preview-loading');
            const badge = document.getElementById('cap-image-stage');
            if (badge) {
                const isPreview = String(stage || 'final') === 'preview';
                badge.textContent = isPreview ? i18n('cap.stage_preview') : i18n('cap.stage_final');
                badge.style.color = isPreview ? '#ffcc00' : '#44cc44';
            }
            setTimeout(()=> fetchStatsWithRetry(3), 700);
        }
        return true;
    }
    function fetchStatsWithRetry(retry) {
        function fetchStats(rem) {
            const cam = (typeof findCamera === 'function' ? findCamera()?.name : '') || '';
            const devParam = cam ? `?device=${encodeURIComponent(cam)}` : '';
            fetch(`/api/camera/last_image/stats${devParam}`).then(r=>r.json()).then(s=>{
                if (s && s.ok && captureViewer) {
                    console.log(`stats: ${s.w}x${s.h} min=${Math.round(s.min)} max=${Math.round(s.max)} median=${Math.round(s.median)} hist=${s.hist ? s.hist.length : 0}`);
                    captureViewer._statsHist = s;
                    const c = document.getElementById('cap-histo-canvas');
                    if (c && c.offsetWidth === 0 && rem > 0) {
                        console.log('histo canvas pas visible, retry', rem);
                        setTimeout(()=> fetchStats(rem-1), 500);
                        return;
                    }
                    captureViewer.renderHistogramFromStats(s);
                    renderStatsLine(s);
                    console.log('histo rendu');
                } else if (s && !s.ok) {
                    console.warn('stats error', s.error);
                    renderStatsLine(null);
                    // Pas de stats pour cette caméra : purge l'histo périmé
                    // (sinon niveaux d'une autre caméra affichés).
                    try {
                        if (captureViewer) captureViewer._statsHist = null;
                        const hc = document.getElementById('cap-histo-canvas');
                        if (hc) hc.getContext('2d')?.clearRect(0, 0, hc.width, hc.height);
                    } catch (e) { /* DOM pas monté */ }
                }
            }).catch(e=> console.warn('stats fetch fail', e));
        }
        fetchStats(retry);
    }
    if (isFits) {
        console.log(`handleCameraImage: FITS ${Math.round(b64Data.length*0.75/1024)}Ko`);
        return _renderAndFetch(b64Data, fmt);
    }
    // filtrage par variant si présent
    if (varNorm) {
        if (wantVignette && varNorm === 'pleine') {
            console.log(`handleCameraImage: pleine ignorée (mode vignette)`);
            return false;
        }
        if (!wantVignette && varNorm === 'vignette') {
            console.log(`handleCameraImage: vignette ignorée (mode pleine)`);
            return false;
        }
        return _renderAndFetch(b64Data, fmt);
    }
    // fallback sans variant : dimensions
    try {
        const rawTmp = atob(b64Data);
        const bytesTmp = new Uint8Array(rawTmp.length);
        for (let i = 0; i < rawTmp.length; i++) bytesTmp[i] = rawTmp.charCodeAt(i);
        const blob = new Blob([bytesTmp], {type:'image/jpeg'});
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            console.log(`handleCameraImage: JPEG candidat ${img.width}x${img.height} ${Math.round(b64Data.length*0.75/1024)}Ko`);
            const isVignetteImg = img.width < 1500;
            if (wantVignette && !isVignetteImg) {
                console.log(`handleCameraImage: pleine ignorée (mode vignette)`);
                if (devName) delete _shownExposureByDev[devName];
                return;
            }
            if (!wantVignette && isVignetteImg) {
                console.log(`handleCameraImage: vignette ignorée (mode pleine)`);
                if (devName) delete _shownExposureByDev[devName];
                return;
            }
            _renderAndFetch(b64Data, fmt);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            _renderAndFetch(b64Data, fmt);
        };
        img.src = url;
    } catch(e) {
        _renderAndFetch(b64Data, fmt);
    }
    // Chemin async (dimensions lues au onload) : on marque optimiste, le
    // rendu suit dans tous les cas (onload peint ou filtre, onerror peint).
    return true;
}




// ── Histogram + preview stretch ────────────────────────────────

function renderHistogram() { captureViewer?.renderHistogram(); }
function applyHistogramStretch() { captureViewer?.applyHistogramStretch(); }

// ── Preview resize ─────────────────────────────────────────────

function _initPanelResize(panelId, handleId, onResize) {
    const panel = document.getElementById(panelId);
    const handle = document.getElementById(handleId);
    if (!panel || !handle) return;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const startW = panel.offsetWidth;
        const startH = panel.offsetHeight;
        const startX = e.clientX;
        const startY = e.clientY;
        function onMove(ev) {
            const newW = Math.max(200, Math.min(window.innerWidth - 40, startW + (ev.clientX - startX)));
            const newH = Math.max(150, Math.min(window.innerHeight - 40, startH + (ev.clientY - startY)));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.transform = 'none';
            onResize?.();
        }
        function onUp() {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            saveAppletPositions();
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
    });
}
function initPreviewResize() {
    _initPanelResize('applet-capture-preview', 'cap-resize-handle', () => {
        if (captureViewer?.pixels) captureViewer._renderStretched();
        captureViewer?.fitZoom();
    });
    _initPanelResize('applet-guide-preview', 'guide-resize-handle', () => {
        if (guideViewer?.pixels) {
            guideViewer.fitZoom();
            const meta = guideViewer._renderStretched();
            if (meta) guideViewer._guideCaptureData = { ...guideViewer._guideCaptureData, ...meta };
            _guideDetectStars(guideViewer.imgW, guideViewer.imgH);
        }
    });
}

// ── Preview zoom / pan / enlarge ────────────────────────────

function _applyPreviewTransform() { captureViewer?._applyTransform(); }
function _resetPreviewZoom() { captureViewer?.resetZoom(); }
function _fitPreviewZoom() { captureViewer?.fitZoom(); }
function initPreviewZoomPan() { captureViewer?.initZoomPan(); }

// ── ADU cursor ───────────────────────────────────────────────────
let _aduFetchTimer = 0;
let _aduLastReq = '';
function initAduCursor() {
    const viewport = document.getElementById('cap-preview-viewport');
    const info = document.getElementById('cap-adu-cursor');
    const canvas = document.getElementById('cap-preview-canvas');
    if (!viewport || !info || !canvas) return;
    function update(e) {
        const cv = captureViewer;
        if (!cv || !cv.imgW || !cv.imgH) { info.textContent = ' '; return; }
        const cRect = canvas.getBoundingClientRect();
        if (cRect.width === 0 || cRect.height === 0) { info.textContent = ' '; return; }
        // canvas CSS size vs image size (transform pan/zoom already accounted via getBoundingClientRect)
        // On calcule la position image brute via rect du canvas (qui inclut transform scale)
        // Plus simple: mappe clientX -> pixel via比例 canvas rect / imgW
        const scaleX = cRect.width / cv.imgW;
        const scaleY = cRect.height / cv.imgH;
        const xImg = (e.clientX - cRect.left) / scaleX;
        const yImg = (e.clientY - cRect.top) / scaleY;
        const ix = Math.floor(xImg);
        const iy = Math.floor(yImg);
        if (ix < 0 || ix >= cv.imgW || iy < 0 || iy >= cv.imgH) { info.textContent = ' '; return; }
        // Si FITS en mémoire, lecture directe (rare : JPEG pleine résolution a pixels=null)
        if (cv.pixels && cv.imgW && cv.imgH) {
            const arrayY = cv.imgH - 1 - iy;
            const adu = cv.pixels[arrayY * cv.imgW + ix];
            if (adu !== undefined && !isNaN(adu)) {
                info.textContent = `x:${ix} y:${iy} ADU:${Math.round(adu)}`;
                return;
            }
        }
        // JPEG (vignette 1024 ou pleine 6224) → ADU du vrai FITS côté serveur (avec mise à l'échelle si vignette)
        let fx = ix, fy = iy;
        if (cv._statsHist && cv._statsHist.w && cv.imgW !== cv._statsHist.w) {
            const s = cv._statsHist.w / cv.imgW;
            fx = Math.floor(ix * s);
            fy = Math.floor(iy * s);
        }
        const key = `${fx},${fy}`;
        if (_aduLastReq === key) return;
        _aduLastReq = key;
        info.textContent = `x:${ix} y:${iy} ADU:…`;
        clearTimeout(_aduFetchTimer);
        _aduFetchTimer = setTimeout(()=>{
            const cam = (typeof findCamera === 'function' ? findCamera()?.name : '') || '';
            const devParam = cam ? `&device=${encodeURIComponent(cam)}` : '';
            fetch(`/api/camera/last_image/adu?x=${fx}&y=${fy}${devParam}`).then(r=>r.json()).then(j=>{
                if (j && j.ok && j.adu !== null && j.adu !== undefined) {
                    info.textContent = `x:${ix} y:${iy} ADU:${Math.round(j.adu)}`;
                } else {
                    console.warn('ADU fail', j);
                    info.textContent = `x:${ix} y:${iy} —`;
                }
            }).catch(e=>{ console.warn('ADU fetch fail', e); info.textContent = `x:${ix} y:${iy} —`; });
        }, 80);
    }
    viewport.addEventListener('mousemove', update);
    viewport.addEventListener('mouseleave', () => { info.textContent = ' '; });
    viewport.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) update(e.touches[0]);
    }, {passive:true});
}

// ── Save image ─────────────────────────────────────────────────

function initSaveImage() {
    const dirInput = document.getElementById('cap-save-dir');
    const saveBtn = document.getElementById('cap-save-btn');
    if (dirInput) {
        dirInput.value = _saveDir;
        dirInput.addEventListener('change', () => {
            _saveDir = dirInput.value.trim();
            const mc = currentModeConfig();
            mc.save_dir = _saveDir;
            saveUiConfig();
        });
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (!_histPixels) { addLog('warning', 'capture', i18n('log.capture.no_image')); return; }
            const dir = _saveDir || document.getElementById('cap-save-dir')?.value?.trim() || '';
            if (!dir) { addLog('warning', 'capture', i18n('log.capture.choose_dir')); return; }
            try {
                const res = await fetch('/api/camera/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dir, filter: _captureFilter }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'capture', i18nFmt('log.capture.image_saved', { path: data.path }));
                else addLog('error', 'capture', i18nFmt('log.ws.error', { err: data.error }));
            } catch (e) {
                addLog('error', 'capture', i18nFmt('log.ws.error', { err: e.message }));
            }
        });
    }
}

// ── Offset overlay (vecteur décalage sur viewer) ─────────────

let _offsetTargetRA = null;    // RA cible en degrés
let _offsetTargetDEC = null;   // DEC cible en degrés
let _offsetSolvedRA = null;    // RA résolu en degrés
let _offsetSolvedDEC = null;   // DEC résolu en degrés
let _offsetScaleArcsec = null; // échelle arcsec/px du dernier solve
let _offsetRotation = null;    // rotation image en degrés
let _offsetVisible = false;

function _syncOverlaySize() {
    const overlay = document.getElementById('offset-overlay-canvas');
    if (!overlay || !_histWidth || !_histHeight) return;
    overlay.width = _histWidth;
    overlay.height = _histHeight;
    overlay.style.width = _histWidth + 'px';
    overlay.style.height = _histHeight + 'px';
}

function clearOffsetOverlay() {
    _offsetVisible = false;
    const overlay = document.getElementById('offset-overlay-canvas');
    if (overlay) {
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        overlay.style.display = 'none';
    }
}

// ── Focus metrics overlay ──────────────────────────────────────

let _focusStars = [];
let _focusHFR = 0;
let _focusFWHM = 0;
let _focusVisible = false;

// Bahtinov overlay state (set by focuser.js, drawn with the focus overlay).
// Coords in FITS pixels (+ fitsW for display scaling) — survives zoom/pan
// via the same CSS transform as star circles.
var _bhtOverlay = null;
function setBhtOverlay(o) {
    _bhtOverlay = o;
    _focusVisible = true;
    drawFocusOverlay();
}
function clearBhtOverlay() {
    _bhtOverlay = null;
}
function drawBhtOverlay(ctx) {
    const o = _bhtOverlay;
    if (!o || !o.lines || !o.fitsW) return;
    const overlay = document.getElementById('focus-overlay-canvas');
    if (!overlay || !overlay.width) return;
    const s = overlay.width / o.fitsW;
    ctx.save();
    ctx.lineWidth = 1.5;
    o.lines.forEach((ln, i) => {
        ctx.strokeStyle = i === o.centerIdx ? 'rgba(255,204,0,0.9)' : 'rgba(0,255,204,0.7)';
        ctx.beginPath();
        ctx.moveTo(ln[0] * s, ln[1] * s);
        ctx.lineTo(ln[2] * s, ln[3] * s);
        ctx.stroke();
    });
    // Intersection cross (red)
    const ix = o.ix * s, iy = o.iy * s;
    ctx.strokeStyle = 'rgba(255,80,80,0.95)';
    ctx.beginPath();
    ctx.moveTo(ix - 6, iy); ctx.lineTo(ix + 6, iy);
    ctx.moveTo(ix, iy - 6); ctx.lineTo(ix, iy + 6);
    ctx.stroke();
    ctx.restore();
}

function clearFocusOverlay() {
    _focusVisible = false;
    _focusStars = [];
    _bhtOverlay = null;
    const overlay = document.getElementById('focus-overlay-canvas');
    if (overlay) {
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        overlay.style.display = 'none';
    }
    const info = document.getElementById('focus-metric-info');
    if (info) info.textContent = '';
}

function drawFocusOverlay() {
    if (!_focusStars.length && !_bhtOverlay) return;
    const overlay = document.getElementById('focus-overlay-canvas');
    const canvas = document.getElementById('cap-preview-canvas');
    if (!overlay || !canvas) return;

    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = canvas.width + 'px';
    overlay.style.height = canvas.height + 'px';
    overlay.style.display = 'block';

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Draw circles on detected stars
    for (const star of _focusStars) {
        const r = Math.max(star.hfr || 3, 3);
        ctx.beginPath();
        ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,255,204,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Small crosshair at center
        ctx.beginPath();
        ctx.moveTo(star.x - 2, star.y);
        ctx.lineTo(star.x + 2, star.y);
        ctx.moveTo(star.x, star.y - 2);
        ctx.lineTo(star.x, star.y + 2);
        ctx.strokeStyle = ('rgba(' + cssVar('--accent-rgb') + ',0.8)');
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // HFR/FWHM label in top-left
    const info = document.getElementById('focus-metric-info');
    if (info) {
        info.textContent = `HFR: ${_focusHFR.toFixed(1)}px  FWHM: ${_focusFWHM.toFixed(1)}px  ★${_focusStars.length}`;
    }

    // Bahtinov spikes (same transform, FITS coords scaled to display)
    drawBhtOverlay(ctx);

    // Sync transform with preview
    const t = `translate(${_previewPanX}px, ${_previewPanY}px) scale(${_previewZoom})`;
    overlay.style.transform = t;
}

function requestFocusMetrics() {
    if (currentMode !== 'focuser') return;
    fetch('/api/focuser/focus-metric')
        .then(r => r.json())
        .then(data => {
            if (!data.ok || !data.stars) {
                clearFocusOverlay();
                return;
            }
            _focusStars = data.stars;
            _focusHFR = data.hfr;
            _focusFWHM = data.fwhm;
            _focusVisible = true;
            drawFocusOverlay();

            // Record HFR data point for the focus chart
            const f = findFocuser();
            const pos = f ? (f.dev.position ?? 0) : 0;
            _focHfrData.push({
                step: _focHfrStep++,
                position: pos,
                hfr: data.hfr,
                fwhm: data.fwhm,
                timestamp: Date.now()
            });
            if (_focHfrData.length > 200) _focHfrData.shift();
            _focDrawHfrChart();
        })
        .catch(() => clearFocusOverlay());
}

function setOffsetTarget(ra, dec) {
    _offsetTargetRA = ra;
    _offsetTargetDEC = dec;
    if (_offsetSolvedRA != null) drawOffsetVector();
}
// Expose for sky-engine context menu
window.setOffsetTarget = setOffsetTarget;

function setOffsetSolved(ra, dec, scaleArcsec, rotationDeg) {
    _offsetSolvedRA = ra;
    _offsetSolvedDEC = dec;
    _offsetScaleArcsec = scaleArcsec;
    _offsetRotation = rotationDeg;
    if (_offsetTargetRA != null) drawOffsetVector();
}

function drawOffsetVector() {
    if (_offsetSolvedRA == null || _offsetSolvedDEC == null) return;
    if (_offsetTargetRA == null || _offsetTargetDEC == null) return;
    if (!_offsetScaleArcsec || !_histWidth || !_histHeight) return;

    const overlay = document.getElementById('offset-overlay-canvas');
    if (!overlay) return;
    _syncOverlaySize();
    overlay.style.display = 'block';
    _offsetVisible = true;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const w = overlay.width;
    const h = overlay.height;
    const cx = w / 2;
    const cy = h / 2;

    // Delta RA/DEC en degrés → arcmin
    const deltaRA = (_offsetTargetRA - _offsetSolvedRA) * 60;  // arcmin
    const deltaDEC = (_offsetTargetDEC - _offsetSolvedDEC) * 60; // arcmin

    // Conversion arcmin → pixels
    const scaleArcminPx = _offsetScaleArcsec / 60.0;
    let dxPx = deltaRA / scaleArcminPx;
    let dyPx = deltaDEC / scaleArcminPx;

    // Appliquer la rotation de l'image pour orienter correctement le vecteur
    // La rotation Seiza est en degrés, sens horaire
    const rotRad = (_offsetRotation || 0) * Math.PI / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const rdx = dxPx * cosR - dyPx * sinR;
    const rdy = dxPx * sinR + dyPx * cosR;

    // Origine = centre image (position résolue)
    const x1 = cx;
    const y1 = cy;
    const x2 = cx + rdx;
    const y2 = cy - rdy; // inversion Y (canvas Y descend)

    // Limiter la longueur max du vecteur
    const maxLen = Math.min(w, h) * 0.45;
    const len = Math.sqrt(rdx * rdx + rdy * rdy);
    let drawX2 = x2, drawY2 = y2;
    if (len > maxLen) {
        const scale = maxLen / len;
        drawX2 = x1 + rdx * scale;
        drawY2 = y1 - rdy * scale;
    }

    // ── Dessiner le vecteur ──

    // Ligne principale
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(drawX2, drawY2);
    ctx.stroke();

    // Flèche (tête)
    const arrowLen = 14;
    const arrowAngle = Math.atan2(drawY2 - y1, drawX2 - x1);
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.moveTo(drawX2, drawY2);
    ctx.lineTo(
        drawX2 - arrowLen * Math.cos(arrowAngle - 0.35),
        drawY2 - arrowLen * Math.sin(arrowAngle - 0.35)
    );
    ctx.lineTo(
        drawX2 - arrowLen * Math.cos(arrowAngle + 0.35),
        drawY2 - arrowLen * Math.sin(arrowAngle + 0.35)
    );
    ctx.closePath();
    ctx.fill();

    // Point origine (position résolue)
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.arc(x1, y1, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#003322';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Réticule cible (à la pointe du vecteur)
    const tgtX = drawX2, tgtY = drawY2;
    const tgtR = 10;
    ctx.strokeStyle = cssVar('--status-warning');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    // Cercle
    ctx.beginPath();
    ctx.arc(tgtX, tgtY, tgtR, 0, Math.PI * 2);
    ctx.stroke();
    // Croix
    ctx.beginPath();
    ctx.moveTo(tgtX - tgtR - 4, tgtY);
    ctx.lineTo(tgtX + tgtR + 4, tgtY);
    ctx.moveTo(tgtX, tgtY - tgtR - 4);
    ctx.lineTo(tgtX, tgtY + tgtR + 4);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Étiquettes ──

    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    // Label distance
    const distArcmin = Math.sqrt(deltaRA * deltaRA + deltaDEC * deltaDEC);
    const distLabel = distArcmin < 10
        ? `${distArcmin.toFixed(1)}'`
        : `${distArcmin.toFixed(0)}'`;

    // Position du label (à côté de la pointe)
    const labelX = drawX2 + 10;
    const labelY = drawY2 - 6;

    // Fond semi-transparent pour lisibilité
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const tw = ctx.measureText(distLabel).width;
    ctx.fillRect(labelX - 3, labelY - 12, tw + 6, 15);

    ctx.fillStyle = cssVar('--accent');
    ctx.fillText(distLabel, labelX, labelY);

    // Flèches cardinales (si rotation connue)
    if (_offsetRotation != null) {
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(0,255,204,0.5)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Direction RA (Est) tournée par la rotation
        const eAngle = -rotRad; // Est = 0° avant rotation
        const nAngle = -rotRad + Math.PI / 2; // Nord = 90° avant rotation
        const arrowR = 28;

        ctx.fillText('E', cx + arrowR * Math.cos(eAngle), cy - arrowR * Math.sin(eAngle));
        ctx.fillText('N', cx + arrowR * Math.cos(nAngle), cy - arrowR * Math.sin(nAngle));
    }
}
