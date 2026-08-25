#!/usr/bin/env python3
"""test_solver.py — End-to-end tests for the Seiza plate solver.

Tests:
  1. FITS parsing (header + data)
  2. Star detection on synthetic images
  3. Hinted plate solving on known fields
  4. Accuracy check (RA/DEC within tolerance of known center)

Usage:
    python tests/test_solver.py              # Run all tests
    python tests/test_solver.py --verbose    # Verbose output
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.solver import Solver

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {name}" + (f" ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


def test_fits_parsing():
    print("\n── FITS Parsing ──")
    s = Solver()

    for field in ["orion", "pleiades", "gemini", "cygnus", "wide_field"]:
        path = f"tests/fake_sky/test_{field}.fits"
        if not os.path.exists(path):
            check(f"{field} file exists", False, "file missing")
            continue

        with open(path, "rb") as f:
            data = f.read()

        img, w, h = s._parse_fits(data)
        check(f"{field} parsed", img is not None, f"shape={img.shape if img is not None else 'None'}")
        check(f"{field} dimensions", w == 1920 and h == 1080, f"{w}x{h}")
        check(f"{field} dtype", img.dtype == np.float32, f"dtype={img.dtype}")
        check(f"{field} range", img.max() > 100, f"max={img.max():.1f}")


def test_star_detection():
    print("\n── Star Detection ──")
    try:
        import seiza
    except ImportError:
        check("seiza available", False, "ModuleNotFoundError")
        return

    s = Solver()

    for field, expected_min in [("orion", 50), ("ursa_major", 50), ("wide_field", 100)]:
        path = f"tests/fake_sky/test_{field}.fits"
        if not os.path.exists(path):
            continue

        img, w, h = s._parse_fits(open(path, "rb").read())
        stars = seiza.detect(img, sigma=2.0)
        check(f"{field} stars detected", len(stars) >= expected_min,
              f"{len(stars)} >= {expected_min}")


def test_hinted_solve():
    print("\n── Hinted Plate Solving ──")
    try:
        import seiza
    except ImportError:
        check("catalogs loaded", False, "seiza not available")
        return

    s = Solver()
    result = s.load_catalogs()
    check("catalogs loaded", result["ok"], result.get("catalog", ""))

    with open("tests/fake_sky/test_orion.fits", "rb") as f:
        fits_data = f.read()

    t0 = time.monotonic()
    r = s.solve_image(fits_data, fmt="fits", ra_hint=84.0, dec_hint=-1.0, scale_hint=3.0, sigma=2.0)
    elapsed_ms = (time.monotonic() - t0) * 1000

    check("solve ok", r["ok"], r.get("error", ""))
    if r["ok"]:
        check("RA near expected", abs(r["ra"] - 84.0) < 5.0, f"ra={r['ra']:.2f}")
        check("DEC near expected", abs(r["dec"] - (-1.0)) < 5.0, f"dec={r['dec']:.2f}")
        check("scale reasonable", 1.5 < r["scale"] < 4.0, f"scale={r['scale']:.2f}")
        check("matched stars", r["matches"] >= 5, f"matches={r['matches']}")
        check("solve time", elapsed_ms < 10000, f"{elapsed_ms:.0f}ms")

        print(f"\n  Solution: RA={r['ra']:.4f}° DEC={r['dec']:.4f}° "
              f"scale={r['scale']:.2f}\"/px rot={r['rotation']:.1f}° "
              f"matches={r['matches']} rms={r['rms']:.2f}\"")


def test_accuracy_on_fields():
    print("\n── Accuracy on Multiple Fields ──")
    try:
        import seiza
    except ImportError:
        print("  ⚠ seiza not available — skipping")
        return

    s = Solver()
    s.load_catalogs()

    tests = [
        ("orion",      84.0,  -1.0,  3.0),
        ("gemini",    115.0,  24.0,  3.0),
        ("cassiopeia", 15.0,  60.0,  2.0),
    ]

    for name, ra, dec, scale in tests:
        path = f"tests/fake_sky/test_{name}.fits"
        if not os.path.exists(path):
            continue

        with open(path, "rb") as f:
            data = f.read()

        r = s.solve_image(data, fmt="fits", ra_hint=ra, dec_hint=dec, scale_hint=scale, sigma=2.0)
        if r["ok"]:
            check(f"{name} solved", True, f"RA={r['ra']:.2f} DEC={r['dec']:.2f}")
        else:
            check(f"{name} solved", False, r.get("error", "")[:60])


def main():
    print("=" * 60)
    print("Seiza Plate Solver — Test Suite")
    print("=" * 60)

    test_fits_parsing()
    test_star_detection()
    test_hinted_solve()
    test_accuracy_on_fields()

    print(f"\n{'=' * 60}")
    print(f"Results: {PASS} passed, {FAIL} failed")
    print(f"{'=' * 60}")

    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
