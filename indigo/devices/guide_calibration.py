"""
guide_calibration.py — Mount calibration for autoguiding.

Measures the mount's response to guide pulses in RA (West/East) and DEC
(North/South) axes. Computes pixel-per-ms conversion rates and camera
sensor angle relative to mount axes.

Protocol (PHD2-inspired):
  WEST  phase: send West pulses until star moves ~25 px total
  EAST  phase: send East pulses to return near starting position
  NORTH phase: send North pulses until star moves ~25 px total
  SOUTH phase: send South pulses to return near starting position
  COMPLETE: fit lines to West and North steps, compute calibration params

Usage:
  cal = GuideCalibration()
  cal.start(step_ms=500, target_px=25)
  cal.record_step('W', x, y, pulse_ms)
  cal.status()
"""

from __future__ import annotations

import logging
import math
from enum import Enum

log = logging.getLogger("indigo.guide_calibration")


class CalState(str, Enum):
    IDLE = "idle"
    WEST = "west"
    EAST = "east"
    NORTH = "north"
    SOUTH = "south"
    COMPLETE = "complete"
    FAILED = "failed"


class GuideCalibration:

    def __init__(self):
        self.state = CalState.IDLE
        self.step_ms: int = 500
        self.target_px: float = 25.0
        self.return_threshold_px: float = 3.0
        self.max_steps_per_phase: int = 40
        self.steps: list[dict] = []

        # Per-phase start position (for cumulative distance tracking)
        self._phase_origin: tuple[float, float] | None = None
        self._phase_count: int = 0
        self._return_last_dist: float | None = None

        # Results (set on complete)
        self.x_rate: float | None = None
        self.y_rate: float | None = None
        self.x_angle: float | None = None
        self.y_angle: float | None = None
        self.orthogonality: float | None = None
        self.quality: str = ""

    def start(self, step_ms: int = 500, target_px: float = 25.0) -> dict:
        if self.state not in (CalState.IDLE, CalState.COMPLETE, CalState.FAILED):
            return {"ok": False, "error": f"calibration déjà en cours ({self.state.value})"}
        self.state = CalState.WEST
        self.step_ms = max(100, min(5000, step_ms))
        self.target_px = max(5.0, min(100.0, target_px))
        self.steps = []
        self._phase_origin = None
        self._phase_count = 0
        self.x_rate = None
        self.y_rate = None
        self.x_angle = None
        self.y_angle = None
        self.orthogonality = None
        self.quality = ""
        log.info("Calibration started: step=%dms target=%.1fpx", self.step_ms, self.target_px)
        return self.status()

    def record_step(self, direction: str, x: float, y: float, pulse_ms: int) -> dict:
        if self.state in (CalState.IDLE, CalState.COMPLETE, CalState.FAILED):
            return {"ok": False, "error": "calibration inactive"}
        if direction not in ("W", "E", "N", "S"):
            return {"ok": False, "error": f"direction invalide: {direction}"}

        if self._phase_origin is None:
            self._phase_origin = (x, y)

        ox, oy = self._phase_origin
        dx = x - ox
        dy = y - oy
        dist = math.sqrt(dx * dx + dy * dy)

        step = {
            "direction": direction,
            "x": round(x, 1),
            "y": round(y, 1),
            "dx": round(dx, 2),
            "dy": round(dy, 2),
            "dist": round(dist, 2),
            "pulse_ms": pulse_ms,
        }
        self.steps.append(step)
        self._phase_count += 1

        # Check phase transition
        next_dir = self._check_transition(direction, dist)
        if next_dir is None:
            return self._finish()
        return self.status(next_direction=next_dir)

    def _check_transition(self, direction: str, dist: float) -> str | None:
        phase = self.state

        if phase == CalState.WEST:
            if dist >= self.target_px or self._phase_count >= self.max_steps_per_phase:
                log.info("WEST done: dist=%.1fpx steps=%d → EAST", dist, self._phase_count)
                self.state = CalState.EAST
                self._phase_origin = None
                self._phase_count = 0
                self._return_last_dist = None
                return "E"

        elif phase == CalState.EAST:
            min_steps = 3
            at_origin = dist < self.return_threshold_px
            went_past = (self._return_last_dist is not None and
                         self._phase_count >= min_steps and
                         dist > self._return_last_dist)
            timed_out = self._phase_count >= self.max_steps_per_phase
            if at_origin or went_past or timed_out:
                log.info("EAST done: dist=%.1fpx steps=%d → NORTH", dist, self._phase_count)
                self.state = CalState.NORTH
                self._phase_origin = None
                self._phase_count = 0
                self._return_last_dist = None
                return "N"
            self._return_last_dist = dist

        elif phase == CalState.NORTH:
            if dist >= self.target_px or self._phase_count >= self.max_steps_per_phase:
                log.info("NORTH done: dist=%.1fpx steps=%d → SOUTH", dist, self._phase_count)
                self.state = CalState.SOUTH
                self._phase_origin = None
                self._phase_count = 0
                self._return_last_dist = None
                return "S"

        elif phase == CalState.SOUTH:
            min_steps = 3
            at_origin = dist < self.return_threshold_px
            went_past = (self._return_last_dist is not None and
                         self._phase_count >= min_steps and
                         dist > self._return_last_dist)
            timed_out = self._phase_count >= self.max_steps_per_phase
            if at_origin or went_past or timed_out:
                log.info("SOUTH done: dist=%.1fpx steps=%d → COMPLETE", dist, self._phase_count)
                return None  # signal done
            self._return_last_dist = dist

        return direction

    def _finish(self) -> dict:
        self.state = CalState.COMPLETE
        self._compute_results()
        log.info("Calibration complete: rate=(%.4f, %.4f) angle=(%.1f, %.1f) quality=%s",
                 self.x_rate or 0, self.y_rate or 0,
                 self.x_angle or 0, self.y_angle or 0, self.quality)
        return self.status()

    def _compute_results(self) -> None:
        west = [s for s in self.steps if s["direction"] == "W"]
        north = [s for s in self.steps if s["direction"] == "N"]

        if len(west) < 3 or len(north) < 3:
            self.state = CalState.FAILED
            self.quality = "insufficient_data"
            return

        # Fit line: cumulative pulse_ms vs dx for West, dy for North
        def fit_rate(steps, axis):
            xs, ys = [], []
            cum_ms = 0
            for s in steps:
                cum_ms += s["pulse_ms"]
                xs.append(cum_ms)
                ys.append(s[axis])
            n = len(xs)
            sx = sum(xs)
            sy = sum(ys)
            sxx = sum(x * x for x in xs)
            sxy = sum(x * y for x, y in zip(xs, ys))
            denom = n * sxx - sx * sx
            if abs(denom) < 1e-12:
                return 0.0, 0.0, 0.0
            slope = (n * sxy - sx * sy) / denom
            intercept = (sy - slope * sx) / n
            # R-squared
            ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
            ss_tot = sum((y - sy / n) ** 2 for y in ys)
            r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
            return slope, intercept, r2

        # x_rate = how many pixels East per ms of West pulse (dx / cum_ms)
        x_rate_raw, x_intercept, x_r2 = fit_rate(west, "dx")
        # y_rate = how many pixels North per ms of North pulse (dy / cum_ms)
        y_rate_raw, y_intercept, y_r2 = fit_rate(north, "dy")

        self.x_rate = abs(x_rate_raw) if x_rate_raw != 0 else 0
        self.y_rate = abs(y_rate_raw) if y_rate_raw != 0 else 0

        # Camera angle: atan2(dy, dx) for the west steps gives the sensor rotation
        if x_rate_raw != 0:
            self.x_angle = math.degrees(math.atan2(
                sum(s["dy"] for s in west) / len(west),
                sum(s["dx"] for s in west) / len(west)
            ))
        if y_rate_raw != 0:
            self.y_angle = math.degrees(math.atan2(
                sum(s["dy"] for s in north) / len(north),
                sum(s["dx"] for s in north) / len(north)
            ))

        # Orthogonality: angle between the two fitted direction vectors
        if self.x_angle is not None and self.y_angle is not None:
            self.orthogonality = abs(abs(self.x_angle - self.y_angle) - 90)

        # Quality assessment
        flaws = []
        if len(west) < 8:
            flaws.append(f"west_steps={len(west)}<8")
        if len(north) < 8:
            flaws.append(f"north_steps={len(north)}<8")
        if self.orthogonality is not None and self.orthogonality > 15:
            flaws.append(f"orthogonality={self.orthogonality:.1f}°>15°")
        if x_r2 < 0.8:
            flaws.append(f"west_linearity={x_r2:.2f}")
        if y_r2 < 0.8:
            flaws.append(f"north_linearity={y_r2:.2f}")

        if not flaws:
            self.quality = "good"
        elif len(flaws) <= 2:
            self.quality = "acceptable"
        else:
            self.quality = "poor"

        self._quality_flaws = flaws

    def stop(self) -> dict:
        prev = self.state
        self.state = CalState.FAILED
        if prev not in (CalState.IDLE, CalState.COMPLETE):
            log.info("Calibration stopped by user")
        return self.status()

    def finish(self) -> dict:
        """Force-complete calibration with current data, computing whatever results are available."""
        if self.state in (CalState.IDLE, CalState.COMPLETE, CalState.FAILED):
            return self.status()
        log.info("Calibration finished early at state=%s with %d steps", self.state.value, len(self.steps))
        self.state = CalState.COMPLETE
        self._compute_results()
        return self.status()

    def reset(self) -> dict:
        self.state = CalState.IDLE
        self.steps = []
        self._phase_origin = None
        self._phase_count = 0
        self.x_rate = None
        self.y_rate = None
        self.x_angle = None
        self.y_angle = None
        self.orthogonality = None
        self.quality = ""
        self._quality_flaws = []
        return self.status()

    def status(self, next_direction: str | None = None) -> dict:
        phase_map = {
            CalState.WEST: "W", CalState.EAST: "E",
            CalState.NORTH: "N", CalState.SOUTH: "S",
        }
        return {
            "ok": True,
            "state": self.state.value,
            "next_direction": next_direction or phase_map.get(self.state, ""),
            "step_ms": self.step_ms,
            "target_px": self.target_px,
            "step_count": len(self.steps),
            "phase_count": self._phase_count,
            "steps": self.steps,
            "x_rate": round(self.x_rate, 6) if self.x_rate is not None else None,
            "y_rate": round(self.y_rate, 6) if self.y_rate is not None else None,
            "x_angle": round(self.x_angle, 1) if self.x_angle is not None else None,
            "y_angle": round(self.y_angle, 1) if self.y_angle is not None else None,
            "orthogonality": round(self.orthogonality, 1) if self.orthogonality is not None else None,
            "quality": self.quality,
            "quality_flaws": getattr(self, "_quality_flaws", []),
        }
