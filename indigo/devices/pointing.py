"""
pointing.py — Pointing-error model (parametric + local interpolation).

Collects measured pointing errors across the sky, fits a *global parametric*
model of the systematic errors (cone, index, orthogonality/flexure) by
least-squares, and combines it with a local inverse-distance-weighting
interpolation of the *residuals* so the correction is accurate both inside and
outside the sampled region.

Samples are ``(ra_deg, dec_deg, delta_ra_deg, delta_dec_deg)`` in equatorial
space (the most stable frame for mechanical deviations and directly measurable
from a plate solve comparing a commanded position against the solved center).
``delta_*`` is the correction to apply: target = commanded + delta.

The RA axis (0-360°) is wrapped so the "short way around" is used; DEC is
clamped to [-90, 90].

The model is explicit (coordinate-dependent) rather than a full N.I.N.A.-style
multi-star fit, but captures the same first-order systematic terms:

    delta_ra  = a0 + a1·sin(dec) + a2·sin(ra)·cos(dec) + a3·cos(ra)·cos(dec)
    delta_dec = b0 + b1·cos(dec) + b2·sin(dec)         + b3·sin(ra)·cos(dec)

Only the numpy dependency is used for the least-squares fit, so the math stays
unit-testable without connected hardware.
"""

from __future__ import annotations

import math
import logging

import numpy as np

log = logging.getLogger("indigo.pointing")

MIN_FIT_SAMPLES = 6


def _wrapped_distance(a: float, b: float, full: float = 360.0) -> float:
    """Distance between two circular coordinates (shortest path), 0..full/2."""
    d = abs((b - a) % full)
    if d > full / 2.0:
        d = full - d
    return d


def ra_features(ra_deg: float, dec_deg: float) -> list[float]:
    """Design-matrix row for the RA correction model."""
    d = math.radians(dec_deg)
    r = math.radians(ra_deg % 360.0)
    return [1.0, math.sin(d), math.sin(r) * math.cos(d), math.cos(r) * math.cos(d)]


def dec_features(ra_deg: float, dec_deg: float) -> list[float]:
    """Design-matrix row for the DEC correction model."""
    d = math.radians(dec_deg)
    r = math.radians(ra_deg % 360.0)
    return [1.0, math.cos(d), math.sin(d), math.sin(r) * math.cos(d)]


