// ═══════════════════════════════════════════════════════════════
// Noctua — Panneau monture + commandes
// Extraits d'app.js (script classique, globals partagés).
// Dépendances globales : device/skyEngine/_targetObject (state.js), apiPost/addLog (api.js), i18n (utils.js).
// ═══════════════════════════════════════════════════════════════

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
        slewingEl.style.color = d.slewing ? cssVar('--status-warning') : '#666';
    }

    const parkingEl = document.getElementById('status-parking');
    if (parkingEl) {
        const isParked = !!d.parked;
        const isBusy = d.park_state === 'Busy';
        if (isBusy) {
            parkingEl.textContent = '● ACTIVE';
            parkingEl.className = 'value status-parking';
            parkingEl.style.color = cssVar('--status-warning');
        } else {
            parkingEl.textContent = isParked ? '● PARKED' : '● UNPARKED';
            parkingEl.className = 'value ' + (isParked ? 'status-stopped' : 'status-online');
            parkingEl.style.color = isParked ? cssVar('--status-error') : cssVar('--status-online');
        }
    }

    const homingEl = document.getElementById('status-homing');
    if (homingEl) {
        homingEl.textContent = d.homing ? '● ACTIVE' : '● IDLE';
        homingEl.className = 'value ' + (d.homing ? 'status-parking' : '');
        homingEl.style.color = d.homing ? cssVar('--status-warning') : '#666';
    }

    const busy = d.park_state === 'Busy' || d.slewing || d.homing;
    ['btn-goto', 'btn-park', 'btn-unpark', 'btn-home'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });

    if (d.props) {
        const statusProp = d.props.find(p => p.name === 'OnStep Status');
        // OnStep status currently not in an applet, could be added later

        const slewProp = d.props.find(p => p.name === 'MOUNT_SLEW_RATE' || p.name === 'TELESCOPE_SLEW_RATE');
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

    renderFlipPanel(d);
}

