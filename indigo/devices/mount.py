"""
mount.py — INDIGO Mount device.

Handles:
  - MOUNT_EQUATORIAL_COORDINATES (RA/DEC)
  - MOUNT_HORIZONTAL_COORDINATES (AZ/ALT)
  - MOUNT_TRACKING (ON/OFF)
  - MOUNT_PARK (PARKED/UNPARKED)
  - MOUNT_MOTION_DEC/RA (NORTH/SOUTH/WEST/EAST)
  - MOUNT_ABORT_MOTION
  - MOUNT_ON_COORDINATES_SET (TRACK/SLEW)
  - MOUNT_SLEW_RATE (GUIDE/CENTERING/FIND/MAX)
  - EQUATORIAL_EOD_COORD (INDI legacy)
"""

from __future__ import annotations

import asyncio
import logging

from .base import BaseDevice
from ..protocol import PropertyVector, parse_sexagesimal

log = logging.getLogger("indigo.mount")

# Property names that identify a mount (INDIGO v2.0 + INDI v1.7 legacy)
MOUNT_PROPERTIES = {
    # INDIGO v2.0
    "MOUNT_EQUATORIAL_COORDINATES",
    "MOUNT_TRACKING",
    "MOUNT_PARK",
    "MOUNT_HORIZONTAL_COORDINATES",
    "MOUNT_MOTION_DEC",
    "MOUNT_MOTION_RA",
    "MOUNT_MOTION_NS",
    "MOUNT_MOTION_WE",
    "MOUNT_ABORT_MOTION",
    "MOUNT_ON_COORDINATES_SET",
    "MOUNT_SLEW_RATE",
    "MOUNT_SET_HOST_TIME",
    "MOUNT_GEOGRAPHIC_COORDINATES",
    "MOUNT_HOME",
    "MOUNT_HOME_SET",
    "MOUNT_PARK_SET",
    # INDI legacy
    "EQUATORIAL_EOD_COORD",
    "HORIZONTAL_COORD",
    "TELESCOPE_TRACK_STATE",
    "TELESCOPE_PARK",
    "TELESCOPE_ABORT_MOTION",
    "TELESCOPE_SLEW_RATE",
    "TELESCOPE_HOME",
}


