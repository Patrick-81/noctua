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
import time
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


class DeviceRegistry:
    """Discovers and manages INDIGO devices."""

    def __init__(self, client: IndigoClient):
        self.client = client
        self._devices: dict[str, GenericDevice] = {}  # name → device
        self._drivers: list[dict] = []  # DRIVERS switch items
        self._auto_connecting: set[str] = set()  # devices we sent CONNECT to
        self._connect_retries: dict[str, int] = {}  # device → retry count
        self._connect_item_names: dict[str, str] = {}  # device → item name for CONNECT
        self._connect_gave_up: dict[str, float] = {}  # device → time.time() when we gave up

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

    def all_devices(self) -> dict[str, BaseDevice]:
        return dict(self._devices)

    def drivers_list(self) -> list[dict]:
        return list(self._drivers)

    # ── Client callbacks ─────────────────────────────────────────

    def _on_connected(self, connected: bool) -> None:
        if not connected:
            self._devices.clear()
            self._auto_connecting.clear()
            self._connect_retries.clear()
            self._connect_item_names.clear()
            log.debug("All devices cleared (disconnected)")
            self._emit_state()
        else:
            # Reset retry state on fresh connection — auto-connect will re-fire from defConnection
            self._auto_connecting.clear()
            self._connect_retries.clear()
            self._connect_item_names.clear()

    def _on_def(self, tag: str, pv: PropertyVector) -> None:
        """Handle a def*Vector — discover or update device."""
        device_name = pv.device
        if not device_name:
            return

        # Track DRIVERS switch
        if pv.name.upper() == "DRIVERS":
            self._drivers = [
                {"name": item.name, "label": item.label}
                for item in pv.items
            ]
            log.debug("DRIVERS: %s", [d["name"] for d in self._drivers])
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
                    connected = str(connect_item.value).lower() in ("on", "true", "1")
                    dev.on_connection_status(connected)

                    # Remember the item name for retries
                    self._connect_item_names[device_name] = connect_item.name

                    # Auto-connect: if device is not connected, send CONNECT=On
                    # Skip if we recently gave up on this device (60s cooldown)
                    if not connected and device_name not in self._auto_connecting:
                        gave_up_at = self._connect_gave_up.get(device_name, 0)
                        if gave_up_at and time.time() - gave_up_at < 60:
                            log.info("Skipping auto-connect: %s (cooldown, gave up %.0fs ago)",
                                     device_name, time.time() - gave_up_at)
                        else:
                            self._auto_connecting.add(device_name)
                            # Preserve existing retry count if device has prior history
                            if device_name not in self._connect_retries:
                                self._connect_retries[device_name] = 0
                            log.info("Auto-connecting device: %s (item=%s, retries=%d)",
                                     device_name, connect_item.name,
                                     self._connect_retries[device_name])
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

                    # Update stored property
                    dev._properties[pv.name] = pv

                    if pv.state == "Alert":
                        # Connection failed — schedule retry (max 3)
                        # If we already gave up, ignore further Alerts
                        if device_name in self._connect_gave_up:
                            dev.on_connection_status(False)
                            dev._properties[pv.name] = pv
                            dev.on_set(tag, pv)
                            self._emit_state()
                            return
                        retries = self._connect_retries.get(device_name, 0)
                        if retries < 3:
                            self._connect_retries[device_name] = retries + 1
                            item_name = self._connect_item_names.get(device_name, "CONNECT")
                            log.warning("[%s] Connection failed, retry %d/3 in 5s",
                                        device_name, retries + 1)
                            if self.client._loop:
                                self.client._loop.call_later(
                                    5.0, lambda: self._schedule_connect(device_name, item_name))
                        else:
                            log.warning("[%s] Connection failed after 3 retries, giving up",
                                        device_name)
                            self._auto_connecting.discard(device_name)
                            self._connect_gave_up[device_name] = time.time()
                    elif connected:
                        # Connection Ok — schedule delayed confirmation
                        # (INDIGO may send Ok then Alert for devices that briefly accept)
                        def _confirm_connection(dname=device_name):
                            dev2 = self.get(dname)
                            if dev2 and dev2.connected:
                                self._auto_connecting.discard(dname)
                                self._connect_gave_up.pop(dname, None)
                                log.debug("[%s] Connection confirmed", dname)
                        if self.client._loop:
                            self.client._loop.call_later(3.0, _confirm_connection)

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
