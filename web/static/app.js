// INDIGO Devices — vanilla JS client

import { SkyCanvas } from '/sky-canvas.js';

let ws = null;
let devices = {};
let selectedDevice = null;
const MAX_LOG = 500;
let logEntries = [];

// ── WebSocket ──────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        document.getElementById('connection-status').className = 'status-dot connected';
        document.getElementById('connection-label').textContent = 'connecte';
        addLog('info', 'ws', 'WebSocket connecte');
    };

    ws.onclose = () => {
        document.getElementById('connection-status').className = 'status-dot disconnected';
        document.getElementById('connection-label').textContent = 'deconnecte';
        addLog('warning', 'ws', 'WebSocket deconnecte, reconnexion...');
        setTimeout(connectWS, 2000);
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') {
            const hadMount = !!findMount();
            devices = msg.devices;
            renderDevices();
            const m = findMount();
            if (m && !hadMount) {
                selectedDevice = m.name;
                renderMountPanel();
            } else if (selectedDevice && devices[selectedDevice] && devices[selectedDevice].type === 'mount') {
                renderMountPanel();
            } else if (selectedDevice) {
                renderProps(selectedDevice);
            }
        } else if (msg.type === 'log') {
            addLog(msg.level, msg.logger, msg.msg);
        }
    };
}

// ── Device list ────────────────────────────────────────────────

function renderDevices() {
    const container = document.getElementById('devices-container');
    container.innerHTML = '';

    for (const [name, dev] of Object.entries(devices)) {
        const div = document.createElement('div');
        div.className = 'device-item' + (name === selectedDevice ? ' selected' : '');
        div.innerHTML = `<span class="type">${dev.type}</span> &mdash; ${name} <span class="status ${dev.connected ? '' : 'disconnected'}">${dev.connected ? '\u25CF' : '\u25CB'}</span>`;
        div.onclick = () => selectDevice(name);
        container.appendChild(div);
    }
}

function selectDevice(name) {
    selectedDevice = name;
    renderDevices();
    const dev = devices[name];
    if (dev && dev.type === 'mount') {
        document.getElementById('device-props').innerHTML = '';
        renderMountPanel();
    } else {
        document.getElementById('mount-panel').style.display = 'none';
        renderProps(name);
    }
}

// ── Mount panel ────────────────────────────────────────────────

function findMount() {
    for (const [name, dev] of Object.entries(devices)) {
        if (dev.type === 'mount') return { name, dev };
    }
    return null;
}

function renderMountPanel() {
    const m = findMount();
    const panel = document.getElementById('mount-panel');
    if (!m) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const d = m.dev;

    const raH = d.ra_hours || 0;
    const decD = d.dec_deg || 0;
    document.getElementById('mount-ra-sexa').textContent = decToSexa(raH, true);
    document.getElementById('mount-ra-dec').textContent = raH.toFixed(4) + ' h';
    document.getElementById('mount-dec-sexa').textContent = decToSexa(decD, false);
    document.getElementById('mount-dec-dec').textContent = decD.toFixed(4) + '\u00B0';

    const trackEl = document.getElementById('mount-tracking');
    trackEl.textContent = d.tracking ? 'TRACK ON' : 'TRACK OFF';
    trackEl.className = 'badge ' + (d.tracking ? 'badge-on' : 'badge-off');

    const parkEl = document.getElementById('mount-park');
    parkEl.textContent = d.parked ? 'PARKED' : 'UNPARKED';
    parkEl.className = 'badge ' + (d.parked ? 'badge-warn' : 'badge-on');

    document.getElementById('mount-slew').style.display = d.slewing ? '' : 'none';

    if (d.props) {
        const statusProp = d.props.find(p => p.name === 'OnStep Status');
        if (statusProp && statusProp.items.length > 0) {
            document.getElementById('onstep-status-section').style.display = '';
            const lines = statusProp.items.map(it => {
                const label = it.label || it.name;
                const val = it.value || '';
                return label === val ? val : `${label}: ${val}`;
            });
            document.getElementById('onstep-status-text').textContent = lines.join('\n');
        } else {
            document.getElementById('onstep-status-section').style.display = 'none';
        }

        // Populate slew speed selector from actual TELESCOPE_SLEW_RATE items
        const slewProp = d.props.find(p => p.name === 'TELESCOPE_SLEW_RATE');
        if (slewProp && slewProp.items.length > 0) {
            const sel = document.getElementById('slew-speed');
            const prev = sel.value;
            if (sel.options.length !== slewProp.items.length || sel.dataset.count !== String(slewProp.items.length)) {
                sel.innerHTML = '';
                let selected = false;
                for (const item of slewProp.items) {
                    const opt = document.createElement('option');
                    opt.value = item.name;
                    opt.textContent = item.label || item.name;
                    if (item.value && !selected) { opt.selected = true; selected = true; }
                    sel.appendChild(opt);
                }
                if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
                sel.dataset.count = String(slewProp.items.length);
            }
        }
    }

    // Update sky canvas crosshair
    if (skyCanvas) {
        skyCanvas.telRa = d.ra_hours ? d.ra_hours * 15 : null;
        skyCanvas.telDec = d.dec_deg || null;
        skyCanvas.render();
    }
}

// ── Coordinate conversion ──────────────────────────────────────

