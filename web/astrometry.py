"""
Astrometry API routes — plate solving + polar alignment.

Endpoints:
  GET  /api/astrometrie/status  — service health
  POST /api/astrometrie/solve   — plate solve
  POST /api/astrometrie/generate_fake_image  — generate test image
"""

import logging
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from indigo.plate_solve import solve_image
from src.astrometry.fake_fits import generate_fake_fits

log = logging.getLogger("indigo.astrometry")

router = APIRouter()


class SolveRequest(BaseModel):
    mode: str = "mount"
    image: str = ""
    threshold: int = 100
    ra_deg: float | None = None
    dec_deg: float | None = None


class FakeImageRequest(BaseModel):
    name: str = "Orion Nebula (fake)"
    width: int = 1920
    height: int = 1080


@router.get("/api/astrometrie/status")
async def status():
    return {"connected": True, "service": "indigo_astrometry"}


@router.post("/api/astrometrie/solve")
async def solve_endpoint(request: SolveRequest):
    """Solve an image using seiza (or simulation fallback)."""
    log.info("Solve request: mode=%s image=%s threshold=%d",
             request.mode, request.image, request.threshold)

    # If no image or image doesn't exist, generate a fake one for testing
    if not request.image or not Path(request.image).exists():
        log.info("Image not found, generating fake image for testing")
        try:
            generate_fake_fits(
                output_path="fake_fits/test_solve.fits",
                width=1920,
                height=1080,
                description=f"Test image for solve (mode={request.mode})",
                ra_center=180.0,
                dec_center=30.0,
                scale_arcsec_px=0.25,
            )
            request.image = "fake_fits/test_solve.tif"
        except Exception as exc:
            return {"ok": False, "error": f"Could not generate test image: {exc}", "stars_found": 0}

    if not request.image:
        return {"ok": False, "error": "No image specified", "stars_found": 0}

    try:
        result = solve_image(
            path=request.image,
            ra_deg=request.ra_deg,
            dec_deg=request.dec_deg,
            scale_arcsec_px=0.25,
        )

        if not result.get("ok"):
            return {
                "ok": False,
                "error": result.get("error", "Unknown error"),
                "stars_found": result.get("stars_found", 0),
            }

        # Convert WCS header to string values for JSON serialization
        if "wcs_header" in result:
            result["wcs_header"] = {
                k: str(v) for k, v in result["wcs_header"].items()
            }

        return {
            "ok": True,
            "center_ra_deg": result["center_ra_deg"],
            "center_dec_deg": result["center_dec_deg"],
            "scale_arcsec_px": result["scale_arcsec_px"],
            "rotation_deg": result["rotation_deg"],
            "matched_stars": result["matched_stars"],
            "rms_arcsec": result["rms_arcsec"],
            "wcs_header": result["wcs_header"],
            "footprint_corners": result.get("footprint_corners", []),
        }

    except Exception as exc:
        log.exception("Plate solving failed")
        return {
            "ok": False,
            "error": f"Plate solving failed: {exc}",
            "stars_found": 0,
        }


@router.post("/api/astrometrie/generate_fake_image")
async def generate_fake_endpoint(request: FakeImageRequest):
    """Generate a fake FITS image for testing."""
    try:
        img_config = {
            "name": "Orion Nebula (fake)",
            "path": "fake_fits/orion_nebula.fits",
            "width": request.width,
            "height": request.height,
            "description": f"Simulated Orion Nebula field with ~500 stars",
        }
        if request.name != img_config["name"]:
            img_config["name"] = request.name
            img_config["path"] = f"fake_fits/{request.name}.fits"

        output_path = generate_fake_fits(
            output_path=img_config["path"],
            width=img_config["width"],
            height=img_config["height"],
            description=img_config.get("description", ""),
            ra_center=180.0,
            dec_center=30.0,
            scale_arcsec_px=0.25,
        )

        return {
            "ok": True,
            "path": str(output_path),
            "description": f"Fake image generated: {output_path}",
        }
    except Exception as exc:
        return {"ok": False, "error": f"Could not generate image: {exc}"}


@router.get("/api/astrometrie/fake_images")
async def fake_images_list():
    """List available fake images for testing."""
    fake_dir = Path("fake_fits")
    images = []
    if fake_dir.exists():
        for f in sorted(fake_dir.glob("*.tif")):
            images.append({
                "name": f.stem,
                "path": str(f),
            })
    return {"images": images}
