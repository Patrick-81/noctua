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
                try { renderProps(selectedDevice); } catch (e) { console.error('renderProps:', e); }
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

    const raH = d.ra_hours != null ? d.ra_hours : 0;
    const decD = d.dec_deg != null ? d.dec_deg : 0;
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
        skyCanvas.slewing = !!d.slewing;
        const raDeg = d.ra_hours != null ? d.ra_hours * 15 : null;
        const decDeg = d.dec_deg != null ? d.dec_deg : null;
        skyCanvas.setTelPosition(raDeg, decDeg);
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
    if (!m) { addLog('error', 'mount', 'Pas de monture detectee — devices: ' + JSON.stringify(Object.keys(devices))); return; }
    const speed = document.getElementById('slew-speed').value;
    addLog('debug', 'mount', `move ${dir} rate=${speed}`);
    apiPost('/api/mount/move', { direction: dir, rate: speed || undefined });
}

function mountHaltMove() {
    addLog('debug', 'mount', 'halt move');
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

function clearLog() { document.getElementById('log').innerHTML = ''; logEntries = []; }

function copyLog() {
    const text = logEntries.map(e => `[${e.dataset.level}] [${e.dataset.logger}] ${e.dataset.msg}`).join('\n');
    navigator.clipboard.writeText(text).then(
        () => addLog('info', 'log', 'Log copié dans le presse-papier'),
        () => addLog('warning', 'log', 'Échec copie')
    );
}

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

    // Fetch site config for horizon computation
    let siteLat = 48.8566, siteLng = 2.3522, siteElev = 0;
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg.site) {
            siteLat = cfg.site.latitude ?? siteLat;
            siteLng = cfg.site.longitude ?? siteLng;
            siteElev = cfg.site.elevation ?? siteElev;
        }
    } catch (e) {
        addLog('warning', 'sky', 'Config site non disponible, défaut Paris');
    }

    skyCanvas = new SkyCanvas(canvas, {
        centerRa: 0, centerDec: 20, fov: 42,
        siteLat, siteLng, siteElev,
    });

    try {
        await skyCanvas.loadCatalogs();
    } catch (e) {
        addLog('error', 'sky', 'Erreur chargement catalogues: ' + e.message);
    }
    document.getElementById('sky-chart-wait').style.display = 'none';
    document.getElementById('sky-chart-status').textContent = skyCanvas.stars?.length ? 'Carte prête' : 'Erreur catalogues';
}

// ── D-pad (mouse + touch) ─────────────────────────────────────

