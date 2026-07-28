"""
test_guide_flow.py — Integration tests for the guide API routes.

Tests: mock INDIGO + web server + guide start/stop/pause/step/reset.
No real hardware required.

Run via: python tests/test_guide_flow.py
"""

__test__ = False  # pytest: run via python tests/test_guide_flow.py

import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python")
MOCK_PORT = 17624
WEB_PORT = 18087
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


def kill_proc(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ── Tests ───────────────────────────────────────────────────

def test_guide_status_idle():
    print("\n=== Test: guide status (idle) ===")
    api_post("/api/guide/reset")
    r = api_get("/api/guide/status")
    check(r.get("state") == "idle", f"State is idle (got {r.get('state')})")
    check(r.get("ref_set") is False, "ref_set is False")


def test_guide_start_stop():
    print("\n=== Test: guide start → stop ===")
    r = api_post("/api/guide/start", {"exposure": 2.0, "aggressiveness": 0.6})
    check(r.get("ok"), "start → ok")
    check(r.get("state") == "guiding", f"state=guiding (got {r.get('state')})")
    check(r.get("exposure_sec") == 2.0, "exposure=2.0")

    r = api_post("/api/guide/stop")
    check(r.get("state") == "stopped", f"state=stopped (got {r.get('state')})")


def test_guide_start_duplicate():
    print("\n=== Test: guide start while already guiding ===")
    api_post("/api/guide/start")
    r = api_post("/api/guide/start")
    check(r.get("ok") is False, "double start → ok=False")
    api_post("/api/guide/stop")


def test_guide_step_sequence():
    print("\n=== Test: guide step sequence ===")
    api_post("/api/guide/reset")
    api_post("/api/guide/start", {"exposure": 1.0, "aggressiveness": 1.0, "ra_gain": 10.0, "dec_gain": 10.0, "min_pulse_ms": 0})

    # First step sets reference
    r = api_post("/api/guide/step", {"x": 100.0, "y": 100.0})
    check(r.get("ok"), "step 1 → ok")
    check(r.get("ref_set") is True, "ref_set=True after first step")
    check(r.get("frame_count") == 1, f"frame_count=1 (got {r.get('frame_count')})")
    check(r.get("ra_pulse_ms") == 0, "no correction on reference frame")

    # Second step with drift
    r = api_post("/api/guide/step", {"x": 105.0, "y": 98.0})
    check(r.get("drift_x") == 5.0, f"drift_x=5.0 (got {r.get('drift_x')})")
    check(r.get("drift_y") == -2.0, f"drift_y=-2.0 (got {r.get('drift_y')})")
    check(r.get("ra_pulse_ms") > 0, f"ra_pulse_ms > 0 (got {r.get('ra_pulse_ms')})")
    check(r.get("ra_direction") == "W", f"ra_direction=W (got {r.get('ra_direction')})")
    check(r.get("dec_pulse_ms") > 0, f"dec_pulse_ms > 0 (got {r.get('dec_pulse_ms')})")
    check(r.get("dec_direction") == "N", f"dec_direction=N (got {r.get('dec_direction')})")

    # Third step: same position, same drift from reference → same correction
    r = api_post("/api/guide/step", {"x": 105.0, "y": 98.0})
    check(r.get("drift_x") == 5.0, "drift_x still 5.0 (relative to ref)")
    check(r.get("ra_pulse_ms") > 0, "correction still applied (star still displaced from ref)")

    # History
    r = api_get("/api/guide/status")
    check(len(r.get("history", [])) == 3, f"3 history entries (got {len(r.get('history', []))})")

    api_post("/api/guide/stop")


def test_guide_pause_resume():
    print("\n=== Test: guide pause → resume ===")
    api_post("/api/guide/reset")
    api_post("/api/guide/start")
    api_post("/api/guide/step", {"x": 100.0, "y": 100.0})

    r = api_post("/api/guide/pause")
    check(r.get("state") == "paused", f"state=paused (got {r.get('state')})")

    # Step while paused should fail
    r = api_post("/api/guide/step", {"x": 110.0, "y": 100.0})
    check(r.get("ok") is False, "step while paused → ok=False")

    r = api_post("/api/guide/resume")
    check(r.get("state") == "guiding", f"state=guiding after resume (got {r.get('state')})")

    # Step after resume should work
    r = api_post("/api/guide/step", {"x": 110.0, "y": 100.0})
    check(r.get("ok"), "step after resume → ok")

    api_post("/api/guide/stop")


def test_guide_set_reference():
    print("\n=== Test: guide set-reference ===")
    api_post("/api/guide/reset")
    api_post("/api/guide/start")
    api_post("/api/guide/step", {"x": 100.0, "y": 100.0})

    r = api_post("/api/guide/set-reference", {"x": 200.0, "y": 300.0})
    check(r.get("ref_x") == 200.0, f"ref_x=200 (got {r.get('ref_x')})")
    check(r.get("ref_y") == 300.0, f"ref_y=300 (got {r.get('ref_y')})")

    # Drift should now be relative to new reference
    r = api_post("/api/guide/step", {"x": 210.0, "y": 295.0})
    check(r.get("drift_x") == 10.0, f"drift_x=10.0 (got {r.get('drift_x')})")
    check(r.get("drift_y") == -5.0, f"drift_y=-5.0 (got {r.get('drift_y')})")

    api_post("/api/guide/stop")


def test_guide_reset():
    print("\n=== Test: guide reset ===")
    api_post("/api/guide/start")
    api_post("/api/guide/step", {"x": 100.0, "y": 100.0})
    api_post("/api/guide/step", {"x": 110.0, "y": 100.0})

    r = api_post("/api/guide/reset")
    check(r.get("state") == "idle", f"state=idle after reset (got {r.get('state')})")
    check(r.get("frame_count") == 0, "frame_count=0")
    check(r.get("ref_set") is False, "ref_set=False")


def test_guide_settings():
    print("\n=== Test: guide settings ===")
    api_post("/api/guide/reset")
    r = api_post("/api/guide/start", {
        "exposure": 3.0,
        "aggressiveness": 0.4,
        "ra_gain": 2.5,
        "dec_gain": 3.0,
        "max_pulse_ms": 1000,
        "min_pulse_ms": 100,
        "plate_scale": 1.5,
    })
    check(r.get("exposure_sec") == 3.0, "exposure=3.0")
    check(r.get("aggressiveness") == 0.4, "aggressiveness=0.4")
    check(r.get("ra_gain") == 2.5, "ra_gain=2.5")
    check(r.get("dec_gain") == 3.0, "dec_gain=3.0")
    check(r.get("max_pulse_ms") == 1000, "max_pulse_ms=1000")
    check(r.get("min_pulse_ms") == 100, "min_pulse_ms=100")
    check(r.get("plate_scale") == 1.5, "plate_scale=1.5")

    api_post("/api/guide/stop")


# ── Main ────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Guide Flow Integration Tests")
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

    try:
        test_guide_status_idle()
        test_guide_start_stop()
        test_guide_start_duplicate()
        test_guide_step_sequence()
        test_guide_pause_resume()
        test_guide_set_reference()
        test_guide_reset()
        test_guide_settings()
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
        print("All guide integration tests passed!")


if __name__ == "__main__":
    main()
