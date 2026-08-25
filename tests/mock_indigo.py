#!/usr/bin/env python3
"""mock_indigo.py — Full INDIGO mock server for testing.

Emulates:
  - Mount (slew, tracking, park, abort)
  - Focuser (position, speed, direction, move)
  - Main Camera CCD (exposure, temperature, BLOB FITS)
  - Guide Camera CCD (exposure, BLOB FITS)

Usage:
    python tests/mock_indigo.py              # default port 17624
    python tests/mock_indigo.py --port 17624
"""

import argparse
import asyncio
import io
import logging
import math
import re
import signal
import struct
import sys

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [mock_indigo] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mock_indigo")


def _sexagesimal(deg: float, is_ra: bool = False) -> str:
    if is_ra:
        h = deg
        hh = int(h)
        mm = int((h - hh) * 60)
        ss = ((h - hh) * 60 - mm) * 60
        return f"{hh}:{mm:02d}:{ss:05.2f}"
    else:
        sign = "+" if deg >= 0 else "-"
        d = abs(deg)
        dd = int(d)
        mm = int((d - dd) * 60)
        ss = ((d - dd) * 60 - mm) * 60
        return f"{sign}{dd}:{mm:02d}:{ss:05.2f}"


# ── FITS generator ──────────────────────────────────────────────

def _make_fits(width: int, height: int, stars: list[tuple[int, int, float, float]],
               bg: float = 100.0, noise: float = 4.0) -> bytes:
    """Generate a minimal FITS image with Gaussian stars (vectorized).

    ``noise``: sigma of the Gaussian read noise added per pixel (skew from a
    flat background toward a realistic scene). Set 0 for a deterministic image.
    """
    import sys

    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    img = np.full((height, width), float(bg), dtype=np.float32)
    for cx, cy, peak, sigma in stars:
        img += peak * np.exp(-((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy)) / (2.0 * sigma * sigma))
    if noise:
        rng = np.random.default_rng()
        img += rng.normal(0, noise, (height, width)).astype(np.float32)
    img = np.clip(img, -32768, 32767).astype(np.int16)

    cards = [
        "SIMPLE  =                    T",
        "NAXIS   =                    2",
        f"NAXIS1  =               {width:>5d}",
        f"NAXIS2  =               {height:>5d}",
        "BITPIX  =                   16",
        "END",
    ]
    header = "".join(c.ljust(80) for c in cards).ljust(2880)
    # FITS requires big-endian byte order
    data = img.astype(">i2").tobytes()
    return header.encode("ascii") + data


# ── Property definitions ───────────────────────────────────────────

