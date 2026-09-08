"""Polar TPPA routes (P1.2)."""

from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/polar/targets")
    async def polar_targets(lat: float | None = None, lng: float | None = None, angle: float = 30.0):
        from indigo.devices.polar import compute_targets, lst_from_time
        from datetime import datetime, timezone

        site = server.site or {}
        lat_v = float(lat if lat is not None else site.get("latitude", 43.952))
        lng_v = float(lng if lng is not None else site.get("longitude", 1.568))
        lst = lst_from_time(datetime.now(timezone.utc), lng_v)
        tgts = compute_targets(lst, lat_v, angle)
        return SanitizedJSONResponse({"lst_deg": lst, "targets": tgts, "angle_min": angle})

    @app.post("/api/polar/compute")
    async def polar_compute(body: dict):
        from indigo.devices.polar import polar_compute as _compute

        solves = body.get("solves") or []
        if len(solves) < 3:
            return SanitizedJSONResponse({"ok": False, "error": "3 solves requis {ra, dec} en degrés"}, status_code=400)
        try:
            # normalise {ra, dec} en degrés
            norm = []
            for s in solves[:3]:
                ra = float(s.get("ra", s.get("ra_deg", s.get("RA", 0))))
                dec = float(s.get("dec", s.get("dec_deg", s.get("DEC", 0))))
                norm.append({"ra": ra, "dec": dec})
        except (TypeError, ValueError) as e:
            return SanitizedJSONResponse({"ok": False, "error": f"solve invalide: {e}"}, status_code=400)
        site = server.site or {}
        lat = float(body.get("lat", site.get("latitude", 43.952)))
        lst = body.get("lst_deg")
        try:
            lst_f = float(lst) if lst is not None else None
        except (TypeError, ValueError):
            lst_f = None
        try:
            res = _compute(norm, lat, lst_f)
        except Exception as e:  # noqa: BLE001
            return SanitizedJSONResponse({"ok": False, "error": str(e)}, status_code=400)
        return SanitizedJSONResponse({"ok": True, **res})
