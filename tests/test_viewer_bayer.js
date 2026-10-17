#!/usr/bin/env node
// ── Tests Viewer : décalage de phase Bayer (XBAYROFF/YBAYROFF) ────
// Run: node tests/test_viewer_bayer.js
// Cas terrain SV305PRO : BAYERPAT=GRBG + XBAYROFF=1 → phase réelle RGGB.
// Ignorer l'offset permute les canaux → dominante chaude (orange).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {}, document: { getElementById: () => null }, console };
vm.createContext(ctx);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'web', 'static', 'viewer.js'), 'utf8')
        + '\n;globalThis.Viewer = Viewer;', ctx);
const Viewer = ctx.Viewer;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  \u2713 ${msg}`); }
    else { failed++; console.log(`  \u2717 ${msg}`); }
}

// 1) shiftBayer : permutations attendues
assert(Viewer.shiftBayer('GRBG', 0, 0) === 'GRBG', 'shiftBayer identité (0,0)');
assert(Viewer.shiftBayer('GRBG', 1, 0) === 'RGGB', 'GRBG + XBAYROFF=1 → RGGB');
assert(Viewer.shiftBayer('GRBG', 0, 1) === 'BGGR', 'GRBG + YBAYROFF=1 → BGGR');
assert(Viewer.shiftBayer('GRBG', 1, 1) === 'GBRG', 'GRBG + (1,1) → GBRG');
assert(Viewer.shiftBayer('RGGB', 1, 0) === 'GRBG', 'RGGB + XBAYROFF=1 → GRBG');
assert(Viewer.shiftBayer('BAD', 1, 0) === 'BAD', 'motif invalide inchangé');

// 2) Phase physique RGGB (R en (0,0)) : le bon motif lit R en (0,0),
//    l'ancien (motif brut GRBG, offset ignoré) lit G → canaux permutés
//    (domi de couleur sur les contours). On marque R seul.
const W = 8, H = 8;
const mos = new Float32Array(W * H);
for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
        mos[y * W + x] = ((y % 2 === 0 && x % 2 === 0) ? 500 : 0); // R physical @ (0,0)
function px(rgb) { return { r: rgb[0], g: rgb[1], b: rgb[2] }; }
const good = px(Viewer.debayer(mos, W, H, Viewer.shiftBayer('GRBG', 1, 0))); // → RGGB
const bad = px(Viewer.debayer(mos, W, H, 'GRBG'));                          // offset ignoré
assert(good.r > good.g && good.r > good.b, `offset appliqué : R lu en (0,0) (r=${good.r},g=${good.g},b=${good.b})`);
assert(bad.g > bad.r, `offset ignoré : G lu en (0,0) (r=${bad.r},g=${bad.g})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
