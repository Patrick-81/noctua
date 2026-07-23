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
    "CCD_PREVIEW", "CCD_UPLOAD", "CCD_IMAGE",
    "UPLOAD_MODE", "UPLOAD_SETTINGS",
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
        # BLOB property name (e.g. "CCD1") — set when defBLOBVector arrives
        self.blob_prop_name: str = ""
        # Image callback: (data: bytes, fmt: str, url: str = "")
        self.on_image: Callable[[bytes, str, str], None] | None = None

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in CAMERA_PROPERTIES

    def _apply_def(self, pv: PropertyVector) -> None:
        name = pv.name.upper()
        log.debug("[%s] def %s", self.name, pv.name)

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
        elif pv.vector_type.value == "blob":
            if not self.blob_prop_name:
                self.blob_prop_name = pv.name
                log.info("[%s] BLOB property discovered: %s", self.name, pv.name)

    def _apply_set(self, pv: PropertyVector) -> None:
        name = pv.name.upper()

        if name == "CCD_INFO":
            self._parse_info(pv)
        elif name == "CCD_TEMPERATURE":
            self._parse_temperature(pv)
        elif name == "CCD_EXPOSURE":
            # INDIGO v2.0: item name is EXPOSURE, target attr = full duration
            # INDIGO v1.7: item name is CCD_EXPOSURE_VALUE or DURATION
            item = (pv.get_item("EXPOSURE") or
                    pv.get_item("CCD_EXPOSURE_VALUE") or
                    pv.get_item("DURATION"))
            if item:
                if pv.state == "Busy":
                    # Use target attr (total duration) if available, else text value
                    val = item.target if item.target is not None else item.value
                    if val is not None:
                        self.exposure_time = float(val)
                elif pv.state == "Ok":
                    self.exposure_time = 0.0
            log.debug("[%s] exposure=%.1fs (state=%s)", self.name, self.exposure_time, pv.state)
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

    @property
    def is_ready(self) -> bool:
        """True if camera has CCD properties from the INDIGO server."""
        return "CCD_EXPOSURE" in self._properties

    async def expose(self, duration: float, frame_type: str = "LIGHT") -> None:
        """Start an exposure."""
        if not self.is_ready:
            raise RuntimeError(
                f"Camera '{self.name}' is not connected to hardware "
                f"(no CCD properties received from INDIGO server)"
            )
        self.frame_type = frame_type.upper()
        log.debug("[%s] EXPOSE START: duration=%.1fs frame_type=%s blob_prop=%s",
                 self.name, duration, self.frame_type, self.blob_prop_name)
        await self.send_switch("CCD_FRAME_TYPE", [
            {"name": self.frame_type, "value": True},
        ])
        item = self.get_item_name("CCD_EXPOSURE", "EXPOSURE", "CCD_EXPOSURE_VALUE", "DURATION")
        log.debug("[%s] EXPOSE: sending CCD_EXPOSURE item=%s value=%.1f", self.name, item, duration)
        await self.send_number("CCD_EXPOSURE", [
            {"name": item, "value": duration},
        ])

    async def abort(self) -> None:
        item = self.get_item_name("CCD_EXPOSURE", "EXPOSURE", "CCD_EXPOSURE_VALUE", "DURATION")
        await self.send_number("CCD_EXPOSURE", [
            {"name": item, "value": 0},
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
        """Called by registry when inline binary BLOB data arrives."""
        log.debug("[%s] BLOB INLINE %s.%s format=%s size=%d",
                 self.name, prop_name, item_name, fmt, len(data))
        if self.on_image:
            self.on_image(data, fmt)
        else:
            log.warning("[%s] No on_image callback set — BLOB dropped!", self.name)

    def on_blob_url(self, prop_name: str, item_name: str, url: str) -> None:
        """Called by registry when URL-based BLOB arrives (INDIGO v2)."""
        log.debug("[%s] BLOB URL %s.%s url=%s",
                 self.name, prop_name, item_name, url)
        if self.on_image:
            self.on_image(b"", "", url)

    # ── State ────────────────────────────────────────────────────

    def state_dict(self) -> dict:
        return {
            "type": "camera",
            "name": self.name,
            "connected": self.connected,
            "is_ready": self.is_ready,
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
