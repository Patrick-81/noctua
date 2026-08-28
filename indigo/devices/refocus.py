"""
refocus.py — Automatic refocus policy and server-side autofocus orchestration.

Lot B3. Two independent triggers decide *when* the focus should be re-computed
while a sequence runs (time elapsed and/or mount altitude drift), then the
existing HFR V-curve autofocus (``AutoFocus`` in ``autofocus.py``) is driven
entirely server-side between two frames — no frontend round-trip:

  - move the focuser to each sampled position,
  - ``measure()`` (injected by the router) exposes 1 s and returns the HFR,
  - ``finish()`` fits the parabola and we slew back to the best position.

The decision logic (``RefocusPolicy``) is a pure state machine so it can be
unit-tested without hardware.  The first call in a run just records the
baseline (assume the user started focused); only subsequent changes trip.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from .autofocus import AutoFocus

log = logging.getLogger("indigo.refocus")

# Timeout for a single focuser move (position magnetically dead-aligned).
MOVE_TIMEOUT_S = 15.0

# A failed refocus is retried only after this delay (attempts are recorded on
# every ``should_refocus`` that fires, so a failing focus never loops per-frame).
ATTEMPT_COOLDOWN_S = 300.0

# Default retry sample settings (same defaults as the frontend autofocus).
DEFAULT_RANGE = 2000
DEFAULT_POINTS = 25
DEFAULT_EXPOSURE_S = 1.0

MeasureFn = Callable[[], Awaitable[tuple[float, float, int]]]  # (hfr, fwhm, stars)


class RefocusError(Exception):
    """Raised when an automatic refocus cannot be completed."""


class RefocusPolicy:
    """Decides when a refocus is due during an acquisition session.

    Triggered when *either* the configured time interval has elapsed since the
    last successful refocus, *or* the mount altitude has drifted by more than
    ``alt_trigger_deg``.  A threshold of ``0`` disables that dimension.

    Timing uses ``time.monotonic()`` (the caller passes ``now``) — only
    elapsed-time differences matter, never wall-clock epoch.  First
    never-baselined call marks the baseline and returns False — the sequence
    never refocuses on the very first frame.
    """

    def __init__(
        self,
        enabled: bool = False,
        interval_min: float = 20.0,
        alt_trigger_deg: float = 3.0,
        attempt_cooldown_s: float = ATTEMPT_COOLDOWN_S,
    ) -> None:
        self.enabled = enabled
        self.interval_min = float(interval_min)
        self.alt_trigger_deg = float(alt_trigger_deg)
        self.attempt_cooldown_s = float(attempt_cooldown_s)
        self.last_time: float | None = None
        self.last_alt: float | None = None
        self.last_attempt: float | None = None
        self.last_best: int | None = None
        self.last_best_hfr: float | None = None

    def configure(self, **kw) -> None:
        """Apply partial config overrides (e.g. from the sequence start body)."""
        if "enabled" in kw:
            self.enabled = bool(kw["enabled"])
        if "interval_min" in kw and kw["interval_min"] is not None:
            self.interval_min = float(kw["interval_min"])
        if "alt_trigger_deg" in kw and kw["alt_trigger_deg"] is not None:
            self.alt_trigger_deg = float(kw["alt_trigger_deg"])

    # ── Decision ─────────────────────────────────────────────────

    def reason(self, now: float, alt_deg: float | None) -> str | None:
        """Return ``"interval"``/``"altitude"``/``"both"`` if a refocus is due."""
        if not self.enabled:
            return None
        if self.last_time is None:
            return None  # no baseline yet — recorded by should_refocus()
        due: list[str] = []
        elapsed_min = (now - self.last_time) / 60.0
        if self.interval_min > 0 and elapsed_min >= self.interval_min:
            due.append("interval")
        if (self.alt_trigger_deg > 0 and self.last_alt is not None and alt_deg is not None
                and abs(alt_deg - self.last_alt) >= self.alt_trigger_deg):
            due.append("altitude")
        if not due:
            return None
        if self.last_attempt is not None and now - self.last_attempt < self.attempt_cooldown_s:
            return None  # a recent attempt failed — wait for the cool-down
        return "both" if len(due) == 2 else due[0]

    def should_refocus(self, now: float, alt_deg: float | None) -> bool:
        """True when a refocus should run before the next frame.

        Records the baseline on first use (returns False) and stamps the
        attempt on every fire so a failure does not retry per-frame.
        """
        if not self.enabled:
            return False
        if self.last_time is None:
            self.last_time = now
            self.last_alt = alt_deg
            return False
        r = self.reason(now, alt_deg)
        if r is None:
            return False
        self.last_attempt = now
        return True

    def mark_refocused(self, now: float, alt_deg: float | None, best: int | None = None,
                       best_hfr: float | None = None) -> None:
        """Record a successful refocus — the baseline for the next trigger.

        Also clears any failed-attempt cool-down.
        """
        self.last_time = now
        self.last_alt = alt_deg
        self.last_best = best
        self.last_best_hfr = best_hfr
        self.last_attempt = None

    def reset(self) -> None:
        """Clear the baseline (called at sequence start → first frame baselines)."""
        self.last_time = None
        self.last_alt = None
        self.last_attempt = None

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "interval_min": self.interval_min,
            "alt_trigger_deg": self.alt_trigger_deg,
            "last_time": self.last_time,
            "last_alt": self.last_alt,
            "last_best": self.last_best,
            "last_best_hfr": self.last_best_hfr,
            "reason": self.reason(time.monotonic(), None),
        }


async def _wait_focuser(focuser, target: int, timeout: float = MOVE_TIMEOUT_S) -> None:
    """Wait until the focuser stops moving (arrived at ``target``)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not getattr(focuser, "is_moving", False):
            return
        await asyncio.sleep(0.1)
    raise RefocusError(f"focuser n'a pas atteint {target} (timeout {timeout:.0f}s)")


