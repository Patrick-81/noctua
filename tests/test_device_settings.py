"""Tests for per-device settings persistence + full switch vectors."""
import asyncio
import sys
import tempfile
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, ROOT)

from indigo.devices.base import GenericDevice  # noqa: E402
from indigo.protocol import Item, PropertyVector, VectorType  # noqa: E402
from indigo.profiles import ProfileStore, DEVICE_SETTINGS_FIELD  # noqa: E402
from indigo.registry import DeviceRegistry, connection_vector  # noqa: E402
from web.routers.hardware import complete_switch_vector, _wait_connected_state  # noqa: E402


def _store():
    tmp = tempfile.mkdtemp()
    return ProfileStore(Path(tmp) / "profiles.yaml")


def test_upsert_keeps_device_settings():
    s = _store()
    r = s.upsert({"name": "Rig", "camera": "C",
                  "device_settings": {"C": {"CCD_MODE": {"RAW 16 1x1": True}}}})
    assert r["ok"] is True
    assert r["profile"][DEVICE_SETTINGS_FIELD] == {"C": {"CCD_MODE": {"RAW 16 1x1": True}}}


def test_upsert_cleans_device_settings():
    s = _store()
    r = s.upsert({"name": "Rig",
                  "device_settings": {"C": {"P": {"i": True}, "": {"x": 1}, "Q": {}},
                                       "": {"P": {"i": True}}, "D2": "nope"}})
    assert r["profile"][DEVICE_SETTINGS_FIELD] == {"C": {"P": {"i": True}}}


def test_upsert_defaults_empty_settings():
    s = _store()
    r = s.upsert({"name": "Rig", "camera": "C"})
    assert r["profile"][DEVICE_SETTINGS_FIELD] == {}


def test_set_device_settings_merge():
    s = _store()
    s.upsert({"name": "Rig"})
    r = s.set_device_settings("Rig", "C", {"CCD_GAIN": {"GAIN": 150}})
    assert r["ok"] is True
    assert r["device_settings"]["C"] == {"CCD_GAIN": {"GAIN": 150}}
    # unknown profile → error, store untouched
    assert "error" in s.set_device_settings("Nope", "C", {"P": {"i": True}})


def test_set_device_settings_clears_empty():
    s = _store()
    s.upsert({"name": "Rig", "device_settings": {"C": {"P": {"i": True}}}})
    r = s.set_device_settings("Rig", "C", {})
    assert r["ok"] is True
    assert "C" not in r["device_settings"]


def test_switch_exclusive_completed():
    full = complete_switch_vector("OneOfMany",
                                  [("RAW 8 1x1", True), ("RAW 16 1x1", False)],
                                  {"RAW 16 1x1": True})
    assert full == [{"name": "RAW 8 1x1", "value": False},
                    {"name": "RAW 16 1x1", "value": True}]


def test_switch_anyofmany_keeps_current():
    full = complete_switch_vector("AnyOfMany",
                                  [("A", True), ("B", False)],
                                  {"B": True})
    assert full == [{"name": "A", "value": True},
                    {"name": "B", "value": True}]


def test_switch_none_rule_defaults_exclusive():
    full = complete_switch_vector(None, [("A", True), ("B", False)], {"B": True})
    assert full == [{"name": "A", "value": False},
                    {"name": "B", "value": True}]


class _FakeDev:
    def __init__(self, connected):
        self.connected = connected


class _FakeRegistry:
    def __init__(self, dev):
        self._dev = dev

    def get(self, name):
        return self._dev


class _FakeServer:
    def __init__(self, dev):
        self.registry = _FakeRegistry(dev)


def test_wait_connected_already_there():
    srv = _FakeServer(_FakeDev(True))
    assert asyncio.run(_wait_connected_state(srv, "C", True, timeout_s=1.0)) is True


def test_wait_connected_timeout():
    srv = _FakeServer(_FakeDev(True))
    assert asyncio.run(_wait_connected_state(srv, "C", False, timeout_s=0.3)) is False


def test_wait_connected_flips():
    dev = _FakeDev(True)
    srv = _FakeServer(dev)

    async def _flip():
        await asyncio.sleep(0.1)
        dev.connected = False

    async def _main():
        t = asyncio.ensure_future(_flip())
        ok = await _wait_connected_state(srv, "C", False, timeout_s=2.0)
        await t
        return ok

    assert asyncio.run(_main()) is True


class _FakeClient:
    pass


def _registry_with_connected_cam():
    reg = DeviceRegistry(_FakeClient())
    dev = GenericDevice("SVBONY SV305PRO", None)
    dev.connected = True
    reg._devices["SVBONY SV305PRO"] = dev
    return reg


def _conn_def(off: bool):
    return PropertyVector(
        device="SVBONY SV305PRO", name="CONNECTION",
        vector_type=VectorType.SWITCH, state="Ok",
        items=[Item(name="CONNECTED", value=not off)])


def test_def_off_confirms_pending_disconnect():
    reg = _registry_with_connected_cam()
    reg._disconnecting.add("SVBONY SV305PRO")
    reg._on_def("defSwitchVector", _conn_def(off=True))
    assert reg._devices["SVBONY SV305PRO"].connected is False
    assert "SVBONY SV305PRO" not in reg._disconnecting


def test_def_off_stale_keeps_connected():
    reg = _registry_with_connected_cam()
    reg._on_def("defSwitchVector", _conn_def(off=True))
    assert reg._devices["SVBONY SV305PRO"].connected is True


def test_connection_vector_disconnect_sets_disconnected_on():
    full = connection_vector(["CONNECTED", "DISCONNECTED"], False)
    assert full == [{"name": "CONNECTED", "value": False},
                    {"name": "DISCONNECTED", "value": True}]


def test_connection_vector_connect_sets_connected_on():
    full = connection_vector(["CONNECTED", "DISCONNECTED"], True)
    assert full == [{"name": "CONNECTED", "value": True},
                    {"name": "DISCONNECTED", "value": False}]


def test_connection_vector_single_item():
    assert connection_vector(["CONNECT"], False) == [{"name": "CONNECT", "value": False}]
    assert connection_vector(["CONNECT"], True) == [{"name": "CONNECT", "value": True}]


if __name__ == "__main__":
    for fn in (test_upsert_keeps_device_settings, test_upsert_cleans_device_settings,
               test_upsert_defaults_empty_settings, test_set_device_settings_merge,
               test_set_device_settings_clears_empty, test_switch_exclusive_completed,
               test_switch_anyofmany_keeps_current, test_switch_none_rule_defaults_exclusive,
               test_wait_connected_already_there, test_wait_connected_timeout,
               test_wait_connected_flips, test_def_off_confirms_pending_disconnect,
               test_def_off_stale_keeps_connected,
               test_connection_vector_disconnect_sets_disconnected_on,
               test_connection_vector_connect_sets_connected_on,
               test_connection_vector_single_item):
        print(f"{fn.__name__} ...")
        fn()
    print("DEVICE SETTINGS OK")
