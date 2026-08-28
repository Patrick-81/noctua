"""
triggers.py — Trigger Manager (Lot A2).

Hooks d'événements de séquence → actions configurables :
``log`` (ligne de journal), ``script`` (commande shell avec timeout), et
``mount_goto`` (pointage de la monture, socle pour les futurs Lots B).

Config (config.yaml, section ``sequence.triggers``) ::

    triggers:
      - name: alerte-fin-serie
        event: series_done
        actions:
          - type: log
            level: info
            message: "Série terminée : {done}/{total} poses"

Événements émis : ``sequence_start``, ``frame_start``, ``frame_done``,
``dither_done``, ``error``, ``series_done``, ``stop``.

Les actions s'exécutent de façon **non bloquante** (task asyncio dédiée) et
une action en échec ne remonte jamais vers la séquence.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Any

log = logging.getLogger("indigo.triggers")

# Événements reconnus
SEQUENCE_START = "sequence_start"
FRAME_START = "frame_start"
FRAME_DONE = "frame_done"
DITHER_DONE = "dither_done"
ERROR = "error"
SERIES_DONE = "series_done"
STOP = "stop"

VALID_EVENTS = {
    SEQUENCE_START, FRAME_START, FRAME_DONE, DITHER_DONE,
    ERROR, SERIES_DONE, STOP,
}


class _SafeDict(dict):
    """Dict qui rend '' pour les clés manquantes lors d'un format_map."""

    def __missing__(self, key):  # noqa: D105
        return ""


def _fmt(text: str, mapping: dict) -> str:
    if not text or "{" not in text or "}" not in text:
        return text or ""
    try:
        return str(text).format_map(_SafeDict(mapping))
    except (ValueError, KeyError, IndexError):
        return str(text)


def _match_conditions(conditions: dict | None, ctx: dict) -> bool:
    if not conditions:
        return True
    for key, expected in conditions.items():
        actual = ctx.get(key)
        if actual is None:
            return False
        if isinstance(expected, list):
            if actual not in expected:
                return False
        elif str(actual) != str(expected):
            return False
    return True


