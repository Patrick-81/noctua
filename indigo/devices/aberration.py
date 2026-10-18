"""
aberration.py — Atelier Aberration & Tilt — logique pure.

Analyse une image FITS/PNG (capturée ou chargée) :
  - Détection d'étoiles + HFR/FWHM/ellipticité (focus_metrics)
  - Estimation aberrations : coma (asymétrie centroïde), astigmatisme (ellipticité moyenne), tilt capteur (gradient HFR)
  - Lecture/écriture header FITS via fitsmeta (sans astropy)

Fonctions pures, testables sans INDIGO.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .focus_metrics import parse_fits, find_stars, compute_hfr, compute_fwhm
from .fitsmeta import read_header, inject_meta, frame_meta


def _ellipticity(image: np.ndarray, cx: int, cy: int, radius: int = 12) -> tuple[float, float]:
    """Ellipticité 0=ronde, 1=allongée, via moments 2nd ordre. Retourne (ellip, angle_deg)."""
    h, w = image.shape
    r0 = max(0, cx - radius); r1 = min(w, cx + radius + 1)
    b0 = max(0, cy - radius); b1 = min(h, cy + radius + 1)
    region = image[b0:b1, r0:r1].astype(np.float64)
    if region.size == 0:
        return 0.0, 0.0
    bg = float(np.median(region))
    region = np.maximum(region - bg, 0)
    total = float(region.sum())
    if total <= 0:
        return 0.0, 0.0
    yy, xx = np.mgrid[b0:b1, r0:r1]
    x = xx - cx
    y = yy - cy
    # moments centrés pondérés
    wgt = region / total
    x2 = float(np.sum(wgt * x * x))
    y2 = float(np.sum(wgt * y * y))
    xy = float(np.sum(wgt * x * y))
    # ellipticité = 1 - b/a ; a,b = axes ellipse via eigenvalues
    # eigen = 0.5*(x2+y2 +/- sqrt((x2-y2)^2+4xy^2))
    tr = x2 + y2
    det = x2 * y2 - xy * xy
    disc = max(0, tr*tr/4 - det)
    if disc <= 0:
        return 0.0, 0.0
    s = math.sqrt(disc)
    lam1 = tr/2 + s
    lam2 = tr/2 - s
    if lam1 <= 0:
        return 0.0, 0.0
    ratio = math.sqrt(max(0, lam2 / lam1)) if lam1 > 0 else 0
    ellip = float(1 - ratio)
    # angle du grand axe (deg, 0°=X, 90°=Y)
    angle = float(0.5 * math.degrees(math.atan2(2 * xy, x2 - y2)))
    return ellip, angle


def _coma_asymmetry(image: np.ndarray, cx: int, cy: int, radius: int = 12) -> tuple[float, float]:
    """Asymétrie coma : vecteur centroïde pondéré vs pic (dx, dy) en px."""
    h, w = image.shape
    r0 = max(0, cx - radius); r1 = min(w, cx + radius + 1)
    b0 = max(0, cy - radius); b1 = min(h, cy + radius + 1)
    region = image[b0:b1, r0:r1].astype(np.float64)
    if region.size == 0:
        return 0.0, 0.0
    bg = float(np.median(region))
    region = np.maximum(region - bg, 0)
    total = float(region.sum())
    if total <= 0:
        return 0.0, 0.0
    yy, xx = np.mgrid[b0:b1, r0:r1]
    # barycentre pondéré
    bx = float(np.sum(region * xx) / total)
    by = float(np.sum(region * yy) / total)
    # pic
    peak_y, peak_x = np.unravel_index(int(region.argmax()), region.shape)
    px = r0 + peak_x
    py = b0 + peak_y
    return float(bx - px), float(by - py)


def _r2(y: np.ndarray, y_pred: np.ndarray) -> float:
    """Coefficient de détermination R² (1 = parfait). 0 si variance nulle."""
    y = np.asarray(y, dtype=float)
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    if ss_tot <= 1e-12:
        return 0.0
    return float(max(0.0, 1.0 - ss_res / ss_tot))


def tilt_plane_fit(stars: list[dict], width: int, height: int) -> dict:
    """Plan HFR = c + a·xn + b·yn (coords normalisées 0-1) + résidus.

    C'est la signature réelle d'un tilt capteur : le front d'onde varie
    linéairement sur le champ. Retourne les coefficients, la magnitude et
    l'angle du gradient, le R², et le résidu de chaque étoile (aligné sur
    l'ordre d'entrée) pour tracer la courbe de résidus.
    """
    w = max(int(width), 1)
    h = max(int(height), 1)
    empty = {
        "a": 0.0, "b": 0.0, "c": 0.0, "mag": 0.0, "angle_deg": 0.0,
        "rms": 0.0, "max_resid": 0.0, "r2": 0.0, "n": 0, "residuals": [],
    }
    if len(stars) < 3:
        return empty
    xs = np.array([s["x"] for s in stars], dtype=float) / w
    ys = np.array([s["y"] for s in stars], dtype=float) / h
    hs = np.array([s["hfr"] for s in stars], dtype=float)
    A = np.column_stack([xs, ys, np.ones_like(xs)])
    try:
        coeff, *_ = np.linalg.lstsq(A, hs, rcond=None)
    except Exception:
        return empty
    a, b, c = (float(coeff[0]), float(coeff[1]), float(coeff[2]))
    pred = c + a * xs + b * ys
    resid = hs - pred
    return {
        "a": round(a, 4), "b": round(b, 4), "c": round(c, 4),
        "mag": round(float(math.hypot(a, b)), 4),
        "angle_deg": round(float(math.degrees(math.atan2(b, a))), 1),
        "rms": round(float(np.sqrt(np.mean(resid ** 2))), 3),
        "max_resid": round(float(np.max(np.abs(resid))), 3),
        "r2": round(_r2(hs, pred), 3),
        "n": len(stars),
        "residuals": [round(float(r), 3) for r in resid],
    }


def field_curvature_fit(stars: list[dict], width: int, height: int) -> dict:
    """Courbure de champ : HFR = h0 + k·u² (u = rayon normalisé 0-1).

    Le meilleur foyer varie avec le rayon : si le HFR croît vers les bords,
    le capteur est hors du plan focal optimal (backfocus). ``k`` mesure la
    courbure (HFR de plus au bord), ``r2`` la qualité du fit parabolique.
    """
    w = max(int(width), 1)
    h = max(int(height), 1)
    empty = {
        "center_hfr": 0.0, "edge_hfr": 0.0, "k": 0.0, "r2": 0.0,
        "n": 0, "edge_ratio": 1.0, "radii": [],
    }
    if len(stars) < 4:
        return empty
    cx, cy = w / 2.0, h / 2.0
    r_max = float(math.hypot(cx, cy)) or 1.0
    xs = np.array([s["x"] for s in stars], dtype=float)
    ys = np.array([s["y"] for s in stars], dtype=float)
    hs = np.array([s["hfr"] for s in stars], dtype=float)
    u = np.hypot(xs - cx, ys - cy) / r_max
    A = np.column_stack([np.ones_like(u), u ** 2])
    try:
        coeff, *_ = np.linalg.lstsq(A, hs, rcond=None)
    except Exception:
        return empty
    h0, k = float(coeff[0]), float(coeff[1])
    pred = h0 + k * u ** 2
    center_hfr = max(h0, 1e-6)
    edge_hfr = h0 + k
    return {
        "center_hfr": round(h0, 3),
        "edge_hfr": round(edge_hfr, 3),
        "k": round(k, 4),
        "r2": round(_r2(hs, pred), 3),
        "n": len(stars),
        "edge_ratio": round(edge_hfr / center_hfr, 3),
        "radii": [round(float(x), 3) for x in u],
    }


def grid_hfr(stars: list[dict], width: int, height: int, n: int = 3) -> list[dict]:
    """Grille n×n : HFR médian par cellule (heatmap tilt).

    Retourne une liste de cellules {row, col, median_hfr, count} (row=0 en
    haut). Utilisé pour la carte de chaleur du tilt (parallelogramme).
    """
    w = max(int(width), 1)
    h = max(int(height), 1)
    buckets: dict[tuple[int, int], list[float]] = {}
    for s in stars:
        hfr = s.get("hfr") or 0.0
        if hfr <= 0:
            continue
        col = min(n - 1, max(0, int(s["x"] / w * n)))
        row = min(n - 1, max(0, int(s["y"] / h * n)))
        buckets.setdefault((row, col), []).append(float(hfr))
    cells = []
    for row in range(n):
        for col in range(n):
            vals = buckets.get((row, col), [])
            cells.append({
                "row": row, "col": col,
                "median_hfr": round(float(np.median(vals)), 3) if vals else 0.0,
                "count": len(vals),
            })
    return cells


def fit_radial_distortion(
    x_meas, y_meas, x_ref, y_ref,
    width: int, height: int,
    order: int = 3, center: tuple[float, float] | None = None,
) -> dict:
    """Fit polynômial radial de distorsion optique à partir de paires d'étoiles.

    Modèle : r_mes = r_ref · (1 + k1·u² + k2·u⁴ + …) avec u = r_ref/r_max.
    On ajuste la distorsion relative d = (r_mes − r_ref)/r_ref = Σ ki·u^(2i)
    par moindres carrés. Retourne les coefficients, le RMS (radial), la
    distorsion max (% du rayon) et les résidus par paire.

    ``order`` = nombre de termes (1 → k1·u², 2 → + k2·u⁴, 3 → + k3·u⁶).
    """
    w = max(int(width), 1)
    h = max(int(height), 1)
    cx, cy = center if center is not None else (w / 2.0, h / 2.0)
    r_max = float(math.hypot(cx, cy)) or 1.0
    xr = np.asarray(x_ref, dtype=float)
    yr = np.asarray(y_ref, dtype=float)
    xm = np.asarray(x_meas, dtype=float)
    ym = np.asarray(y_meas, dtype=float)
    n = xr.size
    empty = {
        "ok": False, "coefficients": [], "rms_px": 0.0,
        "rms_relative": 0.0, "max_distortion_percent": 0.0, "n": n,
    }
    if n < 4:
        return empty
    r_ref = np.hypot(xr - cx, yr - cy)
    r_meas = np.hypot(xm - cx, ym - cy)
    valid = r_ref > 1e-6
    if int(np.count_nonzero(valid)) < 4:
        return empty
    r_ref, r_meas = r_ref[valid], r_meas[valid]
    u = r_ref / r_max
    d = (r_meas - r_ref) / r_ref  # distorsion relative radiale
    order = max(1, min(int(order), 4))
    A = np.column_stack([u ** (2 * (i + 1)) for i in range(order)])
    try:
        coeff, *_ = np.linalg.lstsq(A, d, rcond=None)
    except Exception:
        return empty
    pred = A @ coeff
    rms_relative = float(np.sqrt(np.mean((d - pred) ** 2)))
    # distorsion max sur le champ (u jusqu'à 1)
    u_field = np.linspace(0.0, 1.0, 50)
    d_field = sum(float(coeff[i]) * u_field ** (2 * (i + 1)) for i in range(order))
    return {
        "ok": True,
        "coefficients": [round(float(c), 6) for c in coeff],
        "order": order,
        "rms_relative": round(rms_relative, 6),
        "rms_px": round(float(np.sqrt(np.mean((d - pred) ** 2 * r_ref ** 2))), 3),
        "max_distortion_percent": round(float(np.max(np.abs(d_field))) * 100.0, 3),
        "n": int(r_ref.size),
        "radial_profile": [
            [round(float(u_field[i]), 3), round(float(d_field[i]) * 100.0, 4)]
            for i in range(len(u_field))
        ],
    }


def analyze_image(data: bytes) -> dict:
    """
    Analyse complète d'une image FITS (bytes).

    Retourne dict avec :
      - stars: liste {x,y,flux,peak,hfr,fwhm,ellip,coma_dx,coma_dy,snr}
      - global: hfr_mean, fwhm_mean, ellip_mean, coma_mean, tilt_vector, tilt_mag
      - header: dict FITS
    """
    img, w, h = parse_fits(data)
    if img is None:
        # fallback PNG/JPG déjà décodé ailleurs ? On tente numpy load via data bytes ?
        return {"ok": False, "error": "FITS non parsable — chargez un FITS 8/16/32 bits"}

    values, _cards, _hdr = read_header(data)

    bg_median = float(np.nanmedian(img))
    bg_std = float(np.nanstd(img))
    # floor adaptatif pour SNR (évite /0 sur stack 0-1)
    bg_std_floor = 1e-6 if bg_median < 5.0 else 1.0
    stars_all = find_stars(img, threshold_sigma=5.0, min_distance=8, max_stars=80)

    if not stars_all:
        return {"ok": True, "stars": [], "global": {"star_count": 0}, "header": values, "width": w, "height": h}

    # Détection saturation : pic proche du max image (plateau écrêté)
    img_max = float(np.nanmax(img))
    # Seuil saturation : 95% du max ou 65530 pour 16-bit
    sat_thresh = img_max * 0.95 if img_max > 10 else img_max * 0.98
    for s in stars_all:
        s["saturated"] = bool(s["peak"] >= sat_thresh)

    # Enrichir chaque étoile
    for s in stars_all:
        x, y = int(s["x"]), int(s["y"])
        s["hfr"] = round(float(compute_hfr(img, x, y, bg_median=bg_median)), 2)
        s["fwhm"] = round(float(compute_fwhm(img, x, y, bg_median=bg_median)), 2)
        ellip, angle = _ellipticity(img, x, y)
        s["ellip"] = round(float(ellip), 3)
        s["ellip_angle"] = round(float(angle), 1)
        cdx, cdy = _coma_asymmetry(img, x, y)
        s["coma_dx"] = round(float(cdx), 2)
        s["coma_dy"] = round(float(cdy), 2)
        s["coma_mag"] = round(float(math.hypot(cdx, cdy)), 2)
        # SNR avec floor adaptatif
        snr = (s["peak"] - bg_median) / max(bg_std, bg_std_floor)
        s["snr"] = round(float(snr), 1)

    # Tri qualité : non saturées d'abord
    stars_all.sort(key=lambda s: (s["saturated"], -s["snr"], s["hfr"]))
    stars = stars_all

    # Globaux — calcul sur étoiles non saturées si possible
    usable = [s for s in stars if not s["saturated"] and s["hfr"] > 0 and s["hfr"] < 20]
    # fallback : si tout saturé, on prend tout mais on flag
    pool = usable if len(usable) >= 6 else stars

    tilt = tilt_plane_fit(pool, w, h)
    tilt_dx = tilt["a"]      # variation HFR en x (coords normalisées)
    tilt_dy = tilt["b"]
    tilt_mag = tilt["mag"]
    curvature = field_curvature_fit(pool, w, h)
    grid = grid_hfr(pool, w, h)

    # Résidus du plan de tilt attachés à chaque étoile (courbe tilt + résidu)
    xs_n = np.array([s["x"] for s in stars], dtype=float) / max(w, 1)
    ys_n = np.array([s["y"] for s in stars], dtype=float) / max(h, 1)
    for s, xn, yn in zip(stars, xs_n, ys_n):
        pred = tilt["c"] + tilt_dx * xn + tilt_dy * yn
        s["tilt_pred"] = round(float(pred), 3)
        s["tilt_resid"] = round(float(s["hfr"] - pred), 3)

    ellip_mean = float(np.mean([s["ellip"] for s in pool])) if pool else 0
    coma_mean = float(np.mean([s["coma_mag"] for s in pool])) if pool else 0
    hfr_mean = float(np.mean([s["hfr"] for s in pool])) if pool else 0
    fwhm_mean = float(np.mean([s["fwhm"] for s in pool])) if pool else 0

    # Classification simple
    quality = "good"
    if tilt_mag > 0.8 or ellip_mean > 0.25 or coma_mean > 0.6:
        quality = "tilt" if tilt_mag > 0.8 else ("coma" if coma_mean > 0.6 else "astig")
    elif hfr_mean > 4.5:
        quality = "defocus"

    sat_count = sum(1 for s in stars if s["saturated"])
    usable_len = len(usable)
    # Si tout est saturé, tilt/coma non fiables
    if usable_len < 6:
        # on garde hfr_mean mais on signale saturation
        if sat_count == len(stars) and sat_count > 0:
            quality = "saturated"
            tilt_dx = tilt_dy = tilt_mag = 0.0
            for k in ("a", "b", "mag", "rms", "max_resid", "r2"):
                tilt[k] = 0.0
            curvature = {"center_hfr": 0.0, "edge_hfr": 0.0, "k": 0.0,
                         "r2": 0.0, "n": 0, "edge_ratio": 1.0, "radii": []}
            for s in stars:
                s["tilt_pred"] = 0.0
                s["tilt_resid"] = 0.0
        # sinon on a fallback pool = stars mais on garde qualité tilt si mesuré
    return {
        "ok": True,
        "stars": stars[:60],
        "global": {
            "star_count": len(stars),
            "usable_count": usable_len,
            "saturated_count": sat_count,
            "hfr_mean": round(hfr_mean, 2),
            "fwhm_mean": round(fwhm_mean, 2),
            "ellip_mean": round(ellip_mean, 3),
            "coma_mean": round(coma_mean, 2),
            "tilt_dx": round(tilt_dx, 3),
            "tilt_dy": round(tilt_dy, 3),
            "tilt_mag": round(tilt_mag, 3),
            "tilt": tilt,
            "curvature": curvature,
            "grid": grid,
            "quality": quality,
            "bg_median": round(bg_median, 1),
            "bg_std": round(bg_std, 1),
        },
        "header": values,
        "width": w,
        "height": h,
    }


def analyze_file(path: str | Path) -> dict:
    """Helper fichier FITS/PNG -> analyze_image."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext in (".fit", ".fits"):
        data = p.read_bytes()
        return analyze_image(data)
    elif ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy"):
        # Convertir via Pillow/numpy -> FITS bytes minimal pour réutiliser le pipeline ?
        # Plus simple : charger en numpy et simuler une image FITS
        import numpy as np
        if ext == ".npy":
            arr = np.load(p).astype(np.float64)
        else:
            from PIL import Image
            arr = np.array(Image.open(p).convert("L"), dtype=np.float64)
        # Créer un faux header et appeler le cœur directement
        # On bypass parse_fits en injectant arr directement
        h, w = arr.shape
        # Simuler l'analyse sans header
        bg_median = float(np.nanmedian(arr))
        # Réutiliser find_stars/compute
        stars = find_stars(arr, threshold_sigma=5.0, min_distance=8, max_stars=60)
        for s in stars:
            x, y = int(s["x"]), int(s["y"])
            s["hfr"] = round(float(compute_hfr(arr, x, y, bg_median=bg_median)), 2)
            s["fwhm"] = round(float(compute_fwhm(arr, x, y, bg_median=bg_median)), 2)
            ellip, angle = _ellipticity(arr, x, y)
            s["ellip"] = round(float(ellip), 3); s["ellip_angle"] = round(float(angle), 1)
            cdx, cdy = _coma_asymmetry(arr, x, y)
            s["coma_dx"] = round(float(cdx), 2); s["coma_dy"] = round(float(cdy), 2)
            s["coma_mag"] = round(float(math.hypot(cdx, cdy)), 2)
        return {"ok": True, "stars": stars, "global": {"star_count": len(stars)}, "header": {}, "width": w, "height": h}
    else:
        return {"ok": False, "error": f"Format non supporté : {ext}"}
