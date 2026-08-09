"""test_live_stack.py — Unit tests for the Seiza-backed live stacking engine."""

import os
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.live_stack import LiveStackEngine, _arr_to_fits, _parse_fits_bytes


def starfield(dx=0.0, dy=0.0, seed=1, star_flux=400.0):
    rng = np.random.default_rng(seed)
    img = rng.normal(60, 8, (240, 320)).astype(np.float32)
    yy, xx = np.mgrid[0:240, 0:320]
    for (cx, cy) in [(80, 80), (80, 120), (120, 200), (50, 40), (200, 90),
                     (190, 180), (120, 220), (10, 30), (230, 60), (40, 140)]:
        img += star_flux * np.exp(-(((xx - (cx + dx)) ** 2 + (yy - (cy + dy)) ** 2) / 2.0 ** 2))
    return img.astype(np.float32)


# ── Tests ───────────────────────────────────────────────────────

def test_engine_available():
    e = LiveStackEngine()
    st = e.status()
    check(st["available"] is True, "seiza available")
    check(st["ok"] is True, "status ok")


def test_accept_reject():
    e = LiveStackEngine()
    r = e.push_array(starfield())
    check(r["accepted"] is True and r["reason"] == "reference", "first frame sets ref")
    r = e.push_array(starfield(dx=2.5, dy=-1.5, seed=2))
    check(r["accepted"] is True, "drifted frame accepted")
    check(r["matched_stars"] >= 6, f"matched stars {r.get('matched_stars')}")
    r = e.push_array(np.ones((240, 320), np.float32))
    check(r["accepted"] is False, "blank frame rejected")
    st = e.status()
    check(st["accepted"] == 2 and st["rejected"] == 1, "counters (2 acc / 1 rej)")
    check(st["running"] is True, "stacking running")


def test_reset():
    e = LiveStackEngine()
    e.push_array(starfield())
    r = e.reset()
    check(r["running"] is False and r["accepted"] == 0, "reset clears state")


def test_push_fits_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        f = os.path.join(td, "t.fits")
        _arr_to_fits(starfield(), f)
        data = Path(f).read_bytes()
        img, w, h = _parse_fits_bytes(data)
        check(img is not None and (w, h) == (320, 240), "FITS parse roundtrip")

        e = LiveStackEngine()
        r = e.push_fits(data)
        check(r["accepted"] is True, "push_fits ref accepted")
        r = e.push_fits(Path(f).read_bytes())
        check(r["accepted"] is True, "push_fits same frame accepted")


def test_snapshot_and_master():
    e = LiveStackEngine()
    e.push_array(starfield())
    e.push_array(starfield(dx=2.0, dy=-2.0, seed=3))
    png = e.snapshot_png()
    check(png is not None and png[:8] == b"\x89PNG\r\n\x1a\n", "snapshot returns PNG")

    with tempfile.TemporaryDirectory() as td:
        r = e.save_master(td)
        check(r["ok"] is True, "master saved")
        check(os.path.exists(r["path"]), "master file exists")
        # master is readable by our parser
        back, w, h = _parse_fits_bytes(Path(r["path"]).read_bytes())
        check(back is not None, "master FITS re-parses")
        r = e.save_master(td, fmt="png")
        check(r["ok"] and r["path"].endswith(".png"), "master PNG saved")


def test_calibration_masters():
    with tempfile.TemporaryDirectory() as td:
        flat_dir = os.path.join(td, "flats")
        os.makedirs(flat_dir)
        for i in range(3):
            m = np.full((240, 320), 4000.0, np.float32) + \
                np.random.default_rng(i).normal(0, 15, (240, 320)).astype(np.float32)
            _arr_to_fits(m, os.path.join(flat_dir, f"f{i}.fits"))
        e = LiveStackEngine()
        r = e.build_masters(flat_dir=flat_dir)
        check(r["ok"] and r["calibration"]["flat"] is True, "flat master built")


def test_options_configure():
    e = LiveStackEngine()
    st = e.configure({"maximum_drift_pixels": 64.0, "rejection": "delta-sigma"})
    check(st["ok"] is True, "configure accepted")


# ── Main ───────────────────────────────────────────────────────

passed = 0
failed = 0


def check(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print(f"  \u2713 {label}")
    else:
        failed += 1
        print(f"  \u2717 FAIL: {label}")


def main():
    global passed, failed
    print("=== Live stack engine units ===")
    for fn in (test_engine_available, test_accept_reject, test_reset,
               test_push_fits_roundtrip, test_snapshot_and_master,
               test_calibration_masters, test_options_configure):
        fn()
    success = failed == 0
    print(f"\nResults: {passed} passed, {failed} failed")
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())