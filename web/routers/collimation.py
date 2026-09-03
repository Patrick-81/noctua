"""Collimation atelier — router FastAPI.

Endpoints :
  GET  /api/collimation/status          -> is_rpi, allow_training, model_done
  POST /api/collimation/infer/upload    -> upload FITS/PNG + detection
  POST /api/collimation/infer/load_path -> chargement par chemin serveur (recommandé RPi)
  GET  /api/collimation/infer/stars     -> liste étoiles
  POST /api/collimation/infer/run       -> inference CollimAI sur étoile choisie
  POST /api/collimation/dataset/start   -> grisé sur RPi (403)
  GET  /api/collimation/dataset/status
  POST /api/collimation/train/start     -> grisé sur RPi (403)
  GET  /api/collimation/train/status

Détection RPi centralisée dans indigo.devices.collimation.is_rpi / allow_training.
"""

from __future__ import annotations

import json
import threading
import time
import traceback
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import UploadFile, File, HTTPException

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer

# ── État partagé (thread-safe) pour dataset/train stubs ──
_lock = threading.Lock()
_state = {
    "dataset": {"status": "idle", "progress": 0, "n_done": 0, "n_total": 0, "eta_s": None, "error": None},
    "train": {"status": "idle", "progress": 0, "epoch": 0, "epochs": 40, "best_val": None, "loss_log": [], "error": None},
    "infer": {"status": "idle", "stars": [], "result": None, "error": None, "fits_path": None, "width": 0, "height": 0},
}


def _is_rpi() -> bool:
    try:
        from indigo.devices.collimation import is_rpi, allow_training
        return is_rpi()
    except Exception:
        return False


def _allow_training() -> bool:
    try:
        from indigo.devices.collimation import allow_training
        return allow_training()
    except Exception:
        return not _is_rpi()


def _model_done() -> bool:
    try:
        from indigo.devices.collimation import _model_path
        return _model_path().exists()
    except Exception:
        return False


def _detect_stars_ex(image_path: Path):
    """Copie de backend.py _detect_stars_ex — photutils DAOStarFinder."""
    import numpy as np
    ext = image_path.suffix.lower()
    if ext in (".fit", ".fits"):
        from astropy.io import fits
        with fits.open(image_path) as hdul:
            img = None
            for hdu in hdul:
                if hdu.data is not None and getattr(hdu.data, "ndim", 0) >= 2:
                    img = hdu.data.astype(np.float32)
                    break
            if img is None:
                raise ValueError("Aucune donnée image dans le FITS")
            while img.ndim > 2:
                img = img[0]
    elif ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy"):
        if ext == ".npy":
            img = np.load(image_path).astype(np.float32)
        else:
            from PIL import Image
            img = np.array(Image.open(image_path).convert("L"), dtype=np.float32)
    else:
        raise ValueError(f"Format non supporté : {ext}")

    if img.ndim != 2:
        raise ValueError(f"Image non 2D : shape={img.shape}")
    H, W = img.shape
    cx, cy = W / 2, H / 2
    zone_r = min(W, H) * 0.2

    from astropy.stats import sigma_clipped_stats
    _, median, std = sigma_clipped_stats(img, sigma=3.0)
    img_sub = img - median
    threshold = 5.0 * std

    from photutils.detection import DAOStarFinder
    daofind = DAOStarFinder(fwhm=6.0, threshold=threshold)
    sources = daofind(img_sub)
    if sources is None or len(sources) == 0:
        daofind = DAOStarFinder(fwhm=4.0, threshold=3.0 * std)
        sources = daofind(img_sub)
    if sources is None or len(sources) == 0:
        return [], W, H

    cols = sources.colnames

    def get_col(src, *names):
        for n in names:
            if n in cols:
                return float(src[n])
        raise KeyError(f"Aucune colonne parmi {names} dans {cols}")

    stars = []
    for src in sources:
        try:
            x = get_col(src, "xcentroid", "x_centroid", "x")
            y = get_col(src, "ycentroid", "y_centroid", "y")
            peak = get_col(src, "peak", "peak_value", "max_value")
            flux = get_col(src, "flux", "source_sum", "npix")
        except Exception as e:
            continue
        try:
            roundness = get_col(src, "roundness1", "roundness", "round")
            ellip = min(abs(roundness) / 2, 0.99)
        except KeyError:
            ellip = 0.1
        dist_centre = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        in_zone = dist_centre < zone_r
        saturated = peak > 55000
        adu = int(min(peak + median, 65535))
        candidate = (in_zone and not saturated and peak > threshold and ellip < 0.2)
        stars.append({
            "x": round(x, 1), "y": round(y, 1), "adu": adu,
            "ellip": round(ellip, 3), "flux": round(flux, 0),
            "zone": "centre" if in_zone else "bord",
            "candidate": candidate, "saturated": saturated,
            "dist_r": round(dist_centre / min(W, H) * 100, 1),
        })
    stars.sort(key=lambda s: (not s["candidate"], -s["adu"]))
    return stars[:30], W, H