class Mount(BaseDevice):
    DEVICE_TYPE = "mount"

    # Mapping: INDIGO v2.0 → INDI legacy alternatives
    # When the server uses INDI legacy names, these maps tell us which
    # property names and item names to use for commands.
    PROP_ALIASES = {
        "MOUNT_EQUATORIAL_COORDINATES": ["EQUATORIAL_EOD_COORD"],
        "MOUNT_ON_COORDINATES_SET": [],  # not needed for INDI (slew is implicit)
        "MOUNT_ABORT_MOTION": ["TELESCOPE_ABORT_MOTION"],
        "MOUNT_PARK": ["TELESCOPE_PARK"],
        "MOUNT_TRACKING": ["TELESCOPE_TRACK_STATE"],
        "MOUNT_MOTION_DEC": ["TELESCOPE_MOTION_NS", "MOUNT_MOTION_NS"],
        "MOUNT_MOTION_RA": ["TELESCOPE_MOTION_WE", "MOUNT_MOTION_WE"],
        "MOUNT_SLEW_RATE": ["TELESCOPE_SLEW_RATE"],
        "MOUNT_HOME": ["TELESCOPE_HOME"],
        "MOUNT_HORIZONTAL_COORDINATES": ["HORIZONTAL_COORD"],
    }

    def __init__(self, name: str, client):
        super().__init__(name, client)
        # Coordinates
        self.ra_hours: float = 0.0   # RA in hours
        self.dec_deg: float = 0.0    # Dec in degrees
        self.az_deg: float = 0.0
        self.alt_deg: float = 0.0
        # State
        self.tracking: bool = False
        self.slewing: bool = False
        self.parked: bool = False
        self.park_state: str = ""  # INDIGO property state: "Ok", "Busy", "Alert"
        self.homing: bool = False
        # GOTO target (to detect slew completion)
        self._target_ra: float | None = None
        self._target_dec: float | None = None
        self._prev_ra: float = 0.0
        self._prev_dec: float = 0.0
        # Manual move polling
        self._move_poll_task: asyncio.Task | None = None

    # ── Name resolution ──────────────────────────────────────────

    def _resolve_prop_name(self, primary: str) -> str:
        """Return the property name that actually exists on the server.

        Checks `self._properties` for the INDIGO v2.0 name first,
        then tries each alias.  Returns whichever one is found, or
        the primary name as a last resort (will fail server-side).
        """
        if primary in self._properties:
            return primary
        for alias in self.PROP_ALIASES.get(primary, []):
            if alias in self._properties:
                return alias
        return primary  # not found — will produce an error on the server

    def _resolve_item_name(self, prop_name: str, primary_item: str,
                           alias_items: dict[str, str] | None = None) -> str:
        """Return the item name that exists in the given property.

        For properties where INDIGO and INDI use different item names
        (e.g. CONNECT vs CONNECTED, PARKED vs PARK), this maps accordingly.
        """
        pv = self._properties.get(prop_name)
        if pv is None:
            return primary_item
        # Direct match
        if pv.get_item(primary_item):
            return primary_item
        # Try alias map
        if alias_items:
            for indigo_name, indi_name in alias_items.items():
                if primary_item == indigo_name and pv.get_item(indi_name):
                    return indi_name
        return primary_item

    def matches_property(self, prop_name: str) -> bool:
        return prop_name.upper() in MOUNT_PROPERTIES

    def _apply_def(self, pv: PropertyVector) -> None:
        log.debug("[%s] def %s", self.name, pv.name)

    def _apply_set(self, pv: PropertyVector) -> None:
        name = pv.name.upper()

        if name in ("MOUNT_EQUATORIAL_COORDINATES", "EQUATORIAL_EOD_COORD"):
            self._parse_coordinates(pv)
            log.debug("[%s] coords RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
        elif name in ("MOUNT_TRACKING", "TELESCOPE_TRACK_STATE"):
            self._parse_tracking(pv)
            log.debug("[%s] tracking=%s", self.name, self.tracking)
        elif name in ("MOUNT_PARK", "TELESCOPE_PARK"):
            self._parse_park(pv)
            log.info("[%s] park=%s state=%s", self.name, self.parked, self.park_state)
        elif name in ("MOUNT_HORIZONTAL_COORDINATES", "HORIZONTAL_COORD"):
            self._parse_horizontal(pv)
        elif name in ("MOUNT_HOME", "TELESCOPE_HOME"):
            self._parse_home(pv)
            log.info("[%s] home state=%s", self.name, pv.state)

    def _parse_coordinates(self, pv: PropertyVector) -> None:
        ra_item = pv.get_item("RA")
        dec_item = pv.get_item("DEC")
        if ra_item and ra_item.value is not None:
            v = parse_sexagesimal(str(ra_item.value))
            if v is not None:
                self.ra_hours = v
        if dec_item and dec_item.value is not None:
            v = parse_sexagesimal(str(dec_item.value))
            if v is not None:
                self.dec_deg = v

        # Detect slew completion: clear slewing when coords reach target
        if self.slewing and self._target_ra is not None and self._target_dec is not None:
            ra_diff = abs(self.ra_hours - self._target_ra) * 15  # hours→degrees
            dec_diff = abs(self.dec_deg - self._target_dec)
            if ra_diff < 0.05 and dec_diff < 0.05:
                self.slewing = False
                self._target_ra = None
                self._target_dec = None
                log.info("[%s] slew complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)

    def _parse_tracking(self, pv: PropertyVector) -> None:
        for name in ("ON", "TRACK_ON", "TRACK"):
            item = pv.get_item(name)
            if item is not None:
                val = str(item.value).lower()
                self.tracking = val in ("on", "true", "1", "enabled")
                return

    def _parse_park(self, pv: PropertyVector) -> None:
        self.park_state = pv.state or "Ok"
        # INDI legacy: "PARK" switch, INDIGO v2.0: "PARKED"
        for name in ("PARKED", "PARK"):
            item = pv.get_item(name)
            if item is not None:
                val = str(item.value).lower()
                self.parked = val in ("on", "true", "1", "enabled")
                return

    def _parse_horizontal(self, pv: PropertyVector) -> None:
        az_item = pv.get_item("AZ")
        alt_item = pv.get_item("ALT")
        if az_item and az_item.value is not None:
            v = parse_sexagesimal(str(az_item.value))
            if v is not None:
                self.az_deg = v
        if alt_item and alt_item.value is not None:
            v = parse_sexagesimal(str(alt_item.value))
            if v is not None:
                self.alt_deg = v

    def _parse_home(self, pv: PropertyVector) -> None:
        state = (pv.state or "").lower()
        if self.homing and state != "busy":
            self.homing = False

    # ── Commands ─────────────────────────────────────────────────

    async def slew_to(self, ra_hours: float, dec_deg: float) -> None:
        """GOTO: set coordinates and trigger slew."""
        self.slewing = True
        self._target_ra = ra_hours
        self._target_dec = dec_deg
        self._prev_ra = self.ra_hours
        self._prev_dec = self.dec_deg
        coords_prop = self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES")
        items = [
            {"name": "RA", "value": ra_hours},
            {"name": "DEC", "value": dec_deg},
        ]
        await self.send_number(coords_prop, items)

        # On INDIGO v2.0: explicit SLEW trigger needed
        # On INDI legacy (OnStep): slew is implicit when EQUATORIAL_EOD_COORD is set
        slew_prop = self._resolve_prop_name("MOUNT_ON_COORDINATES_SET")
        if slew_prop in self._properties:
            await self.send_switch(slew_prop, [{"name": "SLEW", "value": True}])

        # Start polling to detect slew completion
        self._start_move_poll()

    async def abort(self) -> None:
        abort_prop = self._resolve_prop_name("MOUNT_ABORT_MOTION")
        item = self._resolve_item_name(abort_prop, "ABORT_MOTION", {
            "ABORT_MOTION": "ABORT",
        })
        await self.send_switch(abort_prop, [{ "name": item, "value": True }])
        self.slewing = False
        self._target_ra = None
        self._target_dec = None
        await self._poll_coords()

    async def park(self) -> None:
        park_prop = self._resolve_prop_name("MOUNT_PARK")
        item = self._resolve_item_name(park_prop, "PARKED", {
            "PARKED": "PARK",
        })
        await self.send_switch(park_prop, [{"name": item, "value": True}])

    async def unpark(self) -> None:
        park_prop = self._resolve_prop_name("MOUNT_PARK")
        item = self._resolve_item_name(park_prop, "UNPARKED", {
            "UNPARKED": "UNPARK",
        })
        await self.send_switch(park_prop, [{"name": item, "value": True}])

    async def home(self) -> None:
        """Send HOME command to the mount.

        Tries INDIGO v2.0 (MOUNT_HOME / HOME) then INDI legacy
        (TELESCOPE_HOME / GO, FIND, SET).
        """
        home_prop = self._resolve_prop_name("MOUNT_HOME")
        pv = self._properties.get(home_prop)
        if pv is None:
            # Brute-force: try well-known property names directly
            for name in ("MOUNT_HOME", "TELESCOPE_HOME"):
                pv = self._properties.get(name)
                if pv is not None:
                    home_prop = name
                    break
        if pv is not None:
            self.homing = True
            self._prev_ra = self.ra_hours
            self._prev_dec = self.dec_deg
            item = "GO"
            for candidate in ("HOME", "GO", "FIND", "SET"):
                if pv.get_item(candidate):
                    item = candidate
                    break
            log.info("[%s] home: sending %s.%s", self.name, home_prop, item)
            await self.send_switch(home_prop, [{"name": item, "value": True}])
            self._start_move_poll()
        else:
            log.warning("[%s] home: no HOME property found in %s",
                        self.name, list(self._properties.keys()))

    async def set_tracking(self, on: bool) -> None:
        track_prop = self._resolve_prop_name("MOUNT_TRACKING")
        # Determine correct item names for the server's naming scheme
        pv = self._properties.get(track_prop)
        if pv:
            # INDI legacy: TRACK_ON / TRACK_OFF
            # INDIGO v2.0: ON / OFF
            if pv.get_item("TRACK_ON"):
                on_item, off_item = "TRACK_ON", "TRACK_OFF"
            elif pv.get_item("ON"):
                on_item, off_item = "ON", "OFF"
            else:
                on_item, off_item = "ON", "OFF"
        else:
            on_item, off_item = "ON", "OFF"
        items = [
            {"name": on_item, "value": on},
            {"name": off_item, "value": not on},
        ]
        await self.send_switch(track_prop, items)

    async def move(self, direction: str, rate: str = "CENTERING") -> None:
        """Start a manual move. direction: N/S/E/W or NORTH/SOUTH/EAST/WEST"""
        _DIR_MAP = {"NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W"}
        d = _DIR_MAP.get(direction.upper(), direction.upper())
        if d in ("N", "S"):
            motion_prop = self._resolve_prop_name("MOUNT_MOTION_DEC")
            # Map: INDIGO NORTH/SOUTH → INDI MOTION_NORTH/MOTION_SOUTH
            pv = self._properties.get(motion_prop)
            if pv and pv.get_item("MOTION_NORTH"):
                item = "MOTION_NORTH" if d == "N" else "MOTION_SOUTH"
            else:
                item = "NORTH" if d == "N" else "SOUTH"
            await self.send_switch(motion_prop, [{"name": item, "value": True}])
        elif d in ("E", "W"):
            motion_prop = self._resolve_prop_name("MOUNT_MOTION_RA")
            pv = self._properties.get(motion_prop)
            if pv and pv.get_item("MOTION_EAST"):
                item = "MOTION_EAST" if d == "E" else "MOTION_WEST"
            else:
                item = "EAST" if d == "E" else "WEST"
            await self.send_switch(motion_prop, [{"name": item, "value": True}])
        # Poll coordinates during the move
        self._start_move_poll()

    def _start_move_poll(self) -> None:
        """Start a background task that polls coordinates every 500ms."""
        self._stop_move_poll()
        self._move_poll_task = asyncio.get_running_loop().create_task(
            self._move_poll_loop())

    def _stop_move_poll(self) -> None:
        if self._move_poll_task and not self._move_poll_task.done():
            self._move_poll_task.cancel()
        self._move_poll_task = None

    async def _move_poll_loop(self) -> None:
        try:
            stable_count = 0
            poll_count = 0
            while True:
                await self._poll_coords()
                poll_count += 1
                # During GOTO: detect slew completion by coordinate stabilization
                if self.slewing and self._target_ra is not None:
                    ra_diff = abs(self.ra_hours - self._prev_ra) * 15
                    dec_diff = abs(self.dec_deg - self._prev_dec)
                    if ra_diff < 0.01 and dec_diff < 0.01 and poll_count > 2:
                        stable_count += 1
                    else:
                        stable_count = 0
                    self._prev_ra = self.ra_hours
                    self._prev_dec = self.dec_deg
                    if stable_count >= 3:
                        self.slewing = False
                        self._target_ra = None
                        self._target_dec = None
                        log.info("[%s] slew complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        self._stop_move_poll()
                        return
                # During HOME: detect homing completion by coordinate stabilization
                elif self.homing:
                    ra_diff = abs(self.ra_hours - self._prev_ra) * 15
                    dec_diff = abs(self.dec_deg - self._prev_dec)
                    if ra_diff < 0.01 and dec_diff < 0.01 and poll_count > 2:
                        stable_count += 1
                    else:
                        stable_count = 0
                    self._prev_ra = self.ra_hours
                    self._prev_dec = self.dec_deg
                    if stable_count >= 3:
                        self.homing = False
                        log.info("[%s] homing complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        self._stop_move_poll()
                        return
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            pass

    async def halt_move(self) -> None:
        self._stop_move_poll()
        await self.abort()

    async def _poll_coords(self) -> None:
        """Request fresh coordinates from INDIGO after a move."""
        try:
            await self.client.send_get_properties(self.name, "EQUATORIAL_EOD_COORD")
        except Exception:
            pass

    async def set_slew_rate(self, rate_name: str) -> None:
        """Set slew rate by item name (e.g. 'Guide', 'Centering', 'Find', 'Max')."""
        slew_prop = self._resolve_prop_name("MOUNT_SLEW_RATE")
        if slew_prop in self._properties:
            pv = self._properties[slew_prop]
            # Set the desired rate ON, all others OFF
            items = [{"name": it.name, "value": it.name == rate_name} for it in pv.items]
            await self.send_switch(slew_prop, items)

    # ── State ────────────────────────────────────────────────────

    def state_dict(self) -> dict:
        return {
            "type": "mount",
            "name": self.name,
            "connected": self.connected,
            "ra_hours": self.ra_hours,
            "dec_deg": self.dec_deg,
            "az_deg": self.az_deg,
            "alt_deg": self.alt_deg,
            "tracking": self.tracking,
            "slewing": self.slewing,
            "parked": self.parked,
            "park_state": self.park_state,
            "homing": self.homing,
            "properties": list(self._properties.keys()),
            "props": self._serialize_properties(),
        }
