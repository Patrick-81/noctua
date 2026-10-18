// Tests unitaires de web/static/recenter_math.js (lancés : node tests/test_recenter_math.js)
// Recentrage au clic (Lot 3) : conversion pixel ↔ ciel depuis un solve.
'use strict';

const path = require('path');
const { pixelToSky, skyToPixel, wrapRA } = require(path.join(__dirname, '..', 'web', 'static', 'recenter_math.js'));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ok - ${msg}`); }
    else { failed++; console.error(`  FAIL - ${msg}`); }
}
function close(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const res = { ra: 84.0, dec: -1.0, scale: 3.0, rotation: 0, width: 1920, height: 1080 };

// Centre → centre du solve (sans rotation)
console.log('centre image = centre résolu :');
{
    const s = pixelToSky(0.5, 0.5, res);
    assert(close(s.ra, 84.0) && close(s.dec, -1.0), `centre → RA ${s.ra}, DEC ${s.dec}`);
}

// Droite de l'image → RA plus grande (rotation nulle)
console.log('clic à droite → RA+ :');
{
    const s = pixelToSky(0.75, 0.5, res);   // +0.25*1920 = +480 px
    // 480 px * 3"/px = 1440" = 0.4°
    assert(close(s.ra, 84.4, 1e-3), `RA attendu 84.4, obtenu ${s.ra}`);
    assert(close(s.dec, -1.0, 1e-3), `DEC inchangé, obtenu ${s.dec}`);
}

// Haut de l'image (v<0.5) → DEC plus grande
console.log('clic en haut → DEC+ :');
{
    const s = pixelToSky(0.5, 0.25, res);   // -0.25*1080 = -270 px → +y ciel
    // 270 px * 3"/px = 810" = 0.225°
    assert(close(s.dec, -1.0 + 0.225, 1e-3), `DEC attendu ${-1.0 + 0.225}, obtenu ${s.dec}`);
}

// Rotation 90° : un offset horizontal image devient vertical ciel
console.log('rotation 90° :');
{
    const r90 = { ...res, rotation: 90 };
    const s = pixelToSky(0.75, 0.5, r90);
    // rdx=480, rdy=0 ; rot=90 → ddx=0, ddy=-480 ; -480*0.05/60 = -0.4° en DEC
    assert(close(s.ra, 84.0, 1e-3), `RA inchangé (${s.ra})`);
    assert(close(s.dec, -1.0 - 0.4, 1e-3), `DEC attendu -1.4, obtenu ${s.dec}`);
}

// Aller-retour pixel → ciel → pixel
console.log('aller-retour pixel↔ciel :');
{
    const cases = [[0.5, 0.5], [0.25, 0.75], [0.8, 0.2], [0.1, 0.9]];
    let okAll = true, detail = '';
    for (const [u, v] of cases) {
        const sky = pixelToSky(u, v, { ...res, rotation: 37 });
        const back = skyToPixel(sky.ra, sky.dec, { ...res, rotation: 37 });
        if (!close(back.u, u, 1e-6) || !close(back.v, v, 1e-6)) {
            okAll = false; detail = `(${u},${v}) → (${back.u},${back.v})`;
        }
    }
    assert(okAll, `round-trip identité ${detail}`);
}

// Débordement RA (wrap)
console.log('wrap RA :');
{
    assert(close(wrapRA(-10), 350) && close(wrapRA(370), 10), 'wrapRA ±');
    const r = { ra: 359.9, dec: 0, scale: 3.0, rotation: 0, width: 1920, height: 1080 };
    const s = pixelToSky(0.75, 0.5, r); // +0.4° → 0.3°
    assert(close(s.ra, 0.3, 1e-3), `RA 359.9+0.4 → 0.3, obtenu ${s.ra}`);
}

// DEC clampé à ±90
console.log('clamp DEC :');
{
    const r = { ra: 10, dec: 89.9, scale: 30.0, rotation: 0, width: 4000, height: 4000 };
    const s = pixelToSky(0.5, 0.0, r);
    assert(s.dec <= 90.0, `DEC ≤ 90 (obtenu ${s.dec})`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
