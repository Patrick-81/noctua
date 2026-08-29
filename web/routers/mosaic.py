"""Routes REST mosaïque (Lot D1) : champ couvert + plan de tuiles."""

from indigo.devices import mosaic as mz

from .common import SanitizedJSONResponse, log


def register(app, server):
    @app.get("/api/mosaic/fov")
    async def mosaic_fov():
        """Champ de la caméra courante (deg) à partir de la focale connue."""
        cam = server.registry.get_camera()
        fov = None
        if cam:
            fov = mz.camera_fov(cam.width_px, cam.height_px,
                                cam.pixel_size_um, cam.focal_length_mm)
        return SanitizedJSONResponse({
            "ok": bool(fov),
            "fov_x_deg": fov[0] if fov else None,
            "fov_y_deg": fov[1] if fov else None,
            "scale_arcsec_px": None,
            "camera": cam.name if cam else None,
        })

    @app.post("/api/mosaic/plan")
    async def mosaic_plan(body: dict):
        """Planifie une grille N×M centrée sur la cible.

        Champ : soit passé explicitement (``fov_x_deg``/``fov_y_deg``), soit
        déduit de la caméra courante (focale + capteur).  Body :
        ``target_coords {ra_hours, dec_deg}``, ``size_arcmin {w, h}``,
        ``overlap_frac``, ``fov_x_deg``/``fov_y_deg`` (optionnels).
        """
        tc = body.get("target_coords") or {}
        ra_hours = tc.get("ra_hours")
        dec_deg = tc.get("dec_deg")
        if ra_hours is None or dec_deg is None:
            return {"ok": False, "error": "target_coords.ra_hours/dec_deg requis"}
        size = body.get("size_arcmin") or {}
        size_w = size.get("w")
        size_h = size.get("h")
        if not size_w or not size_h:
            return {"ok": False, "error": "size_arcmin.w/h requis"}

        fov_x = body.get("fov_x_deg")
        fov_y = body.get("fov_y_deg")
        if not fov_x or not fov_y:
            cam = server.registry.get_camera()
            fov = cam and mz.camera_fov(cam.width_px, cam.height_px,
                                        cam.pixel_size_um, cam.focal_length_mm)
            if not fov:
                return {"ok": False,
                        "error": "FOV indisponible (focale inconnue) — "
                                 "passer fov_x_deg/fov_y_deg"}
            fov_x, fov_y = fov

        plan = mz.plan_mosaic(
            ra_hours * 15.0, dec_deg, size_w, size_h,
            fov_x, fov_y, body.get("overlap_frac", 0.15))
        if plan.get("ok"):
            log.debug(f"mosaïque planifiée : {plan['rows']}×{plan['cols']} "
                      f"= {len(plan['tiles'])} tuiles")
        return SanitizedJSONResponse(plan)