class PointingModel:
    """Parametric + residual-IDW pointing-error model."""

    def __init__(self, max_samples: int = 200, min_fit_samples: int = MIN_FIT_SAMPLES) -> None:
        self.samples: list[dict] = []
        self._max_samples = int(max_samples)
        self.min_fit_samples = int(min_fit_samples)
        self._coefs_ra: np.ndarray | None = None
        self._coefs_dec: np.ndarray | None = None
        self._rms_arcmin: float | None = None
        self._fit_n: int = 0
        self._fit_error: str | None = None

    # ── Sample management ────────────────────────────────────────

    def add_sample(self, ra_deg: float, dec_deg: float,
                   delta_ra_deg: float, delta_dec_deg: float) -> dict:
        """Record one measured pointing error.

        ``delta_*`` is the correction needed to reach the target:
        target = commanded + delta.
        """
        sample = {
            "ra": float(ra_deg) % 360.0,
            "dec": max(-90.0, min(90.0, float(dec_deg))),
            "dra": float(delta_ra_deg),
            "ddec": float(delta_dec_deg),
        }
        self.samples.append(sample)
        if len(self.samples) > self._max_samples:
            self.samples = self.samples[-self._max_samples:]
        return self.status()

    def clear(self) -> dict:
        self.samples.clear()
        self._coefs_ra = None
        self._coefs_dec = None
        self._rms_arcmin = None
        self._fit_n = 0
        self._fit_error = None
        return self.status()

    def pop_sample(self, index: int | None = None) -> dict:
        """Remove one sample (default the last) and return status."""
        if self.samples:
            if index is None:
                self.samples.pop()
            else:
                idx = int(index)
                if 0 <= idx < len(self.samples):
                    self.samples.pop(idx)
        return self.status()

    # ── Parametric fit ───────────────────────────────────────────

    def fit(self) -> dict:
        """Least-squares fit of the global parametric model on the samples.

        Fits RA and DEC corrections independently against their design
        matrices.  The model is kept (coefs) even if the fit is ill-conditioned,
        but ``model_fit`` reflects how confident the result is.
        """
        n = len(self.samples)
        self._fit_n = n
        if n < self.min_fit_samples:
            self._fit_error = f"need >= {self.min_fit_samples} samples (have {n})"
            self._coefs_ra = None
            self._coefs_dec = None
            self._rms_arcmin = None
            return self.status()

        Y_ra = np.array([s["dra"] for s in self.samples], dtype=float)
        Y_dec = np.array([s["ddec"] for s in self.samples], dtype=float)
        X_ra = np.array([ra_features(s["ra"], s["dec"]) for s in self.samples], dtype=float)
        X_dec = np.array([dec_features(s["ra"], s["dec"]) for s in self.samples], dtype=float)

        try:
            self._coefs_ra, *_ = np.linalg.lstsq(X_ra, Y_ra, rcond=None)
            self._coefs_dec, *_ = np.linalg.lstsq(X_dec, Y_dec, rcond=None)
        except Exception as e:  # noqa: BLE001
            self._fit_error = f"fit failed: {e}"
            self._coefs_ra = None
            self._coefs_dec = None
            self._rms_arcmin = None
            return self.status()

        # Residual RMS (arcmin) of the parametric model alone.
        pred_ra = X_ra @ self._coefs_ra
        pred_dec = X_dec @ self._coefs_dec
        res_deg = np.sqrt((Y_ra - pred_ra) ** 2 + (Y_dec - pred_dec) ** 2)
        self._rms_arcmin = float(np.mean(res_deg) * 60.0)
        self._fit_error = None
        return self.status()

    def _predict(self, ra_deg: float, dec_deg: float) -> tuple[float, float]:
        """Parametric correction (delta_ra, delta_dec) at a sky position."""
        if self._coefs_ra is None or self._coefs_dec is None:
            return 0.0, 0.0
        ra = float(ra_deg) % 360.0
        dec = max(-90.0, min(90.0, float(dec_deg)))
        dra = float(np.dot(ra_features(ra, dec), self._coefs_ra))
        ddec = float(np.dot(dec_features(ra, dec), self._coefs_dec))
        return dra, ddec

    def _interpolate(self, ra_deg: float, dec_deg: float, value_fn,
                     power: float = 2.0, min_weight: float = 1e-9) -> tuple[float, float]:
        """IDW over ``value_fn(sample)``, weighted by proximity in the cloud."""
        ra = float(ra_deg) % 360.0
        dec = max(-90.0, min(90.0, float(dec_deg)))
        total_w = 0.0
        acc = 0.0
        for s in self.samples:
            d_ra = _wrapped_distance(ra, s["ra"])
            d_dec = abs(dec - s["dec"])
            dist = math.hypot(d_ra, d_dec)
            if dist < 1e-6:
                return value_fn(s), 1.0
            w = 1.0 / (dist ** power)
            if w < min_weight:
                continue
            total_w += w
            acc += w * value_fn(s)
        if total_w <= min_weight:
            return 0.0, 0.0
        return acc / total_w, total_w

    # ── Correct ──────────────────────────────────────────────────

    def correct(self, ra_deg: float, dec_deg: float,
                power: float = 2.0, min_weight: float = 1e-9) -> dict | None:
        """Total corrective (delta_ra, delta_dec) at a sky position.

        Returns ``None`` when there are no samples.  When a parametric model has
        been fit, the correction is ``model + IDW(residuals)`` so it generalises
        across the sky while staying accurate near the sampled points.
        """
        if not self.samples:
            return None

        ra = float(ra_deg) % 360.0
        dec = max(-90.0, min(90.0, float(dec_deg)))

        if self._coefs_ra is not None and self._coefs_dec is not None:
            m_ra, m_dec = self._predict(ra, dec)
            # Residual IDW: interpolate (delta - model), not raw deltas.
            r_ra, w_ra = self._interpolate(
                ra, dec,
                lambda s: s["dra"] - float(np.dot(ra_features(s["ra"], s["dec"]), self._coefs_ra)),
                power, min_weight)
            r_dec, w_dec = self._interpolate(
                ra, dec,
                lambda s: s["ddec"] - float(np.dot(dec_features(s["ra"], s["dec"]), self._coefs_dec)),
                power, min_weight)
            delta_ra = m_ra + r_ra
            delta_dec = m_dec + r_dec
            weight = (w_ra + w_dec) / 2.0
        else:
            dra_raw, w = self._interpolate(ra, dec, lambda s: s["dra"], power, min_weight)
            ddec_raw, _ = self._interpolate(ra, dec, lambda s: s["ddec"], power, min_weight)
            delta_ra = dra_raw
            delta_dec = ddec_raw
            weight = w

        return {
            "delta_ra": float(delta_ra),
            "delta_dec": float(delta_dec),
            "samples": len(self.samples),
            "weight": float(weight),
            "model_fit": self._coefs_ra is not None,
        }

    # ── Status ───────────────────────────────────────────────────

    def status(self) -> dict:
        coefs_ra = None if self._coefs_ra is None else [float(c) for c in self._coefs_ra]
        coefs_dec = None if self._coefs_dec is None else [float(c) for c in self._coefs_dec]
        return {
            "sample_count": len(self.samples),
            "max_samples": self._max_samples,
            "min_fit_samples": self.min_fit_samples,
            "samples": [dict(s) for s in self.samples],
            "model_fit": {
                "active": self._coefs_ra is not None,
                "fit_n": self._fit_n,
                "rms_arcmin": self._rms_arcmin,
                "error": self._fit_error,
                "coefs_ra": coefs_ra,
                "coefs_dec": coefs_dec,
                "ra_labels": ["index", "sin(dec)", "sin(ra)cos(dec)", "cos(ra)cos(dec)"],
                "dec_labels": ["index", "cos(dec)", "sin(dec)", "sin(ra)cos(dec)"],
            },
        }
