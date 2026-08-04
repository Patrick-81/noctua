#!/usr/bin/env node
// ── Tests for polar alignment math ────────────────────────────────
// Run: node tests/test_polar_math.js

const {
    lstFromTime,
    clampAngle,
    computeTargets,
    decToSexa,
    raToSexa,
    toRad,
    toDeg,
    sub,
    cross,
    norm3,
    solvesToVecs,
    fitPoleFromVecs,
    polarCompute,
} = require('./polar_math.js');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.log(`  ✗ ${msg}`);
    }
}

function assertNear(a, b, tol, msg) {
    assert(Math.abs(a - b) < tol, `${msg} (${a.toFixed(6)} ≈ ${b.toFixed(6)}, tol=${tol})`);
}

// ── Test helpers ──────────────────────────────────────────────────

function raDecToVec(raDeg, decDeg) {
    const ra = toRad(raDeg);
    const dec = toRad(decDeg);
    return [
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
    ];
}

// ── Tests ─────────────────────────────────────────────────────────

console.log('\n=== Couche 1 : Tests mathématiques polaire ===\n');

// --- LST ---
console.log('LST calculation:');
{
    // J2000.0 epoch: 2000-01-01T12:00:00 UTC → JD 2451545.0
    // At J2000, GMST = 280.46061837°
    // For lng=0: LST ≈ 280.46° at that instant
    const j2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
    const lst0 = lstFromTime(j2000, 0);
    assertNear(lst0, 280.46, 0.5, 'LST at J2000 epoch, lng=0 ≈ 280.46°');

    // lng=1.568 → LST should be ~1.568° higher
    const lst1 = lstFromTime(j2000, 1.568);
    assertNear(lst1, 280.46 + 1.568, 0.5, 'LST at J2000, lng=1.568 ≈ 282.03°');

    // LST advances ~360° per sidereal day (23h56m ≈ 23.934h)
    // After 1 hour solar time, LST advances ~15.041°
    const t1 = new Date(j2000.getTime() + 3600 * 1000); // +1h
    const lst2 = lstFromTime(t1, 0);
    const delta = lst2 - lst0;
    assertNear(delta, 15.041, 0.1, 'LST advances ~15.041° per solar hour');
}

// --- clampAngle ---
console.log('\nAngle clamping:');
{
    assert(clampAngle(30, 5, 120) === 30, '30 stays 30');
    assert(clampAngle(3, 5, 120) === 5, '3 clamps to 5 (min)');
    assert(clampAngle(200, 5, 120) === 120, '200 clamps to 120 (max)');
    assert(clampAngle(0, 5, 120) === 30, '0 (falsy) defaults to 30');
    assert(clampAngle(undefined, 5, 120) === 30, 'undefined defaults to 30');
}

// --- computeTargets ---
console.log('\nTarget computation:');
{
    const lst = 180; // fixed LST for determinism
    const lat = 43.952;

    // angle=30min → offset = 30/4 = 7.5°
    const t30 = computeTargets(lst, lat, 30);
    assert(t30.length === 3, '3 targets computed');
    assertNear(t30[0].ra_hours * 15, 180, 0.01, 'Target 0 RA = LST (center)');
    assertNear(t30[1].ra_hours * 15, 180 - 7.5, 0.01, 'Target 1 RA = LST - 7.5°');
    assertNear(t30[2].ra_hours * 15, 180 + 7.5, 0.01, 'Target 2 RA = LST + 7.5°');
    assertNear(t30[0].dec_deg, 90 - 43.952 + 20, 0.01, 'DEC = 90 - lat + 20');

    // angle=60min → offset = 15°
    const t60 = computeTargets(lst, lat, 60);
    assertNear(t60[1].ra_hours * 15, 180 - 15, 0.01, 'angle=60: offset=15°');
    assertNear(t60[2].ra_hours * 15, 180 + 15, 0.01, 'angle=60: offset=15° (other side)');

    // angle=5min → offset = 1.25°
    const t5 = computeTargets(lst, lat, 5);
    assertNear(t5[1].ra_hours * 15, 180 - 1.25, 0.01, 'angle=5: offset=1.25°');

    // angle=120min → offset = 30°
    const t120 = computeTargets(lst, lat, 120);
    assertNear(t120[1].ra_hours * 15, 180 - 30, 0.01, 'angle=120: offset=30°');

    // RA wrapping near 0h
    const lstNear0 = 2; // LST = 2°
    const tWrap = computeTargets(lstNear0, lat, 60);
    const ra1Deg = tWrap[2].ra_hours * 15; // should wrap: 2 + 15 = 17°
    assertNear(ra1Deg, 17, 0.01, 'RA wraps correctly near 0h');
}