PROP_DEFS = [
    # ── Mount ──
    '<defSwitchVector device="Mount" name="CONNECTION" state="Ok" perm="rw" label="Connection">'
    '<defSwitch name="CONNECT" value="Off" label="Connect"/>'
    '<defSwitch name="CONNECTED" value="Off" label="Connected"/>'
    '</defSwitchVector>',

    '<defNumberVector device="Mount" name="MOUNT_EQUATORIAL_COORDINATES" state="Ok" perm="rw" label="Equatorial Coordinates">'
    '<defNumber name="RA" value="0" label="RA"/>'
    '<defNumber name="DEC" value="0" label="DEC"/>'
    '</defNumberVector>',

    '<defNumberVector device="Mount" name="MOUNT_HORIZONTAL_COORDINATES" state="Ok" perm="ro" label="Horizontal Coordinates">'
    '<defNumber name="ALT" value="0" label="Altitude"/>'
    '<defNumber name="AZ" value="0" label="Azimuth"/>'
    '</defNumberVector>',

    '<defSwitchVector device="Mount" name="MOUNT_TRACKING" state="Ok" perm="rw" rule="OneOfMany" label="Tracking">'
    '<defSwitch name="ON" value="Off" label="Tracking ON"/>'
    '<defSwitch name="OFF" value="On" label="Tracking OFF"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="MOUNT_PARK" state="Ok" perm="rw" rule="OneOfMany" label="Park">'
    '<defSwitch name="PARKED" value="Off" label="Parked"/>'
    '<defSwitch name="UNPARKED" value="On" label="Unparked"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="MOUNT_ABORT_MOTION" state="Ok" perm="rw" label="Abort Motion">'
    '<defSwitch name="ABORT_MOTION" value="Off" label="Abort"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="MOUNT_ON_COORDINATES_SET" state="Ok" perm="rw" rule="OneOfMany" label="On Coordinates Set">'
    '<defSwitch name="TRACK" value="Off" label="Track"/>'
    '<defSwitch name="SYNC" value="Off" label="Sync"/>'
    '<defSwitch name="SLEW" value="Off" label="Slew"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="MOUNT_MOTION_NS" state="Ok" perm="rw" rule="AtMostOne" label="N/S Motion">'
    '<defSwitch name="NORTH" value="Off" label="North"/>'
    '<defSwitch name="SOUTH" value="Off" label="South"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="MOUNT_MOTION_WE" state="Ok" perm="rw" rule="AtMostOne" label="E/W Motion">'
    '<defSwitch name="EAST" value="Off" label="East"/>'
    '<defSwitch name="WEST" value="Off" label="West"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Mount" name="DRIFT_SIM_ENABLE" state="Ok" perm="rw" rule="OneOfMany" label="Drift Simulation">'
    '<defSwitch name="ENABLED" value="On" label="Enabled"/>'
    '<defSwitch name="DISABLED" value="Off" label="Disabled"/>'
    '</defSwitchVector>',

    # ── Focuser ──
    '<defSwitchVector device="Focuser" name="CONNECTION" state="Ok" perm="rw" label="Connection">'
    '<defSwitch name="CONNECT" value="Off" label="Connect"/>'
    '<defSwitch name="CONNECTED" value="Off" label="Connected"/>'
    '</defSwitchVector>',

    '<defNumberVector device="Focuser" name="FOCUSER_POSITION" state="Ok" perm="rw" label="Position">'
    '<defNumber name="TARGET_POSITION" value="0" label="Target"/>'
    '<defNumber name="POSITION" value="0" label="Position"/>'
    '</defNumberVector>',

    '<defNumberVector device="Focuser" name="FOCUSER_SPEED" state="Ok" perm="rw" label="Speed">'
    '<defNumber name="SPEED" value="500" label="Speed"/>'
    '</defNumberVector>',

    '<defSwitchVector device="Focuser" name="FOCUSER_DIRECTION" state="Ok" perm="rw" rule="OneOfMany" label="Direction">'
    '<defSwitch name="IN" value="On" label="IN"/>'
    '<defSwitch name="OUT" value="Off" label="OUT"/>'
    '</defSwitchVector>',

    '<defNumberVector device="Focuser" name="FOCUSER_STEPS" state="Ok" perm="rw" label="Steps">'
    '<defNumber name="STEPS" value="0" label="Steps"/>'
    '</defNumberVector>',

    '<defSwitchVector device="Focuser" name="FOCUSER_ABORT_MOTION" state="Ok" perm="rw" label="Abort Motion">'
    '<defSwitch name="ABORT_MOTION" value="Off" label="Abort"/>'
    '</defSwitchVector>',

    # ── Main Camera (CCD) ──
    '<defSwitchVector device="Main Camera" name="CONNECTION" state="Ok" perm="rw" label="Connection">'
    '<defSwitch name="CONNECT" value="Off" label="Connect"/>'
    '<defSwitch name="CONNECTED" value="Off" label="Connected"/>'
    '</defSwitchVector>',

    '<defNumberVector device="Main Camera" name="CCD_INFO" state="Ok" perm="r" label="CCD Info">'
    '<defNumber name="WIDTH" value="1920" label="Width"/>'
    '<defNumber name="HEIGHT" value="1080" label="Height"/>'
    '<defNumber name="PIXEL_SIZE" value="3.75" label="Pixel Size"/>'
    '<defNumber name="BITSPERPIXEL" value="16" label="Bits per pixel"/>'
    '</defNumberVector>',

    '<defNumberVector device="Main Camera" name="CCD_EXPOSURE" state="Ok" perm="rw" label="Exposure">'
    '<defNumber name="EXPOSURE" value="1" label="Duration"/>'
    '</defNumberVector>',

    '<defNumberVector device="Main Camera" name="CCD_TEMPERATURE" state="Ok" perm="rw" label="Temperature">'
    '<defNumber name="CCD_TEMPERATURE_VALUE" value="-10" label="Temperature"/>'
    '<defNumber name="CCD_TEMPERATURE_TARGET" value="-10" label="Setpoint"/>'
    '</defNumberVector>',

    '<defNumberVector device="Main Camera" name="CCD_BINNING" state="Ok" perm="rw" label="Binning">'
    '<defNumber name="HORIZONTAL_BINNING" value="1" label="H Binning"/>'
    '<defNumber name="VERTICAL_BINNING" value="1" label="V Binning"/>'
    '</defNumberVector>',

    '<defSwitchVector device="Main Camera" name="CCD_FRAME_TYPE" state="Ok" perm="rw" rule="OneOfMany" label="Frame Type">'
    '<defSwitch name="LIGHT" value="On" label="Light"/>'
    '<defSwitch name="DARK" value="Off" label="Dark"/>'
    '<defSwitch name="FLAT" value="Off" label="Flat"/>'
    '<defSwitch name="BIAS" value="Off" label="Bias"/>'
    '</defSwitchVector>',

    # ── Guide Camera (CCD) ──
    '<defSwitchVector device="Guide Camera" name="CONNECTION" state="Ok" perm="rw" label="Connection">'
    '<defSwitch name="CONNECT" value="Off" label="Connect"/>'
    '<defSwitch name="CONNECTED" value="Off" label="Connected"/>'
    '</defSwitchVector>',

    '<defNumberVector device="Guide Camera" name="CCD_INFO" state="Ok" perm="r" label="CCD Info">'
    '<defNumber name="WIDTH" value="640" label="Width"/>'
    '<defNumber name="HEIGHT" value="480" label="Height"/>'
    '<defNumber name="PIXEL_SIZE" value="5.6" label="Pixel Size"/>'
    '<defNumber name="BITSPERPIXEL" value="16" label="Bits per pixel"/>'
    '</defNumberVector>',

    '<defNumberVector device="Guide Camera" name="CCD_EXPOSURE" state="Ok" perm="rw" label="Exposure">'
    '<defNumber name="EXPOSURE" value="1" label="Duration"/>'
    '</defNumberVector>',

    '<defNumberVector device="Guide Camera" name="CCD_BINNING" state="Ok" perm="rw" label="Binning">'
    '<defNumber name="HORIZONTAL_BINNING" value="1" label="H Binning"/>'
    '<defNumber name="VERTICAL_BINNING" value="1" label="V Binning"/>'
    '</defNumberVector>',

    # ── Filter Wheel ──
    '<defSwitchVector device="Filter Wheel" name="CONNECTION" state="Ok" perm="rw" label="Connection">'
    '<defSwitch name="CONNECT" value="Off" label="Connect"/>'
    '<defSwitch name="CONNECTED" value="Off" label="Connected"/>'
    '</defSwitchVector>',

    '<defSwitchVector device="Filter Wheel" name="FILTER_SLOT" state="Ok" perm="rw" rule="OneOfMany" label="Filter Slot">'
    '<defSwitch name="L" value="On" label="Luminance"/>'
    '<defSwitch name="R" value="Off" label="Red"/>'
    '<defSwitch name="G" value="Off" label="Green"/>'
    '<defSwitch name="B" value="Off" label="Blue"/>'
    '<defSwitch name="Ha" value="Off" label="Ha"/>'
    '</defSwitchVector>',
]


