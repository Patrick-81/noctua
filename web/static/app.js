// ═══════════════════════════════════════════════════════════════
// INDIGO Devices — App principal (applets flottants)
// ═══════════════════════════════════════════════════════════════

import { SkyEngine } from '/sky-engine.js';

// ── State ─────────────────────────────────────────────────────

let ws = null;
let devices = {};
let selectedDevice = null;
let selectedCamera = null;
const MAX_LOG = 500;
let logEntries = [];
let skyEngine = null;
let currentMode = 'mount';
let uiConfig = {};
let _initDone = false;

async function loadUiConfig() {
    try {
        const cfg = await fetch('/api/ui').then(r => r.json());
        if (cfg && typeof cfg === 'object') uiConfig = cfg;
    } catch (e) {
        console.warn('UI config load failed:', e);
    }
}

function saveUiConfig() {
    if (!_initDone) return;
    fetch('/api/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uiConfig)
    }).catch(e => console.warn('UI config save failed:', e));
}

function currentModeConfig() {
    if (!uiConfig.modes) uiConfig.modes = {};
    if (!uiConfig.modes[currentMode]) uiConfig.modes[currentMode] = {};
    return uiConfig.modes[currentMode];
}

// ── Mode Manager ──────────────────────────────────────────────

const MODES = {
    mount: {
        applets: ['applet-status', 'applet-joystick', 'applet-commands',
                  'applet-hud', 'applet-search'],
        driverType: 'mount'
    },
    focuser: {
        applets: ['applet-focuser-control', 'applet-focuser-position', 'applet-capture-preview'],
        driverType: 'focuser'
    },
    guiding: {
        applets: ['applet-guide-preview', 'applet-guiding-graph', 'applet-guiding-settings', 'applet-calibration'],
        driverType: 'ccd'
    },
    capture: {
        applets: ['applet-capture-settings', 'applet-capture-preview'],
        driverType: 'ccd'
    },
    astrometry: {
        applets: ['applet-solver', 'applet-target', 'applet-polar', 'applet-capture-preview'],
        driverType: null
    }
};

const DRIVER_TYPE_KEYWORDS = {
    mount: ['mount', 'telescope', 'lx200', 'onstep', 'eqmod', 'synscan', 'ioptron', 'celestron', 'synta', 'rainbow', 'gemini'],
    ccd: ['ccd', 'camera', 'qhy', 'zwo', 'asi', 'sbig', 'atik', 'toup', 'playerone', 'svbony', 'guide'],
    focuser: ['focuser', 'focus', 'moonlite', 'highpoint', 'prima', 'unicat', 'robofocus'],
};

function filterDriversByType(drivers, type) {
    if (!type || !drivers.length) return drivers;
    const keywords = DRIVER_TYPE_KEYWORDS[type] || [];
    if (!keywords.length) return drivers;
    return drivers.filter(d => {
        const name = (d.name || '').toLowerCase();
        const label = (d.label || '').toLowerCase();
        return keywords.some(kw => name.includes(kw) || label.includes(kw));
    });
}

function switchMode(mode) {
    if (!MODES[mode]) return;
    currentMode = mode;
    uiConfig.mode = mode;

    document.querySelectorAll('.mode-specific').forEach(el => {
        el.style.display = 'none';
    });

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

    // Refresh solver status when switching to astrometry
    if (mode === 'astrometry') {
        refreshSolverStatus(1);
    }

    refreshDriverList();
    loadAppletPositions();
    saveUiConfig();
}

const VIEWER_MODE_CONFIG = {
    capture:   { title: '◎ CAPTURE — Aperçu',   save: true,  histogram: true,  stretch: true  },
    focuser:   { title: '◎ FOCUSER — Aperçu',   save: false, histogram: true,  stretch: true  },
    guiding:   { title: '◎ GUIDAGE — Aperçu',   save: false, histogram: false, stretch: true  },
    astrometry:{ title: '◎ ASTROMÉTRIE — Aperçu', save: false, histogram: true,  stretch: true  },
};

function configureViewerForMode(mode) {
    const cfg = VIEWER_MODE_CONFIG[mode];
    const titleEl = document.getElementById('viewer-title');
    if (titleEl && cfg) titleEl.textContent = cfg.title;

    const show = cfg && cfg.histogram;

    // Save button
    const saveSection = document.getElementById('cap-save-dir')?.closest('.cap-section');
    if (saveSection) saveSection.style.display = (cfg && cfg.save) ? '' : 'none';

    // Histogram controls — hide individually (they share a flex row with zoom buttons)
    const histoCanvas = document.getElementById('cap-histo-canvas');
    const histoSlider = document.getElementById('cap-histo-slider');
    const histoAuto = document.getElementById('cap-histo-auto');
    const noirLabel = document.querySelector('.cap-histo-label');
    const noirVal = document.getElementById('cap-histo-val');
    const histoRow = document.querySelector('.cap-histo-row');

    if (histoCanvas) histoCanvas.style.display = show ? '' : 'none';
    if (histoSlider) histoSlider.style.display = show ? '' : 'none';
    if (histoAuto) histoAuto.style.display = show ? '' : 'none';
    if (noirLabel) noirLabel.style.display = show ? '' : 'none';
    if (noirVal) noirVal.style.display = show ? '' : 'none';
    if (histoRow) histoRow.style.display = show ? '' : 'none';
}

function initModeBar() {
    document.querySelectorAll('#applet-mode-bar .mode-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });
}

// ── WebSocket ─────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        addLog('info', 'ws', 'WebSocket connecté');
        _refreshGuideCameraList();
    };

    ws.onclose = () => {
        addLog('warning', 'ws', 'WebSocket déconnecté, reconnexion...');
        setTimeout(connectWS, 2000);
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') {
            const hadMount = !!findMount();
            devices = msg.devices;
            renderDevices();
            updateCameraFov();
            const m = findMount();
            if (m && !hadMount) {
                selectedDevice = m.name;
                renderMountPanel();
            } else if (selectedDevice && devices[selectedDevice] && devices[selectedDevice].type === 'mount') {
                renderMountPanel();
            } else if (selectedDevice) {
                try { renderProps(selectedDevice); } catch (e) { console.error('renderProps:', e); }
            }
            renderCapturePanel();
            renderFocuserPanel();
            updateSolverHints();
        } else if (msg.type === 'log') {
            addLog(msg.level, msg.logger, msg.msg);
        } else if (msg.type === 'image') {
            const guideCam = _guideCameraSelect?.value || '';
            if (guideCam && msg.device === guideCam && currentMode === 'guiding') {
                handleGuideImage(msg.data, msg.format);
            } else {
                handleCameraImage(msg.data, msg.format);
            }
        } else if (msg.type === 'solver_result') {
            handleSolverWsResult(msg.result);
        }
    };
}

// ── Device list ───────────────────────────────────────────────

function renderDevices() {
    const container = document.getElementById('applet-props');
    if (!container) return;

    if (!selectedDevice) {
        container.style.display = 'none';
        return;
    }

    const dev = devices[selectedDevice];
    if (!dev) {
        container.style.display = 'none';
        return;
    }

    if (dev.type === 'mount') {
        container.style.display = 'none';
        return;
    }

    if (dev.props && dev.props.length > 0) {
        container.style.display = '';
        renderProps(selectedDevice);
    } else {
        container.style.display = 'none';
    }
}

function selectDevice(name) {
    selectedDevice = name;
    const dev = devices[name];
    if (dev && dev.type === 'mount') {
        renderMountPanel();
    } else {
        renderProps(name);
    }
}

// ── Mount panel ───────────────────────────────────────────────

function findMount() {
    for (const [name, dev] of Object.entries(devices)) {
        if (dev.type === 'mount') return { name, dev };
    }
    return null;
}

function renderMountPanel() {
    const m = findMount();
    if (!m) return;
    const d = m.dev;

    const raH = d.ra_hours != null ? d.ra_hours : 0;
    const decD = d.dec_deg != null ? d.dec_deg : 0;

    const trackEl = document.getElementById('status-tracking');
    if (trackEl) {
        trackEl.textContent = d.tracking ? '● ON' : '● OFF';
        trackEl.className = 'value ' + (d.tracking ? 'status-online' : 'status-stopped');
    }

    const slewingEl = document.getElementById('status-slewing');
    if (slewingEl) {
        slewingEl.textContent = d.slewing ? '● ACTIVE' : '● IDLE';
        slewingEl.className = 'value ' + (d.slewing ? 'status-slewing' : '');
        slewingEl.style.color = d.slewing ? '#ffcc00' : '#666';
    }

    const parkingEl = document.getElementById('status-parking');
    if (parkingEl) {
        const parking = d.park_state === 'Busy';
        parkingEl.textContent = parking ? '● ACTIVE' : '● IDLE';
        parkingEl.className = 'value ' + (parking ? 'status-parking' : '');
        parkingEl.style.color = parking ? '#ff8800' : '#666';
    }

    const homingEl = document.getElementById('status-homing');
    if (homingEl) {
        homingEl.textContent = d.homing ? '● ACTIVE' : '● IDLE';
        homingEl.className = 'value ' + (d.homing ? 'status-parking' : '');
        homingEl.style.color = d.homing ? '#ff8800' : '#666';
    }

    const busy = d.park_state === 'Busy' || d.slewing || d.homing;
    ['btn-goto', 'btn-park', 'btn-unpark', 'btn-home'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });

    if (d.props) {
        const statusProp = d.props.find(p => p.name === 'OnStep Status');
        // OnStep status currently not in an applet, could be added later

        const slewProp = d.props.find(p => p.name === 'TELESCOPE_SLEW_RATE');
        if (slewProp && slewProp.items.length > 0) {
            const sel = document.getElementById('slew-speed');
            if (sel && sel.dataset.count !== String(slewProp.items.length)) {
                sel.innerHTML = '';
                let selected = false;
                for (const item of slewProp.items) {
                    const opt = document.createElement('option');
                    opt.value = item.name;
                    opt.textContent = item.label || item.name;
                    if (item.value && !selected) { opt.selected = true; selected = true; }
                    sel.appendChild(opt);
                }
                sel.dataset.count = String(slewProp.items.length);
            }
        }
    }

    if (skyEngine) {
        skyEngine.slewing = !!d.slewing;
        const raDeg = d.ra_hours != null ? d.ra_hours * 15 : null;
        const decDeg = d.dec_deg != null ? d.dec_deg : null;
        skyEngine.setTelPosition(raDeg, decDeg);
    }
}

function updateCameraFov() {
    if (!skyEngine) return;
    for (const dev of Object.values(devices)) {
        if (dev.type !== 'camera') continue;
        const w = dev.width_px ?? 0;
        const h = dev.height_px ?? 0;
        const ps = dev.pixel_size_um ?? 0;
        const fl = dev.focal_length_mm ?? 0;
        const bx = dev.binning_x ?? 1;
        const by = dev.binning_y ?? 1;
        if (w && h && ps && fl) {
            skyEngine.cameraFovX = 2 * Math.atan(w * bx * ps / 1e6 / (2 * fl / 1e3)) * (180 / Math.PI);
            skyEngine.cameraFovY = 2 * Math.atan(h * by * ps / 1e6 / (2 * fl / 1e3)) * (180 / Math.PI);
            skyEngine.render();
        }
        break;
    }
}

// ── Coordinate conversion ─────────────────────────────────────

function decToSexa(decimalHours, isRA) {
    if (!decimalHours && decimalHours !== 0) return '--:--:--';
    let total = isRA ? decimalHours * 15 : decimalHours;
    const sign = total < 0 ? '-' : (isRA ? '' : '+');
    total = Math.abs(total);
    const deg = Math.floor(total);
    const minFloat = (total - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(1);
    if (isRA) {
        return `${String(deg).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(4, '0')}`;
    }
    return `${sign}${String(deg).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(4, '0')}`;
}

function sexaToDec(str, isRA) {
    const parts = str.trim().split(':').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return null;
    let sign = 1;
    if (!isRA && parts[0] < 0) { sign = -1; parts[0] = Math.abs(parts[0]); }
    const deg = parts[0] + parts[1] / 60 + parts[2] / 3600;
    return isRA ? deg / 15 : sign * deg;
}

// ── Mount commands ────────────────────────────────────────────

function mountGoto() {
    const raStr = document.getElementById('goto-ra')?.value;
    const decStr = document.getElementById('goto-dec')?.value;
    if (!raStr || !decStr) return;
    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'mount', 'Format invalide. Utilisez hh:mm:ss / dd:mm:ss');
        return;
    }
    apiPost('/api/mount/slew', { ra_hours: raH, dec_deg: decD });
    addLog('info', 'mount', `GOTO RA=${raH.toFixed(4)}h DEC=${decD.toFixed(4)}°`);
}

function mountMove(dir) {
    const m = findMount();
    if (!m) { addLog('error', 'mount', 'Pas de monture detectee'); return; }
    const speed = document.getElementById('slew-speed')?.value;
    addLog('debug', 'mount', `move ${dir} rate=${speed}`);
    apiPost('/api/mount/move', { direction: dir, rate: speed || undefined });
}

function mountHaltMove() {
    addLog('debug', 'mount', 'halt move');
    apiPost('/api/mount/halt');
}

function mountAbort() { apiPost('/api/mount/abort'); }

function mountToggleTracking() {
    const m = findMount();
    if (!m) return;
    apiPost('/api/mount/tracking', { on: !m.dev.tracking });
}

function mountPark() { apiPost('/api/mount/park'); }
function mountUnpark() { apiPost('/api/mount/unpark'); }
function mountHome() { apiPost('/api/mount/home'); }

// ── Property panel (generic) ──────────────────────────────────

function renderProps(deviceName) {
    const dev = devices[deviceName];
    const container = document.getElementById('applet-props');
    if (!dev || !dev.props || dev.props.length === 0 || !container) {
        if (container) container.style.display = 'none';
        return;
    }

    container.style.display = '';

    const groups = {};
    for (const p of dev.props) {
        const g = p.group || '(no group)';
        if (!groups[g]) groups[g] = [];
        groups[g].push(p);
    }

    const dragHandle = container.querySelector('.applet-drag');
    if (dragHandle) dragHandle.remove();

    let html = `<div class="applet-drag"><span class="drag-icon">⣿⣿</span><span class="hud-title" style="margin:0; border:none; padding:0;">${escapeHTML(deviceName)}</span><button class="applet-minimize" title="Réduire / étendre"></button></div>`;
    html += `<div class="device-panel">`;
    for (const [groupName, props] of Object.entries(groups)) {
        html += `<div class="prop-group"><div class="prop-group-header" onclick="this.parentElement.classList.toggle('collapsed')">${escapeHTML(groupName)}</div><div class="prop-group-body">`;
        for (const p of props) html += renderPropRow(deviceName, p);
        html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;

    // Re-init drag for this panel
    const newHandle = container.querySelector('.applet-drag');
    if (newHandle) {
        // Minimize button
        const minBtn = container.querySelector('.applet-minimize');
        if (minBtn) {
            minBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMinimize(container);
            });
        }

        newHandle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;
            container.style.transform = 'none';
            container.style.zIndex = 50;
            container.style.transition = 'none';
            newHandle.style.cursor = 'grabbing';
            function onMove(ev) {
                let left = ev.clientX - offsetX;
                let top = ev.clientY - offsetY;
                left = Math.max(0, Math.min(window.innerWidth - 60, left));
                top = Math.max(0, Math.min(window.innerHeight - 40, top));
                container.style.left = left + 'px';
                container.style.top = top + 'px';
                container.style.right = '';
                container.style.bottom = '';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                newHandle.style.cursor = 'grab';
                container.style.zIndex = '';
                container.style.transition = '';
                saveAppletPositions();
                checkOverlap();
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
}

function renderPropRow(deviceName, p) {
    const stateClass = p.state || 'Idle';
    let ctrl = '';
    if (p.vector_type === 'switch') ctrl = renderSwitch(deviceName, p);
    else if (p.vector_type === 'number') ctrl = renderNumber(deviceName, p);
    else if (p.vector_type === 'text') ctrl = renderText(deviceName, p);
    else if (p.vector_type === 'blob') ctrl = `<span style="color:#666">[blob]</span>`;
    const msg = p.message ? `<span class="prop-message">${escapeHTML(p.message)}</span>` : '';
    return `<div class="prop-row"><span class="prop-label">${escapeHTML(p.label || p.name)}</span><div class="prop-ctrl">${ctrl}</div><span class="prop-state ${stateClass}">${stateClass}</span>${msg}</div>`;
}

function renderSwitch(deviceName, p) {
    if (p.rule === 'AnyOfMany') {
        return p.items.map(item => {
            const checked = item.value ? 'checked' : '';
            const disabled = p.perm === 'ro' ? 'disabled' : '';
            return `<label style="margin-right:0.5rem"><input type="checkbox" class="prop-checkbox" ${checked} ${disabled} onchange="setSwitchItem('${escapeAttr(deviceName)}','${escapeAttr(p.name)}','${escapeAttr(item.name)}',this.checked)">${escapeHTML(item.label || item.name)}</label>`;
        }).join('');
    }
    return '<div class="switch-group">' + p.items.map(item => {
        const active = item.value ? ' active' : '';
        const disabled = p.perm === 'ro' ? 'disabled' : '';
        return `<button class="switch-btn${active}" ${disabled} onclick="setSwitchItem('${escapeAttr(deviceName)}','${escapeAttr(p.name)}','${escapeAttr(item.name)}',true)">${escapeHTML(item.label || item.name)}</button>`;
    }).join('') + '</div>';
}

function renderNumber(deviceName, p) {
    return p.items.map(item => {
        const ro = p.perm === 'ro' ? 'readonly' : '';
        const hasRange = item.min !== item.max;
        const rangeHint = hasRange ? `<span class="prop-range">[${item.min}..${item.max}]</span>` : '';
        return `<input type="number" class="prop-input" value="${item.value ?? ''}" min="${item.min || ''}" max="${item.max || ''}" step="${item.step || 'any'}" data-device="${escapeAttr(deviceName)}" data-prop="${escapeAttr(p.name)}" data-item="${escapeAttr(item.name)}" ${ro} ${p.perm !== 'ro' ? `onchange="setNumberItem(this)"` : ''}>${rangeHint}`;
    }).join(' ');
}

function renderText(deviceName, p) {
    return p.items.map(item => {
        const ro = p.perm === 'ro' ? 'readonly' : '';
        return `<input type="text" class="prop-input" value="${escapeAttr(String(item.value ?? ''))}" data-device="${escapeAttr(deviceName)}" data-prop="${escapeAttr(p.name)}" data-item="${escapeAttr(item.name)}" style="width:180px" ${ro} ${p.perm !== 'ro' ? `onkeydown="if(event.key==='Enter')setTextItem(this)"` : ''}>${p.perm !== 'ro' ? `<button class="set-btn" onclick="setTextItem(this.previousElementSibling)">Set</button>` : ''}`;
    }).join(' ');
}

// ── API calls ─────────────────────────────────────────────────

function setSwitchItem(device, prop, item, value) {
    apiPost('/api/property', { device, property: prop, items: [{ name: item, value: value }] });
}

function setNumberItem(input) {
    apiPost('/api/property', { device: input.dataset.device, property: input.dataset.prop, items: [{ name: input.dataset.item, value: parseFloat(input.value) }] });
}

function setTextItem(input) {
    apiPost('/api/property', { device: input.dataset.device, property: input.dataset.prop, items: [{ name: input.dataset.item, value: input.value }] });
}

function apiPost(url, body) {
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json()).then(data => {
        if (data.error) addLog('error', 'api', data.error);
    }).catch(e => addLog('error', 'api', e.message));
}

// ── Utilities ─────────────────────────────────────────────────

function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Log ───────────────────────────────────────────────────────

function addLog(level, logger, msg) {
    const el = document.getElementById('log-content');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.dataset.level = level || 'info';
    entry.dataset.logger = logger || '';
    entry.dataset.msg = msg || '';
    entry.innerHTML = `<span class="ts">${time}</span> <span class="logger">[${escapeHTML(logger || '')}]</span> <span class="msg">${escapeHTML(msg || '')}</span>`;
    el.appendChild(entry);
    logEntries.push(entry);
    while (logEntries.length > MAX_LOG) { const old = logEntries.shift(); old.remove(); }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) el.scrollTop = el.scrollHeight;
    applyLogFilters();
}

function clearLog() {
    const el = document.getElementById('log-content');
    if (el) el.innerHTML = '';
    logEntries = [];
}

function copyLog() {
    const text = logEntries.map(e => `[${e.dataset.level}] [${e.dataset.logger}] ${e.dataset.msg}`).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => addLog('info', 'log', 'Log copié'),
            () => copyLogFallback(text)
        );
    } else {
        copyLogFallback(text);
    }
}

function copyLogFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        addLog('info', 'log', 'Log copié');
    } catch (e) {
        addLog('error', 'log', 'Échec copie');
    }
    document.body.removeChild(ta);
}

function applyLogFilters() {
    const activeLevels = new Set();
    document.querySelectorAll('.log-filters input[type="checkbox"]').forEach(cb => {
        if (cb.checked) activeLevels.add(cb.dataset.level);
    });
    logEntries.forEach(entry => entry.classList.toggle('hidden', !activeLevels.has(entry.dataset.level)));
}

// ── D-pad ─────────────────────────────────────────────────────

function initDpad() {
    const dpad = document.querySelector('.dpad');
    if (!dpad) return;

    let activeDir = null;
    let activeBtn = null;

    function startMove(dir, btn) {
        if (dir === 'stop') { stopMove(); mountAbort(); return; }
        if (activeDir === dir) return;
        if (activeDir) stopMove();
        activeDir = dir;
        activeBtn = btn;
        if (btn) btn.classList.add('active');
        mountMove(dir);
    }

    function stopMove() {
        if (!activeDir) return;
        if (activeBtn) activeBtn.classList.remove('active');
        activeDir = null;
        activeBtn = null;
        mountHaltMove();
    }

    dpad.querySelectorAll('[data-dir]').forEach(btn => {
        const dir = btn.dataset.dir;
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.setPointerCapture(e.pointerId);
            startMove(dir, btn);
        });
        btn.addEventListener('pointerup', (e) => {
            e.preventDefault();
            stopMove();
        });
        btn.addEventListener('pointercancel', () => stopMove());
    });

    document.addEventListener('pointerup', () => stopMove());

    const stopBtn = document.getElementById('btn-dpad-stop') || document.querySelector('.dpad-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => { stopMove(); mountAbort(); });
}

// ── Action buttons ────────────────────────────────────────────

