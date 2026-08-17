"""Connection and mount routes."""

import asyncio
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

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
        m = server.registry.get_mount()
        if not m:
            return {"error": "no mount"}
        if not m.connected:
            return {"ok": False, "error": "mount not connected"}
        phases = []

        # 1. Stop any in-progress camera exposure cleanly
        for cam in server.registry._devices.values():
            if getattr(cam, "DEVICE_TYPE", None) == "camera" and getattr(cam, "is_ready", False):
                try:
                    await cam.abort()
                    phases.append(f"capture abort ({cam.name})")
                except Exception as e:
                    log.warning("flip: cam abort failed for %s: %s", cam.name, e)

        # 2. Stop guiding if active
        try:
            if hasattr(server, "_guide") and hasattr(server._guide, "stop"):
                st = server._guide.status()
                if str(st.get("state", "")).lower() in ("guiding", "starting"):
                    server._guide.stop()
                    phases.append("guiding stopped")
        except Exception as e:
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
        except Exception as e:
            log.warning("flip: abort failed: %s", e)
        await asyncio.sleep(1.0)

        # Set a centering slew rate so the flip doesn't run at max speed
        rate = server.telescope.get("flip_slew_rate", "Centering")
        try:
            await m.set_slew_rate(rate)
        except Exception:
            pass

        await m.slew_to(ra, dec)
        phases.append(f"slew to RA={ra:.4f}h DEC={dec:.4f}°")

        # 5. Optional: recenter via plate solve on the same target
        if server.telescope.get("recenter_after_flip", True):
            phases.append("recenter pending (solve)")

        return {"ok": True, "phases": phases, "target": {"ra_hours": ra, "dec_deg": dec}}
