// ═══════════════════════════════════════════════════════════════
// Noctua — App principal (applets flottants)
// ═══════════════════════════════════════════════════════════════

import { SkyEngine } from '/sky-engine.js';

// ── Mode Manager ──────────────────────────────────────────────

function switchMode(mode) {
    if (!MODES[mode]) return;
    currentMode = mode;
    uiConfig.mode = mode;

    document.querySelectorAll('.mode-specific').forEach(el => {
        el.style.display = 'none';
    });

    // Dashboard always visible
    const dashEl = document.getElementById('applet-status');
    if (dashEl) dashEl.style.display = '';

    for (const id of MODES[mode].applets) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
    }

    document.querySelectorAll('#applet-mode-bar .mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Serial port row: hidden for capture and astrometry (cameras use USB/network)
    const serialRow = document.getElementById('conn-row-serial');
    if (serialRow) {
        const hideSerial = (mode === 'capture' || mode === 'astrometry');
        serialRow.style.display = hideSerial ? 'none' : '';
    }

    // Configure viewer features per mode
    configureViewerForMode(mode);

    // Show/hide offset overlay based on mode
    const overlay = document.getElementById('offset-overlay-canvas');
    if (overlay) {
        if (mode === 'astrometry' && _offsetVisible) {
            overlay.style.display = 'block';
        } else {
            overlay.style.display = 'none';
        }
    }

    // Show/hide focus overlay based on mode
    const focusOvl = document.getElementById('focus-overlay-canvas');
    if (focusOvl) {
        if (mode === 'focuser' && _focusVisible) {
            focusOvl.style.display = 'block';
        } else {
            focusOvl.style.display = 'none';
        }
    }
    if (mode !== 'focuser') clearFocusOverlay();

    // Annonce le changement de mode sur le bus (solver rafraîchit son
    // statut en astrométrie, hardware rend son panneau en mode matériel).
    Hub.emit('mode:changed', { mode }, { source: 'app' });

    refreshDriverList();
    loadAppletPositions();
    saveUiConfig();
}

function configureViewerForMode(mode) {
    if (mode === 'guiding') {
        if (guideViewer) guideViewer.configure('guiding');
        if (captureViewer) captureViewer.configure('guiding');
    } else {
        if (captureViewer) captureViewer.configure(mode);
    }
}

// ── Hub : consommateur calibration:done ───────────────────────
// Confirmation (toast) + démarrage du guidage en un clic.
// La calibration ne fait que publier le résultat ; l'app orchestre.

Hub.subscribe('calibration:done', 'app', (env) => {
    const status = env.payload;
    const quality = status.quality || '';
    const bad = (quality === 'poor' || quality === 'insufficient_data');
    const toastColor = bad ? '#ff5577' : '#4a4';
    const msg = i18nFmt('cal.toast_done', { quality });
    showToast(msg, {
        color: toastColor,
        duration: bad ? 8000 : 0,
        action: bad ? undefined : i18n('cal.toast_start_guide'),
        onAction: () => {
            // Ensure guiding mode is active, then start guiding
            if (currentMode !== 'guiding') {
                const mode = [...document.querySelectorAll('button')].find(b => b.textContent.includes('GUIDAGE'));
                if (mode) mode.click();
            }
            setTimeout(() => _guideStart(), 600);
        },
    });
});

// ── Hub : consommateur capture:progress ───────────────────────
// Toast de fin de capture rapide (panneau Capture) — l'app orchestre la
// confirmation visuelle comme pour calibration:done. L'abort n'est pas
// annoncé comme une fin de séquence.

let _appCaptureRunning = false;

Hub.subscribe('capture:progress', 'app', (env) => {
    const p = env.payload || {};
    const was = _appCaptureRunning;
    _appCaptureRunning = !!p.running;
    if (was && !_appCaptureRunning && !p.aborted && p.total > 0 && p.done >= p.total) {
        showToast(i18nFmt('toast.capture_done', { done: p.done, total: p.total }), { color: '#44cc44', duration: 3000 });
    }
});

