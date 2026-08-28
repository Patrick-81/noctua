"""Pointing-model routes (collect/serve interpolated corrections)."""

from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/pointing/status")
    async def pointing_status():
        return SanitizedJSONResponse(server._pointing.status())

    @app.post("/api/pointing/add")
    async def pointing_add(body: dict):
        """Record one measured pointing error (deg, equatorial).

        body = {"ra_deg": 100.5, "dec_deg": 35.0,
                "delta_ra_deg": 0.5, "delta_dec_deg": -0.3}
        """
        try:
            st = server._pointing.add_sample(
                body["ra_deg"], body["dec_deg"],
                body["delta_ra_deg"], body["delta_dec_deg"],
            )
        except KeyError as e:
            return {"ok": False, "error": f"missing field: {e}"}
        return SanitizedJSONResponse({"ok": True, **st})

    @app.post("/api/pointing/correct")
    async def pointing_correct(body: dict):
        """Interpolate the corrective offset for a sky position (deg).

        body = {"ra_deg": 100.5, "dec_deg": 35.0}
        """
        res = server._pointing.correct(body["ra_deg"], body["dec_deg"])
        return SanitizedJSONResponse(res if res is not None else
                                     {"ok": False, "error": "no samples yet"})

    @app.post("/api/pointing/clear")
    async def pointing_clear():
        st = server._pointing.clear()
        return SanitizedJSONResponse({"ok": True, **st})

    @app.post("/api/pointing/fit")
    async def pointing_fit():
        """Fit the global parametric pointing model on the collected samples.

        Once fitted, /correct returns ``model + residual-IDW`` corrections.
        """
        st = server._pointing.fit()
        fit = st["model_fit"]
        if fit.get("active"):
            return SanitizedJSONResponse({"ok": True, **st,
                                          "rms_arcmin": fit.get("rms_arcmin"),
                                          "fit_n": fit.get("fit_n")})
        return SanitizedJSONResponse({"ok": False, **st,
                                      "error": fit.get("error") or "fit failed"})

    @app.post("/api/pointing/record-solve")
    async def pointing_record_solve(body: dict):
        """Auto-record a pointing sample from a slew + plate-solve result.

        Compares the commanded (ra_hours, dec_deg) position against the solved
        (ra_deg, dec_deg) center, in degrees, and adds the delta to the model.
        This is how the model learns from every recenter/plate-solve pass.

        body = {"ra_hours": 6.7, "dec_deg": 35.0, "solved_ra_deg": ..., "solved_dec_deg": ...}
        """
        try:
            ra_deg_target = float(body["ra_hours"]) * 15.0
            dec_target = float(body["dec_deg"])
            solved_ra = float(body["solved_ra_deg"])
            solved_dec = float(body["solved_dec_deg"])
        except (KeyError, ValueError) as e:
            return {"ok": False, "error": f"bad fields: {e}"}

        # Correction to APPLY to a commanded position to cancel the measured
        # systematic error: the mount overshot by (solved - target), so a goto
        # to target must be offset by -(solved - target) = target - solved.
        # Signed across the RA wrap. Consistent with the manual /add payload
        # (delta_* = correction to add).
        dra = ra_deg_target - solved_ra
        if dra > 180.0:
            dra -= 360.0
        elif dra < -180.0:
            dra += 360.0
        ddec = dec_target - solved_dec

        st = server._pointing.add_sample(ra_deg_target, dec_target, dra, ddec)
        return SanitizedJSONResponse({"ok": True, **st,
                                      "delta_ra_deg": round(dra, 4),
                                      "delta_dec_deg": round(ddec, 4)})
