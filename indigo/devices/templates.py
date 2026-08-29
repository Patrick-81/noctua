"""templates.py — Séquence templates persistence (YAML) — Lot C3.

Named, reusable acquisition plans (L, RGB, Ha…) persisted to disk and
shareable via a JSON export/import format.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import yaml

from .sequence import total_frames, validate_frames

log = logging.getLogger("indigo.templates")

EXPORT_VERSION = "noctua-sequence-templates/1"


def _iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class SequenceTemplateStore:
    """Load/save named sequence templates from a YAML file."""

    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path else None
        self.data: dict = {"templates": []}
        if self.path:
            self.load()

    def load(self) -> None:
        if not self.path or not self.path.exists():
            self.data = {"templates": []}
            return
        try:
            with open(self.path) as f:
                data = yaml.safe_load(f) or {}
            self.data = {"templates": list(data.get("templates", []) or [])}
        except Exception:
            log.exception("Failed to load templates from %s", self.path)
            self.data = {"templates": []}

    def save(self) -> None:
        if not self.path:
            return
        try:
            with open(self.path, "w") as f:
                yaml.dump(self.data, f, default_flow_style=False, sort_keys=False)
        except Exception:
            log.exception("Failed to save templates to %s", self.path)

    # ── access ───────────────────────────────────────────────

    def list(self) -> list[dict]:
        return sorted((dict(t) for t in self.data.get("templates", [])),
                      key=lambda t: (t.get("name") or "").lower())

    def get(self, name: str) -> dict | None:
        for t in self.data.get("templates", []):
            if t.get("name") == name:
                return dict(t)
        return None

    # ── mutations ────────────────────────────────────────────

    def _insert(self, name: str, frames: list, save: bool) -> dict:
        entry = {"name": name, "frames": frames,
                 "count": total_frames(frames), "updated_at": _iso()}
        templates = self.data.setdefault("templates", [])
        for i, t in enumerate(templates):
            if t.get("name") == name:
                templates[i] = entry
                break
        else:
            templates.append(entry)
        if save:
            self.save()
        return {"ok": True, "template": entry}

    def upsert(self, name: str, frames: list) -> dict:
        """Create or update a named template. Returns {ok, template} or {ok:False, error}."""
        name = str(name or "").strip()
        if not name:
            return {"ok": False, "error": "nom de template requis"}
        err = validate_frames(frames)
        if err:
            return {"ok": False, "error": err}
        return self._insert(name, frames, save=True)

    def delete(self, name: str) -> dict:
        templates = self.data.get("templates", [])
        before = len(templates)
        self.data["templates"] = [t for t in templates if t.get("name") != name]
        if len(self.data["templates"]) == before:
            return {"ok": True, "deleted": False}
        self.save()
        return {"ok": True, "deleted": True}

    def clear(self) -> None:
        self.data["templates"] = []
        self.save()

    def import_data(self, obj) -> dict:
        """Import templates from export format: a single template, a list, or
        {"templates": [...]}. Returns {ok, imported, errors}."""
        raw = obj
        if isinstance(raw, dict):
            raw = raw.get("templates", [raw])
        if not isinstance(raw, list):
            return {"ok": False, "error": "format d'import invalide",
                    "imported": 0, "errors": 1}
        imported = 0
        errors = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("frames"):
                errors.append("entrée invalide")
                continue
            name = str(item.get("name", "")).strip()
            if not name or validate_frames(item.get("frames")):
                errors.append(f"{name or '?'}: nom ou plan invalide")
                continue
            self._insert(name, item.get("frames"), save=False)
            imported += 1
        self.save()
        return {"ok": True, "imported": imported, "errors": errors}

    def export(self) -> dict:
        return {
            "version": EXPORT_VERSION,
            "exported_at": _iso(),
            "templates": self.list(),
        }