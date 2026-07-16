"""
base.py — Base class and generic fallback for INDIGO devices.

Each device type (mount, camera, focuser, ...) inherits from BaseDevice
and implements the interface methods for handling property updates
and exposing a clean Python API.
"""

from __future__ import annotations

import json
import logging
import math
from typing import TYPE_CHECKING

from ..protocol import PropertyVector

if TYPE_CHECKING:
    from ..client import IndigoClient

log = logging.getLogger("indigo.device")


class BaseDevice:
    """Base class for an INDIGO device."""

    DEVICE_TYPE: str = "base"

    def __init__(self, name: str, client: IndigoClient):
        self.name = name
        self.client = client
        self.connected = False
        self._properties: dict[str, PropertyVector] = {}

    def matches_property(self, prop_name: str) -> bool:
        return False

    def state_dict(self) -> dict:
        return {
            "type": self.DEVICE_TYPE,
            "name": self.name,
            "connected": self.connected,
            "properties": list(self._properties.keys()),
            "props": self._serialize_properties(),
        }

    def _sanitize_value(self, v):
        """Sanitize a value for JSON serialization (no NaN/Inf)."""
        if isinstance(v, float):
            if math.isnan(v) or math.isinf(v):
                return 0.0
        return v

    def _serialize_properties(self) -> list[dict]:
        """Serialize all properties with full details for the interactive UI."""
        result = []
        for pv in self._properties.values():
            items = []
            for item in pv.items:
                items.append({
                    "name": item.name,
                    "label": item.label,
                    "value": self._sanitize_value(item.value),
                    "min": self._sanitize_value(item.min),
                    "max": self._sanitize_value(item.max),
                    "step": self._sanitize_value(item.step),
                    "format": item.format,
                    "size": item.size,
                })
            result.append({
                "name": pv.name,
                "label": pv.label,
                "group": pv.group,
                "vector_type": pv.vector_type.value,
                "state": pv.state,
                "perm": pv.perm.value,
                "rule": pv.rule.value if pv.rule else None,
                "timeout": pv.timeout,
                "message": pv.message,
                "items": items,
            })
        return result

    def on_def(self, tag: str, pv: PropertyVector) -> None:
        self._properties[pv.name] = pv
        self._apply_def(pv)

    def on_set(self, tag: str, pv: PropertyVector) -> None:
        self._properties[pv.name] = pv
        self._apply_set(pv)

    def on_del(self, prop_name: str) -> None:
        self._properties.pop(prop_name, None)

    def _apply_def(self, pv: PropertyVector) -> None:
        log.debug("[%s] def %s (%d items)", self.name, pv.name, len(pv.items))

    def _apply_set(self, pv: PropertyVector) -> None:
        pass

    async def send_number(self, prop_name: str, items: list[dict]) -> None:
        await self.client.send_new_number(self.name, prop_name, items)

    async def send_switch(self, prop_name: str, items: list[dict]) -> None:
        await self.client.send_new_switch(self.name, prop_name, items)

    async def send_text(self, prop_name: str, items: list[dict]) -> None:
        await self.client.send_new_text(self.name, prop_name, items)

    def get_prop(self, name: str) -> PropertyVector | None:
        return self._properties.get(name)

    def get_item_value(self, prop_name: str, item_name: str, default=None):
        pv = self.get_prop(prop_name)
        if pv is None:
            return default
        return pv.get_item_value(item_name, default)

    def all_properties(self) -> dict[str, PropertyVector]:
        return dict(self._properties)

    def on_connection_status(self, connected: bool) -> None:
        self.connected = connected

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} '{self.name}' connected={self.connected}>"


class GenericDevice(BaseDevice):
    """Concrete fallback for unknown device types."""

    DEVICE_TYPE = "generic"

    def matches_property(self, prop_name: str) -> bool:
        return True
