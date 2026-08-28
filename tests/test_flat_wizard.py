"""Tests unitaires du Flat Wizard (indigo/devices/flat_wizard.py)."""
import pytest

from indigo.devices.flat_wizard import (
    MAX_STEPS,
    FlatWizard,
    is_converged,
    suggest_duration,
)


# ── suggest_duration (pure function) ─────────────────────────────

def test_linear_extrapolation():
    # 4000 ADU at 1.0s, target 8000 → 2.0s
    res = suggest_duration(4000.0, 1.0, target_adu=8000.0)
    assert res["ok"] is True
    assert res["duration"] == pytest.approx(2.0)
    assert res["ratio"] == pytest.approx(2.0)


def test_shorten_when_over_target():
    # 30000 ADU at 3.0s, target 10000 → 1.0s
    res = suggest_duration(30000.0, 3.0, target_adu=10000.0)
    assert res["duration"] == pytest.approx(1.0)


def test_clamps_to_maximum():
    res = suggest_duration(100.0, 1.0, target_adu=20000.0, max_duration=5.0)
    assert res["duration"] == 5.0


def test_clamps_to_minimum():
    res = suggest_duration(90000.0, 1.0, target_adu=100.0, min_duration=0.05)
    assert res["duration"] == 0.05


def test_non_positive_adu_is_error():
    res = suggest_duration(0.0, 1.0, target_adu=8000.0)
    assert res["ok"] is False
    res2 = suggest_duration(-5.0, 1.0, target_adu=8000.0)
    assert res2["ok"] is False


def test_nan_adu_is_error():
    res = suggest_duration(float("nan"), 1.0, target_adu=8000.0)
    assert res["ok"] is False


# ── is_converged ─────────────────────────────────────────────────

def test_convergence_within_tolerance():
    assert is_converged(8000.0, 8000.0, 0.05) is True
    assert is_converged(8000.0 * 1.04, 8000.0, 0.05) is True
    assert is_converged(8000.0 * 1.06, 8000.0, 0.05) is False


# ── FlatWizard state machine ─────────────────────────────────────

def test_wizard_converges_to_target():
    wz = FlatWizard()
    wz.configure(target_adu=8000.0, start_duration=1.0)
    # First measurement lands within tolerance → done immediately
    st = wz.record_measurement(8000.0)
    assert st["done"] is True
    assert st["last_adu"] == 8000.0


def test_wizard_adjusts_then_converges():
    wz = FlatWizard()
    wz.configure(target_adu=8000.0, start_duration=1.0, max_duration=5.0)
    # Miss low: 4000 ADU at 1.0s → suggest 2.0s, not done
    st = wz.record_measurement(4000.0)
    assert st["done"] is False
    assert st["duration"] == pytest.approx(2.0)
    # Now within tolerance → done
    st = wz.record_measurement(8000.0)
    assert st["done"] is True


def test_wizard_stops_at_max_steps():
    wz = FlatWizard()
    wz.configure(target_adu=8000.0, start_duration=1.0, max_duration=1.0,
                 min_duration=0.9)
    # Clamped to 1.0 each time → never converges, stops at MAX_STEPS
    for _ in range(MAX_STEPS):
        if wz.done:
            break
        wz.record_measurement(4000.0)
    assert wz.done is True


def test_wizard_status_shape():
    wz = FlatWizard()
    st = wz.status()
    assert "target_adu" in st
    assert "duration" in st
    assert "done" in st
    assert "suggestion" in st


# ── Router integration (no camera needed for status/configure/reset) ──

def _make_server():
    from fastapi.testclient import TestClient
    from indigo.devices.mount import Mount
    from indigo.registry import DeviceRegistry
    from web.server import WebServer
    registry = DeviceRegistry(type("Client", (), {})())
    server = WebServer(registry)
    return TestClient(server.app), server


def test_router_status_configure_reset():
    client, server = _make_server()
    # Fresh status
    st = client.get("/api/camera/flat-wizard/status").json()
    assert st["done"] is False
    assert st["target_adu"] == 22000.0
    # Configure
    cfg = client.post("/api/camera/flat-wizard/configure",
                      json={"target_adu": 8000, "start_duration": 1.2,
                            "filter": "L", "binning": "1x1"}).json()
    assert cfg["target_adu"] == 8000
    assert cfg["duration"] == 1.2
    assert cfg["filter"] == "L"
    # Reset
    rs = client.post("/api/camera/flat-wizard/reset").json()
    assert rs["done"] is False
    assert rs["target_adu"] == 22000.0


def test_router_step_without_camera_errors():
    client, server = _make_server()
    resp = client.post("/api/camera/flat-wizard/step", json={}).json()
    assert resp.get("error") == "no camera"
