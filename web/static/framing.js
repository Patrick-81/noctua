// ═══════════════════════════════════════════════════════════════
// Noctua — framing.js (module classique, bindings lexicaux globaux)
// Framing assistant (Lot D3) : charger/cadrer une cible dans le FOV.
// ═══════════════════════════════════════════════════════════════

let _frameLastSolveRotation = null;
let _frameTarget = null;
let _frameMosaicPlan = null;
let _frameMosaicDebounce = null;

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
        _frameClearMosaicSuggest();
        return;
    }
    const maj = Number(t.size_arcmin[0]);
    const min = Number(t.size_arcmin[1] ?? t.size_arcmin[0]);
    if (!maj || maj <= 0) { fitEl.style.display = 'none'; _frameClearMosaicSuggest(); return; }

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
            : `✗ déborde du champ (${ratio}% largeur) — mosaïque conseillée`));

    // Suggestion mosaïque auto quand ça déborde (débouncée 300ms)
    if (!fits) {
        clearTimeout(_frameMosaicDebounce);
        _frameMosaicDebounce = setTimeout(() => _frameSuggestMosaic(w, h), 300);
    } else {
        _frameClearMosaicSuggest();
    }
}

function _frameClearMosaicSuggest() {
    clearTimeout(_frameMosaicDebounce);
    _frameMosaicPlan = null;
    const el = document.getElementById('frame-mosaic-suggest');
    if (el) el.style.display = 'none';
    // ne pas effacer les tuiles si elles viennent du séquenceur
    if (skyEngine && skyEngine.mosaicTiles && skyEngine.mosaicTiles._fromFraming) {
        skyEngine.setMosaicTiles(null);
    }
}

async function _frameSuggestMosaic(bboxWArcmin, bboxHArcmin) {
    const t = _frameTarget;
    const fov = _frameReadFov();
    const suggestEl = document.getElementById('frame-mosaic-suggest');
    const textEl = document.getElementById('frame-mosaic-text');
    if (!t || !fov || !suggestEl || !textEl) return;
    // marge 15% pour couvrir l'objet + recouvrement
    const w = Math.ceil(bboxWArcmin * 1.15);
    const h = Math.ceil(bboxHArcmin * 1.15);
    try {
        const plan = await fetch('/api/mosaic/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                target_coords: { ra_hours: t.ra / 15, dec_deg: t.dec },
                size_arcmin: { w, h },
                overlap_frac: 0.15,
                fov_x_deg: fov.x,
                fov_y_deg: fov.y,
            }),
        }).then(r => r.json());
        if (!plan || !plan.ok) {
            suggestEl.style.display = 'none';
            return;
        }
        _frameMosaicPlan = plan;
        const n = plan.tiles.length;
        const grid = `${plan.rows}×${plan.cols}`;
        textEl.textContent = `${t.name || t.id || 'Cible'} ${w}′×${h}′ → ${grid} = ${n} tuile${n>1?'s':''} (recouv. 15%) — voir orange sur la carte`;
        suggestEl.style.display = '';
        // Dessine en orange sur la sky map (marqué _fromFraming pour clear)
        if (skyEngine) {
            const overlay = { tiles: plan.tiles, fov: plan.fov, current: null, _fromFraming: true };
            skyEngine.setMosaicTiles(overlay);
        }
        addLog('info', 'framing', `Mosaïque suggérée : ${grid} = ${n} tuiles pour ${t.name || t.id} (${w}′×${h}′)`);
    } catch (e) {
        suggestEl.style.display = 'none';
    }
}

function _frameApplyMosaicToSequencer() {
    if (!_frameMosaicPlan || !_frameTarget) {
        addLog('warning', 'framing', 'Aucune mosaïque suggérée à appliquer');
        return;
    }
    // Alimente le séquenceur si le panneau est chargé (sequence.js)
    try {
        // Trouve ou crée une cible dans le séquenceur
        const t = _frameTarget;
        // Hub request si disponible, sinon localStorage fallback
        if (typeof seqData !== 'undefined' && seqData && Array.isArray(seqData.targets)) {
            let target = seqData.targets.find(x => x.enabled) || seqData.targets[0];
            if (!target) {
                // crée une cible via l'API du séquenceur (addTarget)
                if (typeof seqAddTarget === 'function') seqAddTarget();
                target = seqData.targets[seqData.targets.length - 1];
            }
            if (target) {
                target.name = t.name || t.id || target.name;
                target.ra = (t.ra / 15).toFixed(4);
                target.dec = t.dec.toFixed(4);
                target.mosaicOn = true;
                target.mosaicW = _frameMosaicPlan.size_arcmin.w;
                target.mosaicH = _frameMosaicPlan.size_arcmin.h;
                target.mosaicOverlap = Math.round(_frameMosaicPlan.overlap_frac * 100);
                target.mosaicPlan = _frameMosaicPlan;
                if (typeof seqRender === 'function') seqRender();
                if (typeof seqPlanMosaic === 'function') seqPlanMosaic(target);
                addLog('info', 'framing', `Mosaïque ${target.name} appliquée au Séquenceur (${_frameMosaicPlan.rows}×${_frameMosaicPlan.cols})`);
                // Bascule visuelle vers le mode Séquenceur
                if (typeof setMode === 'function') setMode('sequencer');
                return;
            }
        }
        // Fallback : copie dans le presse-papier le JSON du plan
        const txt = JSON.stringify(_frameMosaicPlan, null, 2);
        navigator.clipboard.writeText(txt).then(() => {
            addLog('info', 'framing', 'Plan mosaïque copié dans le presse-papier (Séquenceur non chargé)');
        });
    } catch (e) {
        addLog('error', 'framing', `Apply mosaïque échoué: ${e.message}`);
    }
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
    _frameClearMosaicSuggest();
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
    document.getElementById('frame-mosaic-apply')?.addEventListener('click', _frameApplyMosaicToSequencer);
    document.getElementById('frame-mosaic-clear')?.addEventListener('click', _frameClearMosaicSuggest);

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
