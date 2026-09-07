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

    tilt_dx = tilt_dy = tilt_mag = 0.0
    if len(pool) >= 6:
        xs = np.array([s["x"] for s in pool], dtype=float)
        ys = np.array([s["y"] for s in pool], dtype=float)
        hs = np.array([s["hfr"] for s in pool], dtype=float)
        # normaliser coords 0-1
        xn = xs / max(w, 1)
        yn = ys / max(h, 1)
        A = np.column_stack([xn, yn, np.ones_like(xn)])
        try:
            coeff, *_ = np.linalg.lstsq(A, hs, rcond=None)
            tilt_dx = float(coeff[0])  # variation HFR en x
            tilt_dy = float(coeff[1])
            tilt_mag = float(math.hypot(tilt_dx, tilt_dy))
        except Exception:
            pass

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
