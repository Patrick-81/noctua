"""Focuser and autofocus routes."""

from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/focuser")
    async def get_focuser():
        f = server.registry.get_focuser()
        return SanitizedJSONResponse(f.state_dict() if f else None)

    @app.post("/api/focuser/move")
    async def focuser_move(body: dict):
        f = server.registry.get_focuser()
        if not f:
            return {"error": "no focuser"}
        await f.move_to(body["position"])
        return {"ok": True}

    @app.post("/api/focuser/halt")
    async def focuser_halt():
        f = server.registry.get_focuser()
        if not f:
            return {"error": "no focuser"}
        await f.halt()
        return {"ok": True}

    @app.post("/api/focuser/move_relative")
    async def focuser_move_relative(body: dict):
        f = server.registry.get_focuser()
        if not f:
            return {"error": "no focuser"}
        direction = body.get("direction", "OUT")
        steps = int(body.get("steps", 100))
        await f.move_relative(direction, steps)
        return {"ok": True}

    @app.post("/api/focuser/speed")
    async def focuser_set_speed(body: dict):
        f = server.registry.get_focuser()
        if not f:
            return {"error": "no focuser"}
        speed = int(body.get("speed", 1))
        await f.set_speed(speed)
        return {"ok": True}

    @app.get("/api/focuser/focus-metric")
    async def focuser_focus_metric(device: str = ""):
        img_data = server._camera_images.get(device, server._last_image_data) if device else server._last_image_data
        if not img_data:
            return {"ok": False, "error": "no image captured yet"}
        from indigo.devices.focus_metrics import compute_focus_metrics
        try:
            result = compute_focus_metrics(img_data)
            return SanitizedJSONResponse(result)
        except Exception as e:
            log.error("Focus metric error: %s", e)
            return {"ok": False, "error": str(e)}

    # ── Autofocus ─────────────────────────────────────────────

    @app.get("/api/focuser/autofocus/status")
    async def autofocus_status():
        return SanitizedJSONResponse(server._autofocus.status())

    @app.post("/api/focuser/autofocus/start")
    async def autofocus_start(body: dict):
        center = int(body.get("center", 0))
        search_range = int(body.get("range", 2000))
        num_points = int(body.get("points", 25))
        return SanitizedJSONResponse(server._autofocus.start(center, search_range, num_points))

    @app.post("/api/focuser/autofocus/step")
    async def autofocus_step(body: dict):
        position = int(body.get("position", 0))
        hfr = float(body.get("hfr", 0))
        fwhm = float(body.get("fwhm", 0))
        return SanitizedJSONResponse(server._autofocus.step_result(position, hfr, fwhm))

    @app.post("/api/focuser/autofocus/finish")
    async def autofocus_finish():
        return SanitizedJSONResponse(server._autofocus.finish())

    @app.post("/api/focuser/autofocus/stop")
    async def autofocus_stop():
        return SanitizedJSONResponse(server._autofocus.stop())

    @app.post("/api/focuser/autofocus/reset")
    async def autofocus_reset():
        return SanitizedJSONResponse(server._autofocus.reset())
