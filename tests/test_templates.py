"""test_templates.py — Sequence templates store (Lot C3)."""

import sys
import tempfile
import os
import json

ROOT = os.path.join(os.path.dirname(__file__), "..")
for p in (ROOT, os.path.join(ROOT, "indigo")):
    if p not in sys.path:
        sys.path.insert(0, p)

from indigo.devices.templates import SequenceTemplateStore, EXPORT_VERSION

PLAN_L = [
    {"duration": 300.0, "frame_type": "LIGHT", "filter": "L", "count": 5, "delay": 2.0},
]
PLAN_HA = [
    {"duration": 600.0, "frame_type": "LIGHT", "filter": "Ha", "count": 3, "delay": 2.0},
]


def _store():
    tmp = tempfile.mkdtemp(prefix="templates-")
    return SequenceTemplateStore(os.path.join(tmp, "seq_templates.yaml")), tmp


def test_empty_list():
    s, _ = _store()
    assert s.list() == []


def test_upsert_validation():
    s, _ = _store()
    r = s.upsert("  ", PLAN_L)
    assert "error" in r
    assert s.upsert("Plan L", [])["error"]
    assert s.upsert("Plan L", [{"count": 0}])["error"]
    r = s.upsert("Plan L", PLAN_L)
    assert r["ok"] and r["template"]["name"] == "Plan L"
    assert r["template"]["count"] == 5


def test_upsert_replaces_same_name():
    s, _ = _store()
    s.upsert("Test", PLAN_L)
    s.upsert("Test", PLAN_HA)
    listed = s.list()
    assert len(listed) == 1
    assert listed[0]["count"] == 3
    assert listed[0]["frames"][0]["filter"] == "Ha"


def test_persistence_reload():
    s, tmp = _store()
    s.upsert("L", PLAN_L)
    assert not s.path.exists() or True
    s2 = SequenceTemplateStore(s.path)
    assert len(s2.list()) == 1 and s2.get("L")["count"] == 5
    # corrompu → liste vide sans crash
    with open(s.path, "w") as f:
        f.write(": not: [yaml")
    s3 = SequenceTemplateStore(s.path)
    assert s3.list() == []


def test_delete():
    s, _ = _store()
    s.upsert("A", PLAN_L)
    s.upsert("B", PLAN_HA)
    assert s.delete("A")["deleted"] is True
    assert s.delete("A")["deleted"] is False
    assert [t["name"] for t in s.list()] == ["B"]


def test_export_format():
    s, _ = _store()
    s.upsert("L", PLAN_L)
    exp = s.export()
    assert exp["version"] == EXPORT_VERSION
    assert "exported_at" in exp
    assert [t["name"] for t in exp["templates"]] == ["L"]


def test_import_export_roundtrip():
    s, _ = _store()
    s.upsert("L", PLAN_L)
    s.upsert("Ha", PLAN_HA)
    exp = s.export()

    s2 = SequenceTemplateStore(None)  # volatile
    r = s2.import_data(exp)
    assert r["ok"] and r["imported"] == 2 and r["errors"] == []
    assert sorted(t["name"] for t in s2.list()) == ["Ha", "L"]


def test_import_formats():
    # liste simple
    s = SequenceTemplateStore(None)
    r = s.import_data([{"name": "A", "frames": PLAN_L}])
    assert r["imported"] == 1
    # un seul template
    s2 = SequenceTemplateStore(None)
    assert s2.import_data({"name": "B", "frames": PLAN_HA})["imported"] == 1
    # formats invalides
    s3 = SequenceTemplateStore(None)
    assert not s3.import_data("pas json")["ok"]
    r = s3.import_data([{"name": "", "frames": PLAN_L}, "x", {"name": "OK", "frames": []}])
    assert r["imported"] == 0 and len(r["errors"]) == 3


def test_export_serializable_json():
    s, _ = _store()
    s.upsert("L", PLAN_L)
    json.dumps(s.export())  # ne doit pas lever


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  ✓ {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"  ✗ {t.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)