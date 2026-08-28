"""Trigger Manager routes."""

from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/triggers/status")
    async def triggers_status():
        return SanitizedJSONResponse(server.triggers.status())

    @app.post("/api/triggers/test")
    async def triggers_test(body: dict):
        """Fire un événement arbitraire et renvoie les résultats des actions
        des triggers déclenchés (mode synchrone, pour debug/UI)."""
        event = body.get("event", "frame_done")
        context = body.get("context") or {}
        name = body.get("name")  # optionnel : cible un trigger précis
        try:
            results = await server.triggers.trigger_now(event, context, name)
        except Exception as e:  # noqa: BLE001
            return SanitizedJSONResponse({"ok": False, "error": str(e)})
        return SanitizedJSONResponse({"ok": True, "event": event, "fired": results})