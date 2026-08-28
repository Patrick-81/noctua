"""
sequence.py — Sequence acquisition engine.

Runs a plan of capture targets (LIGHT/DARK/BIAS/FLAT frames) one at a time:
for each repetition → set filter → expose → wait for the exposure to finish
(CCD_EXPOSURE ``Busy`` → ``Ok`` via a poll callback) → save the FITS frame →
optionally dither (via the guide's reference offset) → next frame.

Pure-async design: the runner is a background task; the UI is never blocked and
receives progress through ``status()`` (optionally pushed over WS).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime
from typing import Any, Awaitable, Callable

DEFAULT_FRAMES = [
    {"duration": 60.0, "frame_type": "LIGHT", "filter": "", "count": 1, "delay": 1.0},
]

# Callbacks injected by the WebServer so this module stays device-agnostic.
FrameCallback = dict[str, Callable[..., Awaitable[Any]]]


class SequenceRunner:
    def __init__(self) -> None:
        self._running = False
        self._paused = False
        self._stop_requested = False
        self._task: asyncio.Task | None = None
        self._reset_state()

    def _reset_state(self) -> None:
        self._plan_index = 0
        self._frame_index = 0
        self._done = 0
        self._resume_from = 0
        self._total = 0
        self._current: dict | None = None
        self._last_error: str | None = None
        self._last_saved: str | None = None
        self._last_dither: dict | None = None
        self._save_saved: str | None = None

    # ── Public control ─────────────────────────────────────────

    def start(self, frames: list[dict], resume_from: int = 0) -> None:
        """Validate + start a run. Returns immediately; the loop is async.

        ``resume_from`` (Lot C2) skips the first N poses already saved in a
        previous session: ``done`` starts at N and file indexes continue at
        N+1 instead of overwriting.
        """
        if self._running:
            raise RuntimeError("Sequence is already running")
        if not frames:
            raise ValueError("Sequence plan is empty")
        self._frames = [dict(f) for f in frames]
        self._reset_state()
        self._resume_from = max(0, int(resume_from or 0))
        self._done = self._resume_from
        self._total = _plan_total(self._frames)
        self._running = True
        self._paused = False
        self._stop_requested = False

    async def run(self, hooks: dict[str, Callable[..., Awaitable[Any]]] | None = None):
        """Execute the plan. ``hooks`` provides the device interactions:
          - ``expose(duration, frame_type, filter)``
          - ``wait_exposure()``         → await until current pose finishes
          - ``save(frame, index)``      → save to disk, return path
          - ``stack(path, frame)``      → optional live-stacking hook (nullable)
          - ``dither()``                → optional, nullable
          - ``delay(seconds)``          → sleep between frames
          - ``log(level, msg)``         → emit a server-side log line
          - ``on_progress()``           → called after each completed frame
          - ``on_frame_start(frame, index)`` → before each exposure
          - ``on_error(error, frame)``  → called when a frame fails
          - ``on_end(done, total, complete)`` → once, when the run terminates
        """
        h = hooks or {}
        self._running = True
        try:
            pose = 0  # numéro global de pose dans le plan (reprise : on saute les ≤ resume_from)
            for fi, frame in enumerate(self._frames):
                if self._stop_requested:
                    break
                self._current = frame
                self._frame_index = fi
                for k in range(int(frame.get("count", 1))):
                    pose += 1
                    if pose <= self._resume_from:
                        continue  # déjà sauvegardée dans une session précédente
                    if self._stop_requested:
                        break
                    while self._paused and not self._stop_requested:
                        await asyncio.sleep(0.2)
                    try:
                        await self._run_one(h, frame, k)
                    except Exception as e:  # noqa: BLE001
                        self._last_error = str(e)
                        ld = h.get("log")
                        if ld:
                            await ld("error", f"sequence frame failed: {e}")
                        oe = h.get("on_error")
                        if oe:
                            await oe(str(e), self._current or frame)
                        if self._stop_requested:
                            break
                        raise
                    self._done += 1
                    op = h.get("on_progress")
                    if op:
                        await op()
                    dt = h.get("delay")
                    if dt:
                        await dt(float(frame.get("delay", 0.0)))
                self._current = None
        finally:
            complete = (not self._stop_requested and self._last_error is None
                        and self._total > 0 and self._done >= self._total)
            oe = h.get("on_end")
            if oe:
                await oe(self._done, self._total, complete)
            self._running = False
            self._paused = False
            self._task = None

    async def _run_one(self, h: FrameCallback, frame: dict, k: int) -> None:
        fl = h.get("log")
        if fl:
            await fl("info", f"frame {self._done + 1}/{self._total}: "
                            f"{frame.get('frame_type','LIGHT')} "
                            f"{frame.get('duration',0)}s "
                            f"filtre={frame.get('filter','') or '—'} "
                            f"(pose {k + 1}/{frame.get('count',1)})")

        # Optional per-frame hook (e.g. automatic meridian flip / refocus between
        # poses). Runs before exposure so the maintenance happens when no frame
        # is exposing. Returns {'flipped': …} and/or {'refocused': …}.
        bf = h.get("before_frame")
        if bf:
            act = await bf(frame)
            if act is not None and (act.get("flipped") or act.get("refocused")):
                if fl:
                    what = ("flip méridien" if act.get("flipped")
                            else "refocus automatique")
                    detail = act.get("detail") or act.get("phases") or ""
                    await fl("info", f"{what} effectué avant pose ({detail})")

        ofs = h.get("on_frame_start")
        if ofs:
            await ofs(frame, self._done + 1)

        sf = h.get("set_filter")
        if sf and frame.get("filter"):
            await sf(frame["filter"])

        ex = h.get("expose")
        if ex:
            await ex(float(frame.get("duration", 1.0)), frame.get("frame_type", "LIGHT"))

        we = h.get("wait_exposure")
        if we:
            await we()

        sv = h.get("save")
        if sv:
            path = await sv(frame, self._done + 1)
            self._save_saved = path
            if fl:
                await fl("info", f"sauvé → {path}")

            # Optional persistence of the run progress (Lot C2, journal).
            jl = h.get("journal")
            if jl:
                try:
                    await jl(path, frame, self._done + 1)
                except Exception as e:  # noqa: BLE001
                    if fl:
                        await fl("warning", f"journal non écrit : {e}")

            # Optional live stacking of the freshly saved frame
            st = h.get("stack")
            if st and frame.get("frame_type", "LIGHT") in ("LIGHT",):
                try:
                    await st(path, frame)
                except Exception as e:  # noqa: BLE001
                    if fl:
                        await fl("warning", f"stacking skipped: {e}")

        di = h.get("dither")
        if di:
            self._last_dither = await di()

    # ── Pause / resume / stop / status ──────────────────────────

    def pause(self) -> dict:
        if self._running and not self._paused:
            self._paused = True
        return self.status()

    def resume(self) -> dict:
        if self._paused:
            self._paused = False
        return self.status()

    def stop(self) -> dict:
        self._stop_requested = True
        self._paused = False
        return self.status()

    def reset(self) -> dict:
        self._stop_requested = False
        self._running = False
        self._paused = False
        self._task = None
        self._reset_state()
        return self.status()

    def status(self) -> dict:
        return {
            "running": self._running,
            "paused": self._paused,
            "frame_index": self._frame_index,
            "done": self._done,
            "total": self._total,
            "current": self._current,
            "last_error": self._last_error,
            "last_saved": getattr(self, "_save_saved", None),
            "last_dither": self._last_dither,
            "progress": (self._done / self._total) if self._total else 0.0,
        }


def _plan_total(frames: list[dict]) -> int:
    return sum(int(f.get("count", 1)) for f in frames)


def total_frames(frames: list[dict]) -> int:
    """Exposed total; matches the sum of each frame's count."""
    return _plan_total(frames)


