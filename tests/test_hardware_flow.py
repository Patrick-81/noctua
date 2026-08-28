"""
test_hardware_flow.py — Integration tests for hardware panel + profiles API.

Tests: mock INDIGO (with Filter Wheel device) + web server + /api/hardware* and
/api/profiles* routes, incl. connect-all / apply.

Run via: python tests/test_hardware_flow.py
"""

__test__ = False  # pytest: run via python tests/test_hardware_flow.py

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python") if os.path.isdir(os.path.join(ROOT, "venv")) else os.path.join(ROOT, ".venv", "bin", "python")
MOCK_PORT = 17625
WEB_PORT = 18088
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

def test_hardware_lists_devices():
    print("\n=== Test: /api/hardware lists mock devices ===")
    r = api_get("/api/hardware")
    check("devices" in r and "profiles" in r, f"response has devices+profiles (got keys {list(r.keys())})")
    devs = list(r.get("devices", {}).values())
    names = [d["name"] for d in devs]
    for expected in ["Mount", "Main Camera", "Guide Camera", "Focuser", "Filter Wheel"]:
        check(expected in names, f"device '{expected}' detected")
    types = {d["name"]: d["type"] for d in devs}
    check(types.get("Filter Wheel") == "filterwheel", f"Filter Wheel type=filterwheel (got {types.get('Filter Wheel')})")
    check(types.get("Mount") == "mount", f"Mount type=mount (got {types.get('Mount')})")


def _connected_map():
    r = api_get("/api/hardware")
    return {d["name"]: d["connected"] for d in r.get("devices", {}).values()}


def test_profile_crud():
    print("\n=== Test: /api/profiles CRUD ===")
    api_post("/api/hardware/disconnect-all")

    r = api_post("/api/profiles", {"name": "Rig de test",
                                   "mount": "Mount", "camera": "Main Camera",
                                   "guide_camera": "Guide Camera",
                                   "focuser": "Focuser", "filter_wheel": "Filter Wheel",
                                   "optics": "Newton 200/800"})
    check(r.get("ok") is True, "upsert → ok")
    check(r.get("active") == "Rig de test", "first profile is active")

    r = api_get("/api/profiles")
    check(r.get("active") == "Rig de test", "list → active set")
    check(len(r.get("profiles", [])) == 1, "1 profile listed")
    p = r["profiles"][0]
    check(p.get("optics") == "Newton 200/800", "optics stored")
    check(p.get("filter_wheel") == "Filter Wheel", "filter_wheel stored")

    r = api_post("/api/profiles", {"name": "Rig B"})
    check(r.get("ok") is True, "second profile created")
    r = api_get("/api/profiles")
    check(len(r.get("profiles", [])) == 2, "2 profiles listed")

    r = api_post("/api/profiles/activate", {"name": "Rig de test"})
    check(r.get("ok") is True, "activate → ok")
    r = api_get("/api/profiles")
    check(r.get("active") == "Rig de test", "active switched")

    r = api_post("/api/profiles/delete", {"name": "Rig B"})
    check(r.get("ok") is True, "delete → ok")
    r = api_get("/api/profiles")
    check(len(r.get("profiles", [])) == 1, "1 profile after delete")


def test_apply_connects_profile_devices():
    print("\n=== Test: /api/profiles/apply connects profile devices ===")
    api_post("/api/hardware/disconnect-all")
    time.sleep(0.5)
    r = api_post("/api/profiles/apply", {"name": "Rig de test"})
    check(r.get("ok") is True, "apply → ok")

    expected = ["Mount", "Main Camera", "Guide Camera", "Focuser", "Filter Wheel"]
    ok_apply = wait_until(
        lambda: all(_connected_map().get(n) is True for n in expected))
    for n in expected:
        check(ok_apply, f"{n} connected after apply")
    if not ok_apply:
        print(f"    conn map: {_connected_map()}")

    api_post("/api/hardware/disconnect-all")


def test_per_device_connect_disconnect():
    print("\n=== Test: /api/hardware/connect + disconnect (per device) ===")
    api_post("/api/hardware/disconnect-all")
    time.sleep(0.5)

    r = api_post("/api/hardware/connect", {"device": "Filter Wheel"})
    check(r.get("ok") is True, "connect Filter Wheel → ok")

    wait_until(lambda: _connected_map().get("Filter Wheel") is True)
    by_name = _connected_map()
    check(by_name.get("Filter Wheel") is True, "Filter Wheel connected")
    check(by_name.get("Mount") is False, "Mount still disconnected")

    r = api_post("/api/hardware/disconnect", {"device": "Filter Wheel"})
    check(r.get("ok") is True, "disconnect Filter Wheel → ok")
    wait_until(lambda: _connected_map().get("Filter Wheel") is False)
    check(_connected_map().get("Filter Wheel") is False, "Filter Wheel disconnected")