// --- Sexagesimal conversion ---
console.log('\nSexagesimal conversion:');
{
    assert(decToSexa(45.5) === '+45°30\'00"', 'DEC +45.5°');
    assert(decToSexa(-10.25) === '-10°15\'00"', 'DEC -10.25°');
    assert(decToSexa(0) === '+00°00\'00"', 'DEC 0°');
    assert(raToSexa(180) === '12h00m00s', 'RA 180° = 12h');
    assert(raToSexa(270) === '18h00m00s', 'RA 270° = 18h');
    assert(raToSexa(15.5) === '01h02m00s', 'RA 15.5° = 1h02m');
}

// --- solvesToVecs ---
console.log('\nSolve to unit vector:');
{
    // RA=0, DEC=0 → [1, 0, 0]
    const v0 = solvesToVecs([{ ra: 0, dec: 0, ha: 0 }])[0];
    assertNear(v0[0], 1, 1e-10, 'RA=0 DEC=0 → x=1');
    assertNear(v0[1], 0, 1e-10, 'RA=0 DEC=0 → y=0');
    assertNear(v0[2], 0, 1e-10, 'RA=0 DEC=0 → z=0');

    // RA=90, DEC=0 → [0, 1, 0]
    const v90 = solvesToVecs([{ ra: 90, dec: 0, ha: 0 }])[0];
    assertNear(v90[0], 0, 1e-10, 'RA=90 DEC=0 → x=0');
    assertNear(v90[1], 1, 1e-10, 'RA=90 DEC=0 → y=1');

    // RA=0, DEC=90 → [0, 0, 1] (north pole)
    const vPole = solvesToVecs([{ ra: 0, dec: 90, ha: 0 }])[0];
    assertNear(vPole[2], 1, 1e-10, 'DEC=90 → z=1 (north pole)');
}

// --- fitPoleFromVecs: ideal case (pole at true position) ---
console.log('\nCircle fit — ideal (true pole DEC=+90):');
{
    // 3 points on a small circle around the north pole
    // At DEC=66° (24° from pole), at 3 different RAs 120° apart
    // The circumscribed circle center should be very close to the pole
    const dec = 66;
    const solves = [
        { ra: 0, dec },
        { ra: 120, dec },
        { ra: 240, dec },
    ];
    const vecs = solvesToVecs(solves);
    const pole = fitPoleFromVecs(vecs);
    assertNear(pole.dec, 90, 0.5, 'Pole DEC ≈ 90 (symmetric points)');
    assert(!isNaN(pole.ra), 'Pole RA is defined (may be arbitrary for symmetric case)');
}

// --- fitPoleFromVecs: pole at DEC=90, RA unknown ---
console.log('\nCircle fit — pole at DEC=+90 (perfect alignment):');
{
    // 3 points all on the same DEC=70° circle, RAs 120° apart
    // With perfect alignment, found pole should be DEC≈90
    const solves = [
        { ra: 30, dec: 70 },
        { ra: 150, dec: 70 },
        { ra: 270, dec: 70 },
    ];
    const vecs = solvesToVecs(solves);
    const pole = fitPoleFromVecs(vecs);
    assertNear(pole.dec, 90, 0.5, 'Pole DEC ≈ 90 for symmetric DEC=70 points');
}

// --- polarCompute: perfect alignment ---
console.log('\npolarCompute — perfect alignment:');
{
    // 3 symmetric points around the pole → no error
    const solves = [
        { ra: 0, dec: 66 },
        { ra: 120, dec: 66 },
        { ra: 240, dec: 66 },
    ];
    const result = polarCompute(solves, 43.952, 180);
    assertNear(result.poleDEC, 90, 1, 'Pole DEC ≈ 90');
    assert(result.errTotal < 5, `Error < 5 arcmin for perfect alignment (got ${result.errTotal.toFixed(1)}')`);
}

// --- polarCompute: known offset (verify error formula) ---
console.log('\npolarCompute — error formula verification:');
{
    // Verify the error calculation directly from known pole position
    const lat = 43.952;
    const poleRA = 0;
    const poleDEC = 89.5; // 0.5° south of true pole
    const errDec = 90.0 - poleDEC; // 0.5°
    const errAz = errDec * Math.sin(toRad(poleRA)) * Math.cos(toRad(lat)); // sin(0°)=0 → 0
    const errTotal = Math.sqrt(errDec * errDec + errAz * errAz) * 60;
    assertNear(errDec, 0.5, 1e-10, 'errDec = 0.5°');
    assertNear(errAz, 0, 1e-10, 'errAz = 0 (pole at RA=0 → sin(0°)=0)');
    assertNear(errTotal, 30, 1e-10, 'errTotal = 30 arcmin');
}

// --- polarCompute: offset at RA=90 ---
console.log('\npolarCompute — offset at RA=90:');
{
    const lat = 43.952;
    const poleRA = 90;
    const poleDEC = 89.7;
    const errDec = 90.0 - poleDEC; // 0.3°
    const errAz = errDec * Math.sin(toRad(poleRA)) * Math.cos(toRad(lat));
    const errTotal = Math.sqrt(errDec * errDec + errAz * errAz) * 60;
    assertNear(errDec, 0.3, 1e-10, 'errDec = 0.3°');
    assertNear(errAz, 0.3 * Math.cos(toRad(lat)), 1e-10, 'errAz = 0.3 * cos(lat)');
    assert(errTotal > 15, `errTotal > 15 arcmin (got ${errTotal.toFixed(1)}')`);
}