function initButtons() {
    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    };

    bind('btn-goto', mountGoto);
    bind('btn-tracking', mountToggleTracking);
    bind('btn-park', mountPark);
    bind('btn-unpark', mountUnpark);
    bind('btn-home', mountHome);
    bind('btn-abort', mountAbort);
    bind('btn-emergency', () => {
        mountAbort();
        mountToggleTracking();
        addLog('warning', 'mount', 'ARRÊT D\'URGENCE activé');
    });
    bind('btn-sync', () => {
        if (!skyEngine) return;
        let ra = -skyEngine._currentRotation[0];
        let dec = -skyEngine._currentRotation[1];
        if (ra < 0) ra += 360;
        if (ra >= 360) ra -= 360;
        apiPost('/api/mount/slew', { ra_hours: ra / 15, dec_deg: dec });
    });

    bind('log-clear', clearLog);
    bind('log-copy', copyLog);

    document.querySelectorAll('.log-filters input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            applyLogFilters();
            if (!uiConfig.log_levels) uiConfig.log_levels = {};
            uiConfig.log_levels[cb.dataset.level] = cb.checked;
            saveUiConfig();
        });
    });
}

// ── Joystick (slew continu) ──────────────────────────────────

function initJoystick() {
    let slewInterval = null;
    let currentDir = null;

    function startSlew(dir) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const m = findMount();
        if (!m) return;
        if (currentDir === dir) return;
        stopSlew();
        currentDir = dir;
        const speed = document.getElementById('slew-speed')?.value || 'Find';
        mountMove(dir);
        slewInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) renderMountPanel();
        }, 500);
    }

    function stopSlew() {
        if (slewInterval) { clearInterval(slewInterval); slewInterval = null; }
        if (currentDir) {
            mountHaltMove();
            currentDir = null;
        }
    }

    document.querySelectorAll('.joy-btn[data-dir]').forEach(btn => {
        const dir = btn.dataset.dir;
        if (dir === 'stop') {
            btn.addEventListener('click', stopSlew);
            return;
        }
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); startSlew(dir); });
        btn.addEventListener('mouseup', (e) => { e.preventDefault(); if (currentDir === dir) stopSlew(); });
        btn.addEventListener('mouseleave', (e) => { if (currentDir === dir) stopSlew(); });
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); startSlew(dir); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); if (currentDir === dir) stopSlew(); });
        btn.addEventListener('touchcancel', () => { if (currentDir === dir) stopSlew(); });
    });
}

// ── Object search ─────────────────────────────────────────────

function initObjectSearch() {
    const input = document.getElementById('obj-search');
    const resultsEl = document.getElementById('obj-search-results');
    if (!input || !resultsEl) return;

    let activeIdx = -1;
    let currentResults = [];

    function renderResults(results) {
        currentResults = results;
        activeIdx = -1;
        resultsEl.innerHTML = '';
        if (!results.length) { resultsEl.style.display = 'none'; return; }
        results.forEach((r, i) => {
            const div = document.createElement('div');
            div.className = 'obj-search-item';
            const name = r.name || '';
            div.innerHTML = `<span class="obj-id">${escapeHTML(r.id)}</span><span class="obj-name">${escapeHTML(name)}</span><span class="obj-catalog">${escapeHTML(r.catalog)}</span>`;
            div.addEventListener('click', () => selectResult(r));
            div.addEventListener('mouseenter', () => setActive(i));
            resultsEl.appendChild(div);
        });
        resultsEl.style.display = 'block';
    }

    function setActive(idx) {
        resultsEl.querySelectorAll('.obj-search-item').forEach((el, i) => el.classList.toggle('active', i === idx));
        activeIdx = idx;
    }

    function selectResult(r) {
        input.value = r.id;
        resultsEl.style.display = 'none';
        if (skyEngine) {
            skyEngine.clearHighlight();
            skyEngine.centerOnObject(r.ra, r.dec);
            skyEngine.highlightObject(r.ra, r.dec, r.id);
            addLog('info', 'search', `Objet: ${r.id} (${r.catalog})`);
        }
    }

    let searchTimeout = null;
    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q = input.value.trim();
        if (q.length < 1) { resultsEl.style.display = 'none'; return; }
        searchTimeout = setTimeout(() => {
            if (!skyEngine) return;
            renderResults(skyEngine.search(q));
        }, 150);
    });

    input.addEventListener('keydown', (e) => {
        const count = currentResults.length;
        if (!count || resultsEl.style.display === 'none') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIdx + 1) % count); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIdx - 1 + count) % count); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && activeIdx < count) selectResult(currentResults[activeIdx]);
            else if (count > 0) selectResult(currentResults[0]);
        } else if (e.key === 'Escape') { resultsEl.style.display = 'none'; input.blur(); }
    });

    input.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 200));
    input.addEventListener('focus', () => {
        const q = input.value.trim();
        if (q.length >= 1 && skyEngine) renderResults(skyEngine.search(q));
    });
}

// ── Object catalogs (pour search + hit-test) ─────────────────

async function loadObjectCatalogs() {
    const objects = [];
    try {
        const [mess, ngc, namedStars, bsc] = await Promise.all([
            fetch('/catalogs/messier.json').then(r => r.json()),
            fetch('/catalogs/ngc_ic.json').then(r => r.json()),
            fetch('/catalogs/stars.json').then(r => r.json()),
            fetch('/catalogs/bsc5.json').then(r => r.json()),
        ]);
        for (const o of mess.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'Messier', type: o.type || 'Messier' });
        }
        for (const o of ngc.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'NGC', type: o.type || 'NGC' });
        }
        for (const o of namedStars.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'Star', type: o.constellation ? `${o.id} (${o.constellation})` : 'Star' });
        }
        for (const o of bsc.objects) {
            if (objects.some(e => e.id === o.id)) continue;
            objects.push({ id: o.id, name: o.names?.[0] || null, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'BSC', type: o.constellation ? `${o.id} (${o.constellation})` : 'Star' });
        }
        if (skyEngine) skyEngine._objects = objects;
        addLog('info', 'sky', `${objects.length} objets chargés pour hit-test`);
    } catch (e) {
        addLog('warning', 'sky', 'Catalogues objets non disponibles: ' + e.message);
    }
}

// ── Site config popup ─────────────────────────────────────────

function initSitePopup() {
    const overlay = document.getElementById('site-popup-overlay');
    const siteBtn = document.getElementById('btn-update-location');
    const closeBtn = document.getElementById('site-popup-close');
    const cancelBtn = document.getElementById('site-cancel-btn');
    const saveBtn = document.getElementById('site-save-btn');
    const gpsBtn = document.getElementById('site-gps-btn');
    const siteName = document.getElementById('site-name');
    const siteLat = document.getElementById('site-lat');
    const siteLng = document.getElementById('site-lng');
    const siteElev = document.getElementById('site-elev');
    const siteTz = document.getElementById('site-tz');
    const citySearch = document.getElementById('site-city-search');
    const cityResults = document.getElementById('site-city-results');

    function openPopup() {
        fetch('/api/site').then(r => r.json()).then(site => {
            if (siteName) siteName.value = site.name || '';
            if (siteLat) siteLat.value = site.latitude ?? '';
            if (siteLng) siteLng.value = site.longitude ?? '';
            if (siteElev) siteElev.value = site.elevation ?? '';
            if (siteTz && site.timezone) {
                const opt = siteTz.querySelector(`option[value="${site.timezone}"]`);
                if (opt) siteTz.value = site.timezone;
            }
        }).catch(() => {});
        if (overlay) overlay.style.display = 'flex';
        if (cityResults) cityResults.style.display = 'none';
        if (citySearch) citySearch.value = '';
    }

    function closePopup() {
        if (overlay) overlay.style.display = 'none';
    }

    if (siteBtn) siteBtn.addEventListener('click', openPopup);
    if (closeBtn) closeBtn.addEventListener('click', closePopup);
    if (cancelBtn) cancelBtn.addEventListener('click', closePopup);
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(); });

    if (citySearch) {
        let searchTimeout = null;
        citySearch.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const q = citySearch.value.trim();
            if (q.length < 2) { cityResults.style.display = 'none'; return; }
            searchTimeout = setTimeout(() => {
                fetch(`/api/site/cities?q=${encodeURIComponent(q)}`).then(r => r.json()).then(cities => {
                    if (!cities.length) { cityResults.style.display = 'none'; return; }
                    cityResults.innerHTML = '';
                    cities.forEach(c => {
                        const div = document.createElement('div');
                        div.className = 'city-item';
                        div.innerHTML = `<span>${c.name}</span><span class="city-meta">${c.lat.toFixed(2)}°N ${c.lng.toFixed(2)}°E ${c.elev}m</span>`;
                        div.addEventListener('click', () => {
                            if (siteLat) siteLat.value = c.lat;
                            if (siteLng) siteLng.value = c.lng;
                            if (siteElev) siteElev.value = c.elev;
                            cityResults.style.display = 'none';
                            citySearch.value = c.name;
                        });
                        cityResults.appendChild(div);
                    });
                    cityResults.style.display = 'block';
                }).catch(() => { cityResults.style.display = 'none'; });
            }, 300);
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.site-city-row')) cityResults.style.display = 'none';
        });
    }

    if (gpsBtn) {
        gpsBtn.addEventListener('click', () => {
            if (!navigator.geolocation) { addLog('warning', 'site', 'Géolocalisation non supportée'); return; }
            gpsBtn.textContent = '⏳ Localisation...';
            gpsBtn.disabled = true;
            navigator.geolocation.getCurrentPosition(
                pos => {
                    if (siteLat) siteLat.value = pos.coords.latitude.toFixed(4);
                    if (siteLng) siteLng.value = pos.coords.longitude.toFixed(4);
                    if (siteElev) siteElev.value = Math.round(pos.coords.altitude || 0);
                    gpsBtn.textContent = '📍 Géolocaliser (GPS)';
                    gpsBtn.disabled = false;
                },
                err => {
                    addLog('warning', 'site', `GPS échoué: ${err.message}`);
                    gpsBtn.textContent = '📍 Géolocaliser (GPS)';
                    gpsBtn.disabled = false;
                },
                { enableHighAccuracy: true, timeout: 15000 }
            );
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const body = {
                name: siteName?.value?.trim() || '',
                latitude: parseFloat(siteLat?.value) || 0,
                longitude: parseFloat(siteLng?.value) || 0,
                elevation: parseFloat(siteElev?.value) || 0,
                timezone: siteTz?.value || 'UTC',
            };
            try {
                await fetch('/api/site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                addLog('info', 'site', `Lieu sauvegardé: ${body.latitude.toFixed(4)}°N ${body.longitude.toFixed(4)}°E`);
                if (skyEngine) skyEngine.updateSite(body.latitude, body.longitude, body.elevation);
                closePopup();
            } catch (e) {
                addLog('error', 'site', `Erreur: ${e.message}`);
            }
        });
    }
}

// ── Time management ───────────────────────────────────────────

function initTimeControls() {
    const realtimeBtn = document.getElementById('btn-mode-realtime');
    const manualBtn = document.getElementById('btn-mode-manual');
    const manualControls = document.getElementById('manual-controls');
    const applyBtn = document.getElementById('btn-apply-manual');
    const dateInput = document.getElementById('manual-date');
    const timeInput = document.getElementById('manual-time');

    function fillManualFields(date) {
        const pad = (n) => String(n).padStart(2, '0');
        if (dateInput) dateInput.value = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
        if (timeInput) timeInput.value = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    if (realtimeBtn) {
        realtimeBtn.addEventListener('click', () => {
            realtimeBtn.classList.add('active');
            if (manualBtn) manualBtn.classList.remove('active');
            if (manualControls) manualControls.style.display = 'none';
            if (skyEngine) skyEngine.setRealTime();
            currentModeConfig().time_mode = 'realtime';
            saveUiConfig();
        });
    }

    if (manualBtn) {
        manualBtn.addEventListener('click', () => {
            manualBtn.classList.add('active');
            if (realtimeBtn) realtimeBtn.classList.remove('active');
            if (manualControls) manualControls.style.display = 'flex';
            fillManualFields(new Date());
            currentModeConfig().time_mode = 'manual';
            saveUiConfig();
        });
    }

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const dateVal = dateInput?.value;
            const timeVal = timeInput?.value;
            if (!dateVal) return;
            const full = new Date(`${dateVal}T${timeVal || '00:00:00'}`);
            if (isNaN(full.getTime())) return;
            if (skyEngine) skyEngine.setManualTime(full);
            const modeCfg = currentModeConfig();
            modeCfg.manual_date = dateVal;
            modeCfg.manual_time = timeVal || '00:00:00';
            saveUiConfig();
        });
    }

    fillManualFields(new Date());
}

// ── Location update ───────────────────────────────────────────

let _allDrivers = [];

async function refreshDriverList() {
    const driverSelect = document.getElementById('indigo-driver');
    if (!driverSelect) return;
    try {
        _allDrivers = await fetch('/api/drivers').then(r => r.json());
    } catch (e) { _allDrivers = []; }

    const type = MODES[currentMode]?.driverType;
    const filtered = filterDriversByType(_allDrivers, type);
    const modeCfg = currentModeConfig();
    const prev = driverSelect.value || modeCfg.driver || '';

    driverSelect.innerHTML = '';
    if (filtered.length === 0) {
        driverSelect.innerHTML = '<option value="">Aucun driver</option>';
    } else {
        for (const d of filtered) {
            const opt = document.createElement('option');
            opt.value = d.name;
            opt.textContent = d.label || d.name;
            driverSelect.appendChild(opt);
        }
    }

    // Restore previous selection if still present
    if (prev && driverSelect.querySelector(`option[value="${prev}"]`)) {
        driverSelect.value = prev;
    }
}

function initConnectionBar() {
    const connectBtn = document.getElementById('btn-indigo-connect');
    const attachBtn = document.getElementById('btn-indigo-attach');
    const applyPortBtn = document.getElementById('btn-indigo-apply-port');
    const protoSelect = document.getElementById('indigo-protocol');
    const driverSelect = document.getElementById('indigo-driver');
    const attachRow = document.getElementById('conn-row-attach');
    const ipInput = document.getElementById('indigo-ip');
    const portInput = document.getElementById('indigo-port');
    const serialInput = document.getElementById('indigo-serial');
    let isConnected = false;

    // Toggle attach row visibility — shown when protocol is "attach" OR when connected
    if (protoSelect && attachRow) {
        function updateAttachRow() {
            attachRow.style.display = (protoSelect.value === 'attach' || isConnected) ? '' : 'none';
        }
        protoSelect.addEventListener('change', updateAttachRow);
        updateAttachRow();
    }

    // Connect button
    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            const protocol = protoSelect?.value || 'connect';
            const host = ipInput?.value || '192.168.1.25';
            const port = parseInt(portInput?.value || '7624', 10);
            addLog('info', 'ws', `Connexion ${protocol} → ${host}:${port}...`);
            try {
                const res = await fetch('/api/connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ protocol, host, port }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', `Paramètres mis à jour: ${protocol} ${host}:${port}`);
                else addLog('error', 'ws', `Erreur: ${JSON.stringify(data)}`);
            } catch (e) {
                addLog('error', 'ws', `Erreur connexion: ${e.message}`);
            }
        });
    }

    // Attach driver button
    if (attachBtn && driverSelect) {
        attachBtn.addEventListener('click', async () => {
            const driver = driverSelect.value;
            if (!driver) { addLog('warning', 'ws', 'Aucun driver sélectionné'); return; }
            addLog('info', 'ws', `Attachement du driver: ${driver}...`);
            try {
                const res = await fetch('/api/drivers/attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ driver }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', `Driver "${driver}" attaché`);
                else addLog('error', 'ws', `Erreur attach: ${JSON.stringify(data)}`);
            } catch (e) {
                addLog('error', 'ws', `Erreur attach: ${e.message}`);
            }
        });
    }

    // Apply serial port
    if (applyPortBtn && serialInput) {
        applyPortBtn.addEventListener('click', async () => {
            const device = driverSelect?.value;
            const port = serialInput.value.trim();
            if (!device || !port) { addLog('warning', 'ws', 'Driver ou port manquant'); return; }
            addLog('info', 'ws', `Configuration port série: ${device} → ${port}`);
            try {
                const res = await fetch('/api/property', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        device,
                        property: 'DEVICE_PORT',
                        items: [{ name: 'PORT', value: port }],
                    }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', `Port série configuré: ${port}`);
                else addLog('error', 'ws', `Erreur port: ${JSON.stringify(data)}`);
            } catch (e) {
                addLog('error', 'ws', `Erreur port: ${e.message}`);
            }
        });
    }

    // Save driver selection to UI config
    if (driverSelect) {
        driverSelect.addEventListener('change', () => {
            currentModeConfig().driver = driverSelect.value;
            saveUiConfig();
        });
    }

    // Load current connection state
    fetch('/api/connection').then(r => r.json()).then(data => {
        if (protoSelect && data.protocol) protoSelect.value = data.protocol;
        if (ipInput && data.host) ipInput.value = data.host;
        if (portInput && data.port) portInput.value = data.port;
        if (protoSelect && attachRow) {
            attachRow.style.display = protoSelect.value === 'attach' ? '' : 'none';
        }
        if (data.connected) refreshDriverList();
    }).catch(() => {});

    // Poll connection status + drivers every 3s
    setInterval(async () => {
        try {
            const data = await fetch('/api/connection').then(r => r.json());
            const statusEl = document.getElementById('indigo-status');
            isConnected = !!data.connected;
            if (statusEl) {
                statusEl.textContent = data.connected ? '● Connecté' : '● Hors ligne';
                statusEl.className = data.connected ? 'status-online' : 'status-offline';
            }
            if (data.connected) {
                refreshDriverList();
            }
            if (protoSelect && attachRow) {
                const showAttach = protoSelect.value === 'attach' || isConnected;
                attachRow.style.display = showAttach ? '' : 'none';
                const serialRow = document.getElementById('conn-row-serial');
                if (serialRow) {
                    const hideSerial = (currentMode === 'capture' || currentMode === 'astrometry');
                    serialRow.style.display = (showAttach && !hideSerial) ? '' : 'none';
                }
            }
        } catch (e) {}
    }, 3000);
}

function initLocationUpdate() {
    const latInput = document.getElementById('obs-lat');
    const lonInput = document.getElementById('obs-lon');

    const updateBtn = document.getElementById('btn-update-location');
    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            const lat = parseFloat(latInput?.value);
            const lon = parseFloat(lonInput?.value);
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                if (skyEngine) skyEngine.updateSite(lat, lon, skyEngine.siteElev);
                const stationEl = document.getElementById('station-display');
                if (stationEl) stationEl.textContent = `Station : ${lat.toFixed(2)}°N / ${lon.toFixed(2)}°E`;
            }
        });
    }
}

// ── Capture panel ─────────────────────────────────────────────

let _captureFrameType = 'LIGHT';
let _captureRunning = false;
let _captureQueue = 0;
let _captureTotal = 0;
let _exposureStartMs = 0;
let _exposureDurationMs = 0;
let _countdownRaf = 0;

// Histogram / preview
let _histPixels = null;     // Float64Array of raw pixel data
let _histWidth = 0;
let _histHeight = 0;
let _histAuto = true;
let _histBlackPct = 0;      // manual black point (0-100)
let _histMin = 0;
let _histMax = 0;
let _histDataMin = 0;
let _histDataMax = 0;

// Zoom / pan
let _previewZoom = 1;
let _previewPanX = 0;
let _previewPanY = 0;

// Save
let _saveDir = '';

function initCapturePanel() {
    // Camera selector
    const camSelect = document.getElementById('cap-camera-select');
    if (camSelect) {
        camSelect.addEventListener('change', () => {
            selectedCamera = camSelect.value || null;
            renderCapturePanel();
        });
    }

    // Frame type buttons
    document.querySelectorAll('.cap-ft-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cap-ft-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _captureFrameType = btn.dataset.frame;
        });
    });

    // Gain slider ↔ number sync
    const gainSlider = document.getElementById('cap-gain-slider');
    const gainInput = document.getElementById('cap-gain');
    if (gainSlider && gainInput) {
        gainSlider.addEventListener('input', () => {
            gainInput.value = gainSlider.value;
            sendCapNumber('CCD_GAIN', 'GAIN', parseInt(gainSlider.value));
        });
        gainInput.addEventListener('change', () => {
            gainSlider.value = gainInput.value;
            sendCapNumber('CCD_GAIN', 'GAIN', parseInt(gainInput.value));
        });
    }

    // Offset slider ↔ number sync
    const offsetSlider = document.getElementById('cap-offset-slider');
    const offsetInput = document.getElementById('cap-offset');
    if (offsetSlider && offsetInput) {
        offsetSlider.addEventListener('input', () => {
            offsetInput.value = offsetSlider.value;
            sendCapNumber('CCD_OFFSET', 'OFFSET', parseInt(offsetSlider.value));
        });
        offsetInput.addEventListener('change', () => {
            offsetSlider.value = offsetInput.value;
            sendCapNumber('CCD_OFFSET', 'OFFSET', parseInt(offsetInput.value));
        });
    }

    // Binning
    const binningSelect = document.getElementById('cap-binning');
    if (binningSelect) {
        binningSelect.addEventListener('change', () => {
            const v = parseInt(binningSelect.value);
            if (!findCamera()) return;
            apiPost('/api/property', {
                device: findCamera().name,
                property: 'CCD_BINNING',
                items: [{ name: 'HOR_BIN', value: v }, { name: 'VER_BIN', value: v }]
            });
        });
    }

    // Temperature set button
    const setTempBtn = document.getElementById('cap-set-temp');
    if (setTempBtn) {
        setTempBtn.addEventListener('click', () => {
            const target = parseFloat(document.getElementById('cap-target-temp')?.value);
            if (!isNaN(target)) apiPost('/api/camera/temperature', { device: findCamera()?.name, target });
        });
    }

    // Expose button
    const exposeBtn = document.getElementById('cap-expose-btn');
    if (exposeBtn) {
        exposeBtn.addEventListener('click', () => {
            if (_captureRunning) return;
            const count = parseInt(document.getElementById('cap-count')?.value || '1');
            const delay = parseFloat(document.getElementById('cap-delay')?.value || '0');
            startSequence(count, delay);
        });
    }

    // Abort button
    const abortBtn = document.getElementById('cap-abort-btn');
    if (abortBtn) {
        abortBtn.addEventListener('click', () => {
            _captureQueue = 0;
            _captureRunning = false;
            apiPost('/api/camera/abort', { device: findCamera()?.name });
            updateCaptureProgress();
        });
    }
}

