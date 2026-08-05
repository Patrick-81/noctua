"""profiles.py — Hardware profile persistence (YAML).

A profile bundles the devices that make up a rig:
mount, camera, guide camera, focuser (optional),
filter wheel (optional) and optics (optional).
"""

from __future__ import annotations

import logging
from pathlib import Path

import yaml

log = logging.getLogger("indigo.profiles")

PROFILE_FIELDS = ["mount", "camera", "guide_camera", "focuser", "filter_wheel", "optics"]

ROLE_LABELS = {
    "mount": "Monture",
    "camera": "Caméra",
    "guide_camera": "Caméra guide",
    "focuser": "Focuser",
    "filter_wheel": "Roue à filtres",
}


class ProfileStore:
    """Load/save hardware profiles from a YAML file."""

    def __init__(self, path: Path | None = None):
        self.path = path
        self.data: dict = {"active": None, "profiles": []}
        if path:
            self.load()

    def load(self) -> None:
        if not self.path or not self.path.exists():
            self.data = {"active": None, "profiles": []}
            return
        try:
            with open(self.path) as f:
                data = yaml.safe_load(f) or {}
            self.data = {
                "active": data.get("active"),
                "profiles": data.get("profiles", []),
            }
        except Exception:
            log.exception("Failed to load profiles from %s", self.path)
            self.data = {"active": None, "profiles": []}

    def save(self) -> None:
        if not self.path:
            return
        with open(self.path, "w") as f:
            yaml.dump(self.data, f, default_flow_style=False, sort_keys=False)

    def list_profiles(self) -> dict:
        return {"active": self.data.get("active"), "profiles": self.data.get("profiles", [])}

    def get(self, name: str) -> dict | None:
        for p in self.data.get("profiles", []):
            if p.get("name") == name:
                return dict(p)
        return None

    def upsert(self, profile: dict) -> dict:
        """Create or update a profile. Returns {ok, profile, active} or {error}."""
        name = profile.get("name")
        if not name or not str(name).strip():
            return {"error": "profile name required"}
        name = str(name).strip()
        clean = {"name": name}
        for field in PROFILE_FIELDS:
            val = profile.get(field)
            if isinstance(val, str) and val.strip():
                clean[field] = val.strip()
            else:
                clean[field] = None
        profiles = self.data.setdefault("profiles", [])
        for i, p in enumerate(profiles):
            if p.get("name") == name:
                profiles[i] = clean
                break
        else:
            profiles.append(clean)
        if not self.data.get("active"):
            self.data["active"] = name
        self.save()
        return {"ok": True, "profile": clean, "active": self.data["active"]}

    def delete(self, name: str) -> dict:
        profiles = self.data.get("profiles", [])
        before = len(profiles)
        self.data["profiles"] = [p for p in profiles if p.get("name") != name]
        if len(self.data["profiles"]) == before:
            return {"ok": True, "deleted": False}
        if self.data.get("active") == name:
            self.data["active"] = (
                self.data["profiles"][0]["name"] if self.data["profiles"] else None
            )
        self.save()
        return {"ok": True, "deleted": True}

    def set_active(self, name: str) -> dict:
        if not self.get(name):
            return {"error": f"profile '{name}' not found"}
        self.data["active"] = name
        self.save()
        return {"ok": True, "active": name}

    def devices_for(self, name: str) -> list[str]:
        """All non-null device names referenced by a profile (optics excluded)."""
        p = self.get(name)
        if not p:
            return []
        device_fields = [f for f in PROFILE_FIELDS if f != "optics"]
        return [p[f] for f in device_fields if p.get(f)]
