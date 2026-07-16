"""
camera.py — INDIGO Camera (CCD) device.

Handles:
  - CCD_INFO (sensor dimensions, pixel size)
  - CCD_EXPOSURE (exposure duration)
  - CCD_TEMPERATURE (sensor temperature, setpoint)
  - CCD_BINNING (horizontal/vertical binning)
  - CCD_GAIN, CCD_OFFSET
  - CCD_FRAME_TYPE (LIGHT/DARK/FLAT/BIAS)
  - CCD_LENS (focal length)
  - CCD_PREVIEW
  - BLOB (image data)
"""

from __future__ import annotations

import logging
from typing import Callable

from .base import BaseDevice
from ..protocol import PropertyVector

log = logging.getLogger("indigo.camera")

CAMERA_PROPERTIES = {
    "CCD_INFO", "CCD_LENS", "CCD_LENS_FOV",
    "CCD_EXPOSURE", "CCD_TEMPERATURE", "CCD_BINNING",
    "CCD_GAIN", "CCD_OFFSET", "CCD_FRAME_TYPE",
    "CCD_PREVIEW", "CCD_UPLOAD",
}


class Camera(BaseDevice):
    DEVICE_TYPE = "camera"

    def __init__(self, name: str, client):
        super().__init__(name, client)
        # Sensor info
        self.width_px: int = 0
        self.height_px: int = 0
        self.pixel_size_um: float = 0.0
        # Lens
        self.focal_length_mm: float = 0.0
        # Exposure
        self.exposure_time: float = 0.0
        self.frame_type: str = "LIGHT"
        # Temperature
        self.temperature: float = 0.0
        self.target_temp: float | None = None
        # Binning
        self.binning_x: int = 1
        self.binning_y: int = 1
        # Gain/Offset
        self.gain: int = 0
        self.offset: int = 0
        # Image callback
        self.on_image: Callable[[bytes, str], None] | None = None

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in CAMERA_PROPERTIES

    def _apply_def(self, pv: PropertyVector) -> None:
        name = pv.name.upper()
        log.info("[%s] def %s", self.name, pv.name)

        if name == "CCD_INFO":
            self._parse_info(pv)
        elif name == "CCD_LENS":
            item = pv.get_item("FOCAL_LENGTH")
            if item and item.value is not None:
                self.focal_length_mm = float(item.value)
        elif name == "CCD_TEMPERATURE":
            self._parse_temperature(pv)
        elif name == "CCD_BINNING":
            self._parse_binning(pv)

    def _apply_set(self, pv: PropertyVector) -> None:
        name = pv.name.upper()

        if name == "CCD_INFO":
            self._parse_info(pv)
        elif name == "CCD_TEMPERATURE":
            self._parse_temperature(pv)
        elif name == "CCD_EXPOSURE":
            item = pv.get_item("DURATION")
            if item and item.value is not None:
                self.exposure_time = float(item.value)
            log.info("[%s] exposure=%.1fs", self.name, self.exposure_time)
        elif name == "CCD_BINNING":
            self._parse_binning(pv)
        elif name == "CCD_GAIN":
            item = pv.get_item("GAIN")
            if item and item.value is not None:
                self.gain = int(item.value)
        elif name == "CCD_OFFSET":
            item = pv.get_item("OFFSET")
            if item and item.value is not None:
                self.offset = int(item.value)

    def _parse_info(self, pv: PropertyVector) -> None:
        w = pv.get_item("WIDTH")
        h = pv.get_item("HEIGHT")
        ps = pv.get_item("PIXEL_SIZE")
        if w and w.value is not None:
            self.width_px = int(w.value)
        if h and h.value is not None:
            self.height_px = int(h.value)
        if ps and ps.value is not None:
            self.pixel_size_um = float(ps.value)

    def _parse_temperature(self, pv: PropertyVector) -> None:
        item = pv.get_item("CCD_TEMPERATURE") or pv.get_item("TEMPERATURE")
        if item and item.value is not None:
            self.temperature = float(item.value)
        sp = pv.get_item("CCD_SETPOINT_TEMPERATURE")
        if sp and sp.value is not None:
            self.target_temp = float(sp.value)

    def _parse_binning(self, pv: PropertyVector) -> None:
        hb = pv.get_item("HOR_BIN")
        vb = pv.get_item("VER_BIN")
        if hb and hb.value is not None:
            self.binning_x = int(hb.value)
        if vb and vb.value is not None:
            self.binning_y = int(vb.value)

    # ── Commands ─────────────────────────────────────────────────

    async def expose(self, duration: float, frame_type: str = "LIGHT") -> None:
        """Start an exposure."""
        self.frame_type = frame_type.upper()
        await self.send_switch("CCD_FRAME_TYPE", [
            {"name": self.frame_type, "value": True},
        ])
        await self.send_number("CCD_EXPOSURE", [
            {"name": "DURATION", "value": duration},
        ])
        log.info("[%s] expose %.1fs %s", self.name, duration, self.frame_type)

    async def abort(self) -> None:
        await self.send_number("CCD_EXPOSURE", [
            {"name": "DURATION", "value": 0},
        ])

    async def set_temperature(self, target: float) -> None:
        self.target_temp = target
        await self.send_number("CCD_TEMPERATURE", [
            {"name": "CCD_SETPOINT_TEMPERATURE", "value": target},
        ])

    async def set_binning(self, x: int, y: int) -> None:
        self.binning_x = x
        self.binning_y = y
        await self.send_number("CCD_BINNING", [
            {"name": "HOR_BIN", "value": x},
            {"name": "VER_BIN", "value": y},
        ])

    async def set_gain(self, gain: int) -> None:
        self.gain = gain
        await self.send_number("CCD_GAIN", [
            {"name": "GAIN", "value": gain},
        ])

    async def set_offset(self, offset: int) -> None:
        self.offset = offset
        await self.send_number("CCD_OFFSET", [
            {"name": "OFFSET", "value": offset},
        ])

    # ── BLOB handling ────────────────────────────────────────────

    def on_blob_data(self, prop_name: str, item_name: str,
                     fmt: str, data: bytes) -> None:
        """Called by registry when binary BLOB data arrives."""
        log.info("[%s] BLOB %s.%s format=%s size=%d",
                 self.name, prop_name, item_name, fmt, len(data))
        if self.on_image:
            self.on_image(data, fmt)

    # ── State ────────────────────────────────────────────────────

    def state_dict(self) -> dict:
        return {
            "type": "camera",
            "name": self.name,
            "connected": self.connected,
            "width_px": self.width_px,
            "height_px": self.height_px,
            "pixel_size_um": self.pixel_size_um,
            "focal_length_mm": self.focal_length_mm,
            "temperature": self.temperature,
            "target_temp": self.target_temp,
            "exposure_time": self.exposure_time,
            "frame_type": self.frame_type,
            "binning_x": self.binning_x,
            "binning_y": self.binning_y,
            "gain": self.gain,
            "offset": self.offset,
            "properties": list(self._properties.keys()),
            "props": self._serialize_properties(),
        }
