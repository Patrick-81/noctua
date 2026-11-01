"""
test_server_manager.py — Unit tests for the INDI/INDIGO server lifecycle.

Covers: default commands, local-host detection, and the guard that prevents
starting a second server when one already runs on the local machine.

Run via: pytest tests/test_server_manager.py
"""

import asyncio
import os
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.server_manager import ServerManager  # noqa: E402


def test_default_commands_use_configured_port():
    assert ServerManager("indi", port=7625)._get_command() == [
        "indiserver", "-p", "7625",
    ]
    assert ServerManager("indigo", port=7626)._get_command() == [
        "indigo_server", "-p", "7626",
    ]


def test_custom_command_is_kept():
    cmd = ["my-server", "--port", "7624"]
    assert ServerManager("indi", command=cmd)._get_command() == cmd


def test_local_host_detection():
    assert ServerManager("indi", host="127.0.0.1")._is_local_host()
    assert ServerManager("indi", host="0.0.0.0")._is_local_host()
    assert not ServerManager("indi", host="203.0.113.1")._is_local_host()


def test_start_skips_when_server_is_remote(monkeypatch):
    manager = ServerManager("indi", host="203.0.113.1")
    monkeypatch.setattr(
        "indigo.server_manager.subprocess.Popen",
        lambda *a, **k: pytest.fail("must not spawn a remote server"),
    )
    asyncio.run(manager.start())
    assert manager.external_server is False


def test_start_skips_when_local_server_already_running(monkeypatch):
    manager = ServerManager("indi")
    monkeypatch.setattr(
        manager, "_find_local_servers",
        lambda: [{"pid": 42, "name": "indiserver", "cmdline": "indiserver"}],
    )
    monkeypatch.setattr(
        "indigo.server_manager.subprocess.Popen",
        lambda *a, **k: pytest.fail("must not spawn a second server"),
    )
    asyncio.run(manager.start())
    assert manager.external_server is True


def test_start_skips_when_port_is_busy(monkeypatch):
    manager = ServerManager("indi")
    monkeypatch.setattr(manager, "_find_local_servers", lambda: [])
    monkeypatch.setattr(manager, "_port_in_use", lambda: True)
    monkeypatch.setattr(
        "indigo.server_manager.subprocess.Popen",
        lambda *a, **k: pytest.fail("must not spawn on a busy port"),
    )
    asyncio.run(manager.start())
    assert manager.external_server is True


def test_stop_leaves_external_server_alone():
    manager = ServerManager("indi")
    manager._external_server = True

    class FakeProcess:
        def poll(self):
            return None

        def terminate(self):
            raise AssertionError("must not terminate an external server")

    manager._process = FakeProcess()
    asyncio.run(manager.stop())
