"""
exposure.py — Ideal exposure time estimation from a test frame.

Measures the real sky background on a short test exposure and extrapolates
the exposure that would bring the background to a target ADU level, guarding
against saturation of the brightest stars.

Approach:
  - Parse the FITS test frame (reuses focus_metrics parsing/star detection).
  - Sky signal (background above the BZERO pedestal, if any):
        sky_adu = bg_median - bzero
  - Background rate:      r = sky_adu / t_test     (ADU per second)
  - Recommended exposure: t = target_bg / r
  - Bounded by min/max exposure and capped if the brightest star would
    saturate (peak * t / t_test >= saturation fraction of full scale).
  - SNR of a reference star projected at the recommended exposure, assuming
    sky-limited noise (SNR scales as sqrt(t)).
"""

from __future__ import annotations

import logging
import re

import numpy as np

from .focus_metrics import find_stars, parse_fits

log = logging.getLogger("indigo.exposure")

DEFAULT_PARAMS = {
    "target_bg": 4000.0,        # desired sky background (ADU above bias)
    "test_duration": 10.0,      # default test exposure (seconds)
    "min_exposure": 1.0,        # never recommend below this
    "max_exposure": 600.0,      # never recommend above this
    "saturation_frac": 0.60,    # cap exposure so brightest star peak stays below this × full scale
}


def _header_bzero(data: bytes) -> float:
    """Extract BZERO from the FITS header (0.0 when absent)."""
    try:
        head = data[:2880].decode("ascii", errors="replace")
        m = re.search(r"BZERO\s*=\s*(-?[\d.]+)", head)
        return float(m.group(1)) if m else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def estimate_exposure(
    data: bytes,
    test_duration: float,
    params: dict | None = None,
    full_scale: float = 65535.0,
) -> dict:
    """Estimate the ideal exposure from a FITS test frame.

    Args:
        data: Raw FITS bytes of the test exposure.
        test_duration: Exposure time of the test frame (seconds).
        params: Overrides for DEFAULT_PARAMS.
        full_scale: Full-scale ADU of the sensor (e.g. 65535 for 16-bit).

    Returns:
        dict with: ok, exposure_s, bg_median, sky_adu, bg_rate, target_bg,
        star_count, saturation_pct, snr_at_target, capped_by, test_duration.
    """
    p = dict(DEFAULT_PARAMS)
    if params:
        for k in ("target_bg", "test_duration", "min_exposure", "max_exposure", "saturation_frac"):
            if k in params and params[k] is not None:
                p[k] = float(params[k])

    t_test = max(test_duration or p["test_duration"], 1e-3)

    image, w, h = parse_fits(data)
    if image is None:
        return {"ok": False, "error": "Failed to parse test image"}

    bg_median = float(np.nanmedian(image))
    bzero = _header_bzero(data)
    sky_adu = max(bg_median - bzero, 0.0)
    bg_rate = sky_adu / t_test

    # Star detection: saturation check + reference SNR.
    stars = find_stars(image)
    peak_scale = float(np.max(image))
    # Fraction of full scale used by the brightest pixel (above the pedestal).
    peak_frac = (peak_scale - bzero) / full_scale if full_scale > 0 else 1.0

    # Reference star: brightest by peak not already saturated near full scale.
    ref = None
    for s in stars:
        if (s["peak"] - bzero) < full_scale * 0.98:
            ref = s
            break

    result = {
        "ok": True,
        "test_duration": round(t_test, 2),
        "bg_median": round(bg_median, 1),
        "bzero": round(bzero, 1),
        "sky_adu": round(sky_adu, 1),
        "bg_rate": round(bg_rate, 3),
        "target_bg": round(p["target_bg"], 1),
        "min_exposure": round(p["min_exposure"], 1),
        "max_exposure": round(p["max_exposure"], 1),
        "saturation_frac": round(p["saturation_frac"], 3),
        "star_count": len(stars),
        "saturation_pct": round(peak_frac * 100.0, 1),
        "full_scale": full_scale,
        "capped_by": "none",
        "ref_peak": round(ref["peak"] - bzero, 1) if ref else None,
    }

    if sky_adu <= 0 or bg_rate <= 0:
        result.update({"exposure_s": None, "warning": "background is zero — can't extrapolate"})
        return result

    exposure = p["target_bg"] / bg_rate

    # Cap by max exposure.
    if exposure > p["max_exposure"]:
        exposure = p["max_exposure"]
        result["capped_by"] = "max_exposure"

    # Cap so the brightest star peak stays under saturation_frac of full scale.
    if ref is not None:
        ref_peak_adu = ref["peak"] - bzero
        predicted_peak = ref_peak_adu * (exposure / t_test)
        if predicted_peak >= full_scale * p["saturation_frac"]:
            max_t = t_test * (full_scale * p["saturation_frac"]) / ref_peak_adu
            exposure = min(exposure, max_t)
            if result["capped_by"] == "none":
                result["capped_by"] = "saturation"

    if exposure < p["min_exposure"]:
        exposure = p["min_exposure"]
        if result["capped_by"] == "none":
            result["capped_by"] = "min_exposure"

    # Projected SNR at the recommended exposure (sky-limited: sqrt scaling).
    result["exposure_s"] = round(exposure, 1)
    if ref is not None:
        bg_std = max(float(np.nanstd(image)), 1.0)
        ref_snr = (ref["peak"] - bg_median) / bg_std
        result["ref_snr"] = round(ref_snr, 1)
        result["snr_at_target"] = round(ref_snr * (exposure / t_test) ** 0.5, 1) if exposure > 0 else None
    else:
        result["ref_snr"] = None
        result["snr_at_target"] = None
    return result
