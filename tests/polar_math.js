// ── Pure math functions for polar alignment ──────────────────────
// Extracted from web/static/app.js for testability.
// No DOM, no fetch, no side effects.

function lstFromTime(date, lngDeg) {
    const jd = (date.getTime() / 86400000) + 2440587.5;
    const t = (jd - 2451545.0) / 36525.0;
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t * t - (t * t * t) / 38710000.0;
    gmst = ((gmst % 360) + 360) % 360;
    let lst = (gmst + lngDeg) % 360;
    if (lst < 0) lst += 360;
    return lst;
}

function clampAngle(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v || 30));
}

function computeTargets(lstDeg, latDeg, angleMin) {
    const decDeg = 90.0 - latDeg + 20.0;
    const haOffsetDeg = angleMin / 4.0; // 1 min RA = 0.25° HA
    const haOffsets = [0, haOffsetDeg, -haOffsetDeg];
    return haOffsets.map(haOff => {
        const raDeg = ((lstDeg - haOff) % 360 + 360) % 360;
        return { ra_hours: raDeg / 15, dec_deg: decDeg };
    });
}

function decToSexa(deg) {
    const sign = deg < 0 ? '-' : '+';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mf = (abs - d) * 60;
    const m = Math.floor(mf);
    const s = Math.floor((mf - m) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${sign}${pad(d)}°${pad(m)}'${pad(s)}"`;
}

function raToSexa(raDeg) {
    const h = raDeg / 15;
    const hh = Math.floor(h);
    const mf = (h - hh) * 60;
    const mm = Math.floor(mf);
    const ss = Math.floor((mf - mm) * 60);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hh)}h${pad(mm)}m${pad(ss)}s`;
}

// ── Circle fit on the sphere ─────────────────────────────────────

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
];
const norm3 = v => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
const normalize = v => { const n = norm3(v); return [v[0] / n, v[1] / n, v[2] / n]; };

function solvesToVecs(solves) {
    return solves.map(s => {
        const ra = toRad(s.ra);
        const dec = toRad(s.dec);
        return [
            Math.cos(dec) * Math.cos(ra),
            Math.cos(dec) * Math.sin(ra),
            Math.sin(dec)
        ];
    });
}

function fitPoleFromVecs(vecs) {
    let pole = normalize(cross(sub(vecs[0], vecs[1]), sub(vecs[0], vecs[2])));
    if (pole[2] < 0) pole = pole.map(v => -v);
    const poleRA = ((toDeg(Math.atan2(pole[1], pole[0])) % 360) + 360) % 360;
    const poleDEC = toDeg(Math.asin(pole[2]));
    return { ra: poleRA, dec: poleDEC };
}

function polarCompute(solves, latDeg, lstDeg) {
    const vecs = solvesToVecs(solves);
    const pole = fitPoleFromVecs(vecs);

    const errDec = 90.0 - pole.dec;
    const errAz = errDec * Math.sin(toRad(pole.ra)) * Math.cos(toRad(latDeg));
    const errTotal = Math.sqrt(errDec * errDec + errAz * errAz) * 60; // arcmin

    return {
        poleRA: pole.ra,
        poleDEC: pole.dec,
        errDec,
        errAz,
        errTotal,
    };
}

module.exports = {
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
    normalize,
    solvesToVecs,
    fitPoleFromVecs,
    polarCompute,
};
