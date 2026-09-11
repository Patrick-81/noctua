"""
registry.py — INDIGO device registry.

Listens for def*Vector messages from the INDIGO client, auto-detects
device types, creates device instances, and dispatches all messages
to the appropriate device.

This is the central hub that connects the protocol layer to device objects.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Callable

from .protocol import PropertyVector
from .devices.base import BaseDevice, GenericDevice
from .devices.mount import Mount
from .devices.camera import Camera
from .devices.focuser import Focuser
from .devices.filterwheel import FilterWheel

if TYPE_CHECKING:
    from .client import IndigoClient

log = logging.getLogger("indigo.registry")

# All device classes, in priority order for detection
DEVICE_CLASSES = [Mount, Camera, FilterWheel, Focuser]

# Property vectors listing the loadable drivers.
# - "DRIVERS" (device "Server"): legacy name used by old firmwares / mocks.
# - "AGENT_CONFIG_DRIVERS" (device "Configuration Agent"): INDIGO v2
#   (e.g. 2.0-374) exposes every loadable driver here (AnyOfMany, On=loaded).
DRIVER_VECTOR_NAMES = {"DRIVERS", "AGENT_CONFIG_DRIVERS"}

# Driver name prefixes (indigo_<category>_*) → UI category.
# UI roles use: mount, camera, guide_camera, focuser, filter_wheel.
DRIVER_CATEGORY_PREFIXES = {
    "mount": "mount",
    "ccd": "camera",
    "guider": "guide_camera",
    "focuser": "focuser",
    "wheel": "filter_wheel",
    "dome": "dome",
    "gps": "gps",
    "rotator": "rotator",
    "aux": "aux",
    "ao": "ao",
    "agent": "agent",
    "system": "system",
}

# Fallback keywords (name + label, lowercase) → category.
DRIVER_CATEGORY_KEYWORDS = [
    ("mount", ["mount", "telescope", "lx200", "onstep", "eqmod", "synscan",
               "ioptron", "celestron", "synta", "rainbow", "gemini", "temma",
               "starbook", "nexstar", "pmc8"]),
    ("camera", ["ccd", "camera", "qhy", "zwo", "asi", "sbig", "atik", "toup",
                "playerone", "svbony", "altair", "apogee", "omegon", "ogma",
                "dslr", "canon", "nikon", "sony"]),
    ("guide_camera", ["guider", "guide camera"]),
    ("focuser", ["focuser", "focus", "moonlite", "focusdream", "waf"]),
    ("filter_wheel", ["wheel", "filter"]),
    ("dome", ["dome"]),
    ("gps", ["gps"]),
    ("rotator", ["rotator"]),
]


def categorize_driver(name: str, label: str = "") -> str:
    """Return the UI category for a loadable INDIGO driver.

    Primary key: the ``indigo_<category>_`` prefix used by INDIGO v2
    drivers (``indigo_ccd_*`` → ``camera``, ``indigo_wheel_*`` →
    ``filter_wheel``, …).  Falls back to keyword matching on
    ``name`` + ``label``.  Unknown drivers → ``"other"``.
    """
    n = (name or "").lower()
    if n.startswith("indigo_"):
        rest = n[len("indigo_"):]
        prefix = rest.split("_", 1)[0] if rest else ""
        if prefix in DRIVER_CATEGORY_PREFIXES:
            return DRIVER_CATEGORY_PREFIXES[prefix]
    hay = f"{n} {(label or '').lower()}"
    for category, keywords in DRIVER_CATEGORY_KEYWORDS:
        if any(kw in hay for kw in keywords):
            return category
    return "other"


class DeviceRegistry:
    """Discovers and manages INDIGO devices."""

    def __init__(self, client: IndigoClient):
        self.client = client
        self._devices: dict[str, GenericDevice] = {}  # name → device
        self._drivers: list[dict] = []  # DRIVERS switch items
        self._auto_connecting: set[str] = set()  # devices we sent CONNECT to
        self._connect_item_names: dict[str, str] = {}  # device → item name for CONNECT

        # Register callbacks on the client
        client.on_property_def = self._on_def
        client.on_property_set = self._on_set
        client.on_property_new = self._on_new
        client.on_property_del = self._on_del
        client.on_blob = self._on_blob
        client.on_blob_url = self._on_blob_url
        client.on_connected = self._on_connected

        # External notification callback
        self.on_device_added: Callable[[BaseDevice], None] | None = None
        self.on_device_removed: Callable[[str], None] | None = None
        self.on_state_update: Callable[[dict], None] | None = None

    # ── Device access ────────────────────────────────────────────

    def get(self, name: str) -> BaseDevice | None:
        return self._devices.get(name)

    def get_mount(self) -> Mount | None:
        for dev in self._devices.values():
            if isinstance(dev, Mount):
                return dev
        return None

    def get_camera(self, name: str | None = None) -> Camera | None:
        for dev in self._devices.values():
            if isinstance(dev, Camera):
                if name is None or dev.name == name:
                    return dev
        return None

    def get_all_cameras(self) -> list[Camera]:
        return [dev for dev in self._devices.values() if isinstance(dev, Camera)]

    def get_focuser(self) -> Focuser | None:
        for dev in self._devices.values():
            if isinstance(dev, Focuser):
                return dev
        return None

    def get_filterwheel(self, name: str | None = None) -> FilterWheel | None:
        for dev in self._devices.values():
            if isinstance(dev, FilterWheel):
                if name is None or dev.name == name:
                    return dev
        return None

    def register_device_class(self, cls) -> None:
        """Enregistre une classe de device fournie par un plugin (P2.2)."""
        if cls not in DEVICE_CLASSES:
            DEVICE_CLASSES.append(cls)
            log.info("Device class registered by plugin: %s", cls.__name__)

    def all_devices(self) -> dict[str, BaseDevice]:
        return dict(self._devices)

    def drivers_list(self) -> list[dict]:
        return list(self._drivers)

    def drivers_grouped(self) -> dict[str, list[dict]]:
        """Drivers grouped by UI category (mount, camera, …)."""
        grouped: dict[str, list[dict]] = {}
        for d in self._drivers:
            grouped.setdefault(d.get("category", "other"), []).append(dict(d))
        return grouped

    def _store_drivers(self, pv: PropertyVector) -> None:
        """Store the loadable-drivers vector (def or set update).

        Fusionne les vecteurs legacy ``Server/DRIVERS`` et canonique
        ``Configuration Agent/AGENT_CONFIG_DRIVERS`` par nom de driver
        (le dernier état reçu gagne) au lieu d'écraser : un vrai serveur
        INDIGO v2 envoie les deux, et le legacy seul masquerait la
        diversité des drivers.
        """
        incoming = {
            item.name: {
                "name": item.name,
                "label": item.label or item.name,
                "loaded": bool(item.value),
                "category": categorize_driver(item.name, item.label),
            }
            for item in pv.items
        }
        merged = {d["name"]: dict(d) for d in self._drivers}
        merged.update(incoming)
        self._drivers = sorted(merged.values(), key=lambda d: d["name"])
        log.debug("DRIVERS (%s): %d drivers (fusionnés)", pv.name,
                  len(self._drivers))

    # ── Client callbacks ─────────────────────────────────────────

    def _on_connected(self, connected: bool) -> None:
        if not connected:
            self._devices.clear()
            self._drivers.clear()
            self._auto_connecting.clear()
            self._connect_item_names.clear()
            log.debug("All devices cleared (disconnected)")
            self._emit_state()
        else:
            self._drivers.clear()
            self._auto_connecting.clear()
            self._connect_item_names.clear()

    def _on_def(self, tag: str, pv: PropertyVector) -> None:
        """Handle a def*Vector — discover or update device."""
        device_name = pv.device
        if not device_name:
            return

        # Track loadable-drivers vectors:
        # - legacy "DRIVERS" (device "Server")
        # - INDIGO v2 "AGENT_CONFIG_DRIVERS" (device "Configuration Agent")
        if pv.name.upper() in DRIVER_VECTOR_NAMES:
            self._store_drivers(pv)
            return

        # CONNECTION def — detect connection status + auto-connect
        if pv.name.upper() == "CONNECTION":
            dev = self._ensure_device(device_name)
            if dev:
                if type(dev) is GenericDevice:
                    dev = self._upgrade_device(device_name, pv.name)

                # Store the CONNECTION property (needed for UI)
                dev._properties[pv.name] = pv

                connect_item = pv.get_item("CONNECT") or pv.get_item("CONNECTED")
                if connect_item:
                    self._connect_item_names[device_name] = connect_item.name
                    # def ne doit pas écraser un état déjà connecté (valeur stale Off),
                    # mais si le serveur déclare déjà On, on le prend en compte.
                    is_on = str(connect_item.value).lower() in ("on", "true", "1")
                    if is_on and not dev.connected:
                        dev.on_connection_status(True)
                        log.info("[%s] Connected (via def)", device_name)
                    elif not is_on and not dev.connected and device_name not in self._auto_connecting:
                        self._auto_connecting.add(device_name)
                        log.info("Auto-connecting device: %s (item=%s)",
                                 device_name, connect_item.name)
                        self._schedule_connect(device_name, connect_item.name)

                self._emit_state()
            return

        # Auto-detect device type from property
        dev = self._ensure_device(device_name)
        if dev:
            # Upgrade generic GenericDevice to specific type if needed
            if type(dev) is GenericDevice:
                dev = self._upgrade_device(device_name, pv.name)
            dev.on_def(tag, pv)
            self._emit_state()

    def _on_set(self, tag: str, pv: PropertyVector) -> None:
        """Handle a set*Vector — update device state."""
        device_name = pv.device
        if not device_name:
            return

        # Driver list updates (load/unload) arrive as set*Vector too:
        # keep the loadable-drivers list in sync so /api/drivers reflects
        # the server state, not just the initial def wave.
        if pv.name.upper() in DRIVER_VECTOR_NAMES:
            self._store_drivers(pv)
            self._emit_state()
            return

        if pv.name.upper() == "CONNECTION":
            log.debug("[%s] CONNECTION set received: %s",
                     device_name,
                     [(it.name, it.value) for it in pv.items])

        dev = self._ensure_device(device_name)
        if dev:
            # Upgrade generic GenericDevice to specific type if needed
            if type(dev) is GenericDevice:
                dev = self._upgrade_device(device_name, pv.name)

            # Connection status
            if pv.name.upper() == "CONNECTION":
                connect_item = pv.get_item("CONNECT") or pv.get_item("CONNECTED")
                if connect_item:
                    # State takes priority: Alert = failure even if value is On
                    if pv.state == "Alert":
                        connected = False
                    else:
                        connected = str(connect_item.value).lower() in ("on", "true", "1")
                    dev.on_connection_status(connected)
                    dev._properties[pv.name] = pv
                    # Pas de retry auto : on remonte l'erreur (port, etc.) et
                    # on laisse l'utilisateur corriger puis relancer manuellement.
                    # _auto_connecting reste posé pour éviter les storms de def.
                    if pv.state == "Alert":
                        msg = pv.message or ""
                        log.warning("[%s] Connection failed: %s", device_name, msg or "Alert")
                    elif connected:
                        log.info("[%s] Connected", device_name)
                    else:
                        log.info("[%s] Disconnected", device_name)

            dev.on_set(tag, pv)
            self._emit_state()

    def _on_new(self, tag: str, pv: PropertyVector) -> None:
        """Handle a new*Vector — echo of our own commands."""
        pass

    def _on_del(self, device_name: str, prop_name: str) -> None:
        """Handle delProperty."""
        if prop_name:
            log.debug("[%s] delProperty: %s", device_name, prop_name)
        if not prop_name:
            # Entire device removed
            if device_name in self._devices:
                del self._devices[device_name]
                log.debug("Device removed: %s", device_name)
                if self.on_device_removed:
                    self.on_device_removed(device_name)
                self._emit_state()
        else:
            dev = self._devices.get(device_name)
            if dev:
                dev.on_del(prop_name)

    def _on_blob(self, device_name: str, prop_name: str,
                 item_name: str, fmt: str, data: bytes) -> None:
        """Handle binary BLOB data (FITS image)."""
        log.debug("REGISTRY BLOB: device=%s prop=%s item=%s fmt=%s size=%d",
                 device_name, prop_name, item_name, fmt, len(data))
        dev = self._devices.get(device_name)
        if dev and isinstance(dev, Camera):
            dev.on_blob_data(prop_name, item_name, fmt, data)
        else:
            log.warning("REGISTRY BLOB: no Camera device '%s' found (dev=%s)", device_name, dev)

    def _on_blob_url(self, device_name: str, prop_name: str,
                     item_name: str, url: str) -> None:
        """Handle URL-based BLOB (INDIGO v2)."""
        dev = self._devices.get(device_name)
        if dev and isinstance(dev, Camera):
            dev.on_blob_url(prop_name, item_name, url)

    # ── Device creation ──────────────────────────────────────────

    def _ensure_device(self, name: str) -> BaseDevice | None:
        """Get or create a device by name."""
        if name in self._devices:
            return self._devices[name]

        dev = GenericDevice(name, self.client)
        self._devices[name] = dev
        log.debug("New device discovered: '%s'", name)
        return dev

    def _upgrade_device(self, name: str, prop_name: str) -> BaseDevice | None:
        """Upgrade a GenericDevice to the correct type based on property."""
        dev = self._devices.get(name)
        if dev is None or type(dev) is not GenericDevice:
            return dev

        for cls in DEVICE_CLASSES:
            temp = cls.__new__(cls)
            if temp.matches_property(prop_name):
                real = cls(name, self.client)
                real._properties = dev._properties
                real.connected = dev.connected
                self._devices[name] = real
                log.debug("Device '%s' upgraded to %s", name, cls.__name__)
                if self.on_device_added:
                    self.on_device_added(real)
                return real

        name_lower = name.lower()
        camera_keywords = ['svbony', 'asi', 'qhy', 'zwo', 'sbig', 'atik',
                           'toup', 'playerone', ' Mallin', 'fli', 'omegon',
                           'ogma', 'bresser', 'bresser', 'rising', 'ptp',
                           'uvc', 'sony', 'canon', 'nikon', 'olympus']
        for kw in camera_keywords:
            if kw in name_lower:
                real = Camera(name, self.client)
                real._properties = dev._properties
                real.connected = dev.connected
                self._devices[name] = real
                log.debug("Device '%s' upgraded to Camera (by name: '%s')", name, kw)
                if self.on_device_added:
                    self.on_device_added(real)
                return real

        if FilterWheel.matches_name(name):
            real = FilterWheel(name, self.client)
            real._properties = dev._properties
            real.connected = dev.connected
            self._devices[name] = real
            log.debug("Device '%s' upgraded to FilterWheel (by name)", name)
            if self.on_device_added:
                self.on_device_added(real)
            return real

        return dev

    # ── Auto-connect ─────────────────────────────────────────────

    def _schedule_connect(self, device_name: str, item_name: str = "CONNECT") -> None:
        """Schedule sending CONNECT=On to a device on the event loop.

        item_name: the actual switch item name from the def (CONNECT or CONNECTED).
        """
        if self.client._loop:
            asyncio.run_coroutine_threadsafe(
                self.client.send_new_switch(device_name, "CONNECTION", [
                    {"name": item_name, "value": True},
                ]),
                self.client._loop,
            )

    # ── State broadcasting ───────────────────────────────────────

    def _emit_state(self) -> None:
        """Call the state update callback with all device states."""
        if self.on_state_update:
            state = {
                name: dev.state_dict()
                for name, dev in self._devices.items()
            }
            self.on_state_update(state)
