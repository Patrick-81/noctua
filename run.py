#!/usr/bin/env python3
"""
run.py — Noctua server (INDI / indiserver).

Starts:
  1. TCP client → connects to an INDI server (indiserver, port 7624)
  2. FastAPI web server → serves UI on LAN

Drivers are started/stopped through the INDI Web Manager (indi-web,
default http://127.0.0.1:8624), configured via ``indi.web_manager``.

Usage:
    python run.py                     # uses config.yaml
    python run.py <indi_host>:7624    # override INDI server
    python run.py --port 8080         # override web port
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

import uvicorn
import yaml

# Add .venv to path if not already present
if ".venv" in sys.path:
    pass
else:
    venv_path = Path(__file__).parent / ".venv"
    if venv_path.exists():
        sys.path.insert(0, str(venv_path))

import seiza

from indigo.client import IndigoClient
from indigo.indiweb import IndiWebManager
from indigo.registry import DeviceRegistry
from indigo.server_manager import ServerManager
from web.server import WebServer

# ── Logging ──────────────────────────────────────────────────────

log = logging.getLogger("indigo.main")

# ── Config ───────────────────────────────────────────────────────

def load_config(config_path=None) -> dict:
    config_path = Path(config_path) if config_path else (Path(__file__).parent / "config.yaml")
    if config_path.exists():
        with open(config_path) as f:
            return yaml.safe_load(f) or {}
    return {}


def _indiweb_url(indi_cfg: dict) -> str:
    """Resolve the INDI Web Manager URL from config.

    Accepts ``indi.web_manager: "http://host:8624"`` or a mapping
    ``{host, port, url}``. Defaults to ``http://127.0.0.1:8624`` (the
    standard indi-web port); set it to ``false`` to disable the driver
    panel entirely.
    """
    raw = indi_cfg.get("web_manager", indi_cfg.get("indiweb", True))
    if raw is False or raw is None:
        return ""
    if raw is True:
        return "http://127.0.0.1:8624"
    if isinstance(raw, dict):
        url = raw.get("url")
        if url:
            return str(url).rstrip("/")
        host = raw.get("host", "127.0.0.1")
        port = raw.get("port", 8624)
        return f"http://{host}:{port}"
    url = str(raw).strip()
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url.rstrip("/")


# ── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Noctua — INDI devices server")
    parser.add_argument("indi_server", nargs="?",
                        help="INDI server host:port (default: from config.yaml)")
    parser.add_argument("--port", type=int, default=None,
                        help="Web server port (default: from config.yaml or 8080)")
    parser.add_argument("--host", default=None,
                        help="Web server bind address (default: 0.0.0.0)")
    parser.add_argument("--config", default=None,
                        help="Path to config.yaml (default: ./config.yaml)")
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
                        help="Set the logging level (default: INFO)")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    config = load_config(args.config)
    # ``indi`` is the canonical section; ``indigo`` is kept for backward
    # compatibility with existing config.yaml files.
    indi_cfg = config.get("indi") or config.get("indigo", {})
    web_cfg = config.get("web", {})

    # Determine INDI server address
    protocol = indi_cfg.get("protocol", "connect")
    if args.indi_server:
        if ":" not in args.indi_server:
            default_port = indi_cfg.get("port", 7624)
            indi_host_port = f"{args.indi_server}:{default_port}"
        else:
            indi_host_port = args.indi_server
    else:
        host = indi_cfg.get("host", "127.0.0.1")
        port = indi_cfg.get("port", 7624)
        indi_host_port = f"{host}:{port}"

    # Determine web server settings
    web_host = args.host or web_cfg.get("host", "0.0.0.0")
    web_port = args.port or web_cfg.get("port", 8080)

    log.info("INDI server:   %s (%s)", indi_host_port, protocol)
    log.info("Web server:    http://%s:%d", web_host, web_port)

    # INDI Web Manager (driver start/stop) — optional but required for the
    # driver panel when running against indilib.
    indiweb_url = _indiweb_url(indi_cfg)
    indiweb = IndiWebManager(indiweb_url) if indiweb_url else None
    if indiweb_url:
        log.info("INDI Web Manager: %s", indiweb_url)
    else:
        log.info("INDI Web Manager: not configured (driver panel disabled)")

    # Create INDI client + registry
    client = IndigoClient(indi_host_port, protocol=protocol)
    registry = DeviceRegistry(client, indiweb=indiweb)

    # Server management
    server_type = indi_cfg.get("server_type", "indigo")
    auto_start = indi_cfg.get("auto_start", False)
    server_command = indi_cfg.get("server_command")
    if isinstance(server_command, str):
        server_command = server_command.split()
    server_manager = ServerManager(server_type=server_type, host=host, port=port, command=server_command)

    # Create web server
    site_cfg = config.get("site", {})
    telescope_cfg = config.get("telescope", {})
    sequence_cfg = config.get("sequence", {})
    exposure_cfg = config.get("exposure", {})
    config_path = Path(args.config) if args.config else (Path(__file__).parent / "config.yaml")
    ui_path = Path(__file__).parent / "ui.yaml"
    profiles_path = Path(
        os.environ.get("NOCTUA_PROFILES_PATH")
        or os.environ.get("INDIGO_PROFILES_PATH")
        or (Path(__file__).parent / "profiles.yaml"))
    server_list_path = Path(
        os.environ.get("NOCTUA_SERVER_LIST_PATH")
        or os.environ.get("INDIGO_SERVER_LIST_PATH")
        or (Path(__file__).parent / "server_list.yaml"))
    templates_path = Path(
        os.environ.get("NOCTUA_SEQUENCE_TEMPLATES_PATH")
        or os.environ.get("INDIGO_SEQUENCE_TEMPLATES_PATH")
        or (Path(__file__).parent / "sequence_templates.yaml"))
    web = WebServer(registry, site_config=site_cfg, config_path=config_path,
                    ui_path=ui_path, profiles_path=profiles_path,
                    server_list_path=server_list_path,
                    templates_path=templates_path,
                    telescope_config=telescope_cfg, sequence_config=sequence_cfg,
                    exposure_config=exposure_cfg,
                    masters_config=config.get("masters", {}),
                    blob_mode=str(indi_cfg.get("blob_mode", "Also")),
                    prefer_raw16=bool(indi_cfg.get("prefer_raw16", True)))

    # Run everything
    async def run_all():
        # Start the server process if requested
        if auto_start:
            await server_manager.start()

        # Start the INDI client in a background task
        indi_task = asyncio.create_task(client.connect())

        # Start the web server — access_log désactivé pour ne pas
        # flooder le terminal à chaque poll /api/cameras|connection
        config = uvicorn.Config(
            web.app,
            host=web_host,
            port=web_port,
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)
        try:
            await server.serve()
        finally:
            # Arrêt propre : annule la boucle de connexion et ferme la
            # socket INDI — sinon un client fantôme (enableBLOB, etc.)
            # subsiste côté indiserver et la caméra semble « tenue ».
            indi_task.cancel()
            try:
                await indi_task
            except asyncio.CancelledError:
                pass
            except Exception as e:  # noqa: BLE001
                log.warning("indi task end: %s", e)
            try:
                await client.disconnect()
            except Exception as e:  # noqa: BLE001
                log.warning("indi disconnect: %s", e)
            if indiweb is not None:
                try:
                    await indiweb.close()
                except Exception as e:  # noqa: BLE001
                    log.warning("indiweb close: %s", e)
            
            if auto_start:
                await server_manager.stop()

            log.info("Disconnected from INDI server.")

    try:
        asyncio.run(run_all())
    except KeyboardInterrupt:
        log.info("Shutting down.")


if __name__ == "__main__":
    main()
