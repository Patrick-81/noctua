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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

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
    def __init__(self, registry: DeviceRegistry):
        self.registry = registry
        self.app = FastAPI(title="INDIGO Devices")
        self._ws_clients: list[WebSocket] = []

        # Wire up state broadcasting
        registry.on_state_update = self._broadcast_state

        # Install weblog handler on the root logger
        weblog_handler.setLevel(logging.DEBUG)
        logging.getLogger().addHandler(weblog_handler)

        self._setup_routes()

    def _setup_routes(self) -> None:
        app = self.app

        @app.on_event("startup")
        async def startup():
            weblog_handler.set_loop(asyncio.get_event_loop())
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
            c = self.registry.get_camera()
            if not c:
                return {"error": "no camera"}
            await c.expose(body["duration"], body.get("frame_type", "LIGHT"))
            return {"ok": True}

        @app.post("/api/camera/abort")
        async def camera_abort():
            c = self.registry.get_camera()
            if not c:
                return {"error": "no camera"}
            await c.abort()
            return {"ok": True}

        @app.post("/api/camera/temperature")
        async def camera_temperature(body: dict):
            c = self.registry.get_camera()
            if not c:
                return {"error": "no camera"}
            await c.set_temperature(body["target"])
            return {"ok": True}

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
            log.info("WS client connected (%d total)", len(self._ws_clients))
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
                self._ws_clients.remove(ws)
                weblog_handler.remove_client(ws)
                log.info("WS client disconnected (%d remaining)", len(self._ws_clients))

        # ── Static files (HTML/CSS/JS) ──────────────────────────

        CATALOGS_DIR = Path(__file__).parent.parent / "public" / "catalogs"
        if CATALOGS_DIR.exists():
            app.mount("/catalogs", StaticFiles(directory=str(CATALOGS_DIR)),
                      name="catalogs")

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
        elif cmd == "camera/expose":
            c = self.registry.get_camera()
            if c:
                await c.expose(msg["duration"], msg.get("frame_type", "LIGHT"))

    def _broadcast_state(self, state: dict) -> None:
        """Send state update to all connected WebSocket clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "state", "devices": state}))
        for ws in self._ws_clients[:]:
            try:
                asyncio.get_event_loop().create_task(ws.send_text(payload))
            except Exception:
                self._ws_clients.remove(ws)