function findCamera() {
    const cams = Object.entries(devices).filter(([, d]) => d.type === 'camera');
    if (cams.length === 0) { selectedCamera = null; return null; }

    // Check dropdown selection first (user choice)
    const sel = document.getElementById('cap-camera-select');
    if (sel && sel.value && devices[sel.value] && devices[sel.value].type === 'camera') {
        selectedCamera = sel.value;
        return { name: sel.value, dev: devices[sel.value] };
    }

    // Prefer previously selected camera if it still exists
    if (selectedCamera && devices[selectedCamera] && devices[selectedCamera].type === 'camera') {
        return { name: selectedCamera, dev: devices[selectedCamera] };
    }

    // Fallback: first camera found
    selectedCamera = cams[0][0];
    return { name: cams[0][0], dev: cams[0][1] };
}

function sendCapNumber(prop, item, value) {
    const cam = findCamera();
    if (!cam) return;
    apiPost('/api/property', { device: cam.name, property: prop, items: [{ name: item, value }] });
}

async function startSequence(count, delay) {
    const cam = findCamera();
    if (!cam) { addLog('error', 'capture', 'Pas de caméra connectée'); return; }
    _captureTotal = count;
    _captureQueue = count;
    _captureRunning = true;
    updateCaptureProgress();

    for (let i = 0; i < count; i++) {
        if (!_captureRunning) break;
        const exposure = parseFloat(document.getElementById('cap-exposure')?.value || '1');
        addLog('info', 'capture', `Pose ${i + 1}/${count} — ${exposure}s ${_captureFrameType}`);
        apiPost('/api/camera/expose', { device: cam.name, duration: exposure, frame_type: _captureFrameType });
        _exposureDurationMs = exposure * 1000;
        _exposureStartMs = Date.now();
        startCountdown();
        await waitExposureDone(cam.name, exposure * 1000 + 5000);
        stopCountdown();
        if (!_captureRunning) break;
        _captureQueue--;
        updateCaptureProgress();
        if (i < count - 1 && delay > 0 && _captureRunning) {
            await sleep(delay * 1000);
        }
    }
    _captureRunning = false;
    _captureQueue = 0;
    updateCaptureProgress();
    addLog('info', 'capture', 'Séquence terminée');
}

function waitExposureDone(camName, timeout) {
    return new Promise(resolve => {
        const start = Date.now();
        let started = false;
        const check = () => {
            if (!_captureRunning) { resolve(); return; }
            const cam = devices[camName];
            const elapsed = Date.now() - start;
            if (!cam || elapsed > timeout) { resolve(); return; }
            if (!started) {
                if (cam.exposure_time > 0) started = true;
                setTimeout(check, 100);
            } else {
                if (cam.exposure_time <= 0) { resolve(); return; }
                setTimeout(check, 200);
            }
        };
        setTimeout(check, 200);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startCountdown() {
    const row = document.getElementById('cap-countdown-row');
    if (row) row.style.display = '';
    _tickCountdown();
}

function stopCountdown() {
    const row = document.getElementById('cap-countdown-row');
    if (row) row.style.display = 'none';
    if (_countdownRaf) { cancelAnimationFrame(_countdownRaf); _countdownRaf = 0; }
}

function _tickCountdown() {
    if (!_captureRunning) { stopCountdown(); return; }
    const elapsed = Date.now() - _exposureStartMs;
    const remaining = Math.max(0, _exposureDurationMs - elapsed);
    const frac = _exposureDurationMs > 0 ? Math.min(1, elapsed / _exposureDurationMs) : 0;

    const totalSec = remaining / 1000;
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(totalSec % 60)).padStart(2, '0');
    const ds = String(Math.floor((totalSec % 1) * 10));

    const el = document.getElementById('cap-countdown');
    if (el) el.textContent = `${mm}:${ss}.${ds}`;

    const fill = document.getElementById('cap-exp-fill');
    if (fill) fill.style.width = (frac * 100) + '%';

    _countdownRaf = requestAnimationFrame(_tickCountdown);
}

function updateCaptureProgress() {
    const section = document.getElementById('cap-progress-section');
    const fill = document.getElementById('cap-progress-fill');
    const text = document.getElementById('cap-progress-text');
    const exposeBtn = document.getElementById('cap-expose-btn');
    if (!section) return;

    if (_captureTotal > 0 && _captureRunning) {
        section.style.display = '';
        const done = _captureTotal - _captureQueue;
        const pct = _captureTotal > 0 ? (done / _captureTotal * 100) : 0;
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${done} / ${_captureTotal}`;
        if (exposeBtn) exposeBtn.disabled = true;
    } else {
        section.style.display = 'none';
        stopCountdown();
        if (exposeBtn) exposeBtn.disabled = false;
    }
}

function renderCapturePanel() {
    const container = document.getElementById('applet-capture-settings');
    if (!container) return;

    const cam = findCamera();
    const statusBar = document.getElementById('cam-status-bar');
    const statusLed = document.getElementById('cam-status-led');
    const statusLabel = document.getElementById('cam-status-label');

    // Determine state
    let state, label;
    if (!cam) {
        state = 'none';
        label = 'Pas de caméra';
    } else if (!cam.dev.is_ready) {
        state = 'attaching';
        label = `${cam.name} — attachement...`;
    } else if (!cam.dev.connected) {
        state = 'disconnected';
        label = `${cam.name} — déconnectée`;
    } else {
        state = 'ready';
        label = cam.name;
    }

    if (statusBar) statusBar.dataset.state = state;
    if (statusLabel) statusLabel.textContent = label;

    // Show connect button when camera is discovered but not connected/ready
    const btnCamConnect = document.getElementById('btn-cam-connect');
    if (btnCamConnect) {
        const showConnect = cam && !cam.dev.connected && !cam.dev.is_ready;
        btnCamConnect.style.display = showConnect ? '' : 'none';
        btnCamConnect.onclick = async () => {
            if (!cam) return;
            addLog('info', 'ws', `Connexion manuelle: ${cam.name}...`);
            try {
                const res = await fetch('/api/device/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device: cam.name }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', `Connexion envoyée pour ${cam.name}`);
                else addLog('error', 'ws', `Erreur: ${JSON.stringify(data)}`);
            } catch (e) {
                addLog('error', 'ws', `Erreur: ${e.message}`);
            }
        };
    }

    // Populate camera selector (only shown when >1 camera)
    const camSelect = document.getElementById('cap-camera-select');
    const camSection = document.getElementById('cap-camera-section');
    const cameras = Object.entries(devices).filter(([, d]) => d.type === 'camera');
    if (camSelect && camSection) {
        if (cameras.length > 1) {
            camSection.style.display = '';
            const prevVal = camSelect.value || selectedCamera;
            camSelect.innerHTML = '';
            cameras.forEach(([name]) => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                camSelect.appendChild(opt);
            });
            if (prevVal && cameras.some(([n]) => n === prevVal)) {
                camSelect.value = prevVal;
            } else if (cameras.length > 0) {
                camSelect.value = cameras[0][0];
            }
        } else {
            camSection.style.display = 'none';
        }
    }

    if (!cam) {
        container.querySelectorAll('input, select, button:not(.applet-minimize)').forEach(el => {
            el.disabled = true;
        });
        return;
    }

    container.querySelectorAll('input, select, button:not(.applet-minimize)').forEach(el => {
        el.disabled = false;
    });

    const d = cam.dev;

    // Sensor info
    const sensorInfo = document.getElementById('cap-sensor-info');
    if (sensorInfo && d.width_px && d.height_px) {
        sensorInfo.textContent = `${d.width_px}×${d.height_px} — ${d.pixel_size_um}µm`;
    }

    // Binning
    const binSel = document.getElementById('cap-binning');
    if (binSel && d.binning_x != null) {
        binSel.value = d.binning_x;
    }

    // Gain
    const gainInput = document.getElementById('cap-gain');
    const gainSlider = document.getElementById('cap-gain-slider');
    if (gainInput && d.gain != null && document.activeElement !== gainInput) {
        gainInput.value = d.gain;
        if (gainSlider) gainSlider.value = d.gain;
    }

    // Offset
    const offsetInput = document.getElementById('cap-offset');
    const offsetSlider = document.getElementById('cap-offset-slider');
    if (offsetInput && d.offset != null && document.activeElement !== offsetInput) {
        offsetInput.value = d.offset;
        if (offsetSlider) offsetSlider.value = d.offset;
    }

    // Temperature
    const tempEl = document.getElementById('cap-temp-current');
    if (tempEl) {
        tempEl.textContent = d.temperature != null ? `${d.temperature.toFixed(1)} °C` : '--- °C';
    }
    const targetTempInput = document.getElementById('cap-target-temp');
    if (targetTempInput && d.target_temp != null && document.activeElement !== targetTempInput) {
        targetTempInput.value = d.target_temp;
    }

    // Frame type
    if (d.frame_type) {
        _captureFrameType = d.frame_type;
        document.querySelectorAll('.cap-ft-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.frame === d.frame_type);
        });
    }
}

// ── FITS image handling ──────────────────────────────────────

function handleGuideImage(b64Data, fmt) {
    const raw = atob(b64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (!(fmt === 'image/fits' || (bytes.length > 0 && bytes[0] === 0x53))) return;

    // Parse FITS header
    let offset = 0;
    const decoder = new TextDecoder('ascii');
    let headerStr = '';
    while (offset < bytes.length) {
        const block = decoder.decode(bytes.slice(offset, offset + 2880));
        headerStr += block;
        offset += 2880;
        let foundEnd = false;
        for (let c = headerStr.length - 2880; c < headerStr.length; c += 80) {
            if (headerStr.substring(c, c + 3).trim() === 'END') { foundEnd = true; break; }
        }
        if (foundEnd) break;
    }
    const get = (key) => {
        for (let i = 0; i < headerStr.length; i += 80) {
            const card = headerStr.substring(i, i + 80);
            if (card.substring(0, 8).trim() === key) {
                const eqIdx = card.indexOf('=');
                if (eqIdx < 0) continue;
                let val = card.substring(eqIdx + 1).trim();
                const slashIdx = val.indexOf('/');
                if (slashIdx >= 0) val = val.substring(0, slashIdx);
                val = val.trim().replace(/^['"]|['"]$/g, '');
                return val.split(/\s+/)[0] || null;
            }
        }
        return null;
    };
    const naxis = parseInt(get('NAXIS') || '0');
    const w = parseInt(get('NAXIS1') || '0');
    const h = parseInt(get('NAXIS2') || '0');
    const bitpix = parseInt(get('BITPIX') || '16');
    if (naxis < 2 || !w || !h) return;

    const dataStart = offset;
    const remaining = bytes.length - dataStart;
    const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, remaining);
    const pixels = new Float64Array(w * h);
    if (bitpix === 16) {
        for (let i = 0; i < w * h && i * 2 + 2 <= remaining; i++)
            pixels[i] = view.getInt16(i * 2, false);
    } else return;

    let max = -Infinity;
    for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] > max) max = pixels[i];
    }
    const sorted = Float64Array.from(pixels).sort();
    const sky = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const sigma = sorted[Math.floor(sorted.length * 0.841)] - sky || 1;
    const k = Math.max(20, (max - sky) / sigma);
    const soft = sigma * 0.5;

    // Render to BOTH the large preview and the small thumbnail
    const dpr = window.devicePixelRatio || 1;
    function renderToCanvas(canvasEl) {
        if (!canvasEl) return;
        const cw = canvasEl.clientWidth, ch = canvasEl.clientHeight;
        if (!cw || !ch) return;
        const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
        if (canvasEl.width !== bw || canvasEl.height !== bh) {
            canvasEl.width = bw;
            canvasEl.height = bh;
        }
        const ctx = canvasEl.getContext('2d');
        ctx.clearRect(0, 0, bw, bh);

        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tctx = tmp.getContext('2d');
        const imgData = tctx.createImageData(w, h);
        const data = imgData.data;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const raw = pixels[y * w + x];
                const v = Math.asinh((raw - sky) / soft) / Math.asinh(k);
                const val = Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)));
                const dst = ((h - 1 - y) * w + x) * 4;
                data[dst] = val; data[dst+1] = val; data[dst+2] = val; data[dst+3] = 255;
            }
        }
        tctx.putImageData(imgData, 0, 0);

        const scale = Math.min(bw / w, bh / h);
        const dw = w * scale, dh = h * scale;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, (bw - dw) / 2, (bh - dh) / 2, dw, dh);

        // Return metadata for this render
        return { scale, offX: (bw - dw) / 2, offY: (bh - dh) / 2, cw: bw, ch: bh };
    }

    // Render to large preview (for star selection)
    const previewCanvas = document.getElementById('guide-preview-canvas');
    const previewMeta = renderToCanvas(previewCanvas);
    // Also render to small thumbnail
    renderToCanvas(document.getElementById('guide-star-canvas'));

    // Store preview data for click remapping
    if (previewMeta) {
        _guidePreviewCapture = { width: w, height: h, pixels, sky, soft, k, ...previewMeta, dpr };
    }

    // Detect stars and draw markers on preview overlay
    _guideDetectStars(w, h);
}

function _guideDetectStars(w, h) {
    if (!_guidePreviewCapture) return;
    const overlay = document.getElementById('guide-preview-overlay');
    if (!overlay) return;
    const { pixels, sky, soft, k, scale, offX, offY, canvasW, canvasH, dpr } = _guidePreviewCapture;

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
            statusEl.textContent = `⭐ Étoile #${idx} (${_guideSelectedStar.x}, ${_guideSelectedStar.y}) — Prêt pour guidage`;
            statusEl.style.color = '#00ffcc';
        } else if (_guideStarList.length > 0) {
            statusEl.textContent = `✨ ${_guideStarList.length} étoiles — cliquez une étoile ou «⭐ Auto»`;
            statusEl.style.color = '#ffaa00';
        } else {
            statusEl.textContent = 'Pas d\'étoile détectée';
            statusEl.style.color = '#ff4444';
        }
    }
}

function _guideSetStar(star) {
    _guideSelectedStar = star;
    if (star) {
        const w = _guidePreviewCapture?.width || 1;
        const h = _guidePreviewCapture?.height || 1;
        apiPost('/api/guide/set-reference', { x: star.x, y: h - 1 - star.y });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            const idx = _guideStarList.indexOf(star) + 1;
            statusEl.textContent = `⭐ Étoile #${idx} (${star.x}, ${star.y}) — Prêt pour guidage`;
            statusEl.style.color = '#00ffcc';
        }
    }
    if (_guidePreviewCapture) _guideDetectStars(_guidePreviewCapture.width, _guidePreviewCapture.height);
}

function _guideAutoSelect() {
    // Dedicated button handler: re-fetch via API and pick best gaussian_quality star
    const cam = _guideCameraSelect?.value || '';
    if (!cam) { addLog('warn', 'guide', 'Aucune caméra guide sélectionnée'); return; }
    const metricUrl = '/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : '');
    fetch(metricUrl).then(r => r.json()).then(metric => {
        if (!metric?.ok || !metric.stars?.length) {
            addLog('warn', 'guide', 'Aucune étoile détectée');
            return;
        }
        // Pick best by gaussian_quality (already sorted server-side)
        const best = metric.stars[0];
        const imgH = metric.height || 1;
        _guideSelectedStar = { x: best.x, y: best.y, quality: best.gaussian_quality || 0 };
        apiPost('/api/guide/set-reference', { x: best.x, y: imgH - 1 - best.y });
        const statusEl = document.getElementById('guide-preview-status');
        if (statusEl) {
            statusEl.textContent = `⭐ Auto: étoile (${best.x}, ${best.y}) qualité=${best.gaussian_quality} — Prêt`;
            statusEl.style.color = '#00ffcc';
        }
        if (_guidePreviewCapture) _guideDetectStars(_guidePreviewCapture.width, _guidePreviewCapture.height);
        addLog('info', 'guide', `Étoile sélectionnée auto: (${best.x}, ${best.y}) qualité=${best.gaussian_quality}`);
    }).catch(e => {
        addLog('error', 'guide', `Erreur sélection auto: ${e.message}`);
    });
}

let _guideRefSet = false;
let _guideLastCentroid = null;
let _guideStarList = [];
let _guideSelectedStar = null;
let _guidePreviewCapture = null;  // { width, height, pixels } for click remapping
let _guideAutoStar = null;

function handleCameraImage(b64Data, fmt) {
    clearOffsetOverlay();
    clearFocusOverlay();
    const raw = atob(b64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    if (fmt === 'image/fits' || (bytes.length > 0 && bytes[0] === 0x53)) {
        renderFITSImage(bytes);
    } else {
        const blob = new Blob([bytes], { type: fmt || 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const canvas = document.getElementById('cap-preview-canvas');
            if (canvas) {
                canvas.width = img.width;
                canvas.height = img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
            }
            const overlay = document.getElementById('offset-overlay-canvas');
            if (overlay) {
                overlay.width = img.width;
                overlay.height = img.height;
                overlay.style.width = img.width + 'px';
                overlay.style.height = img.height + 'px';
                overlay.style.display = 'none';
            }
            showPreviewInfo(`${img.width}×${img.height} — ${fmt}`);
            URL.revokeObjectURL(url);
        };
        img.src = url;
    }
}

function renderFITSImage(bytes) {
    let headerStr = '';
    let offset = 0;
    const decoder = new TextDecoder('ascii');

    while (offset < bytes.length) {
        const block = decoder.decode(bytes.slice(offset, offset + 2880));
        headerStr += block;
        offset += 2880;
        let foundEnd = false;
        for (let c = headerStr.length - 2880; c < headerStr.length; c += 80) {
            if (headerStr.substring(c, c + 3).trim() === 'END') {
                foundEnd = true;
                break;
            }
        }
        if (foundEnd) break;
    }

    const get = (key) => {
        for (let i = 0; i < headerStr.length; i += 80) {
            const card = headerStr.substring(i, i + 80);
            if (card.substring(0, 8).trim() === key) {
                const eqIdx = card.indexOf('=');
                if (eqIdx < 0) continue;
                let val = card.substring(eqIdx + 1).trim();
                const slashIdx = val.indexOf('/');
                if (slashIdx >= 0) val = val.substring(0, slashIdx);
                val = val.trim().replace(/^['"]|['"]$/g, '');
                return val.split(/\s+/)[0] || null;
            }
        }
        return null;
    };

    const naxis = parseInt(get('NAXIS') || '0');
    const w = parseInt(get('NAXIS1') || '0');
    const h = parseInt(get('NAXIS2') || '0');
    const bitpix = parseInt(get('BITPIX') || '32');

    if (naxis < 2 || !w || !h) {
        addLog('warning', 'capture', 'En-tête FITS invalide');
        return;
    }

    const dataStart = offset;
    const remaining = bytes.length - dataStart;
    const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, remaining);
    const pixels = new Float64Array(w * h);

    if (bitpix === 32 || bitpix === -32) {
        for (let i = 0; i < w * h && i * 4 + 4 <= remaining; i++)
            pixels[i] = view.getFloat32(i * 4, false);
    } else if (bitpix === 16) {
        for (let i = 0; i < w * h && i * 2 + 2 <= remaining; i++)
            pixels[i] = view.getInt16(i * 2, false);
    } else if (bitpix === -16) {
        for (let i = 0; i < w * h && i * 2 + 2 <= remaining; i++)
            pixels[i] = view.getUint16(i * 2, false);
    } else if (bitpix === 64) {
        for (let i = 0; i < w * h && i * 8 + 8 <= remaining; i++)
            pixels[i] = view.getFloat64(i * 8, false);
    } else if (bitpix === 8) {
        for (let i = 0; i < w * h && i < remaining; i++)
            pixels[i] = bytes[dataStart + i];
    }

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] < min) min = pixels[i];
        if (pixels[i] > max) max = pixels[i];
    }

    // Compute sky level using median and sigma from sorted array
    const sorted = Float64Array.from(pixels).sort();
    const sky = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const sigma = sorted[Math.floor(sorted.length * 0.841)] - sky || 1;

    // Asinh stretch: maps [sky - 3σ, sky + k*σ] → [0, 255]
    // k adapts to the data range (larger for images with bright stars)
    const k = Math.max(20, (max - sky) / sigma);
    const soft = sigma * 0.5;  // softening parameter

    const canvas = document.getElementById('cap-preview-canvas');
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const raw = pixels[y * w + x];
            // Asinh stretch centered on sky background
            const v = Math.asinh((raw - sky) / soft) / Math.asinh(k);
            const val = Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)));
            const dst = ((h - 1 - y) * w + x) * 4;
            data[dst] = val;
            data[dst + 1] = val;
            data[dst + 2] = val;
            data[dst + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // Sync overlay canvas dimensions
    const overlay = document.getElementById('offset-overlay-canvas');
    if (overlay) {
        overlay.width = w;
        overlay.height = h;
        overlay.style.width = w + 'px';
        overlay.style.height = h + 'px';
        overlay.style.display = 'none';
    }

    _histPixels = pixels;
    _histWidth = w;
    _histHeight = h;
    _histDataMin = sky - 3 * sigma;
    _histDataMax = sky + k * sigma;
    _histMin = sky - 3 * sigma;
    _histMax = sky + k * sigma;

    showPreviewInfo(`${w}×${h} — FITS ${Math.abs(bitpix)}bit — sky:${sky.toFixed(1)} σ:${sigma.toFixed(1)} range:[${min.toFixed(0)}..${max.toFixed(0)}]`);

    setTimeout(() => {
        _fitPreviewZoom();
        renderHistogram();
    }, 50);

    addLog('debug', 'capture', `Image rendue: ${w}×${h} FITS ${Math.abs(bitpix)}bit`);
}

function showPreviewInfo(text) {
    const panel = document.getElementById('applet-capture-preview');
    if (panel) {
        panel.style.display = '';
        if (panel.classList.contains('collapsed')) toggleMinimize(panel);
    }
    const empty = document.getElementById('cap-preview-empty');
    const wrap = document.getElementById('cap-preview-wrap');
    const info = document.getElementById('cap-preview-info');
    if (empty) empty.style.display = 'none';
    if (wrap) wrap.style.display = '';
    if (info) info.textContent = text;
    // Auto-fit image to viewport
    setTimeout(_fitPreviewZoom, 60);
    // Compute focus metrics in focuser mode
    if (currentMode === 'focuser') setTimeout(requestFocusMetrics, 200);
}

// ── Histogram + preview stretch ────────────────────────────────

