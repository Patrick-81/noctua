"""Tests de la visibilité 24h (meridian.visibility_24h + routeur /api/visibility)."""

import math
from datetime import datetime

import pytest

from indigo.devices.meridian import (
    altitude_deg,
    _rise_set_ha,
    visibility_24h,
)
from web.routers.visibility import _enrich, surface_brightness


# ── Pure math ───────────────────────────────────────────────────

def test_altitude_at_transit():
    # dec=0, lat=45 → altitude = 45° exactly at HA=0.
    assert altitude_deg(45.0, 0.0, 0.0) == pytest.approx(45.0)
    # Pole star (dec=90) at lat=45 → altitude ~ 45° regardless of HA.
    assert altitude_deg(45.0, 90.0, 5.0) == pytest.approx(45.0)


def test_altitude_range():
    # alt must stay in [-90, 90]
    for lat in (-60, 0, 45, 70):
        for dec in (-80, -30, 0, 40, 85):
            for ha in (0, 3, -6, 10):
                a = altitude_deg(lat, dec, ha)
                assert -90.0 <= a <= 90.0


def test_rise_set_ha_symmetric():
    # At the equator an equatorial target rises/sets ±6h around transit.
    ha = _rise_set_ha(0.0, 0.0, 0.0)
    assert ha is not None and math.isclose(ha, 6.0, abs_tol=0.02)


def test_rise_set_polar_none():
    # A target at the celestial pole is circumpolar at mid-latitudes.
    assert _rise_set_ha(45.0, 90.0, 0.0) is None
    assert _rise_set_ha(45.0, -90.0, 0.0) is None


def test_visibility_24h_curve_and_events():
    now = datetime(2026, 8, 27, 0, 0, 0)
    v = visibility_24h(5.0, 0.0, 45.0, 0.0, now=now)
    assert len(v["curve"]) == 48 + 1
    assert v["transit_epoch"] is not None
    assert v["rise_epoch"] is not None and v["set_epoch"] is not None
    # rise before transit, set after transit
    assert v["rise_epoch"] < v["transit_epoch"] < v["set_epoch"]
    if v["best_observable"]:
        mx = v["best_observable"]["max_alt_deg"]
        assert mx <= 90.0


def test_visibility_24h_circumpolar_has_transit():
    now = datetime(2026, 8, 27, 0, 0, 0)
    v = visibility_24h(2.5, 89.9, 45.0, 0.0, now=now)
    assert v["rise_epoch"] is None and v["set_epoch"] is None
    assert v["transit_epoch"] is not None


# ── Surface brightness ──────────────────────────────────────────

def test_surface_brightness_known_value():
    # M42 Orion Nebula: mag 4.0, 66×60 arcmin → ~21.6 mag/arcsec².
    sb = surface_brightness(4.0, [66.0, 60.0])
    assert sb is not None and math.isclose(sb, 21.6, abs_tol=0.3)


def test_surface_brightness_edge_cases():
    assert surface_brightness(None, [10, 10]) is None        # no magnitude
    assert surface_brightness(5.0, None) is None             # no size
    assert surface_brightness(5.0, []) is None               # empty size
    assert surface_brightness(5.0, [0, 0]) is None           # degenerate size


# ── Catalog enrichment ──────────────────────────────────────────

def test_enrich_messier_by_id():
    o = _enrich("M42", 83.82, -5.39)
    assert o["catalog"] == "Messier"
    assert o["mag"] is not None
    assert o["size_arcmin"]
    assert o["surface_brightness"] is not None


def test_enrich_ngc_by_id():
    o = _enrich("NGC 224", 10.684, 41.269)
    assert o["type"]
    assert o["name"]


def test_enrich_star_has_no_surface_brightness():
    o = _enrich("Sirius", 101.287, -16.716)
    assert o["surface_brightness"] is None
    assert o["mag"] is not None


def test_enrich_unknown_returns_minimal_or_nearest():
    # With no id, an isolated sky point still yields a well-formed object
    # (the dense BSC/NGC catalogs usually provide a nearest neighbour) and the
    # requested coordinates are preserved.
    o = _enrich("", 200.0, -40.0)
    assert o["ra_deg"] == 200.0
    assert o["dec_deg"] == -40.0
    assert o["type"] is not None
    assert o["id"] is not None


def test_enrich_without_id_nearest_star_leaves_id_needed_for_dso():
    # M42's coordinates are a hair away from a bright BSC5 star (HR 1895);
    # with bare coordinates the nearest match wins, so the framing assistant
    # must carry the catalog id (M42) through — then the size is returned.
    o = _enrich("", 83.82, -5.39)
    assert o["id"] == "HR 1895"
    assert not o["size_arcmin"] or o["size_arcmin"] == [1]
    o = _enrich("M42", 83.82, -5.39)
    assert o["id"] == "M42"
    assert o["size_arcmin"]
    assert o["surface_brightness"] is not None


# ── Router integration ──────────────────────────────────────────

def _make_client():
    from fastapi.testclient import TestClient
    from indigo.registry import DeviceRegistry
    from web.server import WebServer
    registry = DeviceRegistry(type("Client", (), {})())
    server = WebServer(registry, site_config={"latitude": 44.0, "longitude": 2.0})
    return TestClient(server.app)


def test_router_visibility_shape():
    tc = _make_client()
    r = tc.get("/api/visibility", params={"ra": 83.82, "dec": -5.39, "id": "M42"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["object"]["id"] == "M42"
    assert data["object"]["surface_brightness"] is not None
    vis = data["visibility"]
    assert vis["curve"]
    assert vis["start_epoch"] > 0
    assert data["site"]["latitude"] == 44.0


def test_router_visibility_no_catalog():
    tc = _make_client()
    r = tc.get("/api/visibility", params={"ra": 320.0, "dec": 12.0})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    # Even with no id, a target gets a visibility curve.
    assert data["visibility"]["curve"]
    # Coordinates are echoed back and the object is well-formed.
    assert data["object"]["ra_deg"] == 320.0
    assert data["object"]["dec_deg"] == 12.0
