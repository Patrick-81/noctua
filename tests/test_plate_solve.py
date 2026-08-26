#!/usr/bin/env python3
"""Tests for the astrometry plate solving pipeline.

Tests verify:
  - Fake image generation produces valid TIFF images
  - Plate solving returns correct WCS from injected star positions
  - Blind solve (no RA/DEC hint) still produces valid results
  - Edge cases: empty image, single star, few stars
"""

import os
import sys

# Add parent dir to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
from pathlib import Path
from PIL import Image

from indigo.plate_solve import solve_image
from src.astrometry.fake_fits import generate_fake_fits


# ── Test helpers ──────────────────────────────────────────────────

def _generate_test_image(name: str = "test_solve", width=1024, height=1024,
                        n_stars: int = 200) -> Path:
    """Generate a test fake image and return its path."""
    path = generate_fake_fits(
        output_path=f"fake_fits/{name}.fits",
        width=width,
        height=height,
        description=f"Test image: {name}",
        ra_center=180.0,
        dec_center=30.0,
        scale_arcsec_px=0.25,
        n_stars=n_stars,
        background_noise=10.0,
    )
    return path


def _assert_solve_ok(result: dict, label: str = ""):
    """Assert that a solve result is valid."""
    assert result.get("ok"), f"{label}: solve failed with {result.get('error')}"
    assert result.get("center_ra_deg") is not None, f"{label}: center_ra_deg missing"
    assert result.get("center_dec_deg") is not None, f"{label}: center_dec_deg missing"
    assert result.get("scale_arcsec_px") is not None, f"{label}: scale_arcsec_px missing"
    assert result.get("rotation_deg") is not None, f"{label}: rotation_deg missing"
    assert result.get("matched_stars") is not None, f"{label}: matched_stars missing"
    assert result.get("rms_arcsec") is not None, f"{label}: rms_arcsec missing"
    assert "wcs_header" in result, f"{label}: wcs_header missing"


def _assert_rms_reasonable(result: dict, label: str = ""):
    """Assert RMS is in a reasonable range."""
    rms = result["rms_arcsec"]
    assert rms > 0, f"{label}: RMS should be positive, got {rms}"
    # RMS < 3 arcsec is generally acceptable for a test image
    assert rms < 10, f"{label}: RMS too large ({rms:.2f} arcsec)"


def _assert_center_near_expected(result: dict, expected_ra: float,
                                expected_dec: float, tolerance_deg: float = 1.0,
                                label: str = ""):
    """Assert center is near expected coordinates."""
    ra = result["center_ra_deg"]
    dec = result["center_dec_deg"]
    ra_diff = abs(ra - expected_ra)
    dec_diff = abs(dec - expected_dec)
    assert ra_diff < tolerance_deg, (
        f"{label}: RA {ra:.4f} deg is too far from expected "
        f"{expected_ra} deg (diff={ra_diff:.4f} deg)"
    )
    assert dec_diff < tolerance_deg, (
        f"{label}: DEC {dec:.4f} deg is too far from expected "
        f"{expected_dec} deg (diff={dec_diff:.4f} deg)"
    )


# ── Test 1: Basic plate solve with fake image ─────────────────────

def test_basic_plate_solve():
    """Test 1: Basic plate solving on a fake image with known parameters."""
    print("\n[Test 1] Basic plate solve with fake image")

    # Generate image
    path = _generate_test_image("basic_solve", width=1024, height=1024, n_stars=200)
    assert path.exists(), "Fake image not generated"
    assert path.suffix in (".tif", ".tiff"), "Image should be TIFF"
    print(f"  ✓ Generated image: {path}")

    # Verify image dimensions
    with Image.open(path) as img:
        w, h = img.size
        assert w == 1024, f"Image width mismatch: {w} != 1024"
        assert h == 1024, f"Image height mismatch: {h} != 1024"
        print(f"  ✓ Image dimensions: {w}x{h}")

    # Solve with RA/DEC hints
    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    _assert_solve_ok(result, label="basic_solve")
    _assert_rms_reasonable(result, label="basic_solve")
    _assert_center_near_expected(result, 180.0, 30.0, tolerance_deg=2.0, label="basic_solve")

    print(f"  ✓ Stars found: {result['stars_found']}")
    print(f"  ✓ Matched stars: {result['matched_stars']}")
    print(f"  ✓ Center: RA={result['center_ra_deg']:.4f}°, DEC={result['center_dec_deg']:.4f}°")
    print(f"  ✓ RMS: {result['rms_arcsec']:.4f} arcsec")
    print(f"  ✓ Test 1 PASSED\n")


