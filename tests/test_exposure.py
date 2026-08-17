"""
test_exposure.py — Unit tests for ideal-exposure estimation.

Validates the sky-background extrapolation, saturation capping, max/min
bounding, and zero-background guard on synthetic FITS frames.
No hardware required.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from indigo.devices.exposure import estimate_exposure


# ── Helpers ─────────────────────────────────────────────────────

def make_fits(w, h, pixels, bzero=0.0, bscale=1.0):
    """Create minimal 16-bit FITS bytes with given BZERO/BSCALE."""
    cards = [
        "SIMPLE  =                    T",
        "NAXIS   =                    2",
        f"NAXIS1  =               {w:>5d}",
        f"NAXIS2  =               {h:>5d}",
        "BITPIX  =                    16",
    ]
    if bzero:
        cards.append(f"BZERO   =              {bzero:.4f}")
    if bscale != 1.0:
        cards.append(f"BSCALE  =              {bscale:.4f}")
    cards.append("END")
    header = "".join(c.ljust(80) for c in cards).ljust(2880)

    # With BZERO the on-disk int16 stores (value - BZERO) so it fits in int16.
    stored = (np.asarray(pixels, dtype=np.float64) - bzero).clip(-32768, 32767)
    data = np.array(stored, dtype=">i2").tobytes()
    return header.encode("ascii") + data


def make_sky_star(w=256, h=256, sky=400.0, star_peak=400.0, sigma=3.0,
                  seed=0, bzero=32768.0):
    """FITS of a star on a sky background (above the BZERO pedestal)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    bg = rng.normal(sky, 10.0, (h, w)).clip(0, 65535)
    g = star_peak * np.exp(-((x - 128) ** 2 + (y - 128) ** 2) / (2 * sigma ** 2))
    img = (bg + g + bzero).clip(0, 65535).astype(np.float64)
    return make_fits(w, h, img, bzero=bzero)


# ── Tests ───────────────────────────────────────────────────────

passed = 0
failed = 0


def check(condition, msg):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {msg}")
    else:
        failed += 1
        print(f"  ✗ FAIL: {msg}")


def test_background_extrapolation():
    print("\n=== Background extrapolation ===")
    fits = make_sky_star(sky=400.0, star_peak=400.0)
    r = estimate_exposure(fits, test_duration=10.0,
                          params={"target_bg": 4000, "max_exposure": 600})
    # sky=400 ADU over 10 s → 40 ADU/s → target 4000 → 100 s
    check(r["ok"], "estimate ok")
    check(abs(r["exposure_s"] - 100.0) < 15.0,
          f"exposure ≈ 100 s (got {r['exposure_s']})")
    check(abs(r["bg_rate"] - 40.0) < 5.0, f"bg_rate ≈ 40 ADU/s (got {r['bg_rate']})")
    check(r["bzero"] == 32768.0, "BZERO read from header")
    check(r["star_count"] >= 1, f"star detected ({r['star_count']})")
    check(r["ref_snr"] is not None and r["snr_at_target"] is not None,
          "reference SNR present")


def test_saturation_cap():
    print("\n=== Saturation cap ===")
    # Bright star: at the recommended exposure it would exceed saturation_frac
    fits = make_sky_star(sky=400.0, star_peak=30000.0)
    r = estimate_exposure(fits, test_duration=10.0,
                          params={"target_bg": 4000, "max_exposure": 600})
    check(r["ok"], "estimate ok")
    check(r["capped_by"] == "saturation", f"capped by saturation (got {r['capped_by']})")
    check(r["exposure_s"] < 20.0, f"short exposure to protect stars ({r['exposure_s']} s)")


def test_max_exposure_cap():
    print("\n=== Max exposure cap ===")
    fits = make_sky_star(sky=400.0, star_peak=400.0)
    r = estimate_exposure(fits, test_duration=10.0,
                          params={"target_bg": 4000, "max_exposure": 50.0})
    check(r["ok"], "estimate ok")
    check(r["capped_by"] == "max_exposure", f"capped by max (got {r['capped_by']})")
    check(r["exposure_s"] == 50.0, f"exposure == max (got {r['exposure_s']})")


def test_zero_background():
    print("\n=== Zero background guard ===")
    # A bias-like frame: no measurable sky signal → no extrapolation.
    img = np.full((256, 256), 32768.0, dtype=np.float64)
    fits = make_fits(256, 256, img, bzero=32768.0)
    r = estimate_exposure(fits, test_duration=10.0)
    check(r["ok"], "estimate ok")
    check(r["exposure_s"] is None, "no exposure when background is zero")
    check("warning" in r, "warning explains the zero background")


def test_bright_sky_short_exposure():
    print("\n=== Bright sky → short exposure ===")
    # Strong light pollution: sky already at ~20000 ADU above bias.
    fits = make_sky_star(sky=20000.0, star_peak=400.0)
    r = estimate_exposure(fits, test_duration=10.0,
                          params={"target_bg": 4000, "max_exposure": 600})
    check(r["ok"], "estimate ok")
    check(r["exposure_s"] < 10.0,
          f"short exposure for bright sky (got {r['exposure_s']} s)")
    check(r["sky_adu"] > 19000.0, f"sky measured high ({r['sky_adu']} ADU)")


def test_no_bzero_zero_offset():
    print("\n=== No BZERO (offset 0) ===")
    # Cameras without BZERO: sky signal = bg_median directly.
    fits = make_sky_star(sky=400.0, star_peak=400.0, bzero=0.0)
    r = estimate_exposure(fits, test_duration=10.0,
                          params={"target_bg": 4000, "max_exposure": 600})
    check(r["ok"], "estimate ok")
    check(r["bzero"] == 0.0, "BZERO absent → 0")
    check(abs(r["exposure_s"] - 100.0) < 15.0,
          f"exposure ≈ 100 s (got {r['exposure_s']})")


def test_params_defaults():
    print("\n=== Default params ===")
    fits = make_sky_star(sky=400.0, star_peak=400.0)
    r = estimate_exposure(fits, test_duration=10.0)
    check(r["target_bg"] == 4000.0, "default target_bg 4000")
    check(r["min_exposure"] == 1.0, "default min_exposure 1.0")
    check(r["saturation_frac"] == 0.6, "default saturation_frac 0.6")
    check(r["exposure_s"] > 0, "exposure computed")


# ── Run all tests ───────────────────────────────────────────────

if __name__ == "__main__":
    test_background_extrapolation()
    test_saturation_cap()
    test_max_exposure_cap()
    test_zero_background()
    test_bright_sky_short_exposure()
    test_no_bzero_zero_offset()
    test_params_defaults()

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All tests passed!")
