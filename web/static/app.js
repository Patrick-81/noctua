// ═══════════════════════════════════════════════════════════════
// INDIGO Devices — App principal (applets flottants)
// ═══════════════════════════════════════════════════════════════

import { SkyEngine } from '/sky-engine.js';

// ── State ─────────────────────────────────────────────────────

let ws = null;
let devices = {};
let selectedDevice = null;
const MAX_LOG = 500;
let logEntries = [];
let skyEngine = null;
let currentMode = 'mount';

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

    refreshDriverList();
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
        } else if (msg.type === 'log') {
            addLog(msg.level, msg.logger, msg.msg);
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

    let html = `<div class="applet-drag"><span class="drag-icon">⣿⣿</span><span class="hud-title" style="margin:0; border:none; padding:0;">${escapeHTML(deviceName)}</span></div>`;
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
        cb.addEventListener('change', applyLogFilters);
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
        });
    }

    if (manualBtn) {
        manualBtn.addEventListener('click', () => {
            manualBtn.classList.add('active');
            if (realtimeBtn) realtimeBtn.classList.remove('active');
            if (manualControls) manualControls.style.display = 'flex';
            fillManualFields(new Date());
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
        });
    }

    fillManualFields(new Date());
}

// ── Location update ───────────────────────────────────────────

const DRIVER_STORAGE_KEY = 'indigo-selected-driver';
let _allDrivers = [];

async function refreshDriverList() {
    const driverSelect = document.getElementById('indigo-driver');
    if (!driverSelect) return;
    try {
        _allDrivers = await fetch('/api/drivers').then(r => r.json());
    } catch (e) { _allDrivers = []; }

    const type = MODES[currentMode]?.driverType;
    const filtered = filterDriversByType(_allDrivers, type);
    const prev = driverSelect.value || localStorage.getItem(DRIVER_STORAGE_KEY) || '';

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

    // Save driver selection to localStorage
    if (driverSelect) {
        driverSelect.addEventListener('change', () => {
            localStorage.setItem(DRIVER_STORAGE_KEY, driverSelect.value);
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
                attachRow.style.display = (protoSelect.value === 'attach' || isConnected) ? '' : 'none';
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
        });
    }

    // Update station display
    const stationEl = document.getElementById('station-display');
    if (stationEl) stationEl.textContent = `Station : ${siteLat.toFixed(2)}°N / ${siteLng.toFixed(2)}°E`;
    if (latInput) latInput.value = siteLat;
    if (lonInput) lonInput.value = siteLng;
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
        });
    });

    // Catalog checkboxes
    document.querySelectorAll('[data-catalog]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (skyEngine) skyEngine.setCatalogVisibility(cb.dataset.catalog, cb.checked);
        });
    });
}

// ── Global function exports (for inline handlers) ─────────────

window.setSwitchItem = setSwitchItem;
window.setNumberItem = setNumberItem;
window.setTextItem = setTextItem;

// ── Init ──────────────────────────────────────────────────────

// ── Drag system for applets ───────────────────────────────────

const DRAG_STORAGE_KEY = 'indigo-applet-positions';

function loadAppletPositions() {
    try {
        const saved = JSON.parse(localStorage.getItem(DRAG_STORAGE_KEY) || '{}');
        for (const [id, pos] of Object.entries(saved)) {
            const el = document.getElementById(id);
            if (!el || id === 'applet-mode-bar') continue;
            el.style.left = pos.left || 'auto';
            el.style.top = pos.top || 'auto';
            el.style.right = pos.right || 'auto';
            el.style.bottom = pos.bottom || 'auto';
            el.style.transform = 'none';
        }
    } catch (e) {}
}

function saveAppletPositions() {
    const positions = {};
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar') return;
        const s = el.style;
        const hasLeft = s.left && s.left !== 'auto';
        const hasTop = s.top && s.top !== 'auto';
        const hasRight = s.right && s.right !== 'auto';
        const hasBottom = s.bottom && s.bottom !== 'auto';
        if (hasLeft || hasTop || hasRight || hasBottom) {
            positions[el.id] = {
                left: hasLeft ? s.left : 'auto',
                top: hasTop ? s.top : 'auto',
                right: hasRight ? s.right : 'auto',
                bottom: hasBottom ? s.bottom : 'auto'
            };
        }
    });
    try {
        localStorage.setItem(DRAG_STORAGE_KEY, JSON.stringify(positions));
    } catch (e) {}
}

function initDraggableApplets() {
    document.querySelectorAll('.glass-panel.applet').forEach(panel => {
        if (panel.id === 'applet-mode-bar' || panel.id === 'applet-connection') return;

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
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initModeBar();
    initConnectionBar();
    initButtons();
    initDpad();
    initJoystick();
    initObjectSearch();
    initSitePopup();
    initTimeControls();
    initLocationUpdate();
    initSkyEngine();
    initDraggableApplets();
    initLayerToggles();
    loadAppletPositions();
    connectWS();
    switchMode('mount');
});