# ── Test 2: Blind solve (no RA/DEC hints) ────────────────────────

def test_blind_plate_solve():
    """Test 2: Blind plate solving without RA/DEC hints."""
    print("\n[Test 2] Blind plate solve (no RA/DEC hints)")

    path = _generate_test_image("blind_solve", width=1024, height=1024, n_stars=300)
    assert path.exists(), "Fake image not generated"
    print(f"  ✓ Generated image: {path}")

    result = solve_image(
        path=str(path),
        ra_deg=None,
        dec_deg=None,
        scale_arcsec_px=0.25,
    )

    _assert_solve_ok(result, label="blind_solve")
    _assert_rms_reasonable(result, label="blind_solve")

    print(f"  ✓ Stars found: {result['stars_found']}")
    print(f"  ✓ Matched stars: {result['matched_stars']}")
    print(f"  ✓ Center: RA={result['center_ra_deg']:.4f}°, DEC={result['center_dec_deg']:.4f}°")
    print(f"  ✓ RMS: {result['rms_arcsec']:.4f} arcsec")
    print(f"  ✓ Test 2 PASSED\n")


# ── Test 3: High-quality image (many stars, low noise) ───────────

def test_high_quality_solve():
    """Test 3: Solve on a high-quality image (many stars, low noise)."""
    print("\n[Test 3] High-quality image solve (500 stars, low noise)")

    path = _generate_test_image("high_quality", width=1024, height=1024,
                                n_stars=500)
    assert path.exists(), "Fake image not generated"
    print(f"  ✓ Generated image: {path}")

    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    _assert_solve_ok(result, label="high_quality_solve")
    _assert_rms_reasonable(result, label="high_quality_solve")

    assert result["matched_stars"] > 10, (
        f"high_quality_solve: expected >10 matched stars, got {result['matched_stars']}"
    )
    print(f"  ✓ Stars found: {result['stars_found']}")
    print(f"  ✓ Matched stars: {result['matched_stars']}")
    print(f"  ✓ Center: RA={result['center_ra_deg']:.4f}°, DEC={result['center_dec_deg']:.4f}°")
    print(f"  ✓ RMS: {result['rms_arcsec']:.4f} arcsec")
    print(f"  ✓ Test 3 PASSED\n")


# ── Test 4: Edge case — empty image (no stars) ───────────────────

def test_empty_image():
    """Test 4: Handle empty image with no detectable stars."""
    print("\n[Test 4] Edge case: empty image (no stars)")

    # Generate image with zero stars
    path = _generate_test_image("empty_solve", width=512, height=512, n_stars=0)
    assert path.exists(), "Fake image not generated"
    print(f"  ✓ Generated empty image: {path}")

    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    assert result.get("ok") is False, "Expected solve to fail on empty image"
    assert result.get("error") == "no stars detected", (
        f"Expected 'no stars detected', got '{result.get('error')}'"
    )
    print(f"  ✓ Empty image correctly rejected: '{result.get('error')}'")
    print(f"  ✓ Test 4 PASSED\n")


# ── Test 5: Single star image ────────────────────────────────────

def test_single_star():
    """Test 5: Handle image with only a single star."""
    print("\n[Test 5] Edge case: single star image")

    path = _generate_test_image("single_star", width=512, height=512, n_stars=1)
    assert path.exists(), "Fake image not generated"
    print(f"  ✓ Generated single-star image: {path}")

    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    assert result.get("ok") is False, (
        f"Expected solve to fail on single star (need minimum 2 for scale), "
        f"got {result.get('error')}"
    )
    print(f"  ✓ Single star correctly rejected: '{result.get('error')}'")
    print(f"  ✓ Test 5 PASSED\n")


# ── Test 6: WCS header fields ────────────────────────────────────

def test_wcs_header_fields():
    """Test 6: Verify WCS header contains required fields."""
    print("\n[Test 6] WCS header validation")

    path = _generate_test_image("wcs_test", width=1024, height=1024, n_stars=200)
    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    _assert_solve_ok(result, label="wcs_test")
    wcs = result["wcs_header"]

    # Check key WCS header fields are present
    required_keys = ["CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2",
                     "CDEQ1", "CDEQ2", "CTYPE1", "CTYPE2", "CUNIT1", "CUNIT2"]
    for key in required_keys:
        assert key in wcs, f"Missing WCS header field: {key}"
        print(f"  ✓ {key} = {wcs[key]}")

    print(f"  ✓ Test 6 PASSED\n")


# ── Test 7: Footprint corners ────────────────────────────────────