function renderHistogram() {
    const canvas = document.getElementById('cap-histo-canvas');
    if (!canvas || !_histPixels || _histPixels.length === 0) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth * 2;
    const H = canvas.height = canvas.offsetHeight * 2;

    const bins = new Uint32Array(256);
    const range = _histDataMax - _histDataMin || 1;
    for (let i = 0; i < _histPixels.length; i++) {
        let v = Math.round((_histPixels[i] - _histDataMin) / range * 255);
        if (v < 0) v = 0; if (v > 255) v = 255;
        bins[v]++;
    }
    let maxBin = 0;
    for (let i = 1; i < 256; i++) if (bins[i] > maxBin) maxBin = bins[i];
    if (maxBin === 0) maxBin = 1;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, W, H);

    // Stretch range highlight
    const blackFrac = _histAuto ? 0 : _histBlackPct / 100;
    const blX = blackFrac * W;
    ctx.fillStyle = 'rgba(0,255,204,0.08)';
    ctx.fillRect(blX, 0, W - blX, H);

    // Bars
    for (let i = 0; i < 256; i++) {
        const bh = Math.max(1, (bins[i] / maxBin) * H);
        ctx.fillStyle = 'rgba(0,255,204,0.5)';
        ctx.fillRect(i * W / 256, H - bh, W / 256 + 1, bh);
    }

    // Black point line
    ctx.strokeStyle = '#ff5577';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(blX, 0);
    ctx.lineTo(blX, H);
    ctx.stroke();

    // Update slider position
    const slider = document.getElementById('cap-histo-slider');
    if (slider) slider.value = _histAuto ? 0 : _histBlackPct;
    const val = document.getElementById('cap-histo-val');
    if (val) val.textContent = _histAuto ? 'AUTO' : Math.round(_histBlackPct) + '%';
}

function applyHistogramStretch() {
    const canvas = document.getElementById('cap-preview-canvas');
    if (!canvas || !_histPixels) return;
    const w = _histWidth, h = _histHeight;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    if (_histAuto) {
        _histMin = _histDataMin;
        _histMax = _histDataMax;
    } else {
        const range = _histDataMax - _histDataMin;
        _histMin = _histDataMin + (_histBlackPct / 100) * range;
        _histMax = _histDataMax;
    }
    const stretchRange = _histMax - _histMin || 1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const raw = _histPixels[y * w + x];
            let val;
            if (raw <= _histMin) val = 0;
            else if (raw >= _histMax) val = 255;
            else val = Math.round(((raw - _histMin) / stretchRange) * 255);
            const dst = ((h - 1 - y) * w + x) * 4;
            data[dst] = val;
            data[dst + 1] = val;
            data[dst + 2] = val;
            data[dst + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    const minEl = document.getElementById('cap-histo-min');
    const maxEl = document.getElementById('cap-histo-max');
    if (minEl) minEl.textContent = _histMin.toFixed(1);
    if (maxEl) maxEl.textContent = _histMax.toFixed(1);
}

// ── Preview resize ─────────────────────────────────────────────

function initPreviewResize() {
    const panel = document.getElementById('applet-capture-preview');
    const handle = document.getElementById('cap-resize-handle');
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
            _fitPreviewZoom();
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

// ── Preview zoom / pan / enlarge ────────────────────────────

function _applyPreviewTransform() {
    const canvas = document.getElementById('cap-preview-canvas');
    if (!canvas) return;
    const t = `translate(${_previewPanX}px, ${_previewPanY}px) scale(${_previewZoom})`;
    canvas.style.transform = t;
    const overlay = document.getElementById('offset-overlay-canvas');
    if (overlay) overlay.style.transform = t;
    const focusOvl = document.getElementById('focus-overlay-canvas');
    if (focusOvl) focusOvl.style.transform = t;
    const vp = document.getElementById('cap-preview-viewport');
    if (vp) vp.classList.toggle('zoomed', _previewZoom > 1.05);
    const lvl = document.getElementById('cap-zoom-level');
    if (lvl) {
        const txt = Math.round(_previewZoom * 100) + '%';
        if (lvl.textContent !== txt) {
            lvl.textContent = txt;
            lvl.classList.add('flash');
            clearTimeout(lvl._flashTimer);
            lvl._flashTimer = setTimeout(() => lvl.classList.remove('flash'), 400);
        }
    }
}

function _resetPreviewZoom() {
    _previewZoom = 1;
    _previewPanX = 0;
    _previewPanY = 0;
    const vp = document.getElementById('cap-preview-viewport');
    if (vp) vp.style.height = '';
    _applyPreviewTransform();
}

function _fitPreviewZoom() {
    const canvas = document.getElementById('cap-preview-canvas');
    const vp = document.getElementById('cap-preview-viewport');
    if (!canvas || !vp || !_histWidth || !_histHeight) return;
    const vpW = vp.clientWidth;
    if (vpW <= 0) return;
    const wrap = vp.parentElement;
    const wrapH = wrap ? wrap.clientHeight : 400;
    const controlsH = 80;
    const maxH = Math.max(100, wrapH - controlsH);
    const fitScale = Math.min(vpW / _histWidth, maxH / _histHeight, 1);
    _previewZoom = fitScale;
    _previewPanX = (vpW - _histWidth * fitScale) / 2;
    _previewPanY = 0;
    vp.style.height = Math.round(_histHeight * fitScale) + 'px';
    canvas.style.width = _histWidth + 'px';
    canvas.style.height = _histHeight + 'px';
    const overlay = document.getElementById('offset-overlay-canvas');
    if (overlay) {
        overlay.width = _histWidth;
        overlay.height = _histHeight;
        overlay.style.width = _histWidth + 'px';
        overlay.style.height = _histHeight + 'px';
    }
    _applyPreviewTransform();
}

function initPreviewZoomPan() {
    const vp = document.getElementById('cap-preview-viewport');
    const canvas = document.getElementById('cap-preview-canvas');
    const zoomReset = document.getElementById('cap-zoom-reset');
    const zoomFit = document.getElementById('cap-zoom-fit');
    const zoomEnlarge = document.getElementById('cap-zoom-enlarge');
    if (!vp || !canvas) return;

    // Wheel zoom
    vp.addEventListener('wheel', (e) => {
        if (!_histWidth) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const prevZoom = _previewZoom;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        _previewZoom = Math.max(0.1, Math.min(50, _previewZoom * factor));
        const scale = _previewZoom / prevZoom;
        _previewPanX = mouseX - scale * (mouseX - _previewPanX);
        _previewPanY = mouseY - scale * (mouseY - _previewPanY);
        _applyPreviewTransform();
    }, { passive: false });

    // Pan drag
    let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
    vp.addEventListener('pointerdown', (e) => {
        if (_previewZoom <= 1.05) return;
        if (e.target.closest('.cap-zoom-btn, .cap-histo-auto-btn, input[type=range]')) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = _previewPanX;
        panStartY = _previewPanY;
        vp.classList.add('panning');
        vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        _previewPanX = panStartX + (e.clientX - dragStartX);
        _previewPanY = panStartY + (e.clientY - dragStartY);
        _applyPreviewTransform();
    });
    vp.addEventListener('pointerup', () => {
        dragging = false;
        vp.classList.remove('panning');
    });

    // Touch: pinch-to-zoom + single-finger pan
    let touchState = null;
    vp.addEventListener('touchstart', (e) => {
        if (!_histWidth) return;
        if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const rect = vp.getBoundingClientRect();
            touchState = {
                mode: 'pinch',
                startDist: Math.hypot(dx, dy),
                startZoom: _previewZoom,
                startPanX: _previewPanX,
                startPanY: _previewPanY,
                midX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
                midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
            };
        } else if (e.touches.length === 1 && _previewZoom > 1.05) {
            if (e.target.closest('.cap-zoom-btn, .cap-histo-auto-btn, input[type=range]')) return;
            touchState = {
                mode: 'pan',
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startPanX: _previewPanX,
                startPanY: _previewPanY
            };
            vp.classList.add('panning');
        }
    }, { passive: false });

    vp.addEventListener('touchmove', (e) => {
        if (!touchState) return;
        if (touchState.mode === 'pinch' && e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            const newZoom = Math.max(0.1, Math.min(50, touchState.startZoom * (dist / touchState.startDist)));
            const scale = newZoom / touchState.startZoom;
            _previewPanX = touchState.midX - scale * (touchState.midX - touchState.startPanX);
            _previewPanY = touchState.midY - scale * (touchState.midY - touchState.startPanY);
            _previewZoom = newZoom;
            _applyPreviewTransform();
        } else if (touchState.mode === 'pan' && e.touches.length === 1) {
            e.preventDefault();
            _previewPanX = touchState.startPanX + (e.touches[0].clientX - touchState.startX);
            _previewPanY = touchState.startPanY + (e.touches[0].clientY - touchState.startY);
            _applyPreviewTransform();
        }
    }, { passive: false });

    vp.addEventListener('touchend', (e) => {
        if (touchState && touchState.mode === 'pan') vp.classList.remove('panning');
        touchState = null;
    });
    vp.addEventListener('touchcancel', () => {
        if (touchState && touchState.mode === 'pan') vp.classList.remove('panning');
        touchState = null;
    });

    // Escape to exit enlarged mode
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const panel = document.getElementById('applet-capture-preview');
        if (panel && panel.classList.contains('enlarged')) {
            e.preventDefault();
            zoomEnlarge?.click();
        }
    });

    // Buttons
    if (zoomReset) zoomReset.addEventListener('click', () => { _resetPreviewZoom(); });
    if (zoomFit) zoomFit.addEventListener('click', () => { _fitPreviewZoom(); });
    if (zoomEnlarge) zoomEnlarge.addEventListener('click', () => {
        const panel = document.getElementById('applet-capture-preview');
        if (!panel) return;
        const enlarged = panel.classList.toggle('enlarged');
        if (enlarged) {
            panel.style.cssText = '';
            setTimeout(_fitPreviewZoom, 50);
        } else {
            panel.style.cssText = 'display:none; top:200px; left:50%; transform:translateX(-50%); width:500px;';
            _resetPreviewZoom();
        }
    });
    // Double-click to toggle enlarge
    vp.addEventListener('dblclick', () => {
        const panel = document.getElementById('applet-capture-preview');
        if (panel) zoomEnlarge?.click();
    });
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
            if (!_histPixels) { addLog('warning', 'capture', 'Pas d\'image à sauvegarder'); return; }
            const dir = _saveDir || document.getElementById('cap-save-dir')?.value?.trim() || '';
            if (!dir) { addLog('warning', 'capture', 'Choisissez un répertoire de sauvegarde'); return; }
            try {
                const res = await fetch('/api/camera/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dir }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'capture', `Image sauvegardée: ${data.path}`);
                else addLog('error', 'capture', `Erreur: ${data.error}`);
            } catch (e) {
                addLog('error', 'capture', `Erreur: ${e.message}`);
            }
        });
    }
}

function initHistogramControls() {
    const slider = document.getElementById('cap-histo-slider');
    const autoBtn = document.getElementById('cap-histo-auto');
    if (slider) {
        slider.addEventListener('input', () => {
            _histBlackPct = parseInt(slider.value);
            _histAuto = false;
            if (autoBtn) autoBtn.classList.remove('active');
            applyHistogramStretch();
            renderHistogram();
            currentModeConfig().histo_auto = false;
            currentModeConfig().histo_black_pct = _histBlackPct;
            saveUiConfig();
        });
    }
    if (autoBtn) {
        autoBtn.addEventListener('click', () => {
            _histAuto = !_histAuto;
            autoBtn.classList.toggle('active', _histAuto);
            applyHistogramStretch();
            renderHistogram();
            currentModeConfig().histo_auto = _histAuto;
            saveUiConfig();
        });
    }
    // Restore from config
    const mc = currentModeConfig();
    if (mc.histo_auto === false) {
        _histAuto = false;
        if (autoBtn) autoBtn.classList.remove('active');
        if (mc.histo_black_pct != null) _histBlackPct = mc.histo_black_pct;
    }
    if (mc.save_dir) {
        _saveDir = mc.save_dir;
        const dirInput = document.getElementById('cap-save-dir');
        if (dirInput) dirInput.value = _saveDir;
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

// ── Test harness (dev / no-camera testing) ───────────────────

let _testImages = [];

async function loadTestImageList() {
    try {
        const resp = await fetch('/api/test/fits-list');
        const data = await resp.json();
        _testImages = data.images || [];
        return _testImages;
    } catch (e) {
        console.warn('Test image list failed:', e);
        return [];
    }
}

async function loadTestFITS(filename) {
    try {
        const resp = await fetch(`/api/test/fits/${filename}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);
        clearOffsetOverlay();
        handleCameraImage(data.data, 'image/fits');

        fetch('/api/test/fits-store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: data.data, format: 'image/fits' }),
        });

        addLog('info', 'test', `Image test chargée: ${filename} (${data.size} bytes)`);
        return true;
    } catch (e) {
        addLog('error', 'test', `Échec chargement test: ${e.message}`);
        return false;
    }
}

function mockSolveResult(ra, dec, scale, rotation, opts = {}) {
    const result = {
        ok: true,
        ra: ra,
        dec: dec,
        rotation: rotation || 0,
        flipped: false,
        scale: scale || 2.5,
        matches: opts.matches || 12,
        rms: opts.rms || 1.5,
        width: _histWidth || 1920,
        height: _histHeight || 1080,
        stars_detected: opts.stars || 80,
        mode: 'hinted',
        elapsed_ms: opts.elapsed_ms || 42.0,
    };
    _lastSolverResult = result;
    renderSolverResult(result);
    setOffsetSolved(ra, dec, scale, rotation);
    addLog('info', 'test', `Mock solve: RA=${ra.toFixed(4)}° DEC=${dec.toFixed(4)}° scale=${scale}" rot=${rotation}°`);
    return result;
}

function mockSetTarget(ra, dec) {
    setOffsetTarget(ra, dec);
    addLog('info', 'test', `Cible définie: RA=${ra.toFixed(4)}° DEC=${dec.toFixed(4)}°`);
}

function mockClearTarget() {
    _offsetTargetRA = null;
    _offsetTargetDEC = null;
    clearOffsetOverlay();
    addLog('info', 'test', 'Cible et overlay effacés');
}

function testOverlayScenario(scenario) {
    const scenarios = {
        'north': {
            desc: 'Décalage 30\' vers le Nord',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.0, dec: 45.5 },
        },
        'east': {
            desc: 'Décalage 15\' vers l\'Est',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.25, dec: 45.0 },
        },
        'southeast': {
            desc: 'Décalage diagonal Sud-Est',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.3, dec: 44.5 },
        },
        'rotated': {
            desc: 'Même offset mais image rotée 45°',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 45 },
            target: { ra: 100.0, dec: 45.5 },
        },
        'small': {
            desc: 'Petit décalage 3\' (proche centrage)',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.0, dec: 45.05 },
        },
        'large': {
            desc: 'Grand décalage 2°',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 102.0, dec: 45.0 },
        },
    };

    const s = scenarios[scenario] || scenarios['north'];
    mockSolveResult(s.solved.ra, s.solved.dec, s.solved.scale, s.solved.rot);
    mockSetTarget(s.target.ra, s.target.dec);
    addLog('info', 'test', `Scénario "${scenario}": ${s.desc}`);
    return s;
}

window._testHarness = {
    loadTestImageList,
    loadTestFITS,
    mockSolveResult,
    mockSetTarget,
    mockClearTarget,
    testOverlayScenario,
    listImages: () => { loadTestImageList().then(imgs => console.table(imgs)); },
    help: () => {
        console.log(`
═══ Test Harness — Overlay & Solver ═══

  _testHarness.listImages()                  — Lister les images FITS disponibles
  _testHarness.loadTestFITS('test_orion.fits') — Charger une image dans le viewer
  _testHarness.mockSolveResult(ra, dec, scale, rotation) — Simuler un résultat solver
  _testHarness.mockSetTarget(ra, dec)         — Définir la cible
  _testHarness.mockClearTarget()              — Effacer cible et overlay
  _testHarness.testOverlayScenario('north')   — Scénario de test prédéfini

  Scénarios: north, east, southeast, rotated, small, large

  Exemple complet:
    await _testHarness.loadTestFITS('test_orion.fits')
    _testHarness.testOverlayScenario('southeast')
        `);
    },
};

// ── Plate Solver panel ──────────────────────────────────────────

let _solverMode = 'hinted';
let _solverStatus = null;

function initSolverPanel() {
    // Mode buttons
    document.querySelectorAll('.solver-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.solver-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _solverMode = btn.dataset.solverMode;
            const hintedParams = document.getElementById('solver-hinted-params');
            const blindParams = document.getElementById('solver-blind-params');
            if (hintedParams) hintedParams.style.display = _solverMode === 'hinted' ? '' : 'none';
            if (blindParams) blindParams.style.display = _solverMode === 'blind' ? '' : 'none';
        });
    });

    // Auto hint checkbox
    const autoHint = document.getElementById('solver-auto-hint');
    const manualHints = document.getElementById('solver-manual-hints');
    if (autoHint && manualHints) {
        autoHint.addEventListener('change', () => {
            manualHints.style.display = autoHint.checked ? 'none' : '';
        });
    }

    // Solve button
    const solveBtn = document.getElementById('solver-solve-btn');
    if (solveBtn) {
        solveBtn.addEventListener('click', () => solverSolve('last_image'));
    }

    // Sync mount button
    const syncBtn = document.getElementById('solver-sync-btn');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            const res = _lastSolverResult;
            if (res && res.ok) {
                apiPost('/api/mount/slew', { ra_hours: res.ra / 15, dec_deg: res.dec });
                addLog('info', 'solver', `SYNC monture vers RA=${res.ra.toFixed(4)}° DEC=${res.dec.toFixed(4)}°`);
            }
        });
    }

    // Center sky map button
    const centerBtn = document.getElementById('solver-center-btn');
    if (centerBtn) {
        centerBtn.addEventListener('click', () => {
            const res = _lastSolverResult;
            if (res && res.ok && skyEngine) {
                skyEngine.centerOnObject(res.ra, res.dec);
                addLog('info', 'solver', `Carte centrée sur RA=${res.ra.toFixed(2)}° DEC=${res.dec.toFixed(2)}°`);
            }
        });
    }

    // Test images button
    const testBtn = document.getElementById('solver-test-btn');
    const testDropdown = document.getElementById('solver-test-dropdown');
    const testList = document.getElementById('solver-test-list');
    if (testBtn && testDropdown && testList) {
        testBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const visible = testDropdown.style.display !== 'none';
            testDropdown.style.display = visible ? 'none' : '';
            if (!visible && testList.children.length === 0) {
                testList.innerHTML = '<div style="color:#666; font-size:0.6rem;">Chargement...</div>';
                const images = await loadTestImageList();
                testList.innerHTML = '';
                if (!images.length) {
                    testList.innerHTML = '<div style="color:#666; font-size:0.6rem;">Aucune image trouvée dans tests/fake_sky/</div>';
                    return;
                }
                for (const img of images) {
                    const item = document.createElement('div');
                    item.className = 'solver-test-item';
                    item.innerHTML = `<span class="test-name">${img.name}</span><span class="test-meta">RA=${img.ra?.toFixed(1)}° DEC=${img.dec?.toFixed(1)}° ${img.scale}"</span>`;
                    item.addEventListener('click', () => {
                        loadTestFITS(img.file);
                        testDropdown.style.display = 'none';
                    });
                    testList.appendChild(item);
                }
            }
        });
    }

    // Load solver status
    refreshSolverStatus();
}

let _lastSolverResult = null;

async function refreshSolverStatus(retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await fetch('/api/solver/status');
            const status = await resp.json();
            _solverStatus = status;
            const led = document.getElementById('solver-led');
            const text = document.getElementById('solver-status-text');
            const solveBtn = document.getElementById('solver-solve-btn');

            if (status.available && status.catalogs_loaded) {
                if (led) led.className = 'solver-led solver-led-ok';
                if (text) text.textContent = `Seiza prêt${status.has_blind_index ? ' (blind OK)' : ''}`;
                if (solveBtn) solveBtn.disabled = false;
                return;
            } else if (status.available) {
                if (led) led.className = 'solver-led solver-led-warn';
                if (text) text.textContent = 'Catalogues non chargés';
                if (solveBtn) solveBtn.disabled = true;
                return;
            } else {
                if (led) led.className = 'solver-led solver-led-error';
                if (text) text.textContent = 'Seiza non installé';
                if (solveBtn) solveBtn.disabled = true;
                return;
            }
        } catch (e) {
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            const led = document.getElementById('solver-led');
            const text = document.getElementById('solver-status-text');
            if (led) led.className = 'solver-led solver-led-error';
            if (text) text.textContent = 'Erreur status';
        }
    }
}

function updateSolverHints() {
    const m = findMount();
    const cam = findCamera();
    const raEl = document.getElementById('solver-ra-hint');
    const decEl = document.getElementById('solver-dec-hint');
    const scaleEl = document.getElementById('solver-scale-hint');

    if (m && m.dev.ra_hours != null) {
        const raDeg = m.dev.ra_hours * 15;
        if (raEl) raEl.textContent = decToSexa(raDeg / 15, true);
        if (decEl) decEl.textContent = decToSexa(m.dev.dec_deg, false);
    } else {
        if (raEl) raEl.textContent = '--';
        if (decEl) decEl.textContent = '--';
    }

    if (cam && cam.dev.pixel_size_um && cam.dev.focal_length_mm) {
        const bx = cam.dev.binning_x || 1;
        const scale = (cam.dev.pixel_size_um / 1000) / (cam.dev.focal_length_mm / 1000) * 206.265 / bx;
        if (scaleEl) scaleEl.textContent = scale.toFixed(2) + ' arcsec/px';
    } else {
        if (scaleEl) scaleEl.textContent = '-- arcsec/px';
    }
}

async function solverSolve(mode) {
    const solveBtn = document.getElementById('solver-solve-btn');
    const progress = document.getElementById('solver-progress');
    const progressFill = document.getElementById('solver-progress-fill');
    const progressText = document.getElementById('solver-progress-text');
    const resultsEl = document.getElementById('solver-results');
    const errorEl = document.getElementById('solver-error');

    if (solveBtn) solveBtn.disabled = true;
    if (progress) progress.style.display = '';
    if (resultsEl) resultsEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';

    // Animate progress bar
    let pct = 0;
    const progressInterval = setInterval(() => {
        pct = Math.min(95, pct + 1);
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) {
            const elapsed = (pct / 100) * (_solverMode === 'blind' ? 30 : 3);
            progressText.textContent = `Résolution en cours... ${elapsed.toFixed(1)}s`;
        }
    }, _solverMode === 'blind' ? 300 : 30);

    // Build request body
    const body = { mode };

    if (_solverMode === 'hinted') {
        const autoHint = document.getElementById('solver-auto-hint');
        if (autoHint && autoHint.checked) {
            // Auto: server will use mount + camera
            body.mode = 'last_image';
        } else {
            // Manual hints
            const ra = parseFloat(document.getElementById('solver-ra-manual')?.value);
            const dec = parseFloat(document.getElementById('solver-dec-manual')?.value);
            const scale = parseFloat(document.getElementById('solver-scale-manual')?.value);
            if (!isNaN(ra)) body.ra_hint = ra;
            if (!isNaN(dec)) body.dec_hint = dec;
            if (!isNaN(scale)) body.scale_hint = scale;
        }
    } else {
        body.min_scale = parseFloat(document.getElementById('solver-min-scale')?.value || '0.5');
        body.max_scale = parseFloat(document.getElementById('solver-max-scale')?.value || '15.0');
    }

    try {
        const result = await fetch('/api/solver/solve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(r => r.json());

        clearInterval(progressInterval);

        if (result.ok) {
            _lastSolverResult = result;
            renderSolverResult(result);
            setOffsetSolved(result.ra, result.dec, result.scale, result.rotation);
        } else {
            if (errorEl) {
                errorEl.style.display = '';
                errorEl.textContent = result.error || 'Échec de la résolution';
            }
            addLog('error', 'solver', result.error || 'Échec');
        }
    } catch (e) {
        clearInterval(progressInterval);
        if (errorEl) {
            errorEl.style.display = '';
            errorEl.textContent = e.message;
        }
        addLog('error', 'solver', e.message);
    } finally {
        if (progress) progress.style.display = 'none';
        if (solveBtn) solveBtn.disabled = false;
    }
}

