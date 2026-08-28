"""
test_triggers.py — Trigger Manager (Lot A2).

Couvre : matching (événement + conditions), templating d'action, les actions
log / script (RC, timeout) / mount_goto, le mode non bloquant de fire(),
la désactivation, et le volume status().

Run via: pytest tests/test_triggers.py
"""

import asyncio

import pytest

from indigo.devices.triggers import TriggerManager


def _log_trigger(msg="bonjour {event}", event="series_done"):
    return {
        "name": "t-log",
        "event": event,
        "actions": [{"type": "log", "level": "info", "message": msg}],
    }


# ── Matching ─────────────────────────────────────────────────

def test_matching_by_event_and_conditions():
    mgr = TriggerManager([
        {"name": "a", "event": "frame_done",
         "actions": [{"type": "log", "message": "A"}]},
        {"name": "b", "event": "frame_done", "conditions": {"frame_type": "LIGHT"},
         "actions": [{"type": "log", "message": "B"}]},
        {"name": "c", "event": "frame_done", "conditions": {"frame_type": ["LIGHT", "FLAT"]},
         "actions": [{"type": "log", "message": "C"}]},
        {"name": "d", "event": "series_done",
         "actions": [{"type": "log", "message": "D"}]},
    ])
    async def _run():
        res = await mgr.trigger_now("frame_done", {"frame_type": "LIGHT"})
        return [r["name"] for r in res]

    names = asyncio.run(_run())
    assert set(names) == {"a", "b", "c"}
    # conditions non remplies → filtré
    async def _run2():
        res = await mgr.trigger_now("frame_done", {"frame_type": "DARK"})
        return [r["name"] for r in res]

    assert asyncio.run(_run2()) == ["a"]


# ── Action log + templating ──────────────────────────────────

def test_log_action_templates_context():
    mgr = TriggerManager([_log_trigger(msg="serie {done}/{total} via {missing}")])
    async def _run():
        return await mgr.trigger_now("series_done", {"done": 5, "total": 8})

    res = asyncio.run(_run())
    assert len(res) == 1
    assert res[0]["results"][0]["ok"] is True
    assert res[0]["results"][0]["message"] == "serie 5/8 via "


# ── Actions script ───────────────────────────────────────────

def test_script_action_ok_and_templating():
    mgr = TriggerManager([
        {"name": "s", "event": "frame_done",
         "actions": [{"type": "script",
                      "command": "echo 'pose {index}'", "timeout": 5}]},
    ])
    async def _run():
        return await mgr.trigger_now("frame_done", {"index": 3})

    res = asyncio.run(_run())
    r = res[0]["results"][0]
    assert r["ok"] is True, r
    assert r["rc"] == 0
    assert r["output"] == "pose 3"


def test_script_action_timeout():
    mgr = TriggerManager([
        {"name": "s", "event": "frame_done",
         "actions": [{"type": "script", "command": "sleep 5", "timeout": 0.5}]},
    ])
    async def _run():
        return await mgr.trigger_now("frame_done", {})

    res = asyncio.run(_run())
    r = res[0]["results"][0]
    assert r["ok"] is False
    assert "dépassé" in r["error"]


# ── Action mount_goto ────────────────────────────────────────

class _FakeMount:
    def __init__(self, connected=True, ra_hours=6.0, dec_deg=30.0):
        self.connected = connected
        self.ra_hours = ra_hours
        self.dec_deg = dec_deg
        self.gotos = []

    async def slew_to(self, ra, dec):
        self.gotos.append((ra, dec))


def test_mount_goto_action():
    mnt = _FakeMount()
    mgr = TriggerManager([
        {"name": "g", "event": "error",
         "actions": [{"type": "mount_goto", "ra": "12.5", "dec": "-20.0"}]},
    ])
    mgr.bind({"mount": lambda: mnt})
    async def _run():
        return await mgr.trigger_now("error", {"error": "boom"})

    res = asyncio.run(_run())
    r = res[0]["results"][0]
    assert r["ok"] is True, r
    assert mnt.gotos == [(12.5, -20.0)]


def test_mount_goto_ra_now_uses_current():
    mnt = _FakeMount(ra_hours=7.25, dec_deg=45.0)
    mgr = TriggerManager([
        {"name": "g", "event": "error",
         "actions": [{"type": "mount_goto", "ra": "now", "dec": "45.0"}]},
    ])
    mgr.bind({"mount": lambda: mnt})
    async def _run():
        return await mgr.trigger_now("error", {"error": "x"})

    res = asyncio.run(_run())
    assert res[0]["results"][0]["ok"] is True
    assert mnt.gotos == [(7.25, 45.0)]


def test_mount_goto_no_mount_bind():
    mgr = TriggerManager([
        {"name": "g", "event": "error",
         "actions": [{"type": "mount_goto", "ra": "1", "dec": "2"}]},
    ])
    async def _run():
        return await mgr.trigger_now("error", {"error": "x"})

    res = asyncio.run(_run())
    r = res[0]["results"][0]
    assert r["ok"] is False
    assert "aucune monture" in r["error"]


# ── Divers ───────────────────────────────────────────────────

def test_unknown_action_is_error():
    mgr = TriggerManager([
        {"name": "u", "event": "frame_done",
         "actions": [{"type": "teleport", "where": "mars"}]},
    ])
    async def _run():
        return await mgr.trigger_now("frame_done", {})

    res = asyncio.run(_run())
    assert res[0]["results"][0]["ok"] is False


def test_disabled_manager_fires_nothing():
    mgr = TriggerManager([_log_trigger()])
    mgr.set_enabled(False)
    async def _run():
        assert mgr.fire("series_done", {}) == []
        return await mgr.trigger_now("series_done", {})

    assert asyncio.run(_run()) == []


def test_fire_is_non_blocking_and_records_last():
    async def _run():
        mgr = TriggerManager([_log_trigger(event="frame_done")])
        fired = mgr.fire("frame_done", {})
        assert fired == ["t-log"]
        # laisse la task de fond s'exécuter
        await asyncio.sleep(0.05)
        assert "t-log" in mgr.status()["last"]
        return mgr

    mgr = asyncio.run(_run())
    last = mgr.status()["last"]["t-log"]
    assert last["event"] == "frame_done"
    assert last["results"][0]["ok"] is True


def test_status_schema():
    mgr = TriggerManager([_log_trigger()])
    st = mgr.status()
    assert st["enabled"] is True
    assert "series_done" in st["events"]
    assert len(st["triggers"]) == 1
    assert "last" in st


def test_fire_unknown_event_is_noop():
    mgr = TriggerManager([_log_trigger()])
    assert mgr.fire("meteor", {}) == []
    async def _run():
        return await mgr.trigger_now("meteor", {})

    assert asyncio.run(_run()) == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])