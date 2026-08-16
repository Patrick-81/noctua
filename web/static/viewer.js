// ═══════════════════════════════════════════════════════════════
// Noctua — Viewer (aperçu FITS / non-FITS, zoom/pan, histogramme)
// Classe extraite d'app.js (script classique, globals partagés).
// Dépendances globales : state.js (config, vars preview), layout.js (toggleMinimize).
// ═══════════════════════════════════════════════════════════════

class Viewer {
    static MODES = {
        capture: {
            containerId: 'applet-capture-preview', canvasId: 'cap-preview-canvas',
            viewportId: 'cap-preview-viewport', emptyId: 'cap-preview-empty',
            wrapId: 'cap-preview-wrap', infoId: 'cap-preview-info',
            resizeHandleId: 'cap-resize-handle',
            zoomLevelId: 'cap-zoom-level', zoomResetId: 'cap-zoom-reset',
            zoomFitId: 'cap-zoom-fit', zoomEnlargeId: 'cap-zoom-enlarge',
            overlayIds: ['offset-overlay-canvas', 'focus-overlay-canvas'],
            features: { histogram: true, save: true, enlarge: true, resize: true,
                        starSelect: false, guideButtons: false, focusMetrics: false, offsetVector: false }
        },
        guiding: {
            containerId: 'applet-guide-preview', canvasId: 'guide-preview-canvas',
            viewportId: 'guide-preview-viewport',
            overlayIds: ['guide-preview-overlay'],
            resizeHandleId: 'guide-resize-handle',
            zoomLevelId: 'guide-preview-zoom-level', zoomResetId: 'guide-preview-zoom-reset',
            zoomFitId: 'guide-preview-zoom-fit', zoomEnlargeId: 'guide-zoom-enlarge',
            features: { starSelect: true, guideButtons: true, histogram: false,
                        save: false, enlarge: true, resize: true,
                        focusMetrics: false, offsetVector: false }
        },
        focuser: {
            containerId: 'applet-capture-preview', canvasId: 'cap-preview-canvas',
            viewportId: 'cap-preview-viewport', emptyId: 'cap-preview-empty',
            wrapId: 'cap-preview-wrap', infoId: 'cap-preview-info',
            resizeHandleId: 'cap-resize-handle',
            zoomLevelId: 'cap-zoom-level', zoomResetId: 'cap-zoom-reset',
            zoomFitId: 'cap-zoom-fit', zoomEnlargeId: 'cap-zoom-enlarge',
            overlayIds: ['focus-overlay-canvas'],
            features: { histogram: true, focusMetrics: true, enlarge: true, resize: true,
                        save: false, starSelect: false, guideButtons: false, offsetVector: false }
        },
        astrometry: {
            containerId: 'applet-capture-preview', canvasId: 'cap-preview-canvas',
            viewportId: 'cap-preview-viewport', emptyId: 'cap-preview-empty',
            wrapId: 'cap-preview-wrap', infoId: 'cap-preview-info',
            resizeHandleId: 'cap-resize-handle',
            zoomLevelId: 'cap-zoom-level', zoomResetId: 'cap-zoom-reset',
            zoomFitId: 'cap-zoom-fit', zoomEnlargeId: 'cap-zoom-enlarge',
            overlayIds: ['offset-overlay-canvas'],
            features: { histogram: true, offsetVector: true, enlarge: true, resize: true,
                        save: false, starSelect: false, guideButtons: false, focusMetrics: false }
        }
    };

    constructor(mode) {
        this.mode = mode;
        Object.assign(this, Viewer.MODES[mode]);
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.pixels = null;
        this.imgW = 0;
        this.imgH = 0;
        this.sky = 0;
        this.soft = 0;
        this.k = 0;
        this.histPixels = null;
        this.histAuto = true;
        this.histBlackPct = 0;
        this.histMin = 0;
        this.histMax = 0;
        this.histDataMin = 0;
        this.histDataMax = 0;
        this._touchState = null;
    }