function decToSexa(decimalHours, isRA) {
    if (!decimalHours && decimalHours !== 0) return '--:--:--';
    let total;
    if (isRA) {
        total = decimalHours * 15;
    } else {
        total = decimalHours;
    }
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

// ── Mount commands ─────────────────────────────────────────────

function mountGoto() {
    const raStr = document.getElementById('goto-ra').value;
    const decStr = document.getElementById('goto-dec').value;
    const raH = sexaToDec(raStr, true);
    const decD = sexaToDec(decStr, false);
    if (raH === null || decD === null) {
        addLog('error', 'mount', 'Format invalide. Utilisez hh:mm:ss / dd:mm:ss');
        return;
    }
    apiPost('/api/mount/slew', { ra_hours: raH, dec_deg: decD });
    addLog('info', 'mount', `GOTO RA=${raH.toFixed(4)}h DEC=${decD.toFixed(4)}\u00B0`);
}

function mountMove(dir) {
    const m = findMount();
    if (!m) { addLog('error', 'mount', 'Pas de monture detectee'); return; }
    const speed = document.getElementById('slew-speed').value;
    apiPost('/api/mount/move', { direction: dir, rate: speed || undefined });
}

function mountHaltMove() {
    apiPost('/api/mount/halt');
}

function mountAbort() {
    apiPost('/api/mount/abort');
}

function mountToggleTracking() {
    const m = findMount();
    if (!m) return;
    const on = !m.dev.tracking;
    apiPost('/api/mount/tracking', { on });
}

function mountPark() {
    apiPost('/api/mount/park');
}

function mountUnpark() {
    apiPost('/api/mount/unpark');
}

function mountHome() {
    apiPost('/api/property', {
        device: findMount()?.name,
        property: 'TELESCOPE_HOME',
        items: [{ name: 'GO', value: true }],
    });
}

// ── Property panel (generic) ───────────────────────────────────

function renderProps(deviceName) {
    const dev = devices[deviceName];
    const container = document.getElementById('device-props');
    if (!dev || !dev.props || dev.props.length === 0) {
        container.innerHTML = '';
        return;
    }

    const groups = {};
    for (const p of dev.props) {
        const g = p.group || '(no group)';
        if (!groups[g]) groups[g] = [];
        groups[g].push(p);
    }

    let html = `<div class="device-panel"><h2>${escapeHTML(deviceName)}</h2>`;
    for (const [groupName, props] of Object.entries(groups)) {
        html += `<div class="prop-group"><div class="prop-group-header" onclick="this.parentElement.classList.toggle('collapsed')">${escapeHTML(groupName)}</div><div class="prop-group-body">`;
        for (const p of props) html += renderPropRow(deviceName, p);
        html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
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

// ── API calls ──────────────────────────────────────────────────

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

// ── Utilities ──────────────────────────────────────────────────

function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Log ────────────────────────────────────────────────────────

function addLog(level, logger, msg) {
    const el = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.dataset.level = level;
    entry.innerHTML = `<span class="ts">${time}</span> <span class="logger">[${escapeHTML(logger)}]</span> <span class="msg">${escapeHTML(msg)}</span>`;
    el.appendChild(entry);
    logEntries.push(entry);
    while (logEntries.length > MAX_LOG) { const old = logEntries.shift(); old.remove(); }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) el.scrollTop = el.scrollHeight;
    applyLogFilters();
}

function clearLog() { document.getElementById('log').innerHTML = ''; logEntries = []; }

function applyLogFilters() {
    const activeLevels = new Set();
    document.querySelectorAll('#log-filters input[type="checkbox"]').forEach(cb => { if (cb.checked) activeLevels.add(cb.dataset.level); });
    logEntries.forEach(entry => entry.classList.toggle('hidden', !activeLevels.has(entry.dataset.level)));
}

// ── Resizer ────────────────────────────────────────────────────

function initResizer() {
    const handle = document.getElementById('split-handle');
    const left = document.getElementById('left-panel');
    const container = document.getElementById('split-container');
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = container.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(15, Math.min(70, pct));
        left.style.width = clamped + '%';
    });

    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            handle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ── Sky Canvas ─────────────────────────────────────────────────

let skyCanvas = null;

async function initSkyCanvas() {
    const canvas = document.getElementById('sky-canvas');
    if (!canvas) return;

    skyCanvas = new SkyCanvas(canvas, { centerRa: 0, centerDec: 20, fov: 42 });

    try {
        await skyCanvas.loadCatalogs();
        document.getElementById('sky-chart-wait').style.display = 'none';
        document.getElementById('sky-chart-status').textContent = 'Carte prete';
    } catch (e) {
        addLog('error', 'sky', 'Erreur chargement catalogues: ' + e.message);
    }
}

// ── Init ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#log-filters input[type="checkbox"]').forEach(cb => cb.addEventListener('change', applyLogFilters));
    initResizer();
    initSkyCanvas();
    connectWS();
});

// Make mount functions globally accessible for inline handlers
window.mountGoto = mountGoto;
window.mountMove = mountMove;
window.mountHaltMove = mountHaltMove;
window.mountAbort = mountAbort;
window.mountToggleTracking = mountToggleTracking;
window.mountPark = mountPark;
window.mountUnpark = mountUnpark;
window.mountHome = mountHome;
window.clearLog = clearLog;
window.setSwitchItem = setSwitchItem;
window.setNumberItem = setNumberItem;
window.setTextItem = setTextItem;
