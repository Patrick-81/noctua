"""
test_masters.py — Unit tests for the master calibration library (Lot C1):
combining raw frames into masters, cataloguing them from their normalized
FITS headers, and resolving the best bias/dark/flat by filter/binning/
temperature/exposure.

No hardware required: synthetic frames come from ``mock_indigo``.
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np

from indigo.devices import fitsmeta
from indigo.devices.focus_metrics import parse_fits
from indigo.devices.masters import MasterLibrary
from mock_indigo import _make_fits


def _frame(frame_type="FLAT", filter_name="L", binning="2x2", temp=None,
           exptime=1.0, fg: int = 300) -> bytes:
    raw = _make_fits(64, 64, [(32, 32, fg, 3)], bg=100, noise=2)
    bx, by = (int(p) for p in binning.split("x"))
    meta = fitsmeta.frame_meta(
        frame_type=frame_type, filter_name=filter_name, exposure_sec=exptime,
        instrument="QHY600", ccd_temp=temp,
        binning_x=bx, binning_y=by,
        gain=120, offset=50, focal_length_mm=616.0,
        telescope="Newton 250/1000")
    return fitsmeta.inject_meta(raw, meta)


def _write(tmp, name: str, data: bytes) -> str:
    p = os.path.join(tmp, name)
    with open(p, "wb") as f:
        f.write(data)
    return p


def _flat_lib():
    tmp = tempfile.mkdtemp(prefix="masters-")
    lib = MasterLibrary(tmp)
    return lib, tmp


def test_build_creates_and_indexes_master():
    lib, tmp = _flat_lib()
    src = os.path.join(tmp, "src")
    os.makedirs(src)
    for i in range(4):
        _write(src, f"flat_{i:02d}.fits", _frame())
    res = lib.build(src, "flat")
    assert res.get("ok") is True, res
    master = res["record"]
    assert master["type"] == "flat"
    assert master["filter"] == "L"
    assert master["binning"] == "2x2"
    assert master["framecount"] == 4
    assert master["path"].endswith("masters/flat/flat_L_2x2.fits")
    # catalog scans it back
    assert any(r["name"] == "flat_L_2x2" for r in lib.scan())
    # and the master is a real FITS image (float32)
    img, w, h = parse_fits(_read(master["path"]))
    assert img is not None and (w, h) == (64, 64)


def test_build_writes_normalized_header():
    lib, tmp = _flat_lib()
    src = os.path.join(tmp, "src")
    os.makedirs(src)
    _write(src, "dark_0.fits", _frame("DARK", "", "1x1", temp=-10, exptime=120))
    _write(src, "dark_1.fits", _frame("DARK", "", "1x1", temp=-10, exptime=120))
    res = lib.build(src, "dark")
    assert res.get("ok") is True, res
    data = _read(res["record"]["path"])
    vals, _c, _h = fitsmeta.read_header(data)
    assert vals.get("IMAGETYP") == "Dark Frame"
    assert vals.get("NCOMBINE") == "2"
    assert vals.get("EXPTIME") == "120"
    assert vals.get("CCD-TEMP") == "-10"
    assert vals.get("INSTRUME") == "QHY600"


def test_resolve_flat_by_filter_and_binning():
    lib, tmp = _flat_lib()
    base = os.path.join(tmp, "masters")
    flat = os.path.join(base, "flat")
    os.makedirs(flat)
    _write(flat, "flat_L_2x2.fits", _frame("FLAT", "L", "2x2"))
    _write(flat, "flat_R_2x2.fits", _frame("FLAT", "R", "2x2"))
    _write(flat, "flat_L_1x1.fits", _frame("FLAT", "L", "1x1"))
    lib.scan()

    m = lib.resolve("flat", filter_name="L", binning="2x2")
    assert m is not None and m["filter"] == "L" and m["binning"] == "2x2"
    m = lib.resolve("flat", filter_name="R", binning="2x2")
    assert m is not None and m["filter"] == "R"
    assert lib.resolve("flat", filter_name="Ha", binning="2x2") is None
    assert lib.resolve("flat", filter_name="L", binning="4x4") is None


def test_resolve_dark_temperature():
    lib, tmp = _flat_lib()
    dark = os.path.join(tmp, "masters", "dark")
    os.makedirs(dark)
    _write(dark, "dark_p10.fits", _frame("DARK", "", "1x1", temp=-10, exptime=120))
    _write(dark, "dark_m20.fits", _frame("DARK", "", "1x1", temp=-20, exptime=120))
    lib.scan()

    best = lib.resolve("dark", binning="1x1", temperature=-12, exposure=120)
    assert best is not None and best["temperature"] == -10
    # far from any master, and all masters have a known temperature → no match
    assert lib.resolve("dark", binning="1x1", temperature=-50, exposure=120) is None
    # unknown temperature demand → no constraint
    assert lib.resolve("dark", binning="1x1") is not None


def test_resolve_dark_exposure_prefers_geq():
    lib, tmp = _flat_lib()
    dark = os.path.join(tmp, "masters", "dark")
    os.makedirs(dark)
    _write(dark, "dark_60.fits", _frame("DARK", "", "1x1", temp=-10, exptime=60))
    _write(dark, "dark_120.fits", _frame("DARK", "", "1x1", temp=-10, exptime=120))
    _write(dark, "dark_300.fits", _frame("DARK", "", "1x1", temp=-10, exptime=300))
    lib.scan()

    best = lib.resolve("dark", binning="1x1", temperature=-12, exposure=90)
    assert best is not None and best["exposure"] == 120
    best = lib.resolve("dark", binning="1x1", temperature=-12, exposure=400)
    assert best is not None and best["exposure"] == 300  # nearest overall


def test_resolve_all_returns_paths():
    lib, tmp = _flat_lib()
    base = os.path.join(tmp, "masters")
    for t in ("dark", "flat"):
        os.makedirs(os.path.join(base, t))
    _write(os.path.join(base, "dark"), "d.fits",
           _frame("DARK", "", "1x1", temp=-10, exptime=120))
    _write(os.path.join(base, "flat"), "f.fits",
           _frame("FLAT", "L", "1x1", exptime=2.0))
    res = lib.resolve_all(filter_name="L", binning="1x1", temperature=-12, exposure=120)
    assert res["dark"] and res["dark"].endswith("d.fits")
    assert res["flat"] and res["flat"].endswith("f.fits")
    assert res["bias"] is None


def test_delete_master():
    lib, tmp = _flat_lib()
    dark = os.path.join(tmp, "masters", "dark")
    os.makedirs(dark)
    _write(dark, "dark_x.fits", _frame("DARK", "", "1x1"))
    lib.scan()
    assert lib.delete("dark_x.fits").get("ok") is True
    assert lib.resolve("dark", binning="1x1") is None
    assert lib.delete("dark_x.fits").get("ok") is False


def test_build_rejects_empty_dir():
    lib, tmp = _flat_lib()
    src = os.path.join(tmp, "empty")
    os.makedirs(src)
    res = lib.build(src, "flat")
    assert res.get("ok") is False


def _read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()