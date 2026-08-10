"""
test_sequence_flow.py — Integration tests for the sequence API (backend).

Tests: mock INDIGO + web server + /api/sequence/{defaults,start,status,stop,
pause/resume,reset}; checks that a real run exposes, waits for the image,
saves FITS files to disk and applies dithering.

Run via: python tests/test_sequence_flow.py
"""

__test__ = False  # pytest: run via python tests/test_sequence_flow.py

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
MOCK_PORT = 17641
WEB_PORT = 18100
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
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def api_post(path, data=None):
    try:
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{BASE_URL}{path}", data=body,
                                     headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
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


# ── Tests ───────────────────────────────────────────────────

def test_defaults_from_config():
    print("\n=== Test: /api/sequence/defaults reads config ===")
    r = api_get("/api/sequence/defaults")
    check("error" not in r, "no error")
    check("frames" in r and r["frames"], "frames list present")
    check(r["dither"]["enabled"] is True, "dither enabled from config")
    check(r["save_dir"], "save_dir present")


def test_start_rejects_empty_plan():
    print("\n=== Test: POST /api/sequence/start with empty plan ===")
    r = api_post("/api/sequence/start", {"frames": []})
    check("error" in r, "rejects empty plan")


def test_run_completes_and_saves():
    print("\n=== Test: run a 2-pose LIGHT/L sequence to completion ===")
    frames = [{"duration": 0.1, "frame_type": "LIGHT", "filter": "L",
               "count": 2, "delay": 0.1}]
    r = api_post("/api/sequence/start", {"frames": frames})
    check(r.get("ok") is True, f"start ok (got {r.get('error')})")

    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False)
    check(ok, "sequence finished")

    st = api_get("/api/sequence/status")
    check(st["done"] == 2, f"done == 2 (got {st['done']})")
    check(st["total"] == 2, "total == 2")
    check(abs(st["progress"] - 1.0) < 1e-6, "progress == 1.0")
    check(st["last_saved"] and st["last_saved"].endswith(".fits"),
          f"last_saved recorded ({st['last_saved']})")
    check(st["last_dither"] and "dx" in st["last_dither"],
          "dither result reported per pose")
    check(st["last_error"] is None, "no error")


def test_files_written():
    print("\n=== Test: FITS files written under save_dir/capture_TS/L/ ===")
    st = api_get("/api/sequence/status")
    sessions = sorted(glob.glob(os.path.join(SAVE_DIR, "capture_*")))
    check(sessions, "capture session dir created")
    group_dir = os.path.join(sessions[-1], "L") if sessions else os.path.join(SAVE_DIR, "L")
    files = sorted(glob.glob(os.path.join(group_dir, "light_L_*.fits")))
    check(len(files) == 2, f"2 light fits saved (found {len(files)})")
    if files:
        sizes = [os.path.getsize(f) for f in files]
        check(all(s > 0 for s in sizes), "all saved files non-empty")
        check(st["last_saved"] == files[-1], "last_saved matches newest file")


def test_pause_resume_reset():
    print("\n=== Test: pause / resume / reset controls ===")
    frames = [{"duration": 0.28, "frame_type": "LIGHT", "filter": "",
               "count": 4, "delay": 0.1}]
    r = api_post("/api/sequence/start", {"frames": frames})
    check(r.get("ok") is True, "start ok")

    time.sleep(0.8)
    p = api_post("/api/sequence/pause")
    check(p.get("paused") is True, "paused True")
    # Let the in-flight pose finish (pause acts at frame boundaries) before
    # locking the baseline for the "no progress while paused" check. Wait for a
    # stable plateau (4 equal reads @ 0.3 s) so we are past the finishing frame.
    plateau = [p.get("done", 0)]
    for _ in range(30):
        time.sleep(0.3)
        cur = api_get("/api/sequence/status").get("done")
        plateau.append(cur)
        if len(plateau) >= 4 and len(set(plateau[-4:])) == 1:
            break
    done_at_pause = plateau[-1]
    time.sleep(1.2)
    st = api_get("/api/sequence/status")
    check(st.get("done") == done_at_pause, "no progress while paused")

    r2 = api_post("/api/sequence/resume")
    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=30)
    check(ok, "sequence finished after resume")
    st = api_get("/api/sequence/status")
    check(st["done"] == 4, f"all 4 poses done (got {st['done']})")

    api_post("/api/sequence/reset")
    st = api_get("/api/sequence/status")
    check(st["done"] == 0 and st["total"] == 0, "reset clears counters")
    check(st["running"] is False, "reset leaves runner idle")


def test_stop_mid_run():
    print("\n=== Test: stop interrupts a long run ===")
    frames = [{"duration": 2.0, "frame_type": "LIGHT", "filter": "",
               "count": 10, "delay": 0.2}]
    r = api_post("/api/sequence/start", {"frames": frames})
    check(r.get("ok") is True, "start ok")
    time.sleep(1.5)
    api_post("/api/sequence/stop")
    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=15)
    check(ok, "running == False after stop")
    st = api_get("/api/sequence/status")
    check(st["done"] < 10, f"stops early (done={st['done']}, expected < 10)")


# ── Main ───────────────────────────────────────────────────

if __name__ == "__main__":
    tmp = tempfile.mkdtemp(prefix="seq-flow-")
    global SAVE_DIR
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
    pid = None
    for _ in range(40):
        conn = api_get("/api/connection")
        if "connected" in conn and conn.get("connected"):
            break
        time.sleep(0.5)
    else:
        print("ERROR: web server / INDIGO connection failed")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        sys.exit(1)

    try:
        test_defaults_from_config()
        test_start_rejects_empty_plan()
        test_run_completes_and_saves()
        test_files_written()
        test_pause_resume_reset()
        test_stop_mid_run()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        for port in (WEB_PORT, MOCK_PORT):
            subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All sequence integration tests passed!")