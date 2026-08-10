"""
test_live_stack_flow.py — Integration flow test: live stacking over a sequence.

Spins up mock INDIGO + web server, runs a LIGHT sequence with the stack
enabled, and checks the stacking engine accumulates accepted frames,
produces a snapshot, and can save a master.

Run via: python tests/test_live_stack_flow.py
"""

__test__ = False  # pytest: run via python tests/test_live_stack_flow.py

import base64
import glob
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python")
MOCK_PORT = 17642
WEB_PORT = 18101
BASE_URL = f"http://127.0.0.1:{WEB_PORT}"

passed = 0
failed = 0


def check(condition, msg):
    global passed, failed
    if condition:
        passed += 1
        print(f"  \u2713 {msg}")
    else:
        failed += 1
        print(f"  \u2717 FAIL: {msg}")


def api_get(path):
    try:
        resp = urllib.request.urlopen(f"{BASE_URL}{path}", timeout=15)
        return json.loads(resp.read())
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def api_post(path, data=None):
    try:
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{BASE_URL}{path}", data=body,
                                     headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read())
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def wait_until(predicate, timeout=25, interval=0.4):
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


def test_stacking_defaults():
    print("\n=== Test: stacking defaults exposed ===")
    r = api_get("/api/sequence/defaults")
    check("stack" in r, "stack config present")
    check(r["stack"].get("enabled") is False, "stack disabled by default")
    r = api_get("/api/stacking/status")
    check(r.get("available") is True, "stacking engine available")
    check(r.get("accepted") == 0, "no frames yet")


def test_sequence_with_stacking():
    print("\n=== Test: LIGHT sequence accumulates a live stack ===")
    api_post("/api/stacking/reset")
    frames = [{"duration": 0.1, "frame_type": "LIGHT", "filter": "L",
               "count": 3, "delay": 0.05}]
    r = api_post("/api/sequence/start", {"frames": frames,
                                         "stack": {"enabled": True}})
    check(r.get("ok") is True, f"sequence+stack started (got {r.get('error')})")

    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=40)
    check(ok, "sequence finished")

    st = api_get("/api/stacking/status")
    check(st["running"] is True, "stacking running")
    check(st["accepted"] >= 3, f"stack accepted >= 3 frames (got {st['accepted']})")
    print(f"    stack detail: accepted={st.get('accepted')} rejected={st.get('rejected')} "
          f"last={st.get('last')} error={st.get('error')}")

    png = api_get("/api/stacking/snapshot")
    check(png.get("ok") is True, "snapshot available")
    if "png" in png and png["png"]:
        raw = base64.b64decode(png["png"])
        check(raw[:8] == b"\x89PNG\r\n\x1a\n", "snapshot decodes to PNG")
    else:
        check(False, "snapshot png payload present")


def test_save_master():
    print("\n=== Test: save master to SAVE_DIR ===")
    st = api_get("/api/stacking/status")
    if st.get("accepted", 0) > 0:
        r = api_post("/api/stacking/save", {"dir": SAVE_DIR})
        check(r.get("ok") is True, "master saved")
        check(r.get("path") and r["path"].endswith(".fits"), "master path fits")
        check(os.path.exists(r["path"]), "master file exists on disk")
    else:
        check(False, "no stack to save (skip)")


def test_reset_endpoint():
    print("\n=== Test: reset clears the stack ===")
    r = api_post("/api/stacking/reset")
    check(r.get("accepted") == 0 and r.get("running") is False, "reset works")


