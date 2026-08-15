// ═══════════════════════════════════════════════════════════════
// Noctua — ws.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

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
// ── WebSocket ─────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        addLog('info', 'ws', i18n('log.ws.connected'));
    };

    ws.onclose = () => {
        addLog('warning', 'ws', i18n('log.ws.disconnected'));
        setTimeout(connectWS, 2000);
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') {
            devices = msg.devices;
            // Traducteur : publie l'état sur le bus, chaque module met à jour son panneau.
            Bus.emit('ws:state', { devices }, { source: 'ws' });
            renderDevices();
        } else if (msg.type === 'log') {
            Bus.emit('ws:log', { level: msg.level, logger: msg.logger, msg: msg.msg }, { source: 'ws' });
        } else if (msg.type === 'image') {
            Bus.emit('ws:image', { device: msg.device, format: msg.format, data: msg.data }, { source: 'ws' });
        } else if (msg.type === 'solver_result') {
            Bus.emit('solver:result', { result: msg.result }, { source: 'solver' });
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


function buildPropsHTML(deviceName) {
    const dev = devices[deviceName];
    if (!dev || !dev.props || dev.props.length === 0) return '';
    const groups = {};
    for (const p of dev.props) {
        const g = p.group || '(no group)';
        if (!groups[g]) groups[g] = [];
        groups[g].push(p);
    }
    let html = `<div class="device-panel">`;
    for (const [groupName, props] of Object.entries(groups)) {
        html += `<div class="prop-group"><div class="prop-group-header" onclick="this.parentElement.classList.toggle('collapsed')">${escapeHTML(groupName)}</div><div class="prop-group-body">`;
        for (const p of props) html += renderPropRow(deviceName, p);
        html += '</div></div>';
    }
    html += '</div>';
    return html;
}

function renderProps(deviceName) {
    const container = document.getElementById('applet-props');
    if (!container) return;
    if (!devices[deviceName] || !devices[deviceName].props || devices[deviceName].props.length === 0) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';

    const dragHandle = container.querySelector('.applet-drag');
    if (dragHandle) dragHandle.remove();

    let html = `<div class="applet-drag"><span class="drag-icon">⣿⣿</span><span class="hud-title" style="margin:0; border:none; padding:0;">${escapeHTML(deviceName)}</span><button class="applet-minimize" title="Réduire / étendre"></button></div>`;
    html += buildPropsHTML(deviceName);
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

            const margin = 8;
            const vw = window.innerWidth, vh = window.innerHeight;
            const w = container.offsetWidth, h = container.offsetHeight;
            const blockers = getBlockingRects(container);

            function onMove(ev) {
                let left = ev.clientX - offsetX;
                let top = ev.clientY - offsetY;
                left = Math.max(margin, Math.min(left, vw - w - margin));
                top = Math.max(margin, Math.min(top, vh - h - margin));
                const cand = { left, top, right: left + w, bottom: top + h };
                for (const b of blockers) {
                    if (!(cand.right <= b.left || b.right <= cand.left ||
                          cand.bottom <= b.top || b.bottom <= cand.top)) return;
                }
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
                resolvePanelLayout();
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
            addLog('info', 'ws', i18nFmt('log.ws.connecting', { proto: protocol, host, port }));
            try {
                const res = await fetch('/api/connection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ protocol, host, port }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', i18nFmt('log.ws.params_updated', { proto: protocol, host, port }));
                else addLog('error', 'ws', i18nFmt('log.ws.error', { err: JSON.stringify(data) }));
            } catch (e) {
                addLog('error', 'ws', i18nFmt('log.ws.error_conn', { err: e.message }));
            }
        });
    }

    // Attach driver button
    if (attachBtn && driverSelect) {
        attachBtn.addEventListener('click', async () => {
            const driver = driverSelect.value;
            if (!driver) { addLog('warning', 'ws', i18n('log.ws.no_driver')); return; }
            addLog('info', 'ws', i18nFmt('log.ws.attaching', { driver }));
            try {
                const res = await fetch('/api/drivers/attach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ driver }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', i18nFmt('log.ws.driver_attached', { driver }));
                else addLog('error', 'ws', i18nFmt('log.ws.attach_error', { err: JSON.stringify(data) }));
            } catch (e) {
                addLog('error', 'ws', i18nFmt('log.ws.attach_error', { err: e.message }));
            }
        });
    }

    // Apply serial port
    if (applyPortBtn && serialInput) {
        applyPortBtn.addEventListener('click', async () => {
            const device = driverSelect?.value;
            const port = serialInput.value.trim();
            if (!device || !port) { addLog('warning', 'ws', i18n('log.ws.serial_configured')); return; }
            addLog('info', 'ws', i18nFmt('log.ws.serial_config', { device, port }));
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
                if (data.ok) addLog('info', 'ws', i18nFmt('log.ws.serial_configured', { port }));
                else addLog('error', 'ws', i18nFmt('log.ws.port_error', { err: JSON.stringify(data) }));
            } catch (e) {
                addLog('error', 'ws', i18nFmt('log.ws.port_error', { err: e.message }));
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