# ── Frame/plan helpers (pure, testable) ────────────────────────

def validate_frames(frames: list[dict]) -> str | None:
    """Return an error string if the plan is invalid, else None."""
    if not frames:
        return "Panne vide — ajoutez au moins une pose"
    for i, f in enumerate(frames):
        if "duration" not in f or float(f.get("duration", 0)) <= 0:
            return f"frame {i}: durée invalide"
        c = int(f.get("count", 1))
        if c < 1:
            return f"frame {i}: count invalide"
    return None


def build_path(save_dir: str, frame: dict, index: int) -> str:
    """Build a FITS filename grouped by frame type (lights/, darks/, flats/, biases/)."""
    safe_dir = os.path.expanduser(save_dir or "")
    frame_type = (frame.get("frame_type") or "LIGHT").lower()
    frametype_dir = {
        "light": "lights", "dark": "darks",
        "flat": "flats", "bias": "biases",
    }.get(frame_type, f"{frame_type}s")
    filt = frame.get("filter") or ""
    name_parts = [frame_type]
    if filt:
        name_parts.append(filt)
    name_parts.append(f"{index:03d}")
    name_parts.append(datetime.now().strftime("%Y%m%d_%H%M%S"))
    subdir = os.path.join(safe_dir, frametype_dir)
    return os.path.join(subdir, "_".join(name_parts) + ".fits")


# ── Session planning (Lot C2): cible/date layout + journal ────

def slugify(name: str) -> str:
    """Normalize a target name into a filesystem-safe slug."""
    name = (name or "").strip()
    if not name:
        return ""
    out = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    return out or "cible"


def build_session_dir(root_dir: str, target: str = "", now: datetime | None = None) -> str:
    """Session output directory (strictly below ``root_dir``).

    With a target:  ``<root>/<target_slug>/<YYYY-MM-DD>/<HHMMSS>``
    otherwise:      ``<root>/capture_<YYYYMMDD_HHMMSS>`` (legacy).

    Frame-type group dirs (``lights/``, …) live directly inside it and the
    run state is persisted in ``journal.json`` beside them.
    """
    now = now or datetime.now()
    base = os.path.expanduser(root_dir or "")
    if target:
        return os.path.join(base, slugify(target), now.strftime("%Y-%m-%d"),
                            now.strftime("%H%M%S"))
    return os.path.join(base, f"capture_{now.strftime('%Y%m%d_%H%M%S')}")


def journal_path(session_dir: str) -> str:
    return os.path.join(session_dir, "journal.json")


def save_journal(
    session_dir: str,
    *,
    frames: list[dict],
    done: int,
    total: int,
    last_saved: str | None = None,
    current: dict | None = None,
    frame_index: int | None = None,
    running: bool = False,
    complete: bool | None = None,
    target: str = "",
    **extra,
) -> str:
    """Persist run state to ``<session_dir>/journal.json``.

    ``created_at`` is preserved across rewrites so a resumed session keeps
    its original provenance.  Returns the journal path.
    """
    path = journal_path(session_dir)
    data = {
        "session_dir": session_dir,
        "target": target,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "frames": frames,
        "done": int(done),
        "total": int(total),
        "last_saved": last_saved,
        "current": current,
        "frame_index": frame_index,
        "running": bool(running),
        "complete": complete,
    }
    prev = load_journal(session_dir)
    if prev and prev.get("created_at"):
        data["created_at"] = prev["created_at"]
    if extra:
        data.update(extra)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)  # atomic-ish: journal never ends up half-written
    return path


def load_journal(session_dir: str) -> dict | None:
    """Return the session journal (None if missing or unreadable)."""
    try:
        with open(journal_path(session_dir), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None