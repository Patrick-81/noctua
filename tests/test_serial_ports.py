"""Unit tests for serial-port scan helper (web.routers.hardware)."""

import os

from web.routers.hardware import _scan_serial_ports


def test_scan_returns_list_with_expected_keys():
    ports = _scan_serial_ports()
    assert isinstance(ports, list)
    for p in ports:
        assert "path" in p
        assert "by_id" in p
        assert "preferred" in p
        assert "description" in p
        assert "busy" in p
        assert "holders" in p
        assert p["path"].startswith("/dev/")
        assert isinstance(p["by_id"], list)
        assert isinstance(p["busy"], bool)


def test_scan_paths_exist_or_are_gone():
    ports = _scan_serial_ports()
    for p in ports:
        # Only nodes that still exist are listed (or vanished mid-scan).
        assert os.path.exists(p["path"]) or not p["path"].startswith("/dev/tty")


def test_preferred_is_by_id_when_available():
    ports = _scan_serial_ports()
    for p in ports:
        if p["by_id"]:
            assert p["preferred"] == p["by_id"][0]
        else:
            assert p["preferred"] == p["path"]


def test_scan_is_idempotent():
    a = _scan_serial_ports()
    b = _scan_serial_ports()
    assert [p["path"] for p in a] == [p["path"] for p in b]