    configure(mode) {
        const cfg = Viewer.MODES[mode];
        if (!cfg) return;
        this.mode = mode;
        Object.assign(this, cfg);
        // Prefer the global #viewer-title as the canonical mode title element.
        // Object.assign() above already replaced this.containerId, so fall back to
        // the container's own hud-title only when there is no global title element.
        const titleEl = document.getElementById('viewer-title')
            || document.getElementById(this.containerId)?.querySelector('.hud-title');
        if (titleEl && Viewer.MODES[mode]) {
            const titles = { capture: 'viewer.title_capture', guiding: 'viewer.title_guiding',
                            focuser: 'viewer.title_focuser', astrometry: 'viewer.title_astrometry' };
            titleEl.textContent = i18n(titles[mode] || 'viewer.title_default');
        }
        this._applyFeatures();
    }

    _applyFeatures() {
        const f = this.features;
        // Histogram controls
        for (const id of ['cap-histo-canvas', 'cap-histo-slider', 'cap-histo-auto']) {
            const el = document.getElementById(id);
            if (el) el.style.display = f.histogram ? '' : 'none';
        }
        for (const sel of ['.cap-histo-label', '.cap-histo-row']) {
            const el = document.querySelector(sel);
            if (el) el.style.display = f.histogram ? '' : 'none';
        }
        const hval = document.getElementById('cap-histo-val');
        if (hval) hval.style.display = f.histogram ? '' : 'none';
        // Save section
        const saveSection = document.getElementById('cap-save-dir')?.closest('.cap-section');
        if (saveSection) saveSection.style.display = f.save ? '' : 'none';
        // Enlarge button
        const enlargeBtn = document.getElementById(this.zoomEnlargeId);
        if (enlargeBtn) enlargeBtn.style.display = f.enlarge ? '' : 'none';
        // Hide the other viewer's enlarge button
        const otherEnlId = this.zoomEnlargeId === 'cap-zoom-enlarge' ? 'guide-zoom-enlarge' : 'cap-zoom-enlarge';
        const otherEnl = document.getElementById(otherEnlId);
        if (otherEnl && otherEnl !== enlargeBtn) otherEnl.style.display = 'none';
        // Resize handle
        const resizeH = document.getElementById(this.resizeHandleId);
        if (resizeH) resizeH.style.display = f.resize ? '' : 'none';
        // Also try the other viewer's handle if in shared panel context
        const otherId = this.resizeHandleId === 'cap-resize-handle' ? 'guide-resize-handle' : 'cap-resize-handle';
        const otherH = document.getElementById(otherId);
        if (otherH && otherH !== resizeH) otherH.style.display = 'none';
    }

    setStatus(msg, color) {
        const el = document.getElementById(this.canvasId.replace('-canvas', '-status'));
        if (el) { el.textContent = msg; if (color) el.style.color = color; }
    }

    setInfo(text) {
        const info = document.getElementById('cap-preview-info');
        if (info) info.textContent = text;
    }

    // ── FITS parsing ──

    _parseFITS(bytes) {
        let offset = 0, headerStr = '';
        const decoder = new TextDecoder('ascii');
        while (offset < bytes.length) {
            headerStr += decoder.decode(bytes.slice(offset, offset + 2880));
            offset += 2880;
            for (let c = headerStr.length - 2880; c < headerStr.length; c += 80)
                if (headerStr.substring(c, c + 3).trim() === 'END') return this._decodeFITS(bytes, headerStr, offset);
        }
        return null;
    }

