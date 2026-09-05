"""
guide_loop.py — Boucle d'autoguidage côté serveur.

Réplique exacte de l'ancienne boucle frontend (``web/static/guide.js``
``_guideLoop``) : expose → attend l'image fraîche → mesure le centroïde
→ ``Guide.step_result`` → impulsions monture RA/DEC en parallèle →
télémétrie. Mêmes timings (marge +0,5 s, pause inter-frame 0,2 s),
mêmes formules (tout le calcul vit dans :class:`Guide`).

La session est pilotée par :class:`Guide` (états GUIDING / PAUSED /
STOPPED…) et ne fait que l'orchestration ; les accès matériels passent
par des hooks injectés ``hooks`` pour rester testable sans INDIGO :

- ``capture_frame(duration, timeout)`` → ``bytes | None`` : expose et
  attend une image fraîche (``None`` si timeout).
- ``measure(img)`` → ``dict | None`` : ``{"x", "y", "snr", "width",
  "height"}`` du meilleur centroïde, ``None`` si pas d'étoile.
- ``pulse(direction, ms)`` : impulsion monture (``EAST/WEST/NORTH/
  SOUTH``), move + sleep + halt.
- ``set_rate(rate)`` : vitesse de slew (``"Guide"``), une fois au départ.
- ``broadcast(payload)`` : pousse le statut vers le frontend (WS).
- ``log(level, msg)`` : journal (appelable sync ou async).
- ``sleep(seconds)`` : attente annulable (``asyncio.sleep``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from .guide import Guide, GuideState

log = logging.getLogger("indigo.guide_loop")

#: Traduction direction logique (Guide) → direction monture (INDIGO).
RA_DIRECTION_MAP = {"E": "EAST", "W": "WEST"}
DEC_DIRECTION_MAP = {"N": "NORTH", "S": "SOUTH"}

#: Pause inter-frame (s) — parité avec le ``setTimeout(200)`` frontend.
FRAME_GAP_SEC = 0.2

#: Attente entre deux tentatives quand la capture échoue (s).
RETRY_DELAY_SEC = 2.0

#: Poll d'attente en pause (s).
PAUSE_POLL_SEC = 0.5

#: Timeout d'attente d'image fraîche (s) — parité séquences.
FRESH_IMAGE_TIMEOUT_SEC = 30.0

#: Frames sans étoile avant un rappel log (la boucle continue).
STARLESS_LOG_EVERY = 5


def map_pulses(step: dict) -> list[tuple[str, int]]:
    """Traduit un statut ``step_result`` en impulsions monture.

    Retourne ``[(direction, ms), …]`` (``[]`` si rien à corriger).
    Pure — testable sans matériel.
    """
    pulses: list[tuple[str, int]] = []
    ra_ms = int(step.get("ra_pulse_ms", 0) or 0)
    ra_dir = step.get("ra_direction", "")
    if ra_ms > 0 and ra_dir in RA_DIRECTION_MAP:
        pulses.append((RA_DIRECTION_MAP[ra_dir], ra_ms))
    dec_ms = int(step.get("dec_pulse_ms", 0) or 0)
    dec_dir = step.get("dec_direction", "")
    if dec_ms > 0 and dec_dir in DEC_DIRECTION_MAP:
        pulses.append((DEC_DIRECTION_MAP[dec_dir], dec_ms))
    return pulses


class GuideLoopSession:
    """Une session de guidage : boucle expose → mesure → corrige.

    :param guide: l'état partagé :class:`Guide` (référence, drift, gains).
    :param camera_name: nom de la caméra guide (informatif / logs).
    :param hooks: dict des accès matériels (voir doc module).
    """

    def __init__(
        self,
        guide: Guide,
        camera_name: str,
        hooks: dict[str, Callable[..., Any]],
    ) -> None:
        self.guide = guide
        self.camera_name = camera_name
        self.hooks = hooks
        self.starless_streak = 0

    async def _log(self, level: str, msg: str) -> None:
        fn = self.hooks.get("log")
        if fn is None:
            (log.warning if level in ("warning", "error") else log.info)(msg)
            return
        res = fn(level, msg)
        if isinstance(res, Awaitable):
            await res

    async def run(self) -> None:
        """Boucle principale — se termine quand l'état quitte GUIDING/PAUSED."""
        h = self.hooks
        sleep: Callable[[float], Awaitable[None]] = h.get("sleep", asyncio.sleep)
        try:
            await h["set_rate"]("Guide")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            await self._log("warning", f"guide : vitesse Guide non appliquée ({e})")
        try:
            while True:
                state = self.guide.state
                if state == GuideState.PAUSED:
                    await sleep(PAUSE_POLL_SEC)
                    continue
                if state != GuideState.GUIDING:
                    break
                try:
                    await self._one_frame()
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    # Jamais de mort sur erreur transitoire (parité frontend
                    # qui ignorait les frames en échec).
                    await self._log("warning", f"guide : frame ignorée ({e})")
                    await sleep(RETRY_DELAY_SEC)
        except asyncio.CancelledError:
            raise
        finally:
            try:
                h["broadcast"](self.guide.status())
            except Exception:  # noqa: BLE001
                pass

    async def _one_frame(self) -> None:
        """Une itération : expose → mesure → corrige → télémétrie."""
        h = self.hooks
        sleep: Callable[[float], Awaitable[None]] = h.get("sleep", asyncio.sleep)
        guide = self.guide

        img = await h["capture_frame"](guide.exposure_sec, FRESH_IMAGE_TIMEOUT_SEC)
        if not img:
            await self._on_starless("pas d'image fraîche")
            return

        metric = await h["measure"](img)
        if not metric:
            await self._on_starless("aucune étoile mesurée")
            return
        self.starless_streak = 0

        x, y, snr = metric["x"], metric["y"], metric.get("snr")
        step = guide.step_result(float(x), float(y), snr)

        pulses = map_pulses(step)
        if pulses:
            results = await asyncio.gather(
                *(h["pulse"](direction, ms) for direction, ms in pulses),
                return_exceptions=True,
            )
            for (direction, ms), res in zip(pulses, results):
                if isinstance(res, Exception):
                    await self._log(
                        "warning",
                        f"guide : impulsion {direction} {ms}ms non appliquée ({res})",
                    )

        payload = dict(step)
        payload["camera"] = self.camera_name
        payload["centroid"] = {
            "x": round(float(x), 1),
            "y": round(float(y), 1),
            "w": metric.get("width"),
            "h": metric.get("height"),
        }
        h["broadcast"](payload)
        await sleep(FRAME_GAP_SEC)

    async def _on_starless(self, reason: str) -> None:
        """Frame sans mesure : compteur + rappel périodique + télémétrie."""
        self.starless_streak += 1
        if self.starless_streak % STARLESS_LOG_EVERY == 1:
            await self._log(
                "warning",
                f"guide : {reason} ({self.starless_streak} frames) — étoile perdue ?",
            )
        try:
            self.hooks["broadcast"](self.guide.status())
        except Exception:  # noqa: BLE001
            pass
