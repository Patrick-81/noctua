"""Startup HOME behaviour when the mount is not parked.

Run via: pytest tests/test_startup_home.py
"""

import asyncio
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from web.server import WebServer  # noqa: E402


class FakeMount:
    def __init__(self, *, parked=False, tracking=False, homed=False):
        self.connected = True
        self.parked = parked
        self.tracking = tracking
        self.homed = homed
        self.homing = False
        self.ra_hours = 0.0
        self.dec_deg = 0.0
        self.home_called = False

    def get_prop(self, name):
        return object() if name in ("TELESCOPE_HOME", "MOUNT_HOME") else None

    async def home(self):
        self.home_called = True
        self.homed = True


class FakeRegistry:
    def __init__(self, mount):
        self._mount = mount

    def get_mount(self):
        return self._mount


def _server(mount, enabled=True):
    server = WebServer.__new__(WebServer)
    server.registry = FakeRegistry(mount)
    server.telescope = {"home_on_start": enabled}
    return server


async def _no_sleep(_delay):
    return None


def test_startup_home_sends_home_when_unparked(monkeypatch):
    mount = FakeMount()
    monkeypatch.setattr("web.server.asyncio.sleep", _no_sleep)
    asyncio.run(_server(mount)._home_mount_on_start())
    assert mount.home_called is True


def test_startup_home_skips_when_parked(monkeypatch):
    mount = FakeMount(parked=True)
    monkeypatch.setattr("web.server.asyncio.sleep", _no_sleep)
    asyncio.run(_server(mount)._home_mount_on_start())
    assert mount.home_called is False


def test_startup_home_skips_while_tracking(monkeypatch):
    mount = FakeMount(tracking=True)
    monkeypatch.setattr("web.server.asyncio.sleep", _no_sleep)
    asyncio.run(_server(mount)._home_mount_on_start())
    assert mount.home_called is False


def test_startup_home_disabled_by_config(monkeypatch):
    mount = FakeMount()
    monkeypatch.setattr("web.server.asyncio.sleep", _no_sleep)
    asyncio.run(_server(mount, enabled=False)._home_mount_on_start())
    assert mount.home_called is False
