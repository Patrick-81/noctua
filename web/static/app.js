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
        applets: ['applet-focuser-control', 'applet-focuser-position'],
        driverType: 'focuser'
    },
    guiding: {
        applets: ['applet-guiding-graph', 'applet-guiding-settings'],
        driverType: 'ccd'
    },
    capture: {
        applets: ['applet-capture-settings', 'applet-capture-preview'],
        driverType: 'ccd'
    },
    astrometry: {
        applets: ['applet-solver', 'applet-polar'],
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

    refreshDriverList();
    loadAppletPositions();
    saveUiConfig();
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
        } else if (msg.type === 'log') {
            addLog(msg.level, msg.logger, msg.msg);
        } else if (msg.type === 'image') {
            handleCameraImage(msg.data, msg.format);
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

function handleCameraImage(b64Data, fmt) {
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
        if (block.includes('END')) break;
    }

    const get = (key) => {
        const m = headerStr.match(new RegExp(`${key}\\s*=\\s*(.+)`));
        return m ? m[1].trim().replace(/['"]/g, '').split('/')[0].trim() : null;
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
    const range = max - min || 1;

    const canvas = document.getElementById('cap-preview-canvas');
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const val = Math.round(((pixels[y * w + x] - min) / range) * 255);
            const dst = ((h - 1 - y) * w + x) * 4;
            data[dst] = val;
            data[dst + 1] = val;
            data[dst + 2] = val;
            data[dst + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // Store pixel data for histogram
    _histPixels = pixels;
    _histWidth = w;
    _histHeight = h;
    _histDataMin = min;
    _histDataMax = max;

    showPreviewInfo(`${w}×${h} — FITS ${Math.abs(bitpix)}bit — min:${min.toFixed(1)} max:${max.toFixed(1)}`);

    // Render histogram + stretch
    setTimeout(() => {
        renderHistogram();
        if (!_histAuto) applyHistogramStretch();
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
        const startX = e.clientX;

        function onMove(ev) {
            const newW = Math.max(200, Math.min(window.innerWidth - 40, startW + (ev.clientX - startX)));
            panel.style.width = newW + 'px';
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

        const handle = panel.querySelector('.applet-drag');
        if (!handle) return;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
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
    initSaveImage();
    initHistogramControls();
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
