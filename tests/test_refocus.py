"""
test_refocus.py — RefocusPolicy (Lot B3) + orchestration server-side.

Lancé par pytest (nécessite le venv). Pure-logic tests: no hardware.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.refocus import (  # noqa: E402
    MOVE_TIMEOUT_S,
    RefocusError,
    RefocusPolicy,
    run_autofocus,
)


# ── RefocusPolicy — decision logic ─────────────────────────────

def test_disabled_never_refocuses():
    p = RefocusPolicy(enabled=False, interval_min=20, alt_trigger_deg=3)
    assert p.should_refocus(1000.0, 45.0) is False
    p.last_time = 0.0  # simulate a very old refocus
    p.last_alt = 45.0
    assert p.should_refocus(10**9, 90.0) is False


def test_first_call_is_baseline():
    p = RefocusPolicy(enabled=True, interval_min=20, alt_trigger_deg=3)
    assert p.should_refocus(1000.0, 45.0) is False
    assert p.last_time == 1000.0
    assert p.last_alt == 45.0


def test_interval_trigger():
    p = RefocusPolicy(enabled=True, interval_min=20, alt_trigger_deg=0)
    p.mark_refocused(1000.0, 45.0)
    assert p.reason(1000.0 + 19 * 60, 45.0) is None
    assert p.should_refocus(1000.0 + 19 * 60, 45.0) is False
    assert p.reason(1000.0 + 20 * 60 + 1, 45.0) == "interval"
    assert p.should_refocus(1000.0 + 20 * 60 + 1, 45.0) is True


def test_altitude_trigger():
    p = RefocusPolicy(enabled=True, interval_min=0, alt_trigger_deg=3.0)
    p.mark_refocused(1000.0, 45.0)
    assert p.should_refocus(1001.0, 47.9) is False
    assert p.reason(1001.0, 47.9) is None
    assert p.reason(1002.0, 48.0) == "altitude"
    assert p.should_refocus(1002.0, 48.0) is True
    # l'amplitude absolue compte (descente après un flip) et le succès
    # efface le cooldown de la tentative précédente
    p.mark_refocused(1003.0, 50.0)
    assert p.should_refocus(1004.0, 47.1) is False  # Δ = 2.9° < 3°
    assert p.should_refocus(1005.0, 46.9) is True   # Δ = 3.1° ≥ 3°


def test_both_triggers_report_both():
    p = RefocusPolicy(enabled=True, interval_min=10, alt_trigger_deg=2.0)
    p.mark_refocused(1000.0, 45.0)
    assert p.reason(1000.0 + 11 * 60, 49.0) == "both"


def test_no_alt_available_only_interval_counts():
    p = RefocusPolicy(enabled=True, interval_min=5, alt_trigger_deg=3.0)
    p.mark_refocused(1000.0, None)
    assert p.reason(1000.0 + 3 * 60, None) is None
    assert p.reason(1000.0 + 6 * 60, None) == "interval"


def test_failed_attempt_has_cool_down():
    p = RefocusPolicy(enabled=True, interval_min=5, alt_trigger_deg=3.0)
    p.mark_refocused(1000.0, 45.0)
    # fires and stamps an attempt
    assert p.should_refocus(1000.0 + 6 * 60, 45.0) is True
    assert p.should_refocus(1000.0 + 6 * 60 + 60, 45.0) is False  # cooldown
    assert p.should_refocus(1000.0 + 6 * 60 + 300, 45.0) is True  # cooldown passed


def test_zero_thresholds_disable_dimension():
    p = RefocusPolicy(enabled=True, interval_min=0, alt_trigger_deg=0)
    p.mark_refocused(1000.0, 45.0)
    assert p.should_refocus(10**9, 90.0) is False  # both dims disabled


# ── run_autofocus — orchestration ──────────────────────────────

def test_run_autofocus_moves_to_vertex_and_back():
    async def main():
        fake = FakeFocuser(position=1000)
        positions = []

        async def measure():
            hfr = ((fake.position - 1000) / 100.0) ** 2 + 0.5
            positions.append(fake.position)
            return round(hfr, 4), 2.0, 1

        res = await run_autofocus(fake, measure,
                                  {"center": 1000, "range": 200, "points": 5},
                                  logger=None)
        assert res["ok"] is True
        assert len(positions) == 5
        assert res["best_position"] == 1000
        assert res["best_hfr"] == 0.5
        assert fake.targets and fake.targets[-1] == 1000  # slew back to best

    asyncio.run(main())


def test_run_autofocus_no_stars_raises():
    async def main():
        fake = FakeFocuser(position=0)

        async def measure():
            return 0.0, 0.0, 0

        try:
            await run_autofocus(fake, measure, {"range": 50, "points": 3})
        except RefocusError as e:
            assert "étoiles" in str(e)
            return
        raise AssertionError("expected RefocusError for empty field")

    asyncio.run(main())


def test_run_autofocus_move_timeout_raises():
    async def main():
        stuck = FakeFocuser(position=0, never_arrive=True)

        async def measure():
            return 1.0, 2.0, 1

        try:
            await run_autofocus(stuck, measure, {"range": 50, "points": 3},
                                logger=None)
        except RefocusError as e:
            assert "timeout" in str(e)
            return
        raise AssertionError("expected RefocusError on focuser timeout")

    asyncio.run(main())


# ── fakes ──────────────────────────────────────────────────────

class FakeFocuser:
    """Position advances instantly; records move targets."""

    def __init__(self, position=0, never_arrive=False):
        self.position = position
        self.is_moving = False
        self.targets = []
        self.never_arrive = never_arrive

    async def move_to(self, position):
        self.targets.append(position)
        self.is_moving = True
        if not self.never_arrive:
            self.position = position
            self.is_moving = False


if __name__ == "__main__":
    import traceback
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_"):
            continue
        print(f"  → {name}")
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ✗ {name}: {e}")
            traceback.print_exc()
    sys.exit(1 if failed else 0)