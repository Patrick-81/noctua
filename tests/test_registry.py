"""
test_registry.py — Unit tests for DeviceRegistry CONNECTION handling.

Regression: def CONNECTION vectors are schemas (possibly stale) and must
never clobber the tracked connection state. Only set CONNECTION vectors
(server confirmations) update `dev.connected`.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from indigo.protocol import Item, PropertyVector, VectorType
from indigo.registry import DeviceRegistry


class _FakeCoro:
    def close(self):
        pass


class FakeLoop:
    def __init__(self):
        self.later = []

    def call_later(self, delay, cb):
        self.later.append(cb)


class FakeClient:
    """Minimal IndigoClient stand-in for registry unit tests."""

    def __init__(self):
        self._loop = None
        self.sent = []

    def send_new_switch(self, device, prop, items):
        self.sent.append((device, prop, items))
        return _FakeCoro()


def make_registry():
    client = FakeClient()
    reg = DeviceRegistry(client)
    client._loop = FakeLoop()
    return reg, client


def connection_pv(value, vector_type):
    pv = PropertyVector(
        device="Main Camera",
        name="CONNECTION",
        vector_type=vector_type,
        state="Ok",
    )
    pv.items.append(Item(name="CONNECT", value=value))
    return pv


@pytest.fixture
def record_schedules(monkeypatch):
    def fake_run_coroutine_threadsafe(coro, loop):
        if hasattr(coro, "close"):
            coro.close()
        return None

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe",
                        fake_run_coroutine_threadsafe)


def test_first_def_triggers_auto_connect(record_schedules):
    reg, client = make_registry()
    reg._on_def("1", connection_pv("Off", VectorType.SWITCH))
    dev = reg.get("Main Camera")
    assert dev is not None
    assert dev.connected is False
    assert client.sent == [
        ("Main Camera", "CONNECTION", [{"name": "CONNECT", "value": True}])
    ]


def test_set_on_marks_connected(record_schedules):
    reg, client = make_registry()
    reg._on_def("1", connection_pv("Off", VectorType.SWITCH))
    reg._on_set("2", connection_pv("On", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is True


def test_def_wave_does_not_clobber_connected_state(record_schedules):
    reg, client = make_registry()
    reg._on_def("1", connection_pv("Off", VectorType.SWITCH))
    reg._on_set("2", connection_pv("On", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is True

    # A fresh def wave (e.g. from a getProperties request) must not
    # reset the tracked state nor re-trigger auto-connect.
    client.sent.clear()
    reg._on_def("3", connection_pv("Off", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is True
    assert client.sent == []


def test_def_wave_after_confirmation_no_reconnect(record_schedules):
    reg, client = make_registry()
    reg._on_def("1", connection_pv("Off", VectorType.SWITCH))
    reg._on_set("2", connection_pv("On", VectorType.SWITCH))

    # Simulate the 3s confirmation firing.
    while client._loop.later:
        client._loop.later.pop()()

    client.sent.clear()
    reg._on_def("3", connection_pv("Off", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is True
    assert client.sent == []


def test_manual_disconnect_stays_disconnected(record_schedules):
    reg, client = make_registry()
    reg._on_def("1", connection_pv("Off", VectorType.SWITCH))
    reg._on_set("2", connection_pv("On", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is True

    # User disconnects: server confirms Off.
    reg._on_set("4", connection_pv("Off", VectorType.SWITCH))
    assert reg.get("Main Camera").connected is False
