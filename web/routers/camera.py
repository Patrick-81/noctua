"""Camera and plate solver routes."""

import asyncio
import base64
import os
from datetime import datetime
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/camera")
    async def get_camera():
        c = server.registry.get_camera()
        return SanitizedJSONResponse(c.state_dict() if c else None)

    @app.get("/api/cameras")
    async def get_cameras():
        cameras = server.registry.get_all_cameras()
        return [{"name": c.name, "connected": c.connected, "is_ready": c.is_ready} for c in cameras]

    @app.post("/api/camera/expose")
    async def camera_expose(body: dict):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        if not c.is_ready:
            return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}
        await c.expose(body["duration"], body.get("frame_type", "LIGHT"))
        return {"ok": True}

    @app.post("/api/camera/abort")
    async def camera_abort(body: dict = {}):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        await c.abort()
        return {"ok": True}

    @app.post("/api/camera/save")
    async def camera_save(body: dict):
        """Save the last captured image to a directory."""
        save_dir = body.get("dir", "")
        if not save_dir:
            return {"error": "no directory specified"}
        # Expand ~ and create dir if needed
        save_dir = os.path.expanduser(save_dir)
        os.makedirs(save_dir, exist_ok=True)
        # Build filename from timestamp + filter
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filter_name = (body.get("filter") or "").strip()
        if filter_name:
            filename = f"capture_{filter_name}_{ts}.fits"
        else:
            filename = f"capture_{ts}.fits"
        filepath = os.path.join(save_dir, filename)
        # Get last image data from the camera
        c = server.registry.get_camera()
        if not c:
            return {"error": "no camera"}
        # We need the raw image data — check if we can get it from the client
        # The image was already sent to WS clients, we need to re-fetch or store it
        # For now, we'll store the last image in the server
        if not hasattr(server, '_last_image_data') or not server._last_image_data:
            return {"error": "no image data available — capture first"}
        with open(filepath, "wb") as f:
            f.write(server._last_image_data)
        log.info("Image saved: %s (%d bytes)", filepath, len(server._last_image_data))
        return {"ok": True, "path": filepath, "size": len(server._last_image_data)}

    @app.post("/api/camera/temperature")
    async def camera_temperature(body: dict):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        await c.set_temperature(body["target"])
        return {"ok": True}

    # ── Ideal exposure ───────────────────────────────────────

    @app.get("/api/camera/exposure/recommend")
    async def camera_exposure_recommend(device: str = ""):
        """Recommend an ideal exposure from the last captured image."""
        from indigo.devices.exposure import estimate_exposure, estimate_exposure_multi
        params = server.exposure_cfg or {}
        frames = server._last_exposure_frames
        if len(frames) >= 2:
            # Re-run the multi-shot fit from the frames saved by /estimate.
            try:
                return SanitizedJSONResponse(estimate_exposure_multi(frames, params))
            except Exception as e:
                log.error("Exposure estimate error: %s", e)
                return {"ok": False, "error": str(e)}
        img = server._camera_images.get(device, server._last_image_data) if device else server._last_image_data
        if not img:
            return {"ok": False, "error": "no image captured yet — take a test exposure first"}
        # Use the test duration actually measured by estimate, falling back to
        # the configured default (or 10 s) when the image came from elsewhere.
        test_duration = server._last_exposure_test_s or float(params.get("test_duration", 10.0))
        try:
            result = estimate_exposure(img, test_duration, params)
            return SanitizedJSONResponse(result)
        except Exception as e:
            log.error("Exposure estimate error: %s", e)
            return {"ok": False, "error": str(e)}

    @app.post("/api/camera/exposure/estimate")
    async def camera_exposure_estimate(body: dict = {}):
        """Take one or more test exposures, then recommend the ideal exposure.

        body = {
            "device": "cam",
            "shots": 1 | 3,                 # default: config exposure.shots (1)
            "test_min": 5.0,                # shortest test exposure (s)
            "test_max": 30.0,               # longest test exposure (s)
            "test_mid": 12.0,               # optional intermediate (shots=3)
        }

        shots=1 : single frame (assumes bias = BZERO).
        shots=3 : linear fit ADU(t) = bias + m*t — bias-independent, detects
                  the saturation knee and validates linearity/transparency.
        """
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        if not c.is_ready:
            return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}

        params = dict(server.exposure_cfg or {})
        shots = int(body.get("shots", params.get("shots", 1)))
        if shots not in (1, 2, 3):
            shots = 1

        default_min = float(params.get("test_min", params.get("test_duration", 10.0)))
        default_max = float(params.get("test_max", 30.0))
        default_mid = float(params.get("test_mid") or 0)

        min_t = max(float(body.get("test_min", default_min)), 0.1)
        max_t = max(float(body.get("test_max", default_max)), min_t)
        if shots < 3:
            max_t = max(min_t, max_t)
        mid_t = None
        if shots == 3:
            if body.get("test_mid") is not None:
                mid_t = max(float(body["test_mid"]), 0.1, min_t)
            elif default_mid > 0:
                mid_t = max(default_mid, min_t + 0.1)
            else:
                mid_t = (min_t + max_t) / 2.0
            mid_t = min(mid_t, max_t)

        durations = [min_t, max_t] if shots == 2 else ([min_t] if shots == 1 else [min_t, mid_t, max_t])

        from indigo.devices.exposure import estimate_exposure, estimate_exposure_multi

        base = server._camera_images.get(c.name, b"")
        images = []
        for d in durations:
            await c.expose(d, "LIGHT")
            # Wait for the exposure to finish, then for a new image blob.
            deadline = asyncio.get_running_loop().time() + d + 30.0
            while asyncio.get_running_loop().time() < deadline and c.exposing:
                await asyncio.sleep(0.1)
            while asyncio.get_running_loop().time() < deadline:
                cur = server._camera_images.get(c.name, b"")
                if cur and cur != base:
                    break
                await asyncio.sleep(0.1)
            img = server._camera_images.get(c.name, b"")
            if not img:
                return {"ok": False, "error": "test exposure produced no image"}
            images.append(img)
            base = img

        server._last_exposure_test_s = durations[-1]
        server._last_exposure_frames = list(zip(durations, images))
        try:
            if len(images) >= 2:
                frames = list(zip(durations, images))
                result = estimate_exposure_multi(frames, params)
            else:
                result = estimate_exposure(images[0], durations[0], params)
            return SanitizedJSONResponse(result)
        except Exception as e:
            log.error("Exposure estimate error: %s", e)
            return {"ok": False, "error": str(e)}

    # ── Plate Solver ─────────────────────────────────────────

    @app.get("/api/solver/status")
    async def solver_status():
        return server.solver.status()

    @app.post("/api/solver/catalogs")
    async def solver_load_catalogs(body: dict = {}):
        catalog_dir = body.get("catalog_dir")
        result = server.solver.load_catalogs(catalog_dir)
        return result

    @app.post("/api/solver/solve")
    async def solver_solve(body: dict):
        """Solve a plate from the last captured image or uploaded data.

        body = {
            "mode": "hinted" | "blind" | "last_image",
            "ra_hint": 100.5,        # degrees (hinted mode)
            "dec_hint": 35.2,        # degrees (hinted mode)
            "scale_hint": 2.5,       # arcsec/pixel (hinted mode)
            "min_scale": 0.5,        # arcsec/pixel (blind mode)
            "max_scale": 15.0,       # arcsec/pixel (blind mode)
            "device": "camera_name", # optional, for auto-hint from mount
        }
        """
        if server.solver.is_solving:
            return {"error": "Already solving — wait for current solve to finish"}

        mode = body.get("mode", "hinted")

        # Get image data
        image_data = None
        fmt = "fits"

        if mode == "last_image":
            # Use the last captured image
            if not server._last_image_data:
                return {"error": "No image captured yet — capture first"}
            image_data = server._last_image_data
            fmt = "fits"
        elif "image_data" in body:
            # Direct image upload (base64)
            image_data = base64.b64decode(body["image_data"])
            fmt = body.get("format", "fits")
        else:
            return {"error": "Provide 'mode': 'last_image' or 'image_data'"}

        # Get hints
        ra_hint = body.get("ra_hint")
        dec_hint = body.get("dec_hint")
        scale_hint = body.get("scale_hint")

        # Auto-hint from FITS WCS (highest priority for test images)
        if (ra_hint is None or dec_hint is None or scale_hint is None) and image_data:
            try:
                wcs = server.solver._extract_wcs(image_data)
                if wcs:
                    if ra_hint is None and wcs.get("crval1") is not None:
                        ra_hint = wcs["crval1"]
                    if dec_hint is None and wcs.get("crval2") is not None:
                        dec_hint = wcs["crval2"]
                    if scale_hint is None and wcs.get("cdelt1") is not None:
                        scale_hint = abs(wcs["cdelt1"]) * 3600  # deg/pix → arcsec/pix
                    log.info("Auto-hint from FITS WCS: RA=%.2f DEC=%.2f scale=%.2f",
                             ra_hint or 0, dec_hint or 0, scale_hint or 0)
            except Exception as e:
                log.debug("FITS WCS extraction failed: %s", e)

        # Auto-hint from mount (if not yet provided)
        if ra_hint is None or dec_hint is None:
            m = server.registry.get_mount()
            if m and m.ra_hours is not None:
                ra_hint = ra_hint if ra_hint is not None else m.ra_hours * 15  # hours → degrees
                dec_hint = dec_hint if dec_hint is not None else m.dec_deg
                log.debug("Auto-hint from mount: RA=%.2f DEC=%.2f", ra_hint, dec_hint)

        # Auto-scale from camera (only if still no scale)
        if scale_hint is None:
            c = server.registry.get_camera(body.get("device"))
            if c and c.pixel_size_um and c.focal_length_mm:
                scale_hint = (c.pixel_size_um / 1000) / (c.focal_length_mm / 1000) * 206.265
                log.debug("Auto-scale from camera: %.2f arcsec/px", scale_hint)

        # Run solve in a thread (Seiza releases GIL but we want non-blocking)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: server.solver.solve_image(
                image_data,
                fmt=fmt,
                ra_hint=ra_hint,
                dec_hint=dec_hint,
                scale_hint=scale_hint,
                min_scale=body.get("min_scale", 0.5),
                max_scale=body.get("max_scale", 15.0),
                sigma=body.get("sigma", 2.0),
            )
        )

        # Broadcast result via WebSocket
        if result.get("ok"):
            await server._broadcast_solver_result(result)

        return result
