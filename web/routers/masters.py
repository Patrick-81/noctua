"""Master calibration library routes (Lot C1)."""

import asyncio
import os
from typing import TYPE_CHECKING

from .common import SanitizedJSONResponse

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    def _lib():
        return server.masters

    @app.get("/api/masters")
    async def masters_status():
        return SanitizedJSONResponse(_lib().status())

    @app.post("/api/masters/build")
    async def masters_build(body: dict):
        """Build a master from a directory of raw FITS frames."""
        src = body.get("source_dir") or body.get("files") or ""
        if not src:
            return {"ok": False, "error": "source_dir requis"}
        if isinstance(src, list):
            src = [os.path.expanduser(p) for p in src]
        else:
            src = os.path.expanduser(src)
        name = (body.get("name") or "").rstrip(".fits")
        res = await asyncio.to_thread(
            _lib().build, src,
            body.get("frame_type") or "flat",
            name=name,
            filter_name=body.get("filter"),
            binning=body.get("binning"),
            temperature=body.get("temperature"),
            exposure=body.get("exposure"),
        )
        return SanitizedJSONResponse(res)

    @app.post("/api/masters/resolve")
    async def masters_resolve(body: dict):
        """Best master for a requested acquisition context."""
        rec = _lib().resolve(
            body.get("frame_type") or "light",
            filter_name=body.get("filter") or "",
            binning=body.get("binning") or "",
            temperature=body.get("temperature"),
            exposure=body.get("exposure"),
        )
        return SanitizedJSONResponse({"match": rec})

    @app.post("/api/masters/delete")
    async def masters_delete(body: dict):
        name = (body.get("name") or "").rstrip(".fits")
        if not name:
            return {"ok": False, "error": "name requis"}
        return SanitizedJSONResponse(_lib().delete(name))

    @app.post("/api/masters/calibrate")
    async def masters_calibrate(body: dict):
        """Résout bias/dark/flat puis les injecte dans le live stack."""
        res = _lib().resolve_all(
            filter_name=body.get("filter") or "",
            binning=body.get("binning") or "",
            temperature=body.get("temperature"),
            exposure=body.get("exposure"),
        )
        loaded = await asyncio.to_thread(
            server.stacking.build_masters,
            bias_dir=res["bias"], dark_dir=res["dark"], flat_dir=res["flat"])
        return SanitizedJSONResponse({"resolved": res, "calibration": loaded})