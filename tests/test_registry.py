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

    async def send_new_switch(self, device, prop, items):
        # Async comme le vrai client : le corps s'exécute dans la coroutine
        # (cf. _schedule_connect qui enveloppe l'envoi pour logger les erreurs).
        self.sent.append((device, prop, items))
        return None


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
        # Exécute vraiment la coroutine (comme la boucle prod) au lieu de
        # la fermer : sinon les envois enveloppés ne partent jamais en test.
        try:
            asyncio.run(coro)
        except RuntimeError:
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


def test_guider_companion_not_upgraded_to_camera():
    """INDIGO « Foo (guider) » = interface GUIDER_*, jamais un CCD.

    Régression terrain : « SVBONY SV305PRO (guider) » était upgradé en
    Camera via le mot-clé « svbony », sans CCD_EXPOSURE → boucle guidage
    en « non prête » infinie.
    """
    from indigo.devices.camera import Camera

    reg, client = make_registry()
    pv = connection_pv("On", VectorType.SWITCH)
    pv.device = "SVBONY SV305PRO (guider)"
    reg._on_def("1", pv)
    dev = reg.get("SVBONY SV305PRO (guider)")
    assert dev is not None
    assert not isinstance(dev, Camera)

    # Une prop GUIDER_* ne doit pas non plus le transformer en Camera.
    gpv = PropertyVector(
        device="SVBONY SV305PRO (guider)",
        name="GUIDER_GUIDE_RA",
        vector_type=VectorType.SWITCH,
        state="Ok",
    )
    gpv.items.append(Item(name="EAST", value=0.0))
    reg._on_def("2", gpv)
    assert not isinstance(reg.get("SVBONY SV305PRO (guider)"), Camera)


def test_real_camera_still_upgraded_by_name():
    """Une vraie caméra sans props CCD reçues yet reste un Camera via le nom."""
    from indigo.devices.camera import Camera

    reg, client = make_registry()
    pv = connection_pv("On", VectorType.SWITCH)
    pv.device = "SVBONY SV305PRO"
    reg._on_def("1", pv)
    assert isinstance(reg.get("SVBONY SV305PRO"), Camera)
