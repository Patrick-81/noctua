"""
flat_wizard.py — Automated flat-field calibration capture.

Guides the user to the shortest exposure that reaches a target median ADU
on a uniform illumination panel (flat panel / twilight sky).

Principle:
  - Take a test flat exposure of ``current_duration``.
  - Measure the median ADU of the frame (panels should fill the FOV, so the
    global median is a good proxy; the ``BZERO`` pedestal is dropped).
  - Exposure time scales linearly with light:  new_t = t * target / measured.
  - Re-iterate until the ADU lands within ``tolerance`` of the target, or a
    max number of steps is reached.

The math is a pure function (``suggest_duration``) so it is unit-testable
without a camera.  The ``FlatWizard`` state machine stores the per-session
settings (target, current duration, bounds, per-filter progress).
"""

from __future__ import annotations

import logging

log = logging.getLogger("indigo.flatwizard")

DEFAULT_TARGET_ADU = 22000.0      # ~1/3 of a 16-bit full well, a common N.I.N.A. default
DEFAULT_TOLERANCE = 0.05          # ±5% around the target is accepted
DEFAULT_MIN_DURATION = 0.0        # seconds
DEFAULT_MAX_DURATION = 30.0       # seconds (flats are short)
MAX_STEPS = 4                     # N.I.N.A. converges in ~2-4 iterations


def suggest_duration(
    measured_adu: float,
    current_duration: float,
    target_adu: float = DEFAULT_TARGET_ADU,
    min_duration: float = DEFAULT_MIN_DURATION,
    max_duration: float = DEFAULT_MAX_DURATION,
) -> dict:
    """Compute the next exposure duration from a measured flat ADU.

    Linear adjustment:  new_t = current_t * target / measured.

    Args:
        measured_adu:  median ADU (above bias) of the test flat frame.
        current_duration:  duration of the test exposure (seconds).
        target_adu, min_duration, max_duration:  tuning parameters.

    Returns:
        dict with ``duration`` (next suggested exposure, clamped),
        ``ok`` (whether the measurement was usable), and ``error`` when the
        measured ADU is not usable (<= 0 or non-finite -> cannot extrapolate).
    """
    if measured_adu is None or measured_adu <= 0 or measured_adu != measured_adu:
        return {"ok": False, "duration": current_duration,
                "error": "ADU measurement not usable for extrapolation"}

    ratio = target_adu / measured_adu
    suggested = current_duration * ratio
    # Never let a single (noisy) far miss send a huge duration blindly — clamp.
    suggested = max(min(suggested, max_duration), min_duration)
    return {"ok": True, "duration": round(float(suggested), 3), "ratio": round(float(ratio), 3)}


def is_converged(measured_adu: float, target_adu: float, tolerance: float) -> bool:
    """True when the measured ADU is within ``tolerance`` of the target."""
    if target_adu <= 0:
        return False
    return abs(measured_adu - target_adu) <= target_adu * tolerance


class FlatWizard:
    """Per-session flat calibration state machine (device-agnostic math)."""

    def __init__(self) -> None:
        self._reset()

    def _reset(self) -> None:
        self.target_adu = DEFAULT_TARGET_ADU
        self.tolerance = DEFAULT_TOLERANCE
        self.min_duration = DEFAULT_MIN_DURATION
        self.max_duration = DEFAULT_MAX_DURATION
        self._step = 0
        self.done = False
        self.last_adu: float | None = None
        self.duration: float = 1.0          # current/starting flat duration (s)
        self.suggestion: dict | None = None
        self.msg: str = ""

    def configure(self, target_adu=None, tolerance=None, start_duration=None,
                  min_duration=None, max_duration=None) -> dict:
        """Set the flat target/bounds. Returns the effective settings."""
        if target_adu is not None and float(target_adu) > 0:
            self.target_adu = float(target_adu)
        if tolerance is not None:
            self.tolerance = float(tolerance)
        if start_duration is not None and float(start_duration) > 0:
            self.duration = float(start_duration)
        if min_duration is not None:
            self.min_duration = float(min_duration)
        if max_duration is not None and float(max_duration) > 0:
            self.max_duration = float(max_duration)
        self.done = False
        return self.status()

    def record_measurement(self, adu: float) -> dict:
        """Feed a measured ADU back and advance the wizard.

        Returns the next suggested duration; marks ``done`` when converged or
        the max number of steps is reached.
        """
        self.last_adu = adu

        if is_converged(adu, self.target_adu, self.tolerance):
            self.done = True
            self.msg = f"Convergé : ADU {adu:.0f} ≈ cible {self.target_adu:.0f}"
            self.suggestion = {"ok": True, "duration": self.duration, "converged": True}
            return self.status()

        res = suggest_duration(
            adu, self.duration, self.target_adu,
            self.min_duration, self.max_duration,
        )
        self.suggestion = res
        if not res["ok"]:
            self.msg = res["error"]
            self._step += 1
        else:
            res["converged"] = False
            self.duration = res["duration"]
            self._step += 1
            self.msg = f"ADU {adu:.0f} → durée {self.duration:.3f}s (pas {self._step}/{MAX_STEPS})"

        if self._step >= MAX_STEPS:
            self.done = True
            self.msg += " — max itérations atteint"
        return self.status()

    def status(self) -> dict:
        return {
            "target_adu": round(self.target_adu, 1),
            "tolerance": self.tolerance,
            "min_duration": self.min_duration,
            "max_duration": self.max_duration,
            "duration": round(self.duration, 3),
            "step": self._step,
            "max_steps": MAX_STEPS,
            "done": self.done,
            "last_adu": round(self.last_adu, 1) if self.last_adu is not None else None,
            "suggestion": self.suggestion,
            "msg": self.msg,
        }

    def reset(self) -> dict:
        self._reset()
        return self.status()
