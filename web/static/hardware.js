// ═══════════════════════════════════════════════════════════════
// Noctua — hardware.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Hardware panel + profiles ────────────────────────────────────

const HW_ROLES = [
    ['mount', 'hw.role_mount'],
    ['camera', 'hw.role_camera'],
    ['guide_camera', 'hw.role_guide_camera'],
    ['focuser', 'hw.role_focuser'],
    ['filter_wheel', 'hw.role_filter_wheel'],
];
const HW_ROLE_TYPES = {
    mount: ['mount'],
    camera: ['camera'],
    guide_camera: ['camera'],
    focuser: ['focuser'],
    filter_wheel: ['filterwheel'],
};
const HW_ROLE_FIELDS = ['mount', 'camera', 'guide_camera', 'focuser', 'filter_wheel'];
const HW_ICONS = { mount: '🔭', camera: '📷', focuser: '🔍', filterwheel: '🎨', generic: '⚙️' };

let _hwDevices = {};
let _hwProfiles = { active: null, profiles: [] };

function hwActiveProfile() {
    if (!_hwProfiles.profiles) return null;
    return _hwProfiles.profiles.find(p => p.name === _hwProfiles.active) || null;
}

async function hwLoad() {
    try {
        const data = await fetch('/api/hardware').then(r => r.json());
        _hwDevices = data.devices || {};
        _hwProfiles = data.profiles || { active: null, profiles: [] };
    } catch (e) { addLog('error', 'hw', e.message); }
}

function renderHardwarePanel() {
    const list = document.getElementById('hw-device-list');
    const sel = document.getElementById('hw-profile-select');
    if (!list || !sel) return;

    // Profiles dropdown
    const activeName = _hwProfiles?.active || '';
    sel.innerHTML = '';
    const profiles = _hwProfiles.profiles || [];
    if (!profiles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = i18n('hw.no_profile');
        sel.appendChild(opt);
    } else {
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            sel.appendChild(opt);
        }
    }
    sel.value = activeName;

    // Optics (only when not focused)
    const opticsInput = document.getElementById('hw-optics');
    const ap = hwActiveProfile();
    if (opticsInput && opticsInput !== document.activeElement) {
        opticsInput.value = ap?.optics || '';
    }

    // Device rows
    list.innerHTML = '';
    const names = Object.keys(_hwDevices);
    if (!names.length) {
        list.innerHTML = `<div style="color:#555; font-size:0.6rem; padding:4px;">${i18n('hw.no_devices')}</div>`;
        return;
    }
    for (const name of names) {
        const d = _hwDevices[name];
        const icon = HW_ICONS[d.type] || HW_ICONS.generic;
        const row = document.createElement('div');
        row.className = 'hw-device';
        row.innerHTML =
            `<span class="hw-icon">${icon}</span>` +
            `<span class="hw-name" title="${escapeAttr(name)}">${escapeHTML(name)}</span>` +
            `<span class="hw-status ${d.connected ? 'on' : 'off'}">${d.connected ? i18n('hw.connected') : i18n('hw.offline')}</span>` +
            `<button class="btn-glass ${d.connected ? 'danger' : 'success'}" data-action="${d.connected ? 'disconnect' : 'connect'}" data-device="${escapeAttr(name)}">${d.connected ? i18n('hw.dec') : i18n('hw.conn')}</button>`;
        list.appendChild(row);
    }

    // Server connection status
    fetch('/api/connection').then(r => r.json()).then(data => {
        const el = document.getElementById('hw-conn-status');
        if (el) {
            el.textContent = data.connected ? i18n('hw.server_connected') : i18n('hw.offline');
            el.className = data.connected ? 'status-online' : 'status-offline';
        }
    }).catch(() => {});

    renderHardwareRoles();
}

// Per-role selectors: for each role, list the detected devices compatible with it.
function renderHardwareRoles() {
    const container = document.getElementById('hw-role-assign');
    if (!container) return;
    const ap = hwActiveProfile();
    const fields = HW_ROLE_FIELDS;
    container.innerHTML = '';
    for (const f of fields) {
        const label = i18n(HW_ROLES.find(([r]) => r === f)?.[1] || 'hw.role_mount');
        const types = HW_ROLE_TYPES[f] || [];
        const candidates = Object.keys(_hwDevices)
            .filter(name => types.includes(_hwDevices[name].type))
            .sort();
        const opts = [`<option value="">${i18n('hw.none')}</option>`];
        for (const name of candidates) {
            opts.push(`<option value="${escapeAttr(name)}" ${ap?.[f] === name ? 'selected' : ''}>${escapeHTML(name)}</option>`);
        }
        const row = document.createElement('div');
        row.className = 'hw-row';
        row.innerHTML =
            `<span class="hw-label">${escapeHTML(label)}:</span>` +
            `<select class="hw-role-select" data-role="${f}">${opts.join('')}</select>`;
        container.appendChild(row);
    }
}

