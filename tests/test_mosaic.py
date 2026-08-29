"""Tests du planificateur de mosaïque (Lot D1)."""

import math

import pytest

from indigo.devices.mosaic import camera_fov, expand_frames, plan_mosaic


def test_camera_fov_math():
    # Capteur 3000×2000 px @ 3.45 µm = 10.35 × 6.90 mm, focale 500 mm.
    fov = camera_fov(3000, 2000, 3.45, 500.0)
    assert fov is not None
    k = 180.0 / math.pi
    assert fov[0] == pytest.approx(10.35 / 500.0 * k)
    assert fov[1] == pytest.approx(6.90 / 500.0 * k)


def test_camera_fov_unknown_optics():
    assert camera_fov(0, 2000, 3.45, 500.0) is None
    assert camera_fov(3000, 2000, 0.0, 500.0) is None
    assert camera_fov(3000, 2000, 3.45, 0.0) is None


def test_plan_single_tile_when_fov_covers():
    plan = plan_mosaic(10, 30, 10, 10, 60, 60, 0.15)
    assert plan["ok"] is True
    assert plan["rows"] == 1 and plan["cols"] == 1
    assert plan["single"] is True
    assert len(plan["tiles"]) == 1
    t = plan["tiles"][0]
    assert t["index"] == 0 and t["row"] == 0 and t["col"] == 0
    assert t["ra_deg"] == 10.0 and t["dec_deg"] == 30.0
    assert t["ra_hours"] == pytest.approx(10.0 / 15.0)


def test_plan_2x2_symmetric_grid():
    # FOV 1°×1°, recouvrement 50 % → pas de 0.5°, cible 60'×60' → 2×2.
    plan = plan_mosaic(50, 20, 60, 60, 1.0, 1.0, 0.5)
    assert plan["ok"] is True
    assert plan["rows"] == 2 and plan["cols"] == 2
    assert len(plan["tiles"]) == 4
    assert len(plan["tiles"]) == 1 * 2 * 2  # full grid
    d_ra = 0.5 / math.cos(math.radians(20.0)) / 2.0
    d_dec = 0.25
    by_pos = {(t["row"], t["col"]): t for t in plan["tiles"]}
    # Coin sud-ouest : index 0, RA < centre, DEC < centre.
    sw = by_pos[(0, 0)]
    assert sw["index"] == 0
    assert sw["ra_deg"] == pytest.approx(50.0 - d_ra)
    assert sw["dec_deg"] == pytest.approx(20.0 - d_dec)
    # Coin nord-est : index 3, RA > centre, DEC > centre.
    ne = by_pos[(1, 1)]
    assert ne["index"] == 3
    assert ne["ra_deg"] == pytest.approx(50.0 + d_ra)
    assert ne["dec_deg"] == pytest.approx(20.0 + d_dec)
    assert ne["ra_hours"] == pytest.approx(ne["ra_deg"] / 15.0)


def test_plan_index_row_major():
    plan = plan_mosaic(50, 20, 60, 60, 1.0, 1.0, 0.5)
    idx = {(t["row"], t["col"]): t["index"] for t in plan["tiles"]}
    assert idx[(0, 0)] == 0 and idx[(0, 1)] == 1
    assert idx[(1, 0)] == 2 and idx[(1, 1)] == 3


def test_plan_ra_wrap():
    # Centre près de 0h : les RA des tuiles doivent être cohérentes modulo 360.
    center, dec = 359.5, 10.0
    plan = plan_mosaic(center, dec, 60, 30, 0.5, 0.5, 0.5)
    assert plan["ok"] is True
    cols, rows = plan["cols"], plan["rows"]
    assert cols >= 2
    d_ra = 0.25 / math.cos(math.radians(dec))
    offset = {c: (c - (cols - 1) / 2.0) * d_ra for c in range(cols)}
    for t in plan["tiles"]:
        assert 0.0 <= t["ra_deg"] < 360.0
        expected = (center + offset[t["col"]]) % 360.0
        assert t["ra_deg"] == pytest.approx(expected)
    # La colonne ouest passe bien de l'autre côté de 0h.
    west = [t["ra_deg"] for t in plan["tiles"] if t["col"] == 0]
    assert max(west) > 350.0 or min(west) < 10.0
    # Les deux colonnes ouest/est ne se recouvrent pas.
    east = [t["ra_deg"] for t in plan["tiles"] if t["col"] == cols - 1]
    assert min(east) > max(west) or min(east) > 350.0


def test_plan_pole_clamp_keeps_finite():
    # Cos(dec) très faible → clampé, aucun nombre explosé.
    plan = plan_mosaic(10, 89.5, 60, 30, 0.5, 0.5, 0.5)
    assert plan["ok"] is True
    cols = plan["cols"]
    assert cols >= 2
    for t in plan["tiles"]:
        assert math.isfinite(t["ra_deg"]) and math.isfinite(t["dec_deg"])


def test_plan_invalid_inputs():
    assert plan_mosaic(10, 30, 60, 60, 0, 1, 0.1)["ok"] is False
    assert plan_mosaic(10, 30, -5, 60, 1, 1, 0.1)["ok"] is False
    assert plan_mosaic(10, 30, 60, 60, 1, 1, 0.1)["ok"] is True


def test_plan_overlap_clamped():
    plan = plan_mosaic(50, 20, 20, 20, 1, 1, 0.99)
    assert plan["overlap_frac"] == plan["overlap_frac"]  # kept
    plan_big = plan_mosaic(50, 20, 20, 20, 1, 1, 1.5)
    assert plan_big["overlap_frac"] <= 0.90


def test_expand_frames_per_tile():
    frames = [
        {"duration": 5.0, "frame_type": "LIGHT", "count": 1},
        {"duration": 3.0, "frame_type": "LIGHT", "count": 1},
    ]
    plan = plan_mosaic(10, 30, 60, 60, 1.0, 1.0, 0.5)  # 2×2
    out = expand_frames(frames, plan)
    assert len(out) == 2 * 4
    t0 = plan["tiles"][0]
    tile0 = [f for f in out if f["tile"] == 0]
    assert len(tile0) == 2 and tile0[0]["duration"] == 5.0
    assert tile0[1]["duration"] == 3.0
    t = tile0[0]
    assert t["tile_row"] == 0 and t["tile_col"] == 0
    assert t["tiles_total"] == 4
    assert t["goto_ra_hours"] == t0["ra_hours"]
    assert t["goto_dec_deg"] == t0["dec_deg"]
    assert "goto_ra_hours" in out[-1]


def test_expand_flat_no_mosaic():
    assert expand_frames([{"duration": 1.0}], {"tiles": []}) == []