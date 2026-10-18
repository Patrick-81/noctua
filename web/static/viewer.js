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
            overlayIds: ['offset-overlay-canvas', 'focus-overlay-canvas', 'aberr-overlay-canvas'],
            features: { histogram: true, save: true, enlarge: true, resize: true,
                        starSelect: false, guideButtons: false, focusMetrics: false, offsetVector: false, aberration: true }
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
        },
        aberration: {
            containerId: 'applet-capture-preview', canvasId: 'cap-preview-canvas',
            viewportId: 'cap-preview-viewport', emptyId: 'cap-preview-empty',
            wrapId: 'cap-preview-wrap', infoId: 'cap-preview-info',
            resizeHandleId: 'cap-resize-handle',
            zoomLevelId: 'cap-zoom-level', zoomResetId: 'cap-zoom-reset',
            zoomFitId: 'cap-zoom-fit', zoomEnlargeId: 'cap-zoom-enlarge',
            overlayIds: ['offset-overlay-canvas', 'focus-overlay-canvas', 'aberr-overlay-canvas'],
            features: { histogram: true, save: false, enlarge: true, resize: true,
                        starSelect: false, guideButtons: false, focusMetrics: false, offsetVector: false, aberration: true }
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

    // Remise à zéro à changement de caméra : pas d'image périmée affichée.
    clear(msg) {
        this.pixels = null; this.pixelsRGB = null; this.skyC = null;
        this._statsHist = null; this.imgW = 0; this.imgH = 0;
        this.imgMax = 0; this.sky = 0;
        try {
            const canvasEl = document.getElementById(this.canvasId);
            if (canvasEl) canvasEl.getContext('2d')?.clearRect(0, 0, canvasEl.width, canvasEl.height);
            for (const id of this.overlayIds || []) {
                const ov = document.getElementById(id);
                if (ov) ov.getContext('2d')?.clearRect(0, 0, ov.width, ov.height);
            }
        } catch (e) { /* canvas pas encore monté */ }
        if (msg) this.setStatus(msg, '#888');
    }

    setInfo(text) {        const info = document.getElementById('cap-preview-info');
        if (!info) return;
        // Durée acquisition→transfert (posée par preview.js avant render,
        // consommée une fois — pas de valeur périmée sur le rendu suivant).
        if (this.pendingXfer != null) {
            try { text += ' · ' + i18nFmt('cap.xfer', { s: this.pendingXfer }); }
            catch (e) { text += ` · ${this.pendingXfer}s`; }
            this.pendingXfer = null;
        }
        // Préserve le badge preview/définitif (fils) malgré textContent.
        const badge = document.getElementById('cap-image-stage');
        info.textContent = text;
        if (badge) {
            info.appendChild(document.createTextNode(' '));
            info.appendChild(badge);
        }
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
        // Échelle physique FITS : valeur = brut*BSCALE + BZERO. Les drivers
        // INDIGO sortent l'unsigned via BZERO=32768 : sans ça, tout ce qui
        // dépasse 32767 devient négatif (plafond blanc → bruit orange).
        const bzero = parseFloat(get('BZERO') || '0') || 0;
        let bscale = parseFloat(get('BSCALE') || '1');
        if (!(bscale > 0) && !(bscale < 0)) bscale = 1;

        const remaining = bytes.length - dataStart;
        const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, remaining);
        // RGB (NAXIS=3, ex. RisingCam) : lit les 3 plans + luma pour la
        // mesure. Avant : seul le 1er plan (R, quasi noir) était affiché !
        const nplanes = (naxis === 3) ? (parseInt(get('NAXIS3') || '0') || 3) : 1;
        const planeSize = w * h;
        const pixels = new Float32Array(planeSize);
        let pixelsRGB = null;
        const readPlane = (base, out, n) => {
            if (bitpix === 32 || bitpix === -32)
                for (let i = 0; i < n && i * 4 + 4 <= remaining - base; i++) out[i] = view.getFloat32(base + i * 4, false) * bscale + bzero;
            else if (bitpix === 16)
                for (let i = 0; i < n && i * 2 + 2 <= remaining - base; i++) out[i] = view.getInt16(base + i * 2, false) * bscale + bzero;
            else if (bitpix === -16)
                for (let i = 0; i < n && i * 2 + 2 <= remaining - base; i++) out[i] = view.getUint16(base + i * 2, false) * bscale + bzero;
            else if (bitpix === 64)
                for (let i = 0; i < n && i * 8 + 8 <= remaining - base; i++) out[i] = view.getFloat64(base + i * 8, false) * bscale + bzero;
            else if (bitpix === 8)
                for (let i = 0; i < n && i < remaining - base; i++) out[i] = bytes[dataStart + base + i] * bscale + bzero;
            else return false;
            return true;
        };

        // Plan 0 → pixels (luma/mono, comportement historique). RGB 8 bits :
        // conserve aussi les 3 plans pour l'affichage couleur (sinon on
        // n'affichait que le plan R, quasi noir → image « noire »).
        if (!readPlane(0, pixels, planeSize)) return null;
        // Bayer (NAXIS=2 + BAYERPAT, ex. RGGB) : dématriçage bilinéaire en
        // pleine dynamique (float, pas de passage 8 bits). Sans ça, la
        // mosaïque affichée en mono donne une « grille » sur les surfaces
        // claires. pixels = luma (mesure/HFR), pixelsRGB = couleur.
        // XBAYROFF/YBAYROFF décalent la phase du motif (ex. SV305PRO :
        // BAYERPAT=GRBG + XBAYROFF=1 ⇒ phase réelle RGGB). Les ignorer
        // permute les canaux au dématriçage ⇒ dominante chaude (orange).
        let bayerpat = String(get('BAYERPAT') || '').toUpperCase();
        const xoff = (parseInt(get('XBAYROFF') || '0', 10) & 1) ? 1 : 0;
        const yoff = (parseInt(get('YBAYROFF') || '0', 10) & 1) ? 1 : 0;
        bayerpat = Viewer.shiftBayer(bayerpat, xoff, yoff);
        if (nplanes === 1 && /^[RGB]{4}$/.test(bayerpat)) {
            const deb = Viewer.debayer(pixels, w, h, bayerpat);
            if (deb) {
                for (let i = 0; i < planeSize; i++)
                    pixels[i] = (deb[i * 3] + 2 * deb[i * 3 + 1] + deb[i * 3 + 2]) / 4;
                pixelsRGB = deb;
            }
        }
        // Fond neutralisé pour l'affichage (display-only) : on soustrait
        // la médiane PROPRE à chaque canal (et non une luma commune) au
        // moment du stretch, sinon le canal au fond le plus élevé reste
        // positif ⇒ dominante de couleur sur tout le fond. Les mesures
        // (HFR, stats) restent sur la luma non modifiée. Calculé après
        // résolution couleur (Bayer ci-dessus, RGB8 ci-dessous).
        let skyC = null;
        if (nplanes === 3 && bitpix === 8) {
            const gchan = new Float32Array(planeSize);
            const bchan = new Float32Array(planeSize);
            if (readPlane(planeSize, gchan, planeSize) &&
                readPlane(planeSize * 2, bchan, planeSize)) {
                const rgb = new Uint8Array(planeSize * 3);
                for (let i = 0; i < planeSize; i++) {
                    const r = pixels[i], g = gchan[i], b = bchan[i];
                    pixels[i] = (r + g + b) / 3;
                    rgb[i * 3] = Math.max(0, Math.min(255, Math.round(r)));
                    rgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g)));
                    rgb[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b)));
                }
                pixelsRGB = rgb;
            }
        }
        if (pixelsRGB) {
            // Pas IMPAIR obligatoire : un pas pair (ex. 10) n'échantillonne
            // que les colonnes paires et, la mosaïque Bayer ayant une période
            // de 2, biaise les médianes d'un canal (fond vert/teinté).
            let step = Math.max(1, Math.floor(planeSize / 200000));
            if (step % 2 === 0) step += 1;
            const samples = [[], [], []];
            for (let i = 0; i < planeSize; i += step)
                for (let c = 0; c < 3; c++) samples[c].push(pixelsRGB[i * 3 + c]);
            const med = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0; };
            skyC = [med(samples[0]), med(samples[1]), med(samples[2])];
        }

        let max = -Infinity, min = Infinity;
        for (let i = 0; i < pixels.length; i++) {
            const v = pixels[i];
            if (v > max) max = v;
            if (v < min) min = v;
        }
        const sorted = Float64Array.from(pixels).sort();
        let sky = sorted[Math.floor(sorted.length * 0.5)] || 0;
        const sigma = sorted[Math.floor(sorted.length * 0.841)] - sky || 1;
        // Cadrage dégénéré (plafond blanc saturé, bias : max≈sky) — le
        // stretch ancré au fond rendrait tout noir. On ancre le noir au min
        // des données (display-only, mesures sur pixels bruts inchangées).
        if ((max - sky) < 8) sky = (min === Infinity ? sky : min);
        // Mode de stretch : 'asinh' (défaut, aperçu) ou 'linear' (MAP —
        // dynamique complète). Persisté par l'applet de MAP manuelle.
        if (this.stretchMode !== 'linear' && this.stretchMode !== 'asinh') this.stretchMode = 'asinh';
        return { w, h, pixels, pixelsRGB, skyC, sky, soft: sigma * 0.5, k: Math.max(20, (max - sky) / sigma), max };
    }

    // Décalage de phase du motif Bayer (XBAYROFF/YBAYROFF). pattern indexé
    // y*2+x ; on renvoie le motif équivalent vu depuis (xoff,yoff).
    static shiftBayer(pattern, xoff, yoff) {
        const pat = String(pattern || '').toUpperCase();
        if (!/^[RGB]{4}$/.test(pat) || (!xoff && !yoff)) return pat;
        const out = ['', '', '', ''];
        for (let i = 0; i < 4; i++) {
            const y = i >> 1, x = i & 1;
            const ny = (y + yoff) & 1, nx = (x + xoff) & 1;
            out[ny * 2 + nx] = pat[i];
        }
        return out.join('');
    }

    // ── Rendering ──

    // Dématriçage bilinéaire pur (pleine dynamique float, testable sans
    // DOM). pattern : 4 lettres ex. 'RGGB' → (0,0)=R, (0,1)=G, (1,0)=G,
    // (1,1)=B. Retourne Float64Array(h*w*3) ou null. Au-delà de 12 Mpx on
    // binne en demi-résolution (réutilise le caller pour downsampler).
    static debayer(mono, w, h, pattern) {
        try {
            const pat = String(pattern || '').toUpperCase();
            if (!/^[RGB]{4}$/.test(pat) || w < 4 || h < 4) return null;
            const at = (x, y) => mono[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
            const colAt = (x, y) => pat[(((y % 2) + 2) % 2) * 2 + (((x % 2) + 2) % 2)];
            const out = new Float32Array(w * h * 3);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const o = (y * w + x) * 3;
                    const c = colAt(x, y);
                    if (c === 'G') {
                        // R et B : voisins en croix si la couleur y est, sinon diagonales.
                        let r, b;
                        if (colAt(x + 1, y) === 'R' || colAt(x - 1, y) === 'R') {
                            r = (at(x - 1, y) + at(x + 1, y)) / 2;
                            b = (at(x, y - 1) + at(x, y + 1)) / 2;
                        } else if (colAt(x, y + 1) === 'R' || colAt(x, y - 1) === 'R') {
                            r = (at(x, y - 1) + at(x, y + 1)) / 2;
                            b = (at(x - 1, y) + at(x + 1, y)) / 2;
                        } else {
                            r = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
                            b = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
                        }
                        out[o] = r; out[o + 1] = at(x, y); out[o + 2] = b;
                    } else {
                        // Pixel R ou B : G = moyenne croix, autre couleur = diagonales.
                        out[o + 1] = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
                        const d = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
                        if (c === 'R') { out[o] = at(x, y); out[o + 2] = d; }
                        else { out[o] = d; out[o + 2] = at(x, y); }
                    }
                }
            }
            return out;
        } catch (e) { return null; }
    }

    // Stretch linéaire pur (dynamique complète, sans compression) :
    // noir = fond de ciel, blanc = pixel max. Pour juger un profil
    // d'étoile en MAP (l'autostretch asinh ment sur les tailles).
    // Pure (testable sans DOM) — utilisée par _renderStretched.
    // Retourne 0..255.
    static linearNorm(raw, sky, white) {
        const hi = (white > sky + 1) ? white : sky + 1;
        const v = (raw - sky) / (hi - sky);
        return Math.max(0, Math.min(255, Math.round(v * 255)));
    }

    render(bytes, fmt) {
        const norm = (fmt || '').toLowerCase();
        const isFits = norm === 'fits' || norm === 'image/fits' || norm === '.fits' || norm === '.fit' || norm === 'image/x-fits';
        if (isFits || (bytes.length > 0 && bytes[0] === 0x53)) {
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
        const { w, h, pixels, pixelsRGB, skyC, sky, soft, k, max } = result;
        this.pixels = pixels;
        this.pixelsRGB = pixelsRGB || null;
        this.skyC = skyC || null;
        this.imgW = w;
        this.imgH = h;
        this.sky = sky;
        this.soft = soft;
        this.k = k;
        this.imgMax = max;

        this._showWrap();
        this._renderStretched();

        // Sync overlays
        for (const id of this.overlayIds || []) {
            const ov = document.getElementById(id);
            if (ov) { ov.width = w; ov.height = h; ov.style.width = w + 'px'; ov.style.height = h + 'px'; }
        }

        if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry' || this.mode === 'aberration') {
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
        let mime = fmt || 'image/png';
        const lower = String(fmt || '').toLowerCase();
        if (lower === 'jpg' || lower === 'jpeg') mime = 'image/jpeg';
        else if (lower === 'png') mime = 'image/png';
        else if (lower === 'fits' || lower === '.fits') mime = 'image/fits';
        else if (!lower.includes('/')) mime = fmt; // keep as-is if already mime
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            this.imgW = img.width;
            this.imgH = img.height;
            this.pixels = null;
            this.pixelsRGB = null;
            // legacy globals for overlay/save compatibility
            _histWidth = img.width; _histHeight = img.height;
            const canvas = document.getElementById(this.canvasId);
            if (canvas) { canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); }
            for (const id of this.overlayIds || []) {
                const ov = document.getElementById(id);
                if (ov) { ov.width = img.width; ov.height = img.height; ov.style.width = img.width + 'px'; ov.style.height = img.height + 'px'; }
            }
            this._showWrap();
            // sync stretch globals for overlays
            if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry' || this.mode === 'aberration') {
                this.fitZoom();
            }
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
        const isLinear = (this.stretchMode === 'linear');
        const useRGB = !!(this.pixelsRGB && this.pixelsRGB.length === w * h * 3);
        const asinhK = Math.asinh(this.k);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const dst = ((h - 1 - y) * w + x) * 4;
                if (useRGB) {
                    const s = (y * w + x) * 3;
                    for (let c = 0; c < 3; c++) {
                        // Fond propre au canal (display-only) : neutralise la
                        // dominante sans affecter les mesures (luma intacte).
                        const floor = (this.skyC && this.skyC[c] != null) ? this.skyC[c] : this.sky;
                        const raw = this.pixelsRGB[s + c];
                        data[dst + c] = isLinear
                            ? Viewer.linearNorm(raw, floor, this.imgMax)
                            : Math.max(0, Math.min(255, Math.round(Math.asinh(Math.max(0, raw - floor) / this.soft) / asinhK * 255)));
                    }
                    data[dst + 3] = 255;
                    continue;
                }
                const raw = this.pixels[y * w + x];
                const val = isLinear
                    ? Viewer.linearNorm(raw, this.sky, this.imgMax)
                    : Math.max(0, Math.min(255, Math.round(Math.asinh(Math.max(0, raw - this.sky) / this.soft) / asinhK * 255)));
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
        } else if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry' || this.mode === 'aberration') {
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
        if (this.mode === 'capture' || this.mode === 'focuser' || this.mode === 'astrometry' || this.mode === 'aberration') {
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
            if (!didDrag) {
                const rect = vp.getBoundingClientRect();
                if (isGuide && typeof _guideClick === 'function') {
                    _guideClick(e.clientX - rect.left, e.clientY - rect.top);
                } else if (typeof _captureClick === 'function') {
                    _captureClick(e.clientX - rect.left, e.clientY - rect.top, vp);
                }
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

    // ── Histogram (depuis stats serveur) ────────────────────────
    renderHistogramFromStats(stats) {
        const canvas = document.getElementById('cap-histo-canvas');
        if (!canvas || !stats || !stats.hist) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width = canvas.offsetWidth * 2;
        const H = canvas.height = canvas.offsetHeight * 2;
        const hist = stats.hist;
        let maxBin = 1;
        for (let i=0;i<hist.length;i++) if (hist[i] > maxBin) maxBin = hist[i];
        ctx.clearRect(0,0,W,H);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0,0,W,H);
        const blackFrac = this.histAuto ? 0 : this.histBlackPct/100;
        const blX = blackFrac * W;
        ctx.fillStyle = 'rgba(0,255,204,0.08)';
        ctx.fillRect(blX,0,W-blX,H);
        for (let i=0;i<hist.length;i++) {
            const bh = Math.max(1, (hist[i]/maxBin)*H);
            ctx.fillStyle = 'rgba(0,255,204,0.5)';
            ctx.fillRect(i*W/hist.length, H-bh, W/hist.length+1, bh);
        }
        ctx.strokeStyle = '#ff5577'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(blX,0); ctx.lineTo(blX,H); ctx.stroke();
        const minEl = document.getElementById('cap-histo-min');
        const maxEl = document.getElementById('cap-histo-max');
        if (minEl) minEl.textContent = Math.round(stats.min);
        if (maxEl) maxEl.textContent = Math.round(stats.max);
        const slider = document.getElementById('cap-histo-slider');
        if (slider) slider.value = this.histAuto ? 0 : this.histBlackPct;
        const val = document.getElementById('cap-histo-val');
        if (val) val.textContent = this.histAuto ? 'AUTO' : Math.round(this.histBlackPct)+'%';
        this._statsHist = stats;
    }

    // ── Histogram ──

    renderHistogram() {
        if (this._statsHist) return this.renderHistogramFromStats(this._statsHist);
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