async def run_autofocus(
    focuser,
    measure: MeasureFn,
    cfg: dict | None = None,
    logger: Callable[..., Awaitable[None]] | None = None,
) -> dict:
    """Run one full HFR autofocus pass entirely on the server.

    Args:
        focuser:  focuser device (``position``, ``move_to``, ``is_moving``).
        measure:  coroutine returning ``(hfr, fwhm, star_count)`` for a fresh
                  short exposure (injected by the router).
        cfg:      optional overrides ``range``, ``points``, ``center``.
        logger:   optional ``async log(level, msg)`` for progress lines.

    Returns:
        dict with ``ok``, ``best_position``, ``best_hfr``, ``num_points``,
        ``center``, ``search_range``.
    """
    async def logf(level: str, msg: str) -> None:
        if logger is not None:
            await logger(level, msg)

    cfg = cfg or {}
    center = int(cfg.get("center", getattr(focuser, "position", 0) or 0))
    search_range = int(cfg.get("range", DEFAULT_RANGE))
    num_points = int(cfg.get("points", DEFAULT_POINTS))

    af = AutoFocus()
    build = af.start(center, search_range, num_points)
    if not build.get("ok"):
        raise RefocusError(build.get("error", "autofocus start failed"))

    positions = build["positions"]
    await logf("info", f"refocus automatique : {len(positions)} points "
                       f"(center={center}, range={search_range}, step={build.get('step_size')})")

    for pos in positions:
        await focuser.move_to(pos)
        await _wait_focuser(focuser, pos)
        try:
            hfr, fwhm, stars = await measure()
        except Exception as e:  # noqa: BLE001
            raise RefocusError(f"mesure HFR échouée à {pos}: {e}") from e
        if hfr is None or stars == 0:
            raise RefocusError(
                f"HFR non mesurable à {pos} ({stars} étoiles) — "
                "vérifiez la pose, l'étoile ou le filtre")
        af.step_result(pos, hfr, fwhm)
        await logf("debug", f"refocus {len(af.results)}/{len(positions)}: "
                            f"pos={pos} HFR={hfr:.2f}")

    fin = af.finish()
    best = fin.get("best_position")
    best_hfr = fin.get("best_hfr")
    if best is not None:
        await focuser.move_to(best)
        await _wait_focuser(focuser, best)
        await logf("info", f"refocus terminé : position {best} (HFR {best_hfr})")
    else:
        await logf("warning",
                   f"refocus : pas de minimum exploitable (parabole invalide) — "
                   f"meilleur point mesuré {fin.get('best_position')}")

    return {
        "ok": True,
        "best_position": best,
        "best_hfr": best_hfr,
        "num_points": len(positions),
        "center": center,
        "search_range": search_range,
    }