function renderSolverResult(result) {
    const resultsEl = document.getElementById('solver-results');
    if (resultsEl) resultsEl.style.display = '';

    const raDeg = result.ra;
    const decDeg = result.dec;

    const el = (id, val) => {
        const e = document.getElementById(id);
        if (e) e.textContent = val;
    };

    el('solver-res-ra', decToSexa(raDeg / 15, true));
    el('solver-res-dec', decToSexa(decDeg, false));
    el('solver-res-scale', result.scale.toFixed(2) + ' arcsec/px');
    el('solver-res-rotation', result.rotation.toFixed(1) + '°' + (result.flipped ? ' (mirrored)' : ''));
    el('solver-res-matches', `${result.matches} / ${result.stars_detected} détectées`);
    el('solver-res-rms', result.rms.toFixed(2) + '"');

    // Calculate FoV
    const cam = findCamera();
    if (cam && cam.dev.width_px && cam.dev.height_px) {
        const fovX = (cam.dev.width_px * result.scale / 3600).toFixed(2);
        const fovY = (cam.dev.height_px * result.scale / 3600).toFixed(2);
        el('solver-res-fov', `${fovX}° × ${fovY}°`);
    } else {
        el('solver-res-fov', '--');
    }

    el('solver-res-mode', result.mode === 'hinted' ? 'Indice' : 'Blind');
    el('solver-res-time', result.elapsed_ms < 1000 ? result.elapsed_ms.toFixed(0) + 'ms' : (result.elapsed_ms / 1000).toFixed(1) + 's');

    addLog('info', 'solver', `Résolu: RA=${raDeg.toFixed(4)}° DEC=${decDeg.toFixed(4)}° — ${result.matches} étoiles, RMS=${result.rms.toFixed(2)}"`);
}

function handleSolverWsResult(result) {
    _lastSolverResult = result;
    renderSolverResult(result);
    if (result.ok) {
        setOffsetSolved(result.ra, result.dec, result.scale, result.rotation);
        updateTargetOffset();
    }
    if (_centeringActive) {
        _centeringStep(result);
    }
}

// ── Target centering panel ──────────────────────────────────────

let _nudgeAmount = 1; // arcmin
let _centeringActive = false;
let _centeringMaxSteps = 10;
let _centeringThresholdArcmin = 0.5;

function initTargetPanel() {
    // Set target from inputs
    const setBtn = document.getElementById('target-set-btn');
    if (setBtn) setBtn.addEventListener('click', targetSetFromInputs);

    // GOTO
    const gotoBtn = document.getElementById('target-goto-btn');
    if (gotoBtn) gotoBtn.addEventListener('click', targetGoto);

    // Nudge amount buttons
    document.querySelectorAll('.nudge-amount-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nudge-amount-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _nudgeAmount = parseInt(btn.dataset.nudge) || 1;
        });
    });

    // Nudge direction buttons
    document.querySelectorAll('.nudge-dir-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dra = parseInt(btn.dataset.dra) * _nudgeAmount;
            const ddec = parseInt(btn.dataset.ddec) * _nudgeAmount;
            targetNudge(dra, ddec);
        });
    });

    // Center button
    const centerBtn = document.getElementById('target-center-btn');
    if (centerBtn) centerBtn.addEventListener('click', targetCenterStart);

    // Stop button
    const stopBtn = document.getElementById('target-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', targetCenterStop);

    // Fill RA/DEC from mount position if available
    _targetAutoFillFromMount();
}

function _targetAutoFillFromMount() {
    const m = findMount();
    const raEl = document.getElementById('target-ra');
    const decEl = document.getElementById('target-dec');
    if (m && m.dev.ra_hours != null && raEl && decEl) {
        raEl.value = decToSexa(m.dev.ra_hours, true);
        decEl.value = decToSexa(m.dev.dec_deg, false);
    }
}

function targetSetFromInputs() {
    const raStr = document.getElementById('target-ra')?.value;
    const decStr = document.getElementById('target-dec')?.value;
    if (!raStr || !decStr) return;

    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'target', 'Format invalide. Utilisez HH:MM:SS / ±DD:MM:SS');
        return;
    }

    const raDeg = raH * 15;
    setOffsetTarget(raDeg, decD);
    addLog('info', 'target', `Cible définie: RA=${raDeg.toFixed(4)}° DEC=${decD.toFixed(4)}°`);

    // Update offset display if we already have a solve
    updateTargetOffset();
}

function targetGoto() {
    const raStr = document.getElementById('target-ra')?.value;
    const decStr = document.getElementById('target-dec')?.value;
    if (!raStr || !decStr) return;

    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'target', 'Format invalide');
        return;
    }

    apiPost('/api/mount/slew', { ra_hours: raH, dec_deg: decD });
    addLog('info', 'target', `GOTO RA=${raH.toFixed(4)}h DEC=${decD.toFixed(4)}°`);

    // Also set as offset target
    setOffsetTarget(raH * 15, decD);
}

function targetNudge(draArcmin, ddecArcmin) {
    if (_offsetSolvedRA == null || _offsetSolvedDEC == null) {
        addLog('warning', 'target', 'Pas de résolution — résolvez d\'abord une image');
        return;
    }

    // Convert arcmin delta to RA hours / DEC degrees
    const newRA = _offsetSolvedRA + draArcmin / 60.0;
    const newDEC = _offsetSolvedDEC + ddecArcmin / 60.0;

    apiPost('/api/mount/slew', { ra_hours: newRA / 15, dec_deg: newDEC });
    addLog('info', 'target', `Nudge: ΔRA=${draArcmin > 0 ? '+' : ''}${draArcmin}' ΔDEC=${ddecArcmin > 0 ? '+' : ''}${ddecArcmin}'`);
}

function updateTargetOffset() {
    if (_offsetTargetRA == null || _offsetSolvedRA == null) return;

    const section = document.getElementById('target-offset-section');
    if (section) section.style.display = '';

    const deltaRA = (_offsetTargetRA - _offsetSolvedRA) * 60; // arcmin
    const deltaDEC = (_offsetTargetDEC - _offsetSolvedDEC) * 60; // arcmin
    const dist = Math.sqrt(deltaRA * deltaRA + deltaDEC * deltaDEC);

    const draEl = document.getElementById('target-dra');
    const ddecEl = document.getElementById('target-ddec');
    const distEl = document.getElementById('target-dist');
    const dirEl = document.getElementById('target-dir');

    if (draEl) {
        draEl.textContent = `${deltaRA > 0 ? '+' : ''}${deltaRA.toFixed(1)}'`;
        draEl.style.color = Math.abs(deltaRA) < _centeringThresholdArcmin ? '#00ff88' : '#00ffcc';
    }
    if (ddecEl) {
        ddecEl.textContent = `${deltaDEC > 0 ? '+' : ''}${deltaDEC.toFixed(1)}'`;
        ddecEl.style.color = Math.abs(deltaDEC) < _centeringThresholdArcmin ? '#00ff88' : '#00ffcc';
    }
    if (distEl) {
        distEl.textContent = dist < 10 ? dist.toFixed(1) + "'" : dist.toFixed(0) + "'";
        distEl.style.color = dist < _centeringThresholdArcmin ? '#00ff88' : dist < 5 ? '#ffcc00' : '#ff5577';
    }

    // Direction (compass bearing)
    if (dirEl) {
        const angle = (Math.atan2(deltaRA, deltaDEC) * 180 / Math.PI + 360) % 360;
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        dirEl.textContent = dirs[Math.round(angle / 22.5) % 16];
    }
}

// ── Centering loop ──────────────────────────────────────────────

function targetCenterStart() {
    if (_centeringActive) return;

    if (_offsetTargetRA == null) {
        addLog('error', 'target', 'Définissez d\'abord une cible');
        return;
    }

    _centeringActive = true;
    _centeringStepNum = 0;

    const centerBtn = document.getElementById('target-center-btn');
    const stopBtn = document.getElementById('target-stop-btn');
    const statusSection = document.getElementById('target-center-status');
    if (centerBtn) centerBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    if (statusSection) statusSection.style.display = '';

    addLog('info', 'target', 'Centrage itératif démarré');
    _centeringNextStep();
}

function targetCenterStop() {
    _centeringActive = false;
    const centerBtn = document.getElementById('target-center-btn');
    const stopBtn = document.getElementById('target-stop-btn');
    if (centerBtn) centerBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    addLog('info', 'target', 'Centrage arrêté');
}

let _centeringStepNum = 0;

function _centeringNextStep() {
    if (!_centeringActive) return;

    _centeringStepNum++;
    if (_centeringStepNum > _centeringMaxSteps) {
        addLog('warning', 'target', `Centrage: max ${_centeringMaxSteps} étapes atteint`);
        targetCenterStop();
        return;
    }

    // Update progress
    const fill = document.getElementById('target-center-fill');
    const text = document.getElementById('target-center-text');
    if (fill) fill.style.width = ((_centeringStepNum / _centeringMaxSteps) * 100) + '%';
    if (text) text.textContent = `Étape ${_centeringStepNum}/${_centeringMaxSteps} — résolution...`;

    // Solve last image
    solverSolve('last_image');
}

function _centeringStep(result) {
    if (!_centeringActive) return;

    if (!result || !result.ok) {
        addLog('error', 'target', 'Centrage: échec résolution');
        targetCenterStop();
        return;
    }

    updateTargetOffset();

    // Check if close enough
    if (_offsetTargetRA != null && _offsetSolvedRA != null) {
        const deltaRA = (_offsetTargetRA - _offsetSolvedRA) * 60;
        const deltaDEC = (_offsetTargetDEC - _offsetSolvedDEC) * 60;
        const dist = Math.sqrt(deltaRA * deltaRA + deltaDEC * deltaDEC);

        const text = document.getElementById('target-center-text');
        if (text) text.textContent = `Étape ${_centeringStepNum} — offset ${dist.toFixed(1)}'`;

        if (dist < _centeringThresholdArcmin) {
            addLog('info', 'target', `Centrage terminé: offset ${dist.toFixed(2)}' (< ${_centeringThresholdArcmin}')`);
            targetCenterStop();
            return;
        }

        // Nudge mount toward target
        targetNudge(deltaRA, deltaDEC);

        // Wait for mount to settle then re-solve
        setTimeout(() => {
            if (_centeringActive) _centeringNextStep();
        }, 3000);
    }
}

// ── Polar alignment (3-point method) ────────────────────────────

let _polarSolves = [null, null, null]; // { ra, dec, ha }
let _polarTargets = []; // { ra_hours, dec_deg } for each step
let _polarSiteLat = 43.952;
let _polarMode = 'auto'; // 'auto' | 'manual'
let _polarAutoRunning = false;
let _polarAbortFlag = false;

function _getLstDeg() {
    const now = new Date();
    const jd = (now.getTime() / 86400000) + 2440587.5;
    const t = (jd - 2451545.0) / 36525.0;
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t * t - (t * t * t) / 38710000.0;
    gmst = ((gmst % 360) + 360) % 360;
    const lng = skyEngine ? skyEngine.siteLng : 1.568;
    let lst = (gmst + lng) % 360;
    if (lst < 0) lst += 360;
    return lst;
}

function _polarGetAngleDeg() {
    const el = document.getElementById('polar-angle');
    const val = el ? parseFloat(el.value) : 30;
    return Math.max(5, Math.min(120, val || 30));
}

function _polarComputeTargets() {
    const lst = _getLstDeg();
    const lat = skyEngine ? skyEngine.siteLat : _polarSiteLat;
    const decDeg = 90.0 - lat + 20.0;
    const angleMin = _polarGetAngleDeg();
    const haOffsetDeg = angleMin / 4.0; // 1 min RA = 0.25° HA
    const haOffsets = [0, haOffsetDeg, -haOffsetDeg];
    _polarTargets = haOffsets.map(haOff => {
        const raDeg = ((lst - haOff) % 360 + 360) % 360;
        return { ra_hours: raDeg / 15, dec_deg: decDeg };
    });
    return _polarTargets;
}

function _polarDecToSexa(deg) {
    const sign = deg < 0 ? '-' : '+';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mf = (abs - d) * 60;
    const m = Math.floor(mf);
    const s = Math.floor((mf - m) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${sign}${pad(d)}°${pad(m)}'${pad(s)}"`;
}

function _polarRaToSexa(raDeg) {
    const h = raDeg / 15;
    const hh = Math.floor(h);
    const mf = (h - hh) * 60;
    const mm = Math.floor(mf);
    const ss = Math.floor((mf - mm) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hh)}h${pad(mm)}m${pad(ss)}s`;
}

function initPolarPanel() {
    // Manual capture buttons
    document.querySelectorAll('.polar-capture-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const step = parseInt(btn.dataset.step);
            polarCapture(step);
        });
    });

    // Mode toggle
    document.querySelectorAll('.polar-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _polarMode = btn.dataset.polarMode;
            document.querySelectorAll('.polar-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
            _polarUpdateModeUI();
        });
    });

    // Angle input — recompute targets on change
    const angleEl = document.getElementById('polar-angle');
    if (angleEl) {
        angleEl.addEventListener('change', () => {
            _polarComputeTargets();
            _polarUpdateTargetDisplay();
        });
    }

    // Mount controls
    const trackBtn = document.getElementById('polar-track-btn');
    if (trackBtn) trackBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/mount/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
            addLog('info', 'polar', 'Tracking activé');
        } catch (e) { addLog('error', 'polar', `Tracking: ${e.message}`); }
    });
    const unparkBtn = document.getElementById('polar-unpark-btn');
    if (unparkBtn) unparkBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/mount/unpark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            addLog('info', 'polar', 'Monture déparquée');
        } catch (e) { addLog('error', 'polar', `Unpark: ${e.message}`); }
    });
    const abortBtn = document.getElementById('polar-abort-btn');
    if (abortBtn) abortBtn.addEventListener('click', async () => {
        _polarAbortFlag = true;
        try {
            await fetch('/api/mount/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            addLog('warning', 'polar', 'Arrêt demandé');
        } catch (e) { addLog('error', 'polar', `Abort: ${e.message}`); }
    });

    // Start / Stop auto sequence
    const startBtn = document.getElementById('polar-start-btn');
    if (startBtn) startBtn.addEventListener('click', _polarAutoSequence);
    const stopBtn = document.getElementById('polar-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => { _polarAbortFlag = true; });

    // Recalculate
    const recalcBtn = document.getElementById('polar-recalc-btn');
    if (recalcBtn) recalcBtn.addEventListener('click', polarReset);

    // Reset
    const resetBtn = document.getElementById('polar-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', polarReset);

    // Compute initial targets
    _polarComputeTargets();
    _polarUpdateTargetDisplay();
    _polarUpdateModeUI();
}

function _polarUpdateModeUI() {
    const isManual = _polarMode === 'manual';
    document.querySelectorAll('.polar-manual-only').forEach(el => {
        el.style.display = isManual ? '' : 'none';
    });
    const startBtn = document.getElementById('polar-start-btn');
    if (startBtn) startBtn.style.display = isManual ? 'none' : '';
}

function _polarUpdateTargetDisplay() {
    const angleMin = _polarGetAngleDeg();
    const formatAngle = (m) => {
        if (m >= 60) return `${(m/60).toFixed(1)}h`;
        return `${m}min`;
    };
    // Update step labels
    const label1 = document.getElementById('polar-step1-label');
    const label2 = document.getElementById('polar-step2-label');
    const label3 = document.getElementById('polar-step3-label');
    if (label1) label1.textContent = 'Centre (0h)';
    if (label2) label2.textContent = `+${formatAngle(angleMin)} Est`;
    if (label3) label3.textContent = `-${formatAngle(angleMin)} Ouest`;

    // Update DEC target
    const decEl = document.getElementById('polar-dec-target');
    if (decEl && _polarTargets.length) {
        decEl.textContent = _polarDecToSexa(_polarTargets[0].dec_deg);
    }

    // Update target RA/DEC for each step
    for (let i = 0; i < 3; i++) {
        const t = _polarTargets[i];
        if (!t) continue;
        const raEl = document.getElementById(`polar-s${i+1}-ra`);
        const decEl = document.getElementById(`polar-s${i+1}-dec`);
        if (raEl) raEl.textContent = _polarRaToSexa(t.ra_hours * 15);
        if (decEl) decEl.textContent = _polarDecToSexa(t.dec_deg);
    }
}

async function _polarAutoSequence() {
    if (_polarAutoRunning) return;
    _polarAutoRunning = true;
    _polarAbortFlag = false;

    const startBtn = document.getElementById('polar-start-btn');
    const stopBtn = document.getElementById('polar-stop-btn');
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';

    const progressSection = document.getElementById('polar-progress');
    const progressFill = document.getElementById('polar-progress-fill');
    const progressText = document.getElementById('polar-progress-text');
    if (progressSection) progressSection.style.display = '';

    // Reset any previous solves
    polarReset();
    _polarAutoRunning = true;

    const steps = [
        'GOTO position centrale',
        'Capture + résolution #1',
        'GOTO position Est',
        'Capture + résolution #2',
        'GOTO position Ouest',
        'Capture + résolution #3',
    ];
    const totalSteps = steps.length;

    try {
        // Ensure tracking is on
        addLog('info', 'polar', 'Séquence auto: activation tracking...');
        await fetch('/api/mount/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });

        for (let i = 0; i < 3; i++) {
            if (_polarAbortFlag) break;

            // Progress: GOTO step
            const gotoIdx = i * 2;
            if (progressFill) progressFill.style.width = `${(gotoIdx / totalSteps) * 100}%`;
            if (progressText) progressText.textContent = steps[gotoIdx];

            await polarCapture(i);
            if (_polarAbortFlag) break;

            // Progress: solve step
            const solveIdx = i * 2 + 1;
            if (progressFill) progressFill.style.width = `${(solveIdx / totalSteps) * 100}%`;
            if (progressText) progressText.textContent = steps[solveIdx];

            if (!_polarSolves[i]) {
                if (progressText) progressText.textContent = `Étape ${i+1} échouée — séquence interrompue`;
                break;
            }
        }

        if (!_polarAbortFlag && _polarSolves.every(s => s !== null)) {
            if (progressFill) progressFill.style.width = '100%';
            if (progressText) progressText.textContent = 'Terminé — calcul en cours...';
            polarCompute();
            if (progressText) progressText.textContent = 'Terminé ✓';
        } else if (_polarAbortFlag) {
            if (progressText) progressText.textContent = 'Arrêté par l\'utilisateur';
        }
    } catch (e) {
        addLog('error', 'polar', `Séquence auto: ${e.message}`);
        if (progressText) progressText.textContent = `Erreur: ${e.message}`;
    }

    _polarAutoRunning = false;
    if (startBtn) startBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
}

async function polarCapture(step) {
    if (step < 0 || step > 2) return;
    const target = _polarTargets[step];
    if (!target) return;

    const statusEl = document.getElementById(`polar-step${step+1}-status`);
    const stepEl = document.getElementById(`polar-step${step+1}`);
    if (statusEl) statusEl.textContent = '⟳';
    if (stepEl) { stepEl.classList.add('polar-step-active'); stepEl.classList.remove('polar-step-done'); }

    // Slew to target
    addLog('info', 'polar', `Étape ${step+1}/3: GOTO RA=${target.ra_hours.toFixed(4)}h DEC=${target.dec_deg.toFixed(4)}°`);
    apiPost('/api/mount/slew', { ra_hours: target.ra_hours, dec_deg: target.dec_deg });

    // Wait for mount to settle (poll position)
    const settled = await _polarWaitSettle(30000);
    if (!settled) {
        if (statusEl) statusEl.textContent = '✕';
        if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
        addLog('error', 'polar', `Étape ${step+1}: monture n'a pas atteint la position`);
        return;
    }

    // Solve
    addLog('info', 'polar', `Étape ${step+1}/3: résolution en cours...`);
    try {
        const result = await fetch('/api/solver/solve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'last_image' }),
        }).then(r => r.json());

        if (result.ok) {
            const lst = _getLstDeg();
            const haDeg = (lst - result.ra + 360) % 360;
            _polarSolves[step] = { ra: result.ra, dec: result.dec, ha: haDeg };
            if (statusEl) statusEl.textContent = '✓';
            if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-done'); }
            addLog('info', 'polar', `Étape ${step+1}/3: RA=${result.ra.toFixed(4)}° DEC=${result.dec.toFixed(4)}° (${result.matches} étoiles)`);

            // Check if all 3 done
            if (_polarSolves.every(s => s !== null)) {
                polarCompute();
            }
        } else {
            if (statusEl) statusEl.textContent = '✕';
            if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
            addLog('error', 'polar', `Étape ${step+1}: ${result.error || 'échec résolution'}`);
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = '✕';
        if (stepEl) { stepEl.classList.remove('polar-step-active'); stepEl.classList.add('polar-step-fail'); }
        addLog('error', 'polar', `Étape ${step+1}: ${e.message}`);
    }
}

function _polarWaitSettle(timeoutMs) {
    return new Promise(resolve => {
        const start = Date.now();
        let lastRA = null, stableCount = 0;
        const poll = setInterval(async () => {
            try {
                const resp = await fetch('/api/mount');
                const data = await resp.json();
                const ra = data.ra_hours;
                if (lastRA !== null && Math.abs(ra - lastRA) < 0.001) {
                    stableCount++;
                } else {
                    stableCount = 0;
                }
                lastRA = ra;
                if (stableCount >= 3) {
                    clearInterval(poll);
                    resolve(true);
                }
            } catch (e) { /* retry */ }
            if (Date.now() - start > timeoutMs) {
                clearInterval(poll);
                resolve(false);
            }
        }, 500);
    });
}