    _decodeFITS(bytes, headerStr, dataStart) {
        const get = (key) => {
            for (let i = 0; i < headerStr.length; i += 80) {
                const card = headerStr.substring(i, i + 80);
                if (card.substring(0, 8).trim() !== key) continue;
                const eqIdx = card.indexOf('=');
                if (eqIdx < 0) continue;
                let val = card.substring(eqIdx + 1).trim();
                const si = val.indexOf('/');
                if (si >= 0) val = val.substring(0, si);
                return val.trim().replace(/^['"]|['"]$/g, '').split(/\s+/)[0];
            }
            return null;
        };
        const naxis = parseInt(get('NAXIS') || '0');
        const w = parseInt(get('NAXIS1') || '0');
        const h = parseInt(get('NAXIS2') || '0');
        const bitpix = parseInt(get('BITPIX') || '16');
        if (naxis < 2 || !w || !h) return null;

        const remaining = bytes.length - dataStart;
        const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, remaining);
        const pixels = new Float64Array(w * h);
        if (bitpix === 32 || bitpix === -32)
            for (let i = 0; i < w * h && i * 4 + 4 <= remaining; i++) pixels[i] = view.getFloat32(i * 4, false);
        else if (bitpix === 16)
            for (let i = 0; i < w * h && i * 2 + 2 <= remaining; i++) pixels[i] = view.getInt16(i * 2, false);
        else if (bitpix === -16)
            for (let i = 0; i < w * h && i * 2 + 2 <= remaining; i++) pixels[i] = view.getUint16(i * 2, false);
        else if (bitpix === 64)
            for (let i = 0; i < w * h && i * 8 + 8 <= remaining; i++) pixels[i] = view.getFloat64(i * 8, false);
        else if (bitpix === 8)
            for (let i = 0; i < w * h && i < remaining; i++) pixels[i] = bytes[dataStart + i];
        else return null;

        let max = -Infinity;
        for (let i = 0; i < pixels.length; i++) if (pixels[i] > max) max = pixels[i];
        const sorted = Float64Array.from(pixels).sort();
        const sky = sorted[Math.floor(sorted.length * 0.5)] || 0;
        const sigma = sorted[Math.floor(sorted.length * 0.841)] - sky || 1;
        return { w, h, pixels, sky, soft: sigma * 0.5, k: Math.max(20, (max - sky) / sigma) };
    }

    // ── Rendering ──

    render(bytes, fmt) {
        if (fmt === 'image/fits' || (bytes.length > 0 && bytes[0] === 0x53)) {
            this._renderFITS(bytes);
        } else {
            this._renderNonFITS(bytes, fmt);
        }
    }

    _showWrap() {
        if (this.wrapId) {
            const w = document.getElementById(this.wrapId);
            if (w) w.style.display = 'flex';
        }
        if (this.emptyId) {
            const e = document.getElementById(this.emptyId);
            if (e) e.style.display = 'none';
        }
    }

    _renderFITS(bytes) {
        const result = this._parseFITS(bytes);
        if (!result) { this.setStatus(i18n('viewer.bad_fits'), '#ff4444'); return; }
        const { w, h, pixels, sky, soft, k } = result;
        this.pixels = pixels;
        this.imgW = w;
        this.imgH = h;
        this.sky = sky;
        this.soft = soft;
        this.k = k;

        this._showWrap();
        this._renderStretched();

        // Sync overlays
        for (const id of this.overlayIds || []) {
            const ov = document.getElementById(id);
            if (ov) { ov.width = w; ov.height = h; ov.style.width = w + 'px'; ov.style.height = h + 'px'; }
        }

        if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry') {
            this.histPixels = pixels;
            this.histDataMin = sky - 3 * (soft * 2);
            this.histDataMax = sky + k * (soft * 2);
            this.histMin = this.histDataMin;
            this.histMax = this.histDataMax;
            // Set legacy globals for overlay/save/solver compatibility
            _histPixels = pixels;
            _histWidth = w; _histHeight = h;
            _histDataMin = this.histDataMin; _histDataMax = this.histDataMax;
            _histMin = this.histMin; _histMax = this.histMax;
            this.fitZoom();
            this.renderHistogram();
            this.setInfo(`${w}×${h} — FITS`);
        } else {
            this.setStatus(`Image ${w}×${h} ✓`, '#44cc44');
            this.fitZoom();
        }
    }

    _renderNonFITS(bytes, fmt) {
        const blob = new Blob([bytes], { type: fmt || 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const canvas = document.getElementById(this.canvasId);
            if (canvas) { canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); }
            for (const id of this.overlayIds || []) {
                const ov = document.getElementById(id);
                if (ov) { ov.width = img.width; ov.height = img.height; ov.style.width = img.width + 'px'; ov.style.height = img.height + 'px'; }
            }
            this._showWrap();
            if (this.mode === 'capture') this.setInfo(`${img.width}×${img.height} — ${fmt}`);
            else this.setStatus(`Image ${img.width}×${img.height} (${fmt}) ✓`, '#44cc44');
            URL.revokeObjectURL(url);
        };
        img.onerror = () => { this.setStatus('⚠️ Format: ' + fmt, '#ff4444'); URL.revokeObjectURL(url); };
        img.src = url;
    }

