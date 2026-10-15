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
let _hwDriversGrouped = {};
let _hwDriversFlat = [];
let _hwSelectedDriver = null;
let _hwSerialPorts = null;
let _hwSerialLastFetch = 0;

const HW_DRIVER_CATEGORY_ORDER = ['mount', 'camera', 'guide_camera', 'focuser', 'filter_wheel', 'dome', 'gps', 'rotator', 'aux', 'ao', 'agent', 'system', 'other'];
const HW_DRIVER_CATEGORY_ICONS = { mount: '🔭', camera: '📷', guide_camera: '🎯', focuser: '🔍', filter_wheel: '🎨', dome: '🏠', gps: '📍', rotator: '🔄', aux: '🔌', ao: '🌊', agent: '🤖', system: '⚙️', other: '📦' };

function hwActiveProfile() {
    if (!_hwProfiles.profiles) return null;
    return _hwProfiles.profiles.find(p => p.name === _hwProfiles.active) || null;
}

async function hwLoad(opts = {}) {
    try {
        const data = await fetch('/api/hardware').then(r => r.json());
        _hwDevices = data.devices || {};
        _hwProfiles = data.profiles || { active: null, profiles: [] };
        addLog('info', 'hw', i18nFmt('log.hw.devices_loaded', { n: Object.keys(_hwDevices).length }));
    } catch (e) { addLog('error', 'hw', e.message); }
    await hwLoadDrivers();
    if (opts.rescanSerial !== false) {
        hwScanSerialPorts({ silent: true }).catch(() => {});
    }
}

// ── Serial port scan (shared by connection bar + hardware panel) ──
async function hwScanSerialPorts({ force = false, silent = false } = {}) {
    const now = Date.now();
    if (!force && _hwSerialPorts && now - _hwSerialLastFetch < 3000) return _hwSerialPorts;
    try {
        const data = await fetch('/api/serial/ports').then(r => r.json());
        _hwSerialPorts = data;
        _hwSerialLastFetch = now;
        hwFillSerialDatalist(data);
        hwRenderSerialHint(data);
        if (!silent) {
            const n = (data.ports || []).length;
            addLog('info', 'hw', n ? i18nFmt('hw.serial_found', { n }) : i18n('hw.serial_none'));
        }
        return data;
    } catch (e) {
        if (!silent) addLog('error', 'hw', e.message);
        return null;
    }
}

function hwFillSerialDatalist(data) {
    const list = document.getElementById('serial-port-list');
    if (!list) return;
    list.innerHTML = '';
    const seen = new Set();
    for (const p of data?.ports || []) {
        for (const path of [p.preferred, p.path, ...(p.by_id || [])]) {
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const opt = document.createElement('option');
            opt.value = path;
            const bits = [];
            if (p.description) bits.push(p.description);
            if (p.busy) {
                bits.push(i18nFmt('hw.serial_busy', { pids: (p.holders || []).join(',') }));
            }
            if (p.preferred && path === p.preferred && path !== p.path) bits.push('stable');
            opt.label = bits.join(' · ') || path;
            list.appendChild(opt);
        }
    }
    const profPath = data?.profile?.mount_endpoint;
    if (profPath && !seen.has(profPath) && profPath.startsWith('/dev/')) {
        const opt = document.createElement('option');
        opt.value = profPath;
        opt.label = 'profil (absent)';
        list.appendChild(opt);
    }
}

function hwRenderSerialHint(data) {
    const hint = document.getElementById('hw-serial-hint');
    if (!hint) return;
    const prof = data?.profile;
    const n = (data?.ports || []).length;
    if (prof?.mount_endpoint && prof.exists === false) {
        hint.textContent = i18nFmt('hw.serial_stale', { port: prof.mount_endpoint });
        hint.style.color = '#ff8844';
        return;
    }
    if (prof?.mount_endpoint && prof.exists) {
        hint.textContent = i18nFmt('hw.serial_ok', { port: prof.mount_endpoint });
        hint.style.color = n ? '#88ff88' : '#666';
        return;
    }
    hint.textContent = n ? i18nFmt('hw.serial_found', { n }) : i18n('hw.serial_none');
    hint.style.color = '#666';
}

