#!/usr/bin/env python3
"""Quick test of the astrometry plate solving pipeline."""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from indigo.plate_solve import solve_image

print("=" * 60)
print("Testing plate solving on fake image")
print("=" * 60)

path = "fake_fits/Test Orion Nebula.tif"
print(f"\nSolving: {path}")
print(f"RA center: 180.0 deg, DEC center: 30.0 deg")
print(f"Scale: 0.25 arcsec/px")
print()

result = solve_image(path=path, ra_deg=180.0, dec_deg=30.0, scale_arcsec_px=0.25)

if result.get("ok"):
    print("✓ PLATE SOLVING SUCCESSFUL")
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
else:
    print("✗ PLATE SOLVING FAILED")
    print(f"  Error: {result.get('error', 'Unknown error')}")
    print(f"  Stars found: {result.get('stars_found', 0)}")

print()
print("=" * 60)
print(f"Test finished with exit code {0 if result.get('ok') else 1}")
print("=" * 60)
