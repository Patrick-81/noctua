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
                 sequence_config: dict | None = None, exposure_config: dict | None = None):
        self.registry = registry
        self.site = site_config or {}
        self.telescope = dict(telescope_config or {})
        self.sequence_cfg = dict(sequence_config or {})
        self.exposure_cfg = dict(exposure_config or {})
        # Defaults for meridian flip
        self.telescope.setdefault("flip_enabled", False)
        self.telescope.setdefault("hour_angle_margin", 0.0)
        self.telescope.setdefault("min_altitude", 0.0)
        self.telescope.setdefault("flip_slew_rate", "Centering")
        self.telescope.setdefault("recenter_after_flip", True)
        self.config_path = config_path
        self.ui_path = ui_path
        self.profiles = ProfileStore(profiles_path)
        self.app = FastAPI(title="INDIGO Devices")
        self.app.add_middleware(BaseHTTPMiddleware, dispatch=self._no_cache_middleware)
        self._ws_clients: list[WebSocket] = []
        self._last_image_data: bytes = b""
        self._camera_images: dict[str, bytes] = {}  # device_name → last image bytes
        # Duration of the last test exposure used by /api/camera/exposure/estimate
        # (so GET /recommend can extrapolate without re-taking a frame).
        self._last_exposure_test_s: float = 0.0

        # Plate solver (lazy import to avoid circular dependency)
        from indigo.devices.solver import Solver
        self.solver = Solver()

        from indigo.devices.sequence import SequenceRunner
        self.sequence = SequenceRunner()

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
                              mount, sequence, stacking, ws_test)
        for router in (hardware, config, mount, camera, focuser, guide,
                       sequence, stacking, ws_test):
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
            # The INDIGO server runs on the same host as the INDIGO TCP connection
            # URL may be relative like /blob/0x... or absolute http://host:port/blob/...
            if url.startswith("/"):
                fetch_url = f"http://{self.registry.client._host}:7624{url}"
            elif not url.startswith("http"):
                fetch_url = f"http://{self.registry.client._host}:7624/{url}"
            else:
                fetch_url = url

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