function initDpad() {
    const dpad = document.querySelector('.dpad');
    if (!dpad) return;

    let activeDir = null;
    let activeBtn = null;

    function startMove(dir, btn) {
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

    dpad.querySelectorAll('[data-direction]').forEach(btn => {
        const dir = btn.dataset.direction;

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

    const stopBtn = document.getElementById('btn-dpad-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => { stopMove(); mountAbort(); });
}

// ── Action buttons ─────────────────────────────────────────────

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
    bind('log-clear', clearLog);
    bind('log-copy', copyLog);

    // Sky chart follow toggle
    const followBtn = document.getElementById('sky-follow-btn');
    if (followBtn) {
        followBtn.addEventListener('click', () => {
            if (skyCanvas) {
                skyCanvas.followMode = !skyCanvas.followMode;
                followBtn.className = 'set-btn ' + (skyCanvas.followMode ? 'sky-follow-on' : 'sky-follow-off');
                followBtn.textContent = skyCanvas.followMode ? '\u25CE Suivre' : '\u25CE Libre';
                addLog('info', 'sky', skyCanvas.followMode ? 'Suivi télescope activé' : 'Suivi télescope désactivé');
            }
        });
    }

    // Sky chart center on telescope
    const centerBtn = document.getElementById('sky-center-btn');
    if (centerBtn) {
        centerBtn.addEventListener('click', () => {
            if (skyCanvas) {
                skyCanvas.centerOnTel();
                addLog('info', 'sky', 'Carte centrée sur le télescope');
            }
        });
    }

    // ── Site config popup ─────────────────────────────────────
    const siteOverlay = document.getElementById('site-popup-overlay');
    const siteBtn = document.getElementById('sky-site-btn');
    const siteClose = document.getElementById('site-popup-close');
    const siteCancel = document.getElementById('site-cancel-btn');
    const siteSave = document.getElementById('site-save-btn');
    const siteGps = document.getElementById('site-gps-btn');
    const siteName = document.getElementById('site-name');
    const siteLat = document.getElementById('site-lat');
    const siteLng = document.getElementById('site-lng');
    const siteElev = document.getElementById('site-elev');
    const siteTz = document.getElementById('site-tz');
    const citySearch = document.getElementById('site-city-search');
    const cityResults = document.getElementById('site-city-results');

    function openSitePanel() {
        // Pre-fill from current config
        fetch('/api/site').then(r => r.json()).then(site => {
            siteName.value = site.name || '';
            siteLat.value = site.latitude ?? '';
            siteLng.value = site.longitude ?? '';
            siteElev.value = site.elevation ?? '';
            // Match timezone option
            const opt = siteTz.querySelector(`option[value="${site.timezone}"]`);
            if (opt) siteTz.value = site.timezone;
        }).catch(() => {});
        siteOverlay.style.display = 'flex';
        cityResults.style.display = 'none';
        citySearch.value = '';
    }

    function closeSitePanel() {
        siteOverlay.style.display = 'none';
    }

    if (siteBtn) siteBtn.addEventListener('click', openSitePanel);
    if (siteClose) siteClose.addEventListener('click', closeSitePanel);
    if (siteCancel) siteCancel.addEventListener('click', closeSitePanel);
    if (siteOverlay) siteOverlay.addEventListener('click', (e) => {
        if (e.target === siteOverlay) closeSitePanel();
    });

    // City search
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
                            siteLat.value = c.lat;
                            siteLng.value = c.lng;
                            siteElev.value = c.elev;
                            cityResults.style.display = 'none';
                            citySearch.value = c.name;
                        });
                        cityResults.appendChild(div);
                    });
                    cityResults.style.display = 'block';
                }).catch(() => { cityResults.style.display = 'none'; });
            }, 300);
        });
        // Close city results on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.site-city-row')) cityResults.style.display = 'none';
        });
    }

    // GPS
    if (siteGps) {
        siteGps.addEventListener('click', () => {
            if (!navigator.geolocation) { addLog('warning', 'site', 'Géolocalisation non supportée'); return; }
            siteGps.textContent = '⏳ Localisation...';
            siteGps.disabled = true;
            navigator.geolocation.getCurrentPosition(
                pos => {
                    siteLat.value = pos.coords.latitude.toFixed(4);
                    siteLng.value = pos.coords.longitude.toFixed(4);
                    siteElev.value = Math.round(pos.coords.altitude || 0);
                    siteGps.textContent = '📍 Géolocaliser (GPS)';
                    siteGps.disabled = false;
                    addLog('info', 'site', `GPS: ${pos.coords.latitude.toFixed(4)}°N ${pos.coords.longitude.toFixed(4)}°E ${Math.round(pos.coords.altitude || 0)}m`);
                },
                err => {
                    addLog('warning', 'site', `GPS échoué: ${err.message}`);
                    siteGps.textContent = '📍 Géolocaliser (GPS)';
                    siteGps.disabled = false;
                },
                { enableHighAccuracy: true, timeout: 15000 }
            );
        });
    }

    // Save
    if (siteSave) {
        siteSave.addEventListener('click', async () => {
            const body = {
                name: siteName.value.trim(),
                latitude: parseFloat(siteLat.value) || 0,
                longitude: parseFloat(siteLng.value) || 0,
                elevation: parseFloat(siteElev.value) || 0,
                timezone: siteTz.value,
            };
            try {
                await fetch('/api/site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                addLog('info', 'site', `Lieu sauvegardé: ${body.name || '(sans nom)'} ${body.latitude.toFixed(4)}°N ${body.longitude.toFixed(4)}°E ${body.elevation}m`);
                // Update sky chart horizon
                if (skyCanvas) {
                    skyCanvas.siteLat = body.latitude;
                    skyCanvas.siteLng = body.longitude;
                    skyCanvas.siteElev = body.elevation;
                }
                closeSitePanel();
            } catch (e) {
                addLog('error', 'site', `Erreur sauvegarde: ${e.message}`);
            }
        });
    }
}

// Keep property panel globals for dynamically generated inline handlers
window.setSwitchItem = setSwitchItem;
window.setNumberItem = setNumberItem;
window.setTextItem = setTextItem;
window.mountGoto = mountGoto;

// ── Init ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#log-filters input[type="checkbox"]').forEach(cb => cb.addEventListener('change', applyLogFilters));
    initResizer();
    initDpad();
    initButtons();
    initSkyCanvas();
    connectWS();
});
