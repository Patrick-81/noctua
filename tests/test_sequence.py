"""
test_sequence.py — Unit tests for the sequence acquisition engine.

Covers: plan totals, frame validation, path grouping, and the SequenceRunner
state machine (run, filter/save/dither flow, pause/resume, stop, errors).

Run via: pytest tests/test_sequence.py  (or python tests/test_sequence.py)
"""

import asyncio
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.devices.sequence import (  # noqa: E402
    SequenceRunner,
    build_path,
    total_frames,
    validate_frames,
)

TWO_FRAMES = [
    {"duration": 30.0, "frame_type": "LIGHT", "filter": "L", "count": 2, "delay": 0.5},
    {"duration": 10.0, "frame_type": "DARK", "filter": "", "count": 1, "delay": 0.0},
]


# ── Pure helpers ─────────────────────────────────────────────

def test_plan_total():
    assert total_frames(TWO_FRAMES) == 3
    assert total_frames([]) == 0
    assert total_frames([{"duration": 1, "count": 0}]) == 0


def test_validate_frames():
    assert validate_frames([]) is not None
    assert validate_frames([{"duration": 0, "count": 1}]) is not None
    assert validate_frames([{"duration": -5.0, "count": 1}]) is not None
    assert validate_frames([{"duration": 1.0, "count": 0}]) is not None
    assert validate_frames(TWO_FRAMES) is None


def test_build_path_groups_by_filter():
    p = build_path("/tmp/seq", {"frame_type": "LIGHT", "filter": "L"}, 1)
    assert p.startswith("/tmp/seq/L/light_L_001_")
    assert p.endswith(".fits")
    assert "L" in os.path.dirname(p)


def test_build_path_falls_back_to_group():
    p = build_path("~/seq", {"frame_type": "DARK"}, 2)
    assert p.startswith(os.path.expanduser("~/seq") + "/dark/dark_dark_002_")
    assert p.endswith(".fits")


# ── Runner with fake hooks ───────────────────────────────────

def _hook_record(delay_sleep=0.0, wait_sleep=0.0, fail_save_at=None, fail_expose=False):
    """Build async hooks that log every call into ``calls``."""
    calls = {"expose": [], "wait": 0, "save": [], "set_filter": [], "dither": [],
             "delay": [], "log": []}

    async def expose(duration, frame_type):
        calls["expose"].append((duration, frame_type))
        if fail_expose:
            raise RuntimeError("boom expose")

    async def wait():
        calls["wait"] += 1
        if wait_sleep:
            await asyncio.sleep(wait_sleep)

    async def save(frame, index):
        path = build_path("/tmp/seq", frame, index)
        if fail_save_at is not None and index == fail_save_at:
            raise RuntimeError("boom save")
        calls["save"].append(index)
        return path

    async def set_filter(name):
        calls["set_filter"].append(name)

    async def dither():
        calls["dither"].append(1)
        return {"ok": True, "dx": 1.0, "dy": -1.0}

    async def delay(seconds):
        calls["delay"].append(seconds)
        if delay_sleep:
            await asyncio.sleep(delay_sleep)

    async def log(level, msg):
        calls["log"].append((level, msg))

    hooks = {"expose": expose, "wait_exposure": wait, "save": save,
             "set_filter": set_filter, "dither": dither, "delay": delay, "log": log}
    return hooks, calls


_hook = _hook_record


def test_runner_runs_plan_in_order():
    async def main():
        r = SequenceRunner()
        hooks, calls = _hook()
        r.start(TWO_FRAMES)
        await r.run(hooks)

        # 3 exposures total, starting with frame 1 (LIGHT+L) ×2 then DARK ×1
        assert calls["expose"] == [(30.0, "LIGHT"), (30.0, "LIGHT"), (10.0, "DARK")]
        # filter set before each exposure of the LIGHT/L frame
        assert calls["set_filter"] == ["L", "L"]
        assert calls["wait"] == 3
        assert calls["save"] == [1, 2, 3]
        assert len(calls["dither"]) == 3
        # delay applied after every pose (including the trailing one)
        assert calls["delay"] == [0.5, 0.5, 0.0]

        st = r.status()
        assert st["running"] is False
        assert st["done"] == 3
        assert st["total"] == 3
        assert st["progress"] == 1.0
        assert st["last_saved"].endswith(".fits")
        assert st["last_dither"]["dx"] == 1.0

    asyncio.run(main())


def test_runner_start_guards():
    r = SequenceRunner()
    r.start(TWO_FRAMES)
    try:
        r.start(TWO_FRAMES)
        assert False, "expected RuntimeError for double start"
    except RuntimeError:
        pass
    except ValueError:
        pass
    try:
        SequenceRunner().start([])
        assert False, "expected ValueError for empty plan"
    except ValueError:
        pass


def test_runner_pause_resume_halts_progress():
    async def main():
        r = SequenceRunner()
        # slow per-pose hooks so the pause lands mid-run
        hooks, calls = _hook(wait_sleep=0.2, delay_sleep=0.2)
        r.start(TWO_FRAMES)
        task = asyncio.create_task(r.run(hooks))
        await asyncio.sleep(0.3)
        st = r.pause()
        assert st["paused"] is True
        done_at_pause = r.status()["done"]
        await asyncio.sleep(0.5)
        assert r.status()["done"] == done_at_pause, "progress must halt while paused"
        st = r.resume()
        assert st["paused"] is False
        await task
        assert r.status()["done"] == 3
        assert r.status()["progress"] == 1.0

    asyncio.run(main())


def test_runner_stop_halts_early():
    async def main():
        r = SequenceRunner()
        hooks, _ = _hook(wait_sleep=0.3, delay_sleep=0.3)
        r.start(TWO_FRAMES)
        task = asyncio.create_task(r.run(hooks))
        await asyncio.sleep(0.15)
        r.stop()
        await task
        st = r.status()
        assert st["running"] is False
        assert st["done"] < 3, f"expected < 3, got {st['done']}"

    asyncio.run(main())


def test_runner_error_sets_last_error():
    async def main():
        r = SequenceRunner()
        hooks, _ = _hook(fail_save_at=1)
        r.start(TWO_FRAMES)
        try:
            await r.run(hooks)
            assert False, "runner must re-raise when not stopping"
        except RuntimeError:
            pass
        st = r.status()
        assert st["running"] is False
        assert st["last_error"] and "boom" in st["last_error"]
        assert st["done"] == 0, "failed pose must not be counted as done"

    asyncio.run(main())


def test_runner_reset_clears_state():
    async def main():
        r = SequenceRunner()
        hooks, _ = _hook()
        r.start(TWO_FRAMES)
        await r.run(hooks)
        assert r.status()["done"] == 3
        st = r.reset()
        assert st["done"] == 0
        assert st["total"] == 0
        assert st["running"] is False

    asyncio.run(main())


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  ✓ {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"  ✗ {t.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)