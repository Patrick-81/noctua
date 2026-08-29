"""
server.py — FastAPI web server for INDIGO devices.

Provides:
  - Application wiring: device registry, solver, sequence, stacking engines
  - WebSocket broadcasting helpers (state, images, logs, stacking, sequence)
  - Static file serving

REST routes live in web/routers/*.py — each module exposes ``register(app, server)``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .weblog import handler as weblog_handler

if TYPE_CHECKING:
    from ..registry import DeviceRegistry

from indigo.profiles import ProfileStore

from .routers.common import _mount_flip_status, _sanitize

log = logging.getLogger("indigo.web")

STATIC_DIR = Path(__file__).parent / "static"


class WebServer:
    def __init__(self, registry: DeviceRegistry, site_config: dict | None = None,
                 config_path: Path | None = None, ui_path: Path | None = None,
                 profiles_path: Path | None = None, telescope_config: dict | None = None,
                 sequence_config: dict | None = None, exposure_config: dict | None = None,
                 templates_path: Path | None = None, masters_config: dict | None = None):
        self.registry = registry
        self.site = site_config or {}
        self.telescope = dict(telescope_config or {})
        self.sequence_cfg = dict(sequence_config or {})
        self.exposure_cfg = dict(exposure_config or {})
        # Defaults for meridian flip
        self.telescope.setdefault("flip_enabled", False)
        self.telescope.setdefault("hour_angle_margin", 0.2)
        self.telescope.setdefault("min_altitude", 0.0)
        self.telescope.setdefault("flip_slew_rate", "Centering")
        self.telescope.setdefault("recenter_after_flip", True)
        # State: whether the automatic flip has already fired for the current
        # west-of-meridian pass (avoids re-flipping on every frame post-meridian).
        # Re-armed once the mount goes back east of the meridian.
        self._meridian_flipped = False
        self.config_path = config_path
        self.ui_path = ui_path
        self.profiles = ProfileStore(profiles_path)
        # Sequence templates (Lot C3) : défaut = à côté du fichier de config.
        from indigo.devices.templates import SequenceTemplateStore
        if templates_path is None:
            templates_path = (config_path.parent / "sequence_templates.yaml"
                              if config_path else None)
        self.template_store = SequenceTemplateStore(templates_path)
        # Master calibration library (Lot C1) : racine par défaut = save_dir
        from indigo.devices.masters import MasterLibrary
        self.masters_cfg = dict(masters_config or {})
        masters_root = self.masters_cfg.get("dir") or self.sequence_cfg.get("save_dir", "")
        self.masters = MasterLibrary(masters_root)
        self.app = FastAPI(title="INDIGO Devices")
        self.app.add_middleware(BaseHTTPMiddleware, dispatch=self._no_cache_middleware)
        self._ws_clients: list[WebSocket] = []
        self._last_image_data: bytes = b""
        self._camera_images: dict[str, bytes] = {}  # device_name → last image bytes
        # Duration of the last test exposure used by /api/camera/exposure/estimate
        # (so GET /recommend can extrapolate without re-taking a frame).
        self._last_exposure_test_s: float = 0.0
        # Frames (duration, fits) of the last exposure-measure pass,
        # kept so GET /recommend can re-run the multi-shot fit when applicable.
        self._last_exposure_frames: list[tuple[float, bytes]] = []

        # Plate solver (lazy import to avoid circular dependency)
        from indigo.devices.solver import Solver
        self.solver = Solver()

        from indigo.devices.sequence import SequenceRunner
        self.sequence = SequenceRunner()

        # Trigger Manager (Lot A2) : hooks d'événements de séquence → actions
        from indigo.devices.triggers import TriggerManager
        self.triggers = TriggerManager(self.sequence_cfg.get("triggers"))
        self.triggers.bind({
            "mount": (lambda: self.registry.get_mount()),
        })

        # Refocus automatique (Lot B3) : politique intervalle/altitude + run serveur
        from indigo.devices.refocus import RefocusPolicy
        self.refocus_policy = RefocusPolicy(**self.sequence_cfg.get("refocus", {}) or {"enabled": False})

        # Live stacking engine (Seiza LiveStacker) — device-agnostic pile
        from indigo.devices.live_stack import LiveStackEngine
        self.stacking = LiveStackEngine(options=self.sequence_cfg.get("stack", {}))
        # Auto-stacking session state (short-exposure loop feeding the engine)
        self._stacking_session: asyncio.Task | None = None
        self._stacking_stop = False
        self._stacking_master_path = None  # master auto-sauvé à la cible (sinon None)

        # Guide / calibration / autofocus state machines (used by web/routers)
        from indigo.devices.autofocus import AutoFocus
        from indigo.devices.guide import Guide
        from indigo.devices.guide_calibration import GuideCalibration
        self._autofocus = AutoFocus()
        self._guide = Guide()
        self._guide_cal = GuideCalibration()
        # Flat-field capture wizard
        from indigo.devices.flat_wizard import FlatWizard
        self._flat_wizard = FlatWizard()
        self._flat_filter: str | None = None
        self._flat_binning: str | None = None
        # Pointing error model (interpolated corrections)
        from indigo.devices.pointing import PointingModel
        self._pointing = PointingModel()

        # Wire up state broadcasting
        registry.on_state_update = self._broadcast_state

        # Wire image callbacks as soon as a camera is discovered (no 2 s wait)
        registry.on_device_added = self._on_camera_discovered

        # Install weblog handler on the root logger
        weblog_handler.setLevel(logging.DEBUG)
        logging.getLogger().addHandler(weblog_handler)

        self._setup_routes()

    async def _enable_blob_upload(self):
        """Wait for cameras to appear, request BLOB properties, enable BLOB delivery."""
        blob_requested: set[str] = set()      # cameras we sent getProperties for
        blob_enabled: set[str] = set()         # cameras we sent <enableBLOB> for (property-level)
        blob_enabled_dev: set[str] = set()     # cameras we sent device-level <enableBLOB> for
        format_set: set[str] = set()           # cameras we set CCD_IMAGE_FORMAT for
        retry_count: dict[str, int] = {}       # per-camera getProperties retry count

        while True:
            await asyncio.sleep(2)
            if not self.registry.client.connected:
                blob_requested.clear()
                blob_enabled.clear()
                blob_enabled_dev.clear()
                format_set.clear()
                retry_count.clear()
                continue

            for name, dev in self.registry.all_devices().items():
                if not hasattr(dev, 'on_image'):
                    continue

                # Wire the image callback if not already done
                if dev.on_image is None:
                    dev.on_image = self._make_image_callback(name)
                    log.debug("Wired image callback for camera: %s", name)

                # Step 1: Request CCD_IMAGE blob property definition (retry up to 5 times)
                retries = retry_count.get(name, 0)
                if name not in blob_requested or (not dev.blob_prop_name and retries < 5):
                    if name not in blob_requested:
                        blob_requested.add(name)
                    retry_count[name] = retries + 1
                    await self.registry.client.send_get_properties(
                        device=name, prop_name="CCD_IMAGE")

                # Step 2a: Send property-level <enableBLOB> if we know the blob prop name
                if dev.blob_prop_name and name not in blob_enabled:
                    blob_enabled.add(name)
                    await self.registry.client.send_enable_blob(
                        device=name, prop_name=dev.blob_prop_name, mode="Also")

                # Step 2b: Send device-level <enableBLOB> as fallback
                if name not in blob_enabled_dev:
                    blob_enabled_dev.add(name)
                    await self.registry.client.send_enable_blob(
                        device=name, mode="Also")

                # Step 3: Set CCD_IMAGE_FORMAT to FITS
                if name not in format_set:
                    fmt_pv = dev.get_prop("CCD_IMAGE_FORMAT")
                    if fmt_pv:
                        format_set.add(name)
                        fits_on = any(
                            item.name == "FITS" and item.value
                            for item in fmt_pv.items
                        )
                        if not fits_on:
                            items = [
                                {"name": item.name,
                                 "value": item.name == "FITS"}
                                for item in fmt_pv.items
                            ]
                            await dev.send_switch("CCD_IMAGE_FORMAT", items)

    def _on_camera_discovered(self, dev):
        """Wire the image callback as soon as a camera device appears."""
        if hasattr(dev, "on_image") and dev.on_image is None:
            dev.on_image = self._make_image_callback(dev.name)
            log.debug("Wired image callback for camera: %s", dev.name)

    @staticmethod
    async def _no_cache_middleware(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/", "/app.js")):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    def _setup_routes(self) -> None:
        app = self.app

        @app.on_event("startup")
        async def startup():
            weblog_handler.set_loop(asyncio.get_event_loop())
            asyncio.create_task(self._enable_blob_upload())
            # Load plate solver catalogs
            cat_result = self.solver.load_catalogs()
            if cat_result.get("ok"):
                log.info("Solver catalogs loaded: %s", cat_result)
            else:
                log.warning("Solver catalogs: %s", cat_result.get("error", "unknown error"))
            log.info("Web server started")

        # ── REST API + WebSocket + test endpoints ────────────────
        # Routes moved to web/routers/*.py — each exposes register(app, server).
        from .routers import (camera, config, focuser, guide, hardware,
                              masters, mount, pointing, sequence, stacking,
                              triggers, visibility, ws_test)
        for router in (hardware, config, mount, camera, focuser, guide,
                       sequence, stacking, masters, pointing, triggers,
                       visibility, ws_test):
            router.register(app, self)

        # ── Static files (HTML/CSS/JS) ──────────────────────────

        CATALOGS_DIR = Path(__file__).parent.parent / "public" / "catalogs"
        if CATALOGS_DIR.exists():
            app.mount("/catalogs", StaticFiles(directory=str(CATALOGS_DIR)),
                      name="catalogs")

        CELESTIAL_DIR = Path(__file__).parent.parent / "public" / "celestial-data"
        if CELESTIAL_DIR.exists():
            app.mount("/celestial-data", StaticFiles(directory=str(CELESTIAL_DIR)),
                      name="celestial-data")

        if STATIC_DIR.exists():
            app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True),
                      name="static")

    async def _handle_ws_command(self, msg: dict) -> None:
        """Handle a command received via WebSocket."""
        cmd = msg.get("cmd")
        if cmd == "mount/slew":
            m = self.registry.get_mount()
            if m:
                await m.slew_to(msg["ra_hours"], msg["dec_deg"])
        elif cmd == "mount/abort":
            m = self.registry.get_mount()
            if m:
                await m.abort()
        elif cmd == "mount/park":
            m = self.registry.get_mount()
            if m:
                await m.park()
        elif cmd == "mount/unpark":
            m = self.registry.get_mount()
            if m:
                await m.unpark()
        elif cmd == "mount/home":
            m = self.registry.get_mount()
            if m:
                await m.home()
        elif cmd == "camera/expose":
            c = self.registry.get_camera(msg.get("device"))
            if c:
                await c.expose(msg["duration"], msg.get("frame_type", "LIGHT"))

    def _mount_flip_status(self, state: dict) -> dict:
        """Augment a mount state dict with meridian flip figures."""
        return _mount_flip_status(state, self.site, self.telescope)

    async def _do_meridian_flip(self) -> dict:
        """Execute a manual meridian flip sequence.

        Shared by the ``/api/mount/flip`` route and the sequence auto-flip
        hook.  Returns a dict with ``ok`` and, when ok, the completed phases.
        """
        m = self.registry.get_mount()
        if not m:
            return {"ok": False, "error": "no mount"}
        if not m.connected:
            return {"ok": False, "error": "mount not connected"}
        phases = []

        # 1. Stop any in-progress camera exposure cleanly
        for cam in self.registry._devices.values():
            if getattr(cam, "DEVICE_TYPE", None) == "camera" and getattr(cam, "is_ready", False):
                try:
                    await cam.abort()
                    phases.append(f"capture abort ({cam.name})")
                except Exception as e:  # noqa: BLE001
                    log.warning("flip: cam abort failed for %s: %s", cam.name, e)

        # 2. Stop guiding if active
        try:
            if hasattr(self, "_guide") and hasattr(self._guide, "stop"):
                st = self._guide.status()
                if str(st.get("state", "")).lower() in ("guiding", "starting"):
                    self._guide.stop()
                    phases.append("guiding stopped")
        except Exception as e:  # noqa: BLE001
            log.warning("flip: guide stop failed: %s", e)

        # 3. Capture current target before aborting the slew
        ra = m.ra_hours
        dec = m.dec_deg
        if ra is None or dec is None:
            return {"ok": False, "error": "mount has no coordinates to flip back to",
                    "phases": phases}

        # 4. Abort current motion, then slew to the same target (the flip itself)
        try:
            await m.abort()
            phases.append("motion aborted")
        except Exception as e:  # noqa: BLE001
            log.warning("flip: abort failed: %s", e)
        await asyncio.sleep(1.0)

        rate = self.telescope.get("flip_slew_rate", "Centering")
        try:
            await m.set_slew_rate(rate)
        except Exception:  # noqa: BLE001
            pass

        await m.slew_to(ra, dec)
        phases.append(f"slew to RA={ra:.4f}h DEC={dec:.4f}°")

        # 5. Recenter via plate solve on the same target (blocks until the
        #    mount is stable again, so the sequence can resume safely).
        recenter = {"done": False, "passes": 0, "error": None}
        if self.telescope.get("recenter_after_flip", True):
            recenter = await self._recenter_by_solve(ra, dec)
            if recenter.get("done"):
                phases.append(
                    f"recenter (solve) OK in {recenter.get('passes', 0)} pass(es)")
            else:
                phases.append(
                    f"recenter (solve) {recenter.get('error') or 'failed'}")
        _recenter = recenter

        # Mark that a flip already fired for this west-of-meridian pass so the
        # sequence hook does not re-flip on every subsequent frame.
        self._meridian_flipped = True

        return {
            "ok": True,
            "flipped": True,
            "phases": phases,
            "target": {"ra_hours": ra, "dec_deg": dec},
            "recenter": {
                "done": _recenter.get("done", False),
                "passes": _recenter.get("passes", 0),
                "error": _recenter.get("error"),
            },
        }

    def _camera_scale_hint(self, camera) -> float | None:
        """Pixel scale (arcsec/px) derived from the camera, or None."""
        try:
            if (camera and camera.pixel_size_um and camera.focal_length_mm):
                return (camera.pixel_size_um / 1000.0) / (camera.focal_length_mm / 1000.0) * 206.265
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _recenter_by_solve(self, ra_hours: float, dec_deg: float,
                                 max_passes: int = 3, settle_s: float = 2.0,
                                 tolerance_arcmin: float = 1.0) -> dict:
        """Iteratively re-center the mount on ``(ra_hours, dec_deg)``.

        After a meridian flip the tube is on the other side of the pier, so the
        pointing can drift.  This takes a short exposure, plate-solves it, nudges
        the mount by the measured error and iterates until the target is centered
        (or a max number of passes is reached).  Every successful solve also feeds
        the pointing model so future slews improve.

        Returns ``{"done", "passes", "error", "phases"}``.
        """
        import asyncio as _aio
        loop = _aio.get_event_loop()
        m = self.registry.get_mount()
        cam = self.registry.get_camera()
        if not m or not m.connected:
            return {"done": False, "passes": 0, "error": "no mount"}
        if not cam or not cam.is_ready:
            return {"done": False, "passes": 0, "error": "no ready camera"}
        scale_hint = self._camera_scale_hint(cam)
        if scale_hint is None:
            return {"done": False, "passes": 0, "error": "no plate scale hint"}

        ra_deg_target = (float(ra_hours) * 15.0) % 360.0
        dec_target = float(dec_deg)
        phases: list[str] = []
        exp_s = float(self.exposure_cfg.get("recenter_duration", 2.0))

        for i in range(int(max_passes)):
            await _aio.sleep(settle_s)
            base = self._camera_images.get(cam.name, b"")
            try:
                await cam.expose(exp_s, "LIGHT")
                deadline = loop.time() + 35.0
                while loop.time() < deadline and cam.exposing:
                    await _aio.sleep(0.1)
                while loop.time() < deadline:
                    cur = self._camera_images.get(cam.name, b"")
                    if cur and cur != base:
                        break
                    await _aio.sleep(0.1)
                img = self._camera_images.get(cam.name, b"")
            except Exception as e:  # noqa: BLE001
                return {"done": False, "passes": i, "error": f"expose failed: {e}",
                        "phases": phases}
            if not img:
                return {"done": False, "passes": i, "error": "no image from camera",
                        "phases": phases}

            result = await loop.run_in_executor(
                None,
                lambda: self.solver.solve_image(
                    img, fmt="fits",
                    ra_hint=ra_deg_target, dec_hint=dec_target,
                    scale_hint=scale_hint,
                ),
            )
            if not result.get("ok"):
                # Can't plate-solve (dark/blurry/few stars). Re-trying would
                # only waste time — stop best-effort and let the sequence resume.
                phases.append(f"pass {i + 1}: solve failed ({result.get('error', '?')})")
                return {"done": False, "passes": i + 1,
                        "error": result.get("error") or "solve failed",
                        "phases": phases}

            solved_ra = result["ra"]
            solved_dec = result["dec"]

            # RA error across the wrap (deg).
            dra = solved_ra - ra_deg_target
            if dra > 180.0:
                dra -= 360.0
            elif dra < -180.0:
                dra += 360.0
            ddec = solved_dec - dec_target
            dist_arcmin = (abs(dra) ** 2 + abs(ddec) ** 2) ** 0.5 * 60.0

            # Feed the pointing model.
            try:
                correction_ra = -dra
                if correction_ra > 180.0:
                    correction_ra -= 360.0
                elif correction_ra < -180.0:
                    correction_ra += 360.0
                self._pointing.add_sample(ra_deg_target, dec_target,
                                          correction_ra, -ddec)
            except Exception:  # noqa: BLE001
                pass

            if dist_arcmin <= tolerance_arcmin:
                phases.append(f"pass {i + 1}: centered ({dist_arcmin:.2f}')")
                return {"done": True, "passes": i + 1, "error": None,
                        "phases": phases, "final_error_arcmin": round(dist_arcmin, 3)}

            # Nudge: slew to the corrected position (apply the error in reverse).
            nudge_ra = (ra_deg_target - dra) % 360.0
            nudge_dec = max(-90.0, min(90.0, dec_target - ddec))
            try:
                await m.set_slew_rate(self.telescope.get("flip_slew_rate", "Centering"))
            except Exception:  # noqa: BLE001
                pass
            try:
                await m.slew_to(nudge_ra / 15.0, nudge_dec)
            except Exception as e:  # noqa: BLE001
                return {"done": False, "passes": i + 1, "error": f"slew failed: {e}",
                        "phases": phases}
            phases.append(
                f"pass {i + 1}: error {dist_arcmin:.1f}' → slew to "
                f"RA={nudge_ra / 15.0:.4f}h DEC={nudge_dec:.2f}°")

        return {"done": False, "passes": max_passes,
                "error": f"not centered after {max_passes} passes",
                "phases": phases}

    def _broadcast_state(self, state: dict) -> None:
        """Send state update to all connected WebSocket clients."""
        if not self._ws_clients:
            return
        for name, dev in list(state.items()):
            if dev.get("type") == "mount":
                state[name] = self._mount_flip_status(dev)
        payload = json.dumps(_sanitize({"type": "state", "devices": state}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    def _safe_remove_client(self, ws) -> None:
        try:
            self._ws_clients.remove(ws)
        except ValueError:
            pass

    def _make_image_callback(self, device_name: str):
        """Create an image callback that captures the device name."""
        def _cb(data: bytes, fmt: str, url: str = "") -> None:
            self._on_camera_image(device_name, data, fmt, url)
        return _cb

    def _on_camera_image(self, device_name: str, data: bytes, fmt: str, url: str = "") -> None:
        """Forward camera image to all WebSocket clients."""
        import base64
        if url:
            log.debug("Camera image URL from %s: %s", device_name, url)
            asyncio.ensure_future(self._fetch_and_broadcast(device_name, url, fmt))
        else:
            if not data:
                log.warning("Camera image from %s has ZERO bytes — skipping", device_name)
                return
            # Store last image for save endpoint
            self._last_image_data = data
            self._camera_images[device_name] = data
            if not self._ws_clients:
                return
            b64 = base64.b64encode(data).decode("ascii")
            payload = json.dumps({
                "type": "image",
                "device": device_name,
                "format": fmt,
                "data": b64,
            })
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    async def _fetch_and_broadcast(self, device_name: str, url: str, fmt: str) -> None:
        """Fetch a BLOB image from its URL and broadcast to WebSocket clients."""
        import aiohttp
        try:
            # The INDIGO server runs on the same host as the INDIGO TCP connection.
            # Only accept BLOB paths from the INDIGO server itself to avoid SSRF.
            allowed_host = self.registry.client._host
            allowed_port = 7624
            if url.startswith("/"):
                path = url
            elif url.startswith(f"http://{allowed_host}:{allowed_port}"):
                path = url[len(f"http://{allowed_host}:{allowed_port}"):]
                if not path.startswith("/"):
                    path = "/" + path
            else:
                log.error("Refusing BLOB fetch for disallowed URL: %s", url)
                return

            if ".." in path.split("/"):
                log.error("Refusing BLOB fetch with path traversal: %s", path)
                return
            fetch_url = f"http://{allowed_host}:{allowed_port}{path}"

            log.debug("Fetching BLOB from: %s", fetch_url)
            async with aiohttp.ClientSession() as session:
                async with session.get(fetch_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status != 200:
                        log.error("BLOB fetch failed: HTTP %d from %s", resp.status, fetch_url)
                        return
                    data = await resp.read()
                    log.debug("BLOB fetched: %d bytes from %s", len(data), fetch_url)
                    self._on_camera_image(device_name, data, fmt)
        except Exception as e:
            log.error("Failed to fetch BLOB from %s: %s", url, e)

    async def _broadcast_solver_result(self, result: dict) -> None:
        """Broadcast solver result to all WebSocket clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "solver_result", "result": result}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    async def _stacking_session_loop(self, duration: float, max_frames: int,
                                     session_dir: str, filter_name: str = "") -> None:
        """Auto-stacking loop: repeatedly capture short LIGHT poses, save each
        FITS under the livestack session dir, and push it into the engine.

        Runs until the caller stops it, or until ``max_frames`` accepted frames
        are stacked (max_frames == 0 → continuous).
        """
        import asyncio as _asyncio
        try:
            cam = self.registry.get_camera()
            if not cam:
                self._stacking_stop = True
                raise RuntimeError("no camera connected")
            if not cam.is_ready:
                self._stacking_stop = True
                raise RuntimeError(f"camera '{cam.name}' not ready")

            if filter_name:
                fw = self.registry.get_filterwheel()
                if fw:
                    await fw.set_slot(filter_name)

            frame_descr = {"duration": duration, "frame_type": "LIGHT",
                           "filter": filter_name, "count": 1, "delay": 0.0}
            idx = 0
            completed_with_target = False
            while not self._stacking_stop:
                st = self.stacking.status()
                if max_frames > 0 and st.get("complete"):
                    completed_with_target = True
                    break

                base = self._camera_images.get(cam.name, b"")
                t_obs = datetime.now(timezone.utc)
                await cam.expose(duration, "LIGHT")
                while cam.exposing and not self._stacking_stop:
                    await _asyncio.sleep(0.1)
                deadline = _asyncio.get_running_loop().time() + 30.0
                while _asyncio.get_running_loop().time() < deadline and not self._stacking_stop:
                    cur = self._camera_images.get(cam.name, b"")
                    if cur and cur != base:
                        break
                    await _asyncio.sleep(0.1)
                await _asyncio.sleep(0.2)

                idx += 1
                from datetime import datetime as _dt
                ts = _dt.now().strftime("%Y%m%d_%H%M%S")
                group = (filter_name or "light").replace("/", "_")
                path = os.path.join(session_dir, f"light_{group}_{idx:03d}_{ts}.fits")
                img = self._camera_images.get(cam.name, self._last_image_data)
                # Lot C4 : métadonnées normalisées dans l'entête FITS.
                from indigo.devices import fitsmeta
                site = self.site or {}
                meta = fitsmeta.frame_meta(
                    target=self.sequence_cfg.get("target", ""),
                    frame_type="LIGHT",
                    filter_name=filter_name,
                    exposure_sec=duration,
                    instrument=cam.name,
                    ccd_temp=cam.temperature,
                    set_temp=(cam.target_temp if cam.target_temp is not None
                              else cam.temperature),
                    pixel_size_um=cam.pixel_size_um,
                    binning_x=cam.binning_x,
                    binning_y=cam.binning_y,
                    gain=cam.gain,
                    offset=cam.offset,
                    focal_length_mm=cam.focal_length_mm,
                    telescope=(self.telescope or {}).get("name", ""),
                    sitelat=site.get("latitude"),
                    sitelong=site.get("longitude"),
                    sitelev=site.get("elevation"),
                    date_obs=t_obs,
                )
                img = await _asyncio.to_thread(fitsmeta.inject_meta, img, meta)
                with open(path, "wb") as f:
                    f.write(img)

                res = await _asyncio.to_thread(self.stacking.push_fits, img)
                logging.getLogger(__name__).debug(
                    f"stacking session frame {idx}: ok={res.get('ok')} "
                    f"accepted={res.get('accepted')} err={res.get('error','')}")
                _asyncio.get_running_loop().create_task(self._broadcast_stacking_snapshot(path))
                self._broadcast_stacking_status()
            logging.getLogger(__name__).info(
                f"stacking session ended: {self.stacking.status().get('accepted')} "
                f"accepted in {session_dir}")
        except Exception as e:  # noqa: BLE001
            self._stacking_stop = True
            logging.getLogger(__name__).error(f"stacking session failed: {e}")
        finally:
            self._stacking_session = None
            # Session avec cible atteinte → sauvegarde automatique du master
            # dans <root>/masters/ (le root = parent du dossier de session).
            self._stacking_master_path = None
            if completed_with_target:
                try:
                    res = await _asyncio.to_thread(
                        self.stacking.save_master, os.path.dirname(session_dir), "master", "fits")
                    if res.get("ok"):
                        self._stacking_master_path = res["path"]
                        logging.getLogger(__name__).info(
                            f"auto-saved master at target: {res['path']}")
                    else:
                        logging.getLogger(__name__).warning(
                            f"auto-save master failed: {res.get('error')}")
                except Exception as e:  # noqa: BLE001
                    logging.getLogger(__name__).error(f"auto-save master error: {e}")
            self._broadcast_stacking_status()

    def _stacking_status_payload(self) -> dict:
        """Status payload shared by /api/stacking/status and the WS push."""
        st = self.stacking.status()
        st["session"] = {
            "running": self._stacking_session is not None and not self._stacking_session.done(),
            "stop_requested": self._stacking_stop,
        }
        st["session_dir"] = getattr(self, "_stacking_session_dir", None)
        st["master_path"] = self._stacking_master_path
        return st

    def _broadcast_stacking_status(self) -> None:
        """Broadcast live stacking status to all WebSocket clients
        (message type ``stacking`` — remplace le polling frontend)."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "stacking", "status": self._stacking_status_payload()}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    def _broadcast_sequence_status(self) -> None:
        """Broadcast sequence status to all WebSocket clients
        (message type ``sequence`` — remplace le polling frontend)."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "sequence", "status": self.sequence.status()}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    async def _broadcast_stacking_snapshot(self, path: str = "") -> None:
        """Broadcast the current live-stack preview to WebSocket clients."""
        if not self._ws_clients:
            return
        try:
            png = self.stacking.snapshot_png()
        except Exception:  # noqa: BLE001
            png = None
        if not png:
            return
        await self._broadcast_image("stacking", base64.b64encode(png).decode("ascii"))

    async def _broadcast_image(self, device: str, b64data: str) -> None:
        """Low-level helper pushing a base64 image message to WS clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({
            "type": "image", "device": device, "format": "png", "data": b64data,
        }))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))
