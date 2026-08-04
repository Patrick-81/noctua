"""
autofocus.py — Autofocus state machine and V-curve fitting.

The frontend orchestrates the autofocus sequence by calling:
  1. start(center, range, points) → generates position list
  2. For each position: move_to() → expose → wait → measure HFR
  3. step_result(position, hfr) → stores result
  4. finish() → fits parabola, returns best position
  5. stop() → aborts the sequence
"""

from __future__ import annotations

import logging
import math
from enum import Enum

log = logging.getLogger("indigo.autofocus")


class AutoFocusState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    STOPPED = "stopped"


class AutoFocus:
    """Autofocus sequence tracker.

    The backend only tracks state and fits the parabola.
    The frontend drives the actual sequence (move, expose, measure).
    """

    def __init__(self):
        self.state = AutoFocusState.IDLE
        self.center: int = 0
        self.search_range: int = 2000
        self.num_points: int = 25
        self.step_size: int = 0
        self.positions: list[int] = []
        self.results: list[dict] = []     # [{position, hfr, fwhm}]
        self.current_step: int = 0
        self.best_position: int | None = None
        self.best_hfr: float | None = None

    def start(self, center: int, search_range: int = 2000, num_points: int = 25) -> dict:
        """Start a new autofocus sequence. Returns status."""
        if self.state == AutoFocusState.RUNNING:
            return {"ok": False, "error": "autofocus already running"}

        self.center = center
        self.search_range = search_range
        self.num_points = max(5, min(100, num_points))
        self.step_size = max(1, (2 * search_range) // (self.num_points - 1)) if self.num_points > 1 else 1
        self.results = []
        self.current_step = 0
        self.best_position = None
        self.best_hfr = None

        # Generate positions: center - range to center + range, evenly spaced
        half = search_range
        self.positions = [
            center - half + int(i * (2 * half) / (self.num_points - 1))
            for i in range(self.num_points)
        ] if self.num_points > 1 else [center]

        self.state = AutoFocusState.RUNNING
        log.info("Autofocus started: center=%d range=%d points=%d step=%d",
                 center, search_range, self.num_points, self.step_size)

        return {
            "ok": True,
            "state": self.state.value,
            "positions": self.positions,
            "num_points": self.num_points,
            "step_size": self.step_size,
        }

    def step_result(self, position: int, hfr: float, fwhm: float = 0.0) -> dict:
        """Record the result of one autofocus step. Returns status."""
        if self.state != AutoFocusState.RUNNING:
            return {"ok": False, "error": f"not running (state={self.state.value})"}

        self.results.append({"position": position, "hfr": hfr, "fwhm": fwhm})
        self.current_step = len(self.results)

        # Track best
        if self.best_hfr is None or hfr < self.best_hfr:
            self.best_hfr = hfr
            self.best_position = position

        log.info("Autofocus step %d/%d: pos=%d hfr=%.2f (best=%d hfr=%.2f)",
                 self.current_step, self.num_points, position, hfr,
                 self.best_position, self.best_hfr)

        return self.status()

    def finish(self) -> dict:
        """Finish the sequence and fit a parabola to find the best position."""
        if self.state != AutoFocusState.RUNNING:
            return {"ok": False, "error": f"not running (state={self.state.value})"}

        if len(self.results) < 3:
            self.state = AutoFocusState.DONE
            return {
                "ok": True,
                "state": self.state.value,
                "best_position": self.best_position,
                "best_hfr": self.best_hfr,
                "parabola": None,
            }

        # Fit parabola: HFR = a*(pos - vertex)^2 + hfr_min
        # Use least squares on HFR = a*x^2 + b*x + c
        positions = [r["position"] for r in self.results]
        hfrs = [r["hfr"] for r in self.results]

        try:
            # Polynomial fit degree 2
            coeffs = _fit_parabola(positions, hfrs)
            if coeffs:
                a, b, c = coeffs
                if a > 0:  # Parabola opens upward (valid minimum)
                    vertex_x = -b / (2 * a)
                    vertex_y = a * vertex_x ** 2 + b * vertex_x + c
                    self.best_position = int(round(vertex_x))
                    self.best_hfr = round(vertex_y, 2)
                    parabola = {"a": round(a, 8), "b": round(b, 6), "c": round(c, 4),
                                "vertex_x": round(vertex_x, 1), "vertex_y": round(vertex_y, 2)}
                else:
                    parabola = None
            else:
                parabola = None
        except Exception as e:
            log.warning("Parabola fit failed: %s", e)
            parabola = None

        self.state = AutoFocusState.DONE
        log.info("Autofocus done: best_pos=%d best_hfr=%.2f",
                 self.best_position, self.best_hfr)

        return {
            "ok": True,
            "state": self.state.value,
            "best_position": self.best_position,
            "best_hfr": self.best_hfr,
            "parabola": parabola,
        }

    def stop(self) -> dict:
        """Stop the autofocus sequence."""
        if self.state == AutoFocusState.RUNNING:
            self.state = AutoFocusState.STOPPED
            log.info("Autofocus stopped at step %d/%d", self.current_step, self.num_points)
        return self.status()

    def reset(self) -> dict:
        """Reset to idle state."""
        self.state = AutoFocusState.IDLE
        self.results = []
        self.current_step = 0
        self.best_position = None
        self.best_hfr = None
        return self.status()

    def status(self) -> dict:
        return {
            "ok": True,
            "state": self.state.value,
            "center": self.center,
            "search_range": self.search_range,
            "num_points": self.num_points,
            "step_size": self.step_size,
            "current_step": self.current_step,
            "best_position": self.best_position,
            "best_hfr": self.best_hfr,
            "results": self.results,
            "positions": self.positions,
        }


def _fit_parabola(x: list[int], y: list[float]) -> tuple[float, float, float] | None:
    """Fit a parabola y = a*x^2 + b*x + c using least squares.

    Returns (a, b, c) or None if the fit fails.
    """
    n = len(x)
    if n < 3:
        return None

    # Normal equations for degree-2 polynomial
    sx = sum(x)
    sx2 = sum(xi ** 2 for xi in x)
    sx3 = sum(xi ** 3 for xi in x)
    sx4 = sum(xi ** 4 for xi in x)
    sy = sum(y)
    sxy = sum(xi * yi for xi, yi in zip(x, y))
    sx2y = sum(xi ** 2 * yi for xi, yi in zip(x, y))

    # Matrix: [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]]
    # Vector: [sy, sxy, sx2y]
    det = (n * (sx2 * sx4 - sx3 ** 2)
           - sx * (sx * sx4 - sx3 * sx2)
           + sx2 * (sx * sx3 - sx2 ** 2))

    if abs(det) < 1e-10:
        return None

    inv_det = 1.0 / det

    # Cramer's rule
    a = inv_det * (n * (sx2 * sx4 - sx3 ** 2) - sx * (sx * sx4 - sx3 * sx2) + sx2 * (sx * sx3 - sx2 ** 2))
    # Simplified: just use numpy if available, else manual
    try:
        import numpy as np
        coeffs = np.polyfit(x, y, 2)
        return float(coeffs[0]), float(coeffs[1]), float(coeffs[2])
    except ImportError:
        # Manual Cramer's rule
        def _det3(m):
            return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))

        M = [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]]
        det_M = _det3(M)
        if abs(det_M) < 1e-10:
            return None

        Ma = [[sy, sx, sx2], [sxy, sx, sx3], [sx2y, sx2, sx4]]
        Mb = [[n, sy, sx2], [sx, sxy, sx3], [sx2, sx2y, sx4]]
        Mc = [[n, sx, sy], [sx, sx2, sxy], [sx2, sx3, sx2y]]

        return _det3(Ma) / det_M, _det3(Mb) / det_M, _det3(Mc) / det_M
