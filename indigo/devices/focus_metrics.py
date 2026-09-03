"""
focus_metrics.py — Star detection and focus quality metrics.

Computes HFR (Half Flux Radius) and FWHM (Full Width Half Maximum)
for evaluating focus quality on astronomical images.
"""

from __future__ import annotations

import logging
import re

import numpy as np

log = logging.getLogger("indigo.focus_metrics")


def parse_fits(data: bytes) -> tuple[np.ndarray | None, int, int]:
    """Parse FITS bytes to 2D numpy float64 array. Returns (array, w, h)."""
    try:
        header_str = ""
        offset = 0
        end_found = False

        while offset + 2880 <= len(data):
            block = data[offset:offset + 2880]
            header_str += block.decode("ascii", errors="replace")
            offset += 2880

            last_block = header_str[-2880:]
            for i in range(0, len(last_block), 80):
                card = last_block[i : i + 80]
                if card[:3].strip() == "END":
                    end_found = True
                    break
            if end_found:
                break

        if not end_found:
            return None, 0, 0

        def get(key):
            for i in range(0, len(header_str), 80):
                card = header_str[i : i + 80]
                m = re.match(rf"^{key}\s*=\s*(.+?)(?:\s*/\s*.*)?$", card.strip())
                if m:
                    val = m.group(1).strip().strip("'\"")
                    if "'" in val:
                        val = val.split("'")[0]
                    else:
                        val = val.split()[0] if val.split() else val
                    return val
            return None

        naxis = int(get("NAXIS") or "0")
        w = int(get("NAXIS1") or "0")
        h = int(get("NAXIS2") or "0")
        bitpix = int(get("BITPIX") or "32")
        bzero = float(get("BZERO") or "0")
        bscale = float(get("BSCALE") or "1")

        if naxis < 2 or w == 0 or h == 0:
            return None, 0, 0

        data_start = offset
        remaining = len(data) - data_start

        if bitpix == 32:
            count = min(w * h, remaining // 4)
            arr = np.frombuffer(data[data_start : data_start + count * 4], dtype=">i4", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == -32:
            count = min(w * h, remaining // 4)
            arr = np.frombuffer(data[data_start : data_start + count * 4], dtype=">f4", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 16:
            count = min(w * h, remaining // 2)
            arr = np.frombuffer(data[data_start : data_start + count * 2], dtype=">i2", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == -16:
            count = min(w * h, remaining // 2)
            arr = np.frombuffer(data[data_start : data_start + count * 2], dtype=">u2", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 64:
            count = min(w * h, remaining // 8)
            arr = np.frombuffer(data[data_start : data_start + count * 8], dtype=">i8", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 8:
            count = min(w * h, remaining)
            arr = np.frombuffer(data[data_start : data_start + count], dtype="u1", count=count)
            pixels = arr.astype(np.float64)
        else:
            return None, 0, 0

        # Apply FITS scaling (BZERO/BSCALE). INDIGO CCD simulators commonly
        # emit 16-bit data as an unsigned short via BZERO=32768/BSCALE=1.
        if bzero != 0 or bscale != 1:
            pixels = pixels * bscale + bzero

        # Tolerate truncated FITS (intermittent BLOB corruption): salvage a
        # partial image so star detection / calibration don't hard-fail.
        if pixels.size != w * h:
            if w and pixels.size > 0:
                rows = pixels.size // w
                if rows > 0:
                    log.warning(
                        "FITS truncated: expected %dx%d=%d px, got %d px "
                        "(missing %d px) — using %dx%d partial image",
                        w, h, w * h, pixels.size, w * h - pixels.size, rows, w)
                    img = pixels[: rows * w].reshape((rows, w))
                    return img, w, rows
            log.warning(
                "FITS size mismatch: expected %dx%d=%d px, got %d px",
                w, h, w * h, pixels.size)
            return None, 0, 0

        img = pixels.reshape((h, w))
        return img, w, h

    except Exception as e:
        log.warning("FITS parse error: %s", e)
        return None, 0, 0


def find_stars(
    image: np.ndarray,
    threshold_sigma: float = 5.0,
    min_distance: int = 5,
    max_stars: int = 200,
) -> list[dict]:
    """Find stars in an image using local maxima detection.

    Args:
        image: 2D numpy array (float64).
        threshold_sigma: Detection threshold in sigma above background.
        min_distance: Minimum pixel distance between star centers.
        max_stars: Maximum number of stars to return.

    Returns:
        List of dicts: {x, y, flux, peak}.
    """
    h, w = image.shape

    # Background estimation (sigma-clipped median)
    bg_median = float(np.nanmedian(image))
    bg_std = float(np.nanstd(image))
    # Floor adaptatif : 1 ADU n'a de sens qu'en échelle entière >100 ADU.
    # Pour images float normalisées 0-1 (stack), bg_std~0.01 doit rester tel quel.
    if bg_std < 1e-6:
        bg_std = 1e-6
    elif bg_std < 1.0 and bg_median < 5.0:
        # image normalisée float — ne pas forcer 1.0
        pass
    elif bg_std < 1.0:
        bg_std = 1.0

    threshold = bg_median + threshold_sigma * bg_std

    # --- Voie rapide vectorisée via scipy ( ~50× plus rapide sur 26 Mpx) ---
    try:
        from scipy.ndimage import maximum_filter  # type: ignore

        footprint_size = max(3, min_distance)
        maxf = maximum_filter(image, size=footprint_size, mode="constant", cval=threshold - 1)
        mask = (image == maxf) & (image > threshold)
        cnt = int(np.count_nonzero(mask))
        if cnt == 0:
            return []
        # Trop de candidats (bruit) -> on garde les plus brillants avant NMS
        ys, xs = np.where(mask)
        peaks = image[ys, xs]
        # Tri par pic décroissant pour NMS (garde les plus brillants)
        order = np.argsort(peaks)[::-1]
        # Limiter à max_stars * 50 pour éviter O(N²) sur champ ultra dense
        if len(order) > max_stars * 50:
            order = order[: max_stars * 50]
        ys = ys[order]
        xs = xs[order]
        peaks = peaks[order]
        r_ap = min(8, min_distance)
        # NMS : un seul point par voisinage min_distance (fusion plateaux 11×11)
        kept = []
        kept_coords: list[tuple[int, int]] = []
        for x, y, peak in zip(xs, ys, peaks):
            # check distance aux déjà gardés
            keep = True
            for kx, ky in kept_coords:
                if abs(int(x) - kx) < min_distance and abs(int(y) - ky) < min_distance:
                    if ((int(x) - kx) ** 2 + (int(y) - ky) ** 2) ** 0.5 < min_distance:
                        keep = False
                        break
            if not keep:
                continue
            y_lo = max(0, int(y) - r_ap)
            y_hi = min(h, int(y) + r_ap + 1)
            x_lo = max(0, int(x) - r_ap)
            x_hi = min(w, int(x) + r_ap + 1)
            flux = float(np.sum(image[y_lo:y_hi, x_lo:x_hi]) - bg_median * (y_hi - y_lo) * (x_hi - x_lo))
            if flux > 0:
                kept.append({"x": int(x), "y": int(y), "flux": flux, "peak": float(peak)})
                kept_coords.append((int(x), int(y)))
                if len(kept) >= max_stars:
                    break
        # kept déjà trié par peak/flux décroissant (pas exactement flux, on re-tri)
        kept.sort(key=lambda s: s["flux"], reverse=True)
        return kept[:max_stars]
    except ImportError:
        pass
    except Exception as e:
        log.debug("find_stars vectorisé échoué, fallback boucle: %s", e)

    # Fallback boucle Python (petites images ou scipy absent) avec NMS
    stars = []
    half_d = min_distance // 2

    for y in range(half_d, h - half_d):
        for x in range(half_d, w - half_d):
            val = image[y, x]
            if val < threshold:
                continue
            window = image[y - half_d : y + half_d + 1, x - half_d : x + half_d + 1]
            if val == window.max():
                r = min(8, min_distance)
                y_lo = max(0, y - r)
                y_hi = min(h, y + r + 1)
                x_lo = max(0, x - r)
                x_hi = min(w, x + r + 1)
                flux = float(np.sum(image[y_lo:y_hi, x_lo:x_hi]) - bg_median * (y_hi - y_lo) * (x_hi - x_lo))
                if flux > 0:
                    stars.append({"x": int(x), "y": int(y), "flux": flux, "peak": float(val)})

    stars.sort(key=lambda s: s["flux"], reverse=True)
    # NMS
    if len(stars) > 1 and min_distance > 1:
        kept = []
        for s in stars:
            if any(((s["x"] - k["x"]) ** 2 + (s["y"] - k["y"]) ** 2) ** 0.5 < min_distance for k in kept):
                continue
            kept.append(s)
            if len(kept) >= max_stars:
                break
        stars = kept
    else:
        stars = stars[:max_stars]

    return stars


def compute_hfr(
    image: np.ndarray,
    cx: int,
    cy: int,
    radius: int = 15,
    bg_median: float | None = None,
) -> float:
    """Compute Half Flux Radius around a point.

    HFR is the radius containing 50% of the total flux within the search radius.
    """
    h, w = image.shape
    if bg_median is None:
        bg_median = float(np.nanmedian(image))

    r_lo = max(0, cx - radius)
    r_hi = min(w, cx + radius + 1)
    b_lo = max(0, cy - radius)
    b_hi = min(h, cy + radius + 1)

    region = image[b_lo:b_hi, r_lo:r_hi].astype(np.float64) - bg_median
    region = np.maximum(region, 0)

    total_flux = float(np.sum(region))
    if total_flux <= 0:
        return 0.0

    # Build radial distance map from center
    yy, xx = np.mgrid[b_lo:b_hi, r_lo:r_hi]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)

    # Sort pixels by distance, accumulate flux
    flat_dist = dist.ravel()
    flat_flux = region.ravel()
    order = np.argsort(flat_dist)
    cumflux = np.cumsum(flat_flux[order])
    sorted_dist = flat_dist[order]

    # Find radius where cumulative flux reaches 50%
    half_flux = total_flux * 0.5
    idx = np.searchsorted(cumflux, half_flux)
    if idx >= len(sorted_dist):
        return float(sorted_dist[-1])
    return float(sorted_dist[idx])


def compute_fwhm(
    image: np.ndarray,
    cx: int,
    cy: int,
    radius: int = 15,
    bg_median: float | None = None,
) -> float:
    """Compute Full Width Half Maximum around a point.

    Builds a radial profile and finds where it drops to half the peak.
    """
    h, w = image.shape
    if bg_median is None:
        bg_median = float(np.nanmedian(image))

    r_lo = max(0, cx - radius)
    r_hi = min(w, cx + radius + 1)
    b_lo = max(0, cy - radius)
    b_hi = min(h, cy + radius + 1)

    region = image[b_lo:b_hi, r_lo:r_hi].astype(np.float64) - bg_median
    region = np.maximum(region, 0)

    peak = float(np.max(region))
    if peak <= 0:
        return 0.0

    half_peak = peak * 0.5

    yy, xx = np.mgrid[b_lo:b_hi, r_lo:r_hi]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)

    # Build radial profile: average flux at each integer radius
    max_r = int(min(radius, np.max(dist))) + 1
    profile = np.zeros(max_r)
    counts = np.zeros(max_r)
    flat_dist = dist.ravel()
    flat_flux = region.ravel()
    r_int = flat_dist.astype(int)
    mask = r_int < max_r
    np.add.at(profile, r_int[mask], flat_flux[mask])
    np.add.at(counts, r_int[mask], 1)
    counts = np.maximum(counts, 1)
    profile /= counts

    # Find where profile drops below half peak
    for r_val in range(len(profile)):
        if profile[r_val] < half_peak:
            return float(r_val) * 2.0  # FWHM = 2 * radius at half max

    return float(max_r) * 2.0


def compute_focus_metrics(
    data: bytes,
    threshold_sigma: float = 5.0,
    min_distance: int = 5,
) -> dict:
    """Compute focus metrics for a FITS image.

    Returns dict with: hfr, fwhm, star_count, stars, bg_median, bg_std.
    """
    image, w, h = parse_fits(data)
    if image is None:
        return {"ok": False, "error": "Failed to parse image"}

    bg_median = float(np.nanmedian(image))
    bg_std = float(np.nanstd(image))

    stars = find_stars(image, threshold_sigma=threshold_sigma, min_distance=min_distance)

    if not stars:
        return {
            "ok": True,
            "hfr": 0.0,
            "fwhm": 0.0,
            "star_count": 0,
            "stars": [],
            "width": w,
            "height": h,
            "bg_median": bg_median,
            "bg_std": bg_std,
        }

    # Compute HFR, FWHM, and gaussian quality for each star
    max_pixel_val = float(np.max(image))
    for star in stars:
        star["hfr"] = round(compute_hfr(image, star["x"], star["y"], bg_median=bg_median), 2)
        star["fwhm"] = round(compute_fwhm(image, star["x"], star["y"], bg_median=bg_median), 2)

        # Signal-to-noise ratio of the star
        snr = (star["peak"] - bg_median) / max(bg_std, 1.0)
        star["snr"] = round(snr, 1)

        # Gaussian quality score — higher = better guide star
        hfr_val = star["hfr"]

        # Prefer HFR ~1.5–5px (gaussian peak at 2.5)
        ideal_hfr = 2.5
        hfr_score = np.exp(-abs(hfr_val - ideal_hfr) / ideal_hfr)

        # Penalize saturated or near-saturated stars
        sat_penalty = 1.0 if star["peak"] < max_pixel_val * 0.95 else 0.3

        # Penalize very dim stars (SNR < 5)
        snr_factor = min(snr / 20, 1.0) if snr > 5 else snr / 25

        star["gaussian_quality"] = round(snr_factor * hfr_score * sat_penalty, 3)

    # Re-sort by gaussian_quality descending
    stars.sort(key=lambda s: s["gaussian_quality"], reverse=True)

    # Average metrics (weighted by flux)
    total_flux = sum(s["flux"] for s in stars)
    if total_flux > 0:
        avg_hfr = sum(s["hfr"] * s["flux"] for s in stars) / total_flux
        avg_fwhm = sum(s["fwhm"] * s["flux"] for s in stars) / total_flux
    else:
        avg_hfr = 0.0
        avg_fwhm = 0.0

    return {
        "ok": True,
        "hfr": round(avg_hfr, 2),
        "fwhm": round(avg_fwhm, 2),
        "star_count": len(stars),
        "stars": stars[:100],  # Limit to 100 for API response size
        "width": w,
        "height": h,
        "bg_median": round(bg_median, 1),
        "bg_std": round(bg_std, 1),
    }
