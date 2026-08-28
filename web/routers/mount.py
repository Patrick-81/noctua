"""Connection and mount routes."""

import asyncio
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/connection")
    async def get_connection():
        c = server.registry.client
        return {
            "protocol": getattr(c, '_protocol', 'connect'),
            "host": c._host,
            "port": c._port,
            "connected": c.connected,
        }

    @app.post("/api/connection")
    async def set_connection(body: dict):
        """Update INDIGO connection parameters and reconnect."""
        c = server.registry.client
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

    @app.get("/api/mount")
    async def get_mount():
        m = server.registry.get_mount()
        if not m:
            return SanitizedJSONResponse(None)
        return SanitizedJSONResponse(server._mount_flip_status(m.state_dict()))

    @app.get("/api/mount/flip/status")
    async def get_mount_flip_status():
        m = server.registry.get_mount()
        if not m:
            return SanitizedJSONResponse({"error": "no mount"})
        return SanitizedJSONResponse(server._mount_flip_status(m.state_dict())["flip"])

    @app.post("/api/mount/slew")
    async def mount_slew(body: dict):
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.slew_to(body["ra_hours"], body["dec_deg"])
        return {"ok": True}

    @app.post("/api/mount/abort")
    async def mount_abort():
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.abort()
        return {"ok": True}

    @app.post("/api/mount/park")
    async def mount_park():
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.park()
        return {"ok": True}

    @app.post("/api/mount/unpark")
    async def mount_unpark():
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.unpark()
        return {"ok": True}

    @app.post("/api/mount/home")
    async def mount_home():
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.home()
        return {"ok": True}

    @app.post("/api/mount/tracking")
    async def mount_tracking(body: dict):
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.set_tracking(body.get("on", True))
        return {"ok": True}

    @app.post("/api/mount/move")
    async def mount_move(body: dict):
        m = server.registry.get_mount()
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
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        await m.halt_move()
        return {"ok": True}

    @app.post("/api/mount/flip")
    async def mount_flip():
        """Execute a manual meridian flip sequence."""
        return await server._do_meridian_flip()
