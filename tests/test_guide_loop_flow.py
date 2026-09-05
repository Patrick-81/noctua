"""
test_guide_loop_flow.py — Integration test for the server-side guide loop.

Tests: mock INDIGO + web server, NO frontend involved:
  start (loop) → frames advance headlessly → pause freezes →
  resume advances → live config retune → stop halts.

Run via: python tests/test_guide_loop_flow.py
"""

__test__ = False  # pytest: run via python tests/test_guide_loop_flow.py

import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = sys.executable
MOCK_PORT = 17632
WEB_PORT = 18092
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


def wait_framesminimum(n, timeout=40):
    start = time.time()
    while time.time() - start < timeout:
        st = api_get("/api/guide/status")
        if st.get("frame_count", 0) >= n:
            return st
        time.sleep(1.0)
    return api_get("/api/guide/status")


def kill_proc(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ── Tests ───────────────────────────────────────────────────

def test_loop_advances_headless():
    print("\n=== Test: server loop advances with no frontend ===")
    api_post("/api/guide/reset")
    r = api_post("/api/guide/start", {
        "camera": "Guide Camera",
        "exposure": 0.5,
        "aggressiveness": 0.8,
        "ra_gain": 1.0,
        "dec_gain": 1.0,
    })
    check(r.get("ok") and r.get("state") == "guiding", "start (loop) → guiding")
    st = wait_framesminimum(3, timeout=40)
    check(st.get("frame_count", 0) >= 3,
          f"frames advanced headlessly (frame_count={st.get('frame_count')})")
    check(st.get("ref_set") is True, "reference auto-set on first frame")
    check(len(st.get("history", [])) >= 3, "history grows")
    check(st.get("current_snr") is not None, "SNR recorded")


def test_loop_pause_resume():
    print("\n=== Test: pause freezes, resume advances ===")
    api_post("/api/guide/pause")
    time.sleep(1.0)
    a = api_get("/api/guide/status").get("frame_count", 0)
    time.sleep(3.0)
    b = api_get("/api/guide/status").get("frame_count", 0)
    check(a == b, f"paused → no new frames ({a} == {b})")
    api_post("/api/guide/resume")
    st = wait_framesminimum(b + 2, timeout=40)
    check(st.get("frame_count", 0) >= b + 2, "resumed → frames advance again")


def test_loop_live_config():
    print("\n=== Test: live config retune ===")
    r = api_post("/api/guide/config", {"exposure": 1.5, "aggressiveness": 0.5})
    check(r.get("exposure_sec") == 1.5, "exposure retuned to 1.5")
    check(r.get("aggressiveness") == 0.5, "aggressiveness retuned to 0.5")
    check(r.get("frame_count", 0) > 0, "session NOT reset by retune")


def test_loop_stop_halts():
    print("\n=== Test: stop halts the loop ===")
    r = api_post("/api/guide/stop")
    check(r.get("state") == "stopped", "state=stopped")
    time.sleep(1.0)
    a = api_get("/api/guide/status").get("frame_count", 0)
    time.sleep(3.0)
    b = api_get("/api/guide/status").get("frame_count", 0)
    check(a == b, f"stopped → no new frames ({a} == {b})")
    api_post("/api/guide/reset")


def test_manual_step_still_works():
    print("\n=== Test: loop=false manual stepping (compat) ===")
    api_post("/api/guide/reset")
    r = api_post("/api/guide/start", {"loop": False})
    check(r.get("ok") and r.get("state") == "guiding", "start loop=false → guiding")
    time.sleep(2.0)
    st = api_get("/api/guide/status")
    check(st.get("frame_count", 0) == 0, "no headless frames with loop=false")
    r = api_post("/api/guide/step", {"x": 100.0, "y": 100.0})
    check(r.get("ok") and r.get("frame_count") == 1, "manual step → frame 1")
    api_post("/api/guide/stop")


# ── Main ────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Guide Loop Flow Integration Tests (headless)")
    print("=" * 60)

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
    web_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{MOCK_PORT}", "--port", str(WEB_PORT)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE
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

    # Let the device def wave settle (guide camera must be known).
    time.sleep(3.0)

    try:
        test_loop_advances_headless()
        test_loop_pause_resume()
        test_loop_live_config()
        test_loop_stop_halts()
        test_manual_step_still_works()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        try:
            subprocess.run(["fuser", "-k", f"{WEB_PORT}/tcp"], timeout=2, capture_output=True)
        except Exception:
            pass

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All guide loop integration tests passed!")


if __name__ == "__main__":
    main()
