"""test_live_stack.py — Unit tests for the Seiza-backed live stacking engine."""

import os
import sys
import tempfile
from pathlib import Path

import numpy as np

# Active le venv si on est dans le projet
venv_path = Path(__file__).resolve().parent.parent / ".venv"
if venv_path.exists():
    venv_python = venv_path / "bin" / "python"
    # Insère le site-packages du venv dans le sys.path actuel
    site_packages = venv_path / "lib" / "python3.12" / "site-packages"
    if site_packages.exists():
        sys.path.insert(0, str(site_packages))
    # Insère aussi le répertoire du projet
    project_root = Path(__file__).resolve().parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

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
    """Vérifie que LiveStackEngine peut être instancié et que seiza est disponible."""
    try:
        e = LiveStackEngine()
        st = e.status()
        check(st["available"] is True, "seiza available")
        check(st["ok"] is True, "status ok")
    except RuntimeError as e:
        if "Seiza not installed" in str(e):
            check(False, "seiza available")
            check(False, "status ok")
        else:
            raise


def test_accept_reject():
    """Test accept/reject logic with Seiza."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "first frame sets ref")
        check(False, "drifted frame accepted")
        check(False, "matched stars")
        check(False, "blank frame rejected")
        check(False, "counters")
        check(False, "stacking running")
        return

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
    """Test reset clears state."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "reset clears state")
        return

    e.push_array(starfield())
    r = e.reset()
    check(r["running"] is False and r["accepted"] == 0, "reset clears state")


def test_push_fits_roundtrip():
    """Test FITS roundtrip."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "FITS parse roundtrip")
        return

    with tempfile.TemporaryDirectory() as td:
        f = os.path.join(td, "t.fits")
        _arr_to_fits(starfield(), f)
        data = Path(f).read_bytes()
        img, w, h = _parse_fits_bytes(data)
        check(img is not None and (w, h) == (320, 240), "FITS parse roundtrip")

        r = e.push_fits(data)
        check(r["accepted"] is True, "push_fits ref accepted")
        r = e.push_fits(Path(f).read_bytes())
        check(r["accepted"] is True, "push_fits same frame accepted")


def test_snapshot_and_master():
    """Test snapshot and master saving."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "snapshot returns PNG")
        check(False, "master saved")
        check(False, "master file exists")
        check(False, "master FITS re-parses")
        check(False, "master PNG saved")
        return

    e.push_array(starfield())
    e.push_array(starfield(dx=2.0, dy=-2.0, seed=3))
    png = e.snapshot_png()
    check(png is not None and png[:8] == b"\x89PNG\r\n\x1a\n", "snapshot returns PNG")

    with tempfile.TemporaryDirectory() as td:
        r = e.save_master(td)
        check(r["ok"] is True, "master saved")
        check(os.path.exists(r["path"]), "master file exists")
        back, w, h = _parse_fits_bytes(Path(r["path"]).read_bytes())
        check(back is not None, "master FITS re-parses")
        r = e.save_master(td, fmt="png")
        check(r["ok"] and r["path"].endswith(".png"), "master PNG saved")


def test_calibration_masters():
    """Test flat master building."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "flat master built")
        return

    with tempfile.TemporaryDirectory() as td:
        flat_dir = os.path.join(td, "flats")
        os.makedirs(flat_dir)
        for i in range(3):
            m = np.full((240, 320), 4000.0, np.float32) + \
                np.random.default_rng(i).normal(0, 15, (240, 320)).astype(np.float32)
            _arr_to_fits(m, os.path.join(flat_dir, f"f{i}.fits"))
        r = e.build_masters(flat_dir=flat_dir)
        check(r["ok"] and r["calibration"]["flat"] is True, "flat master built")


def test_options_configure():
    """Test engine configuration."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "configure accepted")
        return

    st = e.configure({"maximum_drift_pixels": 64.0, "rejection": "delta-sigma"})
    check(st["ok"] is True, "configure accepted")


def test_max_frames_completes():
    """Test max_frames completion."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "max_frames configured")
        check(False, "second frame accepted")
        check(False, "complete after max_frames accepted")
        check(False, "push refused once complete")
        check(False, "reset clears complete")
        return

    st = e.configure({"max_frames": 2})
    check(st["max_frames"] == 2 and st["complete"] is False, "max_frames configured")
    e.push_array(starfield())
    r = e.push_array(starfield(dx=2.5, dy=-1.5, seed=2))
    check(r.get("accepted") is True, "second frame accepted")
    st = e.status()
    check(st["complete"] is True, "complete after max_frames accepted")
    r = e.push_array(starfield(seed=3))
    check(r.get("ok") is False and r.get("complete"), "push refused once complete")
    st = e.reset()
    check(st["complete"] is False and st["accepted"] == 0, "reset clears complete")


def test_max_frames_zero_is_continuous():
    """Test max_frames=0 = continuous mode."""
    try:
        e = LiveStackEngine()
    except RuntimeError:
        check(False, "continuous push 1 accepted")
        check(False, "continuous push 2 accepted")
        check(False, "continuous push 3 accepted")
        check(False, "never completes when max_frames == 0")
        return

    e.configure({"max_frames": 0})
    e.push_array(starfield())
    for i in range(3):
        r = e.push_array(starfield(dx=i * 1.5, dy=-i, seed=4 + i))
        check(r.get("accepted") is True, f"continuous push {i + 2} accepted")
    st = e.status()
    check(st["complete"] is False, "never completes when max_frames == 0")


# ── Main ───────────────────────────────────────────────────────

passed = 0
failed = 0


def check(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        print(f"  ✗ FAIL: {label}")


def main():
    global passed, failed
    print("=== Live stack engine units ===")
    for fn in (test_engine_available, test_accept_reject, test_reset,
               test_push_fits_roundtrip, test_snapshot_and_master,
               test_calibration_masters, test_options_configure,
               test_max_frames_completes, test_max_frames_zero_is_continuous):
        fn()
    success = failed == 0
    print(f"\nResults: {passed} passed, {failed} failed")
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
