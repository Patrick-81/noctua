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
    "TELESCOPE_MOTION_NS",
    "TELESCOPE_MOTION_WE",
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
        self.homed: bool = False  # reste vrai après un home réussi (LED verte)
        self._home_busy_seen: bool = False  # Busy vu pendant le home en cours
        self._home_start_ra: float = 0.0
        self._home_start_dec: float = 0.0
        # GOTO target (to detect slew completion)
        self._target_ra: float | None = None
        self._target_dec: float | None = None
        self._slew_seq: int = 0
        self._prev_ra: float = 0.0
        self._prev_dec: float = 0.0
        # Manual move polling
        self._move_poll_task: asyncio.Task | None = None
        # Garde anti-concurrents park/unpark/home : deux POST simultanés
        # (double-clic UI, slew auto + bouton) entrelaçaient les envois et
        # les polls lisait/écrivait parked/homed en course → aléatoire.
        self._mount_op: str | None = None

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
            log.info("[%s] home state=%s msg='%s'", self.name, pv.state, getattr(pv, "message", "") or "")

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
        # Un mount parké ne suit pas physiquement : OnStep coupe le suivi
        # au :hP# sans pousser MOUNT_TRACKING. Sans ça, TRACK+PARK restent
        # allumés ensemble côté UI alors que la monture est immobile.
        if new_parked and self.tracking:
            log.info("[%s] park: parked → tracking False (le park coupe le suivi)", self.name)
            self.tracking = False

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
        if not self.homing:
            return
        if state == "busy":
            self._home_busy_seen = True
            return
        if state == "alert":
            self.homing = False
            self.homed = False
            msg = getattr(pv, "message", "") or ""
            log.warning("[%s] home: Alert driver msg='%s' — home non confirmé", self.name, msg)
            return
        # Ok (ou état vide) : ne valider que si le driver a réellement agi
        # (Busy vu) ou si la monture a bougé. Un Ok immédiat sans Busy ni
        # mouvement = commande ignorée (ex. :hC# refusé car parking/homing
        # ou mouvement en cours) — laisser le poll déclarer l'échec au lieu
        # d'allumer la LED verte à tort (symptôme "home ne réagit plus"
        # suivi d'un faux succès).
        moved_ra = abs(self.ra_hours - self._home_start_ra) * 15.0
        moved_dec = abs(self.dec_deg - self._home_start_dec)
        if self._home_busy_seen or moved_ra > 0.05 or moved_dec > 0.05:
            self.homing = False
            self.homed = True
        else:
            log.debug("[%s] home: Ok sans Busy ni mouvement — en attente du poll", self.name)

    # ── Commands ─────────────────────────────────────────────────

    async def abort(self) -> None:
        abort_prop = self._resolve_prop_name("MOUNT_ABORT_MOTION")
        item = self._resolve_item_name(abort_prop, "ABORT_MOTION", {
            "ABORT_MOTION": "ABORT",
        })
        await self.send_switch(abort_prop, [{ "name": item, "value": True }])
        self.slewing = False
        if self.homing:
            self.homed = False  # home interrompu = pas homed
            self._home_busy_seen = False
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

    def _coords_busy(self) -> bool:
        """True si le driver signale des coordonnées en mouvement (slew/park en cours)."""
        try:
            cp = self._properties.get(self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES"))
            return bool(cp and (cp.state or "").lower() == "busy")
        except Exception:
            return False

    def _coords_stable_step(self, prev: tuple[float, float]) -> tuple[bool, tuple[float, float]]:
        """Un pas de stabilité coords (seuils _ensure_motion_stopped)."""
        dra = abs(self.ra_hours - prev[0]) * 15.0
        dd = abs(self.dec_deg - prev[1])
        cur = (self.ra_hours, self.dec_deg)
        return (dra < 0.005 and dd < 0.005, cur)

    async def _park_poll(self, timeout_s: float = 20.0) -> str:
        """Poll après envoi du :hP#. Retourne 'ok' | 'refused' | 'timeout'.

        'refused' = le driver a répondu puis est revenu à UNPARKED/Ok
        (vu 12:05:17 : Busy/Parking puis revert immédiat) — inutile
        d'attendre tout le timeout, il faut settle puis réessayer.
        'refused' aussi si après ~4s le driver est idle (state Ok, jamais
        Busy, parked inchangé) : la commande a été ignorée (:hP# pendant
        un mouvement ou tracking inadapté) — retry immédiat au lieu de
        bloquer l'HTTP 20s.
        """
        seen_parking = self.parked
        initial_parked = self.parked
        steps = int(timeout_s / 0.5)
        stable = 0
        prev = (self.ra_hours, self.dec_deg)
        for i in range(steps):
            await asyncio.sleep(0.5)
            if self.parked and self.park_state == "Ok":
                log.info("[%s] park: success (parked True, state Ok)", self.name)
                return "ok"
            if self.parked and self.park_state not in ("Busy", "Alert"):
                log.info("[%s] park: success parked True state=%s", self.name, self.park_state)
                return "ok"
            if self.parked:
                seen_parking = True
            if seen_parking and not self.parked and self.park_state == "Ok":
                log.warning("[%s] park: refusé par le driver (revert UNPARKED/Ok après Parking)", self.name)
                return "refused"
            if (i >= 7 and self.parked == initial_parked and not seen_parking
                    and (self.park_state or "Ok") == "Ok"):
                log.warning("[%s] park: driver idle après 4s (state Ok, sans Busy) — commande ignorée ?", self.name)
                return "refused"
            # Accept précoce : OnStep ne repasse jamais à Ok après :hP#
            # (Alert 'Parking' puis Alert '' persistant, vu Mount LX200).
            # PARKED acquis + coords immobiles + coords non Busy = le slew
            # de parking physique est terminé → inutile d'attendre 20s.
            ok_step, prev = self._coords_stable_step(prev)
            if (self.parked and self.park_state == "Alert"
                    and ok_step and not self._coords_busy()):
                stable += 1
                if stable >= 12:  # 6 s immobile sous Alert
                    log.info("[%s] park: success (parked True, Alert persistant + coords stables)", self.name)
                    return "ok"
            else:
                stable = 0
        if self.parked and self.park_state == "Alert":
            # OnStep laisse parfois Alert avec msg '' après parking — on l'accepte comme succès si parked True
            msg = getattr(self._properties.get(self._resolve_prop_name("MOUNT_PARK")), "message", "")
            log.warning("[%s] park: Alert persistant après %.0fs (msg='%s') mais parked True → accepté", self.name, timeout_s, msg)
            return "ok"
        if self.parked:
            log.info("[%s] park: success Busy→%s (après poll)", self.name, self.park_state)
            return "ok"
        return "timeout"

    async def _wait_mount_op(self, waiter: str, timeout: float = 30.0) -> bool:
        """Attend la fin d'une op park/unpark/home en cours.

        Retourne True si libre. Évite qu'un HOME/SLEW cliqué pendant un
        unpark (20 s sous Alert persistant avant le fix) soit silencieusement
        ignoré — symptôme "home ne fonctionne plus".
        """
        waited = 0.0
        while self._mount_op is not None and waited < timeout:
            await asyncio.sleep(0.5)
            waited += 0.5
        if self._mount_op is not None:
            log.warning("[%s] %s: op %s toujours active après %.0fs — ignoré",
                        self.name, waiter, self._mount_op, timeout)
            return False
        return True

    async def park(self) -> None:
        if not await self._wait_mount_op("park"):
            return
        if self.parked and self.park_state != "Busy":
            log.info("[%s] park: déjà parké (state=%s) — rien à faire", self.name, self.park_state)
            return
        self._mount_op = "park"
        try:
            await self._park_impl()
        finally:
            self._mount_op = None

    async def _park_impl(self) -> None:
        self.homed = False  # le park quitte la home position
        # Abort si Busy (park/homing/slewing) — sinon INDIGO ignore le park (mount_park_callback check !parking&&!homing)
        if self.park_state == "Busy" or self.homing or self.slewing:
            log.info("[%s] park: Busy/homing/slewing → abort avant park", self.name)
            await self.abort()
            await self._ensure_motion_stopped()
        # Sortie de pôle au JOYSTICK (pas de :MS# : singulier à DEC 90°, et
        # l'abort d'un palier :MS# laisse un mouvement résiduel qui fait
        # rejeter le :hP# — revert PARKED→UNPARKED vu le 12:05:17).
        if abs(self.dec_deg) > 85.0:
            log.info("[%s] park: pôle DEC %.1f° → joystick SOUTH avant park", self.name, self.dec_deg)
            await self.move("SOUTH", "MAX")
            await asyncio.sleep(min(10.0, abs(self.dec_deg - 80.0) * 0.9))
            await self.halt_move()
            await self._ensure_motion_stopped()
            log.info("[%s] park: après sortie pôle à RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
        # Tracking : on ne le touche PLUS avant park. Le park via frontend
        # INDIGO (qui ne modifie pas le tracking, typiquement ON) passe,
        # tandis que notre passage forcé à OFF était suivi d'un NACK
        # systématique (:hP# revert UNPARKED en 1s). Hypothèse : OnStep ou le
        # driver exige le suivi actif pour accepter le park. Le retry
        # ci-dessous force tracking ON si le premier envoi est refusé.
        log.info("[%s] park: envoi avec tracking=%s (inchangé)", self.name, self.tracking)
        await self._ensure_motion_stopped(timeout=5.0)
        pv = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        target = "PARKED" if pv and any(it.name == "PARKED" for it in pv.items) else "PARK"
        await self._send_park_switch(target)
        # Poll jusqu'à 20s : OnStep :hP# peut mettre 5-15s à slewer vers le pôle.
        res = await self._park_poll(20.0)
        if res == "ok":
            return
        log.info("[%s] park: %s, settle + retry bi-item", self.name, res)
        await self._ensure_motion_stopped(timeout=5.0)
        if not self.tracking:
            log.info("[%s] park retry: tracking OFF → ON (le frontend park avec suivi actif)", self.name)
            await self.set_tracking(True)
            await asyncio.sleep(2.0)
            await self._ensure_motion_stopped(timeout=5.0)
        pv2 = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        if pv2 and len(pv2.items) >= 2:
            items = [{"name": it.name, "value": it.name == target} for it in pv2.items]
            await self.send_switch(self._resolve_prop_name("MOUNT_PARK"), items)
            res2 = await self._park_poll(20.0)
            if res2 == "ok":
                log.info("[%s] park: success après retry (tracking=%s)", self.name, self.tracking)
                return
            res = res2
        log.warning("[%s] park: échec (%s puis retry) — state=%s parked=%s tracking=%s (le park passe via frontend INDIGO : comparer état tracking/payload)",
                    self.name, res, self.park_state, self.parked, self.tracking)

    async def unpark(self) -> None:
        if not await self._wait_mount_op("unpark"):
            return
        if self.parked is False and self.park_state != "Busy":
            log.info("[%s] unpark: déjà déparké (state=%s) — rien à faire", self.name, self.park_state)
            return
        self._mount_op = "unpark"
        try:
            await self._unpark_impl()
        finally:
            self._mount_op = None

    async def _unpark_poll(self, timeout_s: float = 20.0) -> str:
        """Poll après envoi du :hR#. Retourne 'ok' | 'refused' | 'timeout'.

        'refused' si après ~4s le driver est idle (parked True, state Ok,
        jamais Busy) : le :hR# a été ignoré — retry bi-item immédiat au
        lieu de bloquer l'HTTP 20s. Accept précoce comme _park_poll :
        OnStep reste en Alert persistant ('Unparking' puis '') avec
        parked False correct — 3 s de coords stables suffisent (pas de
        slew physique au déparcage).
        """
        stable = 0
        prev = (self.ra_hours, self.dec_deg)
        for i in range(int(timeout_s / 0.5)):
            await asyncio.sleep(0.5)
            if self.parked is False and self.park_state == "Ok":
                log.info("[%s] unpark: success (parked False, state Ok)", self.name)
                return "ok"
            if self.parked is False and self.park_state not in ("Busy", "Alert"):
                log.info("[%s] unpark: success (parked False, state=%s)", self.name, self.park_state)
                return "ok"
            if i >= 7 and self.parked is True and (self.park_state or "Ok") == "Ok":
                log.warning("[%s] unpark: driver idle après 4s (toujours parked/Ok) — commande ignorée ?", self.name)
                return "refused"
            ok_step, prev = self._coords_stable_step(prev)
            if (self.parked is False and self.park_state == "Alert"
                    and ok_step and not self._coords_busy()):
                stable += 1
                if stable >= 6:  # 3 s immobile sous Alert
                    log.info("[%s] unpark: success (parked False, Alert persistant + coords stables)", self.name)
                    return "ok"
            else:
                stable = 0
        if not self.parked and self.park_state == "Alert":
            msg = getattr(self._properties.get(self._resolve_prop_name("MOUNT_PARK")), "message", "")
            log.warning("[%s] unpark: Alert persistant après %.0fs (msg='%s') mais parked False → accepté", self.name, timeout_s, msg)
            return "ok"
        if not self.parked:
            log.info("[%s] unpark: success after poll (parked False, state=%s)", self.name, self.park_state)
            return "ok"
        return "timeout"

    async def _unpark_impl(self) -> None:
        # :hR# ignoré si HOME/PARK Busy (indigo_mount_lx200.c:2774) MAIS
        # AUSSI pendant un slew/homing ou un mouvement joystick résiduel :
        # OnStep refuse alors sans répondre → "unpark ne fonctionne plus",
        # aléatoire selon l'état précédent. Abort large + settle systématique.
        busy = False
        home_pv = self._properties.get(self._resolve_prop_name("MOUNT_HOME"))
        if home_pv and (home_pv.state or "").lower() == "busy":
            busy = True
        if self.park_state == "Busy":
            busy = True
        if self.slewing or self.homing:
            busy = True
        try:
            cp = self._properties.get(self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES"))
            if cp and (cp.state or "").lower() == "busy":
                busy = True
        except Exception:
            pass
        if busy:
            log.info("[%s] unpark: Busy (HOME/PARK/slew/homing/coords) → abort avant unpark", self.name)
            await self.abort()
            await self._ensure_motion_stopped(timeout=5.0)
        else:
            await self._ensure_motion_stopped(timeout=5.0)
        pv = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        target = "UNPARKED" if pv and any(it.name == "UNPARKED" for it in pv.items) else "UNPARK"
        await self._send_park_switch(target)
        res = await self._unpark_poll(20.0)
        if res == "ok":
            return
        log.info("[%s] unpark: %s, settle + retry bi-item", self.name, res)
        await self._ensure_motion_stopped(timeout=5.0)
        pv2 = self._properties.get(self._resolve_prop_name("MOUNT_PARK"))
        if pv2 and len(pv2.items) >= 2:
            items = [{"name": it.name, "value": it.name == target} for it in pv2.items]
            log.info("[%s] unpark: sending bi-item %s", self.name, items)
            await self.send_switch(self._resolve_prop_name("MOUNT_PARK"), items)
            res2 = await self._unpark_poll(20.0)
            if res2 == "ok":
                return
            res = res2
        log.warning("[%s] unpark: échec (%s puis retry) — state=%s parked=%s", self.name, res, self.park_state, self.parked)

    async def slew_to(self, ra_hours: float, dec_deg: float) -> None:
        """GOTO: dé-parque, tracking ON, sort du pôle, puis slew — fallback move si :MS# bloqué."""
        log.info("[%s] slew_to: demandé RA=%.4fh DEC=%.2f° (actuel RA=%.4fh DEC=%.2f° parked=%s tracking=%s park_state=%s)", self.name, ra_hours, dec_deg, self.ra_hours, self.dec_deg, self.parked, self.tracking, self.park_state)
        # Garde anti-double-clic (vu 11:46:25 + 11:46:27) : même cible déjà
        # en cours → on ignore au lieu de relancer un slew concurrent.
        if self.slewing and self._target_ra is not None and self._target_dec is not None:
            _dra = abs(self._target_ra - ra_hours) * 15.0
            if _dra > 180:
                _dra = 360 - _dra
            if _dra < 0.05 and abs(self._target_dec - dec_deg) < 0.05:
                log.info("[%s] slew_to: même cible déjà en cours, ignoré", self.name)
                return
        if self.parked or self.park_state in ("Busy", "Alert"):
            log.info("[%s] slew_to: parked/busy/alert → unpark auto avant slew", self.name)
            await self.unpark()
            await asyncio.sleep(1.0)
            if self.parked or self.park_state in ("Busy", "Alert"):
                # Dernier recours : abort puis réessai unpark
                log.warning("[%s] slew_to: still parked/alert (%s/%s) après unpark → abort+retry", self.name, self.parked, self.park_state)
                await self.abort()
                await asyncio.sleep(1.0)
                await self.unpark()
                await asyncio.sleep(1.0)
            if self.parked:
                log.warning("[%s] slew_to: still parked/busy/alert (%s/%s), slew annulé", self.name, self.parked, self.park_state)
                return
            # Si Alert persiste mais parked False, on tente quand même le slew (OnStep laisse Alert 'Unparking')
            if self.park_state == "Alert":
                log.warning("[%s] slew_to: Alert persistant mais parked False → on tente le slew", self.name)
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
        # Sortie de pôle : OnStep à DEC>85° refuse le :MS# lointain (vu 89.98°→55° bloqué).
        # Palier intermédiaire 80° puis GOTO final. (Le park a sa propre
        # sortie de pôle au joystick dans park() — le :MS# y est proscrit.)
        if abs(self.dec_deg) > 85.0 and abs(dec_deg - self.dec_deg) > 10.0:
            mid_dec = 80.0 if dec_deg < 80 else 75.0
            log.info("[%s] slew_to: pôle DEC %.1f° → palier intermédiaire %.1f° avant cible %.1f°", self.name, self.dec_deg, mid_dec, dec_deg)
            # À 89-90° le :MS# est singulier (RA indéfini) : le slew direct échoue même pour 10°.
            # On tente d'abord le slew, mais s'il reste à 90°, on bascule immédiatement en joystick SOUTH.
            if abs(self.dec_deg) > 89.0:
                log.info("[%s] slew_to: pôle 90° → joystick direct (évite :MS# singulier)", self.name)
                await self.move("SOUTH", "MAX")
                await asyncio.sleep(min(10.0, abs(self.dec_deg - mid_dec) * 0.60))
                await self.halt_move()
                await asyncio.sleep(0.8)
                log.info("[%s] slew_to: après joystick pôle à RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
                if abs(self.dec_deg - 90.0) < 1.0:
                    # Encore au pôle → seconde tentative FIND plus lente
                    await self.move("SOUTH", "MAX")
                    await asyncio.sleep(6.0)
                    await self.halt_move()
                    await asyncio.sleep(0.8)
                    log.info("[%s] slew_to: après 2e joystick à RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
            else:
                await self._slew_to_raw(self.ra_hours, mid_dec)
                for _ in range(16):
                    await asyncio.sleep(0.5)
                    if not self.slewing:
                        break
                log.info("[%s] slew_to: après palier à RA=%.4fh DEC=%.2f° (slewing=%s)", self.name, self.ra_hours, self.dec_deg, self.slewing)
                if abs(self.dec_deg - 89.98) < 2.0 and abs(self.dec_deg - mid_dec) > 2.0:
                    log.warning("[%s] slew_to: palier intermédiaire n'a pas bougé (resté %.1f°) → fallback joystick", self.name, self.dec_deg)
                    await self.move("SOUTH", "MAX")
                    await asyncio.sleep(6.0)
                    await self.halt_move()
                    await asyncio.sleep(0.8)
                    log.info("[%s] slew_to: après fallback joystick à RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
        elif abs(self.dec_deg - 87.0) < 5.0:
            # Sortie de pôle 87° : nudge DEC seul vers la cible. PAS de move
            # RA en joystick ici — au pôle le RA est singulier (pier side
            # inversé vu gamma Cas → opposé). Le RA est géré par le :MS#.
            d_dec = dec_deg - self.dec_deg
            if abs(d_dec) > 2.0:
                direction = "NORTH" if d_dec > 0 else "SOUTH"
                log.info("[%s] slew_to: pôle 87° → méridien %s %.1f°", self.name, direction, abs(d_dec))
                await self.move(direction, "MAX")
                await asyncio.sleep(min(10.0, abs(d_dec) * 0.45))
                await self.halt_move()
                await asyncio.sleep(0.8)
            log.info("[%s] slew_to: après méridien à RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
        # Génération anti-concurrents : un watchdog d'un GOTO précédent ne
        # doit pas joysticker pendant le nouveau slew (→ OnStep '8').
        self._slew_seq += 1
        seq = self._slew_seq
        await self._slew_to_raw(ra_hours, dec_deg)
        # Le suivi (complétion / rejet / retry) tourne en tâche de fond pour
        # ne pas bloquer l'HTTP : le poll ne déclare "rejeté" qu'après 8s
        # stables loin de la cible (le flip met plusieurs s à démarrer).
        try:
            asyncio.get_running_loop().create_task(
                self._slew_watchdog(ra_hours, dec_deg, seq))
        except RuntimeError:
            pass

    async def _slew_watchdog(self, ra_hours: float, dec_deg: float, seq: int) -> None:
        """Attend la fin du slew puis retry si :MS# rejeté (fond, non bloquant)."""
        for _ in range(20):
            await asyncio.sleep(0.5)
            if not self.slewing:
                break
        if seq != self._slew_seq:
            log.info("[%s] watchdog: nouveau GOTO depuis, retry annulé", self.name)
            return
        if self.slewing:
            return  # slew en cours (flip long) : le poll suit
        d_ra_chk = abs(self.ra_hours - ra_hours) * 15.0
        if d_ra_chk > 180:
            d_ra_chk = 360 - d_ra_chk
        d_dec_chk = abs(self.dec_deg - dec_deg)
        if d_ra_chk < 0.05 and d_dec_chk < 0.05:
            log.info("[%s] slew_to: sur cible RA=%.4fh DEC=%.2f°", self.name, self.ra_hours, self.dec_deg)
        else:
            log.warning("[%s] slew_to: :MS# rejeté (resté RA=%.4fh DEC=%.2f°) → retry", self.name, self.ra_hours, self.dec_deg)
            await self._slew_retry_small(ra_hours, dec_deg)

    async def _slew_retry_small(self, ra_hours: float, dec_deg: float) -> None:
        """Retry après :MS# rejeté : joystick DEC seul si petit résidu, jamais de RA large.

        Un grand écart RA (>30°) = traversée du méridien (flip monture
        allemande, vu 12.4h→0.9h gamma Cas) : le joystick EAST/WEST ne peut
        pas flipper et partait à l'opposé. On re-tente juste le :MS#
        (c'est lui qui flippe) — sinon on laisse la main (/api/mount/flip).
        """
        d_dec2 = dec_deg - self.dec_deg
        if abs(d_dec2) > 1:
            await self.move("NORTH" if d_dec2 > 0 else "SOUTH", "MAX")
            await asyncio.sleep(min(8.0, abs(d_dec2) * 0.45))
            await self.halt_move()
            await asyncio.sleep(0.8)
        d_ra2 = (ra_hours - self.ra_hours) * 15.0
        if d_ra2 > 180:
            d_ra2 -= 360
        if d_ra2 < -180:
            d_ra2 += 360
        if abs(d_ra2) > 30.0:
            log.warning("[%s] slew_to retry: ΔRA=%.1f° large → pas de joystick RA (flip requis), re-:MS# direct", self.name, abs(d_ra2))
        elif abs(d_ra2) > 3.0:
            await self.move("WEST" if d_ra2 > 0 else "EAST", "MAX")
            await asyncio.sleep(min(8.0, abs(d_ra2) * 0.30))
            await self.halt_move()
            await asyncio.sleep(0.8)
        await self._slew_to_raw(ra_hours, dec_deg)

    async def _ensure_motion_stopped(self, timeout: float = 10.0) -> bool:
        """Attend l'arrêt complet du mouvement avant un :MS#.

        OnStep refuse le :MS# avec '8' (Already in motion) si le joystick
        précédent (ex. sortie de pôle) décélère encore. On attend coords
        stables 2 s + état serveur non Busy.
        """
        prev_ra, prev_dec = self.ra_hours, self.dec_deg
        stable = 0
        waited = 0.0
        while waited < timeout:
            await asyncio.sleep(0.5)
            waited += 0.5
            dra = abs(self.ra_hours - prev_ra) * 15.0
            dd = abs(self.dec_deg - prev_dec)
            prev_ra, prev_dec = self.ra_hours, self.dec_deg
            busy = False
            try:
                cp = self._properties.get(self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES"))
                if cp and (cp.state or "").lower() == "busy":
                    busy = True
            except Exception:
                pass
            if dra < 0.005 and dd < 0.005 and not busy and not self.homing:
                stable += 1
                if stable >= 4:
                    return True
            else:
                stable = 0
        log.warning("[%s] slew: mouvement toujours actif après %.0fs, on tente quand même", self.name, timeout)
        return False

    async def _slew_to_raw(self, ra_hours: float, dec_deg: float) -> None:
        """GOTO brut: stoppe, arme le trigger PUIS envoie les coords.

        Ordre imposé par le driver (indigo_mount_lx200.c
        mount_eq_coords_callback) : il lit l'item ON_COORDINATES_SET au
        moment où les coords arrivent. Coords d'abord + trigger après =
        branche no-op (ni slew, ni erreur, coords Ok) — exactement le
        symptôme vu sur Mount LX200 OnStep (TRACK/SYNC, pas de SLEW).
        Et :MS# pendant un mouvement → OnStep '8' (Already in motion).
        """
        # 0. Laisser retomber tout mouvement (joystick/abort précédent)
        # AVANT de poser les flags (sinon le poll hérité conclut trop tôt).
        await self._ensure_motion_stopped()
        self.homed = False  # tout slew quitte la home position
        self.slewing = True
        self._target_ra = ra_hours
        self._target_dec = dec_deg
        self._prev_ra = self.ra_hours
        self._prev_dec = self.dec_deg
        # 1. Armer le trigger (SLEW, sinon TRACK) en bi-item OneOfMany.
        slew_prop = self._resolve_prop_name("MOUNT_ON_COORDINATES_SET")
        if slew_prop in self._properties:
            pv = self._properties[slew_prop]
            names = [it.name for it in pv.items]
            on = "SLEW" if "SLEW" in names else ("TRACK" if "TRACK" in names else None)
            if on is None:
                log.warning("[%s] slew: pas de trigger SLEW/TRACK dans %s (%s) — slew non déclenché", self.name, slew_prop, names)
            else:
                log.info("[%s] slew: trigger %s.%s=On avant coords", self.name, slew_prop, on)
                if len(names) >= 2:
                    await self.send_switch(slew_prop, [{"name": on, "value": True}] + [{"name": n, "value": False} for n in names if n != on])
                else:
                    await self.send_switch(slew_prop, [{"name": on, "value": True}])
                await asyncio.sleep(0.3)
        # 2. Coords : le driver tire :Sr/:Sd/:MS# à leur arrivée.
        coords_prop = self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES")
        items = [
            {"name": "RA", "value": ra_hours},
            {"name": "DEC", "value": dec_deg},
        ]
        await self.send_number(coords_prop, items)

        self._start_move_poll()

    async def home(self) -> None:
        """Send HOME command to the mount.

        OnStep :hC# exige unparked et pas de slew/park Busy.
        On dé-parque auto (comme slew), abort si slewing, puis envoie HOME.
        Tries INDIGO v2.0 (MOUNT_HOME / HOME) then INDI legacy
        (TELESCOPE_HOME / GO, FIND, SET).
        """
        if self.homing:
            log.info("[%s] home: homing déjà en cours, ignoré", self.name)
            return
        if not await self._wait_mount_op("home"):
            return
        self._mount_op = "home"
        try:
            await self._home_impl()
        finally:
            self._mount_op = None

    async def _home_impl(self) -> None:
        """Corps du home (voir home() pour la garde anti-concurrents)."""
        log.info("[%s] home: demandé (parked=%s tracking=%s slewing=%s homing=%s)",
                 self.name, self.parked, self.tracking, self.slewing, self.homing)
        self.homed = False
        if self.parked:
            log.info("[%s] home: parked → unpark auto avant home", self.name)
            # Appel direct à l'impl : home() détient déjà _mount_op,
            # unpark() public refuserait (garde anti-concurrents).
            await self._unpark_impl()
            await asyncio.sleep(1.0)
            if self.parked:
                log.warning("[%s] home: still parked, annulé", self.name)
                return
        if self.slewing or self.homing or self.park_state == "Busy":
            log.info("[%s] home: Busy (slewing/homing/park) → abort avant home", self.name)
            await self.abort()
            await asyncio.sleep(0.8)
        # NOTE (2026-09-22) : on a essayé de forcer tracking ON avant HOME
        # (hypothèse : OnStep :hC# exige le suivi, comme :hP#). Testé sur le
        # terrain : refus identique avec tracking OFF ou déjà ON → le
        # tracking n'est PAS le discriminant. On ne touche donc plus au
        # tracking ici (code historique qui fonctionnait quand
        # l'environnement le permettait) ; le refus vient du driver/contrôleur.
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
            self._home_busy_seen = False
            self._home_start_ra = self.ra_hours
            self._home_start_dec = self.dec_deg
            self._prev_ra = self.ra_hours
            self._prev_dec = self.dec_deg
            log.info("[%s] home: prop %s rule=%s state=%s items=%s", self.name, home_prop,
                     getattr(pv, "rule", "?"), pv.state,
                     [(it.name, it.value) for it in pv.items])
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

    async def move(self, direction: str, rate: str | None = None) -> None:
        """Start a manual move. direction: N/S/E/W or NORTH/SOUTH/EAST/WEST.

        ``rate`` est appliqué seulement s'il est fourni — ne plus écraser le
        rate déjà posé par la route HTTP avec un défaut « CENTERING » qui
        ne matche aucun item (joystick silencieux terrain).
        """
        self.homed = False  # joystick = sortie de home
        if rate:
            try:
                await self.set_slew_rate(rate)
                await asyncio.sleep(0.2)
            except Exception as e:  # noqa: BLE001
                log.warning("[%s] move: set_slew_rate(%s) failed: %s", self.name, rate, e)
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
                payload = [{"name": on, "value": True}, {"name": off, "value": False}]
            else:
                payload = [{"name": on, "value": True}]
            log.info("[%s] move %s → %s items=%s (prop_found=%s)",
                     self.name, direction, motion_prop, payload, pv is not None)
            await self.send_switch(motion_prop, payload)
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
                payload = [{"name": on, "value": True}, {"name": off, "value": False}]
            else:
                payload = [{"name": on, "value": True}]
            log.info("[%s] move %s → %s items=%s (prop_found=%s)",
                     self.name, direction, motion_prop, payload, pv is not None)
            await self.send_switch(motion_prop, payload)
        else:
            log.warning("[%s] move: unknown direction %r", self.name, direction)
            return
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
                # During GOTO: detect slew completion by coordinate approach,
                # NOT by mere stabilization. OnStep met plusieurs secondes à
                # démarrer (surtout pour un flip) : ne pas conclure avant 5s,
                # et ne jamais déclarer "complete" loin de la cible.
                if self.slewing and self._target_ra is not None:
                    ra_diff = abs(self.ra_hours - self._prev_ra) * 15
                    dec_diff = abs(self.dec_deg - self._prev_dec)
                    if ra_diff < 0.01 and dec_diff < 0.01 and poll_count > 50:
                        stable_count += 1
                    else:
                        stable_count = 0
                    self._prev_ra = self.ra_hours
                    self._prev_dec = self.dec_deg
                    t_ra_diff = abs(self.ra_hours - self._target_ra) * 15
                    # Wrap RA au plus court (0.9h vs 12.4h = 172°, pas 348°)
                    if t_ra_diff > 180:
                        t_ra_diff = 360 - t_ra_diff
                    t_dec_diff = abs(self.dec_deg - self._target_dec)
                    on_target = t_ra_diff < 0.05 and t_dec_diff < 0.05
                    if on_target and stable_count >= 10:
                        self.slewing = False
                        self._target_ra = None
                        self._target_dec = None
                        log.info("[%s] slew complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        self._stop_move_poll()
                        return
                    if not on_target and stable_count >= 10:
                        # Stable mais loin : vérifier l'état serveur avant de
                        # conclure. Si Busy, le slew est encore en cours.
                        busy = False
                        try:
                            cp = self._properties.get(self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES"))
                            if cp and (cp.state or "").lower() == "busy":
                                busy = True
                        except Exception:
                            pass
                        if busy:
                            stable_count = 0  # on attend la suite du slew
                        elif poll_count > 80:
                            self.slewing = False
                            # Remonte le motif driver (ex. OnStep 'Below horizon'
                            # ou limite méridien) : c'est lui qui dit pourquoi.
                            try:
                                cp2 = self._properties.get(self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES"))
                                cstate = cp2.state if cp2 else "?"
                                cmsg = (getattr(cp2, "message", "") or "")[:120]
                            except Exception:
                                cstate, cmsg = "?", ""
                            log.warning("[%s] slew rejeté/bloqué (stable loin cible: ΔRA=%.2f° ΔDEC=%.2f° coords=%s msg='%s')", self.name, t_ra_diff, t_dec_diff, cstate, cmsg)
                            self._target_ra = None
                            self._target_dec = None
                            self._stop_move_poll()
                            return
                    if poll_count > 600:
                        self.slewing = False
                        self._target_ra = None
                        self._target_dec = None
                        log.warning("[%s] slew timeout après 60s — débloqué", self.name)
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
                        moved_ra = abs(self.ra_hours - self._home_start_ra) * 15.0
                        moved_dec = abs(self.dec_deg - self._home_start_dec)
                        if self._home_busy_seen or moved_ra > 0.05 or moved_dec > 0.05:
                            self.homing = False
                            self.homed = True
                            log.info("[%s] homing complete: RA=%.4fh DEC=%.4f°", self.name, self.ra_hours, self.dec_deg)
                        else:
                            # Coords stables, jamais Busy, aucun mouvement :
                            # le driver a ignoré la commande — ne pas allumer la LED.
                            self.homing = False
                            self.homed = False
                            log.warning("[%s] home: stable sans Busy ni mouvement — commande probablement ignorée par le driver", self.name)
                        self._stop_move_poll()
                        return
                    # Timeout 100s : OnStep met ~75s pour homes (Busy 12:01:08 → Ok 12:02:23).
                    # Évite de bloquer l'UI à vie si HOME échoue (Alert ou driver coincé).
                    if poll_count > 1000:
                        self.homing = False
                        self._home_busy_seen = False
                        log.warning("[%s] homing timeout après 100s (state Busy=%s) — débloqué", self.name, home_state_busy)
                        self._stop_move_poll()
                        return
                else:
                    # Ni slew ni homing (ex. _parse_home a conclu, ou abort
                    # externe) : rien à surveiller, sortie propre au lieu
                    # de boucler à vie.
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
            prop = self._resolve_prop_name("MOUNT_EQUATORIAL_COORDINATES")
            await self.client.send_get_properties(self.name, prop)
        except Exception:
            pass

    async def set_slew_rate(self, rate_name: str) -> None:
        """Set slew rate by item name (e.g. 'Guide', 'Centering', 'Find', 'Max').

        Matching is case-insensitive: INDIGO LX200 exposes GUIDE/CENTERING/FIND/MAX
        while the UI sends Find/Centering — a strict compare turned every item Off
        and the mount never moved.
        """
        slew_prop = self._resolve_prop_name("MOUNT_SLEW_RATE")
        if slew_prop not in self._properties:
            log.debug("[%s] set_slew_rate: no %s in %s", self.name, slew_prop, list(self._properties))
            return
        pv = self._properties[slew_prop]
        want = (rate_name or "").strip().lower()
        matched = any(it.name.lower() == want for it in pv.items)
        if not matched:
            log.warning("[%s] set_slew_rate: no item matching %r in %s — keeping current rate",
                        self.name, rate_name, [it.name for it in pv.items])
            return
        items = [{"name": it.name, "value": it.name.lower() == want} for it in pv.items]
        log.info("[%s] set_slew_rate: %s → %s", self.name, slew_prop,
                 next((it["name"] for it in items if it["value"]), "?"))
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
            "homed": self.homed,
            "properties": list(self._properties.keys()),
            "props": self._serialize_properties(),
        }
