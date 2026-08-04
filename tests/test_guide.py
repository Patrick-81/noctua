"""
test_guide.py — Unit tests for the Guide state machine and drift correction.
"""

import sys
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.devices.guide import Guide, GuideState


def test_initial_state():
    g = Guide()
    s = g.status()
    assert s["state"] == "idle"
    assert s["ref_set"] is False
    assert s["frame_count"] == 0


def test_start():
    g = Guide()
    r = g.start(exposure_sec=2.0, aggressiveness=0.7, ra_gain=1.5, dec_gain=1.2)
    assert r["ok"] is True
    assert r["state"] == "guiding"
    assert r["exposure_sec"] == 2.0
    assert r["aggressiveness"] == 0.7
    assert g.state == GuideState.GUIDING


def test_start_clamps():
    g = Guide()
    g.start(exposure_sec=0.01, aggressiveness=1.5, ra_gain=-1, dec_gain=-1)
    assert g.exposure_sec == 0.1
    assert g.aggressiveness == 1.0
    assert g.ra_gain == 0.1
    assert g.dec_gain == 0.1


def test_start_while_guiding():
    g = Guide()
    g.start()
    r = g.start()
    assert r["ok"] is False
    assert "déjà en cours" in r["error"]


def test_first_frame_sets_reference():
    g = Guide()
    g.start()
    r = g.step_result(100.0, 200.0)
    assert r["ok"] is True
    assert r["ref_set"] is True
    assert r["ref_x"] == 100.0
    assert r["ref_y"] == 200.0
    assert r["drift_x"] == 0.0
    assert r["drift_y"] == 0.0
    assert r["frame_count"] == 1


def test_drift_computation():
    g = Guide()
    g.start(aggressiveness=1.0, ra_gain=10.0, dec_gain=10.0, min_pulse_ms=0)
    g.step_result(100.0, 100.0)  # reference
    r = g.step_result(105.0, 98.0)  # moved 5px East, 2px South
    assert r["drift_x"] == 5.0
    assert r["drift_y"] == -2.0
    # RA correction: drift_x=5, gain=10 → 50ms West
    assert r["ra_direction"] == "W"
    assert r["ra_pulse_ms"] == 50
    # DEC correction: drift_y=-2, gain=10 → 20ms North
    assert r["dec_direction"] == "N"
    assert r["dec_pulse_ms"] == 20


def test_drift_zero_no_correction():
    g = Guide()
    g.start(min_pulse_ms=50)
    g.step_result(100.0, 100.0)
    r = g.step_result(100.0, 100.0)  # no drift
    assert r["ra_pulse_ms"] == 0
    assert r["dec_pulse_ms"] == 0
    assert r["ra_direction"] == ""
    assert r["dec_direction"] == ""


def test_min_pulse_threshold():
    g = Guide()
    g.start(aggressiveness=1.0, ra_gain=1.0, dec_gain=1.0, min_pulse_ms=100)
    g.step_result(100.0, 100.0)
    r = g.step_result(101.0, 100.0)  # 1px drift → 1ms pulse < 100ms threshold
    assert r["ra_pulse_ms"] == 0
    assert r["dec_pulse_ms"] == 0


def test_max_pulse_clamp():
    g = Guide()
    g.start(aggressiveness=1.0, ra_gain=1000.0, dec_gain=1000.0, max_pulse_ms=500, min_pulse_ms=0)
    g.step_result(0.0, 0.0)
    r = g.step_result(100.0, 100.0)  # huge drift
    assert r["ra_pulse_ms"] == 500
    assert r["dec_pulse_ms"] == 500


def test_aggressiveness():
    g = Guide()
    g.start(aggressiveness=0.5, ra_gain=10.0, dec_gain=10.0, min_pulse_ms=0)
    g.step_result(100.0, 100.0)
    r = g.step_result(110.0, 100.0)  # 10px drift
    # With aggr=0.5, effective drift = 5px, gain=10 → 50ms
    assert r["ra_pulse_ms"] == 50


def test_pause_resume():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    r = g.pause()
    assert r["state"] == "paused"
    r = g.step_result(110.0, 100.0)
    assert r["ok"] is False
    r = g.resume()
    assert r["state"] == "guiding"
    r = g.step_result(110.0, 100.0)
    assert r["ok"] is True


def test_stop():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    r = g.stop()
    assert r["state"] == "stopped"
    assert r["ra_pulse_ms"] == 0
    assert r["dec_pulse_ms"] == 0


def test_reset():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    g.reset()
    s = g.status()
    assert s["state"] == "idle"
    assert s["ref_set"] is False
    assert s["frame_count"] == 0
    assert s["history"] == []


def test_set_reference():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    r = g.set_reference(200.0, 300.0)
    assert r["ref_x"] == 200.0
    assert r["ref_y"] == 300.0
    r = g.step_result(210.0, 295.0)
    assert r["drift_x"] == 10.0
    assert r["drift_y"] == -5.0


def test_history_recorded():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    g.step_result(105.0, 98.0)
    g.step_result(103.0, 101.0)
    r = g.status()
    assert len(r["history"]) == 3
    assert r["history"][1]["drift_x"] == 5.0


def test_history_max():
    g = Guide()
    g.start()
    g.step_result(0.0, 0.0)
    for i in range(310):
        g.step_result(float(i), float(i))
    r = g.status()
    assert len(r["history"]) == 100  # capped at 100 in API


def test_step_not_running():
    g = Guide()
    r = g.step_result(100.0, 100.0)
    assert r["ok"] is False


def test_drift_arcsec():
    g = Guide()
    g.start(plate_scale=2.0, min_pulse_ms=0)
    g.step_result(100.0, 100.0)
    r = g.step_result(105.0, 98.0)
    assert r["drift_arcsec_x"] == 10.0  # 5px * 2.0
    assert r["drift_arcsec_y"] == -4.0  # -2px * 2.0


def test_snr_recorded():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0, snr=12.5)
    r = g.step_result(102.0, 101.0, snr=18.0)
    assert r["current_snr"] == 18.0
    s = g.status()
    assert s["history"][0]["snr"] == 12.5
    assert s["history"][1]["snr"] == 18.0


def test_snr_optional():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    r = g.status()
    assert r["current_snr"] is None
    assert r["history"][0]["snr"] is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  ✓ {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
    print(f"\n{passed} passed, {failed} failed")
