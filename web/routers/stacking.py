"""Live stacking routes."""

import asyncio
import base64 as _b64
import os
from datetime import datetime
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/stacking/status")
    async def stacking_status():
        return SanitizedJSONResponse(server._stacking_status_payload())

    @app.post("/api/stacking/reset")
    async def stacking_reset():
        server._stacking_stop = True
        st = server.stacking.reset()
        server._broadcast_stacking_status()
        return SanitizedJSONResponse(st)

    @app.post("/api/stacking/configure")
    async def stacking_configure(body: dict):
        return SanitizedJSONResponse(server.stacking.configure(body))

    @app.post("/api/stacking/masters")
    async def stacking_masters(body: dict):
        return SanitizedJSONResponse(server.stacking.build_masters(
            bias_dir=body.get("bias_dir") or None,
            dark_dir=body.get("dark_dir") or None,
            flat_dir=body.get("flat_dir") or None))

    @app.post("/api/stacking/save")
    async def stacking_save(body: dict):
        save_dir = body.get("dir", "") or server.sequence_cfg.get("save_dir", "")
        path = await asyncio.to_thread(
            server.stacking.save_master, save_dir,
            body.get("name", "master"), body.get("format", "fits"))
        return SanitizedJSONResponse(path)

    @app.get("/api/stacking/snapshot")
    async def stacking_snapshot():
        png = await asyncio.to_thread(server.stacking.snapshot_png)
        if not png:
            return SanitizedJSONResponse({"ok": False, "error": "no stack available"})
        return SanitizedJSONResponse({"ok": True, "png": _b64.b64encode(png).decode("ascii")})

    @app.post("/api/stacking/start")
    async def stacking_start(body: dict):
        """Start an auto-stacking session: short LIGHT poses captured and
        pushed into the live stack until max_frames accepted (0 = continuous).
        Each pose FITS is saved under <root>/livestack_YYYYMMDD_HHMMSS/."""
        if server._stacking_session is not None and not server._stacking_session.done():
            return {"ok": False, "error": "stacking session already running"}
        duration = float(body.get("duration", 5.0))
        max_frames = int(body.get("max_frames", 0) or 0)
        filter_name = body.get("filter", "") or ""
        dark_dir = body.get("dark_dir") or None
        flat_dir = body.get("flat_dir") or None
        root_dir = os.path.expanduser(body.get("save_dir") or server.sequence_cfg.get("save_dir", ""))
        if not root_dir:
            return {"ok": False, "error": "no save directory configured"}

        session_dir = os.path.join(root_dir, f"livestack_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
        os.makedirs(session_dir, exist_ok=True)

        server.stacking.configure({"max_frames": max_frames})
        server.stacking.reset()
        if dark_dir or flat_dir:
            await asyncio.to_thread(
                server.stacking.build_masters, dark_dir=dark_dir, flat_dir=flat_dir)

        server._stacking_stop = False
        server._stacking_session_dir = session_dir
        server._stacking_session = asyncio.create_task(
            server._stacking_session_loop(duration, max_frames, session_dir, filter_name))
        server._broadcast_stacking_status()
        return {"ok": True, "session_dir": session_dir,
                "status": server.stacking.status()}

    @app.post("/api/stacking/stop")
    async def stacking_stop():
        server._stacking_stop = True
        st = server.stacking.status()
        st["session"] = {"running": False, "stop_requested": True}
        server._broadcast_stacking_status()
        return SanitizedJSONResponse(st)