function polarCompute() {
    // Convert solved positions to unit vectors
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const vecs = _polarSolves.map(s => {
        const ra = toRad(s.ra);
        const dec = toRad(s.dec);
        return [
            Math.cos(dec) * Math.cos(ra),
            Math.cos(dec) * Math.sin(ra),
            Math.sin(dec)
        ];
    });

    // Center of circumscribed circle on sphere
    // = normalize((u1-u2) × (u1-u3))
    const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const cross = (a, b) => [
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0]
    ];
    const norm = v => Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    const normalize = v => { const n = norm(v); return [v[0]/n, v[1]/n, v[2]/n]; };

    let pole = normalize(cross(sub(vecs[0], vecs[1]), sub(vecs[0], vecs[2])));

    // Ensure pole points to the correct hemisphere
    if (pole[2] < 0) pole = pole.map(v => -v);

    // Convert pole back to RA/DEC
    const poleRA = ((toDeg(Math.atan2(pole[1], pole[0])) % 360) + 360) % 360;
    const poleDEC = toDeg(Math.asin(pole[2]));

    // Error from true pole (DEC=+90°)
    const errDec = 90.0 - poleDEC; // positive = pole too low (altitude error)
    // Azimuth error: project offset onto E-W direction at the pole
    // For northern hemisphere: E-W direction at the pole is along RA
    const lat = skyEngine ? skyEngine.siteLat : _polarSiteLat;
    const errAz = errDec * Math.sin(toRad(poleRA)) * Math.cos(toRad(lat));

    // Alternative: use the hour angle of the pole to determine E-W offset
    const lst = _getLstDeg();
    const poleHA = ((lst - poleRA) % 360 + 360) % 360;
    // For small errors, azimuth correction ≈ errDec * sin(HA) * cos(lat)
    // But a simpler approach: the offset direction on the sky
    const errAzSimple = (90 - poleDEC) * Math.cos(toRad(poleRA - 0)); // rough E-W component

    // Total error in arcmin
    const errTotal = Math.sqrt(errDec * errDec + errAz * errAz) * 60;

    // Display
    const errAltEl = document.getElementById('polar-err-alt');
    const errAzEl = document.getElementById('polar-err-az');
    const errTotalEl = document.getElementById('polar-err-total');
    const poleRAEl = document.getElementById('polar-pole-ra');
    const poleDecEl = document.getElementById('polar-pole-dec');
    const arrowAlt = document.getElementById('polar-arrow-alt');
    const arrowAz = document.getElementById('polar-arrow-az');
    const resultsEl = document.getElementById('polar-results');

    if (resultsEl) resultsEl.style.display = '';
    if (errAltEl) {
        const sign = errDec > 0 ? '↑' : '↓';
        errAltEl.textContent = `${errDec > 0 ? '+' : ''}${(errDec * 60).toFixed(1)}'`;
        errAltEl.style.color = Math.abs(errDec * 60) < 2 ? '#00ff88' : '#ffcc00';
    }
    if (arrowAlt) arrowAlt.textContent = errDec > 0 ? '↑ trop bas' : '↓ trop haut';
    if (errAzEl) {
        errAzEl.textContent = `${errAz > 0 ? '+' : ''}${(errAz * 60).toFixed(1)}'`;
        errAzEl.style.color = Math.abs(errAz * 60) < 2 ? '#00ff88' : '#ffcc00';
    }
    if (arrowAz) arrowAz.textContent = errAz > 0 ? '→ droite' : '← gauche';
    if (errTotalEl) {
        errTotalEl.textContent = `${errTotal.toFixed(1)}'`;
        errTotalEl.style.color = errTotal < 2 ? '#00ff88' : errTotal < 10 ? '#ffcc00' : '#ff5577';
    }
    if (poleRAEl) poleRAEl.textContent = _polarRaToSexa(poleRA);
    if (poleDecEl) poleDecEl.textContent = _polarDecToSexa(poleDEC);

    // Draw correction diagram
    _polarDrawDiagram(errDec * 60, errAz * 60);

    addLog('info', 'polar', `Pôle trouvé: RA=${poleRA.toFixed(4)}° DEC=${poleDEC.toFixed(4)}° — erreur totale: ${errTotal.toFixed(1)}'`);
}

function _polarDrawDiagram(errAltArcmin, errAzArcmin) {
    const canvas = document.getElementById('polar-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    // Scale: 1 arcmin = 2px, max ±60' → ±120px
    const scale = 2;
    const maxErr = Math.max(Math.abs(errAltArcmin), Math.abs(errAzArcmin), 10);

    // Draw crosshairs (true pole)
    ctx.strokeStyle = 'rgba(0,255,204,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // True pole label
    ctx.fillStyle = 'rgba(0,255,204,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Pôle true', cx, 10);

    // Draw found pole offset
    // errAltArcmin: positive = pole too low (south)
    // errAzArcmin: positive = pole too far east
    const dx = errAzArcmin * scale; // E-W
    const dy = -errAltArcmin * scale; // N-S (canvas Y inverted)

    const poleX = cx + dx;
    const poleY = cy + dy;

    // Line from true to found
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(poleX, poleY);
    ctx.stroke();

    // Arrow head
    const angle = Math.atan2(poleY - cy, poleX - cx);
    const arrowLen = 10;
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.moveTo(poleX, poleY);
    ctx.lineTo(poleX - arrowLen * Math.cos(angle - 0.4), poleY - arrowLen * Math.sin(angle - 0.4));
    ctx.lineTo(poleX - arrowLen * Math.cos(angle + 0.4), poleY - arrowLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();

    // Found pole dot
    ctx.fillStyle = '#ff5577';
    ctx.beginPath();
    ctx.arc(poleX, poleY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Correction arrows (what the user should do)
    // To correct: move pole UP by errAlt, move pole LEFT by errAz
    const corrAlt = -errAltArcmin * scale; // correction direction
    const corrAz = -errAzArcmin * scale;

    if (Math.abs(corrAlt) > 3) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(poleX, poleY);
        ctx.lineTo(poleX, poleY + corrAlt);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#00ff88';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('↑ Alt', poleX + 6, poleY + corrAlt / 2);
    }
    if (Math.abs(corrAz) > 3) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(poleX, poleY);
        ctx.lineTo(poleX + corrAz, poleY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#00ff88';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Az →', poleX + corrAz / 2, poleY - 8);
    }

    // Scale bar
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(30)}'`, 4, h - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, h - 14);
    ctx.lineTo(4 + 30 * scale, h - 14);
    ctx.stroke();
}

function polarReset() {
    _polarSolves = [null, null, null];
    _polarAbortFlag = false;
    for (let i = 1; i <= 3; i++) {
        const statusEl = document.getElementById(`polar-step${i}-status`);
        const stepEl = document.getElementById(`polar-step${i}`);
        if (statusEl) statusEl.textContent = '◻';
        if (stepEl) {
            stepEl.classList.remove('polar-step-done', 'polar-step-active', 'polar-step-fail');
        }
    }
    const resultsEl = document.getElementById('polar-results');
    if (resultsEl) resultsEl.style.display = 'none';
    const progressSection = document.getElementById('polar-progress');
    const progressFill = document.getElementById('polar-progress-fill');
    const progressText = document.getElementById('polar-progress-text');
    if (progressSection) progressSection.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'Prêt';
    _polarComputeTargets();
    _polarUpdateTargetDisplay();
    addLog('info', 'polar', 'Reset — prêt pour une nouvelle séquence');
}

// ── Focuser panel ─────────────────────────────────────────────

const _focHistory = [];
let _focHistoryTimer = null;
const _focHfrData = [];    // [{step, position, hfr, fwhm, timestamp}]
let _focHfrStep = 0;

let _selectedFocCamera = '';
let _focCameraSelect = null;

// Autofocus state
let _afStartBtn = null, _afStopBtn = null;
let _afProgressBar = null, _afProgressText = null, _afStatusText = null;
let _afProgressWrap = null, _afResult = null;
let _afBestPos = null, _afBestHfr = null;
let _afVcurveCanvas = null;
let _afRunning = false;
let _afPositions = [];
let _afResults = [];
let _afIndex = 0;
let _afTimer = null;
let _afExposureSec = 1.0;

// Guide state
let _guideRunning = false;
let _guideTimer = null;
let _guideDriftHistory = [];
let _guideDriftCanvas = null;
let _guideStartBtn = null, _guideStopBtn = null, _guidePauseBtn = null;
let _guideFrameCountEl = null, _guideDriftRAEl = null, _guideDriftDECEl = null;
let _guideCorrRAEl = null, _guideCorrDECEl = null;
let _guideCameraSelect = null;

function findFocuser() {
    for (const [name, dev] of Object.entries(devices)) {
        if (dev.type === 'focuser') return { name, dev };
    }
    return null;
}

function renderFocuserPanel() {
    const f = findFocuser();
    const posEl = document.getElementById('foc-pos-current');
    const tgtEl = document.getElementById('foc-pos-target');
    const dotEl = document.getElementById('foc-moving-dot');
    const barEl = document.getElementById('foc-pos-bar');
    const speedEl = document.getElementById('foc-speed-input');
    if (!posEl) return;

    if (!f) {
        posEl.textContent = '—';
        tgtEl.textContent = '—';
        dotEl.textContent = '●';
        dotEl.className = 'foc-idle';
        if (barEl) barEl.style.width = '0%';
        return;
    }

    posEl.textContent = f.dev.position ?? '—';
    tgtEl.textContent = f.dev.target_position ?? '—';
    if (f.dev.is_moving) {
        dotEl.textContent = '●';
        dotEl.className = 'foc-moving';
    } else {
        dotEl.textContent = '●';
        dotEl.className = 'foc-idle';
    }

    // Position bar (relative to target if known, else static)
    if (barEl) {
        if (f.dev.target_position != null && f.dev.position != null) {
            const min = Math.min(f.dev.position, f.dev.target_position);
            const max = Math.max(f.dev.position, f.dev.target_position);
            const range = max - min || 1;
            const pct = Math.abs(f.dev.position - f.dev.target_position) / range * 100;
            barEl.style.width = (f.dev.is_moving ? pct : 0) + '%';
            barEl.style.background = f.dev.is_moving ? '#00ffcc' : 'rgba(0,255,204,0.3)';
        } else {
            barEl.style.width = '0%';
        }
    }

    // Sync speed input (only if not focused)
    if (speedEl && document.activeElement !== speedEl && f.dev.speed != null) {
        speedEl.value = f.dev.speed;
    }

    _focHistory.push(f.dev.position ?? 0);
    if (_focHistory.length > 100) _focHistory.shift();
    _focDrawHistory();
}

function _focDrawHistory() {
    const canvas = document.getElementById('foc-history-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (_focHistory.length < 2) return;

    const min = Math.min(..._focHistory);
    const max = Math.max(..._focHistory);
    const range = max - min || 1;
    const step = w / (_focHistory.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,255,204,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < _focHistory.length; i++) {
        const x = i * step;
        const y = h - 4 - ((_focHistory[i] - min) / range) * (h - 8);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function _focDrawHfrChart() {
    const canvas = document.getElementById('foc-hfr-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const countEl = document.getElementById('foc-hfr-count');
    const bestEl = document.getElementById('foc-hfr-best');
    if (countEl) countEl.textContent = _focHfrData.length;

    if (_focHfrData.length === 0) {
        if (bestEl) bestEl.textContent = '—';
        return;
    }

    const hfrs = _focHfrData.map(d => d.hfr);
    const min = Math.min(...hfrs);
    const max = Math.max(...hfrs);
    const range = max - min || 1;
    const pad = 20;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;
    const bestIdx = hfrs.indexOf(min);

    if (bestEl) bestEl.textContent = min.toFixed(1) + 'px';

    // Y axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(max.toFixed(1), pad - 3, pad + 4);
    ctx.fillText(min.toFixed(1), pad - 3, h - pad + 4);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(w - pad, y);
        ctx.stroke();
    }

    // Data line
    if (_focHfrData.length >= 2) {
        const xStep = plotW / (_focHfrData.length - 1);
        ctx.beginPath();
        ctx.strokeStyle = '#00ffcc';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < _focHfrData.length; i++) {
            const x = pad + i * xStep;
            const y = pad + plotH - ((hfrs[i] - min) / range) * plotH;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Data points + best marker
    const xStep = _focHfrData.length > 1 ? plotW / (_focHfrData.length - 1) : 0;
    for (let i = 0; i < _focHfrData.length; i++) {
        const x = pad + i * xStep;
        const y = pad + plotH - ((hfrs[i] - min) / range) * plotH;

        if (i === bestIdx) {
            // Best point: filled cyan diamond
            ctx.fillStyle = '#00ffcc';
            ctx.beginPath();
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x + 5, y);
            ctx.lineTo(x, y + 5);
            ctx.lineTo(x - 5, y);
            ctx.closePath();
            ctx.fill();
        } else {
            // Normal point: small dot
            ctx.fillStyle = 'rgba(0,255,204,0.6)';
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Position labels on X axis (show first and last)
    ctx.fillStyle = '#666';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    if (_focHfrData.length > 0) {
        ctx.fillText('pos:' + _focHfrData[0].position, pad, h - 2);
        if (_focHfrData.length > 1) {
            ctx.textAlign = 'right';
            ctx.fillText('pos:' + _focHfrData[_focHfrData.length - 1].position, w - pad, h - 2);
        }
    }
}

// ── Camera selector for focuser ─────────────────────────────

function _refreshCameraList() {
    fetch('/api/cameras').then(r => r.json()).then(cameras => {
        if (!_focCameraSelect) return;
        const prev = _focCameraSelect.value;
        _focCameraSelect.innerHTML = '<option value="">— aucune —</option>';
        for (const c of cameras) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name + (c.connected ? '' : ' (déco)');
            _focCameraSelect.appendChild(opt);
        }
        if (prev && [..._focCameraSelect.options].some(o => o.value === prev)) {
            _focCameraSelect.value = prev;
        }
    }).catch(() => {});
}

function _getSelectedCamera() {
    return _selectedFocCamera || '';
}

// ── Autofocus sequence ──────────────────────────────────────

async function _autofocusStart() {
    if (_afRunning) return;
    const f = findFocuser();
    if (!f) { addLog('error', 'autofocus', 'Aucun focuser trouvé'); return; }

    const range = parseInt(document.getElementById('af-range')?.value || '2000');
    const points = parseInt(document.getElementById('af-points')?.value || '25');
    const center = f.dev.position ?? 0;

    _afRunning = true;
    _afResults = [];
    _afIndex = 0;
    _afPositions = [];
    const currHfrEl = document.getElementById('af-curr-hfr');
    if (currHfrEl) currHfrEl.textContent = 'HFR: —';
    const currPosEl = document.getElementById('af-curr-pos');
    if (currPosEl) currPosEl.textContent = 'Pos: —';
    if (_afStartBtn) _afStartBtn.disabled = true;
    if (_afStopBtn) _afStopBtn.disabled = false;
    if (_afProgressWrap) _afProgressWrap.style.display = '';
    if (_afResult) _afResult.style.display = 'none';

    // Start autofocus on server
    const res = await fetch('/api/focuser/autofocus/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ center, range, points })
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'autofocus', res?.error || 'Échec démarrage');
        _autofocusCleanup();
        return;
    }
    _afPositions = res.positions || [];
    _afExposureSec = 1.0;
    addLog('info', 'autofocus', `V-curve: ${_afPositions.length} points, centre=${center}, plage=±${range}`);
    _autofocusStep();
}

async function _autofocusStep() {
    if (!_afRunning || _afIndex >= _afPositions.length) {
        _autofocusFinish();
        return;
    }
    const pos = _afPositions[_afIndex];
    const total = _afPositions.length;

    if (_afProgressText) _afProgressText.textContent = `${_afIndex + 1}/${total}`;
    if (_afProgressBar) _afProgressBar.style.width = `${((_afIndex) / total) * 100}%`;
    if (_afStatusText) _afStatusText.textContent = `→ ${pos}`;
    _autofocusDrawVcurve();

    // Move focuser
    await fetch('/api/focuser/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos })
    }).then(r => r.json()).catch(() => {});

    // Wait for focuser to arrive
    const arrived = await _autofocusWaitFocuser(pos, 15000);
    if (!arrived) { _autofocusAbort('Focuser non arrivé à ' + pos); return; }

    // Expose (short exposure)
    if (_afStatusText) _afStatusText.textContent = `Expose ${pos}`;
    await fetch('/api/camera/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: _getSelectedCamera(), duration: _afExposureSec })
    }).then(r => r.json()).catch(() => {});

    // Wait for image
    const imgReady = await _autofocusWaitImage(30000);
    if (!imgReady) { _autofocusAbort('Pas d\'image reçue'); return; }

    // Measure HFR
    if (_afStatusText) _afStatusText.textContent = `Mesure ${pos}`;
    const metric = await fetch('/api/focuser/focus-metric' + (_getSelectedCamera() ? `?device=${encodeURIComponent(_getSelectedCamera())}` : ''))
        .then(r => r.json()).catch(() => null);

    if (!metric?.ok) { _autofocusAbort('Focus metric failed'); return; }

    // Record step
    await fetch('/api/focuser/autofocus/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos, hfr: metric.hfr, fwhm: metric.fwhm })
    }).then(r => r.json()).catch(() => {});

    _afResults.push({ position: pos, hfr: metric.hfr, fwhm: metric.fwhm });
    _autofocusDrawVcurve();
    _afIndex++;

    // Update info line with current HFR and position
    const currHfrEl = document.getElementById('af-curr-hfr');
    if (currHfrEl) {
        const bestMin = _afResults.reduce((m, r) => r.hfr < m.hfr ? r : m, _afResults[0]);
        currHfrEl.textContent = `HFR: ${metric.hfr.toFixed(2)} → meilleur: ${bestMin.hfr.toFixed(2)}`;
    }
    const currPosEl = document.getElementById('af-curr-pos');
    if (currPosEl) currPosEl.textContent = `Pos: ${pos}`;

    // Also record in HFR history
    _focHfrData.push({
        step: _focHfrStep++,
        position: pos,
        hfr: metric.hfr,
        fwhm: metric.fwhm,
        timestamp: Date.now()
    });
    if (_focHfrData.length > 200) _focHfrData.shift();
    _focDrawHfrChart();

    // Next step
    setTimeout(() => _autofocusStep(), 100);
}

async function _autofocusWaitFocuser(targetPos, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const f = findFocuser();
        if (f && !f.dev.is_moving) return true;
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

function _autofocusWaitImage(timeoutMs) {
    const camName = _getSelectedCamera();
    const t0 = Date.now();
    return new Promise(resolve => {
        const check = () => {
            if (!_afRunning) { resolve(false); return; }
            const elapsed = Date.now() - t0;
            if (elapsed > timeoutMs) { resolve(false); return; }
            const cam = devices[camName];
            if (cam && cam.exposure_time != null && cam.exposure_time <= 0) {
                resolve(true);
                return;
            }
            setTimeout(check, 200);
        };
        setTimeout(check, 200);
    });
}

async function _autofocusFinish() {
    if (_afStatusText) _afStatusText.textContent = 'Analyse...';
    const res = await fetch('/api/focuser/autofocus/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()).catch(() => null);

    if (res?.ok) {
        if (_afBestPos) _afBestPos.textContent = res.best_position;
        if (_afBestHfr) _afBestHfr.textContent = res.best_hfr ? res.best_hfr.toFixed(2) : '—';
        if (_afResult) _afResult.style.display = '';
        if (_afProgressBar) _afProgressBar.style.width = '100%';
        addLog('info', 'autofocus', `Meilleur point: pos=${res.best_position}, HFR=${res.best_hfr ? res.best_hfr.toFixed(2) : '—'}`);

        // Move focuser to best position
        if (res.best_position != null) {
            if (_afStatusText) _afStatusText.textContent = `→ meilleur: ${res.best_position}`;
            await fetch('/api/focuser/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position: res.best_position })
            }).then(r => r.json()).catch(() => {});
            await _autofocusWaitFocuser(res.best_position, 30000);

            // Verification capture
            if (_afStatusText) _afStatusText.textContent = 'Vérification...';
            await fetch('/api/camera/expose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: _getSelectedCamera(), duration: _afExposureSec })
            }).then(r => r.json()).catch(() => {});
            await _autofocusWaitImage(30000);
        }
    } else {
        addLog('error', 'autofocus', res?.error || 'Analyse V-curve échouée');
    }
    _autofocusDrawVcurve();
    if (_afStatusText) _afStatusText.textContent = '✅ Terminé';
    _autofocusCleanup();
}

function _autofocusAbort(msg) {
    addLog('error', 'autofocus', msg);
    fetch('/api/focuser/autofocus/stop', { method: 'POST' }).catch(() => {});
    _autofocusCleanup();
}

async function _autofocusStop() {
    if (!_afRunning) return;
    _afRunning = false;
    if (_afTimer) { clearTimeout(_afTimer); _afTimer = null; }
    await fetch('/api/focuser/autofocus/stop', { method: 'POST' }).catch(() => {});
    addLog('warning', 'autofocus', 'Arrêté par l\'utilisateur');
    _autofocusCleanup();
}

function _autofocusCleanup() {
    _afRunning = false;
    if (_afStartBtn) _afStartBtn.disabled = false;
    if (_afStopBtn) _afStopBtn.disabled = true;
}

function _autofocusDrawVcurve() {
    const canvas = _afVcurveCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (_afResults.length < 2) {
        ctx.fillStyle = '#555';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('En attente de données...', w / 2, h / 2);
        return;
    }

    const pad = 30;
    const positions = _afResults.map(r => r.position);
    const hfrs = _afResults.map(r => r.hfr);
    const minPos = Math.min(...positions), maxPos = Math.max(...positions);
    const minHfr = Math.min(...hfrs), maxHfr = Math.max(...hfrs);
    const posRange = maxPos - minPos || 1;
    const hfrRange = (maxHfr - minHfr) || 1;

    // Grid
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (h - 2 * pad) * (i / 4);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    // Data points
    ctx.strokeStyle = '#00ccff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < _afResults.length; i++) {
        const x = pad + ((positions[i] - minPos) / posRange) * (w - 2 * pad);
        const y = pad + ((hfrs[i] - minHfr) / hfrRange) * (h - 2 * pad);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Dots
    for (let i = 0; i < _afResults.length; i++) {
        const x = pad + ((positions[i] - minPos) / posRange) * (w - 2 * pad);
        const y = pad + ((hfrs[i] - minHfr) / hfrRange) * (h - 2 * pad);
        ctx.fillStyle = '#00ffcc';
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }

    // Best point
    if (_afResults.length >= 3) {
        let bestI = 0;
        for (let i = 1; i < _afResults.length; i++) {
            if (_afResults[i].hfr < _afResults[bestI].hfr) bestI = i;
        }
        const bx = pad + ((positions[bestI] - minPos) / posRange) * (w - 2 * pad);
        const by = pad + ((hfrs[bestI] - minHfr) / hfrRange) * (h - 2 * pad);
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ff4444';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(positions[bestI], bx, by - 10);
    }

    // Axis labels
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${minPos}`, pad, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${maxPos}`, w - pad, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(minHfr.toFixed(1), pad - 4, pad + 4);
    ctx.fillText(maxHfr.toFixed(1), pad - 4, h - pad + 4);
}

