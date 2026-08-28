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
    build_session_dir,
    load_journal,
    save_journal,
    slugify,
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
    assert p.startswith("/tmp/seq/lights/light_L_001_")
    assert p.endswith(".fits")
    assert "lights" in os.path.dirname(p)


def test_build_path_falls_back_to_group():
    p = build_path("~/seq", {"frame_type": "DARK"}, 2)
    assert p.startswith(os.path.expanduser("~/seq") + "/darks/dark_002_")
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


def test_runner_calls_before_frame_between_poses():
    """before_frame hook runs before each pose and doesn't block execution."""
    async def main():
        r = SequenceRunner()
        hooks, calls = _hook()
        flips = {"count": 0}

        async def before_frame(frame):
            flips["count"] += 1
            if flips["count"] == 1:
                return {"ok": True, "flipped": True, "phases": ["slew"]}
            return None

        hooks["before_frame"] = before_frame
        r.start(TWO_FRAMES)
        await r.run(hooks)

        assert flips["count"] == 3          # one call per pose
        assert calls["expose"] == [(30.0, "LIGHT"), (30.0, "LIGHT"), (10.0, "DARK")]
        assert r.status()["done"] == 3      # flip didn't abort the run

    asyncio.run(main())


def test_runner_trigger_event_hooks():
    """on_frame_start / on_error / on_end hooks sont appelés aux bons moments."""
    async def main():
        r = SequenceRunner()
        hooks, calls = _hook(fail_save_at=2)
        evts = {"frame_start": [], "error": [], "end": []}

        async def on_frame_start(frame, index):
            evts["frame_start"].append((frame.get("frame_type"), index))

        async def on_error(error, frame):
            evts["error"].append((error, frame.get("frame_type")))

        async def on_end(done, total, complete):
            evts["end"].append((done, total, complete))

        hooks["on_frame_start"] = on_frame_start
        hooks["on_error"] = on_error
        hooks["on_end"] = on_end

        r.start(TWO_FRAMES)  # LIGHT×2 puis DARK ; la 2e pose échoue (save)
        try:
            await r.run(hooks)
        except RuntimeError:
            pass

        # une frame_start par pose démarrée (2), une erreur sur la 2e
        assert evts["frame_start"] == [("LIGHT", 1), ("LIGHT", 2)]
        assert evts["error"] == [("boom save", "LIGHT")]
        # on_end marqué incomplet (erreur) après la 1e pose
        assert evts["end"] == [(1, 3, False)]

    asyncio.run(main())


def test_runner_series_done_complete():
    """on_end reçoit complete=True quand toutes les poses aboutissent."""
    async def main():
        r = SequenceRunner()
        hooks, _ = _hook()
        ends = []

        async def on_end(done, total, complete):
            ends.append((done, total, complete))

        hooks["on_end"] = on_end
        r.start(TWO_FRAMES)
        await r.run(hooks)

        assert ends == [(3, 3, True)]

    asyncio.run(main())


# ── Lot C2 : helpers cible/date + journal ─────────────────────

def test_slugify():
    assert slugify("M31 Andromeda") == "M31-Andromeda"
    assert slugify("  NGC 7000 — North America  ") == "NGC-7000-North-America"
    assert slugify("!@#$%") == "cible"
    assert slugify("") == ""


def test_build_session_dir_layout():
    from datetime import datetime
    now = datetime(2026, 8, 28, 21, 30, 5)
    # cible/date : strictly nested under root, with date + time subdirs
    d = build_session_dir("/data/caps", "M31 Andromeda", now=now)
    assert d == "/data/caps/M31-Andromeda/2026-08-28/213005"
    # legacy sans cible : capture_TS
    d2 = build_session_dir("/data/caps", "", now=now)
    assert d2 == "/data/caps/capture_20260828_213005"
    # expension ~ et slug vide
    assert build_session_dir("~/x", "!", now=now) == os.path.join(
        os.path.expanduser("~/x"), "cible", "2026-08-28", "213005")