def register(app, server: "WebServer") -> None:

    @app.get("/api/collimation/status")
    async def collim_status():
        from indigo.devices.collimation import hardware_info
        info = hardware_info()
        return SanitizedJSONResponse({
            "is_rpi": info["is_rpi"],
            "allow_training": info["allow_training"],
            "machine": info["machine"],
            "model_done": info["model_exists"],
            "model_path": info["model_path"],
            "infer": _state["infer"],
            "dataset": _state["dataset"],
            "train": _state["train"],
        })

    # ── INFÉRENCE ──────────────────────────────────────────

    @app.post("/api/collimation/infer/load_path")
    async def collim_load_path(body: dict):
        if not _model_done():
            return SanitizedJSONResponse({"error": "Modèle introuvable — placez best_model.pt dans indigo/collimation/models/"}, status_code=400)
        path = (body or {}).get("path", "").strip()
        if not path:
            return SanitizedJSONResponse({"error": "Chemin vide"}, status_code=400)
        p = Path(path)
        if not p.exists():
            return SanitizedJSONResponse({"error": f"Chemin introuvable : {path}"}, status_code=404)
        if p.is_dir():
            exts = (".fit", ".fits", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy")
            files = sorted([f for f in p.iterdir() if f.is_file() and f.suffix.lower() in exts],
                           key=lambda f: f.stat().st_mtime, reverse=True)
            if not files:
                return SanitizedJSONResponse({"error": f"Aucun fichier image dans : {path}"}, status_code=404)
            file_list = [{"name": f.name, "path": str(f), "size_mb": round(f.stat().st_size/1e6,1),
                          "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))} for f in files[:50]]
            chosen = files[0]
            p = chosen
        else:
            file_list = None
            if p.suffix.lower() not in (".fit",".fits",".png",".jpg",".jpeg",".tif",".tiff",".npy"):
                return SanitizedJSONResponse({"error": f"Format non supporté : {p.suffix}"}, status_code=400)

        with _lock:
            _state["infer"]["fits_path"] = str(p)
            _state["infer"]["stars"] = []
            _state["infer"]["result"] = None
            _state["infer"]["status"] = "detecting"
        try:
            stars, W, H = _detect_stars_ex(p)
            with _lock:
                _state["infer"]["stars"] = stars
                _state["infer"]["width"] = W
                _state["infer"]["height"] = H
                _state["infer"]["status"] = "ready"
            return SanitizedJSONResponse({"ok": True, "stars": stars, "n_stars": len(stars),
                                          "width": W, "height": H, "path": str(p), "filename": p.name,
                                          "dir_listing": file_list})
        except Exception as e:
            with _lock:
                _state["infer"]["status"] = "error"
                _state["infer"]["error"] = str(e)
            traceback.print_exc()
            return SanitizedJSONResponse({"error": str(e)}, status_code=500)

    @app.post("/api/collimation/infer/upload")
    async def collim_upload(file: UploadFile = File(...)):
        if not _model_done():
            return SanitizedJSONResponse({"error": "Modèle introuvable"}, status_code=400)
        ext = Path(file.filename or "image.fits").suffix.lower()
        upload_dir = Path(__file__).parent.parent.parent / "indigo" / "collimation" / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        dest = upload_dir / f"image{ext}"
        data = await file.read()
        dest.write_bytes(data)
        with _lock:
            _state["infer"]["fits_path"] = str(dest)
            _state["infer"]["stars"] = []
            _state["infer"]["result"] = None
            _state["infer"]["status"] = "detecting"
        try:
            stars, W, H = _detect_stars_ex(dest)
            with _lock:
                _state["infer"]["stars"] = stars
                _state["infer"]["width"] = W
                _state["infer"]["height"] = H
                _state["infer"]["status"] = "ready"
            return SanitizedJSONResponse({"ok": True, "stars": stars, "n_stars": len(stars), "width": W, "height": H})
        except Exception as e:
            with _lock:
                _state["infer"]["status"] = "error"
                _state["infer"]["error"] = str(e)
            traceback.print_exc()
            return SanitizedJSONResponse({"error": str(e)}, status_code=500)

    @app.get("/api/collimation/infer/stars")
    async def collim_stars():
        with _lock:
            s = _state["infer"].copy()
        return SanitizedJSONResponse({"stars": s["stars"], "status": s["status"]})

    @app.post("/api/collimation/infer/run")
    async def collim_run(body: dict):
        if not _model_done():
            return SanitizedJSONResponse({"error": "Modèle introuvable"}, status_code=400)
        star_idx = (body or {}).get("star_idx", 0)
        fits_path = _state["infer"].get("fits_path")
        if not fits_path or not Path(fits_path).exists():
            return SanitizedJSONResponse({"error": "Aucune image chargée"}, status_code=400)
        stars = _state["infer"]["stars"]
        if not stars or star_idx >= len(stars):
            return SanitizedJSONResponse({"error": "Étoile invalide"}, status_code=400)
        star = stars[star_idx]
        try:
            from indigo.devices.collimation import predict
            # Passe les coordonnées étoile pour crop plein champ
            result, patch = predict(fits_path, star_x=star["x"], star_y=star["y"])
            result["star"] = star
            with _lock:
                _state["infer"]["result"] = result
                _state["infer"]["status"] = "done"
            return SanitizedJSONResponse({"ok": True, "result": result})
        except Exception as e:
            traceback.print_exc()
            return SanitizedJSONResponse({"error": str(e)}, status_code=500)

    # ── APPRENTISSAGE — grisé sur RPi ──────────────────────

    @app.post("/api/collimation/dataset/start")
    async def collim_dataset_start(body: dict = {}):
        if not _allow_training():
            return SanitizedJSONResponse(
                {"error": "Apprentissage désactivé sur RPi (CPU/RAM insuffisants). Lancez generate_psf_dataset.py sur Orion puis copiez best_model.pt",
                 "is_rpi": True, "allow_training": False}, status_code=403)
        # Stub : pas de génération côté Noctua (lancer standalone)
        return SanitizedJSONResponse({"error": "Génération dataset non embarquée — lancez python generate_psf_dataset.py dans /home/pat/Programmes/Collimation"}, status_code=501)

    @app.get("/api/collimation/dataset/status")
    async def collim_dataset_status():
        with _lock:
            s = _state["dataset"].copy()
        s["allow_training"] = _allow_training()
        s["is_rpi"] = _is_rpi()
        return SanitizedJSONResponse(s)

    @app.post("/api/collimation/train/start")
    async def collim_train_start(body: dict = {}):
        if not _allow_training():
            return SanitizedJSONResponse(
                {"error": "Entraînement désactivé sur RPi. Lancez train_model.py sur Orion",
                 "is_rpi": True, "allow_training": False}, status_code=403)
        return SanitizedJSONResponse({"error": "Entraînement non embarqué — lancez python train_model.py dans /home/pat/Programmes/Collimation"}, status_code=501)

    @app.get("/api/collimation/train/status")
    async def collim_train_status():
        with _lock:
            s = _state["train"].copy()
        s["allow_training"] = _allow_training()
        s["is_rpi"] = _is_rpi()
        return SanitizedJSONResponse(s)
