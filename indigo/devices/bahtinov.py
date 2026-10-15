"""
bahtinov.py — Bahtinov mask focus aid.

A Bahtinov mask produces 3 diffraction spikes on bright stars: two
diagonals (symmetric) + one central spike. At perfect focus the central
spike crosses the exact intersection of the diagonals; defocus shifts it
sideways. This module measures that shift from a FITS frame.

Method (no scipy needed):
  1. pick a bright unsaturated star (or the one nearest a click),
  2. crop ~257px, subtract background, intensity centroid,
  3. discrete Radon: for each angle, sum along the line through the
     centroid → the 3 spikes are the 3 dominant peaks,
  4. the central spike is the one the other two mirror
     (theta1 + theta2 ≈ 2 * theta_central, mod 180°),
  5. intersect the two diagonals, compare with the central spike at the
     same height → signed offset in pixels + confidence.

The sign→focus-direction mapping depends on how the mask is mounted, so
the UI offers an "invert" switch; only the magnitude is physics.
"""

from __future__ import annotations

import logging
import math

import numpy as np

from .focus_metrics import decode_image, find_stars

log = logging.getLogger("indigo.bahtinov")

CROP_SIZE = 257  # odd: centroid pixel centered
RADON_STEP_DEG = 1.0
MIN_PEAK_SEP_DEG = 10.0


def _radon_through_center(crop: np.ndarray, cx: float, cy: float,
                          step_deg: float = RADON_STEP_DEG) -> tuple[np.ndarray, np.ndarray]:
    """Sum along lines through (cx, cy) for each angle in [0, 180).

    Returns (angles_deg, profile). Pure numpy (nearest-pixel sampling).
    """
    h, w = crop.shape
    n = int(180.0 / step_deg)
    angles = np.arange(n, dtype=np.float64) * step_deg
    profile = np.zeros(n, dtype=np.float64)
    max_r = math.hypot(w, h) / 2.0
    steps = np.arange(-max_r, max_r + 1.0, 1.0)
    for i, deg in enumerate(angles):
        a = math.radians(deg)
        dx, dy = math.cos(a), math.sin(a)
        xs = np.clip((cx + dx * steps).astype(int), 0, w - 1)
        ys = np.clip((cy + dy * steps).astype(int), 0, h - 1)
        profile[i] = float(np.sum(crop[ys, xs]))
    return angles, profile


def _pick_peaks(angles: np.ndarray, profile: np.ndarray, count: int = 3,
                min_sep_deg: float = MIN_PEAK_SEP_DEG) -> list[float]:
    """Pick the `count` strongest local maxima separated by >= min_sep."""
    n = len(profile)
    pmax = float(np.max(profile))
    med = float(np.median(profile))
    std = float(np.std(profile))
    # Plancher mixte : bruit (1.5σ) + 10% de la dynamique. Les previews
    # JPEG atténuent les aigrettes (~+35% au-dessus du fond) : un plancher
    # purement statistique les raterait. La validation stricte (support de
    # flux + symétrie) élimine les faux pics — la détection reste généreuse.
    floor = med + max(1.5 * std, 0.1 * (pmax - med), 1e-9)
    is_peak = np.zeros(n, dtype=bool)
    for i in range(n):
        v = profile[i]
        if v < floor:
            continue
        prev_p = profile[(i - 1) % n]
        next_p = profile[(i + 1) % n]
        if v >= prev_p and v >= next_p:
            is_peak[i] = True
    order = np.argsort(profile)[::-1]
    picked: list[float] = []
    for i in order:
        if not is_peak[int(i)]:
            continue
        deg = float(angles[int(i)])
        if all(min(abs(deg - p), 180.0 - abs(deg - p)) >= min_sep_deg for p in picked):
            picked.append(deg)
            if len(picked) >= count:
                break
    return sorted(picked)


def _symmetry_error(a: float, b: float, c: float) -> float:
    """How well c mirrors (a, b): |(a+b)/2 - c| on the 180° circle."""
    mid = ((a + b) / 2.0) % 180.0
    d = abs(mid - (c % 180.0))
    return min(d, 180.0 - d)


