"""
plugins/__init__.py — PluginManager (P2.2 light).

Scan ``plugins/*/plugin.yaml`` + chargement ``backend.py``.
Chaque plugin expose une fonction ``register(server)`` qui peut :
- enregistrer un Device type via ``server.registry.register_device_class(Cls)``
- enregistrer des routes via ``server.app`` (FastAPI)
- s'abonner à des événements (Hub/Trigger)

Isolation : une exception dans un plugin n'empêche jamais les autres.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("indigo.plugins")

PLUGINS_DIR = Path(__file__).parent.parent.parent / "plugins"


class PluginManager:
    def __init__(self, plugins_dir: Path | None = None) -> None:
        self.plugins_dir = Path(plugins_dir) if plugins_dir else PLUGINS_DIR
        self._plugins: list[dict[str, Any]] = []
        self._loaded: list[dict[str, Any]] = []

    def scan(self) -> list[dict]:
        """Liste les plugins découverts (sans les charger)."""
        out: list[dict] = []
        if not self.plugins_dir.exists():
            return out
        for pdir in sorted(self.plugins_dir.iterdir()):
            if not pdir.is_dir():
                continue
            manifest = pdir / "plugin.yaml"
            if not manifest.exists():
                continue
            try:
                data = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
                data["_dir"] = str(pdir)
                data["_name"] = data.get("name") or pdir.name
                out.append(data)
            except Exception as e:  # noqa: BLE001
                log.warning("plugin %s: manifest illisible (%s)", pdir.name, e)
        self._plugins = out
        return out

    def load_all(self, server) -> list[dict]:
        """Charge chaque plugin (import backend.py → register(server))."""
        if not self._plugins:
            self.scan()
        loaded: list[dict] = []
        for meta in self._plugins:
            name = meta.get("_name") or meta.get("name")
            pdir = Path(meta.get("_dir"))
            backend = pdir / "backend.py"
            if not backend.exists():
                log.info("plugin %s: pas de backend.py — ignoré", name)
                continue
            try:
                spec = importlib.util.spec_from_file_location(f"plugins.{name}.backend", backend)
                mod = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = mod
                spec.loader.exec_module(mod)
                if hasattr(mod, "register"):
                    mod.register(server)
                    log.info("plugin %s: backend chargé", name)
                    loaded.append({"name": name, "ok": True, "manifest": meta})
                else:
                    log.warning("plugin %s: backend.py sans register(server)", name)
                    loaded.append({"name": name, "ok": False, "error": "no register()"})
            except Exception as e:  # noqa: BLE001
                log.error("plugin %s: chargement échoué (%s)", name, e, exc_info=True)
                loaded.append({"name": name, "ok": False, "error": str(e)})
        self._loaded = loaded
        return loaded

    def status(self) -> dict:
        return {
            "plugins_dir": str(self.plugins_dir),
            "discovered": self._plugins,
            "loaded": self._loaded,
        }
