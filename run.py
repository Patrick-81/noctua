#!/usr/bin/env python3
"""
run.py — INDIGO Devices server.

Starts:
  1. WebSocket client → connects to INDIGO server
  2. FastAPI web server → serves UI on LAN

Usage:
    python run.py                     # uses config.yaml
    python run.py 192.168.1.100:7624  # override INDIGO server
    python run.py --port 8080         # override web port
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

import uvicorn
import yaml

from indigo.client import IndigoClient
from indigo.registry import DeviceRegistry
from web.server import WebServer

# ── Logging ──────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("indigo.main")


# ── Config ───────────────────────────────────────────────────────

def load_config() -> dict:
    config_path = Path(__file__).parent / "config.yaml"
    if config_path.exists():
        with open(config_path) as f:
            return yaml.safe_load(f) or {}
    return {}


# ── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="INDIGO Devices Server")
    parser.add_argument("indigo_server", nargs="?",
                        help="INDIGO server host:port (default: from config.yaml)")
    parser.add_argument("--port", type=int, default=None,
                        help="Web server port (default: from config.yaml or 8080)")
    parser.add_argument("--host", default=None,
                        help="Web server bind address (default: 0.0.0.0)")
    args = parser.parse_args()

    config = load_config()
    indigo_cfg = config.get("indigo", {})
    web_cfg = config.get("web", {})

    # Determine INDIGO server address
    if args.indigo_server:
        indigo_host_port = args.indigo_server
    else:
        host = indigo_cfg.get("host", "192.168.1.100")
        port = indigo_cfg.get("port", 7624)
        indigo_host_port = f"{host}:{port}"

    # Determine web server settings
    web_host = args.host or web_cfg.get("host", "0.0.0.0")
    web_port = args.port or web_cfg.get("port", 8080)

    log.info("INDIGO server: %s", indigo_host_port)
    log.info("Web server:    http://%s:%d", web_host, web_port)

    # Create INDIGO client + registry
    client = IndigoClient(indigo_host_port)
    registry = DeviceRegistry(client)

    # Create web server
    web = WebServer(registry)

    # Run everything
    async def run_all():
        # Start the INDIGO client in a background task
        indigo_task = asyncio.create_task(client.connect())

        # Start the web server
        config = uvicorn.Config(
            web.app,
            host=web_host,
            port=web_port,
            log_level="info",
        )
        server = uvicorn.Server(config)
        await server.serve()

    try:
        asyncio.run(run_all())
    except KeyboardInterrupt:
        log.info("Shutting down.")


if __name__ == "__main__":
    main()