def _radial_residual(crop: np.ndarray, cx: float, cy: float):
    """Crop minus its azimuthal median profile (removes the round core glow
    equally at all angles; asymmetric spikes remain). Returns (residual,
    corner noise std)."""
    h, w = crop.shape
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2).astype(int)
    maxr = int(dist.max())
    prof = np.zeros(maxr + 1, dtype=np.float64)
    cnt = np.zeros(maxr + 1, dtype=np.float64)
    np.add.at(prof, dist.ravel(), crop.ravel())
    np.add.at(cnt, dist.ravel(), 1)
    radial = prof / np.maximum(cnt, 1)
    resid = crop - radial[dist]
    border = np.concatenate([resid[0, :], resid[-1, :], resid[:, 0], resid[:, -1]])
    noise = float(np.std(border)) if border.size > 1 else 1.0
    return resid, max(noise, 1e-9)


def _band_flux(img: np.ndarray, theta_deg: float, shift: float,
               cx: float, cy: float, r0: float, r1: float) -> tuple[float, int]:
    """Flux along the line (both sides), |t| in [r0, r1]. Returns (flux, npix)."""
    h, w = img.shape
    a = math.radians(theta_deg)
    dx, dy = math.cos(a), math.sin(a)
    nx, ny = -dy, dx
    ts = np.arange(r0, r1 + 1.0, 1.0)
    xs = np.clip((cx + nx * shift + dx * ts).astype(int), 0, w - 1)
    ys = np.clip((cy + ny * shift + dy * ts).astype(int), 0, h - 1)
    xs2 = np.clip((cx + nx * shift - dx * ts).astype(int), 0, w - 1)
    ys2 = np.clip((cy + ny * shift - dy * ts).astype(int), 0, h - 1)
    f = float(np.sum(np.maximum(img[ys, xs], 0.0)) +
              np.sum(np.maximum(img[ys2, xs2], 0.0)))
    return f, 2 * len(ts)


def _refine_angle(crop: np.ndarray, theta: float, cx: float, cy: float,
                  span: float = 3.0, step: float = 0.5) -> float:
    """Refine a spike angle (±span) maximizing far-band flux at fitted shift."""
    best_t, best_v = theta, -1.0
    t = theta - span
    while t <= theta + span + 1e-9:
        tt = t % 180.0
        s, _ = _radon_offset(crop, tt, cx, cy)
        v, _ = _band_flux(crop, tt, s, cx, cy, 60.0, 115.0)
        if v > best_v:
            best_v, best_t = v, tt
        t += step
    return best_t


def _spike_support(resid: np.ndarray, noise: float, theta_deg: float, shift: float,
                   cx: float, cy: float) -> bool:
    """True if the line carries flux along its WHOLE length (both the near
    [15,60] and far [60,115] bands), i.e. a real spike, not a chance
    crossing of other spikes (flux in one band only) nor background."""
    f_near, n_near = _band_flux(resid, theta_deg, shift, cx, cy, 15.0, 60.0)
    f_far, n_far = _band_flux(resid, theta_deg, shift, cx, cy, 60.0, 115.0)
    t_near = 5.0 * noise * math.sqrt(n_near)
    t_far = 5.0 * noise * math.sqrt(n_far)
    if not (f_near > t_near and f_far > t_far):
        return False
    ratio = f_far / max(f_near, 1e-9)
    return 0.2 < ratio < 8.0


def _line_x_at_y(px: float, py: float, theta_deg: float, y: float) -> float | None:
    """X where the line through (px, py) with angle theta meets height y."""
    a = math.radians(theta_deg)
    dx, dy = math.cos(a), math.sin(a)
    if abs(dy) < 1e-9:
        return None
    return px + dx * (y - py) / dy


