"""
server.py — FastAPI web server for INDIGO devices.

Provides:
  - Application wiring: device registry, solver, sequence, stacking engines
  - WebSocket broadcasting helpers (state, images, logs, stacking, sequence)
  - Static file serving

REST routes live in web/routers/*.py — each module exposes ``register(app, server)``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .weblog import handler as weblog_handler

if TYPE_CHECKING:
    from ..registry import DeviceRegistry

from indigo.profiles import ProfileStore

from .routers.common import _mount_flip_status, _sanitize

log = logging.getLogger("indigo.web")

STATIC_DIR = Path(__file__).parent / "static"
SKYMAP_SRC_DIR = (Path(__file__).parent.parent / "packages" / "skymap" / "src").resolve()


class WebServer:
    def __init__(self, registry: DeviceRegistry, site_config: dict | None = None,
                 config_path: Path | None = None, ui_path: Path | None = None,
                 profiles_path: Path | None = None, telescope_config: dict | None = None,
                 sequence_config: dict | None = None, exposure_config: dict | None = None,
                 templates_path: Path | None = None, masters_config: dict | None = None,
                 blob_mode: str = "Also", prefer_raw16: bool = True):
        self.registry = registry
        # Mode de livraison BLOB : Also (inline base64, compatible INDI+INDIGO,
        # défaut sûr) ou URL (INDIGO v2, le serveur garde l'image, le client
        # la télécharge en HTTP — comme le panneau indigo_server).
        _bm = (blob_mode or "Also").upper()
        self.blob_mode = _bm if _bm in ("ALSO", "URL") else "ALSO"
        # RAW 16 bits préféré au RAW 8 bits quand la caméra le propose
        # (X_PIXEL_FORMAT) — opt-out via indigo.prefer_raw16: false.
        self.prefer_raw16 = bool(prefer_raw16)
        self.site = site_config or {}
        self.telescope = dict(telescope_config or {})
        self.sequence_cfg = dict(sequence_config or {})
        self.exposure_cfg = dict(exposure_config or {})
        # Defaults for meridian flip
        self.telescope.setdefault("flip_enabled", False)
        self.telescope.setdefault("hour_angle_margin", 0.2)
        self.telescope.setdefault("min_altitude", 0.0)
        self.telescope.setdefault("flip_slew_rate", "Centering")
        self.telescope.setdefault("recenter_after_flip", True)
        # State: whether the automatic flip has already fired for the current
        # west-of-meridian pass (avoids re-flipping on every frame post-meridian).
        # Re-armed once the mount goes back east of the meridian.
        self._meridian_flipped = False
        self.config_path = config_path
        self.ui_path = ui_path
        self.profiles = ProfileStore(profiles_path)
        # Sequence templates (Lot C3) : défaut = à côté du fichier de config.
        from indigo.devices.templates import SequenceTemplateStore
        if templates_path is None:
            templates_path = (config_path.parent / "sequence_templates.yaml"
                              if config_path else None)
        self.template_store = SequenceTemplateStore(templates_path)
        # Master calibration library (Lot C1) : racine par défaut = save_dir
        from indigo.devices.masters import MasterLibrary
        self.masters_cfg = dict(masters_config or {})
        masters_root = self.masters_cfg.get("dir") or self.sequence_cfg.get("save_dir", "")
        self.masters = MasterLibrary(masters_root)
        self.app = FastAPI(title="INDIGO Devices")
        self.app.add_middleware(BaseHTTPMiddleware, dispatch=self._no_cache_middleware)
        self._ws_clients: list[WebSocket] = []
        self._last_image_data: bytes = b""
        self._last_image_device: str = ""
        self._camera_images: dict[str, bytes] = {}  # device_name → last image bytes
        self._last_thumb: bytes | None = None
        self._last_thumb_device: str = ""
        # Variant d'aperçu demandé par l'UI (vignette|pleine|both|None) —
        # positionné par /api/camera/expose {preview}, lu par _on_camera_image
        # pour ne fabriquer que le JPEG utile.
        self._preview_variant: str | None = None
        # Tâche de fond de la pleine résolution en cours (annulée si une
        # image plus récente arrive — seul le dernier aperçu compte).
        self._pleine_task: asyncio.Task | None = None
        # Unifie les 2 listes WS (server + weblog) pour éviter la divergence qui causait ws=0
        # côté image alors que les logs passaient encore.
        self._ws_clients = weblog_handler._clients  # alias partagé
        # Duration of the last test exposure used by /api/camera/exposure/estimate
        # (so GET /recommend can extrapolate without re-taking a frame).
        self._last_exposure_test_s: float = 0.0
        # Frames (duration, fits) of the last exposure-measure pass,
        # kept so GET /recommend can re-run the multi-shot fit when applicable.
        self._last_exposure_frames: list[tuple[float, bytes]] = []

        # Plate solver (lazy import to avoid circular dependency)
        from indigo.devices.solver import Solver
        self.solver = Solver()

        from indigo.devices.sequence import SequenceRunner
        self.sequence = SequenceRunner()

        # Trigger Manager (Lot A2) : hooks d'événements de séquence → actions
        from indigo.devices.triggers import TriggerManager
        self.triggers = TriggerManager(self.sequence_cfg.get("triggers"))
        self.triggers.bind({
            "mount": (lambda: self.registry.get_mount()),
        })

        # Refocus automatique (Lot B3) : politique intervalle/altitude + run serveur
        from indigo.devices.refocus import RefocusPolicy
        self.refocus_policy = RefocusPolicy(**self.sequence_cfg.get("refocus", {}) or {"enabled": False})

        # Live stacking engine (Seiza LiveStacker) — device-agnostic pile
        from indigo.devices.live_stack import LiveStackEngine
        self.stacking = LiveStackEngine(options=self.sequence_cfg.get("stack", {}))
        # Auto-stacking session state (short-exposure loop feeding the engine)
        self._stacking_session: asyncio.Task | None = None
        self._stacking_stop = False
        self._stacking_master_path = None  # master auto-sauvé à la cible (sinon None)

        # Guide / calibration / autofocus state machines (used by web/routers)
        from indigo.devices.autofocus import AutoFocus
        from indigo.devices.guide import Guide
        from indigo.devices.guide_calibration import GuideCalibration
        self._autofocus = AutoFocus()
        self._guide = Guide()
        self._guide_cal = GuideCalibration()
        # Boucle d'autoguidage serveur (guide_loop.GuideLoopSession) :
        # tâche asyncio + caméra guide courante (None = pas de boucle).
        self._guide_task: asyncio.Task | None = None
        self._guide_camera: str | None = None
        # Flat-field capture wizard
        from indigo.devices.flat_wizard import FlatWizard
        self._flat_wizard = FlatWizard()
        self._flat_filter: str | None = None
        self._flat_binning: str | None = None
        # Pointing error model (interpolated corrections)
        from indigo.devices.pointing import PointingModel
        self._pointing = PointingModel()

        # Plugin manager (P2.2) — scan + load backends before wiring
        from indigo.plugins import PluginManager
        self.plugins = PluginManager()
        try:
            self.plugins.scan()
            self.plugins.load_all(self)
        except Exception as e:  # noqa: BLE001
            log.warning("plugins init failed: %s", e)

        # Wire up state broadcasting
        registry.on_state_update = self._broadcast_state

        # Wire image callbacks as soon as a camera is discovered (no 2 s wait)
        registry.on_device_added = self._on_camera_discovered

        # Install weblog handler on the root logger
        weblog_handler.setLevel(logging.DEBUG)
        logging.getLogger().addHandler(weblog_handler)

        self._setup_routes()

    async def _enable_blob_upload(self):
        """Wait for cameras to appear, request BLOB properties, enable BLOB delivery."""
        blob_requested: set[str] = set()      # cameras we sent getProperties for
        blob_enabled: set[str] = set()         # cameras we sent <enableBLOB> for (property-level)
        blob_enabled_dev: set[str] = set()     # cameras we sent device-level <enableBLOB> for
        retry_count: dict[str, int] = {}       # per-camera getProperties retry count
        last_connect: int = -1                # compteur de connexion vu (détecte les reconnects)
        last_try: dict[tuple, float] = {}     # cooldown d'envoi par (caméra, réglage)
        pixdiag_logged: set[str] = set()      # diagnostic profondeur déjà émis par caméra
        settings_applied: set[str] = set()    # devices aux réglages profil déjà appliqués

        def _reset():
            blob_requested.clear()
            blob_enabled.clear()
            blob_enabled_dev.clear()
            retry_count.clear()
            last_try.clear()
            pixdiag_logged.clear()
            settings_applied.clear()

        def _due(key: tuple) -> bool:
            # Les réglages switch sont refusés pendant une acquisition
            # (Busy → Alert) : ne renvoyer qu'en cas de désaccord, avec
            # cooldown 30 s, au lieu d'une fois-pour-toutes (qui rate sa
            # seule chance si la caméra pose à ce moment-là).
            import time as _t
            now = _t.monotonic()
            if now - last_try.get(key, 0.0) < 30.0:
                return False
            last_try[key] = now
            return True

        while True:
            await asyncio.sleep(2)
            if not self.registry.client.connected:
                _reset()
                last_connect = -1
                continue

            # Nouvelle connexion (reconnect, même rapide et jamais vu
            # déconnecté) : le serveur suit enableBLOB PAR CONNEXION, donc
            # tout est à renvoyer, sinon expose OK mais aucun BLOB.
            cur_connect = getattr(self.registry.client, "_connect_count", 0)
            if cur_connect != last_connect:
                last_connect = cur_connect
                _reset()
                log.info("New INDIGO connection (#%d) — re-requesting BLOB setup", cur_connect)

            for name, dev in self.registry.all_devices().items():
                if not hasattr(dev, 'on_image'):
                    continue

                # Wire the image callback if not already done
                if dev.on_image is None:
                    dev.on_image = self._make_image_callback(name)
                    log.debug("Wired image callback for camera: %s", name)

                # Step 1: Request CCD_IMAGE blob property definition (retry up to 5 times)
                retries = retry_count.get(name, 0)
                if name not in blob_requested or (not dev.blob_prop_name and retries < 5):
                    if name not in blob_requested:
                        blob_requested.add(name)
                    retry_count[name] = retries + 1
                    await self.registry.client.send_get_properties(
                        device=name, prop_name="CCD_IMAGE")

                # Step 2a: Send property-level <enableBLOB> if we know the blob prop name
                # Mode configuré (indigo.blob_mode) : Also = inline base64,
                # compatible INDI + INDIGO ; URL = INDIGO v2 (comme le panneau
                # indigo_server — le driver peut y être bien plus rapide).
                _bmode = getattr(self, "blob_mode", "Also")
                if dev.blob_prop_name and name not in blob_enabled:
                    blob_enabled.add(name)
                    await self.registry.client.send_enable_blob(
                        device=name, prop_name=dev.blob_prop_name, mode=_bmode)
                    log.info("enableBLOB %s for %s.%s", _bmode, name, dev.blob_prop_name)

                # Step 2b: Send device-level <enableBLOB> as fallback
                if name not in blob_enabled_dev:
                    blob_enabled_dev.add(name)
                    await self.registry.client.send_enable_blob(
                        device=name, mode=_bmode)
                    log.info("enableBLOB %s (device-level) for %s", _bmode, name)

                # Step 2c: Forcer l'upload côté client (INDI UPLOAD_MODE) —
                # certains drivers restent en LOCAL/DIRECT et n'envoient
                # jamais le BLOB sur le bus. Réémis si désaccord (cooldown),
                # car refusé pendant une acquisition.
                try:
                    for _up_name in ("UPLOAD_MODE", "CCD_UPLOAD", "UPLOAD_SETTINGS"):
                        _up_pv = dev.get_prop(_up_name)
                        if _up_pv is None:
                            continue
                        _names = {it.name for it in _up_pv.items}
                        if "UPLOAD_CLIENT" in _names:
                            _on = next((it for it in _up_pv.items if it.name == "UPLOAD_CLIENT"), None)
                            if _on is not None and not _on.value and _due((name, "upload")):
                                await dev.send_switch(_up_name, [
                                    {"name": it.name, "value": it.name == "UPLOAD_CLIENT"}
                                    for it in _up_pv.items])
                                log.info("Set %s=UPLOAD_CLIENT for %s", _up_name, name)
                            break
                        if "CLIENT" in _names:
                            _on = next((it for it in _up_pv.items if it.name == "CLIENT"), None)
                            if _on is not None and not _on.value and _due((name, "upload")):
                                await dev.send_switch(_up_name, [
                                    {"name": it.name, "value": it.name == "CLIENT"}
                                    for it in _up_pv.items])
                                log.info("Set %s=CLIENT for %s", _up_name, name)
                            break
                except Exception:  # noqa: BLE001
                    pass

                # Step 2d: Garder CCD_PREVIEW activé — son JPEG (~400 Ko en
                # ~7s) est l'aperçu rapide, bien avant le FITS complet.
                # (Tentative best-effort : noms d'items variables selon driver.)
                preview_pv = dev.get_prop("CCD_PREVIEW")
                if preview_pv:
                    try:
                        enabled_on = any(it.name == "ENABLED" and it.value for it in preview_pv.items)
                        if (not enabled_on and any(it.name == "ENABLED" for it in preview_pv.items)
                                and _due((name, "preview"))):
                            items = [{"name": it.name, "value": it.name == "ENABLED"} for it in preview_pv.items]
                            await dev.send_switch("CCD_PREVIEW", items)
                            log.info("Enabled CCD_PREVIEW for %s (preview JPEG rapide)", name)
                    except Exception:  # noqa: BLE001
                        pass

                # Step 3: Set CCD_IMAGE_FORMAT to FITS (full pour sauvegarde)
                fmt_pv = dev.get_prop("CCD_IMAGE_FORMAT")
                if fmt_pv:
                    fits_on = any(
                        item.name == "FITS" and item.value
                        for item in fmt_pv.items
                    )
                    if not fits_on and _due((name, "format")):
                        log.info("CCD_IMAGE_FORMAT for %s: %s → FITS",
                                 name, [(it.name, bool(it.value)) for it in fmt_pv.items])
                        items = [
                            {"name": item.name,
                              "value": item.name == "FITS"}
                            for item in fmt_pv.items
                        ]
                        await dev.send_switch("CCD_IMAGE_FORMAT", items)

                # Step 3b: RAW16 de préférence (capteur 12 bits : le RAW8
                # écrase les étoiles faibles). Uniquement RAW8→RAW16 /
                # Y8→Y16, jamais de changement de nature (cf. camera.py).
                # Réémis si désaccord (refusé pendant une acquisition).
                # Désactivable via indigo.prefer_raw16: false.
                if getattr(self, "prefer_raw16", True):
                    px_pv = dev.get_prop("X_PIXEL_FORMAT")
                    if px_pv:
                        from indigo.devices.camera import raw16_upgrade
                        target = raw16_upgrade([(it.name, bool(it.value)) for it in px_pv.items])
                        if target and _due((name, "pixel")):
                            log.info("X_PIXEL_FORMAT for %s: %s → %s (16 bits)",
                                     name, [(it.name, bool(it.value)) for it in px_pv.items],
                                     target)
                            await dev.send_switch("X_PIXEL_FORMAT", [
                                {"name": it.name, "value": it.name == target}
                                for it in px_pv.items
                            ])

                # Step 3c: profondeur via CCD_MODE quand le driver n'a pas
                # X_PIXEL_FORMAT (ex. SVBONY : "RAW 8 1x1" → "RAW 16 1x1").
                # Même philosophie : seule la profondeur change, jamais la
                # nature ni la géométrie. Réémis si désaccord (même cooldown).
                mode_pv = dev.get_prop("CCD_MODE")
                if mode_pv and getattr(self, "prefer_raw16", True):
                    try:
                        from indigo.devices.camera import raw16_mode_upgrade
                        mode_target = raw16_mode_upgrade(
                            [(it.name, bool(it.value)) for it in mode_pv.items])
                        if mode_target and _due((name, "mode")):
                            log.info("CCD_MODE for %s: %s → %s (16 bits)",
                                     name,
                                     [it.name for it in mode_pv.items if it.value],
                                     mode_target)
                            await dev.send_switch("CCD_MODE", [
                                {"name": it.name, "value": it.name == mode_target}
                                for it in mode_pv.items
                            ])
                            # Un changement de mode peut réinitialiser le
                            # driver (BLOB setup perdu) : on force sa
                            # redécouverte au prochain tick.
                            blob_requested.discard(name)
                            blob_enabled.discard(name)
                            blob_enabled_dev.discard(name)
                            pixdiag_logged.discard(name)
                    except Exception:  # noqa: BLE001
                        pass

                # Diagnostic profondeur (une fois par caméra) : si le driver
                # n'expose pas X_PIXEL_FORMAT (ou refuse RAW16), on le voit
                # ici au lieu de découvrir du BITPIX=8 après coup. Certains
                # drivers encodent la profondeur dans CCD_MODE.
                if name not in pixdiag_logged and hasattr(dev, "on_image"):
                    pixdiag_logged.add(name)
                    try:
                        _px = dev.get_prop("X_PIXEL_FORMAT")
                        _px_info = ([(it.name, bool(it.value)) for it in _px.items]
                                    if _px else "ABSENT")
                        _mode_pv = dev.get_prop("CCD_MODE")
                        _mode_on = ([it.name for it in _mode_pv.items if it.value]
                                    if _mode_pv else "ABSENT")
                        _mode_all = ([it.name for it in _mode_pv.items]
                                     if _mode_pv else [])
                        _last = self._camera_images.get(name, b"")
                        _bp = "?"
                        if len(_last) >= 2880 and _last[:6].startswith(b"SIMPLE"):
                            import re as _re2
                            _m = _re2.search(rb"BITPIX\s*=\s*(-?\d+)",
                                             _last[:2880])
                            _bp = _m.group(1).decode() if _m else "?"
                        log.info("PIXDIAG %s: X_PIXEL_FORMAT=%s CCD_MODE=%s modes=%s last_BITPIX=%s",
                                 name, _px_info, _mode_on, _mode_all, _bp)
                    except Exception:  # noqa: BLE001
                        pass

            # Réglages sauvegardés (profil actif) : appliqués une fois par
            # session à chaque device connecté (best-effort, props connues
            # uniquement). Le flag est levé à la déconnexion pour réappliquer
            # au prochain connect.
            try:
                _active = self.profiles.list_profiles().get("active")
                _prof = self.profiles.get(_active) if _active else None
                _ds_all = (_prof.get("device_settings") or {}) if _prof else {}
            except Exception:  # noqa: BLE001
                _ds_all = {}
            if _ds_all:
                for _dname, _ddev in self.registry.all_devices().items():
                    _want = _ds_all.get(_dname)
                    if not _want:
                        continue
                    if not bool(getattr(_ddev, "connected", False)):
                        settings_applied.discard(_dname)
                        continue
                    if _dname in settings_applied:
                        continue
                    _res = await self._apply_device_settings(_dname, _want)
                    if _res.get("ok"):
                        settings_applied.add(_dname)
                    else:
                        log.warning("Settings apply deferred for %s", _dname)

    def _on_camera_discovered(self, dev):
        """Wire the image callback as soon as a camera device appears."""
        if hasattr(dev, "on_image") and dev.on_image is None:
            dev.on_image = self._make_image_callback(dev.name)
            log.debug("Wired image callback for camera: %s", dev.name)

    @staticmethod
    async def _no_cache_middleware(request: Request, call_next):
        response = await call_next(request)
        # App + skymap code + viewer/preview : no-cache, mais pas les données (stars/mw/dsos).
        # + tous les JS/CSS maison : un pin ?v= oublié sur UN fichier = navigateur
        # qui tourne du code vieux de plusieurs semaines (vécu : api.js non pinné,
        # hardware.js épinglé à septembre). Seul /lib/ garde son cache.
        _p = request.url.path
        if (_p in ("/", "/app.js", "/preview.js", "/viewer.js", "/capture.js")
                or _p.startswith("/skymap/sky-engine")
                or ((_p.endswith(".js") or _p.endswith(".css")) and "/lib/" not in _p)):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    def _setup_routes(self) -> None:
        app = self.app

        @app.on_event("startup")
        async def startup():
            weblog_handler.set_loop(asyncio.get_event_loop())
            asyncio.create_task(self._enable_blob_upload())
            # Load plate solver catalogs
            cat_result = self.solver.load_catalogs()
            if cat_result.get("ok"):
                log.info("Solver catalogs loaded: %s", cat_result)
            else:
                log.warning("Solver catalogs: %s", cat_result.get("error", "unknown error"))
            log.info("Web server started")

        # ── REST API + WebSocket + test endpoints ────────────────
        # Routes moved to web/routers/*.py — each exposes register(app, server).
        from .routers import (aberration, camera, collimation, config, focuser, guide, hardware,
                              masters, mosaic, mount, pointing, polar, sequence,
                              stacking, triggers, visibility, ws_test)
        for router in (hardware, config, mount, camera, focuser, guide,
                       sequence, stacking, masters, mosaic, pointing, polar,
                       triggers, visibility, ws_test, collimation, aberration):
            router.register(app, self)

        # Plugins API (P2.2)
        @app.get("/api/plugins/status")
        async def plugins_status():
            return self.plugins.status()

        # Serve plugin frontends as static (/plugins/{name}/...)
        try:
            pdir = self.plugins.plugins_dir
            if pdir.exists():
                for sub in pdir.iterdir():
                    if sub.is_dir() and (sub / "frontend.js").exists():
                        app.mount(f"/plugins/{sub.name}", StaticFiles(directory=str(sub)), name=f"plugins-{sub.name}")
        except Exception as e:  # noqa: BLE001
            log.warning("plugin frontend mount failed: %s", e)

        # ── Static files (HTML/CSS/JS) ──────────────────────────

        CATALOGS_DIR = Path(__file__).parent.parent / "public" / "catalogs"
        if CATALOGS_DIR.exists():
            app.mount("/catalogs", StaticFiles(directory=str(CATALOGS_DIR)),
                      name="catalogs")

        CELESTIAL_DIR = Path(__file__).parent.parent / "public" / "celestial-data"
        if CELESTIAL_DIR.exists():
            app.mount("/celestial-data", StaticFiles(directory=str(CELESTIAL_DIR)),
                      name="celestial-data")

        # Sky map package (single source of truth pour sky-engine / sky-projection).
        if SKYMAP_SRC_DIR.exists():
            app.mount("/skymap", StaticFiles(directory=str(SKYMAP_SRC_DIR)),
                      name="skymap")

        if STATIC_DIR.exists():
            app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True),
                      name="static")

    async def _handle_ws_command(self, msg: dict) -> None:
        """Handle a command received via WebSocket."""
        cmd = msg.get("cmd")
        if cmd == "mount/slew":
            m = self.registry.get_mount()
            if m:
                await m.slew_to(msg["ra_hours"], msg["dec_deg"])
        elif cmd == "mount/abort":
            m = self.registry.get_mount()
            if m:
                await m.abort()
        elif cmd == "mount/park":
            m = self.registry.get_mount()
            if m:
                await m.park()
        elif cmd == "mount/unpark":
            m = self.registry.get_mount()
            if m:
                await m.unpark()
        elif cmd == "mount/home":
            m = self.registry.get_mount()
            if m:
                await m.home()
        elif cmd == "camera/expose":
            c = self.registry.get_camera(msg.get("device"))
            if c:
                await c.expose(msg["duration"], msg.get("frame_type", "LIGHT"))

    def _mount_flip_status(self, state: dict) -> dict:
        """Augment a mount state dict with meridian flip figures."""
        return _mount_flip_status(state, self.site, self.telescope)

    async def _do_meridian_flip(self) -> dict:
        """Execute a manual meridian flip sequence.

        Shared by the ``/api/mount/flip`` route and the sequence auto-flip
        hook.  Returns a dict with ``ok`` and, when ok, the completed phases.
        """
        m = self.registry.get_mount()
        if not m:
            return {"ok": False, "error": "no mount"}
        if not m.connected:
            return {"ok": False, "error": "mount not connected"}
        phases = []

        # 1. Stop any in-progress camera exposure cleanly
        for cam in self.registry._devices.values():
            if getattr(cam, "DEVICE_TYPE", None) == "camera" and getattr(cam, "is_ready", False):
                try:
                    await cam.abort()
                    phases.append(f"capture abort ({cam.name})")
                except Exception as e:  # noqa: BLE001
                    log.warning("flip: cam abort failed for %s: %s", cam.name, e)

        # 2. Stop guiding if active
        try:
            if hasattr(self, "_guide") and hasattr(self._guide, "stop"):
                st = self._guide.status()
                if str(st.get("state", "")).lower() in ("guiding", "starting"):
                    self._guide.stop()
                    phases.append("guiding stopped")
        except Exception as e:  # noqa: BLE001
            log.warning("flip: guide stop failed: %s", e)

        # 3. Capture current target before aborting the slew
        ra = m.ra_hours
        dec = m.dec_deg
        if ra is None or dec is None:
            return {"ok": False, "error": "mount has no coordinates to flip back to",
                    "phases": phases}

        # 4. Abort current motion, then slew to the same target (the flip itself)
        try:
            await m.abort()
            phases.append("motion aborted")
        except Exception as e:  # noqa: BLE001
            log.warning("flip: abort failed: %s", e)
        await asyncio.sleep(1.0)

        rate = self.telescope.get("flip_slew_rate", "Centering")
        try:
            await m.set_slew_rate(rate)
        except Exception:  # noqa: BLE001
            pass

        await m.slew_to(ra, dec)
        phases.append(f"slew to RA={ra:.4f}h DEC={dec:.4f}°")

        # 5. Recenter via plate solve on the same target (blocks until the
        #    mount is stable again, so the sequence can resume safely).
        recenter = {"done": False, "passes": 0, "error": None}
        if self.telescope.get("recenter_after_flip", True):
            recenter = await self._recenter_by_solve(ra, dec)
            if recenter.get("done"):
                phases.append(
                    f"recenter (solve) OK in {recenter.get('passes', 0)} pass(es)")
            else:
                phases.append(
                    f"recenter (solve) {recenter.get('error') or 'failed'}")
        _recenter = recenter

        # Mark that a flip already fired for this west-of-meridian pass so the
        # sequence hook does not re-flip on every subsequent frame.
        self._meridian_flipped = True

        return {
            "ok": True,
            "flipped": True,
            "phases": phases,
            "target": {"ra_hours": ra, "dec_deg": dec},
            "recenter": {
                "done": _recenter.get("done", False),
                "passes": _recenter.get("passes", 0),
                "error": _recenter.get("error"),
            },
        }

    def _camera_scale_hint(self, camera) -> float | None:
        """Pixel scale (arcsec/px) derived from the camera, or None."""
        try:
            if (camera and camera.pixel_size_um and camera.focal_length_mm):
                return (camera.pixel_size_um / 1000.0) / (camera.focal_length_mm / 1000.0) * 206.265
        except Exception:  # noqa: BLE001
            pass
        return None

    async def _recenter_by_solve(self, ra_hours: float, dec_deg: float,
                                 max_passes: int = 3, settle_s: float = 2.0,
                                 tolerance_arcmin: float = 1.0) -> dict:
        """Iteratively re-center the mount on ``(ra_hours, dec_deg)``.

        After a meridian flip the tube is on the other side of the pier, so the
        pointing can drift.  This takes a short exposure, plate-solves it, nudges
        the mount by the measured error and iterates until the target is centered
        (or a max number of passes is reached).  Every successful solve also feeds
        the pointing model so future slews improve.

        Returns ``{"done", "passes", "error", "phases"}``.
        """
        import asyncio as _aio
        loop = _aio.get_event_loop()
        m = self.registry.get_mount()
        cam = self.registry.get_camera()
        if not m or not m.connected:
            return {"done": False, "passes": 0, "error": "no mount"}
        if not cam or not cam.is_ready:
            return {"done": False, "passes": 0, "error": "no ready camera"}
        scale_hint = self._camera_scale_hint(cam)
        if scale_hint is None:
            return {"done": False, "passes": 0, "error": "no plate scale hint"}

        ra_deg_target = (float(ra_hours) * 15.0) % 360.0
        dec_target = float(dec_deg)
        phases: list[str] = []
        exp_s = float(self.exposure_cfg.get("recenter_duration", 2.0))

        for i in range(int(max_passes)):
            await _aio.sleep(settle_s)
            base = self._camera_images.get(cam.name, b"")
            try:
                await cam.expose(exp_s, "LIGHT")
                deadline = loop.time() + 35.0
                while loop.time() < deadline and cam.exposing:
                    await _aio.sleep(0.1)
                while loop.time() < deadline:
                    cur = self._camera_images.get(cam.name, b"")
                    if cur and cur != base:
                        break
                    await _aio.sleep(0.1)
                img = self._camera_images.get(cam.name, b"")
            except Exception as e:  # noqa: BLE001
                return {"done": False, "passes": i, "error": f"expose failed: {e}",
                        "phases": phases}
            if not img:
                return {"done": False, "passes": i, "error": "no image from camera",
                        "phases": phases}

            result = await loop.run_in_executor(
                None,
                lambda: self.solver.solve_image(
                    img, fmt="fits",
                    ra_hint=ra_deg_target, dec_hint=dec_target,
                    scale_hint=scale_hint,
                ),
            )
            if not result.get("ok"):
                # Can't plate-solve (dark/blurry/few stars). Re-trying would
                # only waste time — stop best-effort and let the sequence resume.
                phases.append(f"pass {i + 1}: solve failed ({result.get('error', '?')})")
                return {"done": False, "passes": i + 1,
                        "error": result.get("error") or "solve failed",
                        "phases": phases}

            solved_ra = result["ra"]
            solved_dec = result["dec"]

            # RA error across the wrap (deg).
            dra = solved_ra - ra_deg_target
            if dra > 180.0:
                dra -= 360.0
            elif dra < -180.0:
                dra += 360.0
            ddec = solved_dec - dec_target
            dist_arcmin = (abs(dra) ** 2 + abs(ddec) ** 2) ** 0.5 * 60.0

            # Feed the pointing model.
            try:
                correction_ra = -dra
                if correction_ra > 180.0:
                    correction_ra -= 360.0
                elif correction_ra < -180.0:
                    correction_ra += 360.0
                self._pointing.add_sample(ra_deg_target, dec_target,
                                          correction_ra, -ddec)
            except Exception:  # noqa: BLE001
                pass

            if dist_arcmin <= tolerance_arcmin:
                phases.append(f"pass {i + 1}: centered ({dist_arcmin:.2f}')")
                return {"done": True, "passes": i + 1, "error": None,
                        "phases": phases, "final_error_arcmin": round(dist_arcmin, 3)}

            # Nudge: slew to the corrected position (apply the error in reverse).
            nudge_ra = (ra_deg_target - dra) % 360.0
            nudge_dec = max(-90.0, min(90.0, dec_target - ddec))
            try:
                await m.set_slew_rate(self.telescope.get("flip_slew_rate", "Centering"))
            except Exception:  # noqa: BLE001
                pass
            try:
                await m.slew_to(nudge_ra / 15.0, nudge_dec)
            except Exception as e:  # noqa: BLE001
                return {"done": False, "passes": i + 1, "error": f"slew failed: {e}",
                        "phases": phases}
            phases.append(
                f"pass {i + 1}: error {dist_arcmin:.1f}' → slew to "
                f"RA={nudge_ra / 15.0:.4f}h DEC={nudge_dec:.2f}°")

        return {"done": False, "passes": max_passes,
                "error": f"not centered after {max_passes} passes",
                "phases": phases}

    def _broadcast_state(self, state: dict) -> None:
        """Send state update to all connected WebSocket clients."""
        if not self._ws_clients:
            return
        for name, dev in list(state.items()):
            if dev.get("type") == "mount":
                state[name] = self._mount_flip_status(dev)
        payload = json.dumps(_sanitize({"type": "state", "devices": state}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    def _safe_remove_client(self, ws) -> None:
        try:
            self._ws_clients.remove(ws)
        except ValueError:
            pass
        try:
            weblog_handler.remove_client(ws)
        except Exception:
            pass

    def _make_image_callback(self, device_name: str):
        """Create an image callback that captures the device name."""
        def _cb(data: bytes, fmt: str, url: str = "") -> None:
            asyncio.ensure_future(self._on_camera_image(device_name, data, fmt, url))
        return _cb

    @staticmethod
    def _bin_bayer(mono, pattern=""):
        """Bayer -> RGB demi-résolution EXACTE (moyenne des quads 2x2).

        mono: 2D entier, BZERO déjà soustrait. Ne JAMAIS sous-échantillonner
        une mosaïque par stride (il ne garderait qu'une phase sur 4 et
        jetterait 3 couleurs sur 4) : on binne les quads, chaque pixel
        de sortie porte les 3 couleurs. Utilisé pour la vignette ; la
        pleine résolution utilise le bilinéaire (_debayer_preview).
        """
        import numpy as _np
        try:
            pat = (pattern or "").upper()
            if len(pat) != 4 or any(c not in "RGB" for c in pat):
                return None
            h, w = mono.shape
            h2, w2 = (h // 2) * 2, (w // 2) * 2
            if h2 < 2 or w2 < 2:
                return None
            m = mono[:h2, :w2].astype(_np.float32)
            pos = {}
            for i, c in enumerate(pat):
                pos.setdefault(c, []).append((i // 2, i % 2))
            chans = {}
            for c in "RGB":
                qs = [m[y::2, x::2] for (y, x) in pos.get(c, [])]
                if not qs:
                    return None
                chans[c] = sum(qs) / len(qs)
            return _np.stack([chans["R"], chans["G"], chans["B"]], axis=2)
        except Exception:
            return None

    @staticmethod
    def _debayer_preview(mono, pattern="", w=0, h=0):
        """Dématriçage bilinéaire (PIL, C-rapide) d'une mosaïque Bayer.

        mono: tableau 2D entier, BZERO déjà soustrait, pleine dynamique
        (pas de passage en uint8 avant : //257 écraserait les étoiles
        faibles). Retourne RGB float32 (h, w, 3) ou None.
        """
        import numpy as _np
        from PIL import Image as _PIL
        try:
            pat = (pattern or "").upper()
            if len(pat) != 4 or any(c not in "RGB" for c in pat):
                return None
            if tuple(mono.shape) != (h, w):
                return None
            pos = {}
            for i, c in enumerate(pat):
                pos.setdefault(c, []).append((i // 2, i % 2))
            f = mono.astype(_np.float32)
            chans = {}
            for c in "RGB":
                # ascontiguousarray : les quadrants sont des vues stridées
                # que PIL.fromarray lirait de travers (couleurs permutées).
                qs = [_np.ascontiguousarray(f[y::2, x::2]) for (y, x) in pos.get(c, [])]
                if not qs:
                    return None
                q = sum(qs) / len(qs)
                im = _PIL.fromarray(q, mode="F").resize((w, h), _PIL.BILINEAR)
                chans[c] = _np.asarray(im, dtype=_np.float32)
            return _np.stack([chans["R"], chans["G"], chans["B"]], axis=2)
        except Exception:
            return None

    @staticmethod
    def _stretch_and_jpeg(arr_u8, max_side: int, is_color: bool):
        """Étire (plancher bruit) + encode JPEG.

        arr_u8: tableau (H, W) gris ou (H, W, 3) couleur (uint8 de
        préférence, autre dtype numérique toléré). Plancher = médiane +
        3σ (MAD) : un fond sombre reste noir au lieu d'amplifier le bruit
        de lecture. Mêmes bornes sur les 3 canaux (balance préservée).
        """
        import io as _io
        import numpy as _np
        from PIL import Image as _PIL
        try:
            work = _np.ascontiguousarray(arr_u8)
            if is_color:
                work = work.astype(_np.float32)
                # Balance des blancs display-only (gris-moyen sur médianes) :
                # un éclairage chaud (plafond tungstène → orange immonde) sort
                # neutre, comme le frontend d'indigo_server. Sur fond de ciel
                # les médianes sont ~égales → balance ≈ identité (couleurs
                # d'étoiles préservées, cf. test_rgb_planar_keeps_color).
                # FITS sauvegardé et mesures inchangés. Limite connue :
                # bande étroite (Ha) : le fond G/B est remonté (bruit chroma).
                try:
                    _s = work[::8, ::8]
                    _meds = [float(_np.median(_s[:, :, c])) for c in range(3)]
                    _ref = max(_meds)
                    if _ref > 0:
                        _ratios = [(round(_ref / m, 2) if m > 0 else 1.0)
                                   for m in _meds]
                        for _c in range(3):
                            if _meds[_c] > 0:
                                work[:, :, _c] *= (_ref / _meds[_c])
                        # Traçabilité terrain : une correction forte (>1.5×)
                        # signale une dominante (éclairage chaud / offsets
                        # mal lus) — visible dans le log serveur.
                        if max(_ratios) > 1.5:
                            log.info("thumb WB: medians=%s ratios=%s",
                                     [round(m, 1) for m in _meds], _ratios)
                    else:
                        log.warning("thumb WB skipped: medians=%s (≤0, "
                                    "BZERO/BSCALE non appliqué ?)",
                                    [round(m, 1) for m in _meds])
                except Exception:
                    pass
                luma = work.mean(axis=2).astype(_np.float32)
            else:
                luma = work.astype(_np.float32)
            flat = luma.ravel()
            step = max(1, flat.size // 200_000)
            sample = flat[::step]
            med = float(_np.median(sample))
            mad = float(_np.median(_np.abs(sample - med)))
            sigma = 1.4826 * mad
            hi = float(_np.percentile(sample, 99.5))
            # Plancher adaptatif : ciel astro (queue brillante : étoiles, max
            # loin de la médiane) → médiane + 3σ, le fond reste noir sans
            # amplifier le bruit ; champ plat (plafond, bias/flat, capteur
            # saturé : max dans le bruit) → min des données.
            flat_field = (float(_np.max(sample)) - med) <= max(50.0, 20.0 * sigma)
            lo = float(_np.min(sample)) if flat_field else med + 3.0 * sigma
            if not hi > lo:
                hi = lo + 1.0
            if flat_field:
                # Aucune scène à étirer (champ plat/saturé) : étirer le bruit
                # de lecture sur toute la dynamique le colore (moucheture
                # arc-en-ciel) alors qu'indigo_server montre un gris plat. On
                # rend donc un aplat neutre au niveau moyen du champ.
                x = float(_np.clip((med - lo) * (255.0 / (hi - lo)), 0.0, 255.0))
                lvl = int(round(float(_np.arcsinh(x / 255.0 * 10) / _np.arcsinh(10)) * 255))
                if is_color:
                    img = _PIL.fromarray(_np.full((work.shape[0], work.shape[1], 3),
                                                  lvl, dtype=_np.uint8), mode="RGB")
                else:
                    img = _PIL.fromarray(_np.full((work.shape[0], work.shape[1]),
                                                  lvl, dtype=_np.uint8), mode="L")
                img.thumbnail((max_side, max_side), _PIL.BILINEAR)
                out = _io.BytesIO()
                img.save(out, format="JPEG", quality=80, optimize=True)
                return out.getvalue()
            if is_color:
                out = _np.empty(work.shape, dtype=_np.uint8)
                scale = 255.0 / (hi - lo)
                for c in range(3):
                    ch = _np.clip((work[:, :, c].astype(_np.float32) - lo) * scale, 0, 255)
                    ch = _np.arcsinh(_np.clip(ch / 255.0, 0, 1) * 10) / _np.arcsinh(10)
                    out[:, :, c] = (ch * 255).astype(_np.uint8)
                img = _PIL.fromarray(out, mode="RGB")
            else:
                arr_f = _np.clip((work.astype(_np.float32) - lo) / (hi - lo), 0, 1)
                arr_f = _np.arcsinh(arr_f * 10) / _np.arcsinh(10)
                img = _PIL.fromarray((arr_f * 255).astype(_np.uint8), mode="L")
            img.thumbnail((max_side, max_side), _PIL.BILINEAR)
            out = _io.BytesIO()
            img.save(out, format="JPEG", quality=80, optimize=True)
            return out.getvalue()
        except Exception:
            return None

    def _jpeg_thumb(self, data: bytes, max_side: int = 1024) -> bytes | None:
        """FITS/RGB/Bayer → JPEG couleur léger.

        - RGB planaire/entrelacé → JPEG couleur (fini le tout-gris) ;
        - Bayer (BAYERPAT) → dématriçage aperçu ;
        - mono → gris.
        Étirement robuste au bruit : plancher = médiane + 3σ (MAD), pas le
        percentile 2 (qui amplifiait le bruit de lecture en grain visible
        sur les fonds sombres).
        """
        try:
            import io as _io
            import numpy as _np
            from PIL import Image as _PIL
            if len(data) >= 2 and data[0] == 0xFF and data[1] == 0xD8:
                img = _PIL.open(_io.BytesIO(data))
                img.thumbnail((max_side, max_side), _PIL.BILINEAR)
                out = _io.BytesIO()
                img.convert("RGB").save(out, format="JPEG", quality=80, optimize=True)
                return out.getvalue()
            if len(data) < 2880 or not data[:6].startswith(b"SIMPLE"):
                return None
            import re as _re
            hdr = data[:2880].decode("ascii", errors="ignore")
            def _geti(k):
                import re as _re
                m = _re.search(rf"{k}\s*=\s*([-\d\.]+)", hdr)
                try:
                    return int(float(m.group(1))) if m else 0
                except Exception:
                    return 0
            w = _geti("NAXIS1"); h = _geti("NAXIS2"); naxis = _geti("NAXIS"); bitpix = _geti("BITPIX")
            if not w or not h or w * h > 100_000_000:
                return None
            m_bayer = _re.search(r"BAYERPAT\s*=\s*'?\s*([A-Za-z]+)", hdr)
            bayerpat = m_bayer.group(1).upper() if m_bayer else ""
            # Notation scientifique tolérée (BZERO écrit « 3.2768E+04 » par
            # certains drivers) : sinon l'offset est tronqué (3.2768) et les
            # valeurs restent négatives → balance sautée → image teintée.
            m_bzero = _re.search(r"BZERO\s*=\s*([-\d\.eE+]+)", hdr)
            try:
                bzero = float(m_bzero.group(1)) if m_bzero else 0.0
            except Exception:
                bzero = 0.0
            m_bscale = _re.search(r"BSCALE\s*=\s*([-\d\.eE]+)", hdr)
            try:
                bscale = float(m_bscale.group(1)) if m_bscale else 1.0
            except Exception:
                bscale = 1.0
            if not (bscale > 0 or bscale < 0):
                bscale = 1.0
            bpp = 2 if bitpix == 16 else 1 if bitpix == 8 else 4 if bitpix == -32 else 2
            naxis3 = _geti("NAXIS3")
            planes = naxis3 if naxis == 3 and naxis3 else 1
            hdr_end = data.find(b"END" + b" " * 77)
            off = ((hdr_end // 2880) + 1) * 2880 if hdr_end != -1 else 2880
            need = w * h * planes * bpp
            if len(data) < off + need or need > 200_000_000:
                return None
            raw = data[off:off + need]
            if bitpix == 8:
                arr = _np.frombuffer(raw, dtype=_np.uint8)
            elif bitpix == -32:
                arr = _np.frombuffer(raw, dtype=">f4")
            else:
                arr = _np.frombuffer(raw, dtype=">i2")
            # Entête muet sur BZERO mais données 16 bits franchement
            # négatives : unsigned stocké en int16 (offset 32768 non déclaré,
            # vu sur certains drivers). Sans ce repli, médianes ≤ 0 → balance
            # sautée → vignette teintée. Heuristique display-only.
            if bitpix == 16 and bzero == 0.0 and bscale == 1.0 and arr.size:
                try:
                    _samp = arr[::max(1, arr.size // 200_000)]
                    if float(_np.median(_samp)) < -1000.0:
                        bzero = 32768.0
                except Exception:
                    pass
            # Échelle de travail : sous-échantillonne AVANT tout float
            # (vignette 26 Mpx → ~0.7 Mpx : 36× moins de RAM/CPU).
            scale = max(1, int(max(w, h) / max_side))
            color = None  # float32 ou uint8 (H, W, 3) si couleur résolue
            if planes == 3:
                # RGB INDIGO = planaire (transposé par le driver), repli
                # entrelacé toléré. Profondeur native conservée (pas de
                # //257 : l'étirement travaille en float). BZERO/BSCALE
                # appliqués ici AUSSI : un float négatif (unsigned 16 bits
                # avec offset) fausse la balance gris-moyen, qui saute
                # (médianes ≤ 0) et laisse une dominante de couleur.
                try:
                    if arr.size == planes * h * w:
                        rgb = arr.reshape((planes, h, w)).transpose(1, 2, 0)
                    else:
                        rgb = arr.reshape((h, w, planes))
                    if rgb.shape == (h, w, 3):
                        sub = rgb[::scale, ::scale] if scale > 1 else rgb
                        sub = _np.ascontiguousarray(sub)
                        if bzero != 0.0 or bscale != 1.0:
                            sub = sub.astype(_np.float32) * bscale + float(bzero)
                        color = sub
                    else:
                        color = None
                except Exception:
                    color = None
            elif bayerpat:
                # Mosaïque Bayer → couleur SANS passage uint8 (la dynamique
                # survit). Vignette : binning 2x2 exact des quads ; pleine :
                # bilinéaire pleine résolution.
                try:
                    m = arr.reshape((h, w))
                    # Échelle physique : brut*BSCALE + BZERO (le signe compte :
                    # un shift uniforme conserve les différences mais fausse
                    # les RATIOS, donc la balance des blancs).
                    if bzero != 0.0 or bscale != 1.0:
                        m = m.astype(_np.float32) * bscale + float(bzero)
                    if scale > 1:
                        color = self._bin_bayer(m, bayerpat)
                    else:
                        color = self._debayer_preview(m, bayerpat, w, h)
                except Exception:
                    color = None
            if color is not None:
                return self._stretch_and_jpeg(color, max_side, True)
            # Mono (ou repli) : pipeline historique, plancher anti-bruit.
            try:
                arr = arr.reshape((h, w))
            except Exception:
                return None
            if scale > 1:
                arr = arr[::scale, ::scale]
            return self._stretch_and_jpeg(arr, max_side, False)
        except Exception as e:  # noqa: BLE001
            log.warning("thumb failed (fallback full): %s", e)
            return None

    async def _on_camera_image(self, device_name: str, data: bytes, fmt: str, url: str = "") -> None:
        """Forward camera image to all WebSocket clients."""
        import base64
        import time as _time
        t_inline = _time.monotonic()
        # Budget de bout en bout : depuis EXPOSE START (driver/USB/SDK) —
        # c'est cette ligne qui dira où partent les secondes.
        t_expose = None
        try:
            _cam = self.registry.get_camera(device_name)
            t_expose = getattr(_cam, "_last_expose_start", None)
        except Exception:  # noqa: BLE001
            pass
        if not fmt and url:
            if url.lower().endswith(".jpeg") or url.lower().endswith(".jpg"):
                fmt = "jpg"
            elif url.lower().endswith(".fits") or url.lower().endswith(".fit"):
                fmt = "fits"
        if url:
            log.info("Camera image URL from %s: %s (fmt=%s)", device_name, url, fmt)
            asyncio.ensure_future(self._fetch_and_broadcast(device_name, url, fmt))
            return
        if not data:
            log.warning("Camera image from %s has ZERO bytes — skipping", device_name)
            return
        if not fmt:
            if len(data) >= 2 and data[0] == 0xFF and data[1] == 0xD8:
                fmt = "jpg"
            elif len(data) >= 6 and data[:6].startswith(b"SIMPLE"):
                fmt = "fits"
        is_jpeg = fmt.lower().endswith("jpg") or fmt.lower().endswith("jpeg")
        # Stockage séparé : FITS pour save/stats/adu, JPEG preview pour affichage
        if is_jpeg:
            self._last_preview_jpeg = data
            self._last_preview_device = device_name
            if not hasattr(self, "_preview_jpegs"):
                self._preview_jpegs = {}
            self._preview_jpegs[device_name] = data
            # ne pas écraser le FITS si on a déjà un FITS
            if not getattr(self, "_last_image_data", None) or not self._last_image_data[:6].startswith(b"SIMPLE"):
                self._last_image_data = data
                self._last_image_device = device_name
        else:
            self._last_image_data = data
            self._last_image_device = device_name
            self._camera_images[device_name] = data
        log.info("Camera image INLINE from %s: %d bytes fmt=%s ws=%d", device_name, len(data), fmt, len(self._ws_clients))
        if t_expose:
            import time as _t2
            log.info("BUDGET %s: EXPOSE→BLOB %.1fs (driver/USB/SDK, avant Noctua)",
                     device_name, t_inline - t_expose)
        if not is_jpeg and len(data) >= 2880 and data[:6].startswith(b"SIMPLE"):
            try:
                import re as _re
                _hdr = data[:2880].decode("ascii", errors="ignore")
                def _hi(k):
                    _m = _re.search(rf"{k}\s*=\s*([-\d\.]+)", _hdr)
                    try: return int(float(_m.group(1))) if _m else -1
                    except Exception: return -1
                log.info("FITS geometry %s: NAXIS1=%d NAXIS2=%d NAXIS3=%d BITPIX=%d",
                         device_name, _hi("NAXIS1"), _hi("NAXIS2"), _hi("NAXIS3"), _hi("BITPIX"))
                # Diagnostic Bayer : motif déclaré + moyennes des 4 phases de
                # la mosaïque. Tranche motif/phase d'un coup (ex. plafond
                # blanc rendu orange = phases inattendues ou BAYERPAT faux).
                try:
                    import numpy as _np2
                    _mb = _re.search(r"BAYERPAT\s*=\s*'?\s*([A-Za-z]+)", _hdr)
                    _bpat = _mb.group(1).upper() if _mb else "-"
                    _xo = _re.search(r"XBAYEROFF\s*=\s*([-\d\.]+)", _hdr)
                    _yo = _re.search(r"YBAYEROFF\s*=\s*([-\d\.]+)", _hdr)
                    _w, _h, _bpix = _hi("NAXIS1"), _hi("NAXIS2"), _hi("BITPIX")
                    if _w > 0 and _h > 0 and _w * _h < 50_000_000:
                        _he = data.find(b"END" + b" " * 77)
                        _off = ((_he // 2880) + 1) * 2880 if _he != -1 else 2880
                        _bpp = 2 if _bpix == 16 else 1 if _bpix == 8 else 0
                        if _bpp and len(data) >= _off + _w * _h * _bpp:
                            _raw = data[_off:_off + _w * _h * _bpp]
                            _mbz = _re.search(r"BZERO\s*=\s*([-\d\.]+)", _hdr)
                            _mbs = _re.search(r"BSCALE\s*=\s*([-\d\.eE]+)", _hdr)
                            try: _bz = float(_mbz.group(1)) if _mbz else 0.0
                            except Exception: _bz = 0.0
                            _m = (_np2.frombuffer(_raw, dtype=">i2" if _bpp == 2 else _np2.uint8)
                                  .reshape((_h, _w)).astype(_np2.float32) + _bz)
                            _q = [round(float(_m[y::2, x::2].mean()), 1)
                                  for y in (0, 1) for x in (0, 1)]
                            _mu = (_np2.frombuffer(_raw, dtype=">u2" if _bpp == 2 else _np2.uint8)
                                   .reshape((_h, _w)).astype(_np2.float32).mean()
                                if _bpp == 2 else float(_m.mean()))
                            log.info("BAYER %s: pat=%s xoff=%s yoff=%s quads00/01/10/11=%s bzero=%s bscale=%s umean=%.1f",
                                     device_name, _bpat,
                                     _xo.group(1) if _xo else "0",
                                     _yo.group(1) if _yo else "0", _q,
                                     _mbz.group(1) if _mbz else "-",
                                     _mbs.group(1) if _mbs else "-",
                                     round(float(_mu), 1))
                except Exception:  # noqa: BLE001
                    pass
            except Exception:  # noqa: BLE001
                pass
        if not self._ws_clients:
            log.warning("No WS clients for %s — image kept for save, preview will retry on next WS connect", device_name)
        # Id de pose pour la déduplication côté UI (preview + final = 1 affichage).
        exp_id = self._exposure_id(device_name)
        # Durée acquisition→transfert (EXPOSE START → BLOB reçu) : affichée
        # dans l'UI (ligne d'info aperçu) en plus du log BUDGET.
        xfer_s = round(t_inline - t_expose, 1) if t_expose else None
        # >2 Mo FITS → JPEG vignette + pleine résolution (évite 77 Mo FITS sur WS)
        if fmt.lower().endswith("fits") and len(data) > 2 * 1024 * 1024:
            # Vignette 1024 synchrone (rapide, aperçu immédiat) ; pleine
            # 8192 en tâche de fond (ne retarde ni le transfert — FITS déjà
            # stocké plus haut — ni la vignette). Seule la plus récente
            # compte → la précédente encore en cours est annulée.
            # Toujours les deux, quel que soit le mode UI : la vignette
            # garantit un aperçu, la pleine suit sans rien bloquer.
            thumb_vignette = None
            try:
                thumb_vignette = await asyncio.to_thread(self._jpeg_thumb, data, 1024)
            except Exception as e:  # noqa: BLE001
                log.warning("vignette thread failed: %s", e)
            if thumb_vignette:
                self._push_jpg(device_name, thumb_vignette, "vignette", "final", exp_id, xfer_s)
                import time as _t3
                _dt_v = _t3.monotonic() - t_inline
                log.info("Broadcast JPEG vignette %d KB for %s (src FITS %d KB)", len(thumb_vignette)//1024, device_name, len(data)//1024)
                log.info("BUDGET %s: BLOB→vignette %.1fs (CPU Noctua)", device_name, _dt_v)
                self._last_thumb = thumb_vignette
                self._last_thumb_device = device_name
                self._last_thumb_vignette = thumb_vignette
            _old = getattr(self, "_pleine_task", None)
            if _old is not None and not _old.done():
                _old.cancel()
            self._pleine_task = asyncio.get_running_loop().create_task(
                self._build_and_broadcast_pleine(device_name, data, exp_id, xfer_s))
            return
        if is_jpeg:
            # Preview JPEG du driver (ex. CCD_PREVIEW_IMAGE, ~7s après la
            # pose) : diffusé aussitôt avec un variant déduit des dimensions.
            # C'est lui qui donne une image en quelques secondes, bien avant
            # le FITS complet — ne pas le laisser au filtrage à l'aveugle.
            variant = None
            try:
                _dims = await asyncio.to_thread(self._jpg_dims, data)
            except Exception:  # noqa: BLE001
                _dims = None
            if _dims:
                variant = "vignette" if _dims[0] < 1500 else "pleine"
                log.info("Preview JPEG %s: %dx%d → variant %s (%d KB)",
                         device_name, _dims[0], _dims[1], variant, len(data)//1024)
            if variant == "pleine":
                # Preview plein format du driver (ex. 6224×4168 en 400 Ko) :
                # en dérive une vignette immédiate, sinon le mode vignette
                # n'affiche rien avant le FITS (~70s). L'original part en
                # pleine ; la vignette FITS refinera les deux plus tard.
                try:
                    _pv = await asyncio.to_thread(self._jpeg_thumb, data, 1024)
                except Exception as e:  # noqa: BLE001
                    _pv = None
                    log.warning("preview vignette failed for %s: %s", device_name, e)
                if _pv:
                    self._push_jpg(device_name, _pv, "vignette", "preview", exp_id, xfer_s)
                    log.info("Preview JPEG %s: vignette dérivée %d KB",
                             device_name, len(_pv)//1024)
                    self._last_thumb = _pv
                    self._last_thumb_device = device_name
                    self._last_thumb_vignette = _pv
                self._push_jpg(device_name, data, "pleine", "preview", exp_id, xfer_s)
                self._last_thumb_pleine = data
                self._last_thumb_pleine_device = device_name
                return
            if variant:
                self._push_jpg(device_name, data, variant, "preview", exp_id, xfer_s)
                return
            # Dimensions illisibles : diffusion brute sans variant (legacy).
        b64 = base64.b64encode(data).decode("ascii")
        payload = json.dumps({
            "type": "image",
            "device": device_name,
            "format": fmt,
            "exposure": exp_id,
            "xfer": xfer_s,
            "data": b64,
        })
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    @staticmethod
    def _jpg_dims(data: bytes):
        """Dimensions d'un JPEG sans le décoder (lecture d'entête)."""
        try:
            import io as _io
            from PIL import Image as _PIL
            with _PIL.open(_io.BytesIO(data)) as img:
                return (int(img.width), int(img.height))
        except Exception:
            return None

    def _exposure_id(self, device_name: str):
        """Identifiant de la pose en cours (EXPOSE START du driver).

        Le preview JPEG et le FITS final d'une même pose partagent le même
        id — l'UI n'affiche que la première image reçue par pose (plus de
        double affichage aperçu → définitif). Les mesures (HFR, stats)
        restent calculées sur le FITS côté serveur, en pleine dynamique.
        """
        try:
            from indigo.devices.camera import _EXPOSE_STARTS
            exp = _EXPOSE_STARTS.get(device_name) or 0
            if exp:
                return exp
            cam = self.registry.get_camera(device_name)
            exp = getattr(cam, "_last_expose_start", 0) or 0
            if exp:
                return exp
            # Dernier recours : la caméra qui expose en ce moment est celle
            # au timestamp le plus récent. (Dégrade en double affichage au
            # pire, jamais en écran noir.)
            best = 0
            for dev in self.registry.all_devices().values():
                try:
                    v = getattr(dev, "_last_expose_start", 0) or 0
                    if v > best:
                        best = v
                except Exception:  # noqa: BLE001
                    continue
            return best
        except Exception:  # noqa: BLE001
            return 0

    # ── Réglages par device (persistés dans le profil actif) ──────

    # Props exclues du snapshot : connexion, état d'expo en cours, transfert
    # BLOB (géré serveur), port monture (champ dédié mount_endpoint).
    _SETTINGS_SKIP = ("CONNECTION", "CCD_EXPOSURE", "CCD_PREVIEW",
                      "UPLOAD_MODE", "UPLOAD_SETTINGS", "DEVICE_PORT",
                      "DEVICE_PORTS", "CONNECTION_PORT")

    def _snapshot_device_settings(self, device_name: str) -> dict:
        """Photographie les réglages modifiables d'un device.

        switch/number/text inscriptibles uniquement. Retourne
        {PROP: {item: value}}.
        """
        dev = self.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}
        out: dict = {}
        try:
            props = dev.all_properties()
        except Exception:  # noqa: BLE001
            return {"error": "no properties known yet"}
        for pname, pv in props.items():
            try:
                if pname in self._SETTINGS_SKIP:
                    continue
                vtype = pv.vector_type.value
                if vtype not in ("switch", "number", "text"):
                    continue
                if getattr(pv, "perm", "ro") == "ro":
                    continue
                items = {}
                for it in pv.items:
                    v = it.value
                    if isinstance(v, bool):
                        items[it.name] = v
                    elif isinstance(v, (int, float)):
                        items[it.name] = v
                    elif isinstance(v, str) and v:
                        items[it.name] = v
                if items:
                    out[pname] = items
            except Exception:  # noqa: BLE001
                continue
        return {"ok": True, "device": device_name, "settings": out}

    async def _apply_device_settings(self, device_name: str, settings: dict) -> dict:
        """Rejoue des réglages sauvegardés (best-effort, par item connu)."""
        dev = self.registry.get(device_name)
        if not dev:
            return {"error": f"device '{device_name}' not found"}
        if not isinstance(settings, dict) or not settings:
            return {"ok": True, "applied": [], "skipped": []}
        applied, skipped = [], []
        for pname, items in settings.items():
            if pname in self._SETTINGS_SKIP or not isinstance(items, dict):
                skipped.append(pname)
                continue
            try:
                pv = dev.get_prop(pname)
                if not pv:
                    skipped.append(pname)
                    continue
                vtype = pv.vector_type.value
                if vtype == "switch":
                    is_many = getattr(pv, "rule", None) == "AnyOfMany"
                    full = []
                    for it in pv.items:
                        if it.name in items:
                            full.append({"name": it.name, "value": bool(items[it.name])})
                        elif is_many:
                            full.append({"name": it.name, "value": bool(it.value)})
                        else:
                            full.append({"name": it.name, "value": False})
                    await dev.send_switch(pname, full)
                    applied.append(pname)
                elif vtype == "number":
                    nums = [{"name": it.name, "value": float(items[it.name])}
                            for it in pv.items if it.name in items]
                    if not nums:
                        skipped.append(pname)
                        continue
                    await dev.send_number(pname, nums)
                    applied.append(pname)
                elif vtype == "text":
                    txts = [{"name": it.name, "value": str(items[it.name])}
                            for it in pv.items if it.name in items]
                    if not txts:
                        skipped.append(pname)
                        continue
                    await dev.send_text(pname, txts)
                    applied.append(pname)
                else:
                    skipped.append(pname)
            except Exception as e:  # noqa: BLE001
                log.warning("Apply settings %s.%s failed: %s", device_name, pname, e)
                skipped.append(pname)
        log.info("Applied settings for %s: %s (skipped: %s)",
                 device_name, applied, skipped)
        return {"ok": True, "applied": applied, "skipped": skipped}

    def _push_jpg(self, device_name: str, jpg: bytes, variant: str, stage: str = "final", exposure=None, xfer=None) -> None:
        """Diffuse un JPEG (vignette/pleine) à tous les clients WS.

        stage: 'preview' (JPEG driver, rapide, provisoire) ou 'final'
        (dérivé du FITS). exposure: id de pose (cf. _exposure_id).
        """
        if exposure is None:
            exposure = self._exposure_id(device_name)
        payload = json.dumps({
            "type": "image",
            "device": device_name,
            "format": "jpg",
            "variant": variant,
            "stage": stage,
            "exposure": exposure,
            "xfer": xfer,
            "data": base64.b64encode(jpg).decode("ascii"),
        })
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        for ws in self._ws_clients[:]:
            loop.create_task(self._send_jpg(ws, payload))

    async def _send_jpg(self, ws, payload: str) -> None:
        try:
            await ws.send_text(payload)
        except Exception:
            self._safe_remove_client(ws)

    async def _build_and_broadcast_pleine(self, device_name: str, data: bytes, exposure=0, xfer=None) -> None:
        """Fabrique le JPEG pleine résolution en fond et le diffuse.

        N'est jamais sur le chemin critique : le FITS est déjà stocké et
        la vignette déjà diffusée quand cette tâche tourne.
        """
        try:
            thumb = await asyncio.to_thread(self._jpeg_thumb, data, 8192)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("pleine thread failed: %s", e)
            return
        if not thumb:
            log.warning("pleine thumb empty for %s — skipped", device_name)
            return
        self._push_jpg(device_name, thumb, "pleine", "final", exposure, xfer)
        log.info("Broadcast JPEG pleine résolution %d KB for %s (src FITS %d KB) [fond]",
                 len(thumb)//1024, device_name, len(data)//1024)
        self._last_thumb_pleine = thumb
        self._last_thumb_pleine_device = device_name
        if not getattr(self, "_last_thumb_vignette", None):
            self._last_thumb = thumb
            self._last_thumb_device = device_name

    async def _fetch_and_broadcast(self, device_name: str, url: str, fmt: str) -> None:
        """Fetch a BLOB image from its URL and broadcast to WebSocket clients."""
        import aiohttp
        try:
            allowed_host = self.registry.client._host
            allowed_port = getattr(self.registry.client, "_port", 7624)
            if url.startswith("/"):
                path = url
            elif url.startswith("http://"):
                # Accepte http://host:port/path où port == allowed_port (host peut être
                # 127.0.0.1 vs localhost selon le BLOB URL INDIGO).
                try:
                    from urllib.parse import urlparse as _up
                    parsed = _up(url)
                    if parsed.port != allowed_port:
                        log.error("Refusing BLOB fetch for disallowed port: %s", url)
                        return
                    path = parsed.path or "/"
                    if parsed.query:
                        path += "?" + parsed.query
                except Exception:
                    log.error("Refusing BLOB fetch for disallowed URL: %s", url)
                    return
            else:
                log.error("Refusing BLOB fetch for disallowed URL: %s", url)
                return
            if ".." in path.split("/"):
                log.error("Refusing BLOB fetch with path traversal: %s", path)
                return
            fetch_url = f"http://{allowed_host}:{allowed_port}{path}"

            log.info("Fetching BLOB from: %s", fetch_url)
            async with aiohttp.ClientSession() as session:
                async with session.get(fetch_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status != 200:
                        log.error("BLOB fetch failed: HTTP %d from %s", resp.status, fetch_url)
                        return
                    data = await resp.read()
                    log.info("BLOB fetched: %d bytes from %s", len(data), fetch_url)
                    await self._on_camera_image(device_name, data, fmt)
        except Exception as e:
            log.error("Failed to fetch BLOB from %s: %s", url, e)

    async def _broadcast_solver_result(self, result: dict) -> None:
        """Broadcast solver result to all WebSocket clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "solver_result", "result": result}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    async def _stacking_session_loop(self, duration: float, max_frames: int,
                                     session_dir: str, filter_name: str = "") -> None:
        """Auto-stacking loop: repeatedly capture short LIGHT poses, save each
        FITS under the livestack session dir, and push it into the engine.

        Runs until the caller stops it, or until ``max_frames`` accepted frames
        are stacked (max_frames == 0 → continuous).
        """
        import asyncio as _asyncio
        try:
            cam = self.registry.get_camera()
            if not cam:
                self._stacking_stop = True
                raise RuntimeError("no camera connected")
            if not cam.is_ready:
                self._stacking_stop = True
                raise RuntimeError(f"camera '{cam.name}' not ready")

            if filter_name:
                fw = self.registry.get_filterwheel()
                if fw:
                    await fw.set_slot(filter_name)

            frame_descr = {"duration": duration, "frame_type": "LIGHT",
                           "filter": filter_name, "count": 1, "delay": 0.0}
            idx = 0
            completed_with_target = False
            while not self._stacking_stop:
                st = self.stacking.status()
                if max_frames > 0 and st.get("complete"):
                    completed_with_target = True
                    break

                base = self._camera_images.get(cam.name, b"")
                t_obs = datetime.now(timezone.utc)
                await cam.expose(duration, "LIGHT")
                while cam.exposing and not self._stacking_stop:
                    await _asyncio.sleep(0.1)
                deadline = _asyncio.get_running_loop().time() + 30.0
                while _asyncio.get_running_loop().time() < deadline and not self._stacking_stop:
                    cur = self._camera_images.get(cam.name, b"")
                    if cur and cur != base:
                        break
                    await _asyncio.sleep(0.1)
                await _asyncio.sleep(0.2)

                idx += 1
                from datetime import datetime as _dt
                ts = _dt.now().strftime("%Y%m%d_%H%M%S")
                group = (filter_name or "light").replace("/", "_")
                path = os.path.join(session_dir, f"light_{group}_{idx:03d}_{ts}.fits")
                img = self._camera_images.get(cam.name, self._last_image_data)
                # Lot C4 : métadonnées normalisées dans l'entête FITS.
                from indigo.devices import fitsmeta
                site = self.site or {}
                meta = fitsmeta.frame_meta(
                    target=self.sequence_cfg.get("target", ""),
                    frame_type="LIGHT",
                    filter_name=filter_name,
                    exposure_sec=duration,
                    instrument=cam.name,
                    ccd_temp=cam.temperature,
                    set_temp=(cam.target_temp if cam.target_temp is not None
                              else cam.temperature),
                    pixel_size_um=cam.pixel_size_um,
                    binning_x=cam.binning_x,
                    binning_y=cam.binning_y,
                    gain=cam.gain,
                    offset=cam.offset,
                    focal_length_mm=cam.focal_length_mm,
                    telescope=(self.telescope or {}).get("name", ""),
                    sitelat=site.get("latitude"),
                    sitelong=site.get("longitude"),
                    sitelev=site.get("elevation"),
                    date_obs=t_obs,
                )
                img = await _asyncio.to_thread(fitsmeta.inject_meta, img, meta)
                with open(path, "wb") as f:
                    f.write(img)

                res = await _asyncio.to_thread(self.stacking.push_fits, img)
                logging.getLogger(__name__).debug(
                    f"stacking session frame {idx}: ok={res.get('ok')} "
                    f"accepted={res.get('accepted')} err={res.get('error','')}")
                _asyncio.get_running_loop().create_task(self._broadcast_stacking_snapshot(path))
                self._broadcast_stacking_status()
            logging.getLogger(__name__).info(
                f"stacking session ended: {self.stacking.status().get('accepted')} "
                f"accepted in {session_dir}")
        except Exception as e:  # noqa: BLE001
            self._stacking_stop = True
            logging.getLogger(__name__).error(f"stacking session failed: {e}")
        finally:
            self._stacking_session = None
            # Session avec cible atteinte → sauvegarde automatique du master
            # dans <root>/masters/ (le root = parent du dossier de session).
            self._stacking_master_path = None
            if completed_with_target:
                try:
                    res = await _asyncio.to_thread(
                        self.stacking.save_master, os.path.dirname(session_dir), "master", "fits")
                    if res.get("ok"):
                        self._stacking_master_path = res["path"]
                        logging.getLogger(__name__).info(
                            f"auto-saved master at target: {res['path']}")
                    else:
                        logging.getLogger(__name__).warning(
                            f"auto-save master failed: {res.get('error')}")
                except Exception as e:  # noqa: BLE001
                    logging.getLogger(__name__).error(f"auto-save master error: {e}")
            self._broadcast_stacking_status()

    def _stacking_status_payload(self) -> dict:
        """Status payload shared by /api/stacking/status and the WS push."""
        st = self.stacking.status()
        st["session"] = {
            "running": self._stacking_session is not None and not self._stacking_session.done(),
            "stop_requested": self._stacking_stop,
        }
        st["session_dir"] = getattr(self, "_stacking_session_dir", None)
        st["master_path"] = self._stacking_master_path
        return st

    def _broadcast_stacking_status(self) -> None:
        """Broadcast live stacking status to all WebSocket clients
        (message type ``stacking`` — remplace le polling frontend)."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "stacking", "status": self._stacking_status_payload()}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    def _broadcast_sequence_status(self) -> None:
        """Broadcast sequence status to all WebSocket clients
        (message type ``sequence`` — remplace le polling frontend)."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({"type": "sequence", "status": self.sequence.status()}))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    # ── Boucle d'autoguidage serveur ─────────────────────────────

    def _broadcast_guide_status(self, status: dict | None = None) -> None:
        """Broadcast guide telemetry to all WebSocket clients
        (message type ``guide`` → topic Hub ``guide:telemetry``)."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({
            "type": "guide",
            "status": status if status is not None else self._guide.status(),
        }))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))

    def _guide_start_loop(self, camera_name: str) -> None:
        """Lance la boucle de guidage serveur (no-op si déjà en cours)."""
        if self._guide_task is not None and not self._guide_task.done():
            return
        from indigo.devices.guide_loop import GuideLoopSession
        self._guide_camera = camera_name
        session = GuideLoopSession(
            self._guide, camera_name, self._guide_loop_hooks(camera_name))
        self._guide_task = asyncio.get_running_loop().create_task(
            session.run(), name=f"guide-loop-{camera_name}")
        log.info("Guide loop task started (camera=%s)", camera_name)

    async def _guide_stop_loop(self) -> None:
        """Stoppe la boucle (annulation + halt monture de sécurité)."""
        task, self._guide_task = self._guide_task, None
        self._guide_camera = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as e:  # noqa: BLE001
                log.warning("Guide loop task ended with error: %s", e)
        # Sécurité : une impulsion a pu être interrompue entre move et halt.
        try:
            m = self.registry.get_mount()
            if m is not None:
                await m.halt_move()
        except Exception:  # noqa: BLE001
            pass
        self._broadcast_guide_status()

    def _guide_loop_hooks(self, camera_name: str) -> dict:
        """Hooks matériels de GuideLoopSession (caméra, métrique, monture)."""
        server = self
        guide_log = logging.getLogger("indigo.guide")

        async def _log(level: str, msg: str) -> None:
            # Le WebLogHandler (racine) relaie vers le panneau Log via WS.
            guide_log.log(
                logging.WARNING if level in ("warning", "error") else logging.INFO,
                "guide-loop: %s", msg)

        async def capture_frame(duration: float, timeout: float) -> bytes | None:
            cam = server.registry.get_camera(camera_name)
            if cam is None:
                raise RuntimeError(f"caméra guide '{camera_name}' introuvable")
            if not cam.is_ready:
                raise RuntimeError(f"caméra guide '{camera_name}' non prête")
            baseline = server._camera_images.get(cam.name, b"")
            await cam.expose(float(duration), "LIGHT")
            loop = asyncio.get_running_loop()
            while cam.exposing:
                await asyncio.sleep(0.1)
            deadline = loop.time() + float(timeout)
            while loop.time() < deadline:
                cur = server._camera_images.get(cam.name, b"")
                if cur and cur != baseline:
                    await asyncio.sleep(0.2)
                    return cur
                await asyncio.sleep(0.1)
            return None

        async def measure(img: bytes) -> dict | None:
            from indigo.devices.focus_metrics import compute_focus_metrics
            res = await asyncio.to_thread(compute_focus_metrics, img)
            stars = (res or {}).get("stars") or []
            if not stars:
                return None
            best = stars[0]
            return {
                "x": float(best["x"]),
                "y": float(best["y"]),
                "snr": best.get("snr"),
                "width": (res or {}).get("width"),
                "height": (res or {}).get("height"),
            }

        async def pulse(direction: str, ms: int) -> None:
            m = server.registry.get_mount()
            if m is None:
                raise RuntimeError("pas de monture pour corriger")
            # Le halt est protégé de l'annulation : jamais de slew infini
            # si la tâche est stoppée entre move et halt.
            await asyncio.shield(_pulse_guarded(m, direction, ms))

        async def _pulse_guarded(m, direction: str, ms: int) -> None:
            await m.move(direction)
            try:
                await asyncio.sleep(max(0, ms) / 1000.0)
            finally:
                await m.halt_move()

        async def set_rate(rate: str) -> None:
            m = server.registry.get_mount()
            if m is None:
                raise RuntimeError("pas de monture pour régler la vitesse")
            await m.set_slew_rate(rate)

        def broadcast(payload: dict) -> None:
            server._broadcast_guide_status(payload)

        return {
            "capture_frame": capture_frame,
            "measure": measure,
            "pulse": pulse,
            "set_rate": set_rate,
            "broadcast": broadcast,
            "log": _log,
            "sleep": asyncio.sleep,
        }

    async def _broadcast_stacking_snapshot(self, path: str = "") -> None:
        """Broadcast the current live-stack preview to WebSocket clients."""
        if not self._ws_clients:
            return
        try:
            png = self.stacking.snapshot_png()
        except Exception:  # noqa: BLE001
            png = None
        if not png:
            return
        await self._broadcast_image("stacking", base64.b64encode(png).decode("ascii"))

    async def _broadcast_image(self, device: str, b64data: str) -> None:
        """Low-level helper pushing a base64 image message to WS clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(_sanitize({
            "type": "image", "device": device, "format": "png", "data": b64data,
        }))
        loop = asyncio.get_running_loop()

        async def _safe_send(ws):
            try:
                await ws.send_text(payload)
            except Exception:
                self._safe_remove_client(ws)

        for ws in self._ws_clients[:]:
            loop.create_task(_safe_send(ws))