# ── XML parsing ────────────────────────────────────────────────────

def _parse_vector_items(xml_str: str) -> tuple[str, dict[str, str]]:
    m = re.search(r'name="([^"]*)"', xml_str)
    prop_name = m.group(1) if m else ""
    items = {}
    for im in re.finditer(r'<one(?:Number|Switch|Text)\s+name="([^"]*)"[^>]*>([^<]*)</one', xml_str):
        items[im.group(1)] = im.group(2).strip()
    return prop_name, items


# ── Guide drift simulator ─────────────────────────────────────────

class GuideDriftSim:
    """Simulates star drift on guide camera for autoguiding.

    Each exposure steps the star by drift_vel_x/y pixels.
    Mount guide corrections move the star back toward center.
    """

    def __init__(self, img_w: int = 640, img_h: int = 480,
                 drift_vel_x: float = 3.0, drift_vel_y: float = 1.5,
                 correction_strength: float = 8.0):
        self.img_w = img_w
        self.img_h = img_h
        self.drift_vel_x = drift_vel_x
        self.drift_vel_y = drift_vel_y
        self.correction_strength = correction_strength
        self.star_x = img_w / 2
        self.star_y = img_h / 2
        self.frame_count = 0

    def step(self) -> tuple[float, float]:
        """Advance one frame, return (star_x, star_y)."""
        self.frame_count += 1
        self.star_x += self.drift_vel_x
        self.star_y += self.drift_vel_y
        margin = 20
        self.star_x = max(margin, min(self.img_w - margin, self.star_x))
        self.star_y = max(margin, min(self.img_h - margin, self.star_y))
        return (self.star_x, self.star_y)

    def get_position(self) -> tuple[float, float]:
        """Return current star position without advancing drift."""
        return (self.star_x, self.star_y)

    def apply_correction_we(self, direction: str) -> None:
        """Apply WEST/EAST guide correction: moves star toward center."""
        if direction == 'WEST':
            self.star_x -= self.correction_strength
        elif direction == 'EAST':
            self.star_x += self.correction_strength

    def apply_correction_ns(self, direction: str) -> None:
        """Apply NORTH/SOUTH guide correction: moves star toward center."""
        if direction == 'NORTH':
            self.star_y += self.correction_strength
        elif direction == 'SOUTH':
            self.star_y -= self.correction_strength

    def reset(self) -> None:
        self.star_x = self.img_w / 2
        self.star_y = self.img_h / 2
        self.frame_count = 0


# ── Mock mount ─────────────────────────────────────────────────────

