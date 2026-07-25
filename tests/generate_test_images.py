#!/usr/bin/env python3
"""
generate_test_images.py — Generate synthetic FITS star fields for plate solver testing.

Creates realistic-looking star field images with known WCS coordinates
so we can test the Seiza plate solver without a real camera.

Each image has:
- Stars at known RA/DEC positions (from a built-in catalog)
- Gaussian PSF with realistic FWHM
- Poisson + Gaussian noise
- Proper FITS headers (WCS TAN projection)

Usage:
    python generate_test_images.py              # Generate all test images
    python generate_test_images.py --list       # List available test fields
    python generate_test_images.py --field m42  # Generate specific field
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np

# ── Catalog loader (lazy) ───────────────────────────────────────
_catalog = None

def _get_catalog():
    """Load the Tycho-2 catalog via seiza (if available)."""
    global _catalog
    if _catalog is not None:
        return _catalog
    try:
        import seiza as _sz
        paths = _sz.fetch_catalogs(cache_dir=str(Path.home() / '.cache/seiza/catalogs'))
        _catalog = _sz.StarCatalog.open(paths['stars-lite-tycho2.bin'])
        return _catalog
    except Exception as e:
        print(f"  WARNING: Could not load catalog: {e}")
        return None


# ── Built-in star catalog (bright stars, Tycho-2 subset) ────────
# Format: (RA_deg, DEC_deg, Vmag, name)
# These are real bright stars that Seiza can match against Tycho-2

BRIGHT_STARS = [
    # Orion
    (88.79, -1.20, 0.42, "Betelgeuse"),
    (81.28, -1.94, 0.13, "Rigel"),
    (85.19, -0.30, 1.69, "Alnilam"),
    (84.05, -1.20, 1.64, "Alnitak"),
    (86.94, -0.30, 1.77, "Mintaka"),
    (83.82, -0.30, 1.69, "Alnilam"),
    (84.05, -1.94, 1.70, "Alnitak"),
    (86.94, -1.94, 2.23, "Mintaka"),
    (87.46, 5.91, 1.70, "Meissa"),
    (83.00, 6.35, 2.06, "Bellatrix"),
    (89.88, 7.41, 1.77, "Saiph"),
    # Taurus
    (68.98, 16.51, 0.85, "Aldebaran"),
    (56.04, 28.61, 1.65, "Elnath"),
    (54.61, 24.11, 3.41, "Alcyone"),
    # Gemini
    (116.33, 28.03, 1.58, "Castor"),
    (113.65, 28.03, 1.14, "Pollux"),
    (110.03, 20.57, 1.93, "Alhena"),
    # Canis Major
    (101.29, -16.72, -1.46, "Sirius"),
    (104.66, -28.97, 1.50, "Adhara"),
    (95.99, -17.96, 1.84, "Wezen"),
    # Monoceros
    (113.65, -1.45, 3.94, "CMon-15"),
    (109.29, -4.70, 3.54, "Beta Mon"),
    # Hydra
    (141.90, -8.66, 1.98, "Alphard"),
    # Leo
    (152.09, 11.97, 1.35, "Regulus"),
    (168.56, 14.57, 2.14, "Denebola"),
    (148.33, 23.77, 1.36, "Denebola"),
    (141.09, 23.42, 2.56, "Zosma"),
    # Virgo
    (200.98, -11.16, 0.97, "Spica"),
    # Bootes
    (206.89, 19.18, -0.05, "Arcturus"),
    # Ursa Major (Big Dipper)
    (165.93, 61.75, 1.79, "Dubhe"),
    (178.46, 56.38, 2.27, "Merak"),
    (183.86, 57.03, 2.44, "Phecda"),
    (193.51, 55.96, 3.31, "Megrez"),
    (200.98, 54.93, 1.77, "Alioth"),
    (206.89, 54.93, 2.27, "Mizar"),
    (213.92, 55.96, 1.86, "Alkaid"),
    # Cygnus
    (310.36, 33.97, 1.25, "Deneb"),
    (305.56, 45.28, 2.48, "Sadr"),
    (298.44, 27.96, 2.20, "Albireo"),
    # Lyra
    (283.76, 38.78, 0.03, "Vega"),
    # Aquila
    (297.70, 8.87, 0.76, "Altair"),
    # Scorpius
    (247.35, -26.43, 1.05, "Antares"),
    (244.96, -22.62, 2.62, "Graffias"),
    (253.18, -20.67, 2.89, "Dschubba"),
    # Sagittarius
    (270.67, -34.40, 1.80, "Kaus Australis"),
    (264.33, -29.50, 1.85, "Nunki"),
    (271.10, -29.05, 2.59, "Ascella"),
    # Cassiopeia
    (10.13, 56.54, 2.27, "Caph"),
    (14.18, 60.72, 2.28, "Schedar"),
    (18.54, 63.67, 2.47, "Navi"),
    (22.52, 57.81, 2.68, "Ruchbah"),
    (25.38, 60.24, 3.37, "Segin"),
    # Andromeda
    (17.13, 35.62, 2.06, "Alpheratz"),
    (14.18, 23.46, 2.06, "Mirach"),
    (46.80, 38.50, 2.06, "Almach"),
    # Perseus
    (51.08, 49.86, 1.80, "Mirfak"),
    (47.00, 40.96, 2.84, "Algol"),
    # Pleiades (M45)
    (56.87, 24.11, 2.87, "Electra"),
    (56.46, 24.47, 3.63, "Maia"),
    (55.73, 24.11, 3.87, "Merope"),
    (56.63, 24.37, 4.18, "Taygeta"),
    (56.21, 24.47, 5.03, "Celaeno"),
    # Orion Nebula region (M42)
    (83.82, -5.39, 4.00, "M42-center"),
    (83.63, -5.05, 4.50, "M43"),
    (84.21, -5.42, 3.70, "Trapéze"),
    # Andromeda Galaxy (M31) region
    (10.68, 41.27, 3.44, "M31-center"),
    (10.09, 40.87, 4.50, "M31-sat1"),
    (11.27, 41.57, 4.80, "M31-sat2"),
    # Lagoon Nebula (M8) region
    (270.97, -24.38, 6.00, "M8-center"),
    (271.04, -24.53, 5.50, "M8-neb"),
    # Wild Duck Cluster (M11) region
    (282.76, -6.27, 5.80, "M11-center"),
    # Beehive Cluster (M44) region
    (130.03, 19.67, 5.50, "M44-center"),
    (130.20, 19.80, 6.20, "M44-star1"),
    (129.90, 19.50, 6.50, "M44-star2"),
]


def _wcs_to_pixel(ra_deg, dec_deg, ra_cen, dec_cen, scale_arcsec_px, w, h):
    """Convert RA/DEC to pixel coordinates using TAN projection."""
    # Convert to radians
    ra = np.radians(ra_deg)
    dec = np.radians(dec_deg)
    ra0 = np.radians(ra_cen)
    dec0 = np.radians(dec_cen)

    # TAN projection
    cos_dec = np.cos(dec)
    sin_dec = np.sin(dec)
    cos_dec0 = np.cos(dec0)
    sin_dec0 = np.sin(dec0)

    # Direction cosines
    l = cos_dec * np.cos(ra - ra0) - sin_dec0 * (sin_dec - sin_dec0 * cos_dec * np.cos(ra - ra0)) / cos_dec0
    # Simplified TAN: for small fields, use linear approximation
    # dx and dy in radians, consistent with scale_rad
    dx = (ra - ra0) * cos_dec0  # radians
    dy = dec - dec0             # radians

    # Convert to pixels
    scale_rad = np.radians(scale_arcsec_px / 3600.0)
    x = dx / scale_rad + w / 2.0
    y = dy / scale_rad + h / 2.0

    return x, y


def generate_star_field(
    center_ra: float,
    center_dec: float,
    width_px: int = 1920,
    height_px: int = 1080,
    scale_arcsec_px: float = 2.5,
    fov_margin: float = 1.1,
    pixel_size_um: float = 2.9,
    focal_length_mm: float = 1200.0,
    fwhm_px: float = 4.0,
    noise_level: float = 10.0,
    seed: int | None = None,
) -> tuple[np.ndarray, dict]:
    """Generate a synthetic star field image.

    Uses the real Tycho-2 catalog (via seiza.cone_search) to place stars
    at exact catalog positions, ensuring the plate solver can match them.

    Returns:
        (image_array, metadata_dict)
    """
    rng = np.random.default_rng(seed)

    # Image dimensions
    fov_x_deg = width_px * scale_arcsec_px / 3600.0
    fov_y_deg = height_px * scale_arcsec_px / 3600.0
    fov_radius_deg = np.hypot(fov_x_deg, fov_y_deg) / 2.0 * fov_margin

    # Select stars from the real catalog
    field_stars = []
    catalog = _get_catalog()
    if catalog is not None:
        try:
            catalog_stars = catalog.cone_search(
                center_ra, center_dec,
                radius_deg=fov_radius_deg,
                limit=5000,
            )
            for ra, dec, vmag in catalog_stars:
                x, y = _wcs_to_pixel(ra, dec, center_ra, center_dec, scale_arcsec_px, width_px, height_px)
                if 0 < x < width_px and 0 < y < height_px:
                    flux = 10 ** ((8.0 - vmag) / 2.5) * 80
                    field_stars.append((x, y, flux, vmag, f"tycho_{len(field_stars)}", ra, dec))
        except Exception as e:
            print(f"  WARNING: catalog search failed: {e}")

    if not field_stars:
        # Fallback: use built-in bright stars only
        for ra, dec, vmag, name in BRIGHT_STARS:
            x, y = _wcs_to_pixel(ra, dec, center_ra, center_dec, scale_arcsec_px, width_px, height_px)
            margin = max(width_px, height_px) * (fov_margin - 1) / 2
            if -margin < x < width_px + margin and -margin < y < height_px + margin:
                flux = 10 ** ((8.0 - vmag) / 2.5) * 80
                field_stars.append((x, y, flux, vmag, name, ra, dec))

    # Create image
    img = rng.normal(0, noise_level, (height_px, width_px)).astype(np.float32)

    # Add sky background
    img += 50.0

    # Draw stars with Gaussian PSF
    sigma = fwhm_px / 2.355
    for x, y, flux, vmag, name, ra, dec in field_stars:
        # Gaussian PSF (limited to 6 sigma for speed)
        r = int(6 * sigma) + 1
        x0, y0 = int(x), int(y)
        for dy in range(max(0, y0 - r), min(height_px, y0 + r + 1)):
            for dx in range(max(0, x0 - r), min(width_px, x0 + r + 1)):
                d2 = (dx - x) ** 2 + (dy - y) ** 2
                img[dy, dx] += flux * np.exp(-0.5 * d2 / (sigma ** 2))

    # Clip to uint16 range
    img = np.clip(img, 0, 65535).astype(np.uint16)

    # Build metadata
    meta = {
        "center_ra": center_ra,
        "center_dec": center_dec,
        "width": width_px,
        "height": height_px,
        "scale_arcsec_px": scale_arcsec_px,
        "pixel_size_um": pixel_size_um,
        "focal_length_mm": focal_length_mm,
        "n_stars": len(field_stars),
        "named_stars": [(s[5], s[6], s[3], s[4]) for s in field_stars if not s[4].startswith("rnd")],
    }

    return img, meta


def write_fits(img: np.ndarray, filepath: str, meta: dict) -> None:
    """Write a FITS file with proper WCS headers."""
    h, w = img.shape
    bitspix = 16

    # Build FITS header
    header_lines = []
    header_lines.append(f"SIMPLE  =                    T")
    header_lines.append(f"BITPIX  =                   {bitspix}")
    header_lines.append(f"NAXIS   =                    2")
    header_lines.append(f"NAXIS1  =                   {w}")
    header_lines.append(f"NAXIS2  =                   {h}")
    header_lines.append(f"EXTEND  =                    T")
    header_lines.append(f"")
    header_lines.append(f"CRPIX1  =           {w / 2 + 0.5:.1f}        / Reference pixel X")
    header_lines.append(f"CRPIX2  =           {h / 2 + 0.5:.1f}        / Reference pixel Y")
    header_lines.append(f"CRVAL1  =        {meta['center_ra']:.6f}        / Reference RA (deg)")
    header_lines.append(f"CRVAL2  =        {meta['center_dec']:.6f}        / Reference DEC (deg)")
    header_lines.append(f"CTYPE1  = 'RA---TAN'           / TAN projection")
    header_lines.append(f"CTYPE2  = 'DEC--TAN'           / TAN projection")
    cd11 = -meta['scale_arcsec_px'] / 3600.0
    cd22 = meta['scale_arcsec_px'] / 3600.0
    header_lines.append(f"CD1_1   =        {cd11:.10f}        / CD matrix (deg/pix)")
    header_lines.append(f"CD1_2   =        0.0000000000        / CD matrix")
    header_lines.append(f"CD2_1   =        0.0000000000        / CD matrix")
    header_lines.append(f"CD2_2   =        {cd22:.10f}        / CD matrix (deg/pix)")
    header_lines.append(f"CDELT1  =        {cd11:.10f}")
    header_lines.append(f"CDELT2  =        {cd22:.10f}")
    header_lines.append(f"EQUINOX =               2000.0        / Equinox of coordinates")
    header_lines.append(f"RADECSYS= 'FK5'                / Reference frame")
    header_lines.append(f"")
    header_lines.append(f"TELESCOP= 'Synthetic'          / Test image generator")
    header_lines.append(f"INSTRUME= 'Synthetic CCD'      / Fake camera")
    header_lines.append(f"FILTER  = 'None'               / No filter")
    header_lines.append(f"EXPTIME =                 1.0        / Exposure time (s)")
    header_lines.append(f"PIXSCALE=          {meta['scale_arcsec_px']:.2f}        / arcsec/pixel")
    header_lines.append(f"PIXSIZE1=          {meta['pixel_size_um']:.1f}        / pixel size (um)")
    header_lines.append(f"PIXSIZE2=          {meta['pixel_size_um']:.1f}        / pixel size (um)")
    header_lines.append(f"FOCALLEN=         {meta['focal_length_mm']:.1f}        / focal length (mm)")
    header_lines.append(f"")
    header_lines.append(f"END")

    # Pad header to multiple of 2880 bytes (36 cards × 80 chars)
    while len(header_lines) % 36 != 0:
        header_lines.append("")
    header_bytes = "".join(line.ljust(80) for line in header_lines).encode('ascii')
    assert len(header_bytes) % 2880 == 0, f"Header not multiple of 2880: {len(header_bytes)}"

    # Write FITS
    with open(filepath, 'wb') as f:
        f.write(header_bytes)
        # Write image data (big-endian int16)
        data_bytes = img.astype('>i2').tobytes()
        f.write(data_bytes)
        # Pad data to multiple of 2880
        pad = (2880 - len(data_bytes) % 2880) % 2880
        f.write(b'\0' * pad)

    print(f"  Written: {filepath} ({os.path.getsize(filepath)} bytes, {w}x{h}, {meta['n_stars']} stars)")


# ── Test fields ─────────────────────────────────────────────────

TEST_FIELDS = {
    "orion": {
        "center_ra": 84.0,
        "center_dec": -1.0,
        "scale_arcsec_px": 3.0,
        "desc": "Orion (Betelgeuse, Rigel, Belt stars)",
    },
    "pleiades": {
        "center_ra": 56.5,
        "center_dec": 24.3,
        "scale_arcsec_px": 2.0,
        "desc": "Pleiades (M45) — cluster dense",
    },
    "m42": {
        "center_ra": 83.8,
        "center_dec": -5.4,
        "scale_arcsec_px": 1.5,
        "desc": "Orion Nebula (M42) — tight field",
    },
    "gemini": {
        "center_ra": 115.0,
        "center_dec": 24.0,
        "scale_arcsec_px": 3.0,
        "desc": "Gemini (Castor, Pollux)",
    },
    "ursa_major": {
        "center_ra": 195.0,
        "center_dec": 56.0,
        "scale_arcsec_px": 4.0,
        "desc": "Grande Ourse (Big Dipper)",
    },
    "cygnus": {
        "center_ra": 305.0,
        "center_dec": 38.0,
        "scale_arcsec_px": 2.5,
        "desc": "Cygne (Deneb, Sadr, Albireo)",
    },
    "scorpius": {
        "center_ra": 250.0,
        "center_dec": -24.0,
        "scale_arcsec_px": 3.5,
        "desc": "Scorpion (Antares)",
    },
    "cassiopeia": {
        "center_ra": 15.0,
        "center_dec": 60.0,
        "scale_arcsec_px": 2.0,
        "desc": "Cassiopeia — region polaire",
    },
    "andromeda": {
        "center_ra": 10.7,
        "center_dec": 41.3,
        "scale_arcsec_px": 5.0,
        "desc": "Andromède (M31) — grand champ",
    },
    "wide_field": {
        "center_ra": 180.0,
        "center_dec": 0.0,
        "scale_arcsec_px": 10.0,
        "desc": "Large champ équatorial — many stars",
    },
}


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic FITS star fields")
    parser.add_argument("--list", action="store_true", help="List available test fields")
    parser.add_argument("--field", type=str, help="Generate specific field (or 'all')")
    parser.add_argument("--output-dir", type=str, default="tests/fake_sky",
                        help="Output directory (default: tests/fake_sky)")
    parser.add_argument("--width", type=int, default=1920, help="Image width")
    parser.add_argument("--height", type=int, default=1080, help="Image height")
    args = parser.parse_args()

    if args.list:
        print("Available test fields:")
        for name, f in TEST_FIELDS.items():
            print(f"  {name:15s} — {f['desc']}")
            print(f"                  RA={f['center_ra']:.1f} DEC={f['center_dec']:.1f} scale={f['scale_arcsec_px']:.1f}\"/px")
        return

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    fields_to_generate = [args.field] if args.field else list(TEST_FIELDS.keys())

    print(f"Generating {len(fields_to_generate)} test images → {output_dir}/")
    print(f"Image size: {args.width}x{args.height}")
    print()

    for field_name in fields_to_generate:
        if field_name not in TEST_FIELDS:
            print(f"ERROR: Unknown field '{field_name}'")
            print(f"Available: {', '.join(TEST_FIELDS.keys())}")
            continue

        f = TEST_FIELDS[field_name]
        print(f"[{field_name}] {f['desc']}")

        t0 = time.monotonic()
        img, meta = generate_star_field(
            center_ra=f["center_ra"],
            center_dec=f["center_dec"],
            width_px=args.width,
            height_px=args.height,
            scale_arcsec_px=f["scale_arcsec_px"],
            seed=int.from_bytes(field_name.encode(), 'big') % 10000,
        )
        elapsed = time.monotonic() - t0

        filepath = output_dir / f"test_{field_name}.fits"
        write_fits(img, str(filepath), meta)

        # Also write a metadata JSON for test verification
        import json
        meta_path = output_dir / f"test_{field_name}.json"
        with open(meta_path, 'w') as mf:
            json.dump(meta, mf, indent=2, default=str)
        print(f"  Metadata: {meta_path}")
        print(f"  Generated in {elapsed:.2f}s")
        print()

    print("Done! Test images generated.")
    print(f"To test the solver:")
    print(f"  python -c \"from indigo.devices.solver import Solver; s = Solver(); s.load_catalogs()\"")
    print(f"  Then load a FITS file and call s.solve_image(data, fmt='fits')")


if __name__ == "__main__":
    main()
