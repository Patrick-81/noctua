"""Aberration & Tilt atelier — router FastAPI.

Endpoints :
  GET  /api/aberration/status          -> résumé (viewer dispo, dernier header)
  POST /api/aberration/analyze         -> analyse image (last capture / upload / load_path / raw bytes)
  GET  /api/aberration/header          -> header FITS dernier capture (via fitsmeta)

Utilise indigo/devices/aberration.py (pur) + fitsmeta pour header.
Réutilise le viewer capture (captureViewer) côté front.
"""

from __future__ import annotations

import base64
import time
import traceback
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import Query, UploadFile, File
from fastapi.responses import Response

from .common import SanitizedJSONResponse, log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:

    @app.get("/api/aberration/status")
    async def aberr_status():
        hdr = {}
        last = getattr(server, "_last_image_data", b"")
        if last:
            try:
                from indigo.devices.fitsmeta import read_header
                vals, _cards, hb = read_header(last)
                hdr = {k: vals[k] for k in list(vals)[:12]}
                hdr["_header_bytes"] = hb
            except Exception:
                pass
        return SanitizedJSONResponse({
            "ok": True,
            "has_last_image": bool(last),
            "last_header": hdr,
            "viewer": "capture",  # réutilise captureViewer
        })

    @app.get("/api/aberration/header")
    async def aberr_header():
        data = getattr(server, "_last_image_data", b"")
        if not data:
            return SanitizedJSONResponse({"ok": False, "error": "Aucune image capturée — capturez ou chargez un FITS"}, status_code=404)
        try:
            from indigo.devices.fitsmeta import read_header
            vals, cards, hb = read_header(data)
            return SanitizedJSONResponse({"ok": True, "header": vals, "cards": cards[:40], "header_bytes": hb})
        except Exception as e:
            return SanitizedJSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.post("/api/aberration/analyze")
    async def aberr_analyze(body: dict = {}):
        """
        Body :
          {"source": "last"}                      -> dernière capture (défaut)
          {"source": "load_path", "path": "/..."} -> fichier/ dossier serveur
          {"source": "base64", "data": "base64...", "filename": "image.fits"}
        """
        src = (body or {}).get("source", "last")
        data: bytes | None = None
        filename = ""

        if src == "last":
            data = getattr(server, "_last_image_data", b"")
            if not data:
                return SanitizedJSONResponse({"ok": False, "error": "Aucune image capturée — capturez ou chargez un FITS"}, status_code=404)
            filename = "last_capture.fits"
        elif src == "load_path":
            path = (body or {}).get("path", "").strip()
            if not path:
                return SanitizedJSONResponse({"ok": False, "error": "Chemin vide"}, status_code=400)
            p = Path(path)
            if not p.exists():
                return SanitizedJSONResponse({"ok": False, "error": f"Chemin introuvable : {path}"}, status_code=404)
            if p.is_dir():
                exts = (".fit", ".fits", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy")
                files = sorted([f for f in p.iterdir() if f.is_file() and f.suffix.lower() in exts],
                               key=lambda f: f.stat().st_mtime, reverse=True)
                if not files:
                    return SanitizedJSONResponse({"ok": False, "error": f"Aucun FITS dans {path}"}, status_code=404)
                p = files[0]
            ext = p.suffix.lower()
            if ext in (".fit", ".fits"):
                data = p.read_bytes()
            elif ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy"):
                # Pour PNG/NPY on passe par analyze_file directement
                try:
                    from indigo.devices.aberration import analyze_file
                    res = analyze_file(str(p))
                    res["filename"] = p.name
                    res["path"] = str(p)
                    return SanitizedJSONResponse(res)
                except Exception as e:
                    traceback.print_exc()
                    return SanitizedJSONResponse({"ok": False, "error": str(e)}, status_code=500)
            else:
                return SanitizedJSONResponse({"ok": False, "error": f"Format non supporté : {ext}"}, status_code=400)
            filename = p.name
        elif src == "base64":
            b64 = (body or {}).get("data", "")
            if not b64:
                return SanitizedJSONResponse({"ok": False, "error": "data base64 vide"}, status_code=400)
            try:
                data = base64.b64decode(b64)
            except Exception as e:
                return SanitizedJSONResponse({"ok": False, "error": f"base64 invalide: {e}"}, status_code=400)
            filename = (body or {}).get("filename", "upload.fits")
        else:
            return SanitizedJSONResponse({"ok": False, "error": f"source inconnue: {src}"}, status_code=400)

        if not data:
            return SanitizedJSONResponse({"ok": False, "error": "Aucune donnée image"}, status_code=400)

        try:
            from indigo.devices.aberration import analyze_image
            # Exécuter dans thread pour ne pas bloquer l'event loop (HFR sur 80 étoiles)
            import asyncio
            res = await asyncio.to_thread(analyze_image, data)
            res["filename"] = filename
            return SanitizedJSONResponse(res)
        except Exception as e:
            traceback.print_exc()
            return SanitizedJSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.get("/api/aberration/image")
    async def aberr_image(path: str = Query(...), max_bytes: int = Query(50 * 1024 * 1024)):
        """Retourne le FITS brut pour affichage dans le viewer (aperçu)."""
        p = Path(path)
        if not p.exists() or not p.is_file():
            return SanitizedJSONResponse({"ok": False, "error": f"Introuvable: {path}"}, status_code=404)
        if p.stat().st_size > max_bytes:
            return SanitizedJSONResponse({"ok": False, "error": f"Fichier trop gros ({p.stat().st_size} > {max_bytes})"}, status_code=413)
        data = p.read_bytes()
        # Déduit media type simple
        ctype = "application/octet-stream"
        if p.suffix.lower() in (".png",): ctype = "image/png"
        elif p.suffix.lower() in (".jpg", ".jpeg"): ctype = "image/jpeg"
        return Response(content=data, media_type=ctype, headers={"Content-Disposition": f'inline; filename="{p.name}"'})

    @app.post("/api/aberration/upload")
    async def aberr_upload(file: UploadFile = File(...)):
        try:
            data = await file.read()
            ext = Path(file.filename or "image.fits").suffix.lower()
            if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".npy"):
                # Sauver temp et passer par analyze_file
                import tempfile
                tmp = Path(tempfile.gettempdir()) / f"aberr_{file.filename or 'image.fits'}"
                tmp.write_bytes(data)
                from indigo.devices.aberration import analyze_file
                import asyncio
                res = await asyncio.to_thread(analyze_file, str(tmp))
                res["filename"] = file.filename or "upload"
                return SanitizedJSONResponse(res)
            from indigo.devices.aberration import analyze_image
            import asyncio
            res = await asyncio.to_thread(analyze_image, data)
            res["filename"] = file.filename or "upload.fits"
            return SanitizedJSONResponse(res)
        except Exception as e:
            traceback.print_exc()
            return SanitizedJSONResponse({"ok": False, "error": str(e)}, status_code=500)
