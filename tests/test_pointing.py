"""Tests unitaires du PointingModel (indigo/devices/pointing.py)."""
import pytest

from indigo.devices.pointing import PointingModel, _wrapped_distance


def test_wrapped_distance_shortest_path():
    assert _wrapped_distance(350, 10) == 20
    assert _wrapped_distance(10, 350) == 20
    assert _wrapped_distance(0, 180) == 180
    assert _wrapped_distance(0, 90) == 90


def test_empty_model_returns_none():
    m = PointingModel()
    assert m.correct(30, 20) is None


def test_exact_sample_returned():
    m = PointingModel()
    m.add_sample(100.5, 35.2, +0.5, -0.3)
    res = m.correct(100.5, 35.2)
    assert res["delta_ra"] == pytest.approx(0.5)
    assert res["delta_dec"] == pytest.approx(-0.3)


def test_ra_wrap_interpolation():
    m = PointingModel()
    m.add_sample(359.0, 0.0, +1.0, 0.0)
    m.add_sample(1.0, 0.0, -1.0, 0.0)
    # Midway across the 0° meridian → equal weight → delta_ra ~ 0
    res = m.correct(0.0, 0.0)
    assert res["delta_ra"] == pytest.approx(0.0, abs=1e-6)
    assert res["samples"] == 2


def test_dec_clamped():
    m = PointingModel()
    st = m.add_sample(90.0, 95.0, 0.1, 0.1)   # dec > 90 gets clamped to 90
    assert st["samples"][0]["dec"] == 90.0


def test_clear():
    m = PointingModel()
    m.add_sample(90, 30, 1, 1)
    assert m.status()["sample_count"] == 1
    m.clear()
    assert m.status()["sample_count"] == 0


def test_status_shape():
    m = PointingModel()
    st = m.status()
    assert "sample_count" in st
    assert "max_samples" in st
    assert "samples" in st


def test_interpolation_between_two_dec_samples():
    m = PointingModel()
    m.add_sample(100.0, 10.0, +0.0, +1.0)
    m.add_sample(100.0, 50.0, +0.0, -1.0)
    # Midway in DEC → equal weight → delta_dec ~ 0
    res = m.correct(100.0, 30.0)
    assert res["delta_dec"] == pytest.approx(0.0, abs=1e-6)


# ── Router integration ───────────────────────────────────────────

def _make_client():
    from fastapi.testclient import TestClient
    from indigo.registry import DeviceRegistry
    from web.server import WebServer
    registry = DeviceRegistry(type("Client", (), {})())
    server = WebServer(registry)
    return TestClient(server.app), server


def test_router_status_empty_then_add_correct_clear():
    client, server = _make_client()
    st = client.get("/api/pointing/status").json()
    assert st["sample_count"] == 0

    r = client.post("/api/pointing/add", json={
        "ra_deg": 100.5, "dec_deg": 35.0,
        "delta_ra_deg": 0.5, "delta_dec_deg": -0.2}).json()
    assert r["ok"] is True
    assert r["sample_count"] == 1

    corr = client.post("/api/pointing/correct", json={"ra_deg": 100.5, "dec_deg": 35.0}).json()
    assert corr["delta_ra"] == pytest.approx(0.5)

    clr = client.post("/api/pointing/clear").json()
    assert clr["sample_count"] == 0


def test_router_correct_without_samples():
    client, server = _make_client()
    r = client.post("/api/pointing/correct", json={"ra_deg": 100, "dec_deg": 35}).json()
    assert r["ok"] is False


def test_router_add_missing_fields():
    client, server = _make_client()
    r = client.post("/api/pointing/add", json={"ra_deg": 100.0}).json()
    assert r["ok"] is False


def test_router_record_solve_delta():
    client, server = _make_client()
    r = client.post("/api/pointing/record-solve", json={
        "ra_hours": 100.0 / 15.0, "dec_deg": 35.0,
        "solved_ra_deg": 100.5, "solved_dec_deg": 35.2,
    }).json()
    assert r["ok"] is True
    # Correction to apply = target - solved (opposite of the overshoot).
    assert r["delta_ra_deg"] == pytest.approx(-0.5)
    assert r["delta_dec_deg"] == pytest.approx(-0.2)
    st = client.get("/api/pointing/status").json()
    assert st["sample_count"] == 1
    assert st["samples"][0]["ra"] == pytest.approx(100.0)
    # Correction back at the commanded position = recorded delta.
    corr = client.post("/api/pointing/correct", json={"ra_deg": 100.0, "dec_deg": 35.0}).json()
    assert corr["delta_ra"] == pytest.approx(-0.5)
    assert corr["delta_dec"] == pytest.approx(-0.2)


def test_router_record_solve_ra_wrap():
    client, server = _make_client()
    r = client.post("/api/pointing/record-solve", json={
        "ra_hours": 358.0 / 15.0, "dec_deg": 0.0,
        "solved_ra_deg": 2.0, "solved_dec_deg": 0.0,
    }).json()
    # Correction = 358 - 2 = 356 deg → wrapped to -4 deg (short way).
    assert r["delta_ra_deg"] == pytest.approx(-4.0)


def test_router_record_solve_bad_fields():
    client, server = _make_client()
    r = client.post("/api/pointing/record-solve", json={"ra_hours": 6.0}).json()
    assert r["ok"] is False


