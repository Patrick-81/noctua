"""
test_fitsmeta.py — Unit tests for the normalized FITS header metadata injector
(Lot C4): sensor/filter/optics/exposure/gain/offset/temperature/dates written
into the raw FITS header using standard keywords, without corrupting the data.

No hardware required: synthetic FITS images come from ``mock_indigo``.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np

from indigo.devices import fitsmeta
from indigo.devices.focus_metrics import parse_fits
from mock_indigo import _make_fits

from datetime import datetime, timezone


def _raw(width: int = 64, height: int = 64) -> bytes:
    return _make_fits(width, height, [(32, 32, 400, 3)], bg=200, noise=0)


def _full_meta() -> dict:
    return fitsmeta.frame_meta(
        target="M31 Andromeda", frame_type="LIGHT", filter_name="L",
        exposure_sec=120.0, instrument="QHY600", ccd_temp=-10.5, set_temp=-15.0,
        pixel_size_um=3.76, binning_x=2, binning_y=2, gain=120, offset=50,
        focal_length_mm=616.0, telescope="Newton 250/1000",
        sitelat=43.952, sitelong=1.568, sitelev=210.0)


def test_inject_adds_standard_keywords():
    out = fitsmeta.inject_meta(_raw(), _full_meta())
    values, _cards, header_bytes = fitsmeta.read_header(out)
    assert values["OBJECT"] == "M31 Andromeda"
    assert values["IMAGETYP"] == "Light Frame"
    assert values["FILTER"] == "L"
    assert values["EXPTIME"] == "120"
    assert values["INSTRUME"] == "QHY600"
    assert values["CCD-TEMP"] == "-10.5"
    assert values["SET-TEMP"] == "-15"
    assert values["PIXSIZE1"] == "3.76"
    assert values["XBINNING"] == "2"
    assert values["GAIN"] == "120"
    assert values["OFFSET"] == "50"
    assert values["FOCALLEN"] == "616"
    assert values["TELESCOP"] == "Newton 250/1000"
    assert values["SITELAT"] == "43.952"
    assert "DATE-OBS" in values and "DATE-END" in values
    assert header_bytes == 2880  # header stays on a 2880 boundary


def test_data_preserved():
    """The image data block must round-trip bit-identical."""
    raw = _raw()
    out = fitsmeta.inject_meta(raw, _full_meta())
    img, w, h = parse_fits(out)
    ref, _w, _h = parse_fits(raw)
    assert img is not None and w == 64 and h == 64
    assert np.array_equal(img, ref)
    # data block start unchanged → same bytes after the original header
    assert out[2880:] == raw[2880:]


def test_empty_and_none_values_skipped():
    meta = fitsmeta.frame_meta(target="", filter_name="", exposure_sec=0,
                               ccd_temp=None)
    out = fitsmeta.inject_meta(_raw(), meta)
    values, _c, _h = fitsmeta.read_header(out)
    assert "OBJECT" not in values
    assert "FILTER" not in values
    # still normalized where a value exists
    assert values["IMAGETYP"] == "Light Frame"
    assert values["EXPTIME"] == "0"


def test_nan_inf_skipped():
    out = fitsmeta.inject_meta(_raw(), {"CCD-TEMP": float("nan"),
                                        "EXPTIME": float("inf"), "GAIN": 1})
    values, _c, _h = fitsmeta.read_header(out)
    assert "CCD-TEMP" not in values
    assert "EXPTIME" not in values
    assert values["GAIN"] == "1"


def test_non_fits_returns_unchanged():
    raw = _raw()
    truncated = raw[:500]  # no END card
    assert fitsmeta.inject_meta(truncated, _full_meta()) == truncated
    assert fitsmeta.inject_meta(b"", _full_meta()) == b""


def test_updates_existing_card_in_place():
    # pre-existing EXPTIME in the driver header gets normalized
    raw = _raw()
    # inject once, then again with a new value → card updated not duplicated
    once = fitsmeta.inject_meta(raw, {"EXPTIME": 10.0})
    values1, _c, _h = fitsmeta.read_header(once)
    assert values1["EXPTIME"] == "10"
    twice = fitsmeta.inject_meta(once, {"EXPTIME": 20.0})
    values2, cards2, _h = fitsmeta.read_header(twice)
    assert values2["EXPTIME"] == "20"
    exptime_cards = [c for c in cards2 if c[:8].strip() == "EXPTIME"]
    assert len(exptime_cards) == 1


def test_replace_false_keeps_existing():
    raw = fitsmeta.inject_meta(_raw(), {"EXPTIME": 10.0})
    out = fitsmeta.inject_meta(raw, {"EXPTIME": 99.0, "OBJECT": "M1"}, replace=False)
    values, _c, _h = fitsmeta.read_header(out)
    assert values["EXPTIME"] == "10"        # kept
    assert values["OBJECT"] == "M1"         # absent → still added


def test_string_quoting_and_ascii():
    """FITS headers are ASCII: accents are transliterated, quotes doubled, and
    long values are truncated before the comment column."""
    out = fitsmeta.inject_meta(_raw(), {"OBJECT": "Nébuleuse d'Andromède",
                                        "SWCREATE": "x" * 200})
    values, _c, _h = fitsmeta.read_header(out)
    assert values["OBJECT"] == "Nebuleuse d'Andromede"
    assert len(values["SWCREATE"]) <= 60


def test_float_typing():
    out = fitsmeta.inject_meta(_raw(), {"EXPTIME": 0.3, "SITELAT": 43.95})
    values, _c, _h = fitsmeta.read_header(out)
    assert values["EXPTIME"] == "0.3"
    assert values["SITELAT"] == "43.95"


def test_get_value():
    out = fitsmeta.inject_meta(_raw(), _full_meta())
    assert fitsmeta.get_value(out, "OBJECT") == "M31 Andromeda"
    assert fitsmeta.get_value(out, "CCD-TEMP") == "-10.5"
    assert fitsmeta.get_value(_raw(), "OBJECT") is None


def test_frame_meta_date_obs():
    t_obs = datetime(2026, 8, 29, 20, 30, 15, 250000, tzinfo=timezone.utc)
    meta = fitsmeta.frame_meta(exposure_sec=60, date_obs=t_obs)
    out = fitsmeta.inject_meta(_raw(), meta)
    values, _c, _h = fitsmeta.read_header(out)
    assert values["DATE-OBS"].startswith("2026-08-29T20:30:15")