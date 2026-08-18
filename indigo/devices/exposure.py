"""
exposure.py — Ideal exposure time estimation from test frames.

Measures the real sky background on test exposures and extrapolates
the exposure that would bring the background to a target ADU level, guarding
against saturation of the brightest stars.

Single-shot mode (``estimate_exposure``):
  - Sky signal is assumed known once the BZERO pedestal is subtracted.
  - Background rate: r = (bg_median - bzero) / t_test
  - Recommended exposure: t = target_bg / r

Multi-shot mode (``estimate_exposure_multi``):
  - Several exposures at increasing durations are taken and a linear fit
    ``ADU(t) = bias + m*t`` is solved by least squares. The slope m is the
    sky background rate in ADU/s, measured independently of any assumed bias
    (the bias is the fitted intercept, so cameras with unknown offset/dark
    are handled correctly).
  - Linearity/knee detection: if the highest-duration point deviates below
    the fitted line, the sensor is leaving its linear region (approaching
    saturation) — this empirically-observed full-scale is used as the cap
    instead of a hardcoded 65535.

Both modes bound the recommendation by min/max exposure and cap when the
brightest star would saturate (saturation_frac of full scale), and project
the SNR of a reference star (sky-limited: SNR scales as sqrt(t)).
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


def _measure_frame(data: bytes, full_scale: float) -> dict | None:
    """Per-frame sky/star statistics for one test exposure.

    Returns None when the frame cannot be parsed.
    """
    image, w, h = parse_fits(data)
    if image is None:
        return None
    bzero = _header_bzero(data)
    bg_median = float(np.nanmedian(image))
    bg_std = max(float(np.nanstd(image)), 1.0)
    sky_adu = max(bg_median - bzero, 0.0)

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

    return {
        "image": image,
        "bg_median": bg_median,
        "bg_std": bg_std,
        "bzero": bzero,
        "sky_adu": sky_adu,
        "stars": stars,
        "peak_scale": peak_scale,
        "peak_frac": peak_frac,
        "ref": ref,
    }


def _finalize(result: dict, p: dict, t_test: float, exposure: float,
              frame, capped_by: str) -> dict:
    """Apply bounds, saturation cap and SNR projection on a computed exposure."""
    # Cap by max exposure.
    if exposure > p["max_exposure"]:
        exposure = p["max_exposure"]
        capped_by = "max_exposure"

    # Cap so the brightest star peak stays under saturation_frac of full scale.
    ref, bzero = frame["ref"], frame["bzero"]
    if ref is not None:
        ref_peak_adu = ref["peak"] - bzero
        predicted_peak = ref_peak_adu * (exposure / t_test)
        if predicted_peak >= result["full_scale"] * p["saturation_frac"]:
            max_t = t_test * (result["full_scale"] * p["saturation_frac"]) / ref_peak_adu
            exposure = min(exposure, max_t)
            if capped_by == "none":
                capped_by = "saturation"

    if exposure < p["min_exposure"]:
        exposure = p["min_exposure"]
        if capped_by == "none":
            capped_by = "min_exposure"

    result["exposure_s"] = round(exposure, 1)
    result["capped_by"] = capped_by

    # Projected SNR at the recommended exposure (sky-limited: sqrt scaling).
    if ref is not None:
        ref_snr = (ref["peak"] - frame["bg_median"]) / frame["bg_std"]
        result["ref_snr"] = round(ref_snr, 1)
        result["snr_at_target"] = round(ref_snr * (exposure / t_test) ** 0.5, 1) if exposure > 0 else None
    else:
        result["ref_snr"] = None
        result["snr_at_target"] = None
    return result


def estimate_exposure(
    data: bytes,
    test_duration: float,
    params: dict | None = None,
    full_scale: float = 65535.0,
) -> dict:
    """Estimate the ideal exposure from a single FITS test frame.

    Assumes the sky signal is ``bg_median - BZERO``; a single frame is enough
    when the sensor's true bias equals the BZERO offset. Use the multi-shot
    variant when the bias is unknown.

    Args:
        data: Raw FITS bytes of the test exposure.
        test_duration: Exposure time of the test frame (seconds).
        params: Overrides for DEFAULT_PARAMS.
        full_scale: Full-scale ADU of the sensor (e.g. 65535 for 16-bit).

    Returns:
        dict with: ok, exposure_s, bg_median, sky_adu, bg_rate, target_bg,
        star_count, saturation_pct, snr_at_target, capped_by, test_duration,
        mode ("single").
    """
    p = dict(DEFAULT_PARAMS)
    if params:
        for k in ("target_bg", "test_duration", "min_exposure", "max_exposure", "saturation_frac"):
            if k in params and params[k] is not None:
                p[k] = float(params[k])

    t_test = max(test_duration or p["test_duration"], 1e-3)

    frame = _measure_frame(data, full_scale)
    if frame is None:
        return {"ok": False, "error": "Failed to parse test image"}

    bzero = frame["bzero"]
    sky_adu = frame["sky_adu"]
    bg_rate = sky_adu / t_test

    result = {
        "ok": True,
        "mode": "single",
        "test_duration": round(t_test, 2),
        "bg_median": round(frame["bg_median"], 1),
        "bzero": round(bzero, 1),
        "sky_adu": round(sky_adu, 1),
        "bg_rate": round(bg_rate, 3),
        "target_bg": round(p["target_bg"], 1),
        "min_exposure": round(p["min_exposure"], 1),
        "max_exposure": round(p["max_exposure"], 1),
        "saturation_frac": round(p["saturation_frac"], 3),
        "star_count": len(frame["stars"]),
        "saturation_pct": round(frame["peak_frac"] * 100.0, 1),
        "full_scale": full_scale,
        "capped_by": "none",
        "ref_peak": round(frame["ref"]["peak"] - bzero, 1) if frame["ref"] else None,
    }

    if sky_adu <= 0 or bg_rate <= 0:
        result.update({"exposure_s": None, "warning": "background is zero — can't extrapolate"})
        return result

    exposure = p["target_bg"] / bg_rate
    return _finalize(result, p, t_test, exposure, frame, "none")


def estimate_exposure_multi(
    frames: list[tuple[float, bytes]],
    params: dict | None = None,
    full_scale: float = 65535.0,
) -> dict:
    """Estimate the ideal exposure from several test frames at increasing times.

    Solves ``ADU(t) = bias + m*t`` by least squares: the fitted slope ``m``
    is the sky background rate in ADU/s, measured independently of any
    assumed bias. A linearity/knee check on the highest-duration frame sets
    the empirical saturation cap.

    Args:
        frames: List of (duration_seconds, fits_bytes), timings increasing.
        params: Overrides for DEFAULT_PARAMS.
        full_scale: Nominal full-scale ADU (used only for reporting when no
            knee is detected).

    Returns:
        dict with: ok, mode ("multi"), exposure_s, bias, bg_rate (slope),
        r2 (goodness of fit), knee_detected, knee_bg, plus shared fields.
    """
    p = dict(DEFAULT_PARAMS)
    if params:
        for k in ("target_bg", "test_duration", "min_exposure", "max_exposure", "saturation_frac"):
            if k in params and params[k] is not None:
                p[k] = float(params[k])

    if len(frames) < 2:
        return estimate_exposure(frames[0][1] if frames else b"", frames[0][0] if frames else 0,
                                 params, full_scale)

    measured = []
    for t, data in frames:
        fr = _measure_frame(data, full_scale)
        if fr is not None:
            measured.append((max(t, 1e-3), fr))

    if len(measured) < 2:
        return {"ok": False, "error": "fewer than 2 test frames parsed"}

    ts = np.array([m[0] for m in measured], dtype=float)
    bgs = np.array([m[1]["bg_median"] for m in measured], dtype=float)

    # Linear fit ADU(t) = bias + slope*t
    slope, bias = np.polyfit(ts, bgs, 1)
    predictions = bias + slope * ts
    ss_res = float(np.sum((bgs - predictions) ** 2))
    ss_tot = float(np.sum((bgs - bgs.mean()) ** 2))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 1.0

    bg_rate = float(slope)

    # Reference frame for saturation / SNR: the longest valid one.
    last = measured[-1][1]
    # Linearity/knee: does the last (longest) point fall below the line fitted
    # to the remaining frames? A least-squares fit through ALL points is pulled
    # down by the flattened point itself; fitting the linear regime first keeps
    # the prediction honest. A shortfall means the sensor is compressing.
    knee_detected = False
    knee_bg = None
    cap_full_scale = full_scale
    if len(measured) >= 3:
        ts_lin = ts[:-1]
        bg_lin = bgs[:-1]
        slope_lin, bias_lin = np.polyfit(ts_lin, bg_lin, 1)
        expected_last = bias_lin + slope_lin * ts[-1]
        if expected_last > 0 and bgs[-1] < expected_last * 0.95:
            knee_detected = True
            knee_bg = float(bgs[-1])
            # Empirical full scale: twice the measured bg where the knee begins.
            cap_full_scale = knee_bg * 2.0
            log.info("Exposure knee detected at bg=%.1f — capping empirically", knee_bg)

    result = {
        "ok": True,
        "mode": "multi",
        "test_durations": [round(m[0], 2) for m in measured],
        "bg_medians": [round(m[1]["bg_median"], 1) for m in measured],
        "bias": round(float(bias), 1),
        "bg_rate": round(bg_rate, 3),
        "r2": round(r2, 3),
        "knee_detected": knee_detected,
        "knee_bg": round(knee_bg, 1) if knee_bg is not None else None,
        "target_bg": round(p["target_bg"], 1),
        "min_exposure": round(p["min_exposure"], 1),
        "max_exposure": round(p["max_exposure"], 1),
        "saturation_frac": round(p["saturation_frac"], 3),
        "star_count": len(last["stars"]),
        "saturation_pct": round(last["peak_frac"] * 100.0, 1),
        "full_scale": cap_full_scale,
        "capped_by": "none",
        "ref_peak": round(last["ref"]["peak"] - last["bzero"], 1) if last["ref"] else None,
    }

    if bg_rate <= 0:
        result.update({"exposure_s": None, "warning": "background is flat — can't extrapolate"})
        return result

    exposure = p["target_bg"] / bg_rate
    return _finalize(result, p, ts[-1], exposure, last, "none")