function initModeBar() {
    document.querySelectorAll('#applet-mode-bar .mode-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });
}

// ── Internationalisation ──────────────────────────────────────

function initI18nSelector() {
    const sel = document.getElementById('i18n-lang');
    if (!sel || typeof I18N === 'undefined') return;
    sel.value = I18N.current;
    sel.addEventListener('change', () => {
        I18N.setLang(sel.value);
    });
}

// ── Sky engine init ───────────────────────────────────────────

async function initSkyEngine() {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    let siteLat = 43.952, siteLng = 1.568, siteElev = 210;
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg.site) {
            siteLat = cfg.site.latitude ?? siteLat;
            siteLng = cfg.site.longitude ?? siteLng;
            siteElev = cfg.site.elevation ?? siteElev;
        }
    } catch (e) {
        addLog('warning', 'sky', i18n('log.sky.no_site_config'));
    }

    skyEngine = new SkyEngine(container, { siteLat, siteLng, siteElev });
    skyEngine.init();
    skyEngine.setupContextMenu();

    try {
        await skyEngine.loadCatalogs();
        addLog('info', 'sky', i18n('log.sky.init'));
    } catch (e) {
        addLog('error', 'sky', i18nFmt('log.sky.error', { err: e.message }));
    }

    try {
        await loadObjectCatalogs();
    } catch (e) {
        addLog('warning', 'sky', i18nFmt('log.sky.catalog_error', { err: e.message }));
    }

    // Magnitude slider
    const magSlider = document.getElementById('mag-slider');
    const magValue = document.getElementById('mag-value');
    if (magSlider) {
        magSlider.addEventListener('input', () => {
            const val = parseFloat(magSlider.value);
            if (magValue) magValue.textContent = val.toFixed(1);
            if (skyEngine) skyEngine.setMagnitudeLimit(val);
            if (!uiConfig.sky) uiConfig.sky = {};
            uiConfig.sky.magnitude_limit = val;
            saveUiConfig();
        });
    }

    // Update station display
    const stationEl = document.getElementById('station-display');
    if (stationEl) stationEl.textContent = `Station : ${siteLat.toFixed(2)}°N / ${siteLng.toFixed(2)}°E`;
    const latEl = document.getElementById('obs-lat');
    const lonEl = document.getElementById('obs-lon');
    if (latEl) latEl.value = siteLat;
    if (lonEl) lonEl.value = siteLng;
}

// ── Layer toggles ─────────────────────────────────────────────

function initLayerToggles() {
    // Toggle display panel
    const toggleBtn = document.getElementById('btn-toggle-display');
    const displayPanel = document.getElementById('display-panel');
    if (toggleBtn && displayPanel) {
        toggleBtn.addEventListener('click', () => {
            const open = displayPanel.style.display === 'none';
            displayPanel.style.display = open ? '' : 'none';
            toggleBtn.textContent = open ? '☰ AFFICHAGE ▴' : '☰ AFFICHAGE ▾';
        });
    }

    // Layer checkboxes
    document.querySelectorAll('[data-layer]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (skyEngine) skyEngine.setLayerVisibility(cb.dataset.layer, cb.checked);
            if (!uiConfig.sky) uiConfig.sky = {};
            if (!uiConfig.sky.layers) uiConfig.sky.layers = {};
            uiConfig.sky.layers[cb.dataset.layer] = cb.checked;
            saveUiConfig();
        });
    });

    // Catalog checkboxes
    document.querySelectorAll('[data-catalog]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (skyEngine) skyEngine.setCatalogVisibility(cb.dataset.catalog, cb.checked);
            if (!uiConfig.sky) uiConfig.sky = {};
            if (!uiConfig.sky.catalogs) uiConfig.sky.catalogs = {};
            uiConfig.sky.catalogs[cb.dataset.catalog] = cb.checked;
            saveUiConfig();
        });
    });

    // Rotation lock buttons
    const lockZenith = document.getElementById('btn-lock-zenith');
    const lockEW = document.getElementById('btn-lock-ew');
    if (lockZenith) {
        lockZenith.addEventListener('click', () => {
            if (!skyEngine) return;
            skyEngine._lockRA = !skyEngine._lockRA;
            lockZenith.classList.toggle('active', skyEngine._lockRA);
            if (skyEngine._lockRA && skyEngine._lockDEC) {
                skyEngine._lockDEC = false;
                lockEW.classList.remove('active');
            }
            currentModeConfig().rotation_lock = skyEngine._lockRA ? 'zenith' : (skyEngine._lockDEC ? 'ew' : 'none');
            saveUiConfig();
        });
    }
    if (lockEW) {
        lockEW.addEventListener('click', () => {
            if (!skyEngine) return;
            skyEngine._lockDEC = !skyEngine._lockDEC;
            lockEW.classList.toggle('active', skyEngine._lockDEC);
            if (skyEngine._lockDEC && skyEngine._lockRA) {
                skyEngine._lockRA = false;
                lockZenith.classList.remove('active');
            }
            currentModeConfig().rotation_lock = skyEngine._lockDEC ? 'ew' : (skyEngine._lockRA ? 'zenith' : 'none');
            saveUiConfig();
        });
    }
}

