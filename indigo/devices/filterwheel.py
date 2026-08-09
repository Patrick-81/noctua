"""filterwheel.py — INDIGO Filter Wheel device.

Models a motorized (or manual) filter wheel and exposes:
  - the list of slots (FILTER_SLOT switch OneOfMany — legacy mock
    convention, or WHEEL_SLOT number + WHEEL_SLOT_NAME text — native
    INDIGO 2.x convention)
  - the currently selected slot
  - ``set_slot()`` to select a slot by name

The two conventions are unified into the same ``slots`` list of
``{name, label}`` dicts and a ``current_slot`` name.
"""

from __future__ import annotations

import logging
import re

from .base import BaseDevice

log = logging.getLogger("indigo.filterwheel")

FILTERWHEEL_PROPERTIES = {
    "FILTER_SLOT",
    "FILTER_NAME",
    "FILTER_SLOT_NAME",
    "FILTER_POSITION",
    "WHEEL_SLOT",
    "WHEEL_SLOT_NAME",
    "WHEEL_SLOT_OFFSET",
}

FILTERWHEEL_KEYWORDS = ["filter", "filtre", "wheel", "roue"]

_INDEX_RE = re.compile(r"_(\d+)$")


class FilterWheel(BaseDevice):
    DEVICE_TYPE = "filterwheel"

    def __init__(self, name: str, client):
        super().__init__(name, client)
        self.current_slot: str | None = None
        self.slots: list[dict] = []
        # Native INDIGO 2.x convention state
        self._wheel_names: dict[int, str] = {}   # slot index (1-based) → name
        self._wheel_offsets: dict[int, float] = {}
        self._wheel_index: int | None = None

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in FILTERWHEEL_PROPERTIES

    @classmethod
    def matches_name(cls, name: str) -> bool:
        name_lower = name.lower()
        return any(kw in name_lower for kw in FILTERWHEEL_KEYWORDS)

    def is_attached(self) -> bool:
        """True when the wheel exposes usable slot state and is connected."""
        if not self.connected:
            return False
        return self.get_prop("FILTER_SLOT") is not None or self.get_prop("WHEEL_SLOT") is not None

    # ── Legacy convention: FILTER_SLOT (OneOfMany switch) ─────────

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

    # ── Native INDIGO 2.x convention: WHEEL_SLOT / WHEEL_SLOT_NAME ─

    def _parse_wheel_names(self, pv) -> None:
        """Read WHEEL_SLOT_NAME (text) — maps slot index → filter name."""
        new_names: dict[int, str] = {}
        for item in pv.items:
            m = _INDEX_RE.search(item.name)
            if not m:
                continue
            idx = int(m.group(1))
            val = item.value if item.value is not None else ""
            label = item.label or item.name
            new_names[idx] = val or label
        if new_names:
            self._wheel_names = new_names
        self._rebuild_wheel_slots()

    def _parse_wheel_offsets(self, pv) -> None:
        for item in pv.items:
            m = _INDEX_RE.search(item.name)
            if not m:
                continue
            self._wheel_offsets[int(m.group(1))] = float(item.value)
        self._rebuild_wheel_slots()

    def _parse_wheel(self, pv) -> None:
        """Read WHEEL_SLOT (number) — current slot index (1-based)."""
        for item in pv.items:
            if isinstance(item.value, (int, float)):
                self._wheel_index = int(round(item.value))
        self._rebuild_wheel_slots()

    def _rebuild_wheel_slots(self) -> None:
        """Rebuild ``self.slots`` + ``current_slot`` from the native state."""
        if not self._wheel_names:
            return
        names = sorted(self._wheel_names.items())
        if not names:
            return
        self.slots = [
            {"name": label or name, "label": label or name, "index": idx}
            for idx, label in names
        ]
        if self._wheel_index is not None:
            for s in self.slots:
                if s["index"] == self._wheel_index:
                    self.current_slot = s["name"]
                    break
            else:
                # Index not mapped to a name yet — keep the index label
                self.current_slot = f"WHEEL_SLOT.{self._wheel_index}"

    # ── Dispatch ──────────────────────────────────────────────────

    def _apply_set(self, pv) -> None:
        up = pv.name.upper()
        if up == "FILTER_SLOT":
            self._parse_slots(pv)
        elif up == "WHEEL_SLOT":
            self._parse_wheel(pv)
        elif up == "WHEEL_SLOT_NAME":
            self._parse_wheel_names(pv)
        elif up == "WHEEL_SLOT_OFFSET":
            self._parse_wheel_offsets(pv)

    def _apply_def(self, pv) -> None:
        self._apply_set(pv)

    def slots_list(self) -> list[dict]:
        """Return slot names+labels regardless of connected state."""
        if self.slots:
            return [{k: s[k] for k in ("name", "label")} for s in self.slots]
        pv = self.get_prop("FILTER_SLOT")
        if pv:
            return [{"name": i.name, "label": i.label or i.name} for i in pv.items]
        if self._wheel_names:
            return [
                {"name": label or name, "label": label or name}
                for name, label in sorted(self._wheel_names.items())
            ]
        return []

    async def set_slot(self, name: str) -> None:
        """Select a filter slot by name (legacy switch or native number)."""
        # Legacy convention: FILTER_SLOT OneOfMany switch
        switch_pv = self.get_prop("FILTER_SLOT")
        if switch_pv is not None:
            known = [i.name.lower() for i in switch_pv.items]
            if name.lower() not in known:
                raise ValueError(
                    f"Unknown filter slot '{name}' (known: {[i.name for i in switch_pv.items]})"
                )
            log.debug("[%s] set slot → %s", self.name, name)
            await self.send_switch("FILTER_SLOT", [{"name": name, "value": True}])
            self.current_slot = name
            return

        # Native convention: WHEEL_SLOT number + WHEEL_SLOT_NAME
        num_pv = self.get_prop("WHEEL_SLOT")
        if num_pv is None:
            raise RuntimeError(
                f"Filter wheel '{self.name}' has no FILTER_SLOT/WHEEL_SLOT property"
            )
        idx = self._index_for_name(name)
        if idx is None:
            raise ValueError(f"Unknown filter slot '{name}'")
        item_name = num_pv.items[0].name if num_pv.items else "SLOT"
        log.debug("[%s] set wheel slot → %s (index %d)", self.name, name, idx)
        await self.send_number("WHEEL_SLOT", [{"name": item_name, "value": float(idx)}])
        self.current_slot = name

    def _index_for_name(self, name: str) -> int | None:
        """Map a slot name (or slot label) to its 1-based index."""
        if not self._wheel_names:
            return None
        for idx, label in self._wheel_names.items():
            if label == name:
                return idx
        lowered = name.lower()
        for s in self.slots:
            if s["name"].lower() == lowered:
                return s.get("index")
        m = _INDEX_RE.search(name)
        if m:
            idx = int(m.group(1))
            if idx in self._wheel_names:
                return idx
        return None