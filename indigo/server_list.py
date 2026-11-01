"""server_list.py — INDI/INDIGO server list persistence (YAML).

Manages a list of known INDI/INDIGO servers that the user can select
from in the UI. Each server has a name, host, port, and protocol.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from pathlib import Path

import yaml

log = logging.getLogger("indigo.server_list")

SERVER_FIELDS = ["name", "host", "port", "protocol"]


class ServerStore:
    """Load/save INDI/INDIGO server list from a YAML file."""

    def __init__(self, path: Path | None = None):
        self.path = path
        self.data: dict = {"servers": []}
        if path:
            self.load()

    def load(self) -> None:
        if not self.path or not self.path.exists():
            self.data = {"servers": []}
            return
        try:
            with open(self.path) as f:
                data = yaml.safe_load(f) or {}
            self.data = {"servers": data.get("servers", [])}
        except Exception:
            log.exception("Failed to load server list from %s", self.path)
            self.data = {"servers": []}

    def save(self) -> None:
        if not self.path:
            return
        with open(self.path, "w") as f:
            yaml.dump(self.data, f, default_flow_style=False, sort_keys=False)

    def list_servers(self) -> list[dict]:
        return [dict(s) for s in self.data.get("servers", [])]

    def get(self, name: str) -> dict | None:
        for s in self.data.get("servers", []):
            if s.get("name") == name:
                return dict(s)
        return None

    def upsert(self, server: dict) -> dict:
        """Create or update a server entry. Returns {ok, server} or {error}."""
        name = server.get("name")
        host = server.get("host")
        if not name or not str(name).strip():
            return {"error": "server name required"}
        if not host or not str(host).strip():
            return {"error": "host required"}
        name = str(name).strip()
        host = str(host).strip()
        port = int(server.get("port", 7624))
        protocol = server.get("protocol", "connect")
        clean = {
            "name": name,
            "host": host,
            "port": port,
            "protocol": protocol if protocol in ("connect", "tls") else "connect",
        }
        servers = self.data.setdefault("servers", [])
        for i, s in enumerate(servers):
            if s.get("name") == name:
                servers[i] = clean
                break
        else:
            servers.append(clean)
        self.save()
        return {"ok": True, "server": clean}

    def delete(self, name: str) -> dict:
        servers = self.data.get("servers", [])
        before = len(servers)
        self.data["servers"] = [s for s in servers if s.get("name") != name]
        if len(self.data["servers"]) == before:
            return {"ok": True, "deleted": False}
        self.save()
        return {"ok": True, "deleted": True}

    @staticmethod
    async def ping(host: str, port: int, timeout: float = 2.0) -> dict:
        """Test TCP connectivity to a server. Returns {ok, reachable, error}."""
        try:
            loop = asyncio.get_event_loop()
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ok": True, "reachable": True}
        except asyncio.TimeoutError:
            return {"ok": True, "reachable": False, "error": "timeout"}
        except (ConnectionRefusedError, OSError) as e:
            return {"ok": True, "reachable": False, "error": str(e)}