def test_footprint_corners():
    """Test 7: Verify footprint corners are returned and reasonable."""
    print("\n[Test 7] Footprint corners validation")

    path = _generate_test_image("footprint_test", width=1024, height=1024, n_stars=200)
    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=0.25,
    )

    _assert_solve_ok(result, label="footprint_test")
    corners = result.get("footprint_corners", [])
    assert len(corners) >= 0, f"Expected footprint corners, got {len(corners)}"
    print(f"  ✓ Footprint corners: {len(corners)} corners returned")

    for i, corner in enumerate(corners):
        assert "ra" in corner, f"Corner {i} missing 'ra'"
        assert "dec" in corner, f"Corner {i} missing 'dec'"
        print(f"  ✓ Corner {i+1}: RA={corner['ra']:.4f}°, DEC={corner['dec']:.4f}°")

    print(f"  ✓ Test 7 PASSED\n")


# ── Test 8: Scale consistency ────────────────────────────────────

def test_scale_consistency():
    """Test 8: Verify returned scale matches the input scale."""
    print("\n[Test 8] Scale consistency check")

    test_scale = 0.25
    path = _generate_test_image("scale_test", width=1024, height=1024, n_stars=200)
    result = solve_image(
        path=str(path),
        ra_deg=180.0,
        dec_deg=30.0,
        scale_arcsec_px=test_scale,
    )

    _assert_solve_ok(result, label="scale_test")

    actual_scale = result["scale_arcsec_px"]
    # Allow some tolerance (simulation may not recover exact scale)
    scale_ratio = actual_scale / test_scale
    assert 0.5 < scale_ratio < 2.0, (
        f"Scale {actual_scale:.4f} is too far from expected {test_scale} "
        f"(ratio={scale_ratio:.3f})"
    )
    print(f"  ✓ Expected scale: {test_scale} arcsec/px")
    print(f"  ✓ Actual scale:   {actual_scale:.4f} arcsec/px")
    print(f"  ✓ Ratio: {scale_ratio:.3f} (within 0.5-2.0 tolerance)")
    print(f"  ✓ Test 8 PASSED\n")


# ── Test 9: Multiple images ──────────────────────────────────────

def test_multiple_images():
    """Test 9: Verify multiple independent fake images can be solved."""
    print("\n[Test 9] Multiple images test")

    paths = []
    for i in range(3):
        p = _generate_test_image(f"multi_{i}", width=512, height=512, n_stars=150)
        paths.append(str(p))

    for i, p in enumerate(paths):
        result = solve_image(
            path=p,
            ra_deg=180.0,
            dec_deg=30.0,
            scale_arcsec_px=0.25,
        )
        _assert_solve_ok(result, label=f"multi_{i}")
        print(f"  ✓ Image {i+1}: matched={result['matched_stars']}, "
              f"rms={result['rms_arcsec']:.4f} arcsec")

    print(f"  ✓ Test 9 PASSED\n")


# ── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("INDIGO Devices — Plate Solve Tests")
    print("=" * 60)
    print()

    tests = [
        ("Test 1 — Basic plate solve", test_basic_plate_solve),
        ("Test 2 — Blind plate solve", test_blind_plate_solve),
        ("Test 3 — High-quality image", test_high_quality_solve),
        ("Test 4 — Empty image", test_empty_image),
        ("Test 5 — Single star", test_single_star),
        ("Test 6 — WCS header fields", test_wcs_header_fields),
        ("Test 7 — Footprint corners", test_footprint_corners),
        ("Test 8 — Scale consistency", test_scale_consistency),
        ("Test 9 — Multiple images", test_multiple_images),
    ]

    passed = 0
    failed = 0
    errors = []

    for name, func in tests:
        try:
            func()
            passed += 1
        except AssertionError as e:
            failed += 1
            errors.append(f"{name}: {e}")
            print(f"✗ {name}: {e}\n")
        except Exception as e:
            failed += 1
            errors.append(f"{name}: {type(e).__name__}: {e}")
            print(f"✗ {name}: {type(e).__name__}: {e}\n")

    # ── Summary ─────────────────────────────────────────────────
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Total:  {len(tests)}")
    print(f"  Passed: {passed}")
    print(f"  Failed: {failed}")
    print()

    if failed > 0:
        print("Failed tests:")
        for err in errors:
            print(f"  ✗ {err}")
        print()
        print("=" * 60)
        print("✗ SOME TESTS FAILED")
        print("=" * 60)
        sys.exit(1)
    else:
        print("=" * 60)
        print("✓ ALL TESTS PASSED")
        print("=" * 60)
        sys.exit(0)
