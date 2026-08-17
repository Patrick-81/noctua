"""WebSocket and dev-only test endpoints."""

import base64 as _b64
import json
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect

from .common import _sanitize, log

if TYPE_CHECKING:
    from ..server import WebServer

FAKE_SKY = Path(__file__).parent.parent.parent / "tests" / "fake_sky"


def register(app, server: "WebServer") -> None:
    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        from ..weblog import handler as weblog_handler
        await ws.accept()
        server._ws_clients.append(ws)
        weblog_handler.add_client(ws)
        log.debug("WS client connected (%d total)", len(server._ws_clients))
        try:
            # Send current state immediately
            state = {
                name: dev.state_dict()
                for name, dev in server.registry.all_devices().items()
            }
            await ws.send_json(_sanitize({"type": "state", "devices": state}))

            # Keep connection alive, listen for client messages
            while True:
                data = await ws.receive_text()
                await server._handle_ws_command(json.loads(data))
        except WebSocketDisconnect:
            pass
        finally:
            if ws in server._ws_clients:
                server._ws_clients.remove(ws)
            weblog_handler.remove_client(ws)
            log.debug("WS client disconnected (%d remaining)", len(server._ws_clients))

    # ── Test endpoints (dev only) ─────────────────────────────

    @app.get("/api/test/fits-list")
    async def test_fits_list():
        """List available synthetic FITS test images."""
        if not FAKE_SKY.exists():
            return {"images": []}
        images = []
        for p in sorted(FAKE_SKY.glob("test_*.fits")):
            name = p.stem.replace("test_", "")
            meta_path = p.with_suffix(".json")
            meta = {}
            if meta_path.exists():
                meta = json.loads(meta_path.read_text())
            images.append({
                "name": name,
                "file": p.name,
                "ra": meta.get("center_ra"),
                "dec": meta.get("center_dec"),
                "scale": meta.get("scale_arcsec_px"),
                "stars": meta.get("n_stars"),
            })
        return {"images": images}

    @app.get("/api/test/fits/{filename}")
    async def test_fits_get(filename: str):
        """Return a synthetic FITS file as base64 for viewer testing."""
        filepath = FAKE_SKY / filename
        if not filepath.exists() or not filepath.suffix == ".fits":
            return {"error": f"File not found: {filename}"}
        data = filepath.read_bytes()
        return {
            "ok": True,
            "filename": filename,
            "format": "image/fits",
            "data": _b64.b64encode(data).decode("ascii"),
            "size": len(data),
        }

    @app.post("/api/test/fits-store")
    async def test_fits_store(body: dict):
        """Store a FITS image (base64) as last captured image for solver testing.
        Send empty/null data to clear the stored image."""
        b64_data = body.get("data", "")
        if not b64_data:
            server._last_image_data = b""
            return {"ok": True, "size": 0, "cleared": True}
        server._last_image_data = _b64.b64decode(b64_data)
        log.info("Test FITS stored as last image (%d bytes)", len(server._last_image_data))
        return {"ok": True, "size": len(server._last_image_data)}