    _renderStretched(canvasEl) {
        canvasEl = canvasEl || document.getElementById(this.canvasId);
        if (!canvasEl || !this.pixels) return;
        const ctx = canvasEl.getContext('2d');
        const w = this.imgW, h = this.imgH;
        const dpr = window.devicePixelRatio || 1;
        const cw = canvasEl.clientWidth || parseInt(canvasEl.getAttribute('width')) || w;
        const ch = canvasEl.clientHeight || parseInt(canvasEl.getAttribute('height')) || h;
        const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
        if (canvasEl.width !== bw || canvasEl.height !== bh) { canvasEl.width = bw; canvasEl.height = bh; }
        ctx.clearRect(0, 0, bw, bh);

        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tctx = tmp.getContext('2d');
        const imgData = tctx.createImageData(w, h);
        const data = imgData.data;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const raw = this.pixels[y * w + x];
                const v = Math.asinh(Math.max(0, raw - this.sky) / this.soft) / Math.asinh(this.k);
                const val = Math.max(0, Math.min(255, Math.round(v * 255)));
                const dst = ((h - 1 - y) * w + x) * 4;
                data[dst] = val; data[dst + 1] = val; data[dst + 2] = val; data[dst + 3] = 255;
            }
        }
        tctx.putImageData(imgData, 0, 0);
        const scale = Math.min(bw / w, bh / h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, (bw - w * scale) / 2, (bh - h * scale) / 2, w * scale, h * scale);
        return { scale, offX: (bw - w * scale) / 2, offY: (bh - h * scale) / 2, canvasW: bw, canvasH: bh };
    }

    // ── Zoom / Pan ──

    resetZoom() {
        this.zoom = 1; this.panX = 0; this.panY = 0;
        this._applyTransform();
    }

    fitZoom() {
        const canvas = document.getElementById(this.canvasId);
        if (!canvas || !this.imgW || !this.imgH) return;
        const vp = document.getElementById(this.viewportId);
        if (!vp) return;
        const vpW = vp.clientWidth, vpH = vp.clientHeight;
        if (!vpW || !vpH) return;
        this.zoom = Math.min(vpW / this.imgW, vpH / this.imgH) * 0.95;
        this.panX = 0; this.panY = 0;
        if (this.mode === 'guiding') {
            // Anchor canvas/overlay to image pixels; transform does the fitting.
            // Avoids double-scaling (canvas CSS 100% + scale(zoom)) that made the
            // preview shrink erratically on panel resize.
            const fs = Math.min(vpW / this.imgW, vpH / this.imgH) * 0.95;
            this.zoom = fs;
            this.panX = (vpW - this.imgW * fs) / 2;
            this.panY = (vpH - this.imgH * fs) / 2;
            const canvasEl = document.getElementById(this.canvasId);
            if (canvasEl) { canvasEl.style.width = this.imgW + 'px'; canvasEl.style.height = this.imgH + 'px'; }
            for (const id of this.overlayIds || []) {
                const ov = document.getElementById(id);
                if (ov) { ov.style.width = this.imgW + 'px'; ov.style.height = this.imgH + 'px'; }
            }
        } else if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry') {
            const wrap = vp.parentElement;
            const maxH = Math.max(100, (wrap ? wrap.clientHeight : 400) - 80);
            const fs = Math.min(vpW / this.imgW, maxH / this.imgH, 1);
            this.zoom = fs;
            this.panX = (vpW - this.imgW * fs) / 2;
            this.panY = 0;
            const canvasEl = document.getElementById(this.canvasId);
            if (canvasEl) { canvasEl.style.width = this.imgW + 'px'; canvasEl.style.height = this.imgH + 'px'; }
            for (const id of this.overlayIds || []) {
                const ov = document.getElementById(id);
                if (ov) { ov.style.width = this.imgW + 'px'; ov.style.height = this.imgH + 'px'; }
            }
        }
        this._applyTransform();
    }

    _applyTransform() {
        const canvas = document.getElementById(this.canvasId);
        if (!canvas) return;
        const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        canvas.style.transform = t;
        for (const id of this.overlayIds || []) {
            const ov = document.getElementById(id);
            if (ov) ov.style.transform = t;
        }
        const lvl = document.getElementById(this.zoomLevelId);
        if (lvl) lvl.textContent = Math.round(this.zoom * 100) + '%';
        if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry') {
            const vp = document.getElementById(this.viewportId);
            if (vp) vp.classList.toggle('zoomed', this.zoom > 1.05);
            // Legacy globals for overlay functions
            _previewZoom = this.zoom;
            _previewPanX = this.panX;
            _previewPanY = this.panY;
        } else {
            _guidePreviewZoom = this.zoom;
            _guidePreviewPanX = this.panX;
            _guidePreviewPanY = this.panY;
        }
    }

    initZoomPan() {
        const vp = document.getElementById(this.viewportId);
        const canvas = document.getElementById(this.canvasId);
        if (!vp || !canvas) return;

        const isGuide = this.mode === 'guiding';

        // Wheel zoom
        vp.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            const rect = vp.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const old = this.zoom;
            if (isGuide) {
                this.zoom = Math.max(0.5, Math.min(20, this.zoom * (1 - e.deltaY * 0.001)));
            } else {
                if (!this.imgW) return;
                this.zoom = Math.max(0.1, Math.min(50, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            }
            const ratio = 1 - this.zoom / old;
            this.panX += mx * ratio; this.panY += my * ratio;
            this._applyTransform();
        }, { passive: false });

        // Pan / click (guide star select)
        let dragging = false, didDrag = false, sx = 0, sy = 0, psx = 0, psy = 0;
        vp.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, input, select')) return;
            dragging = true; didDrag = false;
            sx = e.clientX; sy = e.clientY;
            psx = this.panX; psy = this.panY;
            if (isGuide && this.zoom > 1) vp.style.cursor = 'grabbing';
            else vp.classList.add('panning');
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
            if ((isGuide && this.zoom > 1) || this.zoom > 1.05) {
                this.panX = psx + dx; this.panY = psy + dy;
                this._applyTransform();
            }
        });
        window.addEventListener('mouseup', (e) => {
            if (!dragging) return;
            dragging = false; vp.style.cursor = ''; vp.classList.remove('panning');
            if (!didDrag && isGuide && typeof _guideClick === 'function') {
                const rect = vp.getBoundingClientRect();
                _guideClick(e.clientX - rect.left, e.clientY - rect.top);
            }
        });

        // Double-click reset / enlarge
        vp.addEventListener('dblclick', () => {
            if (this.features?.enlarge && !isGuide) {
                const btn = document.getElementById(this.zoomEnlargeId);
                if (btn) btn.click();
            } else {
                this.resetZoom();
            }
        });

        // Buttons
        const resetBtn = document.getElementById(this.zoomResetId);
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetZoom());
        const fitBtn = document.getElementById(this.zoomFitId);
        if (fitBtn) fitBtn.addEventListener('click', () => this.fitZoom());

        // Enlarge button
        const enlBtn = document.getElementById(this.zoomEnlargeId);
        if (enlBtn) {
            enlBtn.addEventListener('click', () => {
                const panel = document.getElementById(this.containerId);
                if (!panel) return;
                const enlarged = panel.classList.toggle('enlarged');
                if (enlarged) {
                    panel.dataset.inlineStyle = panel.getAttribute('style') || '';
                    panel.dataset.prevDisplay = window.getComputedStyle(panel).display;
                    panel.removeAttribute('style');
                    setTimeout(() => this.fitZoom(), 50);
                } else {
                    const prevDisplay = panel.dataset.prevDisplay;
                    if (panel.dataset.inlineStyle && panel.dataset.inlineStyle !== 'display:block;') {
                        panel.setAttribute('style', panel.dataset.inlineStyle);
                    } else {
                        panel.removeAttribute('style');
                    }
                    delete panel.dataset.inlineStyle;
                    delete panel.dataset.prevDisplay;
                    if (prevDisplay && prevDisplay !== 'none') {
                        panel.style.display = prevDisplay;
                    }
                    this.resetZoom();
                    this._renderStretched();
                    this.fitZoom();
                }
            });
        }

        // Touch: pinch-to-zoom + single-finger pan
        if (!isGuide) {
            vp.addEventListener('touchstart', (e) => {
                if (!this.imgW) return;
                if (e.touches.length === 2) {
                    const dx = e.touches[0].clientX - e.touches[1].clientX;
                    const dy = e.touches[0].clientY - e.touches[1].clientY;
                    const rect = vp.getBoundingClientRect();
                    this._touchState = {
                        mode: 'pinch', startDist: Math.hypot(dx, dy),
                        startZoom: this.zoom, startPanX: this.panX, startPanY: this.panY,
                        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
                        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
                    };
                } else if (e.touches.length === 1 && this.zoom > 1.05) {
                    this._touchState = { mode: 'pan', startX: e.touches[0].clientX, startY: e.touches[0].clientY, startPanX: this.panX, startPanY: this.panY };
                    vp.classList.add('panning');
                }
            }, { passive: false });
            vp.addEventListener('touchmove', (e) => {
                const ts = this._touchState;
                if (!ts) return;
                if (ts.mode === 'pinch' && e.touches.length === 2) {
                    e.preventDefault();
                    const dx = e.touches[0].clientX - e.touches[1].clientX;
                    const dy = e.touches[0].clientY - e.touches[1].clientY;
                    const dist = Math.hypot(dx, dy);
                    const newZoom = Math.max(0.1, Math.min(50, ts.startZoom * (dist / ts.startDist)));
                    const sc = newZoom / ts.startZoom;
                    this.panX = ts.midX - sc * (ts.midX - ts.startPanX);
                    this.panY = ts.midY - sc * (ts.midY - ts.startPanY);
                    this.zoom = newZoom;
                    this._applyTransform();
                } else if (ts.mode === 'pan' && e.touches.length === 1) {
                    e.preventDefault();
                    this.panX = ts.startPanX + (e.touches[0].clientX - ts.startX);
                    this.panY = ts.startPanY + (e.touches[0].clientY - ts.startY);
                    this._applyTransform();
                }
            }, { passive: false });
            vp.addEventListener('touchend', () => { if (this._touchState?.mode === 'pan') vp.classList.remove('panning'); this._touchState = null; });
            vp.addEventListener('touchcancel', () => { vp.classList.remove('panning'); this._touchState = null; });
        }

        // Keyboard: Escape to exit enlarge (applies to whichever preview is enlarged)
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const enlBtnId = this.zoomEnlargeId;
            const btn = document.getElementById(enlBtnId);
            const panel = document.getElementById(this.containerId);
            if (btn && panel?.classList.contains('enlarged')) {
                e.preventDefault();
                btn.click();
            }
        });

        this.fitZoom();
    }

    // ── Histogram ──

    renderHistogram() {
        const canvas = document.getElementById('cap-histo-canvas');
        if (!canvas || !this.histPixels) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width = canvas.offsetWidth * 2;
        const H = canvas.height = canvas.offsetHeight * 2;
        const bins = new Uint32Array(256);
        const range = this.histDataMax - this.histDataMin || 1;
        for (let i = 0; i < this.histPixels.length; i++) {
            let v = Math.round((this.histPixels[i] - this.histDataMin) / range * 255);
            if (v < 0) v = 0; if (v > 255) v = 255;
            bins[v]++;
        }
        let maxBin = 0;
        for (let i = 1; i < 256; i++) if (bins[i] > maxBin) maxBin = bins[i];
        if (maxBin === 0) maxBin = 1;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, 0, W, H);
        const blackFrac = this.histAuto ? 0 : this.histBlackPct / 100;
        const blX = blackFrac * W;
        ctx.fillStyle = 'rgba(0,255,204,0.08)';
        ctx.fillRect(blX, 0, W - blX, H);
        for (let i = 0; i < 256; i++) {
            const bh = Math.max(1, (bins[i] / maxBin) * H);
            ctx.fillStyle = 'rgba(0,255,204,0.5)';
            ctx.fillRect(i * W / 256, H - bh, W / 256 + 1, bh);
        }
        ctx.strokeStyle = '#ff5577';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(blX, 0); ctx.lineTo(blX, H); ctx.stroke();
        const slider = document.getElementById('cap-histo-slider');
        if (slider) slider.value = this.histAuto ? 0 : this.histBlackPct;
        const val = document.getElementById('cap-histo-val');
        if (val) val.textContent = this.histAuto ? 'AUTO' : Math.round(this.histBlackPct) + '%';
    }

    applyHistogramStretch() {
        const canvas = document.getElementById(this.canvasId);
        if (!canvas || !this.histPixels || !this.imgW || !this.imgH) return;
        const ctx = canvas.getContext('2d');
        const w = this.imgW, h = this.imgH;
        const imgData = ctx.createImageData(w, h);
        const data = imgData.data;
        if (this.histAuto) {
            this.histMin = this.histDataMin;
            this.histMax = this.histDataMax;
        } else {
            const range = this.histDataMax - this.histDataMin;
            this.histMin = this.histDataMin + (this.histBlackPct / 100) * range;
            this.histMax = this.histDataMax;
        }
        const stretchRange = this.histMax - this.histMin || 1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const raw = this.histPixels[y * w + x];
                let val;
                if (raw <= this.histMin) val = 0;
                else if (raw >= this.histMax) val = 255;
                else val = Math.round(((raw - this.histMin) / stretchRange) * 255);
                const dst = ((h - 1 - y) * w + x) * 4;
                data[dst] = val; data[dst + 1] = val; data[dst + 2] = val; data[dst + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        const minEl = document.getElementById('cap-histo-min');
        const maxEl = document.getElementById('cap-histo-max');
        if (minEl) minEl.textContent = this.histMin.toFixed(1);
        if (maxEl) maxEl.textContent = this.histMax.toFixed(1);
    }

    // ── Guide-specific render (preserves star detection data) ──

    renderGuide(bytes, fmt, onDone) {
        if (fmt === 'image/fits' || (bytes.length > 0 && bytes[0] === 0x53)) {
            const result = this._parseFITS(bytes);
            if (!result) { this.setStatus(i18n('viewer.bad_fits'), '#ff4444'); onDone?.(); return; }
            Object.assign(this, result);
            this.imgW = result.w; this.imgH = result.h;
            this.pixels = result.pixels;

            // Ensure guide panel visible
            const panel = document.getElementById('applet-guide-preview');
            if (panel && panel.style.display === 'none') {
                panel.style.display = '';
                if (panel.classList.contains('collapsed')) toggleMinimize(panel);
            }
            // Anchor canvas/overlay to image pixels on first frame (or size change);
            // subsequent frames preserve the user's zoom/pan.
            const gvCanvas = document.getElementById(this.canvasId);
            if (!gvCanvas || parseInt(gvCanvas.style.width) !== result.w) {
                this.fitZoom();
            }
            const meta = this._renderStretched();
            if (meta) {
                this._guideCaptureData = { width: result.w, height: result.h, pixels: result.pixels,
                    sky: result.sky, soft: result.soft, k: result.k, ...meta,
                    dpr: window.devicePixelRatio || 1 };
            }
            if (this.zoom <= 0) this.resetZoom();

            this.setStatus(`Image ${result.w}×${result.h} ✓`, '#44cc44');
            onDone?.();
        } else {
            // Non-FITS guide image
            const blob = new Blob([bytes], { type: fmt || 'image/png' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const canvas = document.getElementById(this.canvasId);
                if (canvas) { canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); }
                this._guideCaptureData = { width: img.width, height: img.height };
                this.setStatus(`Image ${img.width}×${img.height} ✓`, '#44cc44');
                URL.revokeObjectURL(url);
                onDone?.();
            };
            img.onerror = () => { this.setStatus('⚠️ Format: ' + fmt, '#ff4444'); URL.revokeObjectURL(url); onDone?.(); };
            img.src = url;
        }
    }

    // ── Histogram ──

    initHistogramControls() {
        if (this.mode === 'guiding') return;
        const slider = document.getElementById('cap-histo-slider');
        const autoBtn = document.getElementById('cap-histo-auto');
        if (slider) {
            slider.addEventListener('input', () => {
                this.histBlackPct = parseInt(slider.value);
                this.histAuto = false;
                if (autoBtn) autoBtn.classList.remove('active');
                this.applyHistogramStretch();
                this.renderHistogram();
                const mc = currentModeConfig();
                mc.histo_auto = false; mc.histo_black_pct = this.histBlackPct;
                saveUiConfig();
            });
        }
        if (autoBtn) {
            autoBtn.addEventListener('click', () => {
                this.histAuto = !this.histAuto;
                autoBtn.classList.toggle('active', this.histAuto);
                this.applyHistogramStretch();
                this.renderHistogram();
                const mc = currentModeConfig();
                mc.histo_auto = this.histAuto;
                saveUiConfig();
            });
        }
        const mc = currentModeConfig();
        if (mc.histo_auto === false) {
            this.histAuto = false;
            if (autoBtn) autoBtn.classList.remove('active');
            if (mc.histo_black_pct != null) this.histBlackPct = mc.histo_black_pct;
        }
        if (mc.save_dir) { const el = document.getElementById('cap-save-dir'); if (el) el.value = mc.save_dir; }
    }
}