function renderFlipPanel(d) {
    const flipPanel = document.getElementById('flip-panel');
    if (!flipPanel) return;
    const flip = d.flip || {};
    const statusEl = document.getElementById('flip-status');
    const enabledEl = document.getElementById('flip-enabled');
    const marginEl = document.getElementById('flip-margin');
    const minAltEl = document.getElementById('flip-min-alt');

    if (enabledEl && document.activeElement !== enabledEl) {
        enabledEl.checked = !!flip.enabled;
    }
    if (marginEl && document.activeElement !== marginEl && flip.hour_angle_margin != null) {
        marginEl.value = flip.hour_angle_margin;
    }
    if (minAltEl && document.activeElement !== minAltEl && flip.min_altitude != null) {
        minAltEl.value = flip.min_altitude;
    }

    if (statusEl) {
        const ha = flip.ha_fmt || '---';
        const ttf = flip.time_to_flip_fmt || '---';
        if (flip.flip_due) {
            statusEl.textContent = `⚠ FLIP DUE (${flip.flip_side || ''}) — HA ${ha}`;
            statusEl.style.color = cssVar('--status-offline');
            statusEl.style.fontWeight = 'bold';
            statusEl.classList.add('flip-due');
        } else {
            statusEl.textContent = `HA ${ha} (${flip.flip_side || ''}) — ${ttf}`;
            statusEl.style.color = '#888';
            statusEl.style.fontWeight = 'normal';
            statusEl.classList.remove('flip-due');
        }
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

// ── Mount commands ────────────────────────────────────────────

function setTargetObject(obj) {
    if (!obj || obj.ra == null || obj.dec == null) { _targetObject = null; return; }
    _targetObject = {
        ra: obj.ra, dec: obj.dec,
        id: obj.id || obj.name || '',
        name: obj.name || obj.id || '',
    };
    const info = document.getElementById('target-info');
    if (info) {
        const raH = (((_targetObject.ra % 360) + 360) % 360) / 15;
        const dec = _targetObject.dec;
        info.textContent = `Cible : ${_targetObject.id}  RA ${raH.toFixed(2)}h  DEC ${dec >= 0 ? '+' : ''}${dec.toFixed(2)}°`;
    }
    if (skyEngine) {
        skyEngine.clearHighlight();
        skyEngine.highlightObject(_targetObject.ra, _targetObject.dec, _targetObject.id);
    }
    // Show the 24h visibility popup for the chosen target.
    if (typeof showVisibility === 'function') {
        showVisibility(_targetObject);
    }
}

function mountGoto() {
    if (!_targetObject) {
        addLog('warning', 'mount', i18n('log.mount.no_target'));
        return;
    }
    const m = findMount();
    if (!m) {
        addLog('error', 'mount', 'Pas de monture detectee');
        return;
    }
    const raH = (((_targetObject.ra % 360) + 360) % 360) / 15;
    const target = { ra_hours: raH, dec_deg: _targetObject.dec };
    fetch('/api/mount/slew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target)
    }).then(r => r.json()).then(data => {
        if (data.error) {
            addLog('error', 'mount', i18nFmt('log.ws.error', { err: data.error }));
            return;
        }
        addLog('info', 'mount', i18nFmt('log.mount.goto_ok', { id: _targetObject.id, ra: raH.toFixed(4), dec: _targetObject.dec.toFixed(4) }));
    }).catch(e => {
        addLog('error', 'mount', i18nFmt('log.ws.error', { err: e.message }));
    });
}

function mountMove(dir) {
    const m = findMount();
    if (!m) { addLog('error', 'mount', 'Pas de monture detectee'); return; }
    if (m.dev.parked) { addLog('warning', 'mount', 'Monture parquée — déparquez d\'abord (UNPARK)'); return; }
    const speed = document.getElementById('slew-speed')?.value;
    addLog('debug', 'mount', i18nFmt('log.mount.move_rate', { dir, speed }));
    apiPost('/api/mount/move', { direction: dir, rate: speed || undefined });
}

function mountHaltMove() {
    addLog('debug', 'mount', i18n('log.mount.halt_move'));
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

function mountFlip() {
    addLog('info', 'mount', i18n('log.mount.flip_trigger'));
    fetch('/api/mount/flip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => r.json())
        .then(res => {
            if (res.error) { addLog('error', 'mount', i18nFmt('log.mount.flip_failed', { err: res.error })); return; }
            const phases = (res.phases || []).join(' → ');
            addLog('info', 'mount', i18nFmt('log.mount.flip_ok', { phases }));
        })
        .catch(e => addLog('error', 'mount', i18nFmt('log.mount.flip_net', { err: e })));
}

// ── Hub : consommateur ws:state ───────────────────────────────
// Met à jour le FoV caméra sur le ciel + panneau monture
// (auto-sélection quand une monture apparaît, sinon si déjà choisie).

let _lastMountSeen = false;
let _lastSlewing = false;
Hub.subscribe('ws:state', 'mount', (env) => {
    updateCameraFov();
    const m = findMount();
    if (m) {
        // Détection de fin de slew (transition slewing→idle) → mount:slewed.
        const nowSlewing = !!m.dev.slewing;
        if (_lastSlewing && !nowSlewing) {
            Hub.emit('mount:slewed', { ra: m.dev.ra_hours, dec: m.dev.dec_deg }, { source: 'mount' });
        }
        _lastSlewing = nowSlewing;
    }
    if (m && !_lastMountSeen) {
        selectedDevice = m.name;
        renderMountPanel();
    } else if (selectedDevice && devices[selectedDevice] && devices[selectedDevice].type === 'mount') {
        renderMountPanel();
    }
    _lastMountSeen = !!m;
});

function saveFlipConfig() {
    const enabled = !!document.getElementById('flip-enabled')?.checked;
    const margin = parseFloat(document.getElementById('flip-margin')?.value) || 0;
    const minAlt = parseFloat(document.getElementById('flip-min-alt')?.value) || 0;
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telescope: {
            flip_enabled: enabled,
            hour_angle_margin: margin,
            min_altitude: minAlt,
        } }),
    }).catch(e => addLog('warning', 'mount', i18nFmt('log.mount.flip_cfg', { err: e })));
}

// ── Property panel (generic) ──────────────────────────────────
