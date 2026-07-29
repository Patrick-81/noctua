"""
test_focus_metrics.py — Unit tests for focus_metrics module.

Tests star detection, HFR, FWHM, and FITS parsing
using synthetic images with known Gaussian star profiles.
No hardware required.
"""

import math
import struct
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from indigo.devices.focus_metrics import (
    compute_focus_metrics,
    compute_fwhm,
    compute_hfr,
    find_stars,
    parse_fits,
)

# ── Helpers ─────────────────────────────────────────────────────

def make_fits(w, h, bitpix, pixels):
    """Create minimal FITS bytes with given header values and pixel data."""
    cards = [
        "SIMPLE  =                    T",
        "NAXIS   =                    2",
        f"NAXIS1  =               {w:>5d}",
        f"NAXIS2  =               {h:>5d}",
        f"BITPIX  =               {bitpix:>5d}",
        "END",
    ]
    header = "".join(c.ljust(80) for c in cards).ljust(2880)

    if bitpix == 16:
        data = np.array(pixels, dtype=">i2").tobytes()
    elif bitpix == -16:
        data = np.array(pixels, dtype=">u2").tobytes()
    elif bitpix == 32:
        data = np.array(pixels, dtype=">i4").tobytes()
    elif bitpix == -32:
        data = np.array(pixels, dtype=">f4").tobytes()
    elif bitpix == 8:
        data = np.array(pixels, dtype="u1").tobytes()
    else:
        raise ValueError(f"Unsupported BITPIX: {bitpix}")

    return header.encode("ascii") + data


def make_star_image(w, h, stars, bg=100, bitpix=16):
    """Create FITS image with Gaussian stars.

    stars: list of (cx, cy, peak_flux, sigma)
    """
    img = np.full((h, w), bg, dtype=np.float64)
    yy, xx = np.mgrid[0:h, 0:w]
    for cx, cy, peak, sigma in stars:
        g = peak * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
        img += g
    return make_fits(w, h, bitpix, img.astype(np.int32 if bitpix > 0 else np.uint16))


def expected_hfr_gaussian(sigma):
    """Expected HFR for a 2D Gaussian with given sigma.

    HFR = sigma * sqrt(2 * ln(2)) for 2D Gaussian ≈ 1.177 * sigma
    """
    return sigma * math.sqrt(2 * math.log(2))


def expected_fwhm_gaussian(sigma):
    """Expected FWHM for a 2D Gaussian: 2 * sqrt(2 * ln(2)) * sigma ≈ 2.355 * sigma"""
    return 2 * sigma * math.sqrt(2 * math.log(2))


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


def test_fits_parsing():
    print("\n=== FITS Parsing ===")

    # Test BITPIX=16
    img = np.zeros((50, 50), dtype=np.int32)
    img[25, 25] = 1000
    data = make_fits(50, 50, 16, img)
    result, w, h = parse_fits(data)
    check(result is not None, "Parse BITPIX=16")
    check(w == 50 and h == 50, f"Dimensions 50x50 (got {w}x{h})")
    check(result[25, 25] == 1000, f"Pixel value at (25,25) = 1000 (got {result[25, 25]})")

    # Test BITPIX=-16
    img = np.zeros((30, 30), dtype=np.uint16)
    img[10, 10] = 500
    data = make_fits(30, 30, -16, img)
    result, w, h = parse_fits(data)
    check(result is not None, "Parse BITPIX=-16")
    check(result[10, 10] == 500, f"Pixel value at (10,10) = 500 (got {result[10, 10]})")

    # Test invalid FITS
    result, w, h = parse_fits(b"not a FITS file")
    check(result is None, "Invalid FITS returns None")

    # Test empty data
    result, w, h = parse_fits(b"")
    check(result is None, "Empty data returns None")


def test_star_detection():
    print("\n=== Star Detection ===")

    # Single bright star
    data = make_star_image(100, 100, [(50, 50, 5000, 3.0)], bg=100)
    image, w, h = parse_fits(data)
    stars = find_stars(image, threshold_sigma=3.0, min_distance=5)
    check(len(stars) >= 1, f"Detected >=1 star (got {len(stars)})")
    if stars:
        s = stars[0]
        check(abs(s["x"] - 50) <= 2 and abs(s["y"] - 50) <= 2,
              f"Star at ~(50,50) (got ({s['x']},{s['y']}))")
        check(s["flux"] > 0, f"Flux > 0 (got {s['flux']:.0f})")

    # Multiple stars
    data = make_star_image(200, 200, [
        (50, 50, 5000, 2.5),
        (150, 80, 3000, 2.0),
        (100, 150, 8000, 3.5),
    ], bg=100)
    image, w, h = parse_fits(data)
    stars = find_stars(image, threshold_sigma=3.0, min_distance=5)
    check(len(stars) >= 3, f"Detected >=3 stars (got {len(stars)})")

    # No stars (flat image)
    data = make_star_image(100, 100, [], bg=100)
    image, w, h = parse_fits(data)
    stars = find_stars(image, threshold_sigma=5.0)
    check(len(stars) == 0, f"No stars in flat image (got {len(stars)})")

    # Faint star below threshold — use high threshold since flat images have very low std
    data = make_star_image(100, 100, [(50, 50, 20, 2.0)], bg=100)
    image, w, h = parse_fits(data)
    stars = find_stars(image, threshold_sigma=50.0)
    check(len(stars) == 0, f"Faint star below threshold (got {len(stars)})")


