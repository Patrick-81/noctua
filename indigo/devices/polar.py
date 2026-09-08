"""
polar.py — TPPA backend (P1.2).

Port de tests/polar_math.js en Python pur, testable sans INDIGO.
Fournit :
- lst_from_time(date, lng_deg)  (non utilisé côté serveur, garde pour parité)
- targets_for_lst(lst_deg, lat_deg, angle_min)
- polar_compute(solves, lat_deg, lst_deg) → {poleRA, poleDEC, errAlt, errAz, errTotal}

Méthode TPPA 3 points : 3 solves → vecteurs unitaires → pôle = normalisé((v1-v2)×(v1-v3)).
Erreur alt/az dérivée du pôle trouvé vs pôle vrai (DEC=+90°).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

_TORAD = math.pi / 180.0
_TODEG = 180.0 / math.pi


def _to_vec(ra_deg: float, dec_deg: float) -> tuple[float, float, float]:
    ra = ra_deg * _TORAD
    dec = dec_deg * _TORAD
    return (
        math.cos(dec) * math.cos(ra),
        math.cos(dec) * math.sin(ra),
        math.sin(dec),
    )


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _norm(v) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def _normalize(v):
    n = _norm(v)
    if n == 0:
        raise ValueError("vecteur nul")
    return (v[0] / n, v[1] / n, v[2] / n)


def compute_targets(lst_deg: float, lat_deg: float, angle_min: float = 30.0) -> list[dict]:
    """3 cibles TPPA : centre + ± angle autour du méridien."""
    angle_min = max(5.0, min(120.0, float(angle_min or 30)))
    dec_deg = 90.0 - lat_deg + 20.0
    ha_offset_deg = angle_min / 4.0
    ha_offsets = [0.0, ha_offset_deg, -ha_offset_deg]
    out = []
    for ha in ha_offsets:
        ra_deg = ((lst_deg - ha) % 360 + 360) % 360
        out.append({"ra_hours": ra_deg / 15.0, "dec_deg": dec_deg})
    return out


def fit_pole_from_solves(solves: list[dict]) -> dict:
    """solves = [{ra: deg, dec: deg}, ...] (3 requis)."""
    if len(solves) < 3:
        raise ValueError("3 solves requis")
    v0, v1, v2 = [_to_vec(s["ra"], s["dec"]) for s in solves[:3]]
    pole = _normalize(_cross(_sub(v0, v1), _sub(v0, v2)))
    if pole[2] < 0:
        pole = (-pole[0], -pole[1], -pole[2])
    ra = ((math.degrees(math.atan2(pole[1], pole[0])) % 360) + 360) % 360
    dec = math.degrees(math.asin(max(-1.0, min(1.0, pole[2]))))
    return {"ra": ra, "dec": dec, "vec": pole}


def polar_compute(solves: list[dict], lat_deg: float, lst_deg: float | None = None) -> dict:
    """Calcule erreur de mise en station.

    Retourne {poleRA, poleDEC, errAltArcmin, errAzArcmin, errTotalArcmin, poleVec}
    errAlt >0 = pôle trop bas (monter), errAz >0 = trop à l'est.
    """
    pole = fit_pole_from_solves(solves)
    err_dec = 90.0 - pole["dec"]  # deg
    # Azimuth : projection sur E-W au pôle, modulée par cos(lat)
    err_az = err_dec * math.sin(pole["ra"] * _TORAD) * math.cos(lat_deg * _TORAD)
    err_alt_arcmin = err_dec * 60.0
    err_az_arcmin = err_az * 60.0
    err_total = math.sqrt(err_alt_arcmin**2 + err_az_arcmin**2)
    return {
        "poleRA": pole["ra"],
        "poleDEC": pole["dec"],
        "poleVec": pole["vec"],
        "errAltArcmin": err_alt_arcmin,
        "errAzArcmin": err_az_arcmin,
        "errTotalArcmin": err_total,
        # compat polar_math.js keys
        "errDec": err_dec,
        "errAz": err_az,
        "errTotal": err_total,
    }


def lst_from_time(dt: datetime, lng_deg: float) -> float:
    """LST en degrés pour tests/parité JS."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    jd = dt.timestamp() / 86400.0 + 2440587.5
    t = (jd - 2451545.0) / 36525.0
    gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000.0
    gmst = ((gmst % 360) + 360) % 360
    lst = (gmst + lng_deg) % 360
    if lst < 0:
        lst += 360
    return lst
