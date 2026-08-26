"""
Astrometry module for indigo_devices.

Submodules:
  - fake_fits.py          : Fake image generation for testing
  - useAstrometryController.js : Vue 3 composable (JavaScript)
  - routes.py             : FastAPI routes for the astrometry API
"""

from .fake_fits import generate_fake_fits

__all__ = [
    "generate_fake_fits",
]