// ── Global function exports (for inline handlers) ─────────────

window.setSwitchItem = setSwitchItem;
window.setNumberItem = setNumberItem;
window.setTextItem = setTextItem;

// ── Init ──────────────────────────────────────────────────────

function initDraggableApplets() {
    const FIXED_PANELS = ['applet-log', 'applet-legend'];
    document.querySelectorAll('.glass-panel.applet').forEach(panel => {
        if (panel.id === 'applet-mode-bar' || panel.id === 'applet-connection') return;
        if (FIXED_PANELS.includes(panel.id)) return;

        // Minimize button
        const minBtn = panel.querySelector('.applet-minimize');
        if (minBtn) {
            minBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMinimize(panel);
            });
        }

        // Pin button
        const handle = panel.querySelector('.applet-drag');
        if (!handle) return;
        const pinBtn = document.createElement('button');
        pinBtn.className = 'applet-pin';
        pinBtn.title = i18n('app.pin');
        pinBtn.style.cssText = 'font-size:0.6rem; background:none; border:none; cursor:pointer; padding:0 4px; margin-left:auto; transition:color 0.2s;';
        handle.insertBefore(pinBtn, handle.lastElementChild);
        const isPinned = currentModeConfig().pinned?.[panel.id];
        if (isPinned) {
            panel.dataset.pinned = 'true';
            pinBtn.textContent = '🔒';
            pinBtn.style.color = '#00ffcc';
            pinBtn.title = i18n('app.unpin');
        } else {
            pinBtn.textContent = '📌';
            pinBtn.style.color = '#555';
        }
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const modeCfg = currentModeConfig();
            modeCfg.pinned = modeCfg.pinned || {};
            if (panel.dataset.pinned) {
                delete panel.dataset.pinned;
                pinBtn.textContent = '📌';
                pinBtn.style.color = '#555';
                pinBtn.title = i18n('app.pin');
                modeCfg.pinned[panel.id] = false;
            } else {
                panel.dataset.pinned = 'true';
                pinBtn.textContent = '🔒';
                pinBtn.style.color = '#00ffcc';
                pinBtn.title = i18n('app.unpin');
                modeCfg.pinned[panel.id] = true;
            }
            saveUiConfig();
        });

        // Drag from any non-interactive area of the panel
        panel.addEventListener('mousedown', (e) => {
            // Don't drag on interactive elements
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' ||
                e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' ||
                e.target.closest('.btn') || e.target.closest('.slider') ||
                e.target.closest('.toggle-switch') || e.target.closest('a')) return;

            if (panel.dataset.pinned) return;
            e.preventDefault();

            // Convert CSS right/bottom positioning to explicit left/top
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
            panel.style.zIndex = 50;
            panel.style.transition = 'none';
            panel.style.cursor = 'grabbing';

            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            const margin = 8;
            const vw = window.innerWidth, vh = window.innerHeight;
            const w = panel.offsetWidth, h = panel.offsetHeight;

            function onMove(ev) {
                let left = ev.clientX - offsetX;
                let top = ev.clientY - offsetY;
                left = Math.max(margin, Math.min(left, vw - w - margin));
                top = Math.max(margin, Math.min(top, vh - h - margin));
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                panel.style.cursor = '';
                panel.style.zIndex = '';
                panel.style.transition = '';
                saveAppletPositions();
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Load UI config first
    await loadUiConfig();

    initModeBar();
    initI18nSelector();
    initConnectionBar();
    initHardwarePanel();
    initHardwareMode();
    initButtons();
    initDpad();
    initJoystick();
    initObjectSearch();
    initObjectSelector();
    initSitePopup();
    initTimeControls();
    initLocationUpdate();
    captureViewer = new Viewer('capture');
    guideViewer = new Viewer('guiding');
    captureViewer.initZoomPan();
    initCapturePanel();
    initSequencePanel();
    initStackingPanel();
    initPreviewResize();
    initSaveImage();
    captureViewer.initHistogramControls();
    initSolverPanel();
    initTargetPanel();
    initPolarPanel();
    initFocuserPanel();
    initGuidePanel();
    initDashboard();
    setInterval(() => _guideChecklist?.update(), 1000);
    initCalibrationPanel();
    initSessionPanel();
    await initSkyEngine();
    initDraggableApplets();
    initLayerToggles();
    connectWS();

    // Re-check overlap on resize
    window.addEventListener('resize', () => {
        requestAnimationFrame(() => resolvePanelLayout());
    });

    // Apply UI config: mode
    switchMode(uiConfig.mode || 'hardware');
    loadAppletPositions();

    // Apply UI config: log levels
    if (uiConfig.log_levels) {
        document.querySelectorAll('.log-filters input[type="checkbox"]').forEach(cb => {
            const level = cb.dataset.level;
            if (level in uiConfig.log_levels) {
                cb.checked = uiConfig.log_levels[level];
            }
        });
        applyLogFilters();
    }

    // Apply UI config: sky layers
    if (uiConfig.sky?.layers) {
        for (const [layer, on] of Object.entries(uiConfig.sky.layers)) {
            const cb = document.querySelector(`[data-layer="${layer}"]`);
            if (cb) { cb.checked = on; if (skyEngine) skyEngine.setLayerVisibility(layer, on); }
        }
    }
    if (uiConfig.sky?.catalogs) {
        for (const [cat, on] of Object.entries(uiConfig.sky.catalogs)) {
            const cb = document.querySelector(`[data-catalog="${cat}"]`);
            if (cb) { cb.checked = on; if (skyEngine) skyEngine.setCatalogVisibility(cat, on); }
        }
    }

    // Apply UI config: magnitude
    if (uiConfig.sky?.magnitude_limit != null) {
        const magSlider = document.getElementById('mag-slider');
        const magValue = document.getElementById('mag-value');
        if (magSlider) { magSlider.value = uiConfig.sky.magnitude_limit; }
        if (magValue) { magValue.textContent = parseFloat(uiConfig.sky.magnitude_limit).toFixed(1); }
        if (skyEngine) skyEngine.setMagnitudeLimit(uiConfig.sky.magnitude_limit);
    }

    // Apply UI config: rotation lock
    const modeCfg = currentModeConfig();
    const lock = modeCfg.rotation_lock || 'none';
    if (skyEngine) {
        skyEngine._lockRA = lock === 'zenith';
        skyEngine._lockDEC = lock === 'ew';
    }
    const lockZenith = document.getElementById('btn-lock-zenith');
    const lockEW = document.getElementById('btn-lock-ew');
    if (lockZenith) lockZenith.classList.toggle('active', lock === 'zenith');
    if (lockEW) lockEW.classList.toggle('active', lock === 'ew');

    // Apply UI config: time mode
    if (modeCfg.time_mode === 'manual' && skyEngine) {
        const realtimeBtn = document.getElementById('btn-mode-realtime');
        const manualBtn = document.getElementById('btn-mode-manual');
        const manualControls = document.getElementById('manual-controls');
        if (manualBtn) manualBtn.classList.add('active');
        if (realtimeBtn) realtimeBtn.classList.remove('active');
        if (manualControls) manualControls.style.display = 'flex';
        if (modeCfg.manual_date && modeCfg.manual_time) {
            const full = new Date(`${modeCfg.manual_date}T${modeCfg.manual_time}`);
            if (!isNaN(full.getTime())) skyEngine.setManualTime(full);
        }
    }

    // Apply UI config: driver selection
    if (modeCfg.driver) {
        const driverSelect = document.getElementById('indigo-driver');
        if (driverSelect && driverSelect.querySelector(`option[value="${modeCfg.driver}"]`)) {
            driverSelect.value = modeCfg.driver;
        }
    }

    window.__viewer = { guideViewer, captureViewer, handleGuideImage, handleCameraImage, _guideDetectStars, _guideSetStar,
        get _guideStarList() { return _guideStarList; },
        get _guideSelectedStar() { return _guideSelectedStar; },
        get _calLastStatus() { return _calLastStatus; } };
    _initDone = true;
});
