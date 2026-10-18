"""distortion.py — Distorsion optique (fit radial) via solve astrométrique.

Pipeline (nécessite seiza + catalogue chargé par le solveur) :
  1. Résout la plaque (seiza.solve) avec indices RA/DEC/échelle
     (auto-remplis depuis le WCS FITS ou la monture si absents).
  2. Projette les étoiles de catalogue du champ en pixels via le WCS.
  3. Apparie les étoiles détectées aux références (plus proche voisin).
  4. Ajuste la distorsion radiale relative (aberration.fit_radial_distortion).

Sans seiza ou sans catalogue, retourne ``{"ok": False, "error": ...}`` avec un
message exploitable côté UI. Logique de fit pure testable dans aberration.py.
"""

from __future__ import annotations

import logging

import numpy as np

from .aberration import fit_radial_distortion

log = logging.getLogger("indigo.distortion")


def analyze_distortion(
    data: bytes,
    solver,
    *,
    fmt: str = "fits",
    ra_hint: float | None = None,
    dec_hint: float | None = None,
    scale_hint: float | None = None,
    order: int = 3,
    sigma: float = 2.0,
    match_tol_px: float = 5.0,
) -> dict:
    """Analyse de distorsion radiale d'une image via un solve astrométrique.

    ``solver`` : instance ``indigo.devices.solver.Solver`` (catalogue + parse).
    """
    try:
        import seiza
    except Exception as e:  # pragma: no cover - dépend de l'environnement
        return {"ok": False, "error": f"seiza indisponible : {e}"}

    if not solver.is_ready or solver.catalog is None:
        return {
            "ok": False,
            "error": "Solveur non prêt — catalogue non chargé "
                     "(POST /api/solver/catalogs)",
        }

    img, w, h = solver._parse_image(data, fmt)
    if img is None:
        return {"ok": False, "error": "Image non parsable (FITS/JPEG)"}

    # Auto-hint depuis le WCS FITS si les indices sont incomplets
    if ra_hint is None or dec_hint is None or scale_hint is None:
        wcs0 = solver._extract_wcs(data)
        if wcs0:
            if ra_hint is None:
                ra_hint = wcs0.get("crval1")
            if dec_hint is None:
                dec_hint = wcs0.get("crval2")
            if scale_hint is None and wcs0.get("cdelt1") is not None:
                scale_hint = abs(wcs0["cdelt1"]) * 3600.0

    if ra_hint is None or dec_hint is None or scale_hint is None:
        return {
            "ok": False,
            "error": "Indices RA/DEC/échelle requis (WCS absent — utilisez une "
                     "image résolue ou fournissez les hints)",
        }

    try:
        stars = seiza.detect(img, sigma=sigma)
    except Exception as e:
        return {"ok": False, "error": f"Détection d'étoiles échouée : {e}"}

    if len(stars) < 5:
        return {"ok": False, "error": f"Trop peu d'étoiles détectées ({len(stars)})"}

    try:
        sol = seiza.solve(
            stars, solver.catalog, w, h,
            ra=float(ra_hint), dec=float(dec_hint),
            scale_arcsec_px=float(scale_hint),
        )
    except Exception as e:
        return {"ok": False, "error": f"Solve astrométrique échoué : {e}"}

    wcs = sol.wcs
    # Rayon (deg) couvrant ~75% du plus grand côté
    field_r_deg = max(w, h) * wcs.scale_arcsec_px / 3600.0 * 0.75
    try:
        cat_stars = solver.catalog.cone_search(
            float(sol.ra), float(sol.dec), field_r_deg, limit=1000
        )
    except Exception as e:
        return {"ok": False, "error": f"Recherche catalogue échouée : {e}"}

    refs = []
    for entry in cat_stars:
        sra, sdec = float(entry[0]), float(entry[1])
        p = wcs.world_to_pixel(sra, sdec)
        if p is None:
            continue
        x, y = float(p[0]), float(p[1])
        if 0.0 <= x < w and 0.0 <= y < h:
            refs.append((x, y))
    if len(refs) < 4:
        return {
            "ok": False,
            "error": "Pas assez d'étoiles de catalogue dans le champ "
                     f"({len(refs)}) — solve douteux ?",
        }

    ref_arr = np.asarray(refs, dtype=float)
    xm: list[float] = []
    ym: list[float] = []
    xr: list[float] = []
    yr: list[float] = []
    for st in stars:
        d = np.hypot(ref_arr[:, 0] - st.x, ref_arr[:, 1] - st.y)
        i = int(np.argmin(d))
        if d[i] <= match_tol_px:
            xm.append(float(st.x)); ym.append(float(st.y))
            xr.append(float(ref_arr[i, 0])); yr.append(float(ref_arr[i, 1]))

    fit = fit_radial_distortion(xm, ym, xr, yr, w, h, order=order)
    if not fit.get("ok"):
        return {
            "ok": False,
            "error": f"Fit radial impossible ({len(xm)} paires appariées)",
        }

    return {
        "ok": True,
        "matched_stars": int(sol.matched_stars),
        "pairs": len(xm),
        "scale_arcsec_px": round(float(wcs.scale_arcsec_px), 4),
        "rotation_deg": round(float(sol.rotation_deg), 3),
        "rms_arcsec": round(float(sol.rms_arcsec), 3),
        "center_ra": round(float(sol.ra), 4),
        "center_dec": round(float(sol.dec), 4),
        "width": w,
        "height": h,
        "distortion": fit,
        "pairs_xy": [
            [round(xm[i], 2), round(ym[i], 2), round(xr[i], 2), round(yr[i], 2)]
            for i in range(len(xm))
        ],
    }
