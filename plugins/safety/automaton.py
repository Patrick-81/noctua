"""
automaton.py — Safety Automaton pur (P2, sans I/O).

Testable sans INDIGO : on injecte des callbacks async pour
sequence/mount/dome/log. L'automate garantit l'ordre et les gardes.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum


class State(str, Enum):
    IDLE = "idle"
    MONITORING = "monitoring"
    UNSAFE_DETECT = "unsafe_detect"
    STOPPING = "stopping_sequence"
    PARKING = "parking_mount"
    CLOSING = "closing_roof"
    ALERTING = "alerting"
    WAITING_SAFE = "waiting_safe"


@dataclass
class SafetyConfig:
    poll_interval_s: float = 30.0
    debounce_count: int = 2
    hystere_s: float = 300.0
    stop_timeout_s: float = 30.0
    park_timeout_s: float = 120.0
    park_retry_s: float = 60.0
    close_timeout_s: float = 60.0


@dataclass
class SafetyAutomaton:
    """Automate pur — pas de dépendance INDIGO."""

    config: SafetyConfig = field(default_factory=SafetyConfig)
    state: State = State.IDLE
    reason: str = ""
    transitions: list[dict] = field(default_factory=list)
    _unsafe_streak: int = 0
    _safe_streak_s: float = 0.0
    _last_poll: float = 0.0

    # callbacks injectés par le backend : async def () -> bool / str
    # is_safe() -> (bool, reason)
    # stop_sequence() -> bool
    # is_sequence_running() -> bool
    # park_mount() -> bool
    # is_parked() -> bool
    # close_roof() -> bool|None (None si pas de dome)
    # is_roof_closed() -> bool|None
    # alert(reason) -> None
    # log(level, msg) -> None

    def _transit(self, to: State, reason: str = "") -> None:
        self.transitions.append({
            "from": self.state.value,
            "to": to.value,
            "reason": reason,
            "ts": time.time(),
        })
        self.state = to
        self.reason = reason

    async def poll(self, *, is_safe, is_sequence_running, is_parked, is_roof_closed) -> State:
        """Un tick de Monitoring / WaitingSafe — appelé toutes les poll_interval_s."""
        safe, why = await is_safe() if asyncio.iscoroutinefunction(is_safe) else is_safe()
        if self.state == State.MONITORING:
            if not safe:
                self._unsafe_streak += 1
                if self._unsafe_streak >= self.config.debounce_count:
                    self._transit(State.UNSAFE_DETECT, why or "unsafe x2")
                    self._unsafe_streak = 0
            else:
                self._unsafe_streak = 0
        elif self.state == State.WAITING_SAFE:
            if safe:
                # hystérésis : on compte le temps passé Safe
                if self._safe_streak_s == 0:
                    self._safe_streak_s = time.monotonic()
                if time.monotonic() - self._safe_streak_s >= self.config.hystere_s:
                    self._transit(State.MONITORING, "safe 5m")
                    self._safe_streak_s = 0
            else:
                self._safe_streak_s = 0
        return self.state

    async def run_unsafe_chain(self, *, stop_sequence, is_sequence_running,
                               park_mount, is_parked,
                               close_roof=None, is_roof_closed=None,
                               alert=None, log=None) -> State:
        """Enchaîne Stop → Park → [Close] → Alert depuis UnsafeDetect."""
        assert self.state == State.UNSAFE_DETECT, f"bad state {self.state}"
        # 1. StoppingSequence
        self._transit(State.STOPPING, self.reason)
        try:
            await self._call(stop_sequence)
            # wait sequence stopped
            if not await self._wait(lambda: not self._sync(is_sequence_running), self.config.stop_timeout_s):
                self._transit(State.ALERTING, "stop timeout")
                if alert:
                    await self._call(lambda: alert("stop timeout"))
                self._transit(State.WAITING_SAFE, "alerted")
                return self.state
        except Exception as e:  # noqa: BLE001
            self._transit(State.ALERTING, f"stop error: {e}")
            if alert:
                await self._call(lambda: alert(f"stop error: {e}"))
            self._transit(State.WAITING_SAFE, "alerted")
            return self.state

        # 2. ParkingMount
        self._transit(State.PARKING, self.reason)
        try:
            await self._call(park_mount)
            ok = await self._wait(lambda: self._sync(is_parked), self.config.park_timeout_s, retry_at=self.config.park_retry_s, retry_cb=park_mount)
            if not ok:
                self._transit(State.ALERTING, "park timeout/not parked")
                if alert:
                    await self._call(lambda: alert("park timeout/not parked"))
                self._transit(State.WAITING_SAFE, "alerted")
                return self.state
        except Exception as e:  # noqa: BLE001
            self._transit(State.ALERTING, f"park error: {e}")
            if alert:
                await self._call(lambda: alert(f"park error: {e}"))
            self._transit(State.WAITING_SAFE, "alerted")
            return self.state

        # 3. ClosingRoof (optionnel, garde parked)
        if close_roof is not None and is_roof_closed is not None:
            if not self._sync(is_parked):
                self._transit(State.ALERTING, "close skipped: not parked")
                if alert:
                    await self._call(lambda: alert("close skipped: not parked"))
                self._transit(State.WAITING_SAFE, "alerted")
                return self.state
            self._transit(State.CLOSING, self.reason)
            try:
                await self._call(close_roof)
                ok = await self._wait(lambda: self._sync(is_roof_closed), self.config.close_timeout_s)
                if not ok:
                    self._transit(State.ALERTING, "close timeout/not closed")
                    if alert:
                        await self._call(lambda: alert("close timeout"))
                    self._transit(State.WAITING_SAFE, "alerted")
                    return self.state
            except Exception as e:  # noqa: BLE001
                self._transit(State.ALERTING, f"close error: {e}")
                if alert:
                    await self._call(lambda: alert(f"close error: {e}"))
                self._transit(State.WAITING_SAFE, "alerted")
                return self.state

        # 4. Alerting → WaitingSafe
        self._transit(State.ALERTING, self.reason or "unsafe chain done")
        if alert:
            await self._call(lambda: alert(self.reason or "unsafe"))
        self._transit(State.WAITING_SAFE, "alerted")
        return self.state

    # ── helpers ───────────────────────────────────────────────

    def _sync(self, fn):
        res = fn()
        # si fn est coroutine, on ne l'a pas await — l'appelant doit passer une lambda sync
        # on supporte les deux via _call
        return res

    async def _call(self, fn):
        if asyncio.iscoroutinefunction(fn):
            return await fn()
        r = fn()
        if asyncio.iscoroutine(r):
            return await r
        return r

    async def _wait(self, cond, timeout: float, retry_at: float | None = None, retry_cb=None) -> bool:
        """Poll cond() toutes les 0.5s jusqu'à True ou timeout. Retry optionnel."""
        start = time.monotonic()
        retried = False
        while time.monotonic() - start < timeout:
            try:
                if cond():
                    return True
            except Exception:
                pass
            if retry_at is not None and not retried and time.monotonic() - start >= retry_at:
                retried = True
                if retry_cb:
                    try:
                        await self._call(retry_cb)
                    except Exception:
                        pass
            await asyncio.sleep(0.5)
        # dernier check
        try:
            return bool(cond())
        except Exception:
            return False
