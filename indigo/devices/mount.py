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
        # Le simu envoie l'état park dès le def (PARKED true) — il faut
        # l'initialiser sinon le flag reste false et le joystick croit
        # pouvoir bouger alors que la monture est parquée côté serveur.
        name = pv.name.upper()
        if name in ("MOUNT_PARK", "TELESCOPE_PARK"):
            self._parse_park(pv)
        elif name in ("MOUNT_TRACKING", "TELESCOPE_TRACK_STATE"):
            self._parse_tracking(pv)
        elif name in ("MOUNT_EQUATORIAL_COORDINATES", "EQUATORIAL_EOD_COORD"):
            self._parse_coordinates(pv)
        elif name in ("MOUNT_HORIZONTAL_COORDINATES", "HORIZONTAL_COORD"):
            self._parse_horizontal(pv)

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
            log.debug("[%s] park=%s state=%s", self.name, self.parked, self.park_state)
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
        new_state = pv.state or "Ok"
        new_parked = self.parked
        for name in ("PARKED", "PARK"):
            item = pv.get_item(name)
            if item is not None:
                val = str(item.value).lower()
                new_parked = val in ("on", "true", "1", "enabled")
                break
        # Toujours en INFO pour OnStep : on veut voir le message et la state même sans changement
        msg = getattr(pv, "message", "") or ""
        if new_parked != self.parked or new_state != self.park_state or pv.state in ("Alert", "Busy") or msg:
            log.info("[%s] park: %s -> %s state=%s->%s (%s) msg='%s' items=%s", self.name, self.parked, new_parked, self.park_state, new_state, pv.name, msg, [(it.name, it.value) for it in pv.items])
        else:
            log.debug("[%s] park=%s state=%s", self.name, new_parked, new_state)
        self.park_state = new_state
        self.parked = new_parked

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

    async def abort(self) -> None:
        abort_prop = self._resolve_prop_name("MOUNT_ABORT_MOTION")
        item = self._resolve_item_name(abort_prop, "ABORT_MOTION", {
            "ABORT_MOTION": "ABORT",
        })
        await self.send_switch(abort_prop, [{ "name": item, "value": True }])
        self.slewing = False
        self.homing = False
        self._target_ra = None
        self._target_dec = None
        await self._poll_coords()

    async def _send_park_switch(self, target_item: str) -> None:
        """Envoie le switch PARK — INDIGO LX200 OnStep :hP#/:hR#.

        INDIGO `MOUNT_PARK` OnStep = `count=2` `ONE_OF_MANY` (`PARKED`/`UNPARKED`).
        Le handler `indigo_change_property` copie les valeurs et teste
        `PARKED true → park` / `UNPARKED true → unpark`. Si on n'envoie que
        `UNPARKED=On` mono-item, `PARKED` reste `On` (valeur précédente) → les
        deux sont `On` → le driver retombe sur la branche `PARKED` et ignore
        le déparcage. Il faut donc toujours envoyer les 2 items pour `count==2`.
        Pour Meade (`count=1` `AT_MOST_ONE`) le mono-item reste correct.
        Vu à l'observatoire : mono `UNPARKED` ne déparquait jamais, `bi` OK.
        """
        park_prop = self._resolve_prop_name("MOUNT_PARK")
        pv = self._properties.get(park_prop)
        # Cas OnStep/NYX : 2 items ONE_OF_MANY → envoi bi-item obligatoire
        if pv and len(pv.items) == 2:
            items = [{"name": it.name, "value": it.name == target_item} for it in pv.items]
            log.info("[%s] park: sending %s bi %s", self.name, park_prop, items)
            await self.send_switch(park_prop, items)
            return
        if pv and pv.get_item(target_item):
            log.info("[%s] park: sending %s.%s=On (mono AT_MOST_ONE)", self.name, park_prop, target_item)
            await self.send_switch(park_prop, [{"name": target_item, "value": True}])
            return
        if pv and len(pv.items) >= 2:
            items = [{"name": it.name, "value": it.name == target_item} for it in pv.items]
            log.info("[%s] park: sending %s.%s=On (bi fallback)", self.name, park_prop, target_item)
            await self.send_switch(park_prop, items)
            return
        alt_prop = "TELESCOPE_PARK"
        if alt_prop in self._properties:
            pv2 = self._properties.get(alt_prop)
            if pv2 and len(pv2.items) == 2:
                items = [{"name": it.name, "value": it.name == target_item} for it in pv2.items]
                log.info("[%s] park: sending %s bi %s (alias)", self.name, alt_prop, items)
                await self.send_switch(alt_prop, items)
                return
            log.info("[%s] park: sending %s.%s=On (alias mono)", self.name, alt_prop, target_item)
            await self.send_switch(alt_prop, [{"name": target_item, "value": True}])
            return
        log.warning("[%s] park: no PARK property with item %s in %s", self.name, target_item, list(self._properties.keys()))

    async def park(self) -> None:
        # OnStep :hP# exige tracking OFF et pas de slew en cours — on s'aligne sur HOME qui marche
        if self.tracking:
            log.info("[%s] park: tracking ON → OFF avant park", self.name)
            await self.set_tracking(False)
            await asyncio.sleep(0.8)
        pv = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        target = "PARKED" if pv and any(it.name == "PARKED" for it in pv.items) else "PARK"
        await self._send_park_switch(target)
        # Poll jusqu'à 10s : évite de bloquer 8s fixes et détecte le vrai Busy→Ok
        for _ in range(20):
            await asyncio.sleep(0.5)
            if self.parked and self.park_state != "Busy":
                log.info("[%s] park: success (parked True, state=%s)", self.name, self.park_state)
                return
            if self.park_state == "Alert":
                log.warning("[%s] park: Alert reçu (state=%s msg park=%s)", self.name, self.park_state, self.parked)
                break
        if self.parked:
            log.info("[%s] park: success Busy→%s (après poll)", self.name, self.park_state)
            return
        log.info("[%s] park: still not parked=%s after poll, retry bi-item", self.name, self.parked)
        pv2 = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        if pv2 and len(pv2.items) >= 2:
            items = [{"name": it.name, "value": it.name == target} for it in pv2.items]
            await self.send_switch(self._resolve_prop_name("MOUNT_PARK"), items)
            for _ in range(20):
                await asyncio.sleep(0.5)
                if self.parked and self.park_state != "Busy":
                    log.info("[%s] park: success after bi-item", self.name)
                    return
        log.warning("[%s] park: still not parked after 10s (state=%s parked=%s)", self.name, self.park_state, self.parked)

    async def unpark(self) -> None:
        # Si HOME est Busy (vu à 18:39), on l'abort d'abord — sinon :hR# est ignoré
        home_pv = self._properties.get(self._resolve_prop_name("MOUNT_HOME"))
        if home_pv and home_pv.state == "Busy":
            log.info("[%s] unpark: HOME Busy → abort avant unpark", self.name)
            await self.abort()
            await asyncio.sleep(0.8)
        pv = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        target = "UNPARKED" if pv and any(it.name == "UNPARKED" for it in pv.items) else "UNPARK"
        await self._send_park_switch(target)
        for _ in range(20):
            await asyncio.sleep(0.5)
            if self.parked is False and self.park_state != "Busy":
                log.info("[%s] unpark: success (parked False, state=%s)", self.name, self.park_state)
                return
            if self.park_state == "Alert":
                log.warning("[%s] unpark: Alert (state=%s)", self.name, self.park_state)
                break
        if not self.parked:
            log.info("[%s] unpark: success after poll (parked False, state=%s)", self.name, self.park_state)
            return
        log.info("[%s] unpark: still parked after poll, retry bi-item", self.name)
        pv2 = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        if pv2 and len(pv2.items) >= 2:
            items = [{"name": it.name, "value": it.name == target} for it in pv2.items]
            log.info("[%s] unpark: sending bi-item %s", self.name, items)
            await self.send_switch(self._resolve_prop_name("MOUNT_PARK"), items)
            for _ in range(20):
                await asyncio.sleep(0.5)
                if not self.parked and self.park_state != "Busy":
                    log.info("[%s] unpark: success after bi-item", self.name)
                    return
        log.warning("[%s] unpark: still parked after 10s (state=%s parked=%s)", self.name, self.park_state, self.parked)

    async def slew_to(self, ra_hours: float, dec_deg: float) -> None:
        """GOTO: dé-parque, tracking ON, sort du pôle, puis slew — fallback move si :MS# bloqué."""
        log.info("[%s] slew_to: demandé RA=%.4fh DEC=%.2f° (actuel RA=%.4fh DEC=%.2f° parked=%s tracking=%s park_state=%s)", self.name, ra_hours, dec_deg, self.ra_hours, self.dec_deg, self.parked, self.tracking, self.park_state)
        if self.parked or self.park_state == "Busy":
            log.info("[%s] slew_to: parked/busy → unpark auto avant slew", self.name)
            await self.unpark()
            # unpark poll déjà 10s, plus 1s de marge
            await asyncio.sleep(1.0)
            if self.parked or self.park_state == "Busy":
                log.warning("[%s] slew_to: still parked/busy (%s/%s), slew annulé", self.name, self.parked, self.park_state)
                return
        if self.homing:
            log.info("[%s] slew_to: homing en cours → abort avant slew", self.name)
            await self.abort()
            await asyncio.sleep(0.8)
        if not self.tracking:
            log.info("[%s] slew_to: tracking OFF → ON avant slew", self.name)
            await self.set_tracking(True)
            # Poll tracking jusqu'à 3s
            for _ in range(6):
                await asyncio.sleep(0.5)
                if self.tracking:
                    break
            if not self.tracking:
                log.warning("[%s] slew_to: tracking toujours OFF après 3s, on tente quand même", self.name)
            else:
                await asyncio.sleep(0.3)
        # Méridien puis parallèle : on sort du pôle en DEC d'abord (joystick South qui marche), puis on corrige RA
        if abs(self.dec_deg - 87.0) < 5.0:
            d_dec = dec_deg - self.dec_deg
            if abs(d_dec) > 2.0:
                direction = "NORTH" if d_dec > 0 else "SOUTH"
                log.info("[%s] slew_to: pôle → méridien %s %.1f° vers DEC=%.1f°", self.name, direction, abs(d_dec), dec_deg)
                await self.move(direction, "FIND")
                await asyncio.sleep(min(4.0, abs(d_dec) * 0.15))  # ~0.15s/deg en FIND
                await self.halt_move()
                await asyncio.sleep(0.8)
            d_ra = (ra_hours - self.ra_hours) * 15.0
            if d_ra > 180:
                d_ra -= 360
            if d_ra < -180:
                d_ra += 360
            # Au pôle (DEC 87°) le sens RA est inversé (pier side) — on teste les deux
            if abs(d_ra) > 3.0:
                # OnStep à 87° : le RA est dégénéré, on tente WEST d'abord (comme le joystick qui marche en West à 20:21)
                for attempt, direction in enumerate([("WEST" if d_ra > 0 else "EAST"), ("EAST" if d_ra > 0 else "WEST")]):
                    if attempt == 1:
                        log.info("[%s] slew_to: parallèle %s n'a pas bougé, retry %s", self.name, "WEST" if d_ra > 0 else "EAST", direction)
                    else:
                        log.info("[%s] slew_to: puis parallèle %s %.1f° vers RA=%.2fh", self.name, direction, abs(d_ra), ra_hours)
                    before_ra = self.ra_hours
                    await self.move(direction, "MAX")
                    await asyncio.sleep(min(6.0, abs(d_ra) * 0.12))
                    await self.halt_move()
                    await asyncio.sleep(0.8)
                    if abs(self.ra_hours - before_ra) > 0.05:
                        break
                    if attempt == 0:
                        await asyncio.sleep(0.5)
            log.info("[%s] slew_to: après méridien/parallèle à RA=%.4fh DEC=%.2f° → GOTO", self.name, self.ra_hours, self.dec_deg)
        await self._slew_to_raw(ra_hours, dec_deg)
        await asyncio.sleep(1.5)
        if not self.slewing and abs(self.ra_hours - ra_hours) > 0.05 and abs(self.dec_deg - dec_deg) > 0.05:
            log.warning("[%s] slew_to: :MS# bloqué (resté RA=%.4fh DEC=%.2f°) → retry méridien/parallèle", self.name, self.ra_hours, self.dec_deg)
            # retry : on refait méridien puis parallèle
            d_dec2 = dec_deg - self.dec_deg
            if abs(d_dec2) > 1:
                await self.move("NORTH" if d_dec2 > 0 else "SOUTH", "FIND")
                await asyncio.sleep(min(3.0, abs(d_dec2) * 0.15))
                await self.halt_move()
                await asyncio.sleep(0.5)
            await self._slew_to_raw(ra_hours, dec_deg)

    async def _slew_to_raw(self, ra_hours: float, dec_deg: float) -> None:
        """GOTO brut: envoie les coords + trigger SLEW."""
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

        slew_prop = self._resolve_prop_name("MOUNT_ON_COORDINATES_SET")
        if slew_prop in self._properties:
            await self.send_switch(slew_prop, [{"name": "SLEW", "value": True}])

        self._start_move_poll()

    async def home(self) -> None:
        """Send HOME command to the mount.

        OnStep :hC# exige unparked et pas de slew/park Busy.
        On dé-parque auto (comme slew), abort si slewing, puis envoie HOME.
        Tries INDIGO v2.0 (MOUNT_HOME / HOME) then INDI legacy
        (TELESCOPE_HOME / GO, FIND, SET).
        """
        log.info("[%s] home: demandé (parked=%s tracking=%s slewing=%s homing=%s)",
                 self.name, self.parked, self.tracking, self.slewing, self.homing)
        if self.parked:
            log.info("[%s] home: parked → unpark auto avant home", self.name)
            await self.unpark()
            await asyncio.sleep(1.0)
            if self.parked:
                log.warning("[%s] home: still parked, annulé", self.name)
                return
        if self.slewing or self.homing:
            log.info("[%s] home: slewing/homing → abort avant home", self.name)
            await self.abort()
            await asyncio.sleep(0.8)
        # Si un home est déjà Busy côté serveur, l'abort précédent l'a libéré
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
            # OneOfMany mono-item suffit, mais on gère le bi-item comme park
            # pour les drivers à 2 items (ex. HOME/UNHOME).
            if pv.get_item(item) and len(pv.items) == 1:
                log.info("[%s] home: sending %s.%s=On", self.name, home_prop, item)
                await self.send_switch(home_prop, [{"name": item, "value": True}])
            elif len(pv.items) >= 2:
                # Envoie l'item cible On, les autres Off (règle OneOfMany)
                items = [{"name": it.name, "value": it.name == item} for it in pv.items]
                log.info("[%s] home: sending %s bi-item %s", self.name, home_prop, items)
                await self.send_switch(home_prop, items)
            else:
                log.info("[%s] home: sending %s.%s=On (fallback)", self.name, home_prop, item)
                await self.send_switch(home_prop, [{"name": item, "value": True}])
            self._start_move_poll()
        else:
            log.warning("[%s] home: no HOME property found in %s",
                        self.name, list(self._properties.keys()))

    async def set_park_position(self) -> None:
        """Mémorise la position actuelle comme position de PARK."""
        for prop_name in ("MOUNT_PARK_SET", "TELESCOPE_PARK_SET", "MOUNT_PARK_POSITION_SET"):
            pv = self._properties.get(prop_name)
            if pv is not None:
                for cand in ("SET", "PARK_SET", "SET_PARK", "PARK"):
                    if pv.get_item(cand):
                        log.info("[%s] set park position via %s.%s", self.name, prop_name, cand)
                        await self.send_switch(prop_name, [{"name": cand, "value": True}])
                        return
        # Fallback: certains drivers utilisent MOUNT_PARK avec item SET
        park_prop = self._resolve_prop_name("MOUNT_PARK")
        pv = self._properties.get(park_prop)
        if pv and pv.get_item("SET"):
            await self.send_switch(park_prop, [{"name": "SET", "value": True}])
            log.info("[%s] set park position via %s.SET", self.name, park_prop)
            return
        log.warning("[%s] set_park: no PARK_SET property found in %s", self.name, list(self._properties.keys()))

    async def set_home_position(self) -> None:
        """Mémorise la position actuelle comme position HOME."""
        for prop_name in ("MOUNT_HOME_SET", "TELESCOPE_HOME_SET", "MOUNT_HOME_POSITION_SET"):
            pv = self._properties.get(prop_name)
            if pv is not None:
                for cand in ("SET", "HOME_SET", "SET_HOME", "HOME"):
                    if pv.get_item(cand):
                        log.info("[%s] set home position via %s.%s", self.name, prop_name, cand)
                        await self.send_switch(prop_name, [{"name": cand, "value": True}])
                        return
        home_prop = self._resolve_prop_name("MOUNT_HOME")
        pv = self._properties.get(home_prop)
        if pv and pv.get_item("SET"):
            await self.send_switch(home_prop, [{"name": "SET", "value": True}])
            log.info("[%s] set home position via %s.SET", self.name, home_prop)
            return
        log.warning("[%s] set_home: no HOME_SET property found in %s", self.name, list(self._properties.keys()))

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
            pv = self._properties.get(motion_prop)
            if pv and pv.get_item("MOTION_NORTH"):
                on = "MOTION_NORTH" if d == "N" else "MOTION_SOUTH"
                off = "MOTION_SOUTH" if d == "N" else "MOTION_NORTH"
            else:
                on = "NORTH" if d == "N" else "SOUTH"
                off = "SOUTH" if d == "N" else "NORTH"
            # AtMostOne : envoyer les deux items explicitement
            if pv and len(pv.items) >= 2:
                await self.send_switch(motion_prop, [{"name": on, "value": True}, {"name": off, "value": False}])
            else:
                await self.send_switch(motion_prop, [{"name": on, "value": True}])
        elif d in ("E", "W"):
            motion_prop = self._resolve_prop_name("MOUNT_MOTION_RA")
            pv = self._properties.get(motion_prop)
            if pv and pv.get_item("MOTION_EAST"):
                on = "MOTION_EAST" if d == "E" else "MOTION_WEST"
                off = "MOTION_WEST" if d == "E" else "MOTION_EAST"
            else:
                on = "EAST" if d == "E" else "WEST"
                off = "WEST" if d == "E" else "EAST"
            if pv and len(pv.items) >= 2:
                await self.send_switch(motion_prop, [{"name": on, "value": True}, {"name": off, "value": False}])
            else:
                await self.send_switch(motion_prop, [{"name": on, "value": True}])
        # Poll coordinates during the move
        self._start_move_poll()

    def _start_move_poll(self) -> None:
        """Start a background task that monitors coordinate stabilization.

        Runs every 500ms and checks if coords have stabilized (no change
        for 3 consecutive checks).  Coordinate updates come from INDIGO
        push-based set*Vector messages — no explicit polling needed.
        """
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
                poll_count += 1
                # During GOTO: detect slew completion by coordinate stabilization
                # OnStep met ~3s pour un slew 47° — éviter de clearer à 0.3s au départ
                if self.slewing and self._target_ra is not None:
                    ra_diff = abs(self.ra_hours - self._prev_ra) * 15
                    dec_diff = abs(self.dec_deg - self._prev_dec)
                    if ra_diff < 0.01 and dec_diff < 0.01 and poll_count > 10:
                        stable_count += 1
                    else:
                        stable_count = 0
                    self._prev_ra = self.ra_hours
                    self._prev_dec = self.dec_deg
                    if stable_count >= 5:
                        self.slewing = False
                        self._target_ra = None
                        self._target_dec = None
                        log.info("[%s] slew complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        self._stop_move_poll()
                        return
                # During HOME: detect homing completion by coordinate stabilization
                # OnStep peut rester Busy 30-60s au pôle — on attend que les
                # coordonnées se stabilisent ET que l'état serveur ne soit plus Busy.
                elif self.homing:
                    ra_diff = abs(self.ra_hours - self._prev_ra) * 15
                    dec_diff = abs(self.dec_deg - self._prev_dec)
                    # Seuil plus long que pour le slew : le HOME met du temps à démarrer
                    if ra_diff < 0.01 and dec_diff < 0.01 and poll_count > 10:
                        stable_count += 1
                    else:
                        stable_count = 0
                    self._prev_ra = self.ra_hours
                    self._prev_dec = self.dec_deg
                    # Vérifie l'état serveur si disponible (évite de couper trop tôt en Busy)
                    home_state_busy = False
                    try:
                        hp = self._properties.get(self._resolve_prop_name("MOUNT_HOME"))
                        if hp and (hp.state or "").lower() == "busy":
                            home_state_busy = True
                    except Exception:
                        pass
                    if stable_count >= 5 and not home_state_busy:
                        self.homing = False
                        log.info("[%s] homing complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        self._stop_move_poll()
                        return
                    # Timeout 30s : évite de bloquer l'UI à vie si HOME échoue (Alert ou driver coincé)
                    if poll_count > 300:
                        self.homing = False
                        log.warning("[%s] homing timeout après 30s (state Busy=%s) — débloqué", self.name, home_state_busy)
                        self._stop_move_poll()
                        return
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            pass

    async def halt_move(self) -> None:
        self._stop_move_poll()
        # Stop manual motion : mettre les deux axes à Off
        for prop_key in ("MOUNT_MOTION_DEC", "MOUNT_MOTION_RA"):
            prop = self._resolve_prop_name(prop_key)
            pv = self._properties.get(prop)
            if pv and len(pv.items) >= 2:
                try:
                    await self.send_switch(prop, [{"name": it.name, "value": False} for it in pv.items])
                except Exception:  # noqa: BLE001
                    pass
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