function initFocuserPanel() {
    document.querySelectorAll('.foc-rel').forEach(btn => {
        btn.addEventListener('click', () => {
            const steps = parseInt(btn.dataset.steps);
            const dir = steps > 0 ? 'OUT' : 'IN';
            apiPost('/api/focuser/move_relative', { direction: dir, steps: Math.abs(steps) });
        });
    });

    const goBtn = document.getElementById('foc-abs-go');
    if (goBtn) {
        goBtn.addEventListener('click', () => {
            const input = document.getElementById('foc-abs-input');
            const pos = parseInt(input?.value);
            if (!isNaN(pos)) {
                apiPost('/api/focuser/move', { position: pos });
                input.value = '';
            }
        });
    }

    const absInput = document.getElementById('foc-abs-input');
    if (absInput) {
        absInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                goBtn?.click();
            }
        });
    }

    const haltBtn = document.getElementById('foc-halt-btn');
    if (haltBtn) {
        haltBtn.addEventListener('click', () => {
            apiPost('/api/focuser/halt');
        });
    }

    // Speed control
    const speedSet = document.getElementById('foc-speed-set');
    const speedInput = document.getElementById('foc-speed-input');
    if (speedSet && speedInput) {
        const sendSpeed = () => {
            const val = parseInt(speedInput.value);
            if (!isNaN(val) && val > 0) apiPost('/api/focuser/speed', { speed: val });
        };
        speedSet.addEventListener('click', sendSpeed);
        speedInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); sendSpeed(); }
        });
    }

    // HFR chart reset
    const hfrReset = document.getElementById('foc-hfr-reset');
    if (hfrReset) {
        hfrReset.addEventListener('click', () => {
            _focHfrData.length = 0;
            _focHfrStep = 0;
            _focDrawHfrChart();
            clearFocusOverlay();
        });
    }

    // Camera selector for focuser mode
    _focCameraSelect = document.getElementById('foc-camera-select');
    if (_focCameraSelect) {
        _refreshCameraList();
        _focCameraSelect.addEventListener('change', () => {
            _selectedFocCamera = _focCameraSelect.value;
            addLog('info', 'focuser', `Caméra: ${_selectedFocCamera || 'aucune'}`);
        });
    }

    // Autofocus wiring
    _afStartBtn = document.getElementById('af-start');
    _afStopBtn = document.getElementById('af-stop');
    _afProgressBar = document.getElementById('af-progress-bar');
    _afProgressText = document.getElementById('af-progress-text');
    _afStatusText = document.getElementById('af-status-text');
    _afProgressWrap = document.getElementById('af-progress-wrap');
    _afResult = document.getElementById('af-result');
    _afBestPos = document.getElementById('af-best-pos');
    _afBestHfr = document.getElementById('af-best-hfr');
    _afVcurveCanvas = document.getElementById('af-vcurve-canvas');

    if (_afStartBtn) {
        _afStartBtn.addEventListener('click', _autofocusStart);
    }
    if (_afStopBtn) {
        _afStopBtn.addEventListener('click', _autofocusStop);
    }
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
        addLog('warning', 'sky', 'Config site non disponible');
    }

    skyEngine = new SkyEngine(container, { siteLat, siteLng, siteElev });
    skyEngine.init();
    skyEngine.setupContextMenu();

    try {
        await skyEngine.loadCatalogs();
        addLog('info', 'sky', 'Carte céleste initialisée');
    } catch (e) {
        addLog('error', 'sky', 'Erreur chargement données: ' + e.message);
    }

    try {
        await loadObjectCatalogs();
    } catch (e) {
        addLog('warning', 'sky', 'Erreur catalogues: ' + e.message);
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

// ── Guide (autoguidage) ─────────────────────────────────────

function initGuidePanel() {
    _guideDriftCanvas = document.getElementById('guide-drift-canvas');
    _guideStartBtn = document.getElementById('guide-start-btn');
    _guideStopBtn = document.getElementById('guide-stop-btn');
    _guidePauseBtn = document.getElementById('guide-pause-btn');
    _guideFrameCountEl = document.getElementById('guide-frame-count');
    _guideDriftRAEl = document.getElementById('guide-drift-ra');
    _guideDriftDECEl = document.getElementById('guide-drift-dec');
    _guideCorrRAEl = document.getElementById('guide-corr-ra');
    _guideCorrDECEl = document.getElementById('guide-corr-dec');
    _guideCameraSelect = document.getElementById('guide-camera-select');

    if (_guideCameraSelect) {
        _refreshGuideCameraList();
    }

    const aggrSlider = document.getElementById('guide-aggressiveness');
    const aggrVal = document.getElementById('guide-aggr-val');
    if (aggrSlider && aggrVal) {
        aggrSlider.addEventListener('input', () => {
            aggrVal.textContent = aggrSlider.value;
        });
    }

    if (_guideStartBtn) _guideStartBtn.addEventListener('click', _guideStart);
    if (_guideStopBtn) _guideStopBtn.addEventListener('click', _guideStop);
    if (_guidePauseBtn) _guidePauseBtn.addEventListener('click', _guidePause);

    const resetBtn = document.getElementById('guide-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', _guideReset);

    // Guide camera binning
    const guideBin = document.getElementById('guide-binning');
    if (guideBin) {
        guideBin.addEventListener('change', () => {
            const v = parseInt(guideBin.value);
            const cam = _guideCameraSelect?.value;
            if (!cam) return;
            apiPost('/api/property', {
                device: cam,
                property: 'CCD_BINNING',
                items: [{ name: 'HOR_BIN', value: v }, { name: 'VER_BIN', value: v }]
            });
        });
    }

    // Capture button
    const captureBtn = document.getElementById('guide-capture-btn');
    if (captureBtn) captureBtn.addEventListener('click', _guidePreviewCaptureHandler);

    // Auto-select button
    const autoBtn = document.getElementById('guide-autoselect-btn');
    if (autoBtn) autoBtn.addEventListener('click', _guideAutoSelect);

    // Zoom controls for guide preview
    _initGuidePreviewZoom();


}

function _refreshGuideCameraList() {
    fetch('/api/cameras').then(r => r.json()).then(cameras => {
        if (!_guideCameraSelect) return;
        const prev = _guideCameraSelect.value;
        _guideCameraSelect.innerHTML = '<option value="">— aucune —</option>';
        for (const c of cameras) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name + (c.connected ? '' : ' (déco)');
            _guideCameraSelect.appendChild(opt);
        }
        if (prev && [..._guideCameraSelect.options].some(o => o.value === prev)) {
            _guideCameraSelect.value = prev;
        }
    }).catch(() => {});
}

function _guideApplyPreviewTransform() {
    const viewport = document.getElementById('guide-preview-viewport');
    if (!viewport) return;
    const canvas = document.getElementById('guide-preview-canvas');
    const overlay = document.getElementById('guide-preview-overlay');
    const t = `translate(${_guidePreviewPanX}px, ${_guidePreviewPanY}px) scale(${_guidePreviewZoom})`;
    if (canvas) canvas.style.transform = t;
    if (overlay) overlay.style.transform = t;
    const lvl = document.getElementById('guide-preview-zoom-level');
    if (lvl) lvl.textContent = Math.round(_guidePreviewZoom * 100) + '%';
}

function _guideResetPreviewZoom() {
    _guidePreviewZoom = 1;
    _guidePreviewPanX = 0;
    _guidePreviewPanY = 0;
    _guideApplyPreviewTransform();
}

function _guideFitPreviewZoom() {
    const viewport = document.getElementById('guide-preview-viewport');
    const canvas = document.getElementById('guide-preview-canvas');
    if (!viewport || !canvas) return;
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    const imgW = _guidePreviewCapture?.width || 380;
    const imgH = _guidePreviewCapture?.height || 240;
    _guidePreviewZoom = Math.min(vpW / imgW, vpH / imgH) * 0.95;
    _guidePreviewPanX = 0;
    _guidePreviewPanY = 0;
    _guideApplyPreviewTransform();
}

function _initGuidePreviewZoom() {
    const viewport = document.getElementById('guide-preview-viewport');
    const canvas = document.getElementById('guide-preview-canvas');
    if (!viewport || !canvas) return;

    // Wheel zoom
    viewport.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) return; // let browser handle page zoom
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const delta = -e.deltaY * 0.001;
        const oldZoom = _guidePreviewZoom;
        _guidePreviewZoom = Math.max(0.5, Math.min(20, _guidePreviewZoom * (1 + delta)));
        // Adjust pan to keep mouse position fixed
        const ratio = 1 - _guidePreviewZoom / oldZoom;
        _guidePreviewPanX += mx * ratio;
        _guidePreviewPanY += my * ratio;
        _guideApplyPreviewTransform();
    }, { passive: false });

    // Drag to pan (or click to select star)
    let dragging = false, didDrag = false, startX = 0, startY = 0, panStartX = 0, panStartY = 0;
    viewport.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, select')) return;
        dragging = true;
        didDrag = false;
        startX = e.clientX;
        startY = e.clientY;
        panStartX = _guidePreviewPanX;
        panStartY = _guidePreviewPanY;
        if (_guidePreviewZoom > 1) viewport.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
        if (_guidePreviewZoom > 1) {
            _guidePreviewPanX = panStartX + dx;
            _guidePreviewPanY = panStartY + dy;
            _guideApplyPreviewTransform();
        }
    });
    window.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        viewport.style.cursor = '';
        if (!didDrag && _guideStarList.length && _guidePreviewCapture) {
            // Click — select nearest star
            const rect = viewport.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const { scale, offX, offY, width: imgW, height: imgH, dpr } = _guidePreviewCapture;
            // Account for zoom/pan transform
            const imgX = ((cx - _guidePreviewPanX) / _guidePreviewZoom * dpr - offX) / scale;
            const imgY = imgH - 1 - ((cy - _guidePreviewPanY) / _guidePreviewZoom * dpr - offY) / scale;
            let bestDist = Infinity, bestStar = null;
            for (const s of _guideStarList) {
                const dx = s.x - imgX, dy = s.y - imgY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) { bestDist = dist; bestStar = s; }
            }
            if (bestStar && bestDist < 15) _guideSetStar(bestStar);
        }
    });

    // Double-click reset
    viewport.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, select')) return;
        _guideResetPreviewZoom();
    });

    // Buttons
    const zoomReset = document.getElementById('guide-preview-zoom-reset');
    if (zoomReset) zoomReset.addEventListener('click', _guideResetPreviewZoom);
    const zoomFit = document.getElementById('guide-preview-zoom-fit');
    if (zoomFit) zoomFit.addEventListener('click', _guideFitPreviewZoom);

    // Fit on first load
    _guideFitPreviewZoom();
}

async function _guidePreviewCaptureHandler() {
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('warn', 'guide', 'Sélectionnez une caméra guide'); return; }
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    addLog('info', 'guide', `Capture guide en cours (${exposure}s)...`);
    // Set a flag so handleGuideImage knows to run star detection
    apiPost('/api/camera/expose', { device: cam, duration: exposure });
}

async function _guideStart() {
    if (_guideRunning) return;
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('error', 'guide', 'Sélectionnez une caméra guide'); return; }

    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const aggr = parseFloat(document.getElementById('guide-aggressiveness')?.value || '0.8');
    const raGain = parseFloat(document.getElementById('guide-ra-gain')?.value || '1.0');
    const decGain = parseFloat(document.getElementById('guide-dec-gain')?.value || '1.0');
    const maxPulse = parseInt(document.getElementById('guide-max-pulse')?.value || '2000');

    _guideRunning = true;
    _guideDriftHistory = [];
    if (_guideStartBtn) _guideStartBtn.disabled = true;
    if (_guideStopBtn) _guideStopBtn.disabled = false;
    if (_guidePauseBtn) _guidePauseBtn.disabled = false;

    const res = await fetch('/api/guide/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            exposure, aggressiveness: aggr,
            ra_gain: raGain, dec_gain: decGain,
            max_pulse_ms: maxPulse
        })
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'guide', res?.error || 'Échec démarrage');
        _guideCleanup();
        return;
    }
    addLog('info', 'guide', `Guidage démarré: expo=${exposure}s aggr=${aggr}`);
    _guideLoop();
}

async function _guideLoop() {
    if (!_guideRunning) return;
    const cam = _guideCameraSelect?.value || '';
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');

    // Expose guide camera
    apiPost('/api/camera/expose', { device: cam, duration: exposure });

    // Wait for image
    await new Promise(r => setTimeout(r, Math.max(500, exposure * 1000 + 500)));

    // Measure star centroid via focus-metric
    const metricUrl = '/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : '');
    const metric = await fetch(metricUrl).then(r => r.json()).catch(() => null);

    if (metric?.ok && metric.stars?.length > 0) {
        const star = metric.stars[0];
        const x = star.x;
        const y = star.y;
        _guideLastCentroid = { x, y, imgW: metric.width || null, imgH: metric.height || null };

        // Report to guide backend
        const step = await fetch('/api/guide/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x, y })
        }).then(r => r.json()).catch(() => null);

        if (step?.ok) {
            _guideRefSet = step.ref_set;
            _guideUpdateUI(step);

            // Send correction pulses to mount
            if (step.ra_pulse_ms > 0 && step.ra_direction) {
                const dir = step.ra_direction === 'E' ? 'EAST' : 'WEST';
                apiPost('/api/mount/move', { direction: dir, rate: 'Guide' });
                setTimeout(() => apiPost('/api/mount/halt'), step.ra_pulse_ms);
            }
            if (step.dec_pulse_ms > 0 && step.dec_direction) {
                const dir = step.dec_direction === 'N' ? 'NORTH' : 'SOUTH';
                apiPost('/api/mount/move', { direction: dir, rate: 'Guide' });
                setTimeout(() => apiPost('/api/mount/halt'), step.dec_pulse_ms);
            }
        }
    }

    // Next frame
    if (_guideRunning) {
        _guideTimer = setTimeout(() => _guideLoop(), 200);
    }
}

function _guideUpdateUI(status) {
    if (_guideFrameCountEl) _guideFrameCountEl.textContent = status.frame_count;
    if (_guideDriftRAEl) _guideDriftRAEl.textContent = status.drift_arcsec_x?.toFixed(1) ?? '0.0';
    if (_guideDriftDECEl) _guideDriftDECEl.textContent = status.drift_arcsec_y?.toFixed(1) ?? '0.0';
    if (_guideCorrRAEl) _guideCorrRAEl.textContent = `${status.ra_pulse_ms}ms ${status.ra_direction || '—'}`;
    if (_guideCorrDECEl) _guideCorrDECEl.textContent = `${status.dec_pulse_ms}ms ${status.dec_direction || '—'}`;

    if (status.history) {
        _guideDriftHistory = status.history;
        _guideDrawDrift();
        _calDrawCalCrosshair();
    }

    // Beep if outside tolerance
    const tolInput = document.getElementById('guide-tolerance');
    const tol = parseFloat(tolInput?.value || '10');
    if (tol > 0) {
        const ra = Math.abs(status.drift_arcsec_x || 0);
        const dec = Math.abs(status.drift_arcsec_y || 0);
        if (ra > tol || dec > tol) _guideBeep();
    }
}

let _guideDriftLastCSSW = 0, _guideDriftLastCSSH = 0;
let _guideAudioCtx = null;

// ── Guide preview zoom/pan ──
let _guidePreviewZoom = 1;
let _guidePreviewPanX = 0, _guidePreviewPanY = 0;

