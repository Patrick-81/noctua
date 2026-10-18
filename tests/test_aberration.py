"""
test_aberration.py — Atelier « Distortion & Tilt » (Lot 2).

Tests de logique pure (fit plan de tilt + résidus, courbure de champ, grille
HFR, fit radial de distorsion) + un test d'intégration seiza (résolution
astrométrique réelle sur un champ de test, skippé sans catalogue).

Lancé par pytest : `.venv/bin/python -m pytest tests/test_aberration.py -q`
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.aberration import (  # noqa: E402
    tilt_plane_fit,
    field_curvature_fit,
    grid_hfr,
    fit_radial_distortion,
    analyze_image,
)


# ── Helpers ─────────────────────────────────────────────────────

def make_stars(coords, hfrs):
    return [
        {"x": int(x), "y": int(y), "hfr": float(h), "flux": 1000.0, "peak": 900.0}
        for (x, y), h in zip(coords, hfrs)
    ]


def make_fits(w, h, img, bzero=0.0):
    """FITS 16 bits minimal (avec BZERO optionnel)."""
    cards = [
        "SIMPLE  =                    T",
        "NAXIS   =                    2",
        f"NAXIS1  =               {w:>5d}",
        f"NAXIS2  =               {h:>5d}",
        "BITPIX  =                    16",
    ]
    if bzero:
        cards.append(f"BZERO   =              {bzero:.4f}")
    cards.append("END")
    header = "".join(c.ljust(80) for c in cards).ljust(2880)
    stored = (np.asarray(img, dtype=np.float64) - bzero).clip(-32768, 32767)
    return header.encode("ascii") + np.array(stored, dtype=">i2").tobytes()


# ── tilt_plane_fit ──────────────────────────────────────────────

def test_tilt_plane_recovers_gradient():
    W, H = 1000, 800
    rng = np.random.default_rng(0)
    coords = [(rng.uniform(20, W - 20), rng.uniform(20, H - 20)) for _ in range(40)]
    a_true, b_true, c_true = 4.0, -1.0, 2.0
    hfrs = [c_true + a_true * (x / W) + b_true * (y / H) for x, y in coords]
    fit = tilt_plane_fit(make_stars([(int(x), int(y)) for x, y in coords], hfrs), W, H)
    assert fit["n"] == 40
    assert abs(fit["a"] - a_true) < 1e-2
    assert abs(fit["b"] - b_true) < 1e-2
    assert abs(fit["c"] - c_true) < 1e-2
    assert fit["r2"] > 0.99
    assert fit["rms"] < 1e-2
    assert len(fit["residuals"]) == 40


def test_tilt_plane_residuals_isolate_noise():
    W, H = 600, 600
    rng = np.random.default_rng(1)
    coords = [(rng.uniform(10, 590), rng.uniform(10, 590)) for _ in range(50)]
    base = [2.5 + 0.5 * (x / W) for x, y in coords]
    noisy = [v + rng.normal(0, 0.3) for v in base]
    fit = tilt_plane_fit(make_stars([(int(x), int(y)) for x, y in coords], noisy), W, H)
    assert abs(fit["a"] - 0.5) < 0.1
    # résidu rms proche de la vraie dispersion injectée (~0.3)
    assert 0.15 < fit["rms"] < 0.6


def test_tilt_plane_too_few_stars():
    fit = tilt_plane_fit(make_stars([(1, 1)], [2.0]), 100, 100)
    assert fit["n"] == 0 and fit["mag"] == 0.0


# ── field_curvature_fit ─────────────────────────────────────────

def test_field_curvature_recovers_parabola():
    W, H = 1000, 800
    cx, cy = W / 2, H / 2
    r_max = float(np.hypot(cx, cy))
    rng = np.random.default_rng(2)
    h0, k_true = 2.0, 1.5
    coords, hfrs = [], []
    for _ in range(60):
        x, y = rng.uniform(20, W - 20), rng.uniform(20, H - 20)
        u = float(np.hypot(x - cx, y - cy)) / r_max
        coords.append((int(x), int(y)))
        hfrs.append(h0 + k_true * u ** 2)
    fit = field_curvature_fit(make_stars(coords, hfrs), W, H)
    assert fit["n"] == 60
    assert abs(fit["center_hfr"] - h0) < 1e-2
    assert abs(fit["k"] - k_true) < 1e-2
    assert fit["r2"] > 0.99
    assert fit["edge_ratio"] > 1.0


def test_field_curvature_flat_field():
    W, H = 400, 400
    coords = [(100, 100), (300, 100), (100, 300), (300, 300), (200, 200)]
    hfrs = [3.0] * 5
    fit = field_curvature_fit(make_stars(coords, hfrs), W, H)
    assert abs(fit["k"]) < 1e-6
    assert abs(fit["edge_ratio"] - 1.0) < 1e-3


# ── grid_hfr ────────────────────────────────────────────────────

def test_grid_hfr_buckets():
    W, H = 300, 300
    coords = [(50, 50), (60, 55), (250, 250), (150, 150)]
    hfrs = [2.0, 4.0, 6.0, 3.0]
    cells = grid_hfr(make_stars(coords, hfrs), W, H, n=3)
    assert len(cells) == 9
    top_left = next(c for c in cells if c["row"] == 0 and c["col"] == 0)
    assert top_left["count"] == 2
    assert abs(top_left["median_hfr"] - 3.0) < 1e-6
    bot_right = next(c for c in cells if c["row"] == 2 and c["col"] == 2)
    assert bot_right["count"] == 1 and abs(bot_right["median_hfr"] - 6.0) < 1e-6


# ── fit_radial_distortion ───────────────────────────────────────

def test_fit_radial_distortion_recovers_k1():
    W, H = 1000, 800
    cx, cy = W / 2, H / 2
    r_max = float(np.hypot(cx, cy))
    k1_true = 0.02
    xr, yr, xm, ym = [], [], [], []
    for x in np.linspace(50, W - 50, 9):
        for y in np.linspace(50, H - 50, 7):
            r = float(np.hypot(x - cx, y - cy))
            if r < 1e-6:
                continue
            u = r / r_max
            r_meas = r * (1.0 + k1_true * u ** 2)
            xr.append(x); yr.append(y)
            xm.append(cx + (x - cx) / r * r_meas)
            ym.append(cy + (y - cy) / r * r_meas)
    fit = fit_radial_distortion(xm, ym, xr, yr, W, H, order=3)
    assert fit["ok"]
    assert fit["n"] >= 40
    assert abs(fit["coefficients"][0] - k1_true) < 1e-3
    assert fit["rms_relative"] < 1e-3
    assert abs(fit["max_distortion_percent"] - k1_true * 100) < 0.1


def test_fit_radial_distortion_no_distortion():
    W, H = 600, 600
    xr = [100, 300, 500, 200, 400, 300]
    yr = [100, 300, 500, 400, 200, 300]
    fit = fit_radial_distortion(xr, yr, xr, yr, W, H, order=3)
    assert fit["ok"]
    assert max(abs(c) for c in fit["coefficients"]) < 1e-6
    assert fit["max_distortion_percent"] < 1e-3


def test_fit_radial_distortion_too_few_pairs():
    fit = fit_radial_distortion([100], [100], [100], [100], 200, 200)
    assert fit["ok"] is False


# ── analyze_image (intégration boîte blanche) ───────────────────

def _star_image(W=512, H=512, n=60, seed=7, sigma_fn=None, amp_step=8.0):
    rng = np.random.default_rng(seed)
    img = np.full((H, W), 500.0, dtype=np.float64)
    yy, xx = np.mgrid[0:H, 0:W]
    for i in range(n):
        x = rng.uniform(20, W - 20)
        y = rng.uniform(20, H - 20)
        sigma = sigma_fn(x, y) if sigma_fn else 2.0
        amp = 1500.0 + i * amp_step
        img += amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
    return np.clip(img, 0, 32767)


def test_analyze_image_adds_tilt_and_curvature():
    # Tilt en x : sigma (donc HFR) croît vers la droite
    img = _star_image(sigma_fn=lambda x, y: 0.8 + 1.6 * (x / 512))
    res = analyze_image(make_fits(img.shape[1], img.shape[0], img))
    assert res["ok"]
    g = res["global"]
    assert "tilt" in g and "curvature" in g and "grid" in g
    assert g["tilt"]["n"] >= 6
    assert g["tilt"]["a"] > 0
    # grille : colonne gauche (HFR faible) < colonne droite (HFR élevé)
    cells = g["grid"]
    col0 = [c["median_hfr"] for c in cells if c["col"] == 0]
    col2 = [c["median_hfr"] for c in cells if c["col"] == 2]
    assert np.mean(col0) < np.mean(col2)
    assert len(cells) == 9
    assert res["stars"] and "tilt_resid" in res["stars"][0]


def test_analyze_image_field_curvature_radial():
    # Courbure de champ : sigma croît avec le rayon au centre
    def sig(x, y):
        r = np.hypot(x - 256, y - 256) / np.hypot(256, 256)
        return 1.2 + 2.0 * r
    img = _star_image(sigma_fn=sig)
    res = analyze_image(make_fits(img.shape[1], img.shape[0], img))
    assert res["ok"]
    curv = res["global"]["curvature"]
    assert curv["n"] >= 6
    assert curv["k"] > 0
    assert curv["edge_ratio"] > 1.0



# ── Intégration seiza (distorsion) ──────────────────────────────

def test_distortion_integration_orion():
    pytest.importorskip("seiza")
    fake = Path(__file__).resolve().parent / "fake_sky" / "test_orion.fits"
    if not fake.exists():
        pytest.skip("champ de test absent")

    from indigo.devices.solver import Solver
    from indigo.devices.distortion import analyze_distortion

    s = Solver()
    if not s.load_catalogs().get("ok"):
        pytest.skip("catalogue seiza indisponible (hors-ligne)")

    res = analyze_distortion(fake.read_bytes(), s)
    assert res["ok"], res.get("error")
    assert res["pairs"] >= 4
    # champ synthétique non distordu → distorsion radiale faible
    assert res["distortion"]["max_distortion_percent"] < 5.0
    assert res["distortion"]["n"] == res["pairs"]


def test_distortion_without_catalog_errors():
    from indigo.devices.solver import Solver
    from indigo.devices.distortion import analyze_distortion

    s = Solver()  # catalogue non chargé
    res = analyze_distortion(b"", s)
    assert res["ok"] is False
    assert "catalogue" in res["error"].lower()
