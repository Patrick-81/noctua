"""Tests for the Bahtinov mask focus aid (indigo/devices/bahtinov.py)."""
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.bahtinov import analyse_bahtinov


def make_fits_bahtinov(w=800, h=600, sx=400, sy=300, shift=0.0,
                       bg=500.0, peak=12000.0, sigma=3.0, seed=7):
    """Synthetic star + 3 Bahtinov spikes (diagonals 60°/120° through
    center, vertical central spike laterally shifted by `shift` px)."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w), bg) + rng.normal(0, 8, (h, w))
    yy, xx = np.mgrid[0:h, 0:w]
    img += peak * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * sigma ** 2))
    R = 120
    for theta_deg, dx in ((60.0, 0.0), (120.0, 0.0), (90.0, shift)):
        a = np.radians(theta_deg)
        dx_dir, dy_dir = np.cos(a), np.sin(a)
        for t in range(-R, R + 1):
            x = int(round(sx + dx + dx_dir * t))
            y = int(round(sy + dy_dir * t))
            if 0 <= x < w and 0 <= y < h:
                fall = peak * 0.25 / (1.0 + abs(t) / 25.0)
                img[y, x] += fall
    img = np.clip(img, 0, 32767).astype(">i2")

    def card(k, v):
        return f"{k:<8}= {v:>20} / test".ljust(80)[:80]

    hdr = "".join([
        card("SIMPLE", "T"),
        card("BITPIX", "16"),
        card("NAXIS", "2"),
        card("NAXIS1", str(w)),
        card("NAXIS2", str(h)),
        "END".ljust(80),
    ]).ljust(2880)[:2880].encode("ascii")
    return hdr + img.tobytes()


def test_offset_positive():
    res = analyse_bahtinov(make_fits_bahtinov(shift=8.0))
    assert res["ok"], res
    assert abs(res["offset_px"] - 8.0) <= 2.0, res
    assert res["direction"] == "right", res
    assert res["confidence"] > 0.4, res
    print(f"  shift=+8 → {res['offset_px']}px {res['direction']} conf={res['confidence']}")


def test_offset_negative():
    res = analyse_bahtinov(make_fits_bahtinov(shift=-6.0))
    assert res["ok"], res
    assert abs(res["offset_px"] + 6.0) <= 2.0, res
    assert res["direction"] == "left", res
    print(f"  shift=-6 → {res['offset_px']}px {res['direction']}")


def test_focused_zero():
    res = analyse_bahtinov(make_fits_bahtinov(shift=0.0))
    assert res["ok"], res
    assert abs(res["offset_px"]) <= 2.0, res
    print(f"  shift=0 → {res['offset_px']}px conf={res['confidence']}")


def test_click_near_star():
    data = make_fits_bahtinov(shift=5.0)
    res = analyse_bahtinov(data, x=410, y=295)
    assert res["ok"], res
    assert abs(res["offset_px"] - 5.0) <= 2.5, res


def test_no_spikes_rejected():
    rng = np.random.default_rng(3)
    img = np.full((600, 800), 500.0) + rng.normal(0, 8, (600, 800))
    yy, xx = np.mgrid[0:600, 0:800]
    img += 15000 * np.exp(-((xx - 400) ** 2 + (yy - 300) ** 2) / (2 * 3.0 ** 2))
    img = np.clip(img, 0, 32767).astype(">i2")

    def card(k, v):
        return f"{k:<8}= {v:>20} / test".ljust(80)[:80]

    hdr = "".join([
        card("SIMPLE", "T"), card("BITPIX", "16"), card("NAXIS", "2"),
        card("NAXIS1", "800"), card("NAXIS2", "600"), "END".ljust(80),
    ]).ljust(2880)[:2880].encode("ascii")
    res = analyse_bahtinov(hdr + img.tobytes())
    assert (not res["ok"]) or res.get("confidence", 1.0) < 0.4, res
    print(f"  plain star → ok={res['ok']} conf={res.get('confidence')}")


if __name__ == "__main__":
    for fn in (test_offset_positive, test_offset_negative, test_focused_zero,
               test_click_near_star, test_no_spikes_rejected):
        print(f"{fn.__name__} ...")
        fn()
    print("BAHTINOV OK")