def test_frontend_assets_served():
    client, server = _make_client()
    assert client.get("/flatwizard.js").status_code == 200
    assert client.get("/pointing.js").status_code == 200
    idx = client.get("/").text
    # Flat wizard is now a foldable section of the capture panel (not a separate applet).
    assert 'id="fw-config-toggle"' in idx
    assert 'id="fw-body"' in idx
    assert 'id="applet-flatwizard"' not in idx
    assert 'id="applet-pointing"' in idx
    assert 'id="pt-apply-check"' in idx
    assert 'id="pt-fit"' in idx
    assert 'id="pt-fit-info"' in idx
    assert 'id="flip-margin"' in idx and 'value="0.2"' in idx
    assert 'id="vis-overlay"' in idx and 'id="vis-chart"' in idx
    assert '/visibility.js' in idx
    assert '/flatwizard.js' in idx and '/pointing.js' in idx


# ── Parametric model fit ─────────────────────────────────────────

import math  # noqa: E402
import numpy as np  # noqa: E402

from indigo.devices.pointing import ra_features, dec_features  # noqa: E402

TRUE_RA = np.array([0.5, 0.3, -0.2, 0.1])
TRUE_DEC = np.array([-0.4, 0.25, 0.05, -0.15])


def _synthetic_samples(n=18, seed=0):
    """Generate samples from a known parametric model (with a little noise)."""
    rng = np.random.default_rng(seed)
    r = []
    for _ in range(n):
        ra = float(rng.uniform(0, 360))
        dec = float(rng.uniform(-20, 60))
        dra = float(np.dot(ra_features(ra, dec), TRUE_RA))
        ddec = float(np.dot(dec_features(ra, dec), TRUE_DEC))
        # small measurement noise (arcmin level)
        dra += float(rng.normal(0, 0.005))
        ddec += float(rng.normal(0, 0.005))
        r.append((ra, dec, dra, ddec))
    return r


def test_fit_requires_min_samples():
    m = PointingModel()
    for ra, dec, dra, ddec in _synthetic_samples(5):
        m.add_sample(ra, dec, dra, ddec)
    m.fit()
    assert m.status()["model_fit"]["active"] is False
    assert m.status()["model_fit"]["error"]


def test_fit_reconstructs_known_model():
    m = PointingModel()
    for ra, dec, dra, ddec in _synthetic_samples():
        m.add_sample(ra, dec, dra, ddec)
    m.fit()
    st = m.status()["model_fit"]
    assert st["active"] is True
    assert st["fit_n"] == 18
    # Coefs reconstructed to ~mrad-level (noise kept tiny for the test).
    assert np.allclose(st["coefs_ra"], TRUE_RA, atol=0.02)
    assert np.allclose(st["coefs_dec"], TRUE_DEC, atol=0.02)
    assert st["rms_arcmin"] is not None and st["rms_arcmin"] < 1.0


def test_correct_matches_model_when_no_residual():
    """With (near) noise-free samples the total correction at a point far from
    any sample equals the parametric model (residual-IDW ~0 there)."""
    m = PointingModel()
    samples = _synthetic_samples(seed=1)
    for ra, dec, dra, ddec in samples:
        m.add_sample(ra, dec, dra, ddec)
    m.fit()
    assert m.status()["model_fit"]["active"] is True

    # Probe a position deliberately far from all samples → residual ~0.
    probe_ra, probe_dec = 245.0, -40.0
    expected_ra, expected_dec = m._predict(probe_ra, probe_dec)
    res = m.correct(probe_ra, probe_dec)
    assert res["delta_ra"] == pytest.approx(expected_ra, abs=0.05)
    assert res["delta_dec"] == pytest.approx(expected_dec, abs=0.05)


def test_correct_generalizes_outside_cloud():
    """A model fit on one sky region yields a non-zero correction elsewhere
    (global parametric generalisation), unlike pure local IDW."""
    m = PointingModel()
    rng = np.random.default_rng(7)
    for _ in range(18):
        ra = float(rng.uniform(0, 120))     # only the first ~third of the sky
        dec = float(rng.uniform(0, 60))
        dra = float(np.dot(ra_features(ra, dec), TRUE_RA))
        ddec = float(np.dot(dec_features(ra, dec), TRUE_DEC))
        m.add_sample(ra, dec, dra, ddec)
    m.fit()

    # Probe far outside the sampled region.
    corr = m.correct(280.0, -20.0)
    expected_ra, expected_dec = m._predict(280.0, -20.0)
    # The correction is dominated by the model (generalises), and is non-trivial.
    assert corr["delta_ra"] == pytest.approx(expected_ra, abs=0.05)
    assert abs(corr["delta_ra"]) > 0.05 or abs(corr["delta_dec"]) > 0.05


def test_fit_endpoint_router():
    client, server = _make_client()
    for ra, dec, dra, ddec in _synthetic_samples(seed=2):
        client.post("/api/pointing/add", json={
            "ra_deg": ra, "dec_deg": dec,
            "delta_ra_deg": dra, "delta_dec_deg": ddec})
    r = client.post("/api/pointing/fit").json()
    assert r["ok"] is True
    assert r["model_fit"]["active"] is True
    assert r["rms_arcmin"] is not None

    # Correct once the model is fitted.
    corr = client.post("/api/pointing/correct", json={"ra_deg": 245.0, "dec_deg": -40.0}).json()
    assert corr["model_fit"] is True


def test_fit_endpoint_too_few_samples():
    client, server = _make_client()
    client.post("/api/pointing/add", json={
        "ra_deg": 100, "dec_deg": 35, "delta_ra_deg": 0.1, "delta_dec_deg": 0.1})
    r = client.post("/api/pointing/fit").json()
    assert r["ok"] is False
    assert r["model_fit"]["active"] is False


def test_clear_resets_fit():
    m = PointingModel()
    for ra, dec, dra, ddec in _synthetic_samples(seed=3):
        m.add_sample(ra, dec, dra, ddec)
    m.fit()
    assert m.status()["model_fit"]["active"] is True
    m.clear()
    st = m.status()
    assert st["sample_count"] == 0
    assert st["model_fit"]["active"] is False
    assert m.correct(100, 35) is None

