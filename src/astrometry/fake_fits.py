"""Generate fake images for astrometry testing.

Generates TIFF images with synthetic star fields (Gaussian PSF).
No astropy dependency required — seiza reads via PIL.
"""

import os
from pathlib import Path

import numpy as np

from PIL import Image


def _save_image(arr_uint: np.ndarray, output_path: Path) -> Path:
    """Save a uint16 image array to TIFF using PIL."""
    height, width = arr_uint.shape
    img_pil = Image.fromarray(arr_uint)
    img_pil.save(output_path)
    return output_path


def generate_fake_fits(
    output_path: str = "fake_fits/orion_nebula.fits",
    width: int = 1920,
    height: int = 1080,
    description: str = "",
    ra_center: float = 180.0,
    dec_center: float = 30.0,
    scale_arcsec_px: float = 0.25,
    n_stars: int = 500,
    background_noise: float = 10.0,
) -> Path:
    """Generate a synthetic image with realistic star field.

    Args:
        output_path: Where to write the image file.
        width: Image width in pixels.
        height: Image height in pixels.
        description: Image description (stored in filename).
        ra_center: Center RA in degrees.
        dec_center: Center DEC in degrees.
        scale_arcsec_px: Scale in arcsec per pixel.
        n_stars: Number of stars to inject.
        background_noise: Gaussian noise sigma.

    Returns:
        Path to the generated image file.
    """
    # Pre-allocate image array
    img = np.zeros((height, width), dtype=np.float32)

    # Add background noise (vectorized)
    img += np.random.normal(0.0, background_noise, (height, width))

    # Generate random star positions
    x = np.random.uniform(0, width, n_stars)
    y = np.random.uniform(0, height, n_stars)
    fluxes = np.random.lognormal(mean=5.0, sigma=0.8, size=n_stars)
    fluxes = np.clip(fluxes, 10000.0, 500000.0)

    # Pre-create meshgrid for PSF computation
    yy, xx = np.ogrid[:height, :width]

    # Vectorized star placement using broadcasting
    # For each star i: diff_x[i,j,k] = j - x[i], diff_y[i,j,k] = k - y[i]
    # PSF = flux[i] * exp(-(diff_x^2 + diff_y^2) / (2 * sigma^2))
    # Sum over all stars (axis 0)

    # Efficient vectorization: split into batches
    batch_size = 50
    for start in range(0, n_stars, batch_size):
        end = min(start + batch_size, n_stars)
        sx = x[start:end]
        sy = y[start:end]
        fluxes_batch = fluxes[start:end]

        # (batch_size, height, width)
        dx = xx[np.newaxis, :, :] - sx[:, np.newaxis, np.newaxis]
        dy = yy[np.newaxis, :, :] - sy[:, np.newaxis, np.newaxis]
        sigma = 1.0
        psf = fluxes_batch[:, np.newaxis, np.newaxis] * np.exp(
            -(dx ** 2 + dy ** 2) / (2 * sigma ** 2)
        )
        img += psf.sum(axis=0)

    # Clip negative values
    img = np.maximum(img, 0)

    # Convert to uint16 for saving
    img_uint = np.clip(img, 0, 65535).astype(np.uint16)

    # Save as TIFF (supports 16-bit)
    output_path = Path(output_path)
    if not output_path.suffix.lower() in ('.tif', '.tiff'):
        output_path = output_path.with_suffix('.tif')
    output_path.parent.mkdir(parents=True, exist_ok=True)

    _save_image(img_uint, output_path)

    print(f"✓ Fake image written: {output_path} ({width}x{height}, {n_stars} stars)")
    return output_path


def generate_fake_fits_pleiades(
    output_path: str = "fake_fits/pleiades.fits",
) -> Path:
    """Generate a fake Pleiades cluster image."""
    return generate_fake_fits(
        output_path=output_path,
        width=1024,
        height=1024,
        description="Simulated Pleiades cluster field",
        ra_center=74.49,
        dec_center=23.88,
        scale_arcsec_px=0.2,
        n_stars=300,
        background_noise=50.0,
    )


def generate_fake_fits_deep_field(
    output_path: str = "fake_fits/deep_field.fits",
) -> Path:
    """Generate a deep field simulation (many faint stars)."""
    return generate_fake_fits(
        output_path=output_path,
        width=2048,
        height=2048,
        description="Simulated deep field with many faint stars",
        ra_center=130.0,
        dec_center=0.0,
        scale_arcsec_px=0.05,
        n_stars=500,
        background_noise=50.0,
    )


if __name__ == "__main__":
    generate_fake_fits()
    generate_fake_fits_pleiades()
    generate_fake_fits_deep_field()