// Détecte un mélange HTML/JS obsolète (cache navigateur) : si un id
// attendu du panneau DEVICES manque, les listes resteraient vides
// sans aucune erreur — on le signale explicitement.
function hwCheckDom() {
    const expected = ['hw-profile-select', 'hw-driver-select', 'hw-driver-attach',
        'hw-driver-detach', 'hw-drivers-refresh', 'hw-device-list', 'hw-tabs',
        'hw-tab-devices', 'hw-driver-selected'];
    const missing = expected.filter(id => !document.getElementById(id));
    if (missing.length) {
        addLog('error', 'hw', i18nFmt('log.hw.dom_stale', { ids: missing.join(', ') }));
    }
}

async function hwLoadDrivers() {
    // 1️⃣ Sélection — liste structurée par catégorie depuis le backend.
    try {
        const grouped = await fetch('/api/drivers/grouped').then(r => r.json());
        if (grouped && typeof grouped === 'object' && !Array.isArray(grouped)) {
            _hwDriversGrouped = grouped;
            _hwDriversFlat = [];
            for (const [cat, arr] of Object.entries(grouped)) {
                for (const d of (arr || [])) _hwDriversFlat.push(d);
            }
            addLog('info', 'hw', i18nFmt('log.hw.drivers_loaded', { n: _hwDriversFlat.length, c: Object.keys(grouped).length }));
            return;
        }
        throw new Error('réponse drivers/grouped inattendue');
    } catch (e) {
        addLog('error', 'hw', i18nFmt('log.hw.drivers_error', { err: e.message }));
    }
    try {
        const flat = await fetch('/api/drivers').then(r => r.json());
        _hwDriversFlat = Array.isArray(flat) ? flat : [];
        _hwDriversGrouped = {};
        for (const d of _hwDriversFlat) {
            const cat = d.category || 'other';
            if (!_hwDriversGrouped[cat]) _hwDriversGrouped[cat] = [];
            _hwDriversGrouped[cat].push(d);
        }
    } catch (e2) { _hwDriversFlat = []; _hwDriversGrouped = {}; }
}

function hwSelectDriver(name) {
    _hwSelectedDriver = name || null;
    updateHwDriverInfo();
    const sel = document.getElementById('hw-driver-select');
    if (sel && _hwSelectedDriver && sel.value !== _hwSelectedDriver) {
        sel.value = _hwSelectedDriver;
    }
}

// Droplist arborescente : UN seul <select> avec <optgroup> par classe.
// Pas d'état inter-sélecteurs à synchroniser : simple et robuste.
let _hwDriverSelSig = null;

function hwDriverSelSig() {
    return Object.keys(_hwDriversGrouped).sort().map(c =>
        `${c}:${(_hwDriversGrouped[c] || []).map(d => d.name + '=' + (d.loaded ? 1 : 0)).join(',')}`
    ).join('|') + '##' + (_hwSelectedDriver || '');
}

function renderHwDrivers() {
    const sel = document.getElementById('hw-driver-select');
    if (!sel) return;
    // Ne jamais reconstruire pendant que l'utilisateur a la liste ouverte
    // (le focus reste sur le select) : sinon le menu se referme à chaque
    // broadcast ws:state. Idem si rien n'a changé.
    if (document.activeElement === sel) return;
    const sig = hwDriverSelSig();
    if (sig === _hwDriverSelSig && sel.options.length) return;
    _hwDriverSelSig = sig;
    const cats = Object.keys(_hwDriversGrouped).sort((a, b) =>
        HW_DRIVER_CATEGORY_ORDER.indexOf(a) - HW_DRIVER_CATEGORY_ORDER.indexOf(b));
    const prev = _hwSelectedDriver || sel.value || null;
    sel.innerHTML = '';
    if (!cats.length || !_hwDriversFlat.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = i18n('hw.no_drivers');
        sel.appendChild(opt);
        _hwSelectedDriver = null;
        updateHwDriverInfo();
        return;
    }
    for (const cat of cats) {
        const arr = (_hwDriversGrouped[cat] || []).slice().sort((a, b) =>
            (a.label || a.name).localeCompare(b.label || b.name));
        if (!arr.length) continue;
        const icon = HW_DRIVER_CATEGORY_ICONS[cat] || '📦';
        const og = document.createElement('optgroup');
        og.label = `${icon} ${cat} (${arr.length})`;
        for (const d of arr) {
            const opt = document.createElement('option');
            opt.value = d.name;
            opt.textContent = `${d.loaded ? '● ' : '○ '}${d.label || d.name}`;
            og.appendChild(opt);
        }
        sel.appendChild(og);
    }
    if (prev && _hwDriversFlat.some(d => d.name === prev)) sel.value = prev;
    else sel.selectedIndex = 0;
    _hwSelectedDriver = sel.value || null;
    updateHwDriverInfo();
}