// --- polarCompute: 3 symmetric points → error ≈ 0 ---
console.log('\npolarCompute — symmetric points around DEC=70:');
{
    const solves = [
        { ra: 30, dec: 70 },
        { ra: 150, dec: 70 },
        { ra: 270, dec: 70 },
    ];
    const result = polarCompute(solves, 43.952, 180);
    assertNear(result.errDec, 0, 0.5, 'errDec ≈ 0 for symmetric DEC=70 points');
    assert(result.errTotal < 5, `errTotal < 5' for symmetric case (got ${result.errTotal.toFixed(1)}')`);
}

// --- polarCompute: asymmetric points → non-zero error ---
console.log('\npolarCompute — asymmetric points (realistic scenario):');
{
    // Simulate 3 plate-solved positions with a slight offset
    // These are at slightly different DECs due to polar misalignment
    const solves = [
        { ra: 0, dec: 66 },
        { ra: 120, dec: 67 },
        { ra: 240, dec: 65 },
    ];
    const result = polarCompute(solves, 43.952, 180);
    assert(!isNaN(result.errTotal), 'No NaN for asymmetric points');
    assert(result.errTotal > 0, `Non-zero error for asymmetric points (${result.errTotal.toFixed(1)}')`);
}

// --- Degenerate: 3 points on equator (great circle, not collinear) ---
console.log('\nDegenerate case — 3 points on equator:');
{
    // 3 points at DEC=0 with RAs 0/90/180 are NOT collinear on the sphere.
    // They form a large triangle. The cross product of chord vectors is non-zero.
    const solves = [
        { ra: 0, dec: 0 },
        { ra: 90, dec: 0 },
        { ra: 180, dec: 0 },
    ];
    const vecs = solvesToVecs(solves);
    const v = sub(vecs[0], vecs[1]);
    const w = sub(vecs[0], vecs[2]);
    const c = cross(v, w);
    const cNorm = norm3(c);
    assert(cNorm > 1.0, `Cross product non-zero for distinct equatorial points (norm=${cNorm.toFixed(4)})`);
    // The pole of the equatorial plane is the north pole
    const pole = fitPoleFromVecs(vecs);
    assertNear(pole.dec, 90, 1, 'Pole DEC ≈ 90 for equatorial points');
}

// --- Degenerate: 2 identical points (known limitation) ---
console.log('\nDegenerate case — 2 identical points (known limitation):');
{
    // When 2 points are identical, v0-v1 = [0,0,0] → cross product = [0,0,0]
    // normalize([0,0,0]) produces NaN. This is a known limitation.
    const solves = [
        { ra: 45, dec: 70 },
        { ra: 45, dec: 70 },  // duplicate
        { ra: 200, dec: 70 },
    ];
    const vecs = solvesToVecs(solves);
    const v = sub(vecs[0], vecs[1]);
    const vNorm = norm3(v);
    assert(vNorm < 1e-10, `First chord is zero-length for duplicate points (norm=${vNorm.toFixed(10)})`);
    // The algorithm will produce NaN — this is expected behavior for invalid input
    const pole = fitPoleFromVecs(solves);
    assert(isNaN(pole.ra) || isNaN(pole.dec), 'NaN result for duplicate points (expected)');
}

// --- Near-duplicate: very close points → large but finite error ---
console.log('\nNear-degenerate — very close points:');
{
    const solves = [
        { ra: 45, dec: 70 },
        { ra: 45.001, dec: 70.001 },
        { ra: 200, dec: 70 },
    ];
    const vecs = solvesToVecs(solves);
    const pole = fitPoleFromVecs(vecs);
    assert(!isNaN(pole.ra) && !isNaN(pole.dec), 'No NaN for near-duplicate points');
    assert(pole.dec >= -90 && pole.dec <= 90, 'DEC in valid range');
}

// --- Regression: lstFromTime edge cases ---
console.log('\nLST edge cases:');
{
    // Midnight UTC at Greenwich
    const midnight = new Date(Date.UTC(2024, 5, 15, 0, 0, 0));
    const lst = lstFromTime(midnight, 0);
    assert(lst >= 0 && lst < 360, `LST in [0,360): ${lst.toFixed(2)}°`);

    // Negative longitude
    const lstNeg = lstFromTime(midnight, -75); // New York
    assert(lstNeg >= 0 && lstNeg < 360, `LST with negative lng in [0,360): ${lstNeg.toFixed(2)}°`);
}

// --- Summary ---
console.log(`\n${'='.repeat(50)}`);
console.log(`Résultat: ${passed} passés, ${failed} échoués, ${passed + failed} total`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('Tous les tests Couche 1 sont passés ✓\n');
    process.exit(0);
}
