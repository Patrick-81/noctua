#!/usr/bin/env python3
"""Test the astrometry plate solving pipeline with fake images."""

import sys
import os

# Add parent dir to path
sys.path.insert(0, os.path.dirname(__file__))

from indigo.plate_solve import solve_image
from src.astrometry.fake_fits import generate_fake_fits

print("=" * 60)
print("Testing plate solving on fake image")
print("=" * 60)

# Generate a fake image
output_path = generate_fake_fits(
    output_path="fake_fits/test_solve.fits",
    width=1920,
    height=1080,
    description="Test image for plate solving",
    ra_center=180.0,
    dec_center=30.0,
    scale_arcsec_px=0.25,
    n_stars=500,
    background_noise=10.0,
)
print(f"\n✓ Generated fake image: {output_path}")
print(f"  Size: 1920x1080, 500 stars, sigma=10.0")

# Solve the image
print(f"\nSolving: {output_path}")
print(f"RA center: 180.0 deg, DEC center: 30.0 deg")
print(f"Scale: 0.25 arcsec/px")

result = solve_image(path=str(output_path), ra_deg=180.0, dec_deg=30.0, scale_arcsec_px=0.25)

if result.get("ok"):
    print("\n✓ PLATE SOLVING SUCCESSFUL")
    print(f"  Center RA:  {result['center_ra_deg']:.4f} deg")
    print(f"  Center DEC: {result['center_dec_deg']:.4f} deg")
    print(f"  Scale:      {result['scale_arcsec_px']:.4f} arcsec/px")
    print(f"  Rotation:   {result['rotation_deg']:.4f} deg")
    print(f"  Stars found: {result['stars_found']}")
    print(f"  Matched:    {result['matched_stars']}")
    print(f"  RMS quality:{result['rms_arcsec']:.4f} arcsec")
    print()
    print("WCS Header:")
    for k, v in result.get("wcs_header", {}).items():
        print(f"  {k} = {v}")
    print()
    print("=" * 60)
    print("✓ ALL TESTS PASSED")
    print("=" * 60)
    sys.exit(0)
else:
    print(f"\n✗ PLATE SOLVING FAILED")
    print(f"  Error: {result.get('error', 'Unknown error')}")
    print(f"  Stars found: {result.get('stars_found', 0)}")
    print()
    print("=" * 60)
    print("✗ TESTS FAILED")
    print("=" * 60)
    sys.exit(1)
