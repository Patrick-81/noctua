"""
server.py — FastAPI web server for INDIGO devices.

Provides:
  - REST API to query device state and send commands
  - WebSocket for real-time state updates + logs to the browser
  - Serves static files (HTML/CSS/JS)
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from pathlib import Path
from typing import TYPE_CHECKING

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .cities import search_cities
from .weblog import handler as weblog_handler

if TYPE_CHECKING:
    from ..registry import DeviceRegistry

log = logging.getLogger("indigo.web")

STATIC_DIR = Path(__file__).parent / "static"


def _sanitize(obj):
    """Recursively replace NaN/Inf with None for JSON safety."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


class SanitizedJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(_sanitize(content)).encode("utf-8")


class WebServer:
    def __init__(self, registry: DeviceRegistry, site_config: dict | None = None,
                 config_path: Path | None = None, ui_path: Path | None = None):
        self.registry = registry
        self.site = site_config or {}
        self.config_path = config_path
        self.ui_path = ui_path
        self.app = FastAPI(title="INDIGO Devices")
        self.app.add_middleware(BaseHTTPMiddleware, dispatch=self._no_cache_middleware)
        self._ws_clients: list[WebSocket] = []
        self._last_image_data: bytes = b""

        # Plate solver (lazy import to avoid circular dependency)
        from indigo.devices.solver import Solver
        self.solver = Solver()

        # Wire up state broadcasting
        registry.on_state_update = self._broadcast_state

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

        # ── REST API ─────────────────────────────────────────────

        @app.get("/api/devices")
        async def get_devices():
            return SanitizedJSONResponse({
                name: dev.state_dict()
                for name, dev in self.registry.all_devices().items()
            })

        @app.get("/api/drivers")
        async def get_drivers():
            return self.registry.drivers_list()

        @app.post("/api/drivers/attach")
        async def attach_driver(body: dict):
            """Attach (load) a driver on the INDIGO server."""
            driver_name = body.get("driver", "")
            if not driver_name:
                return {"error": "no driver specified"}
            c = self.registry.client
            if not c.connected:
                return {"error": "not connected to INDIGO server"}
            await c.send_attach_driver(driver_name)
            log.info("Attach driver: %s", driver_name)
            return {"ok": True, "driver": driver_name}

        @app.post("/api/device/connect")
        async def connect_device(body: dict):
            """Manually send CONNECT=On to a device."""
            device_name = body.get("device", "")
            if not device_name:
                return {"error": "no device specified"}
            dev = self.registry.get(device_name)
            if not dev:
                return {"error": f"device '{device_name}' not found"}
            # Determine the correct item name for CONNECT
            item_name = self.registry._connect_item_names.get(device_name, "CONNECT")
            conn_prop = dev.get_prop("CONNECTION")
            if conn_prop:
                connect_item = conn_prop.get_item("CONNECT") or conn_prop.get_item("CONNECTED")
                if connect_item:
                    item_name = connect_item.name
            # Reset retry state and send CONNECT
            self.registry._auto_connecting.discard(device_name)
            self.registry._connect_retries.pop(device_name, None)
            log.info("Manual connect: %s (item=%s)", device_name, item_name)
            self.registry._schedule_connect(device_name, item_name)
            return {"ok": True, "device": device_name}

        @app.get("/api/config")
        async def get_config():
            return {"site": self.site}

        @app.get("/api/ui")
        async def get_ui():
            if self.ui_path and self.ui_path.exists():
                with open(self.ui_path) as f:
                    return yaml.safe_load(f) or {}
            return {}

        @app.post("/api/ui")
        async def set_ui(body: dict):
            if not self.ui_path:
                return {"error": "ui_path not configured"}
            with open(self.ui_path, "w") as f:
                yaml.dump(body, f, default_flow_style=False, sort_keys=False)
            return {"ok": True}

        @app.get("/api/site")
        async def get_site():
            return {
                "name": self.site.get("name", ""),
                "latitude": self.site.get("latitude", 0.0),
                "longitude": self.site.get("longitude", 0.0),
                "elevation": self.site.get("elevation", 0.0),
                "timezone": self.site.get("timezone", "UTC"),
            }

        @app.post("/api/site")
        async def set_site(body: dict):
            self.site = {
                "name": body.get("name", ""),
                "latitude": body.get("latitude", 0.0),
                "longitude": body.get("longitude", 0.0),
                "elevation": body.get("elevation", 0.0),
                "timezone": body.get("timezone", "UTC"),
            }
            if self.config_path and self.config_path.exists():
                with open(self.config_path) as f:
                    cfg = yaml.safe_load(f) or {}
                cfg["site"] = self.site
                with open(self.config_path, "w") as f:
                    yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)
                log.info("Site config saved to %s", self.config_path)
            return {"ok": True, "site": self.site}

        @app.get("/api/site/cities")
        async def get_cities(q: str = ""):
            return search_cities(q)

        @app.get("/api/mount")
        async def get_mount():
            m = self.registry.get_mount()
            return SanitizedJSONResponse(m.state_dict() if m else None)

        @app.get("/api/camera")
        async def get_camera():
            c = self.registry.get_camera()
            return SanitizedJSONResponse(c.state_dict() if c else None)

        @app.get("/api/focuser")
        async def get_focuser():
            f = self.registry.get_focuser()
            return SanitizedJSONResponse(f.state_dict() if f else None)

        @app.get("/api/connection")
        async def get_connection():
            c = self.registry.client
            return {
                "protocol": getattr(c, '_protocol', 'connect'),
                "host": c._host,
                "port": c._port,
                "connected": c.connected,
            }

        @app.post("/api/connection")
        async def set_connection(body: dict):
            """Update INDIGO connection parameters and reconnect."""
            c = self.registry.client
            host = body.get("host", c._host)
            port = int(body.get("port", c._port))
            protocol = body.get("protocol", getattr(c, '_protocol', 'connect'))
            c._host = host
            c._port = port
            c._protocol = protocol
            if c.connected:
                await c.disconnect()
            c._reconnect_try = 0
            c._connecting = False
            loop = asyncio.get_event_loop()
            loop.create_task(c.connect())
            return {"ok": True, "host": host, "port": port, "protocol": protocol}

        @app.post("/api/mount/slew")
        async def mount_slew(body: dict):
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.slew_to(body["ra_hours"], body["dec_deg"])
            return {"ok": True}

        @app.post("/api/mount/abort")
        async def mount_abort():
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.abort()
            return {"ok": True}

        @app.post("/api/mount/park")
        async def mount_park():
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.park()
            return {"ok": True}

        @app.post("/api/mount/unpark")
        async def mount_unpark():
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.unpark()
            return {"ok": True}

        @app.post("/api/mount/home")
        async def mount_home():
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.home()
            return {"ok": True}

        @app.post("/api/mount/tracking")
        async def mount_tracking(body: dict):
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.set_tracking(body.get("on", True))
            return {"ok": True}

        @app.post("/api/mount/move")
        async def mount_move(body: dict):
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            direction = body["direction"]
            rate = body.get("rate")
            if rate:
                await m.set_slew_rate(rate)
            await m.move(direction)
            return {"ok": True}

        @app.post("/api/mount/halt")
        async def mount_halt():
            m = self.registry.get_mount()
            if not m:
                return {"error": "no mount"}
            await m.halt_move()
            return {"ok": True}

        @app.post("/api/camera/expose")
        async def camera_expose(body: dict):
            c = self.registry.get_camera(body.get("device"))
            if not c:
                return {"error": "no camera"}
            if not c.is_ready:
                return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}
            await c.expose(body["duration"], body.get("frame_type", "LIGHT"))
            return {"ok": True}

        @app.post("/api/camera/abort")
        async def camera_abort(body: dict = {}):
            c = self.registry.get_camera(body.get("device"))
            if not c:
                return {"error": "no camera"}
            await c.abort()
            return {"ok": True}

        @app.post("/api/camera/save")
        async def camera_save(body: dict):
            """Save the last captured image to a directory."""
            import base64
            import os
            from datetime import datetime
            save_dir = body.get("dir", "")
            if not save_dir:
                return {"error": "no directory specified"}
            # Expand ~ and create dir if needed
            save_dir = os.path.expanduser(save_dir)
            os.makedirs(save_dir, exist_ok=True)
            # Build filename from timestamp
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"capture_{ts}.fits"
            filepath = os.path.join(save_dir, filename)
            # Get last image data from the camera
            c = self.registry.get_camera()
            if not c:
                return {"error": "no camera"}
            # We need the raw image data — check if we can get it from the client
            # The image was already sent to WS clients, we need to re-fetch or store it
            # For now, we'll store the last image in the server
            if not hasattr(self, '_last_image_data') or not self._last_image_data:
                return {"error": "no image data available — capture first"}
            with open(filepath, "wb") as f:
                f.write(self._last_image_data)
            log.info("Image saved: %s (%d bytes)", filepath, len(self._last_image_data))
            return {"ok": True, "path": filepath, "size": len(self._last_image_data)}

        @app.post("/api/camera/temperature")
        async def camera_temperature(body: dict):
            c = self.registry.get_camera(body.get("device"))
            if not c:
                return {"error": "no camera"}
            await c.set_temperature(body["target"])
            return {"ok": True}

        # ── Plate Solver ─────────────────────────────────────────

        @app.get("/api/solver/status")
        async def solver_status():
            return self.solver.status()

        @app.post("/api/solver/catalogs")
        async def solver_load_catalogs(body: dict = {}):
            catalog_dir = body.get("catalog_dir")
            result = self.solver.load_catalogs(catalog_dir)
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
            if self.solver.is_solving:
                return {"error": "Already solving — wait for current solve to finish"}

            mode = body.get("mode", "hinted")

            # Get image data
            image_data = None
            fmt = "fits"

            if mode == "last_image":
                # Use the last captured image
                if not self._last_image_data:
                    return {"error": "No image captured yet — capture first"}
                image_data = self._last_image_data
                fmt = "fits"
            elif "image_data" in body:
                # Direct image upload (base64)
                import base64
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
                    wcs = self.solver._extract_wcs(image_data)
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
                m = self.registry.get_mount()
                if m and m.ra_hours is not None:
                    ra_hint = ra_hint if ra_hint is not None else m.ra_hours * 15  # hours → degrees
                    dec_hint = dec_hint if dec_hint is not None else m.dec_deg
                    log.debug("Auto-hint from mount: RA=%.2f DEC=%.2f", ra_hint, dec_hint)

            # Auto-scale from camera (only if still no scale)
            if scale_hint is None:
                c = self.registry.get_camera(body.get("device"))
                if c and c.pixel_size_um and c.focal_length_mm:
                    scale_hint = (c.pixel_size_um / 1000) / (c.focal_length_mm / 1000) * 206.265
                    log.debug("Auto-scale from camera: %.2f arcsec/px", scale_hint)

            # Run solve in a thread (Seiza releases GIL but we want non-blocking)
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: self.solver.solve_image(
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
                await self._broadcast_solver_result(result)

            return result

        @app.post("/api/focuser/move")
        async def focuser_move(body: dict):
            f = self.registry.get_focuser()
            if not f:
                return {"error": "no focuser"}
            await f.move_to(body["position"])
            return {"ok": True}

        @app.post("/api/focuser/halt")
        async def focuser_halt():
            f = self.registry.get_focuser()
            if not f:
                return {"error": "no focuser"}
            await f.halt()
            return {"ok": True}

        # ── Generic property setter ──────────────────────────────

        @app.post("/api/property")
        async def set_property(body: dict):
            """Send a property update to any device.

            body = {
                "device": "LX200 OnStep",
                "property": "DEVICE_PORT",
                "items": [{"name": "PORT", "value": "/dev/ttyUSB0"}]
            }
            """
            device_name = body.get("device", "")
            prop_name = body.get("property", "")
            items = body.get("items", [])

            dev = self.registry.get(device_name)
            if not dev:
                return {"error": f"device '{device_name}' not found"}

            pv = dev.get_prop(prop_name)
            if not pv:
                return {"error": f"property '{prop_name}' not found on '{device_name}'"}

            vtype = pv.vector_type.value
            if vtype == "switch":
                await dev.send_switch(prop_name, items)
            elif vtype == "number":
                await dev.send_number(prop_name, items)
            elif vtype == "text":
                await dev.send_text(prop_name, items)
            else:
                return {"error": f"unsupported vector type: {vtype}"}

            return {"ok": True}

        # ── WebSocket (real-time state + logs) ───────────────────

        @app.websocket("/ws")
        async def websocket_endpoint(ws: WebSocket):
            await ws.accept()
            self._ws_clients.append(ws)
            weblog_handler.add_client(ws)
            log.debug("WS client connected (%d total)", len(self._ws_clients))
            try:
                # Send current state immediately
                state = {
                    name: dev.state_dict()
                    for name, dev in self.registry.all_devices().items()
                }
                await ws.send_json(_sanitize({"type": "state", "devices": state}))

                # Keep connection alive, listen for client messages
                while True:
                    data = await ws.receive_text()
                    await self._handle_ws_command(json.loads(data))
            except WebSocketDisconnect:
                pass
            finally:
                if ws in self._ws_clients:
                    self._ws_clients.remove(ws)
                weblog_handler.remove_client(ws)
                log.debug("WS client disconnected (%d remaining)", len(self._ws_clients))

        # ── Test endpoints (dev only) ─────────────────────────────

        @app.get("/api/test/fits-list")
        async def test_fits_list():
            """List available synthetic FITS test images."""
            fake_sky = Path(__file__).parent.parent / "tests" / "fake_sky"
            if not fake_sky.exists():
                return {"images": []}
            images = []
            for p in sorted(fake_sky.glob("test_*.fits")):
                name = p.stem.replace("test_", "")
                meta_path = p.with_suffix(".json")
                meta = {}
                if meta_path.exists():
                    import json as _json
                    meta = _json.loads(meta_path.read_text())
                images.append({
                    "name": name,
                    "file": p.name,
                    "ra": meta.get("center_ra"),
                    "dec": meta.get("center_dec"),
                    "scale": meta.get("scale_arcsec_px"),
                    "stars": meta.get("n_stars"),
                })
            return {"images": images}

        @app.get("/api/test/fits/{filename}")
        async def test_fits_get(filename: str):
            """Return a synthetic FITS file as base64 for viewer testing."""
            import base64 as _b64
            fake_sky = Path(__file__).parent.parent / "tests" / "fake_sky"
            filepath = fake_sky / filename
            if not filepath.exists() or not filepath.suffix == ".fits":
                return {"error": f"File not found: {filename}"}
            data = filepath.read_bytes()
            return {
                "ok": True,
                "filename": filename,
                "format": "image/fits",
                "data": _b64.b64encode(data).decode("ascii"),
                "size": len(data),
            }

        @app.post("/api/test/fits-store")
        async def test_fits_store(body: dict):
            """Store a FITS image (base64) as last captured image for solver testing."""
            import base64 as _b64
            b64_data = body.get("data", "")
            if not b64_data:
                return {"error": "No data"}
            self._last_image_data = _b64.b64decode(b64_data)
            log.info("Test FITS stored as last image (%d bytes)", len(self._last_image_data))
            return {"ok": True, "size": len(self._last_image_data)}

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

    def _broadcast_state(self, state: dict) -> None:
        """Send state update to all connected WebSocket clients."""
        if not self._ws_clients:
            return
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
        import base64
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
                    # Store last image for save endpoint
                    self._last_image_data = data

                    if not self._ws_clients:
                        return
                    b64 = base64.b64encode(data).decode("ascii")
                    payload = json.dumps({
                        "type": "image",
                        "format": fmt,
                        "data": b64,
                    })
                    for ws in self._ws_clients[:]:
                        try:
                            await ws.send_text(payload)
                        except Exception:
                            self._safe_remove_client(ws)
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
