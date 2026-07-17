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

if TYPE_CHECKING:
    from .client import IndigoClient

log = logging.getLogger("indigo.registry")

# All device classes, in priority order for detection
DEVICE_CLASSES = [Mount, Camera, Focuser]


class DeviceRegistry:
    """Discovers and manages INDIGO devices."""

    def __init__(self, client: IndigoClient):
        self.client = client
        self._devices: dict[str, GenericDevice] = {}  # name → device
        self._drivers: list[dict] = []  # DRIVERS switch items
        self._auto_connecting: set[str] = set()  # devices we sent CONNECT to

        # Register callbacks on the client
        client.on_property_def = self._on_def
        client.on_property_set = self._on_set
        client.on_property_new = self._on_new
        client.on_property_del = self._on_del
        client.on_blob = self._on_blob
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

    def get_camera(self) -> Camera | None:
        for dev in self._devices.values():
            if isinstance(dev, Camera):
                return dev
        return None

    def get_focuser(self) -> Focuser | None:
        for dev in self._devices.values():
            if isinstance(dev, Focuser):
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
            log.info("All devices cleared (disconnected)")
            self._emit_state()

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
            log.info("DRIVERS: %s", [d["name"] for d in self._drivers])
            return

        # CONNECTION def — detect connection status + auto-connect
        if pv.name.upper() == "CONNECTION":
            dev = self._ensure_device(device_name)
            if dev:
                connect_item = pv.get_item("CONNECT") or pv.get_item("CONNECTED")
                if connect_item:
                    connected = str(connect_item.value).lower() in ("on", "true", "1")
                    dev.on_connection_status(connected)

                    # Auto-connect: if device is not connected, send CONNECT=On
                    if not connected and device_name not in self._auto_connecting:
                        self._auto_connecting.add(device_name)
                        log.info("Auto-connecting device: %s", device_name)
                        self._schedule_connect(device_name)

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
            log.info("[%s] CONNECTION set received: %s",
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
                    connected = str(connect_item.value).lower() in ("on", "true", "1")
                    dev.on_connection_status(connected)

            dev.on_set(tag, pv)
            self._emit_state()

    def _on_new(self, tag: str, pv: PropertyVector) -> None:
        """Handle a new*Vector — echo of our own commands."""
        pass

    def _on_del(self, device_name: str, prop_name: str) -> None:
        """Handle delProperty."""
        if prop_name:
            log.info("[%s] delProperty: %s", device_name, prop_name)
        if not prop_name:
            # Entire device removed
            if device_name in self._devices:
                del self._devices[device_name]
                log.info("Device removed: %s", device_name)
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
        dev = self._devices.get(device_name)
        if dev and isinstance(dev, Camera):
            dev.on_blob_data(prop_name, item_name, fmt, data)

    # ── Device creation ──────────────────────────────────────────

    def _ensure_device(self, name: str) -> BaseDevice | None:
        """Get or create a device by name."""
        if name in self._devices:
            return self._devices[name]

        dev = GenericDevice(name, self.client)
        self._devices[name] = dev
        log.info("New device discovered: '%s'", name)
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
                log.info("Device '%s' upgraded to %s", name, cls.__name__)
                if self.on_device_added:
                    self.on_device_added(real)
                return real

        return dev

    # ── Auto-connect ─────────────────────────────────────────────

    def _schedule_connect(self, device_name: str) -> None:
        """Schedule sending CONNECT=On to a device on the event loop."""
        if self.client._loop:
            asyncio.run_coroutine_threadsafe(
                self.client.send_new_switch(device_name, "CONNECTION", [
                    {"name": "CONNECT", "value": True},
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
