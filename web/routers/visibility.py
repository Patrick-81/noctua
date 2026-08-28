"""Visibility routes — 24h altitude curve + catalog enrichment for a target.

Given a target (RA/DEC and optionally a catalog id) this returns:
  - the catalog data we have (mag, size, type, constellation, names) and the
    computed surface brightness,
  - a 24h altitude curve plus rise/transit/set and the best observability window.

The catalog lookup is best-effort: exact id first, then closest RA/DEC.  A bare
map-click target with no catalog match still gets the visibility curve.
"""

from __future__ import annotations

import math
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import Query

from indigo.devices.meridian import visibility_24h

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer

log = logging.getLogger("indigo.visibility")

_CATALOG_ROOT = Path(__file__).resolve().parent.parent.parent / "public" / "catalogs"
_CATALOG_FILES = [
    "messier.json", "ngc_ic.json", "stars.json",
    "bsc5.json", "sharpless_sh2.json",
]


def surface_brightness(mag: float | None, size_arcmin: list | None) -> float | None:
    """Surface brightness (mag/arcsec²) from total mag + angular size.

    Standard formula:  SB = mag + 2.5·log10(area_arcmin²) + 2.5·log10(3600).
    Returns None when no meaningful size/mag is available (e.g. stars).
    """
    if mag is None or not size_arcmin:
        return None
    maj = float(size_arcmin[0]) if len(size_arcmin) > 0 else 0.0
    if maj <= 0:
        return None
    areamin = float(size_arcmin[1]) if len(size_arcmin) > 1 else maj
    if areamin <= 0:
        areamin = maj
    area = math.pi * (maj / 2.0) * (areamin / 2.0)  # arcmin² (ellipse)
    if area <= 0:
        return None
    return float(mag + 2.5 * math.log10(area) + 2.5 * math.log10(3600.0))


def _clean_id(s: str) -> str:
    return str(s or "").replace(" ", "").replace("　", "").upper()


class _CatalogIndex:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or _CATALOG_ROOT
        self._by_id: dict[str, dict] = {}
        self._all: list[dict] = []
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        for fname in _CATALOG_FILES:
            path = self._root / fname
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text())
            except Exception as e:  # noqa: BLE001
                log.warning("visibility catalogue %s unreadable: %s", fname, e)
                continue
            for o in data.get("objects", []):
                rec = {
                    "id": o.get("id"),
                    "name": (o.get("names") or [None])[0],
                    "names": o.get("names") or [],
                    "type": o.get("type") or "",
                    "ra_deg": o.get("ra_deg"),
                    "dec_deg": o.get("dec_deg"),
                    "mag": o.get("mag"),
                    "size_arcmin": o.get("size_arcmin"),
                    "constellation": o.get("constellation") or "",
                    "catalog": fname.replace(".json", "").title(),
                }
                self._all.append(rec)
                if rec["id"]:
                    self._by_id.setdefault(_clean_id(rec["id"]), rec)
        # Keep only unique ids (bsc5's HR ids etc. may clash across files; last
        # wins consistently via setdefault on first occurrence).

    def find(self, obj_id: str | None, ra_deg: float | None,
             dec_deg: float | None) -> dict | None:
        self._load()
        # 1) exact id
        if obj_id:
            rec = self._by_id.get(_clean_id(obj_id))
            if rec:
                return dict(rec)
        # 2) closest RA/DEC within ~1°
        if ra_deg is not None and dec_deg is not None and self._all:
            best, best_d = None, None
            for rec in self._all:
                if rec["ra_deg"] is None or rec["dec_deg"] is None:
                    continue
                d_ra = abs(((rec["ra_deg"] - ra_deg + 180.0) % 360.0) - 180.0)
                d_dec = abs(rec["dec_deg"] - dec_deg)
                d = math.hypot(d_ra, d_dec * math.cos(math.radians(dec_deg)))
                if best_d is None or d < best_d:
                    best, best_d = rec, d
            if best_d is not None and best_d <= 1.0:
                return dict(best)
        return None


_index = _CatalogIndex()


def _enrich(obj_id: str | None, ra_deg: float, dec_deg: float) -> dict:
    rec = _index.find(obj_id, ra_deg, dec_deg)
    if not rec:
        return {
            "id": obj_id or "",
            "name": obj_id or "",
            "names": [obj_id] if obj_id else [],
            "type": "",
            "catalog": "",
            "constellation": "",
            "mag": None,
            "size_arcmin": None,
            "surface_brightness": None,
            "ra_deg": ra_deg,
            "dec_deg": dec_deg,
        }
    rec["ra_deg"] = ra_deg
    rec["dec_deg"] = dec_deg
    is_star = str(rec.get("type") or "").lower() in ("star", "double_star", "variable_star")
    rec["surface_brightness"] = None if is_star else surface_brightness(
        rec.get("mag"), rec.get("size_arcmin"))
    return rec


def register(app, server: "WebServer") -> None:
    @app.get("/api/visibility")
    async def get_visibility(
        ra: float = Query(..., description="RA in degrees"),
        dec: float = Query(..., description="DEC in degrees"),
        id: str | None = Query(None, description="optional catalog id"),
        horizon_deg: float = Query(0.0),
        min_alt_deg: float = Query(10.0),
        steps: int = Query(48),
    ):
        lat = server.site.get("latitude", 0.0)
        lon = server.site.get("longitude", 0.0)
        obj = _enrich(id, ra, dec)
        vis = visibility_24h(ra / 15.0, dec, lat, lon,
                             horizon_deg=horizon_deg,
                             min_alt_deg=min_alt_deg, steps=steps)
        return SanitizedJSONResponse({
            "ok": True,
            "object": obj,
            "visibility": vis,
            "site": {"latitude": lat, "longitude": lon},
        })