class TriggerManager:
    """Vérifie les triggers sur chaque événement et lance leurs actions."""

    def __init__(self, config: list[dict] | None = None) -> None:
        self._triggers = [dict(t) for t in (config or []) if isinstance(t, dict)]
        self._devices: dict[str, Any] = {}
        self._last: dict[str, dict] = {}      # nom → dernier résultat par trigger
        self._enabled = True

    # ── Configuration ───────────────────────────────────────

    def bind(self, devices: dict[str, Any]) -> None:
        """Fournit les accès aux équipements (p.ex. {"mount": lambda: mount})."""
        self._devices.update(devices)

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = bool(enabled)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def status(self) -> dict:
        return {
            "enabled": self._enabled,
            "events": sorted(VALID_EVENTS),
            "triggers": self._triggers,
            "last": self._last,
        }

    # ── Émission des événements ─────────────────────────────

    def fire(self, event: str, context: dict | None = None) -> list[str]:
        """Emet l'événement ; lance chaque trigger matcheur en tâche de fond.

        Non bloquant : la séquence n'attend jamais les actions. Retourne la
        liste des triggers déclenchés.
        """
        if not self._enabled or event not in VALID_EVENTS:
            return []
        fired = self._matching(event, context or {})
        for name in fired:
            asyncio.get_running_loop().create_task(
                self._run_trigger(event, context or {}, name))
        return fired

    async def trigger_now(self, event: str, context: dict | None = None,
                          name: str | None = None) -> list[dict]:
        """Variante bloquante (tests / endpoint de debug) : retourne les
        résultats des actions de chaque trigger déclenché."""
        if not self._enabled or event not in VALID_EVENTS:
            return []
        ctx = context or {}
        names = self._matching(event, ctx, only_name=name)
        results = []
        for n in names:
            results.append({
                "name": n, "event": event,
                "results": await self._run_trigger(event, ctx, n),
            })
        return results

    def _matching(self, event: str, ctx: dict, only_name: str | None = None) -> list[str]:
        names = []
        for t in self._triggers:
            if only_name and t.get("name") != only_name:
                continue
            if t.get("event") == event and _match_conditions(t.get("conditions"), ctx):
                names.append(t.get("name", "trigger"))
        return names

    # ── Exécution ───────────────────────────────────────────

    async def _run_trigger(self, event: str, ctx: dict, name: str) -> list[dict]:
        trigger = next((t for t in self._triggers if t.get("name") == name), None)
        if trigger is None:
            return []
        results = []
        for action in trigger.get("actions", []) or []:
            try:
                res = await self._run_action(action, ctx)
            except Exception as e:  # noqa: BLE001  (une action ne tue jamais un trigger)
                res = {"type": action.get("type", "?"), "ok": False,
                       "error": f"{type(e).__name__}: {e}"}
            results.append(res)
        self._last[name] = {
            "event": event,
            "fired_at": datetime.now().isoformat(timespec="seconds"),
            "results": results,
        }
        ok = all(r.get("ok") for r in results)
        if not ok:
            log.warning("trigger '%s' (%s) : actions en échec %r", name, event, results)
        return results

    async def _run_action(self, action: dict, ctx: dict) -> dict:
        atype = action.get("type", "log")
        if atype == "log":
            return self._action_log(action, ctx)
        if atype == "script":
            return await self._action_script(action, ctx)
        if atype == "mount_goto":
            return await self._action_mount_goto(action, ctx)
        return {"type": atype, "ok": False, "error": f"action inconnue '{atype}'"}

    def _action_log(self, action: dict, ctx: dict) -> dict:
        message = _fmt(action.get("message", "trigger {event}"), ctx)
        level = action.get("level", "info")
        level_num = {
            "info": logging.INFO, "warning": logging.WARNING,
            "error": logging.ERROR, "debug": logging.DEBUG,
        }.get(level, logging.INFO)
        log.log(level_num, "%s", message)
        return {"type": "log", "ok": True, "message": message, "level": level}

    async def _action_script(self, action: dict, ctx: dict) -> dict:
        import subprocess

        command = _fmt(action.get("command", ""), ctx)
        if not command:
            return {"type": "script", "ok": False, "error": "commande vide"}
        timeout = max(0.1, float(action.get("timeout", 30)))
        extra = {}
        for k, v in ctx.items():
            if k.isidentifier() and (isinstance(v, (str, int, float))):
                extra[f"NOCTUA_{k.upper()}"] = str(v)
        env = {**os.environ, **extra}
        proc = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            try:
                await proc.wait()
            except (ProcessLookupError, ChildProcessError):
                pass
            return {"type": "script", "ok": False,
                    "error": f"script dépassé ({timeout}s)", "command": command}
        output = (out or b"").decode("utf-8", "replace").strip()
        ok = proc.returncode == 0
        if output:
            (log.info if ok else log.warning)(
                "trigger script: rc=%s %s", proc.returncode, output[:400])
        return {"type": "script", "ok": ok, "rc": proc.returncode,
                "output": output[:400], "command": command}

    async def _action_mount_goto(self, action: dict, ctx: dict) -> dict:
        provider = self._devices.get("mount")
        if not callable(provider):
            return {"type": "mount_goto", "ok": False,
                    "error": "aucune monture fournie (bind mount)"}
        mount = provider()
        if not mount or not getattr(mount, "connected", False):
            return {"type": "mount_goto", "ok": False, "error": "monture non connectée"}

        ra = _fmt(str(action.get("ra", "")), ctx) if action.get("ra") is not None else ""
        dec = _fmt(str(action.get("dec", "")), ctx) if action.get("dec") is not None else ""
        try:
            if ra in ("", "now", "current"):
                ra_h = float(getattr(mount, "ra_hours", 0.0))
            else:
                ra_h = float(ra)
            dec_d = float(dec) if dec else float(getattr(mount, "dec_deg", 0.0))
        except (ValueError, TypeError):
            return {"type": "mount_goto", "ok": False,
                    "error": f"coord. invalides ra={ra!r} dec={dec!r}"}

        await mount.slew_to(ra_h, dec_d)
        return {"type": "mount_goto", "ok": True, "ra": ra_h, "dec": dec_d}