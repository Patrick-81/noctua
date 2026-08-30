// ═══════════════════════════════════════════════════════════════
// Noctua — framing.js (module classique, bindings lexicaux globaux)
// Framing assistant (Lot D3) : charger/cadrer une cible dans le FOV.
// ═══════════════════════════════════════════════════════════════

let _frameLastSolveRotation = null;
let _frameTarget = null;

function _frameSetText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
}

// Calcule le FOV (degrés) depuis la première caméra connue — même formule
// que mount.js updateCameraFov (binning & focale depuis l'état INDIGO).
function _frameCameraFov() {
    for (const dev of Object.values(devices)) {
        if (dev.type !== 'camera') continue;
        const w = dev.width_px ?? 0;
        const h = dev.height_px ?? 0;
        const ps = dev.pixel_size_um ?? 0;
        const fl = dev.focal_length_mm ?? 0;
        const bx = dev.binning_x ?? 1;
        const by = dev.binning_y ?? 1;
        if (w && h && ps && fl) {
            return {
                x: 2 * Math.atan(w * bx * ps / 1e6 / (2 * fl / 1e3)) * (180 / Math.PI),
                y: 2 * Math.atan(h * by * ps / 1e6 / (2 * fl / 1e3)) * (180 / Math.PI),
            };
        }
        break;
    }
    return null;
}

function _frameReadFov() {
    const useCam = document.getElementById('frame-use-camera')?.checked;
    let x = parseFloat(document.getElementById('frame-fov-x')?.value);
    let y = parseFloat(document.getElementById('frame-fov-y')?.value);
    if (useCam) {
        const f = _frameCameraFov();
        if (f) {
            x = f.x;
            y = f.y;
            document.getElementById('frame-fov-x').value = x.toFixed(3);
            document.getElementById('frame-fov-y').value = y.toFixed(3);
        }
    }
    if (skyEngine && x > 0 && y > 0) {
        skyEngine.cameraFovX = x;
        skyEngine.cameraFovY = y;
        skyEngine.render();
    }
    return (x > 0 && y > 0) ? { x, y } : null;
}

function _frameApplyRotation(deg) {
    _frameSetText('frame-rot-val', `${Math.round(deg)}°`);
    document.getElementById('frame-rot').value = Math.round(deg);
    if (skyEngine) skyEngine.setCameraRotation(deg);
}

function _frameFitCheck() {
    const fov = _frameReadFov();
    const t = _frameTarget;
    const fitEl = document.getElementById('frame-fit');
    if (!fitEl) return;
    if (!t || !t.size_arcmin || !fov) {
        fitEl.style.display = 'none';
        return;
    }
    const maj = Number(t.size_arcmin[0]);
    const min = Number(t.size_arcmin[1] ?? t.size_arcmin[0]);
    if (!maj || maj <= 0) { fitEl.style.display = 'none'; return; }

    const rotEl = document.getElementById('frame-rot');
    const rotDeg = (parseFloat(rotEl?.value) || 0);
    const pa = Number(t.pa ?? t.position_angle_deg ?? 0);
    const a = (rotDeg + pa) * Math.PI / 180;
    // Boîte englobante du rectangle cible alignée sur les axes du FOV.
    const cosA = Math.abs(Math.cos(a)), sinA = Math.abs(Math.sin(a));
    const w = maj * cosA + min * sinA;   // arcmin
    const h = min * cosA + maj * sinA;
    const fits = w / 60 <= fov.x && h / 60 <= fov.y;

    fitEl.style.display = '';
    const ratio = (Math.max(w / 60 / fov.x, h / 60 / fov.y) * 100).toFixed(0);
    _frameSetText('frame-fit-text',
        `${t.name || t.id || 'Cible'} ${maj}′×${min}′ → ` +
        (fits
            ? `✓ tient dans le champ (${ratio}% largeur)`
            : `✗ déborde du champ (${ratio}% largeur) — agrandir le FOV ou augmenter la rotation`));
}

async function _frameLoadTarget(raDeg, decDeg, name) {
    try {
        const q = new URLSearchParams({ ra: String(raDeg), dec: String(decDeg) });
        if (name) q.set('id', name);
        const data = await fetch('/api/visibility?' + q.toString()).then(r => r.json());
        const o = data.ok ? data.object : null;
        const size = o && o.size_arcmin && o.size_arcmin.length ? o.size_arcmin : null;
        _frameSetText('frame-size', size ? size.map(v => `${v}′`).join('×') : '—');
        _frameTarget = {
            ra: raDeg, dec: decDeg,
            size_arcmin: size,
            pa: o && o.position_angle_deg != null ? o.position_angle_deg : 0,
            name: name || (o && o.name) || '',
            id: (o && o.id) || name || '',
        };
        if (skyEngine) skyEngine.setCameraTarget(_frameTarget);
        _frameFitCheck();
    } catch (e) {
        _frameSetText('frame-size', '?');
    }
}

