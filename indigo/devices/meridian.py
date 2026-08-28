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


# ── Visibility (altitude over time) ─────────────────────────────

def altitude_deg(lat_deg: float, dec_deg: float, ha_hours: float) -> float:
    """Terrestrial altitude (°) of a target given its declination and hour angle.

    ``sin(alt) = sin(lat)·sin(dec) + cos(lat)·cos(dec)·cos(HA)``
    """
    lat = math.radians(lat_deg)
    dec = math.radians(dec_deg)
    ha = math.radians(ha_hours * 15.0)
    sin_alt = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
    sin_alt = max(-1.0, min(1.0, sin_alt))
    return math.degrees(math.asin(sin_alt))


def _rise_set_ha(lat_deg: float, dec_deg: float, horizon_deg: float) -> float | None:
    """Hour angle (positive hours) at which the target crosses ``horizon``.

    Returns None when the target never rises/sets at that altitude (is either
    always above or always below the horizon at this latitude).
    """
    lat = math.radians(lat_deg)
    dec = math.radians(dec_deg)
    hz = math.sin(math.radians(horizon_deg))
    denom = math.cos(lat) * math.cos(dec)
    if abs(denom) < 1e-9:
        return None
    cos_h = (hz - math.sin(lat) * math.sin(dec)) / denom
    if cos_h < -1.0 or cos_h > 1.0:
        return None  # circumpolar
    return math.degrees(math.acos(cos_h)) / 15.0  # hours


def visibility_24h(ra_hours: float, dec_deg: float, lat_deg: float,
                   lon_deg: float, now: datetime | None = None,
                   steps: int = 48, horizon_deg: float = 0.0,
                   min_alt_deg: float = 0.0) -> dict:
    """Compute the 24h visibility window starting at ``now`` for a target.

    Returns the altitude curve (sampled points, UTC-timestamped), the rise /
    transit / set instants (UTC epoch seconds) and the best-observability
    window above ``min_alt_deg``.  ``now`` defaults to the current instant.
    """
    now = now or datetime.now()
    start_epoch = now.timestamp()
    curve: list[dict] = []
    for i in range(steps + 1):
        dt = start_epoch + i * (86400.0 / steps)
        dt_dt = datetime.fromtimestamp(dt)
        lst = local_sidereal_time_deg(lon_deg, dt_dt)
        ha = hour_angle_hours(ra_hours, lst)
        alt = altitude_deg(lat_deg, dec_deg, ha)
        curve.append({"epoch": round(dt), "ha_hours": round(ha, 4),
                      "alt_deg": round(alt, 4)})

    # Find the current transit (LST == RA) within the window.
    lst_now = local_sidereal_time_deg(lon_deg, now)
    ha_now = hour_angle_hours(ra_hours, lst_now)
    to_transit = (-ha_now) % 24.0
    transit_epoch = start_epoch + to_transit * 3600.0

    # Rise/set in hour-angle relative to transit (LST == RA).
    ha_rs = _rise_set_ha(lat_deg, dec_deg, horizon_deg)
    rise_epoch = set_epoch = None
    if ha_rs is not None:
        rise_epoch = transit_epoch - ha_rs * 3600.0
        set_epoch = transit_epoch + ha_rs * 3600.0

    # Observability window: contiguous above min_alt_deg.
    best_night: dict | None = None
    above = [p for p in curve if p["alt_deg"] >= min_alt_deg]
    if above:
        best_night = {
            "start_epoch": above[0]["epoch"],
            "end_epoch": above[-1]["epoch"],
            "max_alt_deg": max(p["alt_deg"] for p in above),
        }

    return {
        "ra_hours": float(ra_hours),
        "dec_deg": float(dec_deg),
        "horizon_deg": float(horizon_deg),
        "min_alt_deg": float(min_alt_deg),
        "start_epoch": round(start_epoch),
        "steps": steps,
        "curve": curve,
        "rise_epoch": rise_epoch,
        "transit_epoch": transit_epoch,
        "set_epoch": set_epoch,
        "best_observable": best_night,
    }

