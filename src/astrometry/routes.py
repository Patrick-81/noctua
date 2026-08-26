"""
FastAPI routes for the astrometry backend.

Provides:
  - GET  /api/astrometrie/status  — health check / connection status
  - POST /api/astrometrie/solve   — plate solving endpoint
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pathlib import Path
import logging

from indigo.plate_solve import solve_image
from .fake_fits import generate_fake_fits

log = logging.getLogger("indigo_astrometry")

app = FastAPI(title="Indigo Astrometry API")


# ── Request model ───────────────────────────────────────────────────

class SolveRequest(BaseModel):
    mode: str = "mount"
    image: str = ""
    threshold: int = 100
    ra_deg: float | None = None
    dec_deg: float | None = None


# ── Routes ──────────────────────────────────────────────────────────

@app.get("/api/astrometrie/status")
def status():
    """Health check — returns connection status."""
    return {"connected": True, "service": "indigo_astrometry"}


@app.post("/api/astrometrie/solve")
async def solve_endpoint(request: SolveRequest):
    """
    Solve an image using seiza.

    Accepts:
      - mode: 'mount' (with approximate RA/DEC) or 'blind'
      - image: path to FITS image or 'capture' for live
      - threshold: star detection threshold
      - ra_deg: approximate RA in degrees (mount mode)
      - dec_deg: approximate DEC in degrees (mount mode)
    """
    log.info("Solve request: mode=%s image=%s threshold=%d",
             request.mode, request.image, request.threshold)

    # For demo/testing: generate a fake image if no real image is provided
    if request.image and not Path(request.image).exists():
        log.info("Image not found, generating fake image for testing")
        try:
            from .fake_fits import generate_fake_fits
            generate_fake_fits(
                output_path="fake_fits/test_solve.fits",
                width=1920,
                height=1080,
                description=f"Test image for solve (mode={request.mode})",
                ra_center=180.0,
                dec_center=30.0,
                scale_arcsec_px=0.25,
            )
            # Generator saves as .tif automatically
            request.image = "fake_fits/test_solve.tif"
        except Exception as exc:
            return {
                "ok": False,
                "error": f"Could not generate test image: {exc}",
                "stars_found": 0,
            }

    if not request.image:
        return {
            "ok": False,
            "error": "No image specified",
            "stars_found": 0,
        }

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


# ── Standalone server ──────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
