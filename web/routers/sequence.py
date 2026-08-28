"""Acquisition sequence routes."""

import asyncio
import os
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    def _fire(event: str, context: dict | None = None) -> None:
        """Emet un événement vers le Trigger Manager ; jamais bloquant."""
        try:
            server.triggers.fire(event, context or {})
        except Exception as e:  # noqa: BLE001
            log.error(f"trigger fire {event} failed: {e}")

    def _seq_hooks(save_dir: str | None = None):
        """Build the device hooks backing the sequence runner.

        ``save_dir`` optionally overrides the root used by build_path; the
        sequence/capture runner injects a per-session ``capture_TS/`` dir
        while the stacking session injects ``livestack_TS/``.
        """
        import asyncio as _asyncio
        from indigo.devices.sequence import build_path

        async def log(level: str, msg: str):
            import logging as _logging
            _logging.getLogger(__name__).log(
                {"info": _logging.INFO, "warning": _logging.WARNING,
                 "error": _logging.ERROR}.get(level, _logging.INFO), msg)

        # Camera + baseline image for the current pose; lets the save hook
        # distinguish "freshly captured" frames from stale ones.
        seq_cam = {"name": None, "baseline": b""}

        async def expose(duration: float, frame_type: str) -> None:
            cam = server.registry.get_camera()
            if not cam:
                raise RuntimeError("no camera connected")
            if not cam.is_ready:
                raise RuntimeError(f"camera '{cam.name}' not ready")
            seq_cam["name"] = cam.name
            seq_cam["baseline"] = server._camera_images.get(cam.name, b"")
            await cam.expose(duration, frame_type)

        async def wait_exposure() -> None:
            cam = server.registry.get_camera()
            if not cam:
                return
            # Wait for CCD_EXPOSURE Busy phase to end (exposing → False).
            while cam.exposing:
                await _asyncio.sleep(0.1)
            # The BLOB push can lag the Busy→Idle transition (transfer +
            # download) — poll until a fresh image for this camera lands.
            baseline = seq_cam.get("baseline", b"")
            deadline = _asyncio.get_running_loop().time() + 30.0
            while _asyncio.get_running_loop().time() < deadline:
                cur = server._camera_images.get(cam.name, b"")
                if cur and cur != baseline:
                    break
                await _asyncio.sleep(0.1)
            # Give the state write a final beat to land before saving.
            await _asyncio.sleep(0.2)

        async def set_filter(name: str) -> None:
            fw = server.registry.get_filterwheel()
            if not fw:
                return
            await fw.set_slot(name)

        async def save(frame: dict, index: int) -> str:
            base = save_dir if save_dir is not None else server.sequence_cfg.get("save_dir", "")
            path = build_path(base, frame, index)
            name = seq_cam.get("name")
            img = server._camera_images.get(name, server._last_image_data) if name else server._last_image_data
            if not img:
                raise RuntimeError("no image data available — capture first")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(img)
            await log("info", f"sequence frame {index} saved: {path} ({len(img)} bytes)")
            return path

        async def dither() -> dict:
            """Dithering piloté par le guide (pulse de référence + settle).

            Voir ``indigo.devices.guide.apply_dither`` : décale la référence du
            guideur (ses corrections ramènent l'étoile dessus = décalage réel
            de la monture), puis attend que le résidu de guidage retombe sous
            le seuil avant de laisser la pose suivante démarrer. Appelé après
            la sauvegarde de la pose.
            """
            from indigo.devices.guide import apply_dither
            gd = getattr(server, "_guide", None)
            if gd is None:
                return {"ok": True, "skipped": True, "reason": "no guide"}
            cfg = server.sequence_cfg.get("dither", {}) or {}
            res = await apply_dither(gd, cfg, log=log)
            if res.get("guided"):
                _fire("dither_done", res)
            return res

        async def stack(path: str, frame: dict) -> None:
            """Push a freshly saved LIGHT frame into the live stack."""
            enabled = server.sequence_cfg.get("stack", {}).get("enabled", False)
            if not enabled:
                return
            try:
                img_bytes = await _asyncio.to_thread(Path(path).read_bytes)
            except Exception:
                img_bytes = server._camera_images.get(seq_cam.get("name"), server._last_image_data)
            if not img_bytes:
                raise RuntimeError("no image data to stack")
            res = await _asyncio.to_thread(server.stacking.push_fits, img_bytes)
            await log("debug", f"stacking push: ok={res.get('ok')} "
                               f"accepted={res.get('accepted')} "
                               f"error={res.get('error', '')} reason={res.get('reason', '')}")
            # Push a fresh preview to WebSocket clients
            loop = _asyncio.get_running_loop()
            loop.create_task(server._broadcast_stacking_snapshot(path))
            # Live status push (accepted/rejected/complete) — remplace le polling
            server._broadcast_stacking_status()

        async def delay(seconds: float) -> None:
            if seconds and seconds > 0:
                await _asyncio.sleep(seconds)

        async def on_progress() -> None:
            server._broadcast_sequence_status()
            st = server.sequence.status()
            cur = st.get("current") or {}
            _fire("frame_done", {
                "done": st.get("done", 0),
                "total": st.get("total", 0),
                "frame_type": cur.get("frame_type", "LIGHT"),
                "filter": cur.get("filter", ""),
                "duration": cur.get("duration", 0),
                "saved_path": st.get("last_saved", ""),
                "last_dither": st.get("last_dither"),
            })

        async def on_frame_start(frame: dict, index: int) -> None:
            _fire("frame_start", {
                "index": index, "done": server.sequence.status().get("done", 0),
                "total": server.sequence.status().get("total", 0),
                "frame_type": frame.get("frame_type", "LIGHT"),
                "filter": frame.get("filter", ""),
                "duration": frame.get("duration", 0),
            })

        async def on_error(error: str, frame: dict) -> None:
            _fire("error", {
                "error": error,
                "frame_type": frame.get("frame_type", "LIGHT"),
                "filter": frame.get("filter", ""),
            })

        async def on_end(done: int, total: int, complete: bool) -> None:
            if complete:
                _fire("series_done", {"done": done, "total": total})
            else:
                st = server.sequence.status()
                _fire("stop", {"done": done, "total": total,
                               "error": st.get("last_error") or ""})

        async def before_frame(frame: dict) -> dict | None:
            """Trigger an automatic meridian flip between poses when due.

            Only considered for LIGHT frames and only when flip automation is
            enabled in the telescope config.  Uses the same flip logic as the
            manual ``/api/mount/flip`` route.
            """
            if frame.get("frame_type", "LIGHT").upper() != "LIGHT":
                return None
            if not server.telescope.get("flip_enabled", False):
                return None
            m = server.registry.get_mount()
            if not m or not m.connected:
                return None
            try:
                status = server._mount_flip_status(m.state_dict())
                flip = status.get("flip", {})
                due = flip.get("flip_due", False)
                ha = flip.get("ha_hours")
            except Exception as e:  # noqa: BLE001
                await log("warning", f"flip check skipped: {e}")
                return None

            # Re-arm when the object is back east of the meridian (HA < 0),
            # so the flip fires once per west-of-meridian pass.
            if ha is not None and ha < 0 and server._meridian_flipped:
                server._meridian_flipped = False

            # Do not re-flip if we already flipped for this pass.
            if not due or server._meridian_flipped:
                return None
            await log("warning", "Méridien passé — flip automatique avant pose")
            return await server._do_meridian_flip()

        return {
            "expose": expose, "wait_exposure": wait_exposure,
            "set_filter": set_filter, "save": save,
            "stack": stack,
            "dither": dither, "delay": delay, "log": log,
            "on_progress": on_progress,
            "on_frame_start": on_frame_start,
            "on_error": on_error,
            "on_end": on_end,
            "before_frame": before_frame,
        }

    @app.get("/api/sequence/status")
    async def sequence_status():
        return SanitizedJSONResponse(server.sequence.status())

    @app.get("/api/sequence/defaults")
    async def sequence_defaults():
        return SanitizedJSONResponse({
            "frames": server.sequence_cfg.get("frames", [
                {"duration": 60.0, "frame_type": "LIGHT", "filter": "", "count": 1, "delay": 1.0},
            ]),
            "save_dir": server.sequence_cfg.get("save_dir", ""),
            "dither": server.sequence_cfg.get("dither", {
                "enabled": False, "amount": 2.0, "settle_rms": 1.0,
                "settle_timeout": 20.0, "settle_stable": 3}),
            "stack": server.sequence_cfg.get("stack", {"enabled": False}),
        })

    @app.post("/api/sequence/start")
    async def sequence_start(body: dict):
        from indigo.devices.sequence import validate_frames
        if body.get("frames") is not None:
            frames = body["frames"]
            err = validate_frames(frames)
        else:
            frames = server.sequence_cfg.get("frames")
            err = None
        if not frames:
            return {"error": "no frames"}
        if err:
            return {"ok": False, "error": err}
        if body.get("save_dir"):
            server.sequence_cfg["save_dir"] = body["save_dir"]
        if body.get("dither") is not None:
            cur = server.sequence_cfg.get("dither", {}) or {}
            merged = {**cur, **body["dither"]}
            server.sequence_cfg["dither"] = merged
        if body.get("stack") is not None:
            cur = server.sequence_cfg.get("stack", {}) or {}
            merged = {**cur, **body["stack"]}
            server.sequence_cfg["stack"] = merged
            if body["stack"].get("enabled"):
                server.stacking.reset()
        # Each run gets its own typed, timestamped directory under the root:
        #   <root>/capture_YYYYMMDD_HHMMSS/
        root_dir = os.path.expanduser(server.sequence_cfg.get("save_dir", ""))
        session_dir = os.path.join(root_dir, f"capture_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
        os.makedirs(session_dir, exist_ok=True)
        server.sequence_cfg["session_dir"] = session_dir
        try:
            server.sequence.start(frames)
        except (RuntimeError, ValueError) as e:
            return {"ok": False, "error": str(e)}
        task = asyncio.create_task(server.sequence.run(_seq_hooks(save_dir=session_dir)))
        server.sequence._task = task
        task.add_done_callback(lambda _t: server._broadcast_sequence_status())
        server._broadcast_sequence_status()
        _fire("sequence_start", {
            "frames": len(frames),
            "total": server.sequence.status().get("total", 0),
            "session_dir": session_dir,
        })
        return {"ok": True, "session_dir": session_dir, "status": server.sequence.status()}

    @app.post("/api/sequence/stop")
    async def sequence_stop():
        st = SanitizedJSONResponse(server.sequence.stop())
        server._broadcast_sequence_status()
        return st

    @app.post("/api/sequence/pause")
    async def sequence_pause():
        st = SanitizedJSONResponse(server.sequence.pause())
        server._broadcast_sequence_status()
        return st

    @app.post("/api/sequence/resume")
    async def sequence_resume():
        st = SanitizedJSONResponse(server.sequence.resume())
        server._broadcast_sequence_status()
        return st

    @app.post("/api/sequence/reset")
    async def sequence_reset():
        st = SanitizedJSONResponse(server.sequence.reset())
        server._broadcast_sequence_status()
        return st
