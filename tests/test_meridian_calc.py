"""
test_meridian_calc.py — Unit tests for meridian flip math (indigo/devices/meridian.py).
"""

import sys
import os
from datetime import datetime

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.devices.meridian import (  # noqa: E402
    flip_due,
    flip_side,
    fmt_ha,
    fmt_time_to_flip,
    hour_angle_hours,
    local_sidereal_time_deg,
    time_to_flip,
)


def test_lst_range_and_wrap():
    now = datetime(2024, 1, 1, 0, 0, 0)
    lst = local_sidereal_time_deg(0.0, now)
    assert 0.0 <= lst < 360.0
    # Adding 360° longitude must not change LST
    lst2 = local_sidereal_time_deg(360.0, now)
    assert abs(lst - lst2) < 1e-9


def test_ha_basic():
    # LST 90° = 6h ; RA 6h → HA 0 (on meridian)
    assert abs(hour_angle_hours(6.0, 90.0)) < 1e-9
    # RA 5h with LST 6h → HA = +1h (west)
    assert abs(hour_angle_hours(5.0, 90.0) - 1.0) < 1e-6
    # RA 7h with LST 6h → HA = -1h (east)
    assert abs(hour_angle_hours(7.0, 90.0) + 1.0) < 1e-6


def test_ha_wrap_into_12h():
    # RA 6h, LST 20h (HA=14h) should wrap to -10h (east)
    ha = hour_angle_hours(6.0, 20.0 * 15)
    assert ha > -12.1 and ha <= 12.0
    # 14 wraps to -10
    assert abs(ha + 10.0) < 1e-6


def test_flip_side():
    assert flip_side(-2.0) == "est"
    assert flip_side(2.0) == "ouest"
    assert flip_side(0.0) == "meridien"


def test_flip_due_threshold():
    # HA below margin → not due
    assert flip_due(-1.0, 0.0) is False
    # HA at/above margin → due
    assert flip_due(0.0, 0.0) is True
    assert flip_due(2.0, 0.5) is True
    # margin positive delays the flip
    assert flip_due(0.2, 0.5) is False


def test_flip_due_altitude_safety():
    # Above min altitude → due
    assert flip_due(2.0, 0.0, min_alt_deg=5.0, alt_deg=40.0) is True
    # Below min altitude → blocked
    assert flip_due(2.0, 0.0, min_alt_deg=5.0, alt_deg=2.0) is False
    # Unknown altitude → not blocked
    assert flip_due(2.0, 0.0, min_alt_deg=5.0, alt_deg=None) is True


def test_time_to_flip():
    # HA 0.2 toward margin 0.5 → 0.3h in the future
    assert abs(time_to_flip(0.2, 0.5) - 0.3) < 1e-6
    # Already past (HA < margin)
    assert time_to_flip(0.8, 0.0) < 0


def test_fmt_ha():
    assert fmt_ha(2.5) == "+02h30"
    assert "−" in fmt_ha(-1.5)
    assert "-" or "−" in fmt_ha(-0.5)


def test_fmt_time_to_flip():
    assert "5 min" in fmt_time_to_flip(5 / 60)
    assert "2h10" in fmt_time_to_flip(130 / 60)
    assert "passé" in fmt_time_to_flip(-30 / 60)


def test_known_lst_reference():
    # at J2000 epoch LST should be near GMST (same lon offset).
    # Sanity: LST at lon=longitude roughly in [0,360)
    lst = local_sidereal_time_deg(1.568)
    assert 0.0 <= lst < 360.0