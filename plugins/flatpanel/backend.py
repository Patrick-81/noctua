"""
Flat panel plugin — premier plugin de référence (P2.2).

Device : FLAT_LIGHT (switch OneOfMany On/Off), FLAT_BRIGHTNESS (number 0-255).
Routes : GET /api/flatpanel/status, POST /api/flatpanel/{light,brightness}
"""

from __future__ import annotations

import logging

from indigo.devices.base import BaseDevice

log = logging.getLogger("indigo.flatpanel")

FLAT_PROPERTIES = {"FLAT_LIGHT", "FLAT_BRIGHTNESS", "FLAT_COVER", "FLAT_LIGHT_INTENSITY"}


class FlatPanel(BaseDevice):
    DEVICE_TYPE = "flatpanel"

    def __init__(self, name: str, client):
        super().__init__(name, client)
        self.brightness: int = 0  # 0..255
        self.light_on: bool = False
        self.cover_open: bool = True

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in FLAT_PROPERTIES

    @classmethod
    def matches_name(cls, name: str) -> bool:
        n = name.lower()
        return any(k in n for k in ["flat", "panel", "flip-flat", "flatfield"])

    def _apply_set(self, pv) -> None:
        up = pv.name.upper()
        if up in ("FLAT_BRIGHTNESS", "FLAT_LIGHT_INTENSITY"):
            for it in pv.items:
                try:
                    self.brightness = max(0, min(255, int(float(it.value))))
                except (TypeError, ValueError):
                    pass
        elif up == "FLAT_LIGHT":
            for it in pv.items:
                # OneOfMany : item ON == True
                if it.name.upper() in ("ON", "LIGHT_ON", "FLAT_LIGHT_ON"):
                    self.light_on = bool(it.value)
                elif it.name.upper() in ("OFF", "LIGHT_OFF", "FLAT_LIGHT_OFF"):
                    if it.value:
                        self.light_on = False
            # fallback : single switch value
            if len(pv.items) == 1:
                self.light_on = bool(pv.items[0].value)
        elif up == "FLAT_COVER":
            for it in pv.items:
                if it.name.upper() in ("OPEN", "COVER_OPEN"):
                    if it.value:
                        self.cover_open = True
                elif it.name.upper() in ("CLOSED", "CLOSE", "COVER_CLOSED"):
                    if it.value:
                        self.cover_open = False

    def _apply_def(self, pv) -> None:
        self._apply_set(pv)

    def state_dict(self) -> dict:
        base = super().state_dict()
        base.update({
            "brightness": self.brightness,
            "light_on": self.light_on,
            "cover_open": self.cover_open,
        })
        return base

    async def set_brightness(self, value: int) -> None:
        v = max(0, min(255, int(value)))
        # try FLAT_BRIGHTNESS number
        pv = self.get_prop("FLAT_BRIGHTNESS") or self.get_prop("FLAT_LIGHT_INTENSITY")
        if pv and pv.items:
            await self.send_number(pv.name, [{"name": pv.items[0].name, "value": float(v)}])
        else:
            # no prop yet — optimistic local
            self.brightness = v
        self.brightness = v

    async def set_light(self, on: bool) -> None:
        pv = self.get_prop("FLAT_LIGHT")
        if pv and pv.items:
            # OneOfMany : set ON/OFF
            items = []
            for it in pv.items:
                up = it.name.upper()
                if up in ("ON", "LIGHT_ON", "FLAT_LIGHT_ON"):
                    items.append({"name": it.name, "value": bool(on)})
                elif up in ("OFF", "LIGHT_OFF", "FLAT_LIGHT_OFF"):
                    items.append({"name": it.name, "value": not bool(on)})
            if items:
                await self.send_switch(pv.name, items)
        self.light_on = bool(on)


def register(server) -> None:
    """Appelé par PluginManager au démarrage."""
    # 1. Enregistre la classe device
    server.registry.register_device_class(FlatPanel)
    log.info("flatpanel: device class registered")

    # 2. Routes REST
    app = server.app

    async def _get_panel():
        # cherche le premier flatpanel connecté, sinon le premier tout court
        for dev in server.registry.all_devices().values():
            if isinstance(dev, FlatPanel):
                if dev.connected:
                    return dev
        for dev in server.registry.all_devices().values():
            if isinstance(dev, FlatPanel):
                return dev
        return None

    @app.get("/api/flatpanel/status")
    async def flatpanel_status():
        dev = await _get_panel()
        if not dev:
            return {"ok": False, "error": "no flat panel device"}
        return {"ok": True, "panel": dev.state_dict()}

    @app.post("/api/flatpanel/light")
    async def flatpanel_light(body: dict):
        dev = await _get_panel()
        if not dev:
            return {"ok": False, "error": "no flat panel device"}
        on = bool(body.get("on", body.get("light_on", False)))
        await dev.set_light(on)
        return {"ok": True, "panel": dev.state_dict()}

    @app.post("/api/flatpanel/brightness")
    async def flatpanel_brightness(body: dict):
        dev = await _get_panel()
        if not dev:
            return {"ok": False, "error": "no flat panel device"}
        try:
            v = int(body.get("brightness", body.get("value", 0)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "brightness invalide (0..255)"}
        if not 0 <= v <= 255:
            return {"ok": False, "error": "brightness hors bornes 0..255"}
        await dev.set_brightness(v)
        return {"ok": True, "panel": dev.state_dict()}

    log.info("flatpanel: routes /api/flatpanel/* registered")

    # 3. Déclare la catégorie driver pour l'UI
    try:
        from indigo.registry import DRIVER_CATEGORY_PREFIXES
        DRIVER_CATEGORY_PREFIXES["flat"] = "flatpanel"
    except Exception:
        pass
