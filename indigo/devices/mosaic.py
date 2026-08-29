"""
mosaic.py — Mosaic tile planning (Lot D1).

Pure helpers for splitting a target too large for a single field of view into
an N×M grid, aligned with RA/Dec (north up, no camera rotation), plus the
spreading of an exposure plan across the tiles.  No I/O here — the web layer
feeds the FOV/coord context and the sequence runner performs the moves.
"""

from __future__ import annotations

import math
from typing import Any

# Clamp for cos(dec) so RA steps don't explode near the poles.
MIN_COS_DEC = 0.15
MAX_OVERLAP = 0.90


def camera_fov(
    width_px: int, height_px: int, pixel_size_um: float, focal_length_mm: float,
) -> tuple[float, float] | None:
    """Field of view (deg, deg) from sensor geometry.

    FOV is independent of binning (binning down-samples, it does not change the
    projected field).  Returns ``None`` when the optics are not known.
    """
    if not width_px or not height_px or not pixel_size_um or not focal_length_mm:
        return None
    sensor_w_mm = width_px * pixel_size_um / 1000.0
    sensor_h_mm = height_px * pixel_size_um / 1000.0
    k = 180.0 / math.pi
    return (sensor_w_mm / focal_length_mm * k,
            sensor_h_mm / focal_length_mm * k)


def plan_mosaic(
    center_ra_deg: float,
    center_dec_deg: float,
    size_arcmin_w: float,
    size_arcmin_h: float,
    fov_x_deg: float,
    fov_y_deg: float,
    overlap_frac: float = 0.15,
) -> dict[str, Any]:
    """Split ``center`` into a tiling that covers ``size``.

    Grid is aligned to RA/Dec (ECT row-major, row 0 = south, col 0 = west,
    index = row * cols + col).  Returns ``{"ok": False, "error": ...}`` on
    invalid input, otherwise the plan with ``tiles`` (each carrying its center
    in both degrees and hours).
    """
    fov_x, fov_y = float(fov_x_deg), float(fov_y_deg)
    if fov_x <= 0 or fov_y <= 0:
        return {"ok": False, "error": "fov invalide"}
    if size_arcmin_w <= 0 or size_arcmin_h <= 0:
        return {"ok": False, "error": "taille cible invalide"}
    overlap = min(max(float(overlap_frac), 0.0), MAX_OVERLAP)

    step_w = fov_x * (1.0 - overlap)          # center-to-center spacing (deg)
    step_h = fov_y * (1.0 - overlap)
    span_w = size_arcmin_w / 60.0
    span_h = size_arcmin_h / 60.0
    cols = max(1, math.ceil(span_w / step_w))
    rows = max(1, math.ceil(span_h / step_h))

    cos_dec = max(math.cos(math.radians(center_dec_deg)), MIN_COS_DEC)
    # Corrections carried as absolute RA degrees at the tangent point.
    d_ra_per_step = step_w / cos_dec

    tiles: list[dict[str, Any]] = []
    for r in range(rows):
        dec_off = (r - (rows - 1) / 2.0) * step_h
        for c in range(cols):
            ra_off = (c - (cols - 1) / 2.0) * d_ra_per_step
            ra_deg = (float(center_ra_deg) + ra_off) % 360.0
            dec_deg = float(center_dec_deg) + dec_off
            tiles.append({
                "index": r * cols + c,
                "row": r, "col": c,
                "ra_deg": round(ra_deg, 6),
                "dec_deg": round(dec_deg, 6),
                "ra_hours": round(ra_deg / 15.0, 6),
            })

    return {
        "ok": True,
        "center": {"ra_deg": float(center_ra_deg), "dec_deg": float(center_dec_deg)},
        "size_arcmin": {"w": float(size_arcmin_w), "h": float(size_arcmin_h)},
        "fov": {"x_deg": fov_x, "y_deg": fov_y},
        "overlap_frac": overlap,
        "rows": rows, "cols": cols,
        "tiles": tiles,
        "single": len(tiles) == 1,
    }


def expand_frames(frames: list[dict], plan: dict) -> list[dict]:
    """Duplicate an exposure plan once per mosaic tile.

    Every frame is stamped with its tile (index + row/col), the total tile
    count and the tile center — the sequence ``before_frame`` hook uses those
    ``goto_*`` keys to slew + recentre when the tile changes.
    """
    tiles = plan.get("tiles") or []
    out: list[dict] = []
    for t in tiles:
        for fr in frames:
            out.append({
                **fr,
                "tile": t["index"],
                "tile_row": t["row"],
                "tile_col": t["col"],
                "tiles_total": len(tiles),
                "goto_ra_hours": t["ra_hours"],
                "goto_dec_deg": t["dec_deg"],
            })
    return out