async function hwAssignRole(role, name) {
    let ap = hwActiveProfile();
    if (!ap) {
        const profName = prompt(i18n('hw.prompt_no_profile'), 'Rig');
        if (!profName) { renderHardwarePanel(); return; }
        await fetch('/api/profiles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: profName }),
        });
        await fetch('/api/profiles/activate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: profName }),
        });
        await hwLoad();
        ap = hwActiveProfile();
        if (!ap) { renderHardwarePanel(); return; }
    }
    const update = { name: ap.name };
    for (const f of HW_ROLE_FIELDS) update[f] = ap[f] || null;
    if (update[role] === name) name = '';      // selecting the same device again → unassign
    for (const f of HW_ROLE_FIELDS) {
        if (update[f] === name) update[f] = null;
    }
    update[role] = name;
    update.optics = ap.optics || '';
    await fetch('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
    });
    await hwLoad();
    renderHardwarePanel();
}

function initHardwarePanel() {
    const sel = document.getElementById('hw-profile-select');
    const newBtn = document.getElementById('hw-profile-new');
    const saveBtn = document.getElementById('hw-profile-save');
    const delBtn = document.getElementById('hw-profile-delete');
    const applyBtn = document.getElementById('hw-profile-apply');
    const list = document.getElementById('hw-device-list');
    const optics = document.getElementById('hw-optics');
    const connectAll = document.getElementById('hw-connect-all');
    const disconnectAll = document.getElementById('hw-disconnect-all');
    const refreshBtn = document.getElementById('hw-refresh');

    if (sel) sel.addEventListener('change', async () => {
        if (!sel.value) return;
        await fetch('/api/profiles/activate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sel.value }),
        });
        await hwLoad();
        renderHardwarePanel();
    });

    if (newBtn) newBtn.addEventListener('click', async () => {
        const name = prompt(i18n('hw.prompt_new'), '');
        if (!name) return;
        const ap = hwActiveProfile() || {};
        const body = { name };
        for (const f of HW_ROLE_FIELDS) body[f] = ap[f] || null;
        body.optics = ap.optics || '';
        await fetch('/api/profiles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        await fetch('/api/profiles/activate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        await hwLoad();
        renderHardwarePanel();
        addLog('info', 'hw', i18nFmt('log.hw.profile_created', { name }));
    });

    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const ap = hwActiveProfile();
        if (!ap) { addLog('warning', 'hw', i18n('log.hw.no_active_save')); return; }
        const body = { name: ap.name };
        for (const f of HW_ROLE_FIELDS) body[f] = ap[f] || null;
        body.optics = ap.optics || '';
        await fetch('/api/profiles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        await hwLoad();
        renderHardwarePanel();
        addLog('info', 'hw', i18nFmt('log.hw.profile_saved', { name: ap.name }));
    });

    if (delBtn) delBtn.addEventListener('click', async () => {
        const ap = hwActiveProfile();
        if (!ap) return;
        if (!confirm(i18nFmt('hw.confirm_delete', { name: ap.name }))) return;
        await fetch('/api/profiles/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ap.name }),
        });
        await hwLoad();
        renderHardwarePanel();
        addLog('info', 'hw', i18nFmt('log.hw.profile_deleted', { name: ap.name }));
    });

    if (applyBtn) applyBtn.addEventListener('click', async () => {
        const ap = hwActiveProfile();
        if (!ap) { addLog('warning', 'hw', i18n('log.hw.no_profile_apply')); return; }
        addLog('info', 'hw', i18nFmt('log.hw.profile_applying', { name: ap.name }));
        const res = await fetch('/api/profiles/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ap.name }),
        }).then(r => r.json()).catch(() => null);
        await hwLoad();
        renderHardwarePanel();
        if (res?.ok) addLog('info', 'hw', i18nFmt('log.hw.profile_applied', { name: ap.name }));
        else if (res?.error) addLog('error', 'hw', i18nFmt('log.ws.error', { err: res.error }));
    });

    if (list) list.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const device = btn.dataset.device;
        const action = btn.dataset.action;
        const res = await fetch(`/api/hardware/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device }),
        }).then(r => r.json()).catch(() => null);
        if (res?.error) addLog('error', 'hw', i18nFmt('log.hw.device_error', { device, err: res.error }));
        await hwLoad();
        renderHardwarePanel();
    });

    const roleAssign = document.getElementById('hw-role-assign');
    if (roleAssign) roleAssign.addEventListener('change', async (e) => {
        const sel = e.target.closest('.hw-role-select');
        if (!sel) return;
        await hwAssignRole(sel.dataset.role, sel.value);
    });

    if (optics) optics.addEventListener('change', async () => {
        const ap = hwActiveProfile();
        if (!ap) return;
        const body = { name: ap.name };
        for (const f of HW_ROLE_FIELDS) body[f] = ap[f] || null;
        body.optics = optics.value.trim();
        await fetch('/api/profiles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        await hwLoad();
    });

    if (connectAll) connectAll.addEventListener('click', async () => {
        const res = await fetch('/api/hardware/connect-all', { method: 'POST' })
            .then(r => r.json()).catch(() => null);
        await hwLoad();
        renderHardwarePanel();
        if (res?.ok) addLog('info', 'hw', i18n('log.hw.connect_all'));
    });

    if (disconnectAll) disconnectAll.addEventListener('click', async () => {
        const res = await fetch('/api/hardware/disconnect-all', { method: 'POST' })
            .then(r => r.json()).catch(() => null);
        await hwLoad();
        renderHardwarePanel();
        if (res?.ok) addLog('info', 'hw', i18n('log.hw.disconnect_all'));
    });

    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
        await hwLoad();
        renderHardwarePanel();
    });

    hwLoad().then(() => renderHardwarePanel());
}

// ── Hardware mode (mode dédié, grand panneau) ────────────────

function renderHardwareMode() {
    const container = document.getElementById('applet-hardware-mode');
    if (!container) return;

    // Device selector + properties
    const devSel = document.getElementById('hw-mode-device-select');
    if (devSel) {
        const prev = devSel.value;
        devSel.innerHTML = `<option value="">${i18n('hw.select_device')}</option>`;
        const names = Object.keys(_hwDevices);
        if (names.length && (!_hwModeDevice || !names.includes(_hwModeDevice))) {
            _hwModeDevice = names.includes('Mount') ? 'Mount' : names[0];
        }
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${_hwDevices[name].type})`;
            devSel.appendChild(opt);
        }
        if (names.includes(_hwModeDevice)) devSel.value = _hwModeDevice;
        else if (prev && names.includes(prev)) { devSel.value = prev; _hwModeDevice = prev; }
    }

    renderHardwareModeProps();
}