function updateHwDriverInfo() {
    const el = document.getElementById('hw-driver-selected');
    if (!el) return;
    const d = _hwDriversFlat.find(x => x.name === _hwSelectedDriver);
    if (!d) { el.textContent = '—'; return; }
    const icon = HW_DRIVER_CATEGORY_ICONS[d.category] || '📦';
    el.textContent = `${icon} ${d.label || d.name} — ${d.name} [${d.category || '?'}] ${d.loaded ? '● chargé' : '○ non chargé'}`;
    el.style.color = d.loaded ? '#44cc44' : '#00ffcc';
    const attachBtn = document.getElementById('hw-driver-attach');
    if (attachBtn) {
        attachBtn.disabled = !!d.loaded;
        attachBtn.style.opacity = d.loaded ? '0.4' : '';
        attachBtn.title = d.loaded ? i18n('hw.driver_loaded_tip') : i18n('hw.driver_load');
    }
    const detachBtn = document.getElementById('hw-driver-detach');
    if (detachBtn) {
        detachBtn.disabled = !d.loaded;
        detachBtn.style.opacity = d.loaded ? '' : '0.4';
        detachBtn.title = d.loaded ? i18n('hw.driver_unload') : i18n('hw.driver_unloaded_tip');
    }
}

async function hwDriverLoadedFlag(name) {
    try {
        const flat = await fetch('/api/drivers').then(r => r.json());
        const d = (Array.isArray(flat) ? flat : []).find(x => x.name === name);
        return d ? !!d.loaded : null; // null = absent du vecteur
    } catch (e) { return undefined; }
}

// Vérifie que le serveur a vraiment (dé)chargé : l'endpoint ne fait
// qu'envoyer l'ordre (fire-and-forget), et le serveur peut refuser
// (ex. drivers fixés au démarrage d'indigo_server, non déchargeables).
async function hwWaitDriverState(name, expectLoaded, timeoutMs = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 1500));
        const flag = await hwDriverLoadedFlag(name);
        if (expectLoaded && flag === true) return true;
        if (!expectLoaded && (flag === false || flag === null)) return true;
    }
    return false;
}

async function hwAttachDriver(name) {
    const target = name || _hwSelectedDriver;
    if (!target) { addLog('warning', 'hw', i18n('hw.driver_select_first')); return; }
    // 2️⃣ Chargement (attach) — charge le driver côté serveur INDIGO.
    addLog('info', 'hw', i18nFmt('log.hw.driver_loading', { driver: target }));
    try {
        const res = await fetch('/api/drivers/attach', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driver: target }),
        }).then(r => r.json());
        if (res?.ok) {
            if (await hwWaitDriverState(target, true)) {
                addLog('info', 'hw', i18nFmt('log.hw.driver_loaded', { driver: target }));
            } else {
                addLog('error', 'hw', i18nFmt('log.hw.driver_not_loaded', { driver: target }));
            }
            await hwLoadDrivers();
            await hwLoadDevicesOnly();
            renderHardwarePanel();
        } else {
            addLog('error', 'hw', i18nFmt('log.hw.driver_error', { driver: target, err: res?.error || '?' }));
        }
    } catch (e) {
        addLog('error', 'hw', i18nFmt('log.hw.driver_error', { driver: target, err: e.message }));
    }
}

