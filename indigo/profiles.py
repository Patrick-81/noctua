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

PROFILE_FIELDS = ["mount", "camera", "guide_camera", "focuser", "filter_wheel", "optics",
                  "mount_interface", "mount_endpoint"]

# Réglages par device persistés : {device: {PROP: {item: value}}}
# Ex. {"SVBONY SV305PRO": {"CCD_MODE": {"RAW 16 1x1": True}, "CCD_GAIN": {"GAIN": 150}}}
# Appliqués (best-effort) à la connexion du device, avant toute acquisition.
DEVICE_SETTINGS_FIELD = "device_settings"

ROLE_LABELS = {
    "mount": "Monture",
    "camera": "Caméra",
    "guide_camera": "Caméra guide",
    "focuser": "Focuser",
    "filter_wheel": "Roue à filtres",
}


def _clean_device_settings(ds) -> dict:
    """Nettoie {device: {PROP: {item: value}}} : que des str non vides et
    des valeurs JSON (bool/num/str). Entrées vides écartées."""
    if not isinstance(ds, dict):
        return {}
    clean: dict = {}
    for dev, props in ds.items():
        if not isinstance(dev, str) or not dev.strip() or not isinstance(props, dict):
            continue
        cprops: dict = {}
        for prop, items in props.items():
            if not isinstance(prop, str) or not prop.strip() or not isinstance(items, dict):
                continue
            citems = {k: v for k, v in items.items()
                      if isinstance(k, str) and k.strip()
                      and isinstance(v, (bool, int, float, str))}
            if citems:
                cprops[prop.strip()] = citems
        if cprops:
            clean[dev.strip()] = cprops
    return clean


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
            if field == "mount_interface":
                v = str(val).strip().lower() if isinstance(val, str) else ""
                clean[field] = v if v in ("serial", "network") else None
                continue
            if isinstance(val, str) and val.strip():
                clean[field] = val.strip()
            else:
                clean[field] = None
        # Réglages par device : conservés tels quels (dicts nettoyés aux
        # str/num/bool, props et items non vides uniquement).
        ds = profile.get(DEVICE_SETTINGS_FIELD)
        clean[DEVICE_SETTINGS_FIELD] = _clean_device_settings(ds)
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

    def set_device_settings(self, profile_name: str, device: str, settings: dict) -> dict:
        """Mémorise les réglages d'un device dans un profil (merge par device)."""
        for p in self.data.get("profiles", []):
            if p.get("name") == profile_name:
                ds = p.setdefault(DEVICE_SETTINGS_FIELD, {})
                if not isinstance(ds, dict):
                    ds = p[DEVICE_SETTINGS_FIELD] = {}
                cleaned = _clean_device_settings({device: settings}).get(device) if settings else None
                if cleaned:
                    ds[device] = cleaned
                else:
                    ds.pop(device, None)
                self.save()
                return {"ok": True, "device_settings": ds}
        return {"error": f"profile '{profile_name}' not found"}

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
        """All non-null device names referenced by a profile (optics/interface excluded)."""
        p = self.get(name)
        if not p:
            return []
        device_fields = ["mount", "camera", "guide_camera", "focuser", "filter_wheel"]
        return [p[f] for f in device_fields if p.get(f)]