function renderHardwareModeProps() {
    const propsEl = document.getElementById('hw-mode-props');
    if (!propsEl) return;
    if (document.activeElement && propsEl.contains(document.activeElement)) return;
    if (!_hwModeDevice || !devices[_hwModeDevice]) {
        propsEl.innerHTML = `<div style="color:#555; font-size:0.65rem; padding:6px;">${i18n('hw.select_hint')}</div>`;
        return;
    }
    const html = buildPropsHTML(_hwModeDevice);
    propsEl.innerHTML = html || `<div style="color:#555; font-size:0.65rem; padding:6px;">${i18n('hw.no_props')}</div>`;
}

function initHardwareMode() {
    const devSel = document.getElementById('hw-mode-device-select');
    if (devSel) devSel.addEventListener('change', () => {
        _hwModeDevice = devSel.value || null;
        renderHardwareModeProps();
    });
}

// ── Bus ───────────────────────────────────────────────────────

// Consommateur ws:state : reconstruit _hwDevices et rend les panneaux.
let _hwPrevDevices = {};
const _hubTimers = {};
const HUB_CONFIRM_MS = 1200;
Bus.on('ws:state', (env) => {
    const next = {};
    for (const [n, d] of Object.entries(env.payload.devices)) {
        next[n] = { name: n, type: d.type, connected: !!d.connected };
    }
    if (typeof Hub !== 'undefined') {
        for (const [n, d] of Object.entries(env.payload.devices)) {
            const prev = _hwPrevDevices[n];
            if (d.connected && !(prev && prev.connected)) {
                clearTimeout(_hubTimers[n]);
                const name = n, type = d.type;
                const sensor = {
                    width_px: d.width_px || 0,
                    height_px: d.height_px || 0,
                    pixel_size_um: d.pixel_size_um || 0,
                    focal_length_mm: d.focal_length_mm || 0,
                };
                _hubTimers[n] = setTimeout(() => {
                    delete _hubTimers[name];
                    const cur = _hwPrevDevices[name];
                    if (cur && cur.connected) {
                        Hub.emit('device:connected', { name, type, sensor }, { source: 'hardware' });
                    }
                }, HUB_CONFIRM_MS);
            } else if (!d.connected && _hubTimers[n]) {
                clearTimeout(_hubTimers[n]);
                delete _hubTimers[n];
            }
        }
        for (const n of Object.keys(_hubTimers)) {
            if (!(n in next)) {
                clearTimeout(_hubTimers[n]);
                delete _hubTimers[n];
            }
        }
    }
    _hwPrevDevices = next;
    _hwDevices = next;
    renderHardwarePanel();
    renderHardwareMode();
});

// Consommateur mode:changed : rafraîchit le mode matériel à l'entrée.
Bus.on('mode:changed', (env) => {
    if (env.payload.mode === 'hardware') renderHardwareMode();
});