def _radon_offset(crop: np.ndarray, theta_deg: float, cx: float, cy: float,
                  max_shift: float = 40.0) -> tuple[float, float]:
    """Lateral position of the spike: sums along lines parallel to theta,
    shifted perpendicularly in [-max_shift, +max_shift].

    Returns (best_shift_px, contrast). Shift sign = side of the normal
    (-sin, cos): positive = upper-left side for typical angles.
    """
    h, w = crop.shape
    a = math.radians(theta_deg)
    dx, dy = math.cos(a), math.sin(a)
    nx, ny = -dy, dx  # unit normal
    max_r = math.hypot(w, h) / 2.0
    steps = np.arange(-max_r, max_r + 1.0, 1.0)
    shifts = np.arange(-max_shift, max_shift + 1.0, 1.0)
    prof = np.zeros(len(shifts), dtype=np.float64)
    for i, s in enumerate(shifts):
        xs = np.clip((cx + nx * s + dx * steps).astype(int), 0, w - 1)
        ys = np.clip((cy + ny * s + dy * steps).astype(int), 0, h - 1)
        prof[i] = float(np.sum(crop[ys, xs]))
    med = float(np.median(prof))
    i_best = int(np.argmax(prof))
    contrast = (float(prof[i_best]) - med) / max(med, 1e-9)
    return float(shifts[i_best]), contrast


def _cross(px1: float, py1: float, t1: float,
           px2: float, py2: float, t2: float) -> tuple[float, float] | None:
    """Crossing of two positioned lines (point + angle each)."""
    a1, a2 = math.radians(t1), math.radians(t2)
    d1 = (math.cos(a1), math.sin(a1))
    d2 = (math.cos(a2), math.sin(a2))
    det = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(det) < 1e-9:
        return None
    ex, ey = px2 - px1, py2 - py1
    s = (ex * d2[1] - ey * d2[0]) / det
    return (px1 + s * d1[0], py1 + s * d1[1])