def test_journal_roundtrip_preserves_created_at():
    import shutil
    import tempfile
    tmp = tempfile.mkdtemp(prefix="seq-journal-")
    try:
        session = os.path.join(tmp, "M31", "2026-08-28", "213005")
        p1 = save_journal(
            session,
            frames=[{"duration": 30.0, "frame_type": "LIGHT", "count": 2}],
            target="M31 Andromeda", done=1, total=2, running=True)
        assert p1.endswith("journal.json")
        j = load_journal(session)
        assert j["done"] == 1 and j["total"] == 2
        assert j["target"] == "M31 Andromeda"
        assert j["running"] is True
        # réécriture (pose suivante) : created_at conservé, done progressé
        save_journal(session, frames=j["frames"], target=j["target"],
                     done=2, total=2, running=False, complete=True)
        j2 = load_journal(session)
        assert j2["created_at"] == j["created_at"]
        assert j2["done"] == 2 and j2["complete"] is True
        # répertoire inexistant / journal corrompu → None
        assert load_journal(os.path.join(tmp, "nope")) is None
        junk = os.path.join(tmp, "corrupt")
        os.makedirs(junk, exist_ok=True)
        with open(os.path.join(junk, "journal.json"), "w") as f:
            f.write("{invalid json")
        assert load_journal(junk) is None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _tmp_journal(tmp, frames, done, total, complete=False, target="T"):
    session = os.path.join(tmp, "sess")
    os.makedirs(session, exist_ok=True)
    path = os.path.join(session, "journal.json")
    import json
    json.dump({"session_dir": session, "target": target, "frames": frames,
               "done": done, "total": total, "complete": complete}, open(path, "w"))
    return session, frames, path


def test_journal_resume_progress_helpers():
    """Le journal doit refléter la progression pour pouvoir reprendre."""
    import tempfile
    tmp = tempfile.mkdtemp(prefix="seq-journal2-")
    try:
        session, frames, path = _tmp_journal(tmp, TWO_FRAMES, 2, 3,
                                             complete=False, target="M31")
        j = load_journal(session)
        assert j is not None
        assert j["done"] == 2 and j["total"] == 3
        assert j["complete"] is False
        assert j["frames"] == frames
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# ── Lot C2 : reprise du SequenceRunner ────────────────────────

def test_runner_resume_skips_already_done_poses():
    """resume_from=N saute les N premières poses et continue les index."""
    async def main():
        r = SequenceRunner()
        hooks, calls = _hook()
        r.start(TWO_FRAMES, resume_from=2)   # LIGHT×2 déjà faites, il reste la DARK
        await r.run(hooks)

        st = r.status()
        assert st["done"] == 3                 # compteur cumulatif conservé
        assert st["total"] == 3
        assert calls["expose"] == [(10.0, "DARK")]  # seulement la pose restante
        assert calls["save"] == [3]            # index continue à 3 (pas d'écrasement)
        assert calls["set_filter"] == []

    asyncio.run(main())


def test_runner_resume_full_restart_without_offset():
    async def main():
        r = SequenceRunner()
        hooks, calls = _hook()
        r.start(TWO_FRAMES, resume_from=0)
        await r.run(hooks)
        assert r.status()["done"] == 3
        assert calls["save"] == [1, 2, 3]

    asyncio.run(main())


def test_runner_calls_journal_after_save():
    """Le hook journal est appelé après chaque pose sauvée avec l'index."""
    async def main():
        r = SequenceRunner()
        hooks, _ = _hook()
        journals = []

        async def journal(path, frame, index):
            journals.append((index, os.path.basename(path)))

        hooks["journal"] = journal
        r.start(TWO_FRAMES)
        await r.run(hooks)

        assert len(journals) == 3
        assert [j[0] for j in journals] == [1, 2, 3]
        assert all(j[1].startswith("light_") or j[1].startswith("dark_")
                   for j in journals)

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