class MockMount:
    def __init__(self, drift_sim: GuideDriftSim | None = None):
        self.ra_hours = 6.0
        self.dec_deg = 45.0
        self.tracking = False
        self.parked = True
        self.slewing = False
        self._start_ra = self.ra_hours
        self._start_dec = self.dec_deg
        self._target_ra = None
        self._target_dec = None
        self._connected = True
        self.drift_sim = drift_sim  # Optional: guide drift sim to correct
        self._guide_moving_ns = False
        self._guide_moving_we = False
        self.drift_enabled = True
        # Mock observing site (Mirrors config.yaml defaults)
        self.lat_deg = 43.952
        self.lon_deg = 1.568

    def _alt_az(self):
        """Compute altitude/azimuth from the mounted RA/DEC at the mock site."""
        from datetime import datetime
        import math
        now = datetime.now()
        jd = now.timestamp() / 86400.0 + 2440587.5
        t = (jd - 2451545.0) / 36525.0
        gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0)
                + 0.000387933 * t * t - (t * t * t) / 38710000.0)
        lst = (gmst + self.lon_deg) % 360.0
        ha = math.radians((lst - self.ra_hours * 15.0) % 360.0)
        dec = math.radians(self.dec_deg)
        lat = math.radians(self.lat_deg)
        alt = math.asin(math.sin(dec) * math.sin(lat) + math.cos(dec) * math.cos(lat) * math.cos(ha))
        az = math.atan2(
            -math.sin(ha),
            math.cos(ha) * math.sin(lat) - math.tan(dec) * math.cos(lat),
        )
        return math.degrees(alt), (math.degrees(az) + 360.0) % 360.0

    def horizontal_xml(self):
        alt, az = self._alt_az()
        return (
            f'<setNumberVector device="Mount" name="MOUNT_HORIZONTAL_COORDINATES" state="Ok">'
            f'<oneNumber name="ALT">{alt:.3f}</oneNumber>'
            f'<oneNumber name="AZ">{az:.3f}</oneNumber>'
            f'</setNumberVector>'
        )

    def coords_xml(self, state="Ok"):
        return (
            f'<setNumberVector device="Mount" name="MOUNT_EQUATORIAL_COORDINATES" state="{state}">'
            f'<oneNumber name="RA">{_sexagesimal(self.ra_hours, is_ra=True)}</oneNumber>'
            f'<oneNumber name="DEC">{_sexagesimal(self.dec_deg)}</oneNumber>'
            f'</setNumberVector>'
        )

    def tracking_xml(self):
        v = "On" if self.tracking else "Off"
        return (
            f'<setSwitchVector device="Mount" name="MOUNT_TRACKING" state="Ok">'
            f'<oneSwitch name="ON">{v}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def park_xml(self):
        p = "On" if self.parked else "Off"
        u = "Off" if self.parked else "On"
        return (
            f'<setSwitchVector device="Mount" name="MOUNT_PARK" state="Ok">'
            f'<oneSwitch name="PARKED">{p}</oneSwitch>'
            f'<oneSwitch name="UNPARKED">{u}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def connection_xml(self):
        c = "On" if self._connected else "Off"
        return (
            f'<setSwitchVector device="Mount" name="CONNECTION" state="Ok">'
            f'<oneSwitch name="CONNECT">{c}</oneSwitch>'
            f'<oneSwitch name="CONNECTED">{c}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def motion_ns_xml(self, on_dir: str = ""):
        return (
            f'<setSwitchVector device="Mount" name="MOUNT_MOTION_NS" state="Ok">'
            f'<oneSwitch name="NORTH">{"On" if on_dir == "NORTH" else "Off"}</oneSwitch>'
            f'<oneSwitch name="SOUTH">{"On" if on_dir == "SOUTH" else "Off"}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def motion_we_xml(self, on_dir: str = ""):
        return (
            f'<setSwitchVector device="Mount" name="MOUNT_MOTION_WE" state="Ok">'
            f'<oneSwitch name="EAST">{"On" if on_dir == "EAST" else "Off"}</oneSwitch>'
            f'<oneSwitch name="WEST">{"On" if on_dir == "WEST" else "Off"}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def handle_number(self, prop_name, items):
        if prop_name in ("MOUNT_EQUATORIAL_COORDINATES", "EQUATORIAL_EOD_COORD"):
            self._start_ra = self.ra_hours
            self._start_dec = self.dec_deg
            if "RA" in items:
                self._target_ra = float(items["RA"])
            if "DEC" in items:
                self._target_dec = float(items["DEC"])
            self.slewing = True
            self.parked = False
            log.info("Slew target: RA=%.4fh DEC=%.4f°", self._target_ra, self._target_dec)
        return []

    def handle_switch(self, prop_name, items):
        responses = []
        if prop_name == "CONNECTION":
            for k, v in items.items():
                if k in ("CONNECT", "CONNECTED"):
                    self._connected = v.lower() in ("on", "true", "1")
            log.info("Mount connection: %s", self._connected)
            responses.append(self.connection_xml())
        elif prop_name in ("MOUNT_TRACKING", "TELESCOPE_TRACK_STATE"):
            v = items.get("ON") or items.get("TRACK_ON") or items.get("TRACK")
            self.tracking = v.lower() in ("on", "true", "1") if v else False
            log.info("Tracking: %s", self.tracking)
            responses.append(self.tracking_xml())
        elif prop_name in ("MOUNT_PARK", "TELESCOPE_PARK"):
            v = items.get("PARKED") or items.get("PARK")
            self.parked = v.lower() in ("on", "true", "1") if v else False
            if self.parked:
                self.ra_hours = 6.0
                self.dec_deg = 45.0
                self.tracking = False
                self.slewing = False
            log.info("Park: %s", self.parked)
            responses.append(self.park_xml())
        elif prop_name in ("MOUNT_ABORT_MOTION", "TELESCOPE_ABORT_MOTION"):
            self.slewing = False
            self._target_ra = None
            self._target_dec = None
            log.info("Abort — RA=%.4fh DEC=%.4f°", self.ra_hours, self.dec_deg)
            responses.append(self.coords_xml())
        elif prop_name == "MOUNT_MOTION_NS":
            on_dir = next((k for k, v in items.items() if v.lower() in ("on", "true", "1")), None)
            if on_dir:
                self._guide_moving_ns = True
                if self.drift_sim:
                    self.drift_sim.apply_correction_ns(on_dir)
                responses.append(self.motion_ns_xml(on_dir))
            else:
                self._guide_moving_ns = False
                responses.append(self.motion_ns_xml())
        elif prop_name == "MOUNT_MOTION_WE":
            on_dir = next((k for k, v in items.items() if v.lower() in ("on", "true", "1")), None)
            if on_dir:
                self._guide_moving_we = True
                if self.drift_sim:
                    self.drift_sim.apply_correction_we(on_dir)
                responses.append(self.motion_we_xml(on_dir))
            else:
                self._guide_moving_we = False
                responses.append(self.motion_we_xml())
        elif prop_name == "DRIFT_SIM_ENABLE":
            enabled = items.get("ENABLED", "off").lower() in ("on", "true", "1")
            self.drift_enabled = enabled
            log.info("Drift sim %s", "enabled" if enabled else "disabled")
            responses.append(
                f'<setSwitchVector device="Mount" name="DRIFT_SIM_ENABLE" state="Ok">'
                f'<oneSwitch name="ENABLED">{"On" if enabled else "Off"}</oneSwitch>'
                f'<oneSwitch name="DISABLED">{"Off" if enabled else "On"}</oneSwitch>'
                f'</setSwitchVector>'
            )
        return responses

    async def send_state(self, writer):
        enabled = "On" if self.drift_enabled else "Off"
        disabled = "Off" if self.drift_enabled else "On"
        coord_state = "Busy" if self.slewing else "Ok"
        for xml in [self.connection_xml(), self.coords_xml(coord_state), self.horizontal_xml(),
                     self.tracking_xml(),
                     self.park_xml(), self.motion_ns_xml(), self.motion_we_xml(),
                     f'<setSwitchVector device="Mount" name="DRIFT_SIM_ENABLE" state="Ok">'
                     f'<oneSwitch name="ENABLED">{enabled}</oneSwitch>'
                     f'<oneSwitch name="DISABLED">{disabled}</oneSwitch>'
                     f'</setSwitchVector>']:
            writer.write((xml + "\n").encode())
            await writer.drain()
            await asyncio.sleep(0.03)


# ── Mock focuser ────────────────────────────────────────────────

class MockFocuser:
    def __init__(self):
        self.position = 0
        self.target = 0
        self.speed = 500
        self.direction = "IN"
        self.moving = False
        self._connected = True

    def connection_xml(self):
        c = "On" if self._connected else "Off"
        return (
            f'<setSwitchVector device="Focuser" name="CONNECTION" state="Ok">'
            f'<oneSwitch name="CONNECT">{c}</oneSwitch>'
            f'<oneSwitch name="CONNECTED">{c}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def position_xml(self):
        return (
            f'<setNumberVector device="Focuser" name="FOCUSER_POSITION" state="Ok">'
            f'<oneNumber name="TARGET_POSITION">{self.target}</oneNumber>'
            f'<oneNumber name="POSITION">{self.position}</oneNumber>'
            f'</setNumberVector>'
        )

    def speed_xml(self):
        return (
            f'<setNumberVector device="Focuser" name="FOCUSER_SPEED" state="Ok">'
            f'<oneNumber name="SPEED">{self.speed}</oneNumber>'
            f'</setNumberVector>'
        )

    def direction_xml(self):
        d_in = "On" if self.direction == "IN" else "Off"
        d_out = "On" if self.direction == "OUT" else "Off"
        return (
            f'<setSwitchVector device="Focuser" name="FOCUSER_DIRECTION" state="Ok">'
            f'<oneSwitch name="IN">{d_in}</oneSwitch>'
            f'<oneSwitch name="OUT">{d_out}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def handle_number(self, prop_name, items):
        if prop_name == "FOCUSER_POSITION":
            tp = items.get("TARGET_POSITION")
            if tp is not None:
                self.target = int(float(tp))
                self.moving = True
                log.info("Focuser goto %d", self.target)
            pos = items.get("POSITION")
            if pos is not None:
                self.position = int(float(pos))
        elif prop_name == "FOCUSER_SPEED":
            s = items.get("SPEED")
            if s is not None:
                self.speed = int(float(s))
        elif prop_name == "FOCUSER_STEPS":
            s = int(float(items.get("STEPS", 0)))
            if self.direction == "OUT":
                self.target = self.position + s
            else:
                self.target = self.position - s
            self.moving = True
            log.info("Focuser relative %s %d → target %d", self.direction, s, self.target)
        return []

    def handle_switch(self, prop_name, items):
        if prop_name == "CONNECTION":
            for k, v in items.items():
                if k in ("CONNECT", "CONNECTED"):
                    self._connected = v.lower() in ("on", "true", "1")
            log.info("Focuser connection: %s", self._connected)
            return [self.connection_xml()]
        elif prop_name == "FOCUSER_DIRECTION":
            for k, v in items.items():
                if v.lower() in ("on", "true"):
                    self.direction = k
        elif prop_name == "FOCUSER_ABORT_MOTION":
            self.moving = False
            self.target = self.position
            log.info("Focuser ABORT — position %d", self.position)
        return []

    async def send_state(self, writer):
        for xml in [self.connection_xml(), self.position_xml(), self.speed_xml(), self.direction_xml()]:
            writer.write((xml + "\n").encode())
            await writer.drain()
            await asyncio.sleep(0.03)

    async def simulate_move(self, writer):
        """Simulate focuser reaching target step by step."""
        try:
            while self.moving and self.position != self.target:
                step = 1 if self.target > self.position else -1
                self.position += step
                writer.write((self.position_xml() + "\n").encode())
                await writer.drain()
                await asyncio.sleep(0.02)
            self.moving = False
        except asyncio.CancelledError:
            self.moving = False
        except (ConnectionResetError, BrokenPipeError):
            pass


# ── Mock camera ────────────────────────────────────────────────

class MockCamera:
    def __init__(self, name: str, width: int = 1920, height: int = 1080,
                 pixel_size: float = 3.75, stars: list | None = None):
        self.name = name
        self.width = width
        self.height = height
        self.pixel_size = pixel_size
        self.exposure = 1.0
        self.temperature = -10.0
        self.target_temp = -10.0
        self.binning_x = 1
        self.binning_y = 1
        self._connected = True
        self._exposing = False
        self._stars = stars or [
            (width // 4, height // 4, 5000, 3.0),
            (width * 3 // 4, height // 3, 4000, 2.5),
            (width // 2, height * 2 // 3, 6000, 3.5),
            (width // 3, height * 3 // 4, 3000, 2.0),
            (width * 2 // 3, height // 2, 4500, 2.8),
            (width // 7, height * 2 // 3, 3200, 2.2),
            (width * 5 // 6, height * 4 // 5, 2800, 2.6),
            (width // 3, height // 5, 2600, 2.4),
        ]
        # Guide drift override: if set, use this single star instead of _stars
        self.star_override: tuple[float, float, float, float] | None = None

    def connection_xml(self):
        c = "On" if self._connected else "Off"
        return (
            f'<setSwitchVector device="{self.name}" name="CONNECTION" state="Ok">'
            f'<oneSwitch name="CONNECT">{c}</oneSwitch>'
            f'<oneSwitch name="CONNECTED">{c}</oneSwitch>'
            f'</setSwitchVector>'
        )

    def exposure_xml(self, state="Ok"):
        return (
            f'<setNumberVector device="{self.name}" name="CCD_EXPOSURE" state="{state}">'
            f'<oneNumber name="EXPOSURE">{self.exposure}</oneNumber>'
            f'</setNumberVector>'
        )

    def temperature_xml(self):
        return (
            f'<setNumberVector device="{self.name}" name="CCD_TEMPERATURE" state="Ok">'
            f'<oneNumber name="CCD_TEMPERATURE_VALUE">{self.temperature:.1f}</oneNumber>'
            f'<oneNumber name="CCD_TEMPERATURE_TARGET">{self.target_temp:.1f}</oneNumber>'
            f'</setNumberVector>'
        )

    def handle_number(self, prop_name, items):
        if prop_name == "CCD_EXPOSURE":
            e = items.get("EXPOSURE")
            if e is not None:
                self.exposure = float(e)
                self._exposing = True
                log.info("[%s] Exposure: %.1fs", self.name, self.exposure)
        elif prop_name == "CCD_TEMPERATURE":
            t = items.get("CCD_TEMPERATURE_TARGET")
            if t is not None:
                self.target_temp = float(t)
        elif prop_name == "CCD_BINNING":
            h = items.get("HORIZONTAL_BINNING")
            v = items.get("VERTICAL_BINNING")
            if h: self.binning_x = int(float(h))
            if v: self.binning_y = int(float(v))
        return []

    def handle_switch(self, prop_name, items):
        if prop_name == "CONNECTION":
            for k, v in items.items():
                if k in ("CONNECT", "CONNECTED"):
                    self._connected = v.lower() in ("on", "true", "1")
            log.info("[%s] Connection: %s", self.name, self._connected)
            return [self.connection_xml()]
        return []

    async def send_state(self, writer):
        for xml in [self.connection_xml(), self.temperature_xml()]:
            writer.write((xml + "\n").encode())
            await writer.drain()
            await asyncio.sleep(0.03)

    async def simulate_exposure(self, writer):
        """Simulate exposure: wait, then send FITS BLOB."""
        if not self._exposing:
            return
        self._exposing = False
        try:
            # Send "Busy" state
            writer.write((self.exposure_xml("Busy") + "\n").encode())
            await writer.drain()
            # Wait for exposure duration (capped for mock)
            wait = min(self.exposure, 2.0)
            await asyncio.sleep(wait)
            # Generate FITS image
            w = self.width // self.binning_x
            h = self.height // self.binning_y
            if self.star_override:
                # Guide drift: single star at override position
                sx, sy, peak, sigma = self.star_override
                star_pos = (int(sx), int(sy), peak, sigma)
                fits_data = _make_fits(w, h, [star_pos], bg=200)
            else:
                # Default: random jitter on configured stars (guide-scale shake).
                # The sky background grows with the exposure duration so tests of
                # the ideal-exposure estimator (single & multi-shot) see a bare
                # sky rate proportional to time.
                import random
                stars = [(cx + random.randint(-1, 1), cy + random.randint(-1, 1), peak, sigma)
                         for cx, cy, peak, sigma in self._stars[:8]]
                fits_data = _make_fits(w, h, stars, bg=100.0 + self.exposure * 10.0)
            # Send as BLOB
            blob_xml = (
                f'<setBLOBVector device="{self.name}" name="CCD1" state="Ok" timestamp="{_timestamp()}">'
                f'<oneBLOB name="CCD1" format=".fits" size="{len(fits_data)}">'
                f'{_blob_encode(fits_data)}'
                f'</oneBLOB>'
                f'</setBLOBVector>'
            )
            writer.write((blob_xml + "\n").encode())
            await writer.drain()
            # Send "Ok" state
            writer.write((self.exposure_xml("Ok") + "\n").encode())
            await writer.drain()
            log.info("[%s] Exposure complete: %d bytes FITS", self.name, len(fits_data))
        except (ConnectionResetError, BrokenPipeError):
            pass


# ── Helpers ──────────────────────────────────────────────────────

def _timestamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")


def _blob_encode(data: bytes) -> str:
    """Encode binary data as base64 for INDIGO BLOB."""
    import base64
    return base64.b64encode(data).decode("ascii")


# ── TCP server ─────────────────────────────────────────────────────

class MockIndigoServer:
    def __init__(self, host="127.0.0.1", port=17624,
                 drift_vel_x=3.0, drift_vel_y=1.5, correction_strength=8.0):
        self.host = host
        self.port = port
        self.drift_sim = GuideDriftSim(
            img_w=640, img_h=480,
            drift_vel_x=drift_vel_x,
            drift_vel_y=drift_vel_y,
            correction_strength=correction_strength,
        )
        self.mount = MockMount(drift_sim=self.drift_sim)
        self.focuser = MockFocuser()
        self.cameras = {
            "Main Camera": MockCamera("Main Camera", 1920, 1080, 3.75),
            "Guide Camera": MockCamera("Guide Camera", 640, 480, 5.6),
        }
        self._writer = None
        self._slew_task = None
        self._fw_connected = False
        self._fw_slot = "L"

    async def start(self):
        server = await asyncio.start_server(self._handle_client, self.host, self.port)
        log.info("Listening on %s:%d", self.host, self.port)
        async with server:
            await server.serve_forever()

    async def _handle_client(self, reader, writer):
        addr = writer.get_extra_info("peername")
        log.info("Client connected: %s", addr)
        self._writer = writer
        try:
            xml_buf = b""
            while True:
                data = await reader.readline()
                if not data:
                    break
                xml_buf += data
                stripped = xml_buf.strip()
                if not stripped:
                    continue
                tag_m = re.match(rb"<(\w+)", stripped)
                if not tag_m:
                    continue
                top_tag = tag_m.group(1)
                close_tag = b"</" + top_tag + b">"
                if close_tag not in stripped and not stripped.endswith(b"/>"):
                    continue
                msg = xml_buf.decode("ascii", errors="replace").strip()
                xml_buf = b""
                if not msg:
                    continue
                log.debug("RECV: %s", msg[:300])

                if msg.startswith("<getProperties"):
                    # Send all property definitions
                    for line in PROP_DEFS:
                        writer.write((line + "\n").encode())
                    await writer.drain()
                    await asyncio.sleep(0.05)
                    # Send device states
                    await self.mount.send_state(writer)
                    await self.focuser.send_state(writer)
                    for cam in self.cameras.values():
                        await cam.send_state(writer)
                    # Filter Wheel state (parity with other devices)
                    c = "On" if self._fw_connected else "Off"
                    writer.write((
                        f'<setSwitchVector device="Filter Wheel" name="CONNECTION" state="Ok">'
                        f'<oneSwitch name="CONNECT">{c}</oneSwitch>'
                        f'<oneSwitch name="CONNECTED">{c}</oneSwitch>'
                        f'</setSwitchVector>\n').encode())
                    await writer.drain()
                    writer.write((self.fw_slot_state() + "\n").encode())
                    await writer.drain()

                elif msg.startswith("<newNumberVector"):
                    prop_name, items = _parse_vector_items(msg)
                    # Route to the correct device
                    device_m = re.search(r'device="([^"]*)"', msg)
                    device_name = device_m.group(1) if device_m else ""
                    if device_name == "Mount":
                        self.mount.handle_number(prop_name, items)
                        await self._simulate_slew(writer)
                    elif device_name == "Focuser":
                        self.focuser.handle_number(prop_name, items)
                        asyncio.ensure_future(self._simulate_focuser_move(writer))
                    elif device_name in self.cameras:
                        self.cameras[device_name].handle_number(prop_name, items)
                        if prop_name == "CCD_EXPOSURE" and device_name == "Guide Camera":
                            if self.mount.drift_enabled:
                                sx, sy = self.drift_sim.step()
                            else:
                                sx, sy = self.drift_sim.get_position()
                            self.cameras["Guide Camera"].star_override = (sx, sy, 8000, 3.0)
                        asyncio.ensure_future(self.cameras[device_name].simulate_exposure(writer))

                elif msg.startswith("<newSwitchVector"):
                    prop_name, items = _parse_vector_items(msg)
                    device_m = re.search(r'device="([^"]*)"', msg)
                    device_name = device_m.group(1) if device_m else ""
                    if device_name == "Mount":
                        responses = self.mount.handle_switch(prop_name, items)
                        if prop_name in ("MOUNT_ABORT_MOTION", "TELESCOPE_ABORT_MOTION"):
                            if self._slew_task and not self._slew_task.done():
                                self._slew_task.cancel()
                        for resp in responses:
                            writer.write((resp + "\n").encode())
                        await writer.drain()
                    elif device_name == "Focuser":
                        responses = self.focuser.handle_switch(prop_name, items)
                        for resp in responses:
                            writer.write((resp + "\n").encode())
                        await writer.drain()
                    elif device_name in self.cameras:
                        responses = self.cameras[device_name].handle_switch(prop_name, items)
                        for resp in responses:
                            writer.write((resp + "\n").encode())
                        await writer.drain()
                    elif device_name == "Filter Wheel":
                        if prop_name == "CONNECTION":
                            on = any(v.lower() in ("on", "true", "1") for v in items.values())
                            self._fw_connected = on
                            c = "On" if on else "Off"
                            writer.write((
                                f'<setSwitchVector device="Filter Wheel" name="CONNECTION" '
                                f'state="Ok"><oneSwitch name="CONNECT" value="{c}"/>'
                                f'<oneSwitch name="CONNECTED" value="{c}"/>'
                                f'</setSwitchVector>\n').encode())
                            await writer.drain()
                        elif prop_name == "FILTER_SLOT":
                            on_items = [n for n, v in items.items() if v.lower() in ("on", "true", "1")]
                            if on_items:
                                self._fw_slot = on_items[0]
                            writer.write((self.fw_slot_state() + "\n").encode())
                            await writer.drain()

                elif msg.startswith("<enableBLOB"):
                    pass  # ignore
                else:
                    log.debug("Unhandled: %s", msg[:100])

        except (ConnectionResetError, BrokenPipeError):
            log.info("Client disconnected")
        finally:
            writer.close()
            self._writer = None

    def fw_slot_state(self):
        """Return a setSwitchVector describing the current FILTER_SLOT state."""
        slots = ["L", "R", "G", "B", "Ha"]
        parts = "".join(
            f'<oneSwitch name="{name}" value="{ "On" if name == self._fw_slot else "Off" }"/>'
            for name in slots
        )
        return (f'<setSwitchVector device="Filter Wheel" name="FILTER_SLOT" state="Ok" '
                f'perm="rw" rule="OneOfMany">{parts}</setSwitchVector>')

    async def _simulate_slew(self, writer):
        if self._slew_task and not self._slew_task.done():
            self._slew_task.cancel()
        self._slew_task = asyncio.ensure_future(self._do_slew(writer))

    async def _do_slew(self, writer):
        try:
            import math
            start_ra = self.mount._start_ra
            start_dec = self.mount._start_dec
            target_ra = self.mount._target_ra
            target_dec = self.mount._target_dec
            if target_ra is None or target_dec is None:
                return
            # Angular distance (degrees) — RA scaled by cos(dec)
            cos_dec = math.cos(math.radians((start_dec + target_dec) / 2))
            ra_dist = abs(target_ra - start_ra) * 15.0 * cos_dec
            dec_dist = abs(target_dec - start_dec)
            dist_deg = math.hypot(ra_dist, dec_dist)
            # Slew rate ~4°/s, clamped to [0.3, 3.0] seconds
            duration = max(0.3, min(3.0, dist_deg / 4.0))
            steps = max(10, int(duration / 0.03))
            dt = duration / steps
            log.info("Slew: %.1f° in %.1fs (%d steps)", dist_deg, duration, steps)
            for i in range(1, steps + 1):
                t = i / steps
                self.mount.ra_hours = start_ra + (target_ra - start_ra) * t
                self.mount.dec_deg = start_dec + (target_dec - start_dec) * t
                writer.write((self.mount.coords_xml("Busy") + "\n").encode())
                await writer.drain()
                await asyncio.sleep(dt)
            # Final position — exact target
            self.mount.ra_hours = target_ra
            self.mount.dec_deg = target_dec
            self.mount.slewing = False
            self.mount._target_ra = None
            self.mount._target_dec = None
            writer.write((self.mount.coords_xml("Ok") + "\n").encode())
            await writer.drain()
            log.info("Slew complete: RA=%.4fh DEC=%.4f°",
                     self.mount.ra_hours, self.mount.dec_deg)
        except asyncio.CancelledError:
            log.info("Slew cancelled (abort)")
        except (ConnectionResetError, BrokenPipeError):
            pass

    async def _simulate_focuser_move(self, writer):
        await self.focuser.simulate_move(writer)


def main():
    parser = argparse.ArgumentParser(description="Mock INDIGO server for testing")
    parser.add_argument("--port", type=int, default=17624)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--drift-vel-x", type=float, default=3.0,
                        help="Guide drift velocity X (pixels/frame, default: 3.0)")
    parser.add_argument("--drift-vel-y", type=float, default=1.5,
                        help="Guide drift velocity Y (pixels/frame, default: 1.5)")
    parser.add_argument("--correction-strength", type=float, default=8.0,
                        help="Guide correction strength (pixels/pulse, default: 8.0)")
    parser.add_argument("--no-drift", action="store_true",
                        help="Disable guide drift simulation (star stays centered)")
    args = parser.parse_args()

    if args.no_drift:
        args.drift_vel_x = 0
        args.drift_vel_y = 0

    server = MockIndigoServer(
        host=args.host, port=args.port,
        drift_vel_x=args.drift_vel_x,
        drift_vel_y=args.drift_vel_y,
        correction_strength=args.correction_strength,
    )

    log.info("Guide drift sim: vel=(%.1f, %.1f) px/frame, correction=%.1f px/pulse",
             args.drift_vel_x, args.drift_vel_y, args.correction_strength)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: loop.stop())

    try:
        loop.run_until_complete(server.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