async function hwDetachDriver(name) {
    const target = name || _hwSelectedDriver;
    if (!target) { addLog('warning', 'hw', i18n('hw.driver_select_first')); return; }
    if (!confirm(i18nFmt('hw.driver_confirm_unload', { driver: target }))) return;
    addLog('info', 'hw', i18nFmt('log.hw.driver_unloading', { driver: target }));
    try {
        const res = await fetch('/api/drivers/detach', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driver: target }),
        }).then(r => r.json());
        if (res?.ok) {
            if (await hwWaitDriverState(target, false)) {
                addLog('info', 'hw', i18nFmt('log.hw.driver_unloaded', { driver: target }));
            } else {
                addLog('error', 'hw', i18nFmt('log.hw.driver_refused', { driver: target }));
            }
            await hwLoadDrivers();
            await hwLoadDevicesOnly();
            renderHardwarePanel();
        } else {
            addLog('error', 'hw', i18nFmt('log.hw.driver_error', { driver: target, err: res?.error || '?' }));
        }
    } catch (e) {
        addLog('error', 'hw', i18nFmt('log.hw.driver_error', { driver: target, err: e.message }));
    }
}

async function hwLoadDevicesOnly() {
    try {
        const data = await fetch('/api/hardware').then(r => r.json());
        _hwDevices = data.devices || {};
    } catch (e) { /* silencieux */ }
}

function renderConnLeds() {
    const el = document.getElementById('conn-device-leds');
    if (!el) return;
    el.innerHTML = '';
    const ap = typeof hwActiveProfile === 'function' ? hwActiveProfile() : null;
    const order = ['mount', 'camera', 'guide_camera', 'focuser', 'filter_wheel'];
    let shown = 0;
    for (const role of order) {
        const types = HW_ROLE_TYPES[role] || [];
        let name = null, connected = false;
        if (ap && ap[role] && _hwDevices[ap[role]]) { name = ap[role]; connected = !!_hwDevices[name].connected; }
        else {
            const cand = Object.keys(_hwDevices).find(n => types.includes(_hwDevices[n].type));
            if (cand) { name = cand; connected = !!_hwDevices[cand].connected; }
        }
        // Toujours afficher T C A F R/W en neutre (gris) → vert quand connecté
        const isEn = (typeof I18N !== 'undefined' && I18N.current === 'en');
        const letter = { mount: 'T', camera: 'C', guide_camera: 'A', focuser: 'F', filter_wheel: isEn ? 'W' : 'R' }[role] || '?';
        const item = document.createElement('span');
        item.className = 'conn-led-item';
        const titleName = name || letter;
        item.title = name ? `${name} — ${connected ? 'connecté' : 'hors ligne'}` : `${letter} — non assigné`;
        const dot = document.createElement('span');
        dot.className = 'conn-led ' + (connected ? 'on' : 'off');
        const lab = document.createElement('span');
        lab.className = 'conn-led-label';
        lab.textContent = letter;
        item.appendChild(dot);
        item.appendChild(lab);
        el.appendChild(item);
    }
}

// Roles compatibles avec un type de device (générique : mount/camera/…,
// sans nom de modèle — LX200, OnStep, EQ6… passent par type=mount).
function hwRolesForType(type) {
    return HW_ROLE_FIELDS.filter(f => (HW_ROLE_TYPES[f] || []).includes(type));
}

function hwRoleLabel(role) {
    return i18n(HW_ROLES.find(([r]) => r === role)?.[1] || 'hw.role_mount');
}

// Rôle courant du device dans le profil actif (null si non assigné).
function hwCurrentRole(deviceName) {
    const ap = hwActiveProfile();
    if (!ap) return null;
    for (const f of HW_ROLE_FIELDS) {
        if (ap[f] === deviceName) return f;
    }
    return null;
}

