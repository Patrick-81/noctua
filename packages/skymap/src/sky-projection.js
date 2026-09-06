// sky-projection.js — Projection orthographique rapide pour la couche étoiles.
// Pur module ESM sans dépendance DOM/d3 : testé par tests/sky-projection.spec.js
// (parité avec d3.geo.orthographic sur des points réels transportés dans la page).

const DEG = Math.PI / 180;

// Vecteur unitaire d'un point équatorial (ra, dec en degrés).
export function raDecToUnit(raDeg, decDeg) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    const cd = Math.cos(dec);
    return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

// Bases tangentes (est / nord) au centre : permettent de projeter par produits
// scalaires, sans appeler sin/cos par étoile à chaque frame.
function tangentBasis(centerRA, centerDec) {
    const a = centerRA * DEG;
    const d = centerDec * DEG;
    const cd = Math.cos(d), sd = Math.sin(d);
    const ca = Math.cos(a), sa = Math.sin(a);
    // est : +RA croissant
    const east = [-sa, ca, 0];
    // nord : +Dec croissant
    const north = [-sd * ca, -sd * sa, cd];
    return [east, north];
}

// Projection d'un seul point en coordonnées écran.
// centerRA / centerDec : centre de la carte (degrés).
// Retourne null si le point est hors de l'hémisphère visible (clip à 90°).
export function projectPoint(raDeg, decDeg, centerRA, centerDec, scale, tx, ty) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    const cRA = centerRA * DEG;
    const cDec = centerDec * DEG;

    const cosDec = Math.cos(dec), sinDec = Math.sin(dec);
    const cosCD = Math.cos(cDec), sinCD = Math.sin(cDec);
    const cosDR = Math.cos(ra - cRA), sinDR = Math.sin(ra - cRA);

    // cos de la distance angulaire au centre : positif = hémisphère visible
    const cz = cosDec * cosCD * cosDR + sinDec * sinCD;
    if (cz <= 0) return null;

    const rawX = -cosDec * sinDR;
    const rawY = sinDec * cosCD - cosDec * sinCD * cosDR;
    return [rawX * scale + tx, -rawY * scale + ty];
}

// Précalcule les vecteurs unitaires de toutes les étoiles, triés par magnitude
// croissante (les plus brillantes d'abord → permettent un plafonnement simple).
export function buildStarVectors(features) {
    const stars = [];
    for (const f of features || []) {
        const coords = f.geometry && f.geometry.coordinates;
        if (!coords || coords.length < 2) continue;
        const mag = Number(f.properties && f.properties.mag);
        if (!isFinite(mag)) continue;
        stars.push({ u: raDecToUnit(coords[0], coords[1]), mag, id: f.id });
    }
    stars.sort((a, b) => a.mag - b.mag);
    return stars;
}

// Projette les étoiles visibles dans `out` (triplés x, y, size).
// - Respecte le seuil de magnitude (magMax) ; `stars` étant trié par magnitude
//   croissante, on sort de la boucle dès qu'on le dépasse.
// - Ne compte / n'écrit que les étoiles à moins d'une demi-diagonale de
//   canvas du centre (tx, ty) : le budget `maxStars` est donc dépensé pour
//   l'écran visible, si bien qu'en zoomant on atteint des étoiles plus
//   faibles. Rayon (et pas rectangle) car l'appelant fait pivoter toute la
//   couche étoiles de l'angle parallactique autour de (tx, ty) APRÈS coup.
// - sizeFn(mag) calcule le rayon d'affichage.
// Retourne le nombre d'étoiles écrites.
// nameOf / namesOut / maxNames (optionnels) : quand nameOf(star) renvoie une
// chaîne non vide, elle est ajoutée à namesOut en triplets [x, y, texte, ...],
// les plus brillantes d'abord, plafonné à maxNames.
// stereo (optionnel) : projection stéréographique au lieu d'orthographique —
// divise les coordonnées du plan tangent par (1 + cz), montre au-delà d'un
// hémisphère.
export function projectStars(stars, centerRA, centerDec, scale, tx, ty, magMax, maxStars, out, sizeFn,
    nameOf, namesOut, maxNames, stereo) {
    const [east, north] = tangentBasis(centerRA, centerDec);
    const c = raDecToUnit(centerRA, centerDec);
    // Cull radius = half the canvas diagonal (+ a small margin). The caller
    // rotates the whole star layer by the parallactic angle around (tx, ty)
    // AFTER this runs, so a tight [0,w]×[0,h] rectangle test would wrongly
    // drop stars destined for the screen corners once rotated — leaving a
    // band of stars parallel to the un-rotated frame, tilted on screen with
    // the horizon. A radial test around the rotation centre is rotation-proof.
    const cullR2 = (Math.hypot(tx, ty) + 8) ** 2;
    const czMin = 0;   // both modes clip at the hemisphere (stereo edge stays finite)
    const wantNames = !!(nameOf && namesOut && maxNames);
    let count = 0;
    let nameCount = 0;
    for (const s of stars) {
        if (s.mag > magMax) break;
        const u = s.u;
        const cz = u[0] * c[0] + u[1] * c[1] + u[2] * c[2];
        if (cz <= czMin) continue;
        let rawX = -(u[0] * east[0] + u[1] * east[1] + u[2] * east[2]);
        let rawY = u[0] * north[0] + u[1] * north[1] + u[2] * north[2];
        if (stereo) { const k = 1 + cz; rawX /= k; rawY /= k; }
        const px = rawX * scale + tx;
        const py = -rawY * scale + ty;
        const dpx = px - tx, dpy = py - ty;
        if (dpx * dpx + dpy * dpy > cullR2) continue;
        out.push(px, py, sizeFn(s.mag));
        count++;
        if (wantNames && nameCount < maxNames) {
            const nm = nameOf(s);
            if (nm) { namesOut.push(px, py, nm); nameCount++; }
        }
        if (count >= maxStars) break;
    }
    return count;
}