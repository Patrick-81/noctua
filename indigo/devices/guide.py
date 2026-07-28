"""
guide.py — Autoguide state machine and drift correction.

The frontend orchestrates the guide loop:
  1. start(exposure, aggressiveness, ...) → sets reference star position
  2. For each frame: expose guide camera → wait for image → measure centroid
  3. step_result(x, y) → computes drift from reference, returns correction pulses
  4. stop() → halts guiding

Correction pulses are returned as (direction_ms, ra_ms, dec_ms) for the frontend
to send to the mount via timed MOUNT_MOTION commands.
"""

from __future__ import annotations

import logging
import math
from enum import Enum

log = logging.getLogger("indigo.guide")


class GuideState(str, Enum):
    IDLE = "idle"
    GUIDING = "guiding"
    PAUSED = "paused"
    STOPPED = "stopped"
    ERROR = "error"


class Guide:
    """Autoguide tracker.

    The backend stores reference position, computes drift and correction pulses.
    The frontend drives the actual loop (expose, centroid, send correction to mount).
    """

    def __init__(self):
        self.state = GuideState.IDLE
        # Settings
        self.exposure_sec: float = 1.0
        self.aggressiveness: float = 0.8     # 0.0 – 1.0
        self.ra_gain: float = 1.0            # pixels → ms conversion factor (RA)
        self.dec_gain: float = 1.0           # pixels → ms conversion factor (DEC)
        self.max_pulse_ms: int = 2000        # max correction per axis
        self.min_pulse_ms: int = 50          # ignore drift below this
        # Reference (set on start)
        self.ref_x: float = 0.0
        self.ref_y: float = 0.0
        self.ref_set: bool = False
        # Current frame
        self.current_x: float = 0.0
        self.current_y: float = 0.0
        self.drift_x: float = 0.0
        self.drift_y: float = 0.0
        self.drift_arcsec_x: float = 0.0
        self.drift_arcsec_y: float = 0.0
        # Correction
        self.ra_pulse_ms: int = 0
        self.dec_pulse_ms: int = 0
        self.ra_direction: str = ""   # "E" or "W"
        self.dec_direction: str = ""  # "N" or "S"
        # History (last N frames)
        self.history: list[dict] = []
        self.max_history: int = 300
        # Frame counter
        self.frame_count: int = 0
        # Plate scale: arcsec per pixel (for display only)
        self.plate_scale: float = 1.0

    def start(
        self,
        exposure_sec: float = 1.0,
        aggressiveness: float = 0.8,
        ra_gain: float = 1.0,
        dec_gain: float = 1.0,
        max_pulse_ms: int = 2000,
        min_pulse_ms: int = 50,
        plate_scale: float = 1.0,
    ) -> dict:
        """Start a new guide session."""
        if self.state == GuideState.GUIDING:
            return {"ok": False, "error": "guidage déjà en cours"}

        self.exposure_sec = max(0.1, min(30.0, exposure_sec))
        self.aggressiveness = max(0.0, min(1.0, aggressiveness))
        self.ra_gain = max(0.1, ra_gain)
        self.dec_gain = max(0.1, dec_gain)
        self.max_pulse_ms = max(100, min(5000, max_pulse_ms))
        self.min_pulse_ms = max(10, min(500, min_pulse_ms))
        self.plate_scale = max(0.01, plate_scale)

        self.ref_x = 0.0
        self.ref_y = 0.0
        self.ref_set = False
        self.drift_x = 0.0
        self.drift_y = 0.0
        self.drift_arcsec_x = 0.0
        self.drift_arcsec_y = 0.0
        self.ra_pulse_ms = 0
        self.dec_pulse_ms = 0
        self.ra_direction = ""
        self.dec_direction = ""
        self.history = []
        self.frame_count = 0

        self.state = GuideState.GUIDING
        log.info("Guide started: exposure=%.1fs aggr=%.2f ra_gain=%.2f dec_gain=%.2f",
                 self.exposure_sec, self.aggressiveness, self.ra_gain, self.dec_gain)

        return self.status()

    def step_result(self, x: float, y: float) -> dict:
        """Record measured star centroid and compute correction.

        On the first frame with ref_set=False, this sets the reference.
        Returns status with correction pulses.
        """
        if self.state != GuideState.GUIDING:
            return {"ok": False, "error": f"pas en train de guider (état={self.state.value})"}

        self.current_x = x
        self.current_y = y
        self.frame_count += 1

        # Set reference on first measurement
        if not self.ref_set:
            self.ref_x = x
            self.ref_y = y
            self.ref_set = True
            self.drift_x = 0.0
            self.drift_y = 0.0
            self.ra_pulse_ms = 0
            self.dec_pulse_ms = 0
            self.ra_direction = ""
            self.dec_direction = ""
            log.info("Guide reference set: (%.1f, %.1f)", x, y)
        else:
            # Drift in pixels (positive = star moved East / North)
            self.drift_x = x - self.ref_x
            self.drift_y = y - self.ref_y

            # Convert to arcsec for display
            self.drift_arcsec_x = self.drift_x * self.plate_scale
            self.drift_arcsec_y = self.drift_y * self.plate_scale

            # Compute correction pulses
            self._compute_correction()

        # Record history
        entry = {
            "frame": self.frame_count,
            "x": round(x, 1),
            "y": round(y, 1),
            "drift_x": round(self.drift_x, 2),
            "drift_y": round(self.drift_y, 2),
            "drift_arcsec_x": round(self.drift_arcsec_x, 2),
            "drift_arcsec_y": round(self.drift_arcsec_y, 2),
            "ra_pulse_ms": self.ra_pulse_ms,
            "dec_pulse_ms": self.dec_pulse_ms,
            "ra_direction": self.ra_direction,
            "dec_direction": self.dec_direction,
        }
        self.history.append(entry)
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]

        log.debug("Guide frame %d: drift=(%.1f, %.1f) corr=(%d%s, %d%s)",
                  self.frame_count, self.drift_x, self.drift_y,
                  self.ra_pulse_ms, self.ra_direction,
                  self.dec_pulse_ms, self.dec_direction)

        return self.status()

    def _compute_correction(self) -> None:
        """Compute RA/DEC correction pulses from drift."""
        # RA axis (East-West): drift_x positive → star moved East → need to correct West
        ra_pixels = self.drift_x * self.aggressiveness
        ra_ms = int(abs(ra_pixels) * self.ra_gain)
        ra_ms = min(ra_ms, self.max_pulse_ms)
        if ra_ms < self.min_pulse_ms:
            self.ra_pulse_ms = 0
            self.ra_direction = ""
        else:
            self.ra_pulse_ms = ra_ms
            self.ra_direction = "W" if ra_pixels > 0 else "E"

        # DEC axis (North-South): drift_y positive → star moved North → need to correct South
        dec_pixels = self.drift_y * self.aggressiveness
        dec_ms = int(abs(dec_pixels) * self.dec_gain)
        dec_ms = min(dec_ms, self.max_pulse_ms)
        if dec_ms < self.min_pulse_ms:
            self.dec_pulse_ms = 0
            self.dec_direction = ""
        else:
            self.dec_pulse_ms = dec_ms
            self.dec_direction = "S" if dec_pixels > 0 else "N"

    def pause(self) -> dict:
        """Pause guiding (stop corrections, keep reference)."""
        if self.state == GuideState.GUIDING:
            self.state = GuideState.PAUSED
            log.info("Guide paused at frame %d", self.frame_count)
        return self.status()

    def resume(self) -> dict:
        """Resume guiding from paused state."""
        if self.state == GuideState.PAUSED:
            self.state = GuideState.GUIDING
            log.info("Guide resumed at frame %d", self.frame_count)
        return self.status()

    def stop(self) -> dict:
        """Stop guiding."""
        prev = self.state
        self.state = GuideState.STOPPED
        self.ra_pulse_ms = 0
        self.dec_pulse_ms = 0
        self.ra_direction = ""
        self.dec_direction = ""
        if prev != GuideState.IDLE:
            log.info("Guide stopped at frame %d", self.frame_count)
        return self.status()

    def reset(self) -> dict:
        """Reset to idle state."""
        self.state = GuideState.IDLE
        self.ref_set = False
        self.history = []
        self.frame_count = 0
        self.drift_x = 0.0
        self.drift_y = 0.0
        self.ra_pulse_ms = 0
        self.dec_pulse_ms = 0
        return self.status()

    def set_reference(self, x: float, y: float) -> dict:
        """Manually set the guide reference star position."""
        self.ref_x = x
        self.ref_y = y
        self.ref_set = True
        log.info("Guide reference manually set: (%.1f, %.1f)", x, y)
        return self.status()

    def status(self) -> dict:
        return {
            "ok": True,
            "state": self.state.value,
            "exposure_sec": self.exposure_sec,
            "aggressiveness": self.aggressiveness,
            "ra_gain": self.ra_gain,
            "dec_gain": self.dec_gain,
            "max_pulse_ms": self.max_pulse_ms,
            "min_pulse_ms": self.min_pulse_ms,
            "plate_scale": self.plate_scale,
            "ref_x": round(self.ref_x, 1),
            "ref_y": round(self.ref_y, 1),
            "ref_set": self.ref_set,
            "current_x": round(self.current_x, 1),
            "current_y": round(self.current_y, 1),
            "drift_x": round(self.drift_x, 2),
            "drift_y": round(self.drift_y, 2),
            "drift_arcsec_x": round(self.drift_arcsec_x, 2),
            "drift_arcsec_y": round(self.drift_arcsec_y, 2),
            "ra_pulse_ms": self.ra_pulse_ms,
            "dec_pulse_ms": self.dec_pulse_ms,
            "ra_direction": self.ra_direction,
            "dec_direction": self.dec_direction,
            "frame_count": self.frame_count,
            "history": self.history[-100:],  # Last 100 for API
        }
