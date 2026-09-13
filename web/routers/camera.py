"""Camera and plate solver routes."""

import asyncio
import base64
import os
from datetime import datetime
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/camera")
    async def get_camera():
        c = server.registry.get_camera()
        return SanitizedJSONResponse(c.state_dict() if c else None)

    @app.get("/api/cameras")
    async def get_cameras():
        cameras = server.registry.get_all_cameras()
        return [{"name": c.name, "connected": c.connected, "is_ready": c.is_ready} for c in cameras]

    @app.post("/api/camera/expose")
    async def camera_expose(body: dict):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        if not c.is_ready:
            return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}
        await c.expose(body["duration"], body.get("frame_type", "LIGHT"))
        return {"ok": True}

    @app.post("/api/camera/abort")
    async def camera_abort(body: dict = {}):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        await c.abort()
        return {"ok": True}

    @app.post("/api/camera/save")
    async def camera_save(body: dict):
        """Save the last captured image to a directory."""
        save_dir = body.get("dir", "")
        if not save_dir:
            return {"error": "no directory specified"}
        # Expand ~ and create dir if needed
        save_dir = os.path.expanduser(save_dir)
        os.makedirs(save_dir, exist_ok=True)
        # Build filename from timestamp + filter
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filter_name = (body.get("filter") or "").strip()
        if filter_name:
            filename = f"capture_{filter_name}_{ts}.fits"
        else:
            filename = f"capture_{ts}.fits"
        filepath = os.path.join(save_dir, filename)
        # Get last image data from the camera
        c = server.registry.get_camera()
        if not c:
            return {"error": "no camera"}
        # We need the raw image data — check if we can get it from the client
        # The image was already sent to WS clients, we need to re-fetch or store it
        # For now, we'll store the last image in the server
        if not hasattr(server, '_last_image_data') or not server._last_image_data:
            return {"error": "no image data available — capture first"}
        # Lot C4 : métadonnées normalisées (capteur, optique, site) dans l'entête FITS.
        from indigo.devices import fitsmeta
        site = server.site or {}
        meta = fitsmeta.frame_meta(
            target=body.get("target") or server.sequence_cfg.get("target", ""),
            frame_type=body.get("frame_type") or c.frame_type or "LIGHT",
            filter_name=filter_name,
            exposure_sec=c.exposure_time,
            instrument=c.name,
            ccd_temp=c.temperature,
            set_temp=(c.target_temp if c.target_temp is not None else c.temperature),
            pixel_size_um=c.pixel_size_um,
            binning_x=c.binning_x,
            binning_y=c.binning_y,
            gain=c.gain,
            offset=c.offset,
            focal_length_mm=c.focal_length_mm,
            telescope=(server.telescope or {}).get("name", ""),
            sitelat=site.get("latitude"),
            sitelong=site.get("longitude"),
            sitelev=site.get("elevation"),
        )
        img = await asyncio.to_thread(fitsmeta.inject_meta, server._last_image_data, meta)
        with open(filepath, "wb") as f:
            f.write(img)
        log.info("Image saved: %s (%d bytes)", filepath, len(img))
        return {"ok": True, "path": filepath, "size": len(img)}

    @app.get("/api/camera/last_image")
    async def camera_last_image(device: str = "", thumb: int = 1, variant: str = "", pleine: int = 0):
        """Retourne la dernière image capturée (thumb JPEG si dispo, sinon FITS) en base64.

        Fallback HTTP quand le WS a raté la poussée (ws=0, réseau, etc.).
        Le viewer capture l'appelle en fallback après waitExposureDone.
        variant=pleine ou pleine=1 → JPEG pleine 8192, sinon vignette 1024.
        """
        # thumb=1 → préfère le JPEG (vignette ou pleine selon variant)
        if thumb:
            # pleine demandée explicitement
            if (variant == "pleine" or pleine) and getattr(server, "_last_thumb_pleine", None):
                tdev = getattr(server, "_last_thumb_pleine_device", "") or device or getattr(server, "_last_image_device", "")
                import base64 as _b64
                return SanitizedJSONResponse({
                    "ok": True,
                    "device": tdev,
                    "format": "jpg",
                    "variant": "pleine",
                    "data": _b64.b64encode(server._last_thumb_pleine).decode("ascii"),
                    "size": len(server._last_thumb_pleine),
                    "thumb": True,
                })
            if getattr(server, "_last_thumb", None):
                tdev = getattr(server, "_last_thumb_device", "") or device or getattr(server, "_last_image_device", "")
                import base64 as _b64
                # _last_thumb est la vignette 1024 (ou pleine si pas de vignette)
                variant_name = "vignette" if getattr(server, "_last_thumb_vignette", None) else "pleine"
                return SanitizedJSONResponse({
                    "ok": True,
                    "device": tdev,
                    "format": "jpg",
                    "variant": variant_name,
                    "data": _b64.b64encode(server._last_thumb).decode("ascii"),
                    "size": len(server._last_thumb),
                    "thumb": True,
                })
            # fallback pleine si vignette pas dispo mais pleine oui
            if getattr(server, "_last_thumb_pleine", None):
                tdev = getattr(server, "_last_thumb_pleine_device", "") or device or getattr(server, "_last_image_device", "")
                import base64 as _b64
                return SanitizedJSONResponse({
                    "ok": True,
                    "device": tdev,
                    "format": "jpg",
                    "variant": "pleine",
                    "data": _b64.b64encode(server._last_thumb_pleine).decode("ascii"),
                    "size": len(server._last_thumb_pleine),
                    "thumb": True,
                })
        # sinon full FITS
        img = None
        dev_name = device or getattr(server, "_last_image_device", "")
        if dev_name:
            img = server._camera_images.get(dev_name)
        if not img:
            img = getattr(server, "_last_image_data", b"")
        if not img:
            return {"ok": False, "error": "no image captured yet"}
        import base64 as _b64
        return SanitizedJSONResponse({
            "ok": True,
            "device": dev_name or "unknown",
            "format": "fits",
            "data": _b64.b64encode(img).decode("ascii"),
            "size": len(img),
            "thumb": False,
        })

    @app.get("/api/camera/last_image/stats")
    async def camera_last_image_stats(device: str = "", bins: int = 256):
        """Histogramme + stats du dernier FITS (calculé côté serveur sur le vrai FITS).
        Utilisé par l'aperçu JPEG pleine résolution pour afficher l'histo/ADU
        sans télécharger le FITS complet."""
        import asyncio as _aio
        import re as _re
        import numpy as _np
        img = server._camera_images.get(device) if device else None
        if not img:
            img = getattr(server, "_last_image_data", b"")
        if not img or len(img) < 2880 or not img[:6].startswith(b"SIMPLE"):
            return {"ok": False, "error": "no FITS captured yet"}
        def _compute():
            try:
                hdr = img[:2880].decode("ascii", errors="ignore")
                def _geti(k):
                    m = _re.search(rf"{k}\s*=\s*([-\d\.]+)", hdr)
                    try: return int(float(m.group(1))) if m else 0
                    except: return 0
                w = _geti("NAXIS1"); h = _geti("NAXIS2"); naxis = _geti("NAXIS"); bitpix = _geti("BITPIX")
                if not w or not h: return None
                bpp = 2 if bitpix==16 else 1 if bitpix==8 else 4 if bitpix==-32 else 2
                naxis3 = _geti("NAXIS3"); planes = naxis3 if naxis==3 and naxis3 else 1
                hdr_end = img.find(b"END" + b" " * 77)
                off = ((hdr_end // 2880) + 1) * 2880 if hdr_end!=-1 else 2880
                need = w*h*planes*bpp
                if len(img) < off+need: return None
                raw = img[off:off+need]
                if bitpix==8: arr = _np.frombuffer(raw, dtype=_np.uint8)
                elif bitpix==-32: arr = _np.frombuffer(raw, dtype=">f4")
                else: arr = _np.frombuffer(raw, dtype=">i2")
                if planes==3:
                    try:
                        arr = arr.reshape((planes, h, w)) if arr.size==planes*h*w else arr.reshape((h,w,planes))
                        arr = arr.mean(axis=0) if arr.shape[0]==3 else arr.mean(axis=2) if arr.shape[2]==3 else arr[0]
                    except: return None
                else:
                    try: arr = arr.reshape((h,w))
                    except: return None
                flat = arr.ravel().astype(_np.float32)
                step = max(1, flat.size // 200000)
                sample = flat[::step]
                vmin = float(_np.min(sample)); vmax = float(_np.max(sample))
                median = float(_np.median(sample))
                hist, edges = _np.histogram(sample, bins=256, range=(vmin, vmax))
                return {
                    "w": w, "h": h, "bitpix": bitpix,
                    "min": vmin, "max": vmax, "median": median,
                    "hist": hist.tolist(), "bins": 256,
                }
            except Exception as e:
                return {"error": str(e)}
        res = await _aio.to_thread(_compute)
        if not res or "error" in res:
            return {"ok": False, "error": res.get("error","failed") if res else "failed"}
        return SanitizedJSONResponse({"ok": True, **res})

    @app.get("/api/camera/last_image/adu")
    async def camera_last_image_adu(device: str = "", x: int = 0, y: int = 0):
        """ADU du vrai FITS à la coordonnée x,y (origine coin haut-gauche comme l'affichage)."""
        import asyncio as _aio
        import re as _re
        import numpy as _np
        # Cherche un FITS (pas un JPEG preview) — _camera_images peut contenir le JPEG si on a écrasé
        img = None
        if device:
            cand = server._camera_images.get(device)
            if cand and len(cand) >= 6 and cand[:6].startswith(b"SIMPLE"):
                img = cand
        if not img:
            # _last_image_data est FITS si on a bien séparé JPEG/FITS côté server
            cand = getattr(server, "_last_image_data", b"")
            if cand and len(cand) >= 6 and cand[:6].startswith(b"SIMPLE"):
                img = cand
        if not img:
            # fallback : scanne tous les _camera_images à la recherche d'un FITS
            for v in getattr(server, "_camera_images", {}).values():
                if v and len(v) >= 6 and v[:6].startswith(b"SIMPLE"):
                    img = v
                    break
        if not img or len(img) < 2880 or not img[:6].startswith(b"SIMPLE"):
            log.warning("ADU: no FITS found (device=%s, last_is_jpeg=%s)", device, str(getattr(server, "_last_image_data", b"")[:2] == b"\xff\xd8"))
            return {"ok": False, "error": "no FITS"}
        def _get():
            try:
                hdr = img[:2880].decode("ascii", errors="ignore")
                def _geti(k):
                    m = _re.search(rf"{k}\s*=\s*([-\d\.]+)", hdr)
                    try: return int(float(m.group(1))) if m else 0
                    except: return 0
                w = _geti("NAXIS1"); h = _geti("NAXIS2"); bitpix = _geti("BITPIX")
                if not w or not h: return None
                bpp = 2 if bitpix==16 else 1 if bitpix==8 else 4 if bitpix==-32 else 2
                hdr_end = img.find(b"END" + b" " * 77)
                off = ((hdr_end // 2880) + 1) * 2880 if hdr_end!=-1 else 2880
                ay = h - 1 - int(y)
                ax = int(x)
                if ax <0 or ax>=w or ay<0 or ay>=h: return {"adu": None, "w":w,"h":h}
                naxis = _geti("NAXIS"); naxis3 = _geti("NAXIS3"); planes = naxis3 if naxis==3 and naxis3 else 1
                # Lecture directe d'un seul pixel sans charger tout le tableau 77 Mo
                if planes == 1:
                    need_one = bpp
                    pix_off = off + (ay * w + ax) * bpp
                    if pix_off + bpp > len(img): return None
                    raw1 = img[pix_off:pix_off+bpp]
                    if bitpix == 8: adu = float(raw1[0])
                    elif bitpix == -32: adu = float(_np.frombuffer(raw1, dtype=">f4")[0])
                    else: adu = float(_np.frombuffer(raw1, dtype=">i2")[0])
                else:
                    # 3 plans : essaie (planes,h,w) puis (h,w,planes)
                    # Cas (3,h,w) : plan * w*h + ay*w+ax
                    # Cas (h,w,3) : (ay*w+ax)*3 + c
                    # On lit 3 octets/valeurs et on moyenne
                    if bitpix == 8:
                        # taille totale = w*h*3
                        # test rapide : si on est en (3,h,w), les 3 plans sont contigus
                        # on lit les 3 bytes et on moyenne
                        # pour (h,w,3), les 3 bytes sont contigus à pix_off
                        # On distingue par la taille du header ? On tente les deux et on prend la moyenne la plus plausible
                        # Plus simple : on lit les deux interprétations et on moyenne les 3 valeurs lues
                        # Pour (3,h,w) : offsets séparés
                        off0 = off + 0 * w * h + ay * w + ax
                        off1 = off + 1 * w * h + ay * w + ax
                        off2 = off + 2 * w * h + ay * w + ax
                        if off2 < len(img):
                            v0 = img[off0]; v1 = img[off1]; v2 = img[off2]
                            adu_planar = (int(v0) + int(v1) + int(v2)) / 3.0
                        else:
                            adu_planar = None
                        # Pour (h,w,3) : interleaved
                        pix_off_inter = off + (ay * w + ax) * 3
                        if pix_off_inter + 2 < len(img):
                            vi0 = img[pix_off_inter]; vi1 = img[pix_off_inter+1]; vi2 = img[pix_off_inter+2]
                            adu_inter = (int(vi0) + int(vi1) + int(vi2)) / 3.0
                        else:
                            adu_inter = None
                        # Si les deux sont valides, elles devraient être proches pour une vraie image
                        # On préfère la version planar (classique FITS 3 planes)
                        adu = adu_planar if adu_planar is not None else adu_inter
                        if adu is None: return None
                    else:
                        # 16-bit ou float 3 plans : on retombe sur le décodage complet (rare)
                        need = w*h*planes*bpp
                        raw = img[off:off+need]
                        if bitpix == -32: arr = _np.frombuffer(raw, dtype=">f4")
                        else: arr = _np.frombuffer(raw, dtype=">i2")
                        try:
                            arr = arr.reshape((planes, h, w)) if arr.size==planes*h*w else arr.reshape((h,w,planes))
                            arr = arr.mean(axis=0) if arr.shape[0]==3 else arr.mean(axis=2) if arr.shape[2]==3 else arr[0]
                        except: return None
                        adu = float(arr[ay, ax])
                return {"adu": adu, "w":w,"h":h, "x":ax, "y":int(y)}
            except Exception as e:
                return {"error": str(e)}
        res = await _aio.to_thread(_get)
        if not res or "error" in res:
            return {"ok": False, "error": res.get("error","failed") if res else "failed"}
        return SanitizedJSONResponse({"ok": True, **res})

    @app.post("/api/camera/temperature")
    async def camera_temperature(body: dict):
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        await c.set_temperature(body["target"])
        return {"ok": True}

    # ── Ideal exposure ───────────────────────────────────────

    @app.get("/api/camera/exposure/recommend")
    async def camera_exposure_recommend(device: str = ""):
        """Recommend an ideal exposure from the last captured image."""
        from indigo.devices.exposure import estimate_exposure, estimate_exposure_multi
        params = server.exposure_cfg or {}
        frames = server._last_exposure_frames
        if len(frames) >= 2:
            # Re-run the multi-shot fit from the frames saved by /estimate.
            try:
                return SanitizedJSONResponse(estimate_exposure_multi(frames, params))
            except Exception as e:
                log.error("Exposure estimate error: %s", e)
                return {"ok": False, "error": str(e)}
        img = server._camera_images.get(device, server._last_image_data) if device else server._last_image_data
        if not img:
            return {"ok": False, "error": "no image captured yet — take a test exposure first"}
        # Use the test duration actually measured by estimate, falling back to
        # the configured default (or 10 s) when the image came from elsewhere.
        test_duration = server._last_exposure_test_s or float(params.get("test_duration", 10.0))
        try:
            result = estimate_exposure(img, test_duration, params)
            return SanitizedJSONResponse(result)
        except Exception as e:
            log.error("Exposure estimate error: %s", e)
            return {"ok": False, "error": str(e)}

    @app.post("/api/camera/exposure/estimate")
    async def camera_exposure_estimate(body: dict = {}):
        """Take one or more test exposures, then recommend the ideal exposure.

        body = {
            "device": "cam",
            "shots": 1 | 3,                 # default: config exposure.shots (1)
            "test_min": 5.0,                # shortest test exposure (s)
            "test_max": 30.0,               # longest test exposure (s)
            "test_mid": 12.0,               # optional intermediate (shots=3)
        }

        shots=1 : single frame (assumes bias = BZERO).
        shots=3 : linear fit ADU(t) = bias + m*t — bias-independent, detects
                  the saturation knee and validates linearity/transparency.
        """
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        if not c.is_ready:
            return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}

        params = dict(server.exposure_cfg or {})
        shots = int(body.get("shots", params.get("shots", 1)))
        if shots not in (1, 2, 3):
            shots = 1

        default_min = float(params.get("test_min", params.get("test_duration", 10.0)))
        default_max = float(params.get("test_max", 30.0))
        default_mid = float(params.get("test_mid") or 0)

        min_t = max(float(body.get("test_min", default_min)), 0.1)
        max_t = max(float(body.get("test_max", default_max)), min_t)
        if shots < 3:
            max_t = max(min_t, max_t)
        mid_t = None
        if shots == 3:
            if body.get("test_mid") is not None:
                mid_t = max(float(body["test_mid"]), 0.1, min_t)
            elif default_mid > 0:
                mid_t = max(default_mid, min_t + 0.1)
            else:
                mid_t = (min_t + max_t) / 2.0
            mid_t = min(mid_t, max_t)

        durations = [min_t, max_t] if shots == 2 else ([min_t] if shots == 1 else [min_t, mid_t, max_t])

        from indigo.devices.exposure import estimate_exposure, estimate_exposure_multi

        base = server._camera_images.get(c.name, b"")
        images = []
        for d in durations:
            await c.expose(d, "LIGHT")
            # Wait for the exposure to finish, then for a new image blob.
            deadline = asyncio.get_running_loop().time() + d + 30.0
            while asyncio.get_running_loop().time() < deadline and c.exposing:
                await asyncio.sleep(0.1)
            while asyncio.get_running_loop().time() < deadline:
                cur = server._camera_images.get(c.name, b"")
                if cur and cur != base:
                    break
                await asyncio.sleep(0.1)
            img = server._camera_images.get(c.name, b"")
            if not img:
                return {"ok": False, "error": "test exposure produced no image"}
            images.append(img)
            base = img

        server._last_exposure_test_s = durations[-1]
        server._last_exposure_frames = list(zip(durations, images))
        try:
            if len(images) >= 2:
                frames = list(zip(durations, images))
                result = estimate_exposure_multi(frames, params)
            else:
                result = estimate_exposure(images[0], durations[0], params)
            return SanitizedJSONResponse(result)
        except Exception as e:
            log.error("Exposure estimate error: %s", e)
            return {"ok": False, "error": str(e)}

    # ── Flat-field Wizard ────────────────────────────────────

    @app.get("/api/camera/flat-wizard/status")
    async def flat_wizard_status():
        return SanitizedJSONResponse(server._flat_wizard.status())

    @app.post("/api/camera/flat-wizard/configure")
    async def flat_wizard_configure(body: dict = {}):
        st = server._flat_wizard.configure(
            target_adu=body.get("target_adu"),
            tolerance=body.get("tolerance"),
            start_duration=body.get("start_duration"),
            min_duration=body.get("min_duration"),
            max_duration=body.get("max_duration"),
        )
        server._flat_filter = body.get("filter")
        server._flat_binning = body.get("binning")
        return SanitizedJSONResponse({**st, "filter": server._flat_filter,
                                      "binning": server._flat_binning})

    @app.post("/api/camera/flat-wizard/step")
    async def flat_wizard_step(body: dict = {}):
        """Take one test flat exposure, measure its ADU, suggest next duration."""
        c = server.registry.get_camera(body.get("device"))
        if not c:
            return {"error": "no camera"}
        if not c.is_ready:
            return {"error": f"Camera '{c.name}' not connected to hardware — no CCD properties"}

        wz = server._flat_wizard
        if wz.done:
            return SanitizedJSONResponse({**wz.status(), "ok": True,
                                          "already_done": True})

        duration = float(body.get("duration", wz.duration))
        if body.get("binning"):
            b = str(body["binning"])
            x, y = b.split("x") if "x" in b else (b, b)
            await c.set_binning(int(x), int(y))

        from indigo.devices.exposure import _measure_frame

        base = server._camera_images.get(c.name, b"")
        await c.expose(duration, "FLAT")
        deadline = asyncio.get_running_loop().time() + duration + 30.0
        while asyncio.get_running_loop().time() < deadline and c.exposing:
            await asyncio.sleep(0.1)
        while asyncio.get_running_loop().time() < deadline:
            cur = server._camera_images.get(c.name, b"")
            if cur and cur != base:
                break
            await asyncio.sleep(0.1)
        img = server._camera_images.get(c.name, b"")
        if not img:
            return {"ok": False, "error": "flat test exposure produced no image"}

        full_scale = float(server.exposure_cfg.get("full_scale", 65535))
        frame = _measure_frame(img, full_scale)
        if frame is None:
            return {"ok": False, "error": "failed to parse flat test image"}

        adu = max(frame["sky_adu"], 0.0)
        st = wz.record_measurement(adu)
        return SanitizedJSONResponse({
            **st,
            "ok": True,
            "measured_adu": round(adu, 1),
            "bg_median": round(frame["bg_median"], 1),
            "bzero": round(frame["bzero"], 1),
            "saturation_pct": round(frame["peak_frac"] * 100.0, 1),
            "filter": server._flat_filter,
            "binning": server._flat_binning,
        })

    @app.post("/api/camera/flat-wizard/reset")
    async def flat_wizard_reset(body: dict = {}):
        st = server._flat_wizard.reset()
        server._flat_filter = None
        server._flat_binning = None
        return SanitizedJSONResponse(st)

    # ── Plate Solver ─────────────────────────────────────────

    @app.get("/api/solver/status")
    async def solver_status():
        return server.solver.status()

    @app.post("/api/solver/catalogs")
    async def solver_load_catalogs(body: dict = {}):
        catalog_dir = body.get("catalog_dir")
        result = server.solver.load_catalogs(catalog_dir)
        return result

    @app.post("/api/solver/solve")
    async def solver_solve(body: dict):
        """Solve a plate from the last captured image or uploaded data.

        body = {
            "mode": "hinted" | "blind" | "last_image",
            "ra_hint": 100.5,        # degrees (hinted mode)
            "dec_hint": 35.2,        # degrees (hinted mode)
            "scale_hint": 2.5,       # arcsec/pixel (hinted mode)
            "min_scale": 0.5,        # arcsec/pixel (blind mode)
            "max_scale": 15.0,       # arcsec/pixel (blind mode)
            "device": "camera_name", # optional, for auto-hint from mount
        }
        """
        if server.solver.is_solving:
            return {"error": "Already solving — wait for current solve to finish"}

        mode = body.get("mode", "hinted")

        # Get image data
        image_data = None
        fmt = "fits"

        if mode == "last_image":
            # Use the last captured image
            if not server._last_image_data:
                return {"error": "No image captured yet — capture first"}
            image_data = server._last_image_data
            fmt = "fits"
        elif "image_data" in body:
            # Direct image upload (base64)
            image_data = base64.b64decode(body["image_data"])
            fmt = body.get("format", "fits")
        else:
            return {"error": "Provide 'mode': 'last_image' or 'image_data'"}

        # Get hints
        ra_hint = body.get("ra_hint")
        dec_hint = body.get("dec_hint")
        scale_hint = body.get("scale_hint")

        # Auto-hint from FITS WCS (highest priority for test images)
        if (ra_hint is None or dec_hint is None or scale_hint is None) and image_data:
            try:
                wcs = server.solver._extract_wcs(image_data)
                if wcs:
                    if ra_hint is None and wcs.get("crval1") is not None:
                        ra_hint = wcs["crval1"]
                    if dec_hint is None and wcs.get("crval2") is not None:
                        dec_hint = wcs["crval2"]
                    if scale_hint is None and wcs.get("cdelt1") is not None:
                        scale_hint = abs(wcs["cdelt1"]) * 3600  # deg/pix → arcsec/pix
                    log.info("Auto-hint from FITS WCS: RA=%.2f DEC=%.2f scale=%.2f",
                             ra_hint or 0, dec_hint or 0, scale_hint or 0)
            except Exception as e:
                log.debug("FITS WCS extraction failed: %s", e)

        # Auto-hint from mount (if not yet provided)
        if ra_hint is None or dec_hint is None:
            m = server.registry.get_mount()
            if m and m.ra_hours is not None:
                ra_hint = ra_hint if ra_hint is not None else m.ra_hours * 15  # hours → degrees
                dec_hint = dec_hint if dec_hint is not None else m.dec_deg
                log.debug("Auto-hint from mount: RA=%.2f DEC=%.2f", ra_hint, dec_hint)

        # Auto-scale from camera (only if still no scale)
        if scale_hint is None:
            c = server.registry.get_camera(body.get("device"))
            if c and c.pixel_size_um and c.focal_length_mm:
                scale_hint = (c.pixel_size_um / 1000) / (c.focal_length_mm / 1000) * 206.265
                log.debug("Auto-scale from camera: %.2f arcsec/px", scale_hint)

        # Run solve in a thread (Seiza releases GIL but we want non-blocking)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: server.solver.solve_image(
                image_data,
                fmt=fmt,
                ra_hint=ra_hint,
                dec_hint=dec_hint,
                scale_hint=scale_hint,
                min_scale=body.get("min_scale", 0.5),
                max_scale=body.get("max_scale", 15.0),
                sigma=body.get("sigma", 2.0),
            )
        )

        # Broadcast result via WebSocket
        if result.get("ok"):
            await server._broadcast_solver_result(result)

        return result
