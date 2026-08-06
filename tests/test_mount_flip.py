"""
test_mount_flip.py — Integration tests for meridian flip (backend).

Tests: mock INDIGO + web server + /api/config (telescope block) +
/api/mount/flip/status + /api/mount/flip.

Run via: python tests/test_mount_flip.py
"""

__test__ = False  # pytest: run via python tests/test_mount_flip.py

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python")
MOCK_PORT = 17640
WEB_PORT = 18099
BASE_URL = f"http://127.0.0.1:{WEB_PORT}"

passed = 0
failed = 0


def check(condition, msg):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {msg}")
    else:
        failed += 1
        print(f"  ✗ FAIL: {msg}")


def api_get(path):
    try:
        resp = urllib.request.urlopen(f"{BASE_URL}{path}", timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def api_post(path, data=None):
    try:
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{BASE_URL}{path}", data=body,
                                     headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def wait_for(url, timeout=20):
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = urllib.request.urlopen(url, timeout=2)
            resp.read()
            return True
        except Exception:
            time.sleep(0.5)
    return False


def wait_until(predicate, timeout=8, interval=0.3):
    start = time.time()
    while time.time() - start < timeout:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def kill_proc(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ── Tests ───────────────────────────────────────────────────

def test_config_has_telescope_block():
    print("\n=== Test: /api/config exposes telescope block ===")
    r = api_get("/api/config")
    check("telescope" in r, "config has telescope block")
    tel = r.get("telescope", {})
    check("flip_enabled" in tel, "telescope has flip_enabled")
    check("hour_angle_margin" in tel, "telescope has hour_angle_margin")
    check("min_altitude" in tel, "telescope has min_altitude")


def test_config_persist_telescope():
    print("\n=== Test: POST /api/config persists telescope ===")
    r = api_post("/api/config", {"telescope": {"hour_angle_margin": 1.0, "min_altitude": 10.0}})
    check(r.get("ok") is True, "POST /api/config ok")
    check(abs(r["telescope"]["hour_angle_margin"] - 1.0) < 1e-6, "margin persisted to 1.0")
    check(abs(r["telescope"]["min_altitude"] - 10.0) < 1e-6, "min_altitude persisted to 10.0")
    # restore
    api_post("/api/config", {"telescope": {"hour_angle_margin": 0.0, "min_altitude": 5.0}})


def test_mount_flip_status_shape():
    print("\n=== Test: /api/mount/flip/status shape ===")
    r = api_get("/api/mount/flip/status")
    check("error" not in r, "no error")
    for key in ("enabled", "lst_deg", "ha_hours", "ha_fmt", "flip_due",
                "flip_side", "time_to_flip_fmt", "hour_angle_margin", "min_altitude"):
        check(key in r, f"flip status has '{key}'")
    check(r["ha_hours"] is not None, f"ha_hours computed ({r['ha_hours']})")
    check(r["flip_side"] in ("est", "ouest", "meridien", "inconnu"), "flip_side known")
    check(r["enabled"] is True, "flip_enabled default True from config")


def test_mount_state_has_flip():
    print("\n=== Test: /api/mount carries flip block ===")
    r = api_get("/api/mount")
    check(r.get("type") == "mount", "mount detected")
    check("flip" in r, "mount state has flip block")
    f = r.get("flip", {})
    check("ha_fmt" in f, "flip.ha_fmt present")
    check("alt_deg" in r, "mount alt_deg present")
    check(r["alt_deg"] > -90, f"mock altitude realistic ({r['alt_deg']})")


def test_flip_executes():
    print("\n=== Test: POST /api/mount/flip executes sequence ===")
    r = api_post("/api/mount/flip")
    check(r.get("ok") is True, f"flip ok (got {r.get('error')})")
    phases = r.get("phases", [])
    check(len(phases) >= 3, f"flip has phases ({phases})")
    check(any("slew" in p for p in phases), "flip includes a slew phase")
    target = r.get("target", {})
    check("ra_hours" in target and "dec_deg" in target, "flip returns target coords")
    # Mount should be slewing to the same target after flip
    st = api_get("/api/mount")
    check(st.get("slewing") is True, "mount slewing after flip")


def test_flip_due_respects_altitude():
    print("\n=== Test: flip_due respects min altitude ===")
    r = api_get("/api/mount/flip/status")
    alt = api_get("/api/mount").get("alt_deg")
    margin = r.get("hour_angle_margin", 0.0)
    ha = r.get("ha_hours")
    if ha is not None and alt is not None and alt >= margin and alt >= r.get("min_altitude", 0):
        # HA may be negative (east) → not due regardless
        if ha >= 0:
            check(r["flip_due"] is True, "flip_due true when HA west + above min alt")
        else:
            check(r["flip_due"] is False, "flip_due false when HA east")
    else:
        print("  (skip — target currently east or below horizon)")


# ── Main ───────────────────────────────────────────────────

if __name__ == "__main__":
    tmpdir = tempfile.mkdtemp(prefix="flip-")
    config_path = os.path.join(tmpdir, "config.yaml")
    profiles_path = os.path.join(tmpdir, "profiles.yaml")
    with open(config_path, "w") as f:
        f.write(f"""
indigo:
  host: 127.0.0.1
  port: {MOCK_PORT}
web:
  host: 127.0.0.1
  port: {WEB_PORT}
site:
  name: Test
  latitude: 43.952
  longitude: 1.568
  elevation: 210
  timezone: Europe/Paris
telescope:
  flip_enabled: true
  hour_angle_margin: 0.0
  min_altitude: 5.0
  flip_slew_rate: Centering
  recenter_after_flip: true
""")

    try:
        subprocess.run(["fuser", "-k", f"{MOCK_PORT}/tcp"], timeout=2, capture_output=True)
        subprocess.run(["fuser", "-k", f"{WEB_PORT}/tcp"], timeout=2, capture_output=True)
    except Exception:
        pass
    time.sleep(0.5)

    print("\nStarting mock INDIGO server...")
    mock_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "tests", "mock_indigo.py"), "--port", str(MOCK_PORT)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    time.sleep(1.5)

    print("Starting web server...")
    env = dict(os.environ)
    env["INDIGO_PROFILES_PATH"] = profiles_path
    web_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{MOCK_PORT}", "--port", str(WEB_PORT),
         "--config", config_path],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env
    )

    if not wait_for(f"{BASE_URL}/api/connection", timeout=20):
        print("ERROR: Web server failed to start")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        sys.exit(1)

    print("Waiting for INDIGO connection...")
    for _ in range(20):
        conn = api_get("/api/connection")
        if conn.get("connected"):
            break
        time.sleep(1)

    try:
        test_config_has_telescope_block()
        test_config_persist_telescope()
        test_mount_flip_status_shape()
        test_mount_state_has_flip()
        test_flip_executes()
        test_flip_due_respects_altitude()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        try:
            subprocess.run(["fuser", "-k", f"{WEB_PORT}/tcp"], timeout=2, capture_output=True)
            subprocess.run(["fuser", "-k", f"{MOCK_PORT}/tcp"], timeout=2, capture_output=True)
        except Exception:
            pass

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All meridian flip integration tests passed!")
