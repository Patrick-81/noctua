"""
focuser.py — INDI / INDIGO Focuser device.

Supports both naming conventions:
  - INDI: FOCUS_MOTION (FOCUS_INWARD/FOCUS_OUTWARD), ABS_FOCUS_POSITION
    (FOCUS_ABSOLUTE_POSITION), REL_FOCUS_POSITION
    (FOCUS_RELATIVE_POSITION), FOCUS_SPEED (FOCUS_SPEED_VALUE),
    FOCUS_ABORT_MOTION (ABORT).
  - INDIGO / legacy INDI: FOCUSER_POSITION, FOCUSER_SPEED,
    FOCUSER_DIRECTION (MOVE_INWARD/MOVE_OUTWARD), FOCUSER_STEPS,
    FOCUSER_ABORT_MOTION.
"""

from __future__ import annotations

import logging

from .base import BaseDevice
from ..protocol import PropertyVector

log = logging.getLogger("indigo.focuser")

FOCUSER_PROPERTIES = {
    # INDI standard focuser interface
    "ABS_FOCUS_POSITION",
    "REL_FOCUS_POSITION",
    "FOCUS_MOTION",
    "FOCUS_SPEED",
    "FOCUS_ABORT_MOTION",
    "FOCUS_MAX",
    # INDIGO / legacy INDI
    "FOCUSER_POSITION",
    "FOCUSER_SPEED",
    "FOCUSER_DIRECTION",
    "FOCUSER_ABORT_MOTION",
    "FOCUSER_STEPS",
}

POSITION_PROPS = ("FOCUSER_POSITION", "ABS_FOCUS_POSITION")
SPEED_PROPS = ("FOCUSER_SPEED", "FOCUS_SPEED")
DIRECTION_PROPS = ("FOCUSER_DIRECTION", "FOCUS_MOTION")
STEPS_PROPS = ("FOCUSER_STEPS", "REL_FOCUS_POSITION")
ABORT_PROPS = ("FOCUSER_ABORT_MOTION", "FOCUS_ABORT_MOTION")

INWARD_ITEMS = ("IN", "MOVE_INWARD", "FOCUS_INWARD")
OUTWARD_ITEMS = ("OUT", "MOVE_OUTWARD", "FOCUS_OUTWARD")


class Focuser(BaseDevice):
    DEVICE_TYPE = "focuser"

    def __init__(self, name: str, client):
        super().__init__(name, client)
        self.position: int = 0
        self.target_position: int | None = None
        self.speed: int = 0
        self.is_moving: bool = False

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in FOCUSER_PROPERTIES

    def _first_prop(self, names: tuple[str, ...]) -> str | None:
        for name in names:
            if name in self._properties:
                return name
        return None

    def _apply_def(self, pv: PropertyVector) -> None:
        log.debug("[%s] def %s", self.name, pv.name)
        self._apply_set(pv)

    def _apply_set(self, pv: PropertyVector) -> None:
        name = pv.name.upper()

        if name in POSITION_PROPS:
            self._parse_position(pv)
            log.debug("[%s] position=%d", self.name, self.position)
        elif name in SPEED_PROPS:
            item = pv.get_item("SPEED") or pv.get_item("FOCUS_SPEED_VALUE")
            if item is None and pv.items:
                item = pv.items[0]
            if item is not None and item.value is not None:
                self.speed = int(item.value)
        if (pv.state or "").lower() == "busy":
            self.is_moving = True
        elif (pv.state or "").lower() in ("ok", "idle"):
            self.is_moving = False

    def _parse_position(self, pv: PropertyVector) -> None:
        item = (pv.get_item("POSITION") or pv.get_item("TARGET_POSITION")
                or pv.get_item("FOCUS_ABSOLUTE_POSITION")
                or pv.get_item("FOCUSER_POSITION"))
        if item is None and pv.items:
            item = pv.items[0]
        if item is not None and item.value is not None:
            self.position = int(item.value)

    # ── Commands ─────────────────────────────────────────────────

    async def move_to(self, position: int) -> None:
        """Move focuser to an absolute position."""
        self.target_position = position
        self.is_moving = True
        prop = self._first_prop(POSITION_PROPS) or "FOCUSER_POSITION"
        item_name = self.get_item_name(
            prop, "TARGET_POSITION", "POSITION", "FOCUS_ABSOLUTE_POSITION",
            "FOCUSER_POSITION")
        await self.send_number(prop, [
            {"name": item_name, "value": position},
        ])
        log.info("[%s] goto %d (%s.%s)", self.name, position, prop, item_name)

    async def move_relative(self, direction: str, steps: int) -> None:
        """Move focuser relative to current position. direction: IN/OUT."""
        d = direction.upper()

        rel_prop = self._first_prop(("REL_FOCUS_POSITION",))
        motion_prop = self._first_prop(("FOCUS_MOTION",))
        if rel_prop and motion_prop:
            # INDI: select direction then request the relative move.
            inward = d in ("IN", "INWARD", "MOVE_INWARD")
            motion_pv = self.get_prop(motion_prop)
            names = {i.name.upper() for i in motion_pv.items} if motion_pv else set()
            want = None
            for cand in (INWARD_ITEMS if inward else OUTWARD_ITEMS):
                if cand in names:
                    want = cand
                    break
            if want:
                await self.send_switch(motion_prop, [
                    {"name": it.name, "value": it.name.upper() == want}
                    for it in motion_pv.items
                ])
            self.is_moving = True
            item_name = self.get_item_name(
                rel_prop, "FOCUS_RELATIVE_POSITION", "REL_FOCUS_POSITION")
            await self.send_number(rel_prop, [
                {"name": item_name, "value": steps},
            ])
            log.info("[%s] relative %s %d (%s.%s)", self.name, d, steps,
                     rel_prop, item_name)
            return

        # INDIGO / legacy INDI: direction switch + steps number.
        prop = self._first_prop(("FOCUSER_DIRECTION",)) or "FOCUSER_DIRECTION"
        pv = self.get_prop(prop)
        item_names = {i.name.upper() for i in pv.items} if pv and pv.items else set()
        candidates = INWARD_ITEMS if d in ("IN", "INWARD") else OUTWARD_ITEMS
        real = d
        if item_names:
            for cand in candidates:
                if cand in item_names:
                    real = cand
                    break
        self.is_moving = True
        await self.send_switch(prop, [
            {"name": real, "value": True},
        ])
        steps_prop = self._first_prop(STEPS_PROPS) or "FOCUSER_STEPS"
        await self.send_number(steps_prop, [
            {"name": self.get_item_name(steps_prop, "STEPS", "FOCUSER_STEPS"), "value": steps},
        ])

    async def halt(self) -> None:
        prop = self._first_prop(ABORT_PROPS)
        if prop:
            item = self.get_item_name(prop, "ABORT_MOTION", "ABORT")
            await self.send_switch(prop, [
                {"name": item, "value": True},
            ])
        self.is_moving = False

    async def set_speed(self, speed: int) -> None:
        self.speed = speed
        prop = self._first_prop(SPEED_PROPS) or "FOCUSER_SPEED"
        item = self.get_item_name(prop, "SPEED", "FOCUS_SPEED_VALUE")
        await self.send_number(prop, [
            {"name": item, "value": speed},
        ])

    # ── State ────────────────────────────────────────────────────

    def state_dict(self) -> dict:
        return {
            "type": "focuser",
            "name": self.name,
            "connected": self.connected,
            "position": self.position,
            "target_position": self.target_position,
            "speed": self.speed,
            "is_moving": self.is_moving,
            "properties": list(self._properties.keys()),
            "props": self._serialize_properties(),
        }