// Renseigne le champ id, rempli RA/DEC depuis l'objet, charge la taille.
function frameSetTargetObject(obj) {
    if (!obj) return;
    const idEl = document.getElementById('frame-target-id');
    if (idEl) idEl.value = obj.id || obj.name || '';
    if (obj.ra != null && obj.dec != null) {
        const raEl = document.getElementById('frame-ra');
        const decEl = document.getElementById('frame-dec');
        if (raEl) raEl.value = decToSexa(obj.ra / 15, true);
        if (decEl) decEl.value = decToSexa(obj.dec, false);
    }
    _frameLoadTarget(obj.ra, obj.dec, obj.id || obj.name || '');
}

function frameSet() {
    const idEl = document.getElementById('frame-target-id');
    const objId = (idEl?.value || '').trim();
    if (objId) {
        const o = skyEngine && skyEngine.search ? skyEngine.search(objId)[0] : null;
        if (o && o.ra != null) {
            frameSetTargetObject(o);
            return;
        }
    }
    const raStr = document.getElementById('frame-ra')?.value;
    const decStr = document.getElementById('frame-dec')?.value;
    if (!raStr || !decStr) return;
    const raH = sexaToDec(raStr, true);
    // RA saisi en heures sexagésimales ; si proprement numérique en heures.
    if (raH === null) return;
    const decD = sexaToDec(decStr, false);
    if (decD === null) {
        addLog('error', 'framing', 'Format RA/DEC invalide (attendu HH:MM:SS / ±DD:MM:SS)');
        return;
    }
    _frameLoadTarget(raH * 15, decD, objId || undefined);
}

function frameGoto() {
    if (!_frameTarget) {
        addLog('warning', 'framing', 'Définir une cible avant GOTO');
        return;
    }
    _applyPointingCorrection(_frameTarget.ra, _frameTarget.dec).then(([raDeg, decDeg]) => {
        apiPost('/api/mount/slew', { ra_hours: raDeg / 15, dec_deg: decDeg });
        addLog('info', 'framing', `GOTO ${(_frameTarget.name || _frameTarget.id || '')} → RA ${(raDeg / 15).toFixed(4)}h DEC ${decDeg.toFixed(4)}°`);
    });
}

function frameClear() {
    _frameTarget = null;
    _frameSetText('frame-size', '—');
    _frameSetText('frame-ra', '');
    _frameSetText('frame-dec', '');
    const fitEl = document.getElementById('frame-fit');
    if (fitEl) fitEl.style.display = 'none';
    if (skyEngine) skyEngine.setCameraTarget(null);
}

function frameRotSolve() {
    if (_frameLastSolveRotation == null) {
        addLog('warning', 'framing', 'Aucune rotation de solve disponible (résoudre une image d\'abord)');
        return;
    }
    _frameApplyRotation(_frameLastSolveRotation);
    _frameFitCheck();
}

function initFramingPanel() {
    document.getElementById('frame-rot')?.addEventListener('input', (e) => {
        _frameApplyRotation(parseFloat(e.target.value) || 0);
        _frameFitCheck();
    });
    document.getElementById('frame-rot-solve')?.addEventListener('click', frameRotSolve);
    document.getElementById('frame-rot-reset')?.addEventListener('click', () => {
        _frameApplyRotation(0);
        _frameFitCheck();
    });
    document.getElementById('frame-use-camera')?.addEventListener('change', () => {
        _frameReadFov();
        _frameFitCheck();
    });
    document.getElementById('frame-fov-x')?.addEventListener('change', () => { _frameReadFov(); _frameFitCheck(); });
    document.getElementById('frame-fov-y')?.addEventListener('change', () => { _frameReadFov(); _frameFitCheck(); });
    document.getElementById('frame-set')?.addEventListener('click', frameSet);
    document.getElementById('frame-goto')?.addEventListener('click', frameGoto);
    document.getElementById('frame-clear')?.addEventListener('click', frameClear);

    Hub.subscribe('solver:result', 'framing', (env) => {
        const res = env?.payload?.result;
        if (res && typeof res.rotation === 'number') {
            _frameLastSolveRotation = ((res.rotation % 360) + 360) % 360;
        }
    });

    // Rafraîchit le FOV dès qu'une caméra est détectée (mise sous tension tardive).
    Hub.subscribe('ws:state', 'framing', () => {
        if (document.getElementById('frame-use-camera')?.checked) {
            _frameReadFov();
            _frameFitCheck();
        }
    });

    _frameReadFov();
}