// Endpoint affiché uniquement sur la ligne du device « monture »
// (type mount OU rôle mount assigné) — reste générique pour toute marque.
function hwShowEndpointCell(deviceName, d) {
    if (d?.type === 'mount') return true;
    return hwCurrentRole(deviceName) === 'mount';
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

    // Tableur : une ligne = un device INDIGO (rôle + endpoint inline)
    list.innerHTML = '';
    const names = Object.keys(_hwDevices);
    if (!names.length) {
        list.innerHTML = `<div style="color:#555; font-size:0.6rem; padding:4px;">${i18n('hw.no_devices')}</div>`;
    } else {
        const curIf = ap?.mount_interface || 'serial';
        const curEp = ap?.mount_endpoint || '';
        for (const name of names) {
            const d = _hwDevices[name];
            const icon = HW_ICONS[d.type] || HW_ICONS.generic;
            const row = document.createElement('div');
            row.className = 'hw-device';
            row.dataset.device = name;

            const roleNow = hwCurrentRole(name);
            const roles = hwRolesForType(d.type);
            let roleOpts = `<option value="">${i18n('hw.none')}</option>`;
            for (const r of roles) {
                roleOpts += `<option value="${r}" ${roleNow === r ? 'selected' : ''}>${escapeHTML(hwRoleLabel(r))}</option>`;
            }

            let epHtml = `<span class="hw-ep-dash" title="${escapeAttr(i18n('hw.ep_na'))}">—</span>`;
            if (hwShowEndpointCell(name, d)) {
                const ph = curIf === 'network' ? '192.168.1.10:7624' : '/dev/ttyUSB0';
                epHtml =
                    `<span class="hw-ep-cell">` +
                    `<select class="hw-iface" data-field="iface" title="${escapeAttr(i18n('hw.iface'))}">` +
                    `<option value="serial" ${curIf === 'serial' ? 'selected' : ''}>${escapeHTML(i18n('hw.iface_serial'))}</option>` +
                    `<option value="network" ${curIf === 'network' ? 'selected' : ''}>${escapeHTML(i18n('hw.iface_net'))}</option>` +
                    `</select>` +
                    `<input class="hw-ep-input" data-field="endpoint" list="serial-port-list" value="${escapeAttr(curEp)}" placeholder="${escapeAttr(ph)}" title="${escapeAttr(i18n('hw.ep_hint'))}">` +
                    `</span>`;
            }

            row.innerHTML =
                `<select class="hw-role-select" data-device="${escapeAttr(name)}" title="${escapeAttr(i18n('hw.role_hint'))}">${roleOpts}</select>` +
                `<span class="hw-name" title="${escapeAttr(name)}">${icon} ${escapeHTML(name)}</span>` +
                `<span class="hw-status ${d.connected ? 'on' : 'off'}">${d.connected ? i18n('hw.connected') : i18n('hw.offline')}</span>` +
                epHtml +
                `<button class="btn-glass" data-action="props" data-device="${escapeAttr(name)}" title="${escapeAttr(i18n('hw.props'))}">⚙️</button>` +
                `<button class="btn-glass ${d.connected ? 'danger' : 'success'}" data-action="${d.connected ? 'disconnect' : 'connect'}" data-device="${escapeAttr(name)}">${d.connected ? i18n('hw.dec') : i18n('hw.conn')}</button>`;
            list.appendChild(row);
        }
    }

    // Server connection status — throttlé 5s (évite storm ws:state)
    if (!renderHardwarePanel._lastConnFetch || Date.now() - renderHardwarePanel._lastConnFetch > 5000) {
        renderHardwarePanel._lastConnFetch = Date.now();
        fetch('/api/connection').then(r => r.json()).then(data => {
            const el = document.getElementById('hw-conn-status');
            if (el) {
                el.textContent = data.connected ? i18n('hw.server_connected') : i18n('hw.offline');
                el.className = data.connected ? 'status-online' : 'status-offline';
            }
        }).catch(() => {});
    }

    renderHwDrivers();
    renderConnLeds();
}

async function hwConnectRoles() {
    const ap = hwActiveProfile();
    if (!ap) { addLog('warning', 'hw', i18n('log.hw.no_profile_apply')); return; }
    for (const f of HW_ROLE_FIELDS) {
        const name = ap[f];
        if (name && _hwDevices[name] && !_hwDevices[name].connected) {
            await fetch('/api/hardware/connect', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: name }),
            }).catch(() => null);
        }
    }
    await hwLoad();
    renderHardwarePanel();
    addLog('info', 'hw', i18n('log.hw.connect_all'));
}