function _guideBeep() {
    try {
        if (!_guideAudioCtx) _guideAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = _guideAudioCtx.createOscillator();
        const gain = _guideAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(_guideAudioCtx.destination);
        osc.frequency.value = 880;
        osc.type = 'square';
        gain.gain.setValueAtTime(0.15, _guideAudioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, _guideAudioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(_guideAudioCtx.currentTime + 0.3);
    } catch (e) { /* audio not available */ }
}

function _guideDrawDrift() {
    const canvas = _guideDriftCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const dw = canvas.clientWidth;
    const dh = canvas.clientHeight;
    if (!dw || !dh) return;
    const bw = Math.round(dw * dpr);
    const bh = Math.round(dh * dpr);
    if (canvas.width !== bw || canvas.height !== bh || dw !== _guideDriftLastCSSW || dh !== _guideDriftLastCSSH) {
        canvas.width = bw;
        canvas.height = bh;
        _guideDriftLastCSSW = dw;
        _guideDriftLastCSSH = dh;
    }
    const ctx = canvas.getContext('2d');
    const w = bw, h = bh;
    ctx.clearRect(0, 0, w, h);

    const hist = _guideDriftHistory;
    const pad = 42;
    const padBottom = 18;
    const midY = h / 2;

    // Dynamic yMax from tolerance input (minimum ±5)
    const tolInput = document.getElementById('guide-tolerance');
    const tolArcsec = parseFloat(tolInput?.value || '10');
    const yMax = Math.max(5, tolArcsec);

    // Grid lines
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1 * dpr;
    const gridSteps = 4;
    for (let i = -gridSteps; i <= gridSteps; i++) {
        const y = midY + (i / gridSteps) * (midY - pad);
        if (y < pad || y > h - padBottom) continue;
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    // Zero line (target) — brighter
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(w - pad, midY); ctx.stroke();

    // Tolerance zone from input value
    const tol = tolArcsec / yMax * (midY - pad);
    ctx.fillStyle = 'rgba(255,68,68,0.12)';
    ctx.fillRect(pad, midY - tol, w - 2 * pad, tol * 2);
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(pad, midY - tol); ctx.lineTo(w - pad, midY - tol); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, midY + tol); ctx.lineTo(w - pad, midY + tol); ctx.stroke();
    ctx.setLineDash([]);

    // Tolerance label
    ctx.fillStyle = '#ff6666';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`±${tolArcsec}″`, pad + 2 * dpr, midY - tol - 4 * dpr);

    if (hist.length < 1) {
        ctx.fillStyle = '#777';
        ctx.font = `${12 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('En attente de données...', w / 2, midY);
        return;
    }

    // ── Fixed-size sliding window (120s) ──
    const windowSec = 120;
    const exposure = parseFloat(document.getElementById('guide-exposure')?.value || '1.0');
    const windowFrames = Math.max(2, Math.ceil(windowSec / exposure));
    const plotWidth = w - 2 * pad;
    const xStep = plotWidth / (windowFrames - 1);

    // Determine which history indices fall in the window
    const startIdx = Math.max(0, hist.length - windowFrames);

    // Pre-allocate fixed-size array (null = no data yet)
    const slots = new Array(windowFrames).fill(null);
    for (let i = 0; i < windowFrames; i++) {
        const hi = startIdx + i;
        if (hi >= 0 && hi < hist.length) slots[i] = hist[hi];
    }

    // Find first/last non-null
    let firstSlot = -1, lastSlot = -1;
    for (let i = 0; i < windowFrames; i++) {
        if (slots[i] !== null) {
            if (firstSlot === -1) firstSlot = i;
            lastSlot = i;
        }
    }
    if (firstSlot === -1) return;

    function drawLine(getVal, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        let started = false;
        for (let i = firstSlot; i <= lastSlot; i++) {
            const d = slots[i];
            if (d === null) continue;
            const x = pad + i * xStep;
            const y = midY - (getVal(d) / yMax) * (midY - pad);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Last value dot + label
        const last = slots[lastSlot];
        if (last) {
            const lx = pad + lastSlot * xStep;
            const ly = midY - (getVal(last) / yMax) * (midY - pad);
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(lx, ly, 4 * dpr, 0, Math.PI * 2); ctx.fill();
            ctx.font = `bold ${10 * dpr}px monospace`;
            ctx.textAlign = 'left';
            ctx.fillText(`${getVal(last).toFixed(1)}″`, lx + 6 * dpr, ly - 6 * dpr);
        }
    }

    drawLine(d => d.drift_arcsec_x, '#44cc44');
    drawLine(d => d.drift_arcsec_y, '#4488ff');

    // Y axis labels
    ctx.fillStyle = '#999';
    ctx.font = `bold ${10 * dpr}px monospace`;
    ctx.textAlign = 'right';
    for (let i = -gridSteps; i <= gridSteps; i++) {
        const y = midY + (i / gridSteps) * (midY - pad);
        if (y < pad - 4 * dpr || y > h - padBottom + 4 * dpr) continue;
        const val = (i / gridSteps) * yMax;
        ctx.fillStyle = val === 0 ? '#bbb' : '#777';
        ctx.fillText(val.toFixed(0), pad - 6 * dpr, y + 3.5 * dpr);
    }

    // X axis — time ticks (relative to now)
    ctx.textAlign = 'center';
    const tickCount = Math.min(6, windowFrames);
    for (let i = 0; i <= tickCount; i++) {
        const idx = Math.round((i / tickCount) * (windowFrames - 1));
        const x = pad + idx * xStep;
        const relSec = -(windowFrames - 1 - idx) * exposure;
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 0.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, h - padBottom); ctx.lineTo(x, h - padBottom + 4 * dpr); ctx.stroke();
        ctx.fillStyle = '#666';
        ctx.font = `${7.5 * dpr}px monospace`;
        ctx.fillText(`${relSec}s`, x, h - padBottom + 14 * dpr);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#555';
    ctx.font = `${7.5 * dpr}px monospace`;
    ctx.fillText(`-${(windowFrames - 1) * exposure}s`, pad + 2 * dpr, h - padBottom + 4 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(`0s`, w - pad - 2 * dpr, h - padBottom + 4 * dpr);
}

async function _guideStop() {
    _guideRunning = false;
    _guideRefSet = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/stop', { method: 'POST' }).catch(() => {});
    addLog('warning', 'guide', 'Guidage arrêté');
    _guideCleanup();
}

async function _guidePause() {
    if (!_guideRunning) return;
    _guideRunning = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/pause', { method: 'POST' }).catch(() => {});
    addLog('info', 'guide', 'Guidage en pause');
    if (_guideStartBtn) _guideStartBtn.disabled = false;
    if (_guideStopBtn) _guideStopBtn.disabled = true;
    if (_guidePauseBtn) _guidePauseBtn.disabled = true;
}

async function _guideReset() {
    _guideRunning = false;
    _guideRefSet = false;
    if (_guideTimer) { clearTimeout(_guideTimer); _guideTimer = null; }
    await fetch('/api/guide/reset', { method: 'POST' }).catch(() => {});
    _guideDriftHistory = [];
    _guideDrawDrift();
    _guideCleanup();
    addLog('info', 'guide', 'Guidage réinitialisé');
}

function _guideCleanup() {
    _guideRunning = false;
    if (_guideStartBtn) _guideStartBtn.disabled = false;
    if (_guideStopBtn) _guideStopBtn.disabled = true;
    if (_guidePauseBtn) _guidePauseBtn.disabled = true;
}

// ── Calibration monture ─────────────────────────────────────

let _calRunning = false;
let _calStartBtn = null, _calStopBtn = null;
let _calGraphCanvas = null;
let _calPhaseEl = null, _calStepCountEl = null, _calQualityEl = null;
let _calResultsEl = null;
let _calXRatesEl = null, _calYRateEl = null, _calOrthoEl = null, _calBadgeEl = null;
let _calTimer = null;

function initCalibrationPanel() {
    _calStartBtn = document.getElementById('cal-start-btn');
    _calStopBtn = document.getElementById('cal-stop-btn');
    _calGraphCanvas = document.getElementById('cal-graph-canvas');
    _calPhaseEl = document.getElementById('cal-phase');
    _calStepCountEl = document.getElementById('cal-step-count');
    _calQualityEl = document.getElementById('cal-quality');
    _calResultsEl = document.getElementById('cal-results');
    _calXRatesEl = document.getElementById('cal-x-rate');
    _calYRateEl = document.getElementById('cal-y-rate');
    _calOrthoEl = document.getElementById('cal-ortho');
    _calBadgeEl = document.getElementById('cal-badge');

    if (_calStartBtn) _calStartBtn.addEventListener('click', _calibrateStart);
    if (_calStopBtn) _calStopBtn.addEventListener('click', _calibrateStop);

    // Tab switching: Graphe / Cible
    const tabGraph = document.getElementById('cal-tab-graph');
    const tabCross = document.getElementById('cal-tab-crosshair');
    const crossCanvas = document.getElementById('cal-crosshair-canvas');
    if (tabGraph && tabCross && crossCanvas) {
        tabGraph.addEventListener('click', () => {
            tabGraph.classList.add('cal-tab-active');
            tabCross.classList.remove('cal-tab-active');
            _calGraphCanvas.style.display = '';
            crossCanvas.style.display = 'none';
            _calibrateDrawGraph({steps: []});
        });
        tabCross.addEventListener('click', () => {
            tabCross.classList.add('cal-tab-active');
            tabGraph.classList.remove('cal-tab-active');
            _calGraphCanvas.style.display = 'none';
            crossCanvas.style.display = '';
            _calDrawCalCrosshair();
        });
    }
}

function _calDrawCalCrosshair() {
    const canvas = document.getElementById('cal-crosshair-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const hist = _guideDriftHistory;
    if (hist.length < 1) {
        ctx.fillStyle = '#555';
        ctx.font = `${11 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('En attente des données de guidage...', w / 2, h / 2);
        return;
    }

    const pad = 48;
    const plotW = w - 2 * pad;
    const plotH = h - 2 * pad;
    const midX = pad + plotW / 2;
    const midY = pad + plotH / 2;
    const half = Math.max(5, parseFloat(document.getElementById('guide-tolerance')?.value || '10'));
    const maxR = Math.min(plotW, plotH) / 2 - 4 * dpr;
    const scale = maxR / half;

    // Tolerance zones
    const tolR = half * scale, safeR = tolR / 2;
    const gradOrg = ctx.createRadialGradient(midX, midY, safeR, midX, midY, tolR);
    gradOrg.addColorStop(0, 'rgba(255,165,0,0.0)');
    gradOrg.addColorStop(1, 'rgba(255,165,0,0.12)');
    ctx.fillStyle = gradOrg;
    ctx.beginPath(); ctx.arc(midX, midY, tolR, 0, Math.PI * 2); ctx.fill();
    const gradGrn = ctx.createRadialGradient(midX, midY, 0, midX, midY, safeR);
    gradGrn.addColorStop(0, 'rgba(0,255,100,0.08)');
    gradGrn.addColorStop(1, 'rgba(0,255,100,0.15)');
    ctx.fillStyle = gradGrn;
    ctx.beginPath(); ctx.arc(midX, midY, safeR, 0, Math.PI * 2); ctx.fill();

    // Concentric rings
    for (let r = 1; r <= 4; r++) {
        const radius = (tolR * r) / 4;
        const isB = r % 2 === 0;
        ctx.strokeStyle = isB ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.10)';
        ctx.lineWidth = isB ? 1.5 * dpr : 0.5 * dpr;
        ctx.setLineDash(isB ? [] : [3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.arc(midX, midY, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Crosshair lines
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(pad + plotW, midY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, pad); ctx.lineTo(midX, pad + plotH); ctx.stroke();

    // Data trail
    for (let i = 0; i < hist.length; i++) {
        const d = hist[i];
        const px = midX + (d.drift_arcsec_x || 0) * scale;
        const py = midY - (d.drift_arcsec_y || 0) * scale;
        const alpha = 0.15 + 0.85 * (i / hist.length);
        const radius = i === hist.length - 1 ? 5 * dpr : 2.5 * dpr;
        ctx.fillStyle = i === hist.length - 1 ? '#ffffff' : `rgba(180,200,255,${alpha * 0.6})`;
        ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
    }

    // Current crosshair
    if (hist.length > 0) {
        const last = hist[hist.length - 1];
        const cx = midX + (last.drift_arcsec_x || 0) * scale;
        const cy = midY - (last.drift_arcsec_y || 0) * scale;
        ctx.strokeStyle = '#00ffcc';
        ctx.lineWidth = 2.5 * dpr;
        const ch = 10 * dpr;
        ctx.beginPath(); ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch); ctx.stroke();
        ctx.fillStyle = '#00ffcc';
        ctx.beginPath(); ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2); ctx.fill();
        // Readout
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${11 * dpr}px monospace`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`RA: ${(last.drift_arcsec_x || 0).toFixed(2)}″`, w - pad, h - pad);
        ctx.fillText(`DEC: ${(last.drift_arcsec_y || 0).toFixed(2)}″`, w - pad, h - pad + 14 * dpr);
    }
}

async function _calibrateStart() {
    if (_calRunning) return;
    const cam = _guideCameraSelect?.value;
    if (!cam) { addLog('error', 'calibration', 'Sélectionnez une caméra guide'); return; }

    // Reset calibration state machine
    await fetch('/api/guide/calibrate/reset', { method: 'POST' }).catch(() => {});

    // Need a guide star — take a quick exposure to get centroid
    addLog('info', 'calibration', 'Prévisualisation étoile guide...');
    await fetch('/api/camera/expose', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device: cam, duration: 1.0})
    }).then(r => r.json()).catch(() => {});
    await sleep(2000);

    const metric = await fetch('/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : ''))
        .then(r => r.json()).catch(() => null);
    if (!metric?.ok || !metric.stars?.length) {
        addLog('error', 'calibration', 'Aucune étoile détectée');
        return;
    }

    const pulseMs = parseInt(document.getElementById('cal-pulse-ms')?.value || '500');
    const res = await fetch('/api/guide/calibrate/start', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({step_ms: pulseMs, target_px: 25})
    }).then(r => r.json()).catch(() => null);

    if (!res?.ok) {
        addLog('error', 'calibration', res?.error || 'Échec démarrage');
        return;
    }

    // Set true origin from the pre-calibration star position
    await fetch('/api/guide/calibrate/set-origin', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({x: metric.stars[0].x, y: metric.stars[0].y})
    }).catch(() => {});

    _calRunning = true;
    if (_calStartBtn) _calStartBtn.disabled = true;
    if (_calStopBtn) _calStopBtn.disabled = false;
    if (_calResultsEl) _calResultsEl.style.display = 'none';
    const wrap = document.getElementById('cal-status-wrap');
    if (wrap) wrap.style.display = '';
    addLog('info', 'calibration', 'Calibration démarrée');
    _calibrateLoop();
}

async function _calibrateLoop() {
    if (!_calRunning) return;
    const status = await fetch('/api/guide/calibrate/status', {method: 'GET'})
        .then(r => r.json()).catch(() => null);
    if (!status?.ok) { _calibrateAbort('Erreur statut'); return; }

    const dir = status.next_direction;
    const stepMs = status.step_ms || 500;
    const cam = _guideCameraSelect?.value || '';

    if (_calPhaseEl) {
        const phaseNames = {W:'→ WEST', E:'← EAST', N:'↑ NORTH', S:'↓ SOUTH'};
        _calPhaseEl.textContent = `Phase: ${phaseNames[dir] || dir}`;
    }
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${status.step_count}`;
    _calibrateDrawGraph(status);

    // Mount pulse
    const mountDir = {W:'WEST', E:'EAST', N:'NORTH', S:'SOUTH'}[dir];
    if (mountDir) {
        await fetch('/api/mount/move', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({direction: mountDir, rate: 'Guide'})
        }).then(r => r.json()).catch(() => {});
        await sleep(stepMs);
        await fetch('/api/mount/halt', {method: 'POST'}).catch(() => {});
    }

    // Expose guide camera
    await fetch('/api/camera/expose', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device: cam, duration: 0.5})
    }).then(r => r.json()).catch(() => {});
    await sleep(1500);

    // Get centroid
    const metric = await fetch('/api/focuser/focus-metric' + (cam ? `?device=${encodeURIComponent(cam)}` : ''))
        .then(r => r.json()).catch(() => null);

    if (!metric?.ok || !metric.stars?.length) {
        _calibrateAbort('Étoile perdue');
        return;
    }
    const star = metric.stars[0];

    // Record step
    const stepRes = await fetch('/api/guide/calibrate/step', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({direction: dir, x: star.x, y: star.y, pulse_ms: stepMs})
    }).then(r => r.json()).catch(() => null);

    if (!stepRes?.ok) { _calibrateAbort(stepRes?.error || 'Erreur step'); return; }

    // Update UI
    if (_calPhaseEl) {
        const phaseNames = {W:'→ WEST', E:'← EAST', N:'↑ NORTH', S:'↓ SOUTH'};
        _calPhaseEl.textContent = `Phase: ${phaseNames[stepRes.next_direction] || stepRes.next_direction}`;
    }
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${stepRes.step_count}`;
    _calibrateDrawGraph(stepRes);

    // Check completion / failure
    if (stepRes.state === 'complete') {
        _calibrateDone(stepRes);
        return;
    }
    if (stepRes.state === 'failed') {
        _calibrateAbort(stepRes.error || 'Échec calibration');
        return;
    }

    if (_calRunning) {
        _calTimer = setTimeout(() => _calibrateLoop(), 50);
    }
}

function _calibrateDrawGraph(status) {
    const canvas = _calGraphCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const steps = status.steps || [];
    const west = steps.filter(s => s.direction === 'W');
    const east = steps.filter(s => s.direction === 'E');
    const north = steps.filter(s => s.direction === 'N');
    const south = steps.filter(s => s.direction === 'S');

    if (steps.length < 1) {
        ctx.fillStyle = '#555';
        ctx.font = `${11 * dpr}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('En attente...', w / 2, h / 2);
        return;
    }

    const pad = 44;
    const plotW = w - 2 * pad;
    const plotH = h - 2 * pad;
    const midX = pad + plotW / 2;
    const midY = pad + plotH / 2;

    // Data bounds — use a fixed minimum range so points don't jump
    const allX = steps.map(s => s.dx);
    const allY = steps.map(s => s.dy);
    const targetPx = status.target_px || 25;
    const maxAbs = Math.max(1, ...allX.map(Math.abs), ...allY.map(Math.abs));
    const range = Math.max(maxAbs * 1.3, targetPx * 2);
    const scale = Math.min(plotW, plotH) / (2 * range);

    // Grid with graduation labels
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        const frac = i / 4;
        const val = (frac * range).toFixed(0);
        const x = midX + frac * range * scale;
        const y = midY - frac * range * scale;
        ctx.strokeStyle = '#2a2a3e';
        ctx.lineWidth = 0.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, pad + plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + plotW, y); ctx.stroke();
        // X tick label
        ctx.fillStyle = '#555';
        ctx.fillText(val, x, pad + plotH + 2 * dpr);
        // Y tick label
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(val, pad - 4 * dpr, y);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
    }

    // Zero cross
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(pad + plotW, midY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, pad); ctx.lineTo(midX, pad + plotH); ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('0', pad - 4 * dpr, midY + 3 * dpr);

    // Axis labels
    const labelStyle = '#777';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = labelStyle;
    ctx.font = `${8 * dpr}px monospace`;
    ctx.fillText('W ← dx (px) → E', w / 2, pad + plotH + 14 * dpr);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('S ← dy (px) → N', pad - 2 * dpr, h / 2);

    // Helper: draw step series
    function drawSteps(series, color, label, showLabels) {
        if (series.length < 1) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * dpr;
        if (series.length >= 2) {
            ctx.beginPath();
            for (let i = 0; i < series.length; i++) {
                const x = midX + series[i].dx * scale;
                const y = midY - series[i].dy * scale;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        for (let i = 0; i < series.length; i++) {
            const x = midX + series[i].dx * scale;
            const y = midY - series[i].dy * scale;
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
            if (showLabels) {
                ctx.fillStyle = '#aaa';
                ctx.font = `${7 * dpr}px monospace`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.fillText((i + 1).toString(), x + 4 * dpr, y - 2 * dpr);
            }
        }
        // Legend entry
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        const lx = pad + 2 * dpr;
        const ly = pad + 2 * dpr + (['#4488ff','#ff8844','#44cc44','#cc44cc'].indexOf(color) * 12 * dpr);
        ctx.fillRect(lx, ly, 70 * dpr, 10 * dpr);
        ctx.fillStyle = color;
        ctx.font = `${8 * dpr}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('●', lx + 2 * dpr, ly + 1 * dpr);
        ctx.fillStyle = '#ccc';
        ctx.fillText(label, lx + 14 * dpr, ly + 1 * dpr);
    }

    drawSteps(west, '#4488ff', 'WEST', true);
    drawSteps(east, '#ff8844', 'EAST', false);
    drawSteps(north, '#44cc44', 'NORTH', true);
    drawSteps(south, '#cc44cc', 'SOUTH', false);
}

function _calibrateDone(status) {
    _calRunning = false;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;

    if (_calPhaseEl) _calPhaseEl.textContent = 'Phase: ✅ Terminé';
    if (_calStepCountEl) _calStepCountEl.textContent = `Steps: ${status.step_count}`;

    // Results
    if (_calResultsEl) _calResultsEl.style.display = '';
    if (_calXRatesEl) _calXRatesEl.textContent = status.x_rate != null ? status.x_rate.toFixed(6) : '—';
    if (_calYRateEl) _calYRateEl.textContent = status.y_rate != null ? status.y_rate.toFixed(6) : '—';
    if (_calOrthoEl) _calOrthoEl.textContent = status.orthogonality != null ? status.orthogonality.toFixed(1) : '—';

    const qColors = {good: '#4a4', acceptable: '#fa0', poor: '#f44', insufficient_data: '#888'};
    if (_calBadgeEl) {
        _calBadgeEl.textContent = status.quality || '—';
        _calBadgeEl.style.color = qColors[status.quality] || '#888';
    }
    if (_calQualityEl) {
        const flaws = status.quality_flaws || [];
        _calQualityEl.textContent = flaws.length ? flaws.join(' ') : '';
    }

    // Auto-populate guide gains from calibration results
    if (status.x_rate != null && status.x_rate > 0) {
        const raGain = document.getElementById('guide-ra-gain');
        if (raGain) raGain.value = (1 / status.x_rate).toFixed(1);
    }
    if (status.y_rate != null && status.y_rate > 0) {
        const decGain = document.getElementById('guide-dec-gain');
        if (decGain) decGain.value = (1 / status.y_rate).toFixed(1);
    }

    _calibrateDrawGraph(status);
    addLog('info', 'calibration', `Calibration terminée: qualité=${status.quality}`);
}

function _calibrateAbort(msg) {
    _calRunning = false;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;
    fetch('/api/guide/calibrate/stop', {method: 'POST'}).catch(() => {});
    if (_calPhaseEl) _calPhaseEl.textContent = 'Phase: ❌ ' + msg;
    addLog('error', 'calibration', msg);
}

async function _calibrateStop() {
    if (!_calRunning) return;
    _calRunning = false;
    if (_calTimer) { clearTimeout(_calTimer); _calTimer = null; }
    await fetch('/api/guide/calibrate/stop', {method: 'POST'}).catch(() => {});
    if (_calPhaseEl) _calPhaseEl.textContent = 'Phase: ⏹ Arrêté';
    if (_calStartBtn) _calStartBtn.disabled = false;
    if (_calStopBtn) _calStopBtn.disabled = true;
    addLog('warning', 'calibration', 'Arrêté par l\'utilisateur');
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

// ── Drag system for applets ───────────────────────────────────

function toggleMinimize(panel) {
    const wasCollapsed = panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    const minBtn = panel.querySelector('.applet-minimize');
    if (minBtn) minBtn.classList.toggle('collapsed-label', !wasCollapsed);
    currentModeConfig().collapsed = currentModeConfig().collapsed || {};
    currentModeConfig().collapsed[panel.id] = !wasCollapsed;
    saveUiConfig();
}

function applyCollapsedState() {
    const modeCfg = currentModeConfig();
    const collapsed = modeCfg.collapsed || {};
    for (const [id, isCollapsed] of Object.entries(collapsed)) {
        if (!isCollapsed) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('collapsed');
        const btn = el.querySelector('.applet-minimize');
        if (btn) btn.classList.add('collapsed-label');
    }
}

function checkOverlap() {
    const panels = [];
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar' || el.id === 'applet-connection') return;
        if (el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        panels.push({ el, rect });
    });

    for (let i = 0; i < panels.length; i++) {
        for (let j = i + 1; j < panels.length; j++) {
            const a = panels[i].rect;
            const b = panels[j].rect;
            const overlap = !(a.right <= b.left || b.right <= a.left ||
                              a.bottom <= b.top || b.bottom <= a.top);
            if (overlap) {
                const el = panels[j].el;
                let left = parseInt(el.style.left) || 0;
                let top = parseInt(el.style.top) || 0;
                el.style.left = (left + 20) + 'px';
                el.style.top = (top + 20) + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                el.style.transform = 'none';
                panels[j].rect = el.getBoundingClientRect();
            }
        }
    }
}

function loadAppletPositions() {
    const modeCfg = currentModeConfig();
    const positions = modeCfg.applets || {};
    for (const [id, pos] of Object.entries(positions)) {
        const el = document.getElementById(id);
        if (!el || id === 'applet-mode-bar') continue;
        if (pos.left != null) el.style.left = pos.left;
        else el.style.left = 'auto';
        if (pos.top != null) el.style.top = pos.top;
        else el.style.top = 'auto';
        if (pos.right != null) el.style.right = pos.right;
        else el.style.right = 'auto';
        if (pos.bottom != null) el.style.bottom = pos.bottom;
        else el.style.bottom = 'auto';
        if (pos.transform) el.style.transform = pos.transform;
        else el.style.transform = 'none';
    }
    applyCollapsedState();
    requestAnimationFrame(() => checkOverlap());
}

function saveAppletPositions() {
    const modeCfg = currentModeConfig();
    const positions = {};
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar') return;
        const s = el.style;
        const hasLeft = s.left && s.left !== 'auto';
        const hasTop = s.top && s.top !== 'auto';
        const hasRight = s.right && s.right !== 'auto';
        const hasBottom = s.bottom && s.bottom !== 'auto';
        const hasTransform = s.transform && s.transform !== 'none';
        if (hasLeft || hasTop || hasRight || hasBottom) {
            positions[el.id] = {
                left: hasLeft ? s.left : null,
                top: hasTop ? s.top : null,
                right: hasRight ? s.right : null,
                bottom: hasBottom ? s.bottom : null,
            };
            if (hasTransform) positions[el.id].transform = s.transform;
        }
    });
    modeCfg.applets = positions;
    saveUiConfig();
}

function initDraggableApplets() {
    document.querySelectorAll('.glass-panel.applet').forEach(panel => {
        if (panel.id === 'applet-mode-bar' || panel.id === 'applet-connection') return;

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
        pinBtn.title = 'Épingler / détacher';
        pinBtn.textContent = '📌';
        pinBtn.style.cssText = 'font-size:0.55rem; background:none; border:none; color:#555; cursor:pointer; padding:0 4px; margin-left:auto;';
        handle.insertBefore(pinBtn, handle.lastElementChild);
        const isPinned = currentModeConfig().pinned?.[panel.id];
        if (isPinned) {
            panel.dataset.pinned = 'true';
            pinBtn.style.color = '#00ffcc';
        }
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const modeCfg = currentModeConfig();
            modeCfg.pinned = modeCfg.pinned || {};
            if (panel.dataset.pinned) {
                delete panel.dataset.pinned;
                pinBtn.style.color = '#555';
                modeCfg.pinned[panel.id] = false;
            } else {
                panel.dataset.pinned = 'true';
                pinBtn.style.color = '#00ffcc';
                modeCfg.pinned[panel.id] = true;
            }
            saveUiConfig();
        });

        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
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
            handle.style.cursor = 'grabbing';

            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            function onMove(ev) {
                let left = ev.clientX - offsetX;
                let top = ev.clientY - offsetY;
                left = Math.max(0, Math.min(window.innerWidth - 60, left));
                top = Math.max(0, Math.min(window.innerHeight - 40, top));
                panel.style.left = left + 'px';
                panel.style.top = top + 'px';
            }

            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                handle.style.cursor = 'grab';
                panel.style.zIndex = '';
                panel.style.transition = '';
                saveAppletPositions();
                checkOverlap();
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
    initConnectionBar();
    initButtons();
    initDpad();
    initJoystick();
    initObjectSearch();
    initSitePopup();
    initTimeControls();
    initLocationUpdate();
    initCapturePanel();
    initPreviewResize();
    initPreviewZoomPan();
    initSaveImage();
    initHistogramControls();
    initSolverPanel();
    initTargetPanel();
    initPolarPanel();
    initFocuserPanel();
    initGuidePanel();
    initCalibrationPanel();
    await initSkyEngine();
    initDraggableApplets();
    initLayerToggles();
    connectWS();

    // Re-check overlap on resize
    window.addEventListener('resize', () => {
        requestAnimationFrame(() => checkOverlap());
    });

    // Apply UI config: mode
    switchMode(uiConfig.mode || 'mount');
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

    _initDone = true;
});
