"""Common helpers shared by the route modules (moved out of server.py)."""

import json
import logging
import math

from fastapi.responses import JSONResponse

log = logging.getLogger("indigo.web")


def _sanitize(obj):
    """Recursively replace NaN/Inf with None for JSON safety."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


class SanitizedJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(_sanitize(content)).encode("utf-8")


def _mount_flip_status(state: dict, site: dict, telescope: dict) -> dict:
    """Compute meridian-flip figures and merge them into a mount state dict."""
    from indigo.devices.meridian import (
        flip_due, flip_side, fmt_ha, fmt_time_to_flip,
        hour_angle_hours, local_sidereal_time_deg, time_to_flip,
    )

    longitude = float(site.get("longitude", 0.0) or 0.0)
    margin = float(telescope.get("hour_angle_margin", 0.0) or 0.0)
    min_alt = float(telescope.get("min_altitude", 0.0) or 0.0)
    enabled = bool(telescope.get("flip_enabled", False))

    ra = state.get("ra_hours")
    alt = state.get("alt_deg")
    lst = local_sidereal_time_deg(longitude)
    ha = hour_angle_hours(ra, lst) if ra is not None else None

    if ha is None:
        merged = dict(state)
        merged["flip"] = {
            "enabled": enabled,
            "lst_deg": lst,
            "ha_hours": None,
            "ha_fmt": "---",
            "flip_due": False,
            "flip_side": "inconnu",
            "time_to_flip_fmt": "---",
            "hour_angle_margin": margin,
            "min_altitude": min_alt,
        }
        return merged

    due = flip_due(ha, margin, min_alt, alt)
    ttf = time_to_flip(ha, margin)
    merged = dict(state)
    merged["flip"] = {
        "enabled": enabled,
        "lst_deg": lst,
        "ha_hours": ha,
        "ha_fmt": fmt_ha(ha),
        "flip_due": due,
        "flip_side": flip_side(ha),
        "time_to_flip_fmt": fmt_time_to_flip(ttf),
        "hour_angle_margin": margin,
        "min_altitude": min_alt,
    }
    return merged