def analyse_bahtinov(data: bytes, x: float | None = None, y: float | None = None,
                     crop_size: int = CROP_SIZE) -> dict:
    """Measure Bahtinov defocus offset on a FITS or JPEG frame.

    Returns {ok, x, y, offset_px, direction, angles, center_angle,
    intersection, confidence, ...}. offset signed in pixels,
    direction 'left'/'right' (which side the central spike sits on).
    """
    image, w, h, _source = decode_image(data)
    if image is None:
        return {"ok": False, "error": "Failed to parse image"}

    stars = find_stars(image, threshold_sigma=8.0, min_distance=20, max_stars=50)
    if not stars:
        return {"ok": False, "error": "no star found"}
    # Brightest unsaturated star (a clipped core flattens spike profiles).
    cand = [s for s in stars if s["peak"] < 30000] or stars
    if x is not None and y is not None:
        near = [s for s in cand
                if abs(s["x"] - x) <= 80 and abs(s["y"] - y) <= 80]
        if not near:
            return {"ok": False, "error": "no star near click"}
        star = max(near, key=lambda s: s["flux"])
    else:
        star = max(cand, key=lambda s: s["flux"])

    half = crop_size // 2
    sx, sy = int(star["x"]), int(star["y"])
    x0, x1 = max(0, sx - half), min(w, sx + half + 1)
    y0, y1 = max(0, sy - half), min(h, sy + half + 1)
    crop = image[y0:y1, x0:x1].astype(np.float64)
    if crop.shape[0] < 64 or crop.shape[1] < 64:
        return {"ok": False, "error": "star too close to edge"}
    bg = float(np.median(crop))
    crop = np.maximum(crop - bg, 0.0)
    total = float(np.sum(crop))
    if total <= 0:
        return {"ok": False, "error": "empty crop"}
    yy, xx = np.mgrid[0:crop.shape[0], 0:crop.shape[1]]
    cx = float(np.sum(xx * crop) / total)
    cy = float(np.sum(yy * crop) / total)

    angles, profile = _radon_through_center(crop, cx, cy)
    peaks = _pick_peaks(angles, profile, count=5)
    if len(peaks) < 2:
        return {"ok": False, "error": "fewer than 2 spikes detected",
                "x": sx, "y": sy, "angles": peaks}

    # Contrast (lateral peak height) for detected peaks…
    contrast: dict[float, float] = {}
    for p in peaks:
        _, c = _radon_offset(crop, p, cx, cy)
        contrast[p] = c
    # …plus a full scan: a shifted central spike leaves no through-center
    # peak, so it must be found by lateral contrast + symmetry.
    for t in range(0, 180, 2):
        tf = float(t)
        if tf not in contrast:
            _, c = _radon_offset(crop, tf, cx, cy)
            contrast[tf] = c

    # Assignment: central = high contrast + mirrored by two strong peaks.
    # Rank all valid triples, then keep the first whose 3 spikes all show
    # far-from-center flux (rejects round stars whose noise happens to be
    # symmetric).
    ranked = []
    import itertools
    for c in contrast:
        if contrast[c] < 0.25:
            continue
        for d1, d2 in itertools.combinations(peaks, 2):
            if contrast[d1] < 0.3 or contrast[d2] < 0.3:
                continue
            if min(abs(c - d1), 180.0 - abs(c - d1)) < MIN_PEAK_SEP_DEG:
                continue
            if min(abs(c - d2), 180.0 - abs(c - d2)) < MIN_PEAK_SEP_DEG:
                continue
            err = _symmetry_error(d1, d2, c)
            if err > 12.0:
                continue
            ranked.append((contrast[c] - err / 12.0, c, (d1, d2), err))
    ranked.sort(key=lambda r: r[0], reverse=True)
    resid, noise = _radial_residual(crop, cx, cy)
    best = None
    for score, c, (d1, d2), err in ranked[:12]:
        # Refine angles (1° sampling loses far flux) then gate on support.
        shifts_tmp = {}
        refined = {}
        ok_lines = True
        for t in (c, d1, d2):
            rt = _refine_angle(crop, t, cx, cy)
            s, _ = _radon_offset(crop, rt, cx, cy)
            if not _spike_support(resid, noise, rt, s, cx, cy):
                ok_lines = False
                break
            refined[t] = rt
            shifts_tmp[rt] = s
        if ok_lines:
            c, d1, d2 = refined[c], refined[d1], refined[d2]
            shifts = {k: shifts_tmp[k] for k in (c, d1, d2)}
            err = _symmetry_error(d1, d2, c)
            best = (score, c, (d1, d2), err, shifts)
            break
    if best is None:
        return {"ok": False, "error": "no spike structure (round star?)",
                "x": sx, "y": sy, "angles": peaks}
    _, center_angle, diag, sym_err, shifts = best
    diag = list(diag)
    triple = [center_angle, diag[0], diag[1]]
    # Lateral positions already fitted during the support check above.

    def _anchor(t: float) -> tuple[float, float]:
        s = shifts[t]
        ar = math.radians(t)
        return (cx - math.sin(ar) * s, cy + math.cos(ar) * s)

    p1 = _anchor(diag[0])
    p2 = _anchor(diag[1])
    pc = _anchor(center_angle)
    cross = _cross(p1[0], p1[1], diag[0], p2[0], p2[1], diag[1])
    if cross is None:
        return {"ok": False, "error": "diagonals parallel",
                "x": sx, "y": sy, "angles": [round(p, 1) for p in triple]}
    xc_at_cross = _line_x_at_y(pc[0], pc[1], center_angle, cross[1])
    if xc_at_cross is None:  # central spike horizontal: use y instead
        ac = math.radians(center_angle)
        dxc, dyc = math.cos(ac), math.sin(ac)
        offset = (cross[0] - pc[0]) * (-dyc) + (cross[1] - pc[1]) * dxc
        offset = -offset
    else:
        offset = xc_at_cross - cross[0]
    offset = float(offset)

    refund = {}
    for p in triple:
        _, cc = _radon_offset(crop, p, cx, cy)
        refund[p] = cc
    med_c = float(np.median([refund[p] for p in triple]))
    contrast_term = max(0.0, min(1.0, med_c / 2.0))
    confidence = round(contrast_term * max(0.0, 1.0 - sym_err / 15.0), 3)
    # Intersection in CROP coords → back to image coords for the overlay.
    ix, iy = x0 + cross[0], y0 + cross[1]

    return {
        "ok": True,
        "x": sx,
        "y": sy,
        "width": w,
        "height": h,
        "offset_px": round(offset, 1),
        "direction": "right" if offset >= 0 else "left",
        "angles": [round(p, 1) for p in triple],
        "center_angle": round(center_angle, 1),
        "shifts": {str(round(p, 1)): round(shifts[p], 1) for p in triple},
        "intersection": {"x": round(ix, 1), "y": round(iy, 1)},
        "confidence": confidence,
        "symmetry_err_deg": round(sym_err, 2),
        "crop_size": int(crop.shape[0]),
    }
