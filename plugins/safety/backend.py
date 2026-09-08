"""
Safety backend — wiring de l'automate sur le serveur (P2).
"""

from __future__ import annotations

import asyncio
import logging
import time

from .automaton import SafetyAutomaton, SafetyConfig, State

log = logging.getLogger("indigo.safety")


def register(server) -> None:
    cfg = server.sequence_cfg.get("safety") if hasattr(server, "sequence_cfg") else None
    # fallback : lit plugin.yaml via PluginManager
    pm_cfg = {}
    try:
        for p in getattr(server.plugins, "_plugins", []):
            if p.get("_name") == "safety":
                pm_cfg = p.get("config", {}) or {}
    except Exception:
        pass
    merged = {**pm_cfg, **(cfg or {})}
    scfg = SafetyConfig(
        poll_interval_s=float(merged.get("poll_interval_s", 30)),
        debounce_count=int(merged.get("debounce_count", 2)),
        hystere_s=float(merged.get("hystere_s", 300)),
        stop_timeout_s=float(merged.get("stop_timeout_s", 30)),
        park_timeout_s=float(merged.get("park_timeout_s", 120)),
        park_retry_s=float(merged.get("park_retry_s", 60)),
        close_timeout_s=float(merged.get("close_timeout_s", 60)),
    )
    automaton = SafetyAutomaton(config=scfg, state=State.MONITORING)
    server._safety_automaton = automaton
    server._safety_sources = {"allsky": None, "aux": None, "openweather": None}
    server._safety_task = None

    # ── sources (minimaliste : allsky fake safe par défaut) ──
    async def is_safe():
        # agrégation AND — une source Unsafe ou muette → Unsafe
        # pour l'instant : si un device AUX weather connecté et non safe → Unsafe
        # sinon allsky absent → Safe (fail-open minimaliste, user active station ensuite)
        reasons = []
        # aux station si présente
        try:
            for dev in server.registry.all_devices().values():
                # heuristique : device type weather / aux
                if getattr(dev, "DEVICE_TYPE", "") in ("weather", "aux") or "weather" in dev.name.lower() or "aag" in dev.name.lower():
                    # si le device expose une prop WEATHER_CLOUD_COVER ou SAFETY
                    # on considère Unsafe si cloud >80 ou rain
                    # fallback : s'il est déconnecté → Unsafe
                    if not dev.connected:
                        return False, f"{dev.name} déconnecté"
        except Exception:
            pass
        return True, ""

    # ── wiring helpers ──
    def is_sequence_running():
        try:
            return bool(server.sequence.status().get("running"))
        except Exception:
            return False

    async def stop_sequence():
        try:
            server.sequence.stop()
        except Exception as e:
            log.warning("safety stop_sequence failed: %s", e)

    def is_parked():
        try:
            m = server.registry.get_mount()
            if not m:
                return False
            # mount park = parked attr ou state
            return bool(getattr(m, "parked", False) or getattr(m, "is_parked", False) or str(m.state_dict().get("parked", "")).lower() in ("true", "parked"))
        except Exception:
            return False

    async def park_mount():
        m = server.registry.get_mount()
        if not m:
            raise RuntimeError("no mount")
        await m.park()

    def is_roof_closed():
        # dome plugin optionnel
        try:
            for dev in server.registry.all_devices().values():
                if getattr(dev, "DEVICE_TYPE", "") == "dome":
                    return bool(getattr(dev, "is_closed", False) or getattr(dev, "closed", False))
        except Exception:
            pass
        return None

    async def close_roof():
        for dev in server.registry.all_devices().values():
            if getattr(dev, "DEVICE_TYPE", "") == "dome":
                await dev.close() if hasattr(dev, "close") else None
                return
        raise RuntimeError("no dome")

    async def alert(reason: str):
        msg = f"Safety Unsafe: {reason}"
        log.error(msg)
        # trigger script générique si configuré
        try:
            server.triggers.fire("error", {"error": msg, "reason": reason})
        except Exception:
            pass

    # ── poll loop ──
    async def safety_loop():
        log.info("safety automaton started (poll %.0fs)", scfg.poll_interval_s)
        while True:
            try:
                await automaton.poll(is_safe=is_safe, is_sequence_running=is_sequence_running,
                                     is_parked=is_parked, is_roof_closed=is_roof_closed)
                if automaton.state == State.UNSAFE_DETECT:
                    log.warning("safety: unsafe detect (%s) → chain Stop→Park→[Close]", automaton.reason)
                    await automaton.run_unsafe_chain(
                        stop_sequence=stop_sequence, is_sequence_running=is_sequence_running,
                        park_mount=park_mount, is_parked=is_parked,
                        close_roof=close_roof if any(getattr(d, "DEVICE_TYPE", "") == "dome" for d in server.registry.all_devices().values()) else None,
                        is_roof_closed=is_roof_closed if any(getattr(d, "DEVICE_TYPE", "") == "dome" for d in server.registry.all_devices().values()) else None,
                        alert=alert, log=log,
                    )
                    log.info("safety: chain done → %s", automaton.state.value)
            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001
                log.error("safety loop error: %s", e, exc_info=True)
            await asyncio.sleep(scfg.poll_interval_s)

    # démarre la tâche
    try:
        loop = asyncio.get_running_loop()
        server._safety_task = loop.create_task(safety_loop(), name="safety-loop")
    except RuntimeError:
        # pas de loop au import (tests) — sera démarré au startup
        async def _on_startup():
            server._safety_task = asyncio.create_task(safety_loop(), name="safety-loop")
        # hook startup via app
        try:
            server.app.add_event_handler("startup", _on_startup)
        except Exception:
            pass

    # ── routes ──
    app = server.app

    @app.get("/api/safety/status")
    async def safety_status():
        return {
            "ok": True,
            "state": automaton.state.value,
            "reason": automaton.reason,
            "config": scfg.__dict__,
            "transitions": automaton.transitions[-20:],
        }

    @app.post("/api/safety/test")
    async def safety_test(body: dict):
        """Déclenche manuellement Unsafe → chaîne (dry-run si dry=true)."""
        reason = body.get("reason", "manual test")
        dry = bool(body.get("dry", False))
        if dry:
            return {"ok": True, "dry": True, "state": automaton.state.value}
        # force UnsafeDetect
        automaton.state = State.UNSAFE_DETECT
        automaton.reason = reason
        # lance la chaîne sans bloquer la requête (background)
        async def _run():
            await automaton.run_unsafe_chain(
                stop_sequence=stop_sequence, is_sequence_running=is_sequence_running,
                park_mount=park_mount, is_parked=is_parked,
                close_roof=None, is_roof_closed=None,
                alert=alert, log=log,
            )
        asyncio.create_task(_run())
        return {"ok": True, "state": automaton.state.value, "reason": reason}

    log.info("safety: routes /api/safety/* registered, automaton monitoring")
