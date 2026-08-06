"""
meridian.py — Meridian flip detection math.

Pure Python, no dependencies. Computes local sidereal time (LST), hour angle
(HA) and whether the mount needs a meridian flip.

Conventions:
  - LST in degrees, HA in hours (normalized to [-12, +12]).
  - HA < 0 : target east of meridian (rising).  HA > 0 : west (setting).
  - On a German equatorial mount, the flip is needed when HA crosses 0
    (from negative to positive) for a target observed through the west pier.
"""

from __future__ import annotations

import math
from datetime import datetime

_JD_EPOCH = 2451545.0  # J2000.0
_DAYS_PER_CENTURY = 36525.0


def _julian_date(now: datetime) -> float:
    return now.timestamp() / 86400.0 + 2440587.5


def local_sidereal_time_deg(longitude_deg: float, now: datetime | None = None) -> float:
    """Return local sidereal time in degrees [0, 360)."""
    jd = _julian_date(now or datetime.now())
    t = (jd - _JD_EPOCH) / _DAYS_PER_CENTURY
    gmst = (280.46061837
            + 360.98564736629 * (jd - _JD_EPOCH)
            + 0.000387933 * t * t
            - (t * t * t) / 38710000.0)
    lst = (gmst + longitude_deg) % 360.0
    if lst < 0:
        lst += 360.0
    return lst


def hour_angle_hours(ra_hours: float, lst_deg: float) -> float:
    """Return HA in hours, normalized to [-12, +12).

    HA = (LST - RA) with both in hours. Positive = west of meridian.
    """
    lst_hours = lst_deg / 15.0
    ha = lst_hours - ra_hours
    ha = (ha + 12.0) % 24.0 - 12.0  # wrap into [-12, +12)
    return ha


def time_to_flip(ha_hours: float, margin_hours: float = 0.0) -> float:
    """Estimated hours until the flip threshold is crossed.

    Positive value: flip in the future.  Negative: the threshold was already
    crossed ``-value`` hours ago.
    """
    # HA is increasing at ~1 h per hour of sidereal time (≈1.0027 solar).
    # We approximate with solar hours for simplicity (the flip threshold
    # is a soft configuration knob anyway).
    return margin_hours - ha_hours


def flip_due(ha_hours: float, margin_hours: float = 0.0,
             min_alt_deg: float = 0.0, alt_deg: float | None = None) -> bool:
    """Return True when a meridian flip is due.

    - ``ha_hours``      : current hour angle (hours, west-positive).
    - ``margin_hours``  : flip fires when HA >= margin (0 = at meridian).
    - ``min_alt_deg``   : do not flip below this altitude (safety).
    - ``alt_deg``       : current altitude, may be None (unknown).
    """
    if ha_hours < margin_hours:
        return False
    if alt_deg is not None and alt_deg < min_alt_deg:
        return False
    return True


def flip_side(ha_hours: float) -> str:
    """Return 'est' | 'ouest' | 'meridien' based on HA sign."""
    if abs(ha_hours) < 1e-6:
        return "meridien"
    return "ouest" if ha_hours > 0 else "est"


def fmt_ha(ha_hours: float) -> str:
    """Format HA as e.g. '-02h30' (positive = west)."""
    sign = "+" if ha_hours >= 0 else "−"
    total_min = int(round(abs(ha_hours) * 60))
    h, m = divmod(total_min, 60)
    return f"{sign}{h:02d}h{m:02d}"


def fmt_time_to_flip(hours: float) -> str:
    """Format relative time as 'dans 5 min' / 'il y a 3 min'."""
    minutes = int(round(hours * 60))
    if minutes >= 0:
        if minutes >= 120:
            return f"flip dans {minutes // 60}h{minutes % 60:02d}"
        return f"flip dans {minutes} min"
    minutes = -minutes
    if minutes >= 120:
        return f"flip passé il y a {minutes // 60}h{minutes % 60:02d}"
    return f"flip passé il y a {minutes} min"


def ha_from_altaz(ra_hours: float, dec_deg: float,
                  alt_deg: float, az_deg: float, lat_deg: float,
                  lon_deg: float, now: datetime | None = None) -> float | None:
    """Compute HA from an Alt/Az observation (fallback when RA is stale).

    Solves the astronomical triangle for the hour angle and wraps it to
    [-12, +12) hours. Returns None on degenerate input.
    """
    from math import radians, degrees, asin, cos, sin, acos

    if ra_hours is None or dec_deg is None:
        return None
    lst = local_sidereal_time_deg(lon_deg, now)
    lat = radians(lat_deg)
    dec = radians(dec_deg)
    alt = radians(alt_deg)
    az = radians(az_deg)
    try:
        cos_h = (sin(alt) - sin(lat) * sin(dec)) / (cos(lat) * cos(dec))
        cos_h = max(-1.0, min(1.0, cos_h))
        h_deg = degrees(acos(cos_h))
    except (ValueError, ZeroDivisionError):
        return None
    # Hour angle sign from azimuth: eastern targets (AZ < 180°) have HA < 0
    if az > 180.0:
        h_deg = -h_deg
    ha = h_deg / 15.0
    return (ha + 12.0) % 24.0 - 12.0
