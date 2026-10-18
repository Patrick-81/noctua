// ═══════════════════════════════════════════════════════════════
// Noctua — recenter_math.js
// Conversion pixel ↔ ciel pour le recentrage au clic (Lot 3).
// Pur, sans DOM ni fetch : testé par node tests/test_recenter_math.js.
// Modèle petit champ : le solve fournit le centre (ra,dec), l'échelle
// (arcsec/px) et la rotation de l'image ; on en déduit la coordonnée ciel
// d'un pixel cliqué (et réciproquement). Mêmes hypothèses que le vecteur
// d'offset (preview.js drawOffsetVector) → cohérence avec la boucle de
// centrage existante (target.js).
// ═══════════════════════════════════════════════════════════════
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.RecenterMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    function wrapRA(ra) { return ((ra % 360) + 360) % 360; }

    // u,v ∈ [0,1] : position du clic dans l'image affichée (origine haut-gauche).
    // res : résultat de solve {ra, dec (deg), scale (arcsec/px), rotation (deg),
    //        width, height (px)}.
    function pixelToSky(u, v, res) {
        const dxPx = (u - 0.5) * res.width;
        const dyPx = (v - 0.5) * res.height;
        // Repère canvas : y croissant vers le bas → on inverse pour le ciel.
        const rdx = dxPx, rdy = -dyPx;
        const rot = (res.rotation || 0) * Math.PI / 180;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        // Rotation inverse de celle appliquée au vecteur d'offset.
        const ddx = rdx * cosR + rdy * sinR;
        const ddy = -rdx * sinR + rdy * cosR;
        const scaleArcminPx = (res.scale || 0) / 60.0;
        const dec = Math.max(-90, Math.min(90, res.dec + ddy * scaleArcminPx / 60.0));
        return { ra: wrapRA(res.ra + ddx * scaleArcminPx / 60.0), dec };
    }

    // Inverse : fraction pixel (u,v) d'une coordonnée ciel. Sert au test
    // aller-retour et à d'éventuels overlays.
    function skyToPixel(ra, dec, res) {
        const scaleArcminPx = (res.scale || 0) / 60.0;
        let dRA = ra - res.ra;
        if (dRA > 180) dRA -= 360;
        if (dRA < -180) dRA += 360;
        const dDEC = dec - res.dec;
        const dxPx = dRA * 60.0 / scaleArcminPx;
        const dyPx = dDEC * 60.0 / scaleArcminPx;
        const rot = (res.rotation || 0) * Math.PI / 180;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        const rdx = dxPx * cosR - dyPx * sinR;
        const rdy = dxPx * sinR + dyPx * cosR;
        return { u: 0.5 + rdx / res.width, v: 0.5 - rdy / res.height };
    }

    return { pixelToSky, skyToPixel, wrapRA };
});
