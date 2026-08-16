// ═══════════════════════════════════════════════════════════════
// Noctua — preview.js (module classique, bindings lexicaux globaux)
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
        ovCtx.strokeStyle = selected ? '#ff6600' : 'rgba(0,255,204,0.8)';
        ovCtx.lineWidth = selected ? 2.5 * dpr : 1.5 * dpr;
        ovCtx.beginPath(); ovCtx.arc(px, py, radius, 0, Math.PI * 2); ovCtx.stroke();

        // Crosshair
        const ch = radius + 3 * dpr;
        ovCtx.beginPath(); ovCtx.moveTo(px - ch, py); ovCtx.lineTo(px + ch, py); ovCtx.stroke();
        ovCtx.beginPath(); ovCtx.moveTo(px, py - ch); ovCtx.lineTo(px, py + ch); ovCtx.stroke();

        // Dimmest stars: smaller, fainter markers
        if (i >= 5 && !selected) {
            ovCtx.strokeStyle = 'rgba(0,255,204,0.3)';
            ovCtx.lineWidth = 1 * dpr;
            ovCtx.beginPath(); ovCtx.arc(px, py, 3 * dpr, 0, Math.PI * 2); ovCtx.stroke();
        }

        // Label top 5 or selected
        if (i < 5 || selected) {
            ovCtx.fillStyle = selected ? '#ff6600' : '#aaa';
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
            statusEl.style.color = '#00ffcc';
        } else if (_guideStarList.length > 0) {
            statusEl.textContent = i18nFmt('preview.star_list', { n: _guideStarList.length });
            statusEl.style.color = '#ffaa00';
        } else {
            statusEl.textContent = i18n('preview.no_star');
            statusEl.style.color = '#ff4444';
        }
    }
}

function _guideSetStar(star) {
    _guideSelectedStar = star;
    if (star) {
        const w = _guideCap()?.width || 1;
        const h = _guideCap()?.height || 1;
        apiPost('/api/guide/set-reference', { x: star.x, y: h - 1 - star.y });
        Bus.emit('guide:starSelected', { star }, { source: 'preview' });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            const idx = _guideStarList.indexOf(star) + 1;
            statusEl.textContent = `⭐ Étoile #${idx} (${star.x}, ${star.y}) — Prêt pour guidage`;
            statusEl.style.color = '#00ffcc';
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
        Bus.emit('guide:starSelected', { star: _guideSelectedStar }, { source: 'preview' });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            statusEl.textContent = `⭐ Auto: étoile (${best.x}, ${best.y}) qualité=${best.gaussian_quality} — Prêt`;
            statusEl.style.color = '#00ffcc';
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

// ── Bus ───────────────────────────────────────────────────────

// Consommateur ws:image : route l'image vers le viewer guide ou capture.
Bus.on('ws:image', (env) => {
    const { device, format, data } = env.payload;
    const guideCam = _guideCameraSelect?.value || '';
    console.log('WS image: device=%s format=%s guideCam=%s match=%s', device, format, guideCam, device === guideCam);
    if (guideCam && device === guideCam) {
        handleGuideImage(data, format);
    } else {
        handleCameraImage(data, format);
    }
});

let _guideStarList = [];
let _guideSelectedStar = null;
function _guideCap() { return guideViewer?._guideCaptureData || _guideLegacyCapture; }
let _guideLegacyCapture = null;
let _guideAutoStar = null;

function handleCameraImage(b64Data, fmt) {
    clearOffsetOverlay();
    clearFocusOverlay();
    const raw = atob(b64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (captureViewer) captureViewer.render(bytes, fmt);
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

function clearFocusOverlay() {
    _focusVisible = false;
    _focusStars = [];
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
    if (!_focusStars.length) return;
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
        ctx.strokeStyle = 'rgba(0,255,204,0.8)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // HFR/FWHM label in top-left
    const info = document.getElementById('focus-metric-info');
    if (info) {
        info.textContent = `HFR: ${_focusHFR.toFixed(1)}px  FWHM: ${_focusFWHM.toFixed(1)}px  ★${_focusStars.length}`;
    }

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
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(drawX2, drawY2);
    ctx.stroke();

    // Flèche (tête)
    const arrowLen = 14;
    const arrowAngle = Math.atan2(drawY2 - y1, drawX2 - x1);
    ctx.fillStyle = '#00ffcc';
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
    ctx.fillStyle = '#00ffcc';
    ctx.beginPath();
    ctx.arc(x1, y1, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#003322';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Réticule cible (à la pointe du vecteur)
    const tgtX = drawX2, tgtY = drawY2;
    const tgtR = 10;
    ctx.strokeStyle = '#ff8800';
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

    ctx.fillStyle = '#00ffcc';
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
