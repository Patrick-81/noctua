"""Config, UI and site routes."""

from typing import TYPE_CHECKING

import yaml

from ..cities import search_cities
from .common import log

if TYPE_CHECKING:
    from ..server import WebServer


def register(app, server: "WebServer") -> None:
    @app.get("/api/config")
    async def get_config():
        return {
            "site": server.site,
            "telescope": server.telescope,
            "exposure": server.exposure_cfg,
        }

    @app.post("/api/config")
    async def set_config(body: dict):
        if "site" in body and isinstance(body["site"], dict):
            server.site.update(body["site"])
        if "telescope" in body and isinstance(body["telescope"], dict):
            server.telescope.update(body["telescope"])
        if "exposure" in body and isinstance(body["exposure"], dict):
            server.exposure_cfg.update(body["exposure"])
        if server.config_path and server.config_path.exists():
            with open(server.config_path) as f:
                cfg = yaml.safe_load(f) or {}
            cfg["site"] = server.site
            cfg["telescope"] = server.telescope
            cfg["exposure"] = server.exposure_cfg
            with open(server.config_path, "w") as f:
                yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)
            log.info("Config saved to %s", server.config_path)
        return {"ok": True, "site": server.site, "telescope": server.telescope,
                "exposure": server.exposure_cfg}

    @app.get("/api/ui")
    async def get_ui():
        if server.ui_path and server.ui_path.exists():
            with open(server.ui_path) as f:
                return yaml.safe_load(f) or {}
        return {}

    @app.post("/api/ui")
    async def set_ui(body: dict):
        if not server.ui_path:
            return {"error": "ui_path not configured"}
        with open(server.ui_path, "w") as f:
            yaml.dump(body, f, default_flow_style=False, sort_keys=False)
        return {"ok": True}

    @app.get("/api/site")
    async def get_site():
        return {
            "name": server.site.get("name", ""),
            "latitude": server.site.get("latitude", 0.0),
            "longitude": server.site.get("longitude", 0.0),
            "elevation": server.site.get("elevation", 0.0),
            "timezone": server.site.get("timezone", "UTC"),
        }

    @app.post("/api/site")
    async def set_site(body: dict):
        server.site = {
            "name": body.get("name", ""),
            "latitude": body.get("latitude", 0.0),
            "longitude": body.get("longitude", 0.0),
            "elevation": body.get("elevation", 0.0),
            "timezone": body.get("timezone", "UTC"),
        }
        if server.config_path and server.config_path.exists():
            with open(server.config_path) as f:
                cfg = yaml.safe_load(f) or {}
            cfg["site"] = server.site
            with open(server.config_path, "w") as f:
                yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)
            log.info("Site config saved to %s", server.config_path)
        return {"ok": True, "site": server.site}

    @app.get("/api/site/cities")
    async def get_cities(q: str = ""):
        return search_cities(q)
