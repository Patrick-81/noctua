"""filterwheel.py — INDIGO Filter Wheel device.

Models a motorized (or manual) filter wheel and exposes:
  - the list of slots (FILTER_SLOT switch items, OneOfMany)
  - the currently selected slot
  - ``set_slot()`` to select a slot by name
"""

from __future__ import annotations

import logging

from .base import BaseDevice

log = logging.getLogger("indigo.filterwheel")

FILTERWHEEL_PROPERTIES = {
    "FILTER_SLOT",
    "FILTER_NAME",
    "FILTER_SLOT_NAME",
    "FILTER_POSITION",
}

FILTERWHEEL_KEYWORDS = ["filter", "filtre", "wheel", "roue"]


class FilterWheel(BaseDevice):
    DEVICE_TYPE = "filterwheel"

    def __init__(self, name: str, client):
        super().__init__(name, client)
        self.current_slot: str | None = None
        self.slots: list[dict] = []

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in FILTERWHEEL_PROPERTIES

    @classmethod
    def matches_name(cls, name: str) -> bool:
        name_lower = name.lower()
        return any(kw in name_lower for kw in FILTERWHEEL_KEYWORDS)

    def _parse_slots(self, pv) -> None:
        """Read the FILTER_SLOT switch vector into ``self.slots`` + ``current_slot``."""
        items = []
        for item in pv.items:
            on = bool(item.value)
            label = item.label or item.name
            # Preserve the richer label from a previous def when a state reply
            # carries no label (label falls back to the item name).
            existing = {s["name"]: s for s in self.slots}
            prev = existing.get(item.name)
            if prev and prev.get("label") and (not item.label or label == item.name):
                label = prev["label"]
            items.append({
                "name": item.name,
                "label": label,
                "value": on,
            })
            if on:
                self.current_slot = item.name
        if items:
            existing = {s["name"]: s for s in self.slots}
            self.slots = [
                {**existing.get(i["name"], {}), **i} if i["name"] in existing else i
                for i in items
            ]

    def _apply_set(self, pv) -> None:
        if pv.name.upper() == "FILTER_SLOT":
            self._parse_slots(pv)

    def _apply_def(self, pv) -> None:
        if pv.name.upper() == "FILTER_SLOT":
            self._parse_slots(pv)

    def slots_list(self) -> list[dict]:
        """Return slot names+labels regardless of connected state."""
        if self.slots:
            return [{k: s[k] for k in ("name", "label")} for s in self.slots]
        pv = self.get_prop("FILTER_SLOT")
        if pv:
            return [{"name": i.name, "label": i.label or i.name} for i in pv.items]
        return []

    async def set_slot(self, name: str) -> None:
        """Select a filter slot (OneOfMany switch)."""
        pv = self.get_prop("FILTER_SLOT")
        if pv is None:
            raise RuntimeError(f"Filter wheel '{self.name}' has no FILTER_SLOT property")
        known = [i.name.lower() for i in pv.items]
        if name.lower() not in known:
            raise ValueError(f"Unknown filter slot '{name}' (known: {[i.name for i in pv.items]})")
        log.debug("[%s] set slot → %s", self.name, name)
        await self.send_switch("FILTER_SLOT", [{"name": name, "value": True}])