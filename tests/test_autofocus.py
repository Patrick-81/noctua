"""
test_autofocus.py — Unit tests for the AutoFocus state machine and V-curve fitting.
"""

import sys
import os
import math

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.devices.autofocus import AutoFocus, _fit_parabola, AutoFocusState


def test_initial_state():
    af = AutoFocus()
    s = af.status()
    assert s["state"] == "idle"
    assert s["best_position"] is None
    assert s["best_hfr"] is None


def test_start():
    af = AutoFocus()
    r = af.start(center=5000, search_range=1000, num_points=11)
    assert r["ok"] is True
    assert r["state"] == "running"
    assert len(r["positions"]) == 11
    assert r["positions"][0] == 4000
    assert r["positions"][-1] == 6000
    assert af.state == AutoFocusState.RUNNING


def test_start_clamps_points():
    af = AutoFocus()
    af.start(center=0, search_range=1000, num_points=2)
    assert af.num_points == 5  # clamped to min 5
    af2 = AutoFocus()
    af2.start(center=0, search_range=1000, num_points=200)
    assert af2.num_points == 100  # clamped to max 100


def test_start_while_running():
    af = AutoFocus()
    af.start(center=0, search_range=1000, num_points=10)
    r = af.start(center=0, search_range=1000, num_points=10)
    assert r["ok"] is False
    assert "already running" in r["error"]


def test_step_result():
    af = AutoFocus()
    af.start(center=5000, search_range=1000, num_points=11)
    r = af.step_result(position=4000, hfr=10.0, fwhm=5.0)
    assert r["ok"] is True
    assert r["current_step"] == 1
    assert af.results[0]["position"] == 4000
    assert af.results[0]["hfr"] == 10.0


def test_step_result_tracks_best():
    af = AutoFocus()
    af.start(center=0, search_range=500, num_points=5)
    af.step_result(0, 5.0)
    assert af.best_hfr == 5.0
    assert af.best_position == 0
    af.step_result(100, 3.0)
    assert af.best_hfr == 3.0
    assert af.best_position == 100
    af.step_result(200, 7.0)
    assert af.best_hfr == 3.0  # still the best


def test_step_result_not_running():
    af = AutoFocus()
    r = af.step_result(0, 5.0)
    assert r["ok"] is False
    assert "not running" in r["error"]


def test_finish_finds_minimum():
    af = AutoFocus()
    af.start(center=5000, search_range=2000, num_points=11)
    # Simulate V-curve: best at pos 5000
    for pos in af.positions:
        dist = abs(pos - 5000)
        hfr = 1.0 + (dist / 200.0) ** 2
        af.step_result(pos, hfr)

    r = af.finish()
    assert r["ok"] is True
    assert r["state"] == "done"
    assert r["best_position"] is not None
    # Best position should be close to 5000
    assert abs(r["best_position"] - 5000) < 100
    assert r["best_hfr"] < 2.0


def test_finish_with_few_points():
    af = AutoFocus()
    af.start(center=0, search_range=500, num_points=5)
    af.step_result(-500, 5.0)
    af.step_result(500, 5.0)
    r = af.finish()
    assert r["ok"] is True
    assert r["parabola"] is None  # < 3 num_points → no parabola


def test_finish_not_running():
    af = AutoFocus()
    r = af.finish()
    assert r["ok"] is False


def test_stop():
    af = AutoFocus()
    af.start(center=0, search_range=500, num_points=10)
    r = af.stop()
    assert r["state"] == "stopped"
    assert af.state == AutoFocusState.STOPPED


def test_reset():
    af = AutoFocus()
    af.start(center=0, search_range=500, num_points=10)
    af.step_result(0, 5.0)
    af.reset()
    assert af.state == AutoFocusState.IDLE
    assert af.results == []
    assert af.best_position is None


def test_positions_evenly_spaced():
    af = AutoFocus()
    af.start(center=10000, search_range=5000, num_points=21)
    positions = af.positions
    assert len(positions) == 21
    assert positions[0] == 5000
    assert positions[-1] == 15000
    # Check even spacing
    for i in range(1, len(positions)):
        diff = positions[i] - positions[i - 1]
        assert diff > 0


def test_fit_parabola_perfect():
    # y = 0.01*(x - 100)^2 + 1.0
    xs = list(range(50, 151, 10))
    ys = [0.01 * (x - 100) ** 2 + 1.0 for x in xs]
    coeffs = _fit_parabola(xs, ys)
    assert coeffs is not None
    a, b, c = coeffs
    # vertex at x = -b/(2a) = 100
    vertex_x = -b / (2 * a)
    assert abs(vertex_x - 100) < 1.0
    assert a > 0  # opens upward


def test_fit_parabola_noisy():
    import random
    random.seed(42)
    xs = list(range(0, 2001, 200))
    ys = [0.001 * (x - 1000) ** 2 + 2.0 + random.gauss(0, 0.1) for x in xs]
    coeffs = _fit_parabola(xs, ys)
    assert coeffs is not None
    a, b, c = coeffs
    assert a > 0
    vertex_x = -b / (2 * a)
    assert abs(vertex_x - 1000) < 50


def test_fit_parabola_insufficient():
    assert _fit_parabola([1, 2], [1, 2]) is None
    assert _fit_parabola([1], [1]) is None


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
