"""Guiding and mount-calibration routes."""

import asyncio
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    async def _calibrate_set_drift(enabled: bool):
        """Toggle mock drift sim (fire-and-forget, safe if property doesn't exist)."""
        try:
            name = "ENABLED" if enabled else "DISABLED"
            await server.registry.client.send_new_switch(
                "Mount", "DRIFT_SIM_ENABLE",
                [{"name": name, "value": True}])
        except Exception:
            pass

    @app.get("/api/guide/status")
    async def guide_status():
        return SanitizedJSONResponse(server._guide.status())

    @app.post("/api/guide/start")
    async def guide_start(body: dict):
        exposure = float(body.get("exposure", 1.0))
        aggressiveness = float(body.get("aggressiveness", 0.8))
        ra_gain = float(body.get("ra_gain", 1.0))
        dec_gain = float(body.get("dec_gain", 1.0))
        max_pulse = int(body.get("max_pulse_ms", 2000))
        min_pulse = int(body.get("min_pulse_ms", 50))
        plate_scale = float(body.get("plate_scale", 1.0))
        # Re-enable drift sim if it was disabled by calibration
        await _calibrate_set_drift(True)
        return SanitizedJSONResponse(server._guide.start(
            exposure, aggressiveness, ra_gain, dec_gain, max_pulse, min_pulse, plate_scale))

    @app.post("/api/guide/step")
    async def guide_step(body: dict):
        x = float(body.get("x", 0))
        y = float(body.get("y", 0))
        snr = body.get("snr")
        snr = float(snr) if snr is not None else None
        return SanitizedJSONResponse(server._guide.step_result(x, y, snr))

    @app.post("/api/guide/set-reference")
    async def guide_set_reference(body: dict):
        x = float(body.get("x", 0))
        y = float(body.get("y", 0))
        return SanitizedJSONResponse(server._guide.set_reference(x, y))

    @app.post("/api/guide/pause")
    async def guide_pause():
        return SanitizedJSONResponse(server._guide.pause())

    @app.post("/api/guide/resume")
    async def guide_resume():
        return SanitizedJSONResponse(server._guide.resume())

    @app.post("/api/guide/stop")
    async def guide_stop():
        return SanitizedJSONResponse(server._guide.stop())

    @app.post("/api/guide/reset")
    async def guide_reset():
        return SanitizedJSONResponse(server._guide.reset())

    # ── Guide calibration ─────────────────────────────────────

    @app.get("/api/guide/calibrate/status")
    async def calibrate_status():
        return SanitizedJSONResponse(server._guide_cal.status())

    @app.post("/api/guide/calibrate/start")
    async def calibrate_start(body: dict):
        from indigo.devices.guide_calibration import CalState
        step_ms = int(body.get("step_ms", 500))
        target_px = float(body.get("target_px", 25))
        # Safety reset — if previous calibration crashed mid-state
        if server._guide_cal.state not in (CalState.IDLE, CalState.COMPLETE, CalState.FAILED):
            log.warning("Calibration start called while state=%s — resetting first",
                        server._guide_cal.state.value)
            server._guide_cal.reset()
        # Disable drift NOW (synchronous) so the first calibration exposure isn't affected
        await _calibrate_set_drift(False)
        try:
            return SanitizedJSONResponse(server._guide_cal.start(step_ms, target_px))
        except Exception as e:
            log.error("Calibrate start exception: %s", e, exc_info=True)
            return {"ok": False, "error": str(e)}

    @app.post("/api/guide/calibrate/set-origin")
    async def calibrate_set_origin(body: dict):
        x = float(body.get("x", 0))
        y = float(body.get("y", 0))
        server._guide_cal.set_origin(x, y)
        return SanitizedJSONResponse({"ok": True})

    @app.post("/api/guide/calibrate/step")
    async def calibrate_step(body: dict):
        direction = body.get("direction", "")
        x = float(body.get("x", 0))
        y = float(body.get("y", 0))
        pulse_ms = int(body.get("pulse_ms", 500))
        result = server._guide_cal.record_step(direction, x, y, pulse_ms)
        if result.get("state") in ("complete", "failed"):
            asyncio.ensure_future(_calibrate_set_drift(True))
        return SanitizedJSONResponse(result)

    @app.post("/api/guide/calibrate/stop")
    async def calibrate_stop():
        asyncio.ensure_future(_calibrate_set_drift(True))
        return SanitizedJSONResponse(server._guide_cal.stop())

    @app.post("/api/guide/calibrate/finish")
    async def calibrate_finish():
        asyncio.ensure_future(_calibrate_set_drift(True))
        return SanitizedJSONResponse(server._guide_cal.finish())

    @app.post("/api/guide/calibrate/reset")
    async def calibrate_reset():
        asyncio.ensure_future(_calibrate_set_drift(True))
        return SanitizedJSONResponse(server._guide_cal.reset())
