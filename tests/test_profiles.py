"""
test_profiles.py — Unit tests for the ProfileStore (hardware profiles).
"""

import sys
import os
import tempfile
from pathlib import Path

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.profiles import ProfileStore, PROFILE_FIELDS, ROLE_LABELS  # noqa: E402


def _store():
    tmp = tempfile.mkdtemp()
    return ProfileStore(Path(tmp) / "profiles.yaml")


def test_empty_store():
    s = _store()
    assert s.list_profiles() == {"active": None, "profiles": []}
    assert s.get("Rig") is None


def test_upsert_creates_and_activates_first():
    s = _store()
    r = s.upsert({"name": "Rig", "mount": "Mount", "camera": "Main Camera"})
    assert r["ok"] is True
    assert r["active"] == "Rig"
    assert s.get("Rig")["camera"] == "Main Camera"


def test_upsert_updates_existing():
    s = _store()
    s.upsert({"name": "Rig", "mount": "Mount"})
    r = s.upsert({"name": "Rig", "mount": "Mount2", "camera": "Cam"})
    assert r["ok"] is True
    p = s.get("Rig")
    assert p["mount"] == "Mount2"
    assert p["camera"] == "Cam"


def test_upsert_requires_name():
    s = _store()
    r = s.upsert({"mount": "Mount"})
    assert "error" in r


def test_upsert_normalizes_whitespace_and_none():
    s = _store()
    s.upsert({"name": "Rig", "mount": "  Mount  ", "focuser": ""})
    p = s.get("Rig")
    assert p["mount"] == "Mount"
    assert p["focuser"] is None


def test_fields_complete():
    s = _store()
    s.upsert({"name": "Rig",
              "mount": "Mount", "camera": "Main Camera", "guide_camera": "Guide Camera",
              "focuser": "Focuser", "filter_wheel": "Filter Wheel", "optics": "Newton 200/800"})
    p = s.get("Rig")
    for field in PROFILE_FIELDS:
        assert field in p
    assert p["optics"] == "Newton 200/800"


def test_devices_for_excludes_optics():
    s = _store()
    s.upsert({"name": "Rig",
              "mount": "Mount", "camera": "Main Camera", "guide_camera": "Guide Camera",
              "focuser": "Focuser", "filter_wheel": "Filter Wheel", "optics": "Newton 200/800"})
    devs = s.devices_for("Rig")
    assert "Newton 200/800" not in devs
    assert devs == ["Mount", "Main Camera", "Guide Camera", "Focuser", "Filter Wheel"]


def test_set_active_and_fallback_on_delete():
    s = _store()
    s.upsert({"name": "Rig A"})
    s.upsert({"name": "Rig B"})
    s.set_active("Rig B")
    assert s.list_profiles()["active"] == "Rig B"
    s.delete("Rig B")
    assert s.list_profiles()["active"] == "Rig A"
    s.delete("Rig A")
    assert s.list_profiles()["active"] is None


def test_delete_unknown_is_not_error():
    s = _store()
    r = s.delete("Nope")
    assert r["ok"] is True
    assert r["deleted"] is False


def test_set_active_unknown():
    s = _store()
    r = s.set_active("Nope")
    assert "error" in r


def test_persistence():
    tmp = tempfile.mkdtemp()
    path = Path(tmp) / "profiles.yaml"
    s = ProfileStore(path)
    s.upsert({"name": "Rig", "mount": "Mount"})
    s2 = ProfileStore(path)
    assert s2.get("Rig")["mount"] == "Mount"


def test_role_labels():
    assert ROLE_LABELS["mount"] == "Monture"
    assert ROLE_LABELS["guide_camera"] == "Caméra guide"