async function hwDisconnectRoles() {
    const ap = hwActiveProfile();
    if (!ap) return;
    for (const f of HW_ROLE_FIELDS) {
        const name = ap[f];
        if (name && _hwDevices[name]?.connected) {
            await fetch('/api/hardware/disconnect', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: name }),
            }).catch(() => null);
        }
    }
    await hwLoad();
    renderHardwarePanel();
    addLog('info', 'hw', i18n('log.hw.disconnect_all'));
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
    if (role) {
        if (update[role] === name) name = '';      // same device again → unassign
        for (const f of HW_ROLE_FIELDS) {
            if (update[f] === name) update[f] = null;
        }
        update[role] = name;
    } else {
        // role vide : on retire ce device de tous les rôles
        for (const f of HW_ROLE_FIELDS) {
            if (update[f] === name) update[f] = null;
        }
    }
    update.optics = ap.optics || '';
    update.mount_interface = ap.mount_interface || null;
    update.mount_endpoint = ap.mount_endpoint || null;
    await fetch('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
    });
    await hwLoad();
    renderHardwarePanel();
}

// Sauvegarde endpoint/interface monture depuis la ligne du tableur
// (générique : n'importe quelle monture assignée au rôle mount).
async function hwSaveMountConn({ iface, endpoint } = {}) {
    const ap = hwActiveProfile();
    if (!ap) return;
    const body = { name: ap.name };
    for (const f of HW_ROLE_FIELDS) body[f] = ap[f] || null;
    body.optics = ap.optics || '';
    body.mount_interface = iface != null ? iface : (ap.mount_interface || 'serial');
    body.mount_endpoint = endpoint != null ? endpoint : (ap.mount_endpoint || '');
    await fetch('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    await hwLoad({ rescanSerial: false });
    // Pas de renderHardwarePanel complet ici (déjà en cours / focus input)
    // → on laisse l'appelant rafraîchir si besoin.
}

// Pousse DEVICE_PORT vers le device monture si déjà connecté
// (le port vit aussi dans les props INDIGO — une seule source de vérité UI).
async function hwPushDevicePortIfAny(deviceName, port) {
    if (!deviceName || !port) return;
    try {
        const st = (typeof devices !== 'undefined' && devices[deviceName]) || null;
        if (!st || !st.connected) return;
        const pv = (st.props || []).find(p => p.name === 'DEVICE_PORT' || p.name === 'CONNECTION_PORT');
        if (!pv || !pv.items?.length) return;
        const item = pv.items[0];
        await fetch('/api/property', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device: deviceName,
                property: pv.name,
                items: [{ name: item.name, value: port }],
            }),
        });
        addLog('info', 'hw', i18nFmt('log.ws.serial_configured', { port }));
    } catch (e) { /* best-effort */ }
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
    const tabsBar = document.getElementById('hw-tabs');
    const scanBtn = document.getElementById('hw-scan-serial');

    // Onglets Devices / Drivers / Profil
    if (tabsBar) tabsBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.hw-tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        tabsBar.querySelectorAll('.hw-tab').forEach(b => {
            const on = b === btn;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        for (const t of ['devices', 'drivers', 'profile']) {
            const panel = document.getElementById(`hw-tab-${t}`);
            if (!panel) continue;
            const on = t === tab;
            panel.classList.toggle('active', on);
            if (on) panel.removeAttribute('hidden');
            else panel.setAttribute('hidden', '');
        }
    });

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
        body.mount_interface = ap.mount_interface || null;
        body.mount_endpoint = ap.mount_endpoint || null;
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
        const iface = list?.querySelector('.hw-iface')?.value;
        const ep = list?.querySelector('.hw-ep-input')?.value.trim();
        body.mount_interface = iface || ap.mount_interface || null;
        body.mount_endpoint = ep != null ? ep : (ap.mount_endpoint || null);
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

    // Délégation tableur : ⚙ props, CONN, rôle, endpoint
    if (list) {
        list.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const device = btn.dataset.device;
            const action = btn.dataset.action;
            if (action === 'props') { hwOpenDeviceProps(device); return; }
            const res = await fetch(`/api/hardware/${action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device }),
            }).then(r => r.json()).catch(() => null);
            if (res?.error) addLog('error', 'hw', i18nFmt('log.hw.device_error', { device, err: res.error }));
            await hwLoad();
            renderHardwarePanel();
        });

        list.addEventListener('change', async (e) => {
            const t = e.target;
            if (t.classList?.contains('hw-role-select')) {
                await hwAssignRole(t.value, t.dataset.device);
                return;
            }
            if (t.classList?.contains('hw-iface')) {
                // bascule série/réseau → placeholder + sauvegarde profil
                const epInput = t.closest('.hw-ep-cell')?.querySelector('.hw-ep-input');
                if (epInput) {
                    epInput.placeholder = t.value === 'network' ? '192.168.1.10:7624' : '/dev/ttyUSB0';
                }
                await hwSaveMountConn({ iface: t.value });
                renderHardwarePanel();
                return;
            }
            if (t.classList?.contains('hw-ep-input')) {
                const iface = t.closest('.hw-ep-cell')?.querySelector('.hw-iface')?.value || 'serial';
                const port = t.value.trim();
                await hwSaveMountConn({ iface, endpoint: port });
                const mountName = hwActiveProfile()?.mount || Object.keys(_hwDevices).find(n => _hwDevices[n]?.type === 'mount');
                if (iface === 'serial' && mountName) await hwPushDevicePortIfAny(mountName, port);
                return;
            }
        });
    }

    if (scanBtn) scanBtn.addEventListener('click', async () => {
        const data = await hwScanSerialPorts({ force: true, silent: true });
        const ports = data?.ports || [];
        if (!ports.length) { addLog('warning', 'hw', i18n('hw.serial_none')); return; }
        const choices = ports.map((p, i) => `${i + 1}. ${p.preferred}${p.description ? ` — ${p.description}` : ''}${p.busy ? ' [busy]' : ''}`);
        const pick = prompt(
            `${i18n('hw.serial_found', { n: ports.length })}\n${choices.join('\n')}\n\n#`,
            '1',
        );
        if (pick === null || pick === '') return;
        const idx = parseInt(pick, 10) - 1;
        const chosen = ports[idx];
        if (!chosen) return;
        const pathInp = list?.querySelector('.hw-ep-input');
        if (pathInp) {
            pathInp.value = chosen.preferred;
            pathInp.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            await hwSaveMountConn({ iface: 'serial', endpoint: chosen.preferred });
            renderHardwarePanel();
        }
        addLog('info', 'hw', i18nFmt('log.ws.serial_configured', { port: chosen.preferred }));
    });

    if (optics) optics.addEventListener('change', async () => {
        const ap = hwActiveProfile();
        if (!ap) return;
        const body = { name: ap.name };
        for (const f of HW_ROLE_FIELDS) body[f] = ap[f] || null;
        body.optics = optics.value.trim();
        body.mount_interface = ap.mount_interface || null;
        body.mount_endpoint = ap.mount_endpoint || null;
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

    const drvAttach = document.getElementById('hw-driver-attach');
    if (drvAttach) drvAttach.addEventListener('click', async () => {
        const dsel = document.getElementById('hw-driver-select');
        await hwAttachDriver(dsel?.value || _hwSelectedDriver);
    });

    const drvDetach = document.getElementById('hw-driver-detach');
    if (drvDetach) drvDetach.addEventListener('click', async () => {
        const dsel = document.getElementById('hw-driver-select');
        await hwDetachDriver(dsel?.value || _hwSelectedDriver);
    });

    const drvRefresh = document.getElementById('hw-drivers-refresh');
    if (drvRefresh) drvRefresh.addEventListener('click', async () => {
        await hwLoadDrivers();
        renderHwDrivers();
    });

    const drvSelect = document.getElementById('hw-driver-select');
    if (drvSelect) drvSelect.addEventListener('change', () => {
        hwSelectDriver(drvSelect.value);
    });

    hwCheckDom();
    hwLoad().then(() => { renderHardwarePanel(); renderConnLeds(); });
    hwScanSerialPorts({ force: true, silent: true }).catch(() => {});
}

// ── Hardware mode (mode dédié, grand panneau) ────────────────

function renderHardwareMode() {
    const container = document.getElementById('applet-hardware-mode');
    if (!container) return;

    // Sélecteur props retiré du flux principal (onglet) — plus de
    // hardcode "Mount LX200" : on garde le device courant s'il existe.
    const names = Object.keys(_hwDevices);
    if (_hwModeDevice && !names.includes(_hwModeDevice)) _hwModeDevice = null;
    if (!_hwModeDevice && names.length) {
        const mount = names.find(n => _hwDevices[n]?.type === 'mount');
        _hwModeDevice = mount || names[0];
    }

    renderHardwareModeProps();
}

// Résout le conteneur de props : nouveau panneau séparé en priorité,
// ancien emplacement inline en repli (HTML en cache).
function hwPropsContainer() {
    return document.getElementById('hw-device-props') ||
        document.getElementById('hw-mode-props');
}

function hwOpenDeviceProps(name) {
    if (!name) return;
    _hwModeDevice = name;
    renderHardwareModeProps(true);
    // Toujours (ré)afficher : couvre aussi le cas panneau fermé via ✕.
    const panel = document.getElementById('applet-hwprops');
    if (panel) {
        panel.style.display = '';
        panel.classList.remove('collapsed');
    }
}

// Throttle : le WS stream à plusieurs Hz, reconstruire 36 props à chaque
// fois fige le panneau. On ne reconstruit que si signature changée et au
// plus toutes les 1.5 s (forçage sur action explicite).
let _hwPropsSig = null;
let _hwPropsLastMs = 0;
function renderHardwareModeProps(force) {
    // Panneau séparé (applet-hwprops) : la liste prend de la place, elle ne
    // reste plus coincée en bas du panneau Matériel.
    const panel = document.getElementById('applet-hwprops');
    const propsEl = hwPropsContainer();
    const titleEl = document.getElementById('hwprops-title-name');
    if (!propsEl) return;
    if (document.activeElement && propsEl.contains(document.activeElement)) return;
    if (titleEl) titleEl.textContent = _hwModeDevice || '';
    // On ne touche au display que pour masquer (jamais de forçage visible sur
    // le stream : le layout/minimize de l'utilisateur reste maître).
    if (panel && (!_hwModeDevice || !devices[_hwModeDevice])) panel.style.display = 'none';
    if (!_hwModeDevice || !devices[_hwModeDevice]) {
        propsEl.innerHTML = `<div style="color:#555; font-size:0.65rem; padding:6px;">${i18n('hw.select_hint')}</div>`;
        return;
    }
    const _hwDev = devices[_hwModeDevice];
    if (!_hwDev.props || !_hwDev.props.length) {
        // Diagnostic visible : dit si le device est absent du store WS ou sans props.
        propsEl.innerHTML = `<div style="color:#c84; font-size:0.65rem; padding:6px;">${i18n('hw.no_props')} [${escapeHTML(_hwModeDevice)} — ws:${_hwDev ? 'ok' : 'absent'}, props:${_hwDev && _hwDev.props ? _hwDev.props.length : '—'}]</div>`;
        return;
    }
    const sig = _hwDev.props.map(p =>
        p.name + '=' + p.state + '|' + (p.items || []).map(i => i.name + ':' + i.value).join(',')).join(';');
    const nowMs = Date.now();
    if (!force && sig === _hwPropsSig) return;
    if (!force && nowMs - _hwPropsLastMs < 1500) return;
    _hwPropsSig = sig;
    _hwPropsLastMs = nowMs;
    const html = buildPropsHTML(_hwModeDevice);
    propsEl.innerHTML = html || `<div style="color:#555; font-size:0.65rem; padding:6px;">${i18n('hw.no_props')}</div>`;
}

function initHardwareMode() {
    const closeBtn = document.querySelector('#applet-hwprops .applet-close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = document.getElementById('applet-hwprops');
        if (panel) panel.style.display = 'none';
    });
}

// ── Hub ───────────────────────────────────────────────────────

// Consommateur ws:state : reconstruit _hwDevices et rend les panneaux.
let _hwPrevDevices = {};
const _hubTimers = {};
const HUB_CONFIRM_MS = 1200;
Hub.subscribe('ws:state', 'hardware', (env) => {
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
                    delete _hubTimers[n];
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
    renderConnLeds();
});

// Consommateur mode:changed : rafraîchit le mode matériel à l'entrée.
Hub.subscribe('mode:changed', 'hardware', (env) => {
    if (env.payload.mode === 'hardware') {
        renderHardwareMode();
        hwScanSerialPorts({ silent: true }).catch(() => {});
    }
});