def test_connect_unknown_device():
    print("\n=== Test: connect unknown device → error ===")
    r = api_post("/api/hardware/connect", {"device": "Nope"})
    check(not r.get("ok"), f"unknown device → ok falsy (got {r})")


def test_apply_unknown_profile():
    print("\n=== Test: apply unknown profile → error ===")
    r = api_post("/api/profiles/apply", {"name": "Nope"})
    check(not r.get("ok"), f"unknown profile → ok falsy (got {r})")


def test_filterwheel_status_and_slot():
    print("\n=== Test: /api/filterwheel status + slot selection ===")
    api_post("/api/hardware/connect", {"device": "Filter Wheel"})
    wait_until(lambda: api_get("/api/filterwheel").get("connected") is True)

    fw = api_get("/api/filterwheel")
    check(fw.get("found") is True, "filter wheel found")
    names = [s["name"] for s in fw.get("slots", [])]
    check(names == ["L", "R", "G", "B", "Ha"], f"5 slots L/R/G/B/Ha (got {names})")
    check(fw.get("current") in names, f"current slot is one of the slots (got {fw.get('current')})")

    r = api_post("/api/filterwheel/slot", {"slot": "G"})
    check(r.get("ok") is True, "set slot G → ok")
    wait_until(lambda: api_get("/api/filterwheel").get("current") == "G")
    check(api_get("/api/filterwheel").get("current") == "G", "current slot is G")

    r = api_post("/api/filterwheel/slot", {"slot": "Nope"})
    check(not r.get("ok"), "unknown slot → error")

    api_post("/api/hardware/disconnect", {"device": "Filter Wheel"})


def test_save_filename_includes_filter():
    print("\n=== Test: /api/camera/save names file with filter ===")
    import re as _re
    tmpdir = tempfile.mkdtemp(prefix="cap_")
    api_post("/api/hardware/connect", {"device": "Main Camera"})
    wait_until(lambda: api_get("/api/hardware").get("devices", {}).get("Main Camera", {}).get("connected") is True)

    # Capture → populate _last_image_data
    r = api_post("/api/camera/expose", {"device": "Main Camera", "duration": 0.1})
    check(r.get("ok") is True, "expose → ok")

    # Wait for the mock to deliver the FITS image
    def _image_ready():
        sav = api_post("/api/camera/save", {"dir": tmpdir, "filter": "G"})
        return sav.get("ok") is True

    ok = wait_until(_image_ready, timeout=10)
    check(ok, "save with filter succeeded")
    import glob as _glob
    files = _glob.glob(os.path.join(tmpdir, "*.fits"))
    check(len(files) == 1, "one file written")
    fname = os.path.basename(files[0])
    check(fname.startswith("capture_G_"), f"filename embeds filter G (got {fname})")

    # Second save without filter
    r2 = api_post("/api/camera/save", {"dir": tmpdir})
    files2 = _glob.glob(os.path.join(tmpdir, "*.fits"))
    check(len(files2) == 2, "two files after second save")
    unfiltered = [f for f in files2 if "_G_" not in os.path.basename(f)]
    check(len(unfiltered) == 1 and unfiltered[0].endswith(".fits"),
          f"second file has no filter tag (got {[os.path.basename(f) for f in files2]})")

    api_post("/api/hardware/disconnect", {"device": "Main Camera"})


# ── Main ────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Hardware + Profiles Flow Integration Tests")
    print("=" * 60)

    profiles_path = os.path.join(tempfile.mkdtemp(), "profiles.yaml")

    for port in [MOCK_PORT, WEB_PORT]:
        try:
            subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)
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
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{MOCK_PORT}", "--port", str(WEB_PORT)],
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
        test_hardware_lists_devices()
        test_profile_crud()
        test_apply_connects_profile_devices()
        test_per_device_connect_disconnect()
        test_connect_unknown_device()
        test_apply_unknown_profile()
        test_filterwheel_status_and_slot()
        test_save_filename_includes_filter()
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
        print("All hardware integration tests passed!")


if __name__ == "__main__":
    main()
