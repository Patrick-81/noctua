"""
focuser.py — INDIGO Focuser device.

Handles:
  - FOCUSER_POSITION (current position, target)
  - FOCUSER_SPEED
  - FOCUSER_DIRECTION (IN/OUT)
  - FOCUSER_ABORT_MOTION
"""

from __future__ import annotations

import logging

from .base import BaseDevice
from ..protocol import PropertyVector

log = logging.getLogger("indigo.focuser")

FOCUSER_PROPERTIES = {
    "FOCUSER_POSITION",
    "FOCUSER_SPEED",
    "FOCUSER_DIRECTION",
    "FOCUSER_ABORT_MOTION",
    "FOCUSER_STEPS",
}


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

    def _apply_def(self, pv: PropertyVector) -> None:
        name = pv.name.upper()
        log.info("[%s] def %s", self.name, pv.name)

        if name == "FOCUSER_POSITION":
            self._parse_position(pv)
        elif name == "FOCUSER_SPEED":
            item = pv.get_item("SPEED")
            if item and item.value is not None:
                self.speed = int(item.value)

    def _apply_set(self, pv: PropertyVector) -> None:
        name = pv.name.upper()

        if name == "FOCUSER_POSITION":
            self._parse_position(pv)
            log.info("[%s] position=%d", self.name, self.position)
        elif name == "FOCUSER_SPEED":
            item = pv.get_item("SPEED")
            if item and item.value is not None:
                self.speed = int(item.value)

    def _parse_position(self, pv: PropertyVector) -> None:
        item = pv.get_item("POSITION")
        if item and item.value is not None:
            self.position = int(item.value)

    # ── Commands ─────────────────────────────────────────────────

    async def move_to(self, position: int) -> None:
        """Move focuser to an absolute position."""
        self.target_position = position
        self.is_moving = True
        await self.send_number("FOCUSER_POSITION", [
            {"name": "TARGET_POSITION", "value": position},
        ])
        log.info("[%s] goto %d", self.name, position)

    async def move_relative(self, direction: str, steps: int) -> None:
        """Move focuser relative to current position. direction: IN/OUT"""
        d = direction.upper()
        self.is_moving = True
        await self.send_switch("FOCUSER_DIRECTION", [
            {"name": d, "value": True},
        ])
        await self.send_number("FOCUSER_STEPS", [
            {"name": "STEPS", "value": steps},
        ])

    async def halt(self) -> None:
        await self.send_switch("FOCUSER_ABORT_MOTION", [
            {"name": "ABORT_MOTION", "value": True},
        ])
        self.is_moving = False

    async def set_speed(self, speed: int) -> None:
        self.speed = speed
        await self.send_number("FOCUSER_SPEED", [
            {"name": "SPEED", "value": speed},
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