def test_hfr_gaussian():
    print("\n=== HFR (Gaussian) ===")

    for sigma in [2.0, 3.0, 5.0]:
        data = make_star_image(100, 100, [(50, 50, 10000, sigma)], bg=0)
        image, w, h = parse_fits(data)
        hfr = compute_hfr(image, 50, 50, radius=20, bg_median=0.0)
        expected = expected_hfr_gaussian(sigma)
        ratio = hfr / expected if expected > 0 else 0
        check(0.8 < ratio < 1.3,
              f"HFR for sigma={sigma}: got {hfr:.2f}, expected ~{expected:.2f} (ratio={ratio:.2f})")


def test_fwhm_gaussian():
    print("\n=== FWHM (Gaussian) ===")

    for sigma in [2.0, 3.0, 5.0]:
        data = make_star_image(100, 100, [(50, 50, 10000, sigma)], bg=0)
        image, w, h = parse_fits(data)
        fwhm = compute_fwhm(image, 50, 50, radius=20, bg_median=0.0)
        expected = expected_fwhm_gaussian(sigma)
        ratio = fwhm / expected if expected > 0 else 0
        check(0.7 < ratio < 1.4,
              f"FWHM for sigma={sigma}: got {fwhm:.2f}, expected ~{expected:.2f} (ratio={ratio:.2f})")


def test_focus_metrics_integration():
    print("\n=== Focus Metrics (integration) ===")

    # Image with 3 stars
    data = make_star_image(200, 200, [
        (50, 50, 5000, 2.5),
        (150, 80, 3000, 2.0),
        (100, 150, 8000, 3.5),
    ], bg=100)
    result = compute_focus_metrics(data)
    check(result["ok"], "Metrics computed successfully")
    check(result["star_count"] >= 3, f"Found >=3 stars (got {result['star_count']})")
    check(result["hfr"] > 0, f"Average HFR > 0 (got {result['hfr']})")
    check(result["fwhm"] > 0, f"Average FWHM > 0 (got {result['fwhm']})")
    check(result["width"] == 200, f"Width=200 (got {result['width']})")
    check(result["height"] == 200, f"Height=200 (got {result['height']})")
    check(len(result["stars"]) <= 100, "Stars list capped at 100")

    # Each star should have hfr, fwhm, gaussian_quality
    for s in result["stars"][:3]:
        check("hfr" in s and "fwhm" in s, f"Star ({s['x']},{s['y']}) has hfr/fwhm")
        check("gaussian_quality" in s, f"Star ({s['x']},{s['y']}) has gaussian_quality")
        check(0 <= s["gaussian_quality"] <= 1, f"gaussian_quality between 0 and 1")

    # Stars should be sorted by gaussian_quality descending
    qualities = [s["gaussian_quality"] for s in result["stars"]]
    check(qualities == sorted(qualities, reverse=True),
          "Stars sorted by gaussian_quality descending")

    # Empty image
    data = make_star_image(100, 100, [], bg=100)
    result = compute_focus_metrics(data)
    check(result["ok"], "Empty image returns ok")
    check(result["star_count"] == 0, "Empty image: 0 stars")
    check(result["hfr"] == 0, "Empty image: HFR=0")


def test_hfr_weighted_average():
    print("\n=== HFR Weighted Average ===")

    # Two stars with different sizes - larger star should dominate weighted average
    data = make_star_image(200, 200, [
        (50, 50, 10000, 2.0),   # narrow, bright
        (150, 150, 2000, 5.0),  # wide, faint
    ], bg=0)
    result = compute_focus_metrics(data)
    check(result["ok"], "Computed metrics for two stars")

    # The flux-weighted average should be closer to the bright star's HFR
    narrow_hfr = expected_hfr_gaussian(2.0)
    wide_hfr = expected_hfr_gaussian(5.0)
    check(result["hfr"] < wide_hfr,
          f"Flux-weighted HFR ({result['hfr']:.2f}) < wide star HFR ({wide_hfr:.2f})")


# ── Run all tests ───────────────────────────────────────────────

if __name__ == "__main__":
    test_fits_parsing()
    test_star_detection()
    test_hfr_gaussian()
    test_fwhm_gaussian()
    test_focus_metrics_integration()
    test_hfr_weighted_average()

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All tests passed!")
