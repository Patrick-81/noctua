"""
test_dither.py — Dithering piloté par le guide (Lot A1).

Couvre : offset gaussien, recommutation du drift par set_reference, les trois
issues de wait_settle (settlé / timeout / guidage interrompu) et le chemin
complet apply_dither (skip guidage, skip config, settle, timeout).

Run via: pytest tests/test_dither.py
"""

import asyncio
import math
import random

import pytest

import indigo.devices.guide as guide_mod
from indigo.devices.guide import Guide, apply_dither, dither_gauss_offset, wait_settle


# ── Pur : offset gaussien ─────────────────────────────────────

def test_dither_gauss_offset_stats():
    random.seed(42)
    amount = 2.0
    n = 2000
    xs = [dither_gauss_offset(amount)[0] for _ in range(n)]
    ys = [dither_gauss_offset(amount)[1] for _ in range(n)]
    mean_x = sum(xs) / n
    std_x = math.sqrt(sum((x - mean_x) ** 2 for x in xs) / n)
    assert abs(mean_x) < 0.15 * amount
    assert 0.7 * amount <= std_x <= 1.3 * amount
    assert abs(sum(ys) / n) < 0.15 * amount


# ── Pur : set_reference recalcule le drift ────────────────────

def test_set_reference_recomputes_drift():
    g = Guide()
    g.start()
    g.step_result(100.0, 100.0)
    s = g.set_reference(120.0, 120.0)
    assert s["ref_x"] == 120.0
    assert s["ref_y"] == 120.0
    # le drift reflète immédiatement le décalage (20 px de chaque axe ici)
    assert s["drift_x"] == -20.0
    assert s["drift_y"] == -20.0
    # après convergence sur la nouvelle référence → drift nul
    s = g.step_result(120.0, 120.0)
    assert s["drift_x"] == 0.0
    assert s["drift_y"] == 0.0


def test_set_reference_before_measure_keeps_zero():
    g = Guide()
    g.start()
    s = g.set_reference(120.0, 120.0)  # pas encore de centroid mesuré
    assert s["ref_set"] is True
    assert s["drift_x"] == 0.0
    assert s["drift_y"] == 0.0


# ── wait_settle : les trois issues ────────────────────────────

def test_wait_settle_timeout():
    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        g.set_reference(120.0, 120.0)  # drift de 20 px jamais corrigé ici
        res = await wait_settle(g, settle_rms=1.0, timeout=0.5, poll=0.2, stable=2)
        assert res["timed_out"] is True
        assert res["aborted"] is False
        assert res["rms"] is not None and res["rms"] > 1.0
        assert 0.4 <= res["waited"] <= 0.8

    asyncio.run(_run())


def test_wait_settle_settles():
    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        g.set_reference(120.0, 120.0)  # simulate le shift de référence du dither

        async def drive():
            # le frontend guide : l'étoile revient vers la nouvelle référence
            for target in (112.0, 118.0, 122.0, 121.0, 120.0, 120.5, 120.0):
                g.step_result(target, target)
                await asyncio.sleep(0.15)

        task = asyncio.create_task(drive())
        res = await wait_settle(g, settle_rms=2.0, timeout=5.0, poll=0.1, stable=2)
        await task
        assert res["timed_out"] is False
        assert res["aborted"] is False
        assert res["rms"] is not None and res["rms"] <= 2.0

    asyncio.run(_run())


def test_wait_settle_aborts_when_guide_stops():
    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        g.set_reference(120.0, 120.0)

        async def stop_soon():
            await asyncio.sleep(0.25)
            g.stop()

        task = asyncio.create_task(stop_soon())
        res = await wait_settle(g, settle_rms=1.0, timeout=5.0, poll=0.1, stable=2)
        await task
        assert res["aborted"] is True
        assert res["timed_out"] is False

    asyncio.run(_run())


# ── apply_dither : chemins complets ───────────────────────────

def test_apply_dither_disabled():
    async def _run():
        g = Guide()
        g.start()
        res = await apply_dither(g, {"enabled": False})
        assert res["skipped"] is True

    asyncio.run(_run())


def test_apply_dither_not_guiding(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("wait_settle ne doit pas être appelé")

    monkeypatch.setattr(guide_mod, "wait_settle", _boom)

    async def _run():
        logs = []

        async def log(level, msg):
            logs.append((level, msg))

        res = await apply_dither(Guide(), {"enabled": True, "amount": 2.0}, log=log)
        assert res["guided"] is False
        assert res["skipped"] is True
        assert res["reason"] == "not guiding"
        assert any("pas de guidage" in m for _, m in logs)

    asyncio.run(_run())


def test_apply_dither_settles(monkeypatch):
    calls = {}

    async def fake_wait_settle(guide, rms, timeout, *, poll=0.5, stable=3):
        calls["args"] = (rms, timeout, stable)
        return {"waited": 2.4, "rms": 0.31, "timed_out": False, "aborted": False}

    monkeypatch.setattr(guide_mod, "wait_settle", fake_wait_settle)

    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        logs = []

        async def log(level, msg):
            logs.append((level, msg))

        res = await apply_dither(g, {
            "enabled": True, "amount": 2.5,
            "settle_rms": 1.0, "settle_timeout": 20.0, "settle_stable": 4,
        }, log=log)
        return g, res, logs

    g, res, logs = asyncio.run(_run())
    assert res["ok"] is True
    assert res["guided"] is True
    assert res["settle"]["timed_out"] is False
    assert calls["args"] == (1.0, 20.0, 4)
    # la référence du guideur a bien été décalée de (dx, dy)
    assert g.ref_x == 100.0 + res["dx"]
    assert g.ref_y == 100.0 + res["dy"]
    assert any("settlé" in m for _, m in logs)


def test_apply_dither_timed_out(monkeypatch):
    async def fake_wait_settle(guide, rms, timeout, *, poll=0.5, stable=3):
        return {"waited": 20.0, "rms": 5.5, "timed_out": True, "aborted": False}

    monkeypatch.setattr(guide_mod, "wait_settle", fake_wait_settle)

    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        logs = []

        async def log(level, msg):
            logs.append((level, msg))

        res = await apply_dither(g, {
            "enabled": True, "amount": 2.0,
            "settle_rms": 1.0, "settle_timeout": 20.0,
        }, log=log)
        return res, logs

    res, logs = asyncio.run(_run())
    assert res["settle"]["timed_out"] is True
    assert any("settle non atteint" in m for _, m in logs)


def test_apply_dither_no_settle_when_rms_zero(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("wait_settle ne doit pas être appelé")

    monkeypatch.setattr(guide_mod, "wait_settle", _boom)

    async def _run():
        g = Guide()
        g.start()
        g.step_result(100.0, 100.0)
        res = await apply_dither(g, {"enabled": True, "amount": 2.0, "settle_rms": 0})
        assert res["guided"] is True
        assert res["settle"]["waited"] == 0.0

    asyncio.run(_run())


if __name__ == "__main__":
    pytest.main([__file__, "-v"])