def test_auto_stacking_session():
    print("\n=== Test: auto-stacking session (short poses → livestack_TS/) ===")
    api_post("/api/stacking/reset")
    r = api_post("/api/stacking/start", {
        "duration": 0.1, "max_frames": 3,
        "save_dir": SAVE_DIR, "filter": "L"})
    check(r.get("ok") is True, f"stacking session started (got {r.get('error')})")
    check(r.get("session_dir") and "livestack_" in r["session_dir"],
          "session_dir is a livestack_* folder")
    check(os.path.isdir(r["session_dir"]), "session dir exists on disk")

    ok = wait_until(lambda: api_get("/api/stacking/status").get("complete") is True,
                    timeout=40)
    check(ok, "session auto-completes at max_frames")

    st = api_get("/api/stacking/status")
    check(st.get("accepted", 0) >= 3,
          f"accepted >= 3 (got {st.get('accepted')})")
    check(st["session"]["running"] is False, "session runner finished")
    files = sorted(glob.glob(os.path.join(r["session_dir"], "light_*.fits")))
    check(len(files) >= 3, f"live poses saved in session dir (found {len(files)})")

    # Save the master while the finished stack is still live
    mr = api_post("/api/stacking/save", {"dir": r["session_dir"]})
    check(mr.get("ok") is True, "master saved after session")
    check(mr.get("path") and os.path.exists(mr["path"]), "master exists on disk")

    api_post("/api/stacking/reset")


# ── Main ───────────────────────────────────────────────────

if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="stack-flow-")
    SAVE_DIR = os.path.join(tmp, "captures")
    config_path = os.path.join(tmp, "config.yaml")
    profiles_path = os.path.join(tmp, "profiles.yaml")
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
  flip_enabled: false
  hour_angle_margin: 0.0
  min_altitude: 5.0
sequence:
  save_dir: {SAVE_DIR}
  dither:
    enabled: true
    amount: 2.0
  stack:
    enabled: false
  frames:
    - duration: 1.0
      frame_type: LIGHT
      filter: ""
      count: 1
      delay: 0.0
""")

    for port in (MOCK_PORT, WEB_PORT):
        subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)
    time.sleep(0.5)

    print("\nStarting mock INDIGO server...")
    mock_logfile = open(os.path.join(tmp, "mock.log"), "ab", buffering=0)
    mock_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "tests", "mock_indigo.py"), "--port", str(MOCK_PORT)],
        cwd=ROOT, stdout=mock_logfile, stderr=subprocess.STDOUT
    )
    time.sleep(1.5)

    print("Starting web server...")
    env = dict(os.environ)
    env["INDIGO_PROFILES_PATH"] = profiles_path
    logfile = open(os.path.join(tmp, "web.log"), "ab", buffering=0)
    web_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{MOCK_PORT}", "--port", str(WEB_PORT),
         "--config", config_path],
        cwd=ROOT, stdout=logfile, stderr=subprocess.STDOUT, env=env
    )
    conn_ok = False
    for _ in range(40):
        conn = api_get("/api/connection")
        if "connected" in conn and conn.get("connected"):
            conn_ok = True
            break
        time.sleep(0.5)
    if not conn_ok:
        print("ERROR: web server / INDIGO connection failed")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        sys.exit(1)

    try:
        test_stacking_defaults()
        test_sequence_with_stacking()
        test_save_master()
        test_reset_endpoint()
        test_auto_stacking_session()
    finally:
        print("\n\nShutting down...")
        if "logfile" in dir() and logfile:
            logfile.close()
        kill_proc(web_proc)
        kill_proc(mock_proc)
        for port in (WEB_PORT, MOCK_PORT):
            subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)
        logpath = os.path.join(tmp, "web.log")
        if os.path.exists(logpath):
            print(f"\n--- web.log (tail) ---")
            with open(logpath) as f:
                lines = f.readlines()
            tail = lines[-40:] if lines else lines
            for l in tail:
                if any(k in l for k in ("stack", "Stack", "sequence", "Sequence",
                                         "sauv", "error", "Error", "warning", "frame")):
                    print(l.rstrip())
        mockpath = os.path.join(tmp, "mock.log")
        if os.path.exists(mockpath):
            print(f"\n--- mock.log (tail) ---")
            with open(mockpath) as f:
                lines = f.readlines()
            for l in lines[-25:]:
                if any(k in l for k in ("Exposure", "exposure", "BLOB", "blob", "error",
                                        "Error", "Traceback", "Accepted", "frame")):
                    print(l.rstrip())

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    print("All live-stacking integration tests passed!")