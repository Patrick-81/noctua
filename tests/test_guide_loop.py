"""
test_guide_loop.py — Unit tests for the server-side guide loop.

Covers ``indigo.devices.guide_loop`` (pure mapping + session driven by
injected hooks, no INDIGO hardware needed) and ``Guide.update_config``.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from indigo.devices.guide import Guide, GuideState
from indigo.devices.guide_loop import GuideLoopSession, map_pulses


def test_map_pulses_directions():
    pulses = map_pulses({"ra_pulse_ms": 120, "ra_direction": "W",
                         "dec_pulse_ms": 80, "dec_direction": "S"})
    assert ("WEST", 120) in pulses
    assert ("SOUTH", 80) in pulses
    pulses = map_pulses({"ra_pulse_ms": 50, "ra_direction": "E",
                         "dec_pulse_ms": 60, "dec_direction": "N"})
    assert ("EAST", 50) in pulses
    assert ("NORTH", 60) in pulses


def test_map_pulses_empty_when_zero():
    assert map_pulses({"ra_pulse_ms": 0, "ra_direction": "",
                       "dec_pulse_ms": 0, "dec_direction": ""}) == []
    # Unknown direction codes are ignored (never send a wrong slew).
    assert map_pulses({"ra_pulse_ms": 100, "ra_direction": "X",
                       "dec_pulse_ms": 0, "dec_direction": ""}) == []


def make_hooks(frames, record):
    """Fake hooks: ``frames`` = list of metric dicts (None = starless)."""
    it = iter(frames)

    async def capture_frame(duration, timeout):
        return b"fake-fits"

    async def measure(img):
        try:
            return next(it)
        except StopIteration:
            return None

    async def pulse(direction, ms):
        record["pulses"].append((direction, ms))

    async def set_rate(rate):
        record["rate"] = rate

    def broadcast(payload):
        record["broadcasts"].append(payload)

    async def log(level, msg):
        record["logs"].append((level, msg))

    async def sleep(s):
        await asyncio.sleep(0)  # cède la main (sinon la boucle affame le test)

    return {
        "capture_frame": capture_frame,
        "measure": measure,
        "pulse": pulse,
        "set_rate": set_rate,
        "broadcast": broadcast,
        "log": log,
        "sleep": sleep,
    }


async def _run_with_record(session, guide, record, max_frames):
    task = asyncio.ensure_future(session.run())
    for _ in range(2000):
        await asyncio.sleep(0)
        n = sum(1 for p in record["broadcasts"]
                if isinstance(p, dict) and "centroid" in p)
        if n >= max_frames:
            break
    guide.stop()
    await asyncio.wait_for(task, timeout=5)


def fresh_record():
    return {"pulses": [], "broadcasts": [], "logs": [], "rate": None}


def test_loop_steps_and_pulses():
    guide = Guide()
    guide.start(exposure_sec=1.0, aggressiveness=1.0, ra_gain=10.0,
                dec_gain=10.0, max_pulse_ms=2000, min_pulse_ms=1,
                plate_scale=1.0)
    record = fresh_record()
    hooks = make_hooks([
        {"x": 100.0, "y": 100.0, "snr": 20.0, "width": 640, "height": 480},
        {"x": 110.0, "y": 100.0, "snr": 20.0, "width": 640, "height": 480},
        {"x": 110.0, "y": 106.0, "snr": 20.0, "width": 640, "height": 480},
    ], record)
    hooks["_record"] = record
    asyncio.new_event_loop().run_until_complete(
        _run_with_record(GuideLoopSession(guide, "Guide Camera", hooks),
                         guide, record, 3))
    # First frame sets the reference (no pulse), next frames correct.
    assert guide.frame_count >= 3
    assert record["rate"] == "Guide"
    dirs = [d for d, _ in record["pulses"]]
    assert "WEST" in dirs  # drift +10px X → corrige Ouest
    assert "SOUTH" in dirs  # drift +6px Y → corrige Sud
    # Telemetry carries centroid for the frontend overlays.
    centro = [p for p in record["broadcasts"]
              if isinstance(p, dict) and "centroid" in p]
    assert centro and centro[0]["centroid"]["x"] == 100.0
    assert centro[0]["camera"] == "Guide Camera"


def test_loop_starless_keeps_running():
    guide = Guide()
    guide.start()
    record = fresh_record()
    hooks = make_hooks([None, None,
                        {"x": 50.0, "y": 50.0, "snr": 9.0,
                         "width": 640, "height": 480}], record)
    hooks["_record"] = record
    asyncio.new_event_loop().run_until_complete(
        _run_with_record(GuideLoopSession(guide, "Guide Camera", hooks),
                         guide, record, 1))
    # Starless frames don't step (no reference drift), loop survives.
    assert any("aucune étoile" in m or "image fraîche" in m
               for _, m in record["logs"])
    assert guide.frame_count == 1  # seule la frame mesurée steppe…
    assert record["pulses"] == []  # …et la 1re mesure fixe juste la référence.


def test_loop_pause_no_capture():
    guide = Guide()
    guide.start()
    record = fresh_record()
    calls = {"capture": 0}

    async def capture_frame(duration, timeout):
        calls["capture"] += 1
        return b"img"

    async def measure(img):
        return {"x": 1.0, "y": 1.0, "snr": 5.0, "width": 10, "height": 10}

    async def pulse(direction, ms):
        pass

    async def set_rate(rate):
        pass

    def broadcast(payload):
        record["broadcasts"].append(payload)

    async def log(level, msg):
        pass

    async def sleep(s):
        await asyncio.sleep(0)  # cède la main (sinon la boucle affame le test)

    hooks = {"capture_frame": capture_frame, "measure": measure,
             "pulse": pulse, "set_rate": set_rate, "broadcast": broadcast,
             "log": log, "sleep": sleep}

    async def main():
        session = GuideLoopSession(guide, "Guide Camera", hooks)
        task = asyncio.ensure_future(session.run())
        for _ in range(200):
            await asyncio.sleep(0)
            if guide.frame_count >= 1:
                break
        guide.pause()
        n_before = calls["capture"]
        for _ in range(200):
            await asyncio.sleep(0)
        assert calls["capture"] == n_before  # paused → no exposes
        guide.resume()
        for _ in range(2000):
            await asyncio.sleep(0)
            if guide.frame_count >= 2:
                break
        assert guide.frame_count >= 2
        guide.stop()
        await asyncio.wait_for(task, timeout=5)

    asyncio.new_event_loop().run_until_complete(main())


def test_loop_capture_error_retries():
    guide = Guide()
    guide.start()
    record = fresh_record()

    async def capture_frame(duration, timeout):
        raise RuntimeError("caméra débranchée")

    async def measure(img):
        raise AssertionError("unreachable")

    async def pulse(direction, ms):
        raise AssertionError("unreachable")

    async def set_rate(rate):
        pass

    def broadcast(payload):
        record["broadcasts"].append(payload)

    async def log(level, msg):
        record["logs"].append((level, msg))

    async def sleep(s):
        await asyncio.sleep(0)

    hooks = {"capture_frame": capture_frame, "measure": measure,
             "pulse": pulse, "set_rate": set_rate, "broadcast": broadcast,
             "log": log, "sleep": sleep}

    async def main():
        session = GuideLoopSession(guide, "Guide Camera", hooks)
        task = asyncio.ensure_future(session.run())
        await asyncio.sleep(0.05)
        guide.stop()
        await asyncio.wait_for(task, timeout=5)

    asyncio.new_event_loop().run_until_complete(main())
    # Transient errors never kill the loop; they are logged.
    assert any("frame ignorée" in m for _, m in record["logs"])


def test_update_config_hot_retune():
    guide = Guide()
    guide.start(exposure_sec=1.0, aggressiveness=0.8)
    res = guide.update_config(exposure_sec=2.5, ra_gain=3.0)
    assert res["exposure_sec"] == 2.5
    assert res["ra_gain"] == 3.0
    assert guide.frame_count == 0  # session NOT reset
    # Clamps identiques à start().
    res = guide.update_config(exposure_sec=999.0, aggressiveness=-1.0)
    assert res["exposure_sec"] == 30.0
    assert res["aggressiveness"] == 0.0
