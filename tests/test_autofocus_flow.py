"""
test_autofocus_flow.py — Integration tests for autofocus API routes.

Tests the full flow: mock INDIGO + web server + autofocus start/step/finish/stop.
No real hardware required.

Run via: python tests/test_autofocus_flow.py
"""

__test__ = False  # pytest: run via python tests/test_autofocus_flow.py

import base64
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python") if os.path.isdir(os.path.join(ROOT, "venv")) else os.path.join(ROOT, ".venv", "bin", "python")
MOCK_PORT = 17624
WEB_PORT = 18086
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


def make_test_fits(w=100, h=100, stars=None, bg=100):
    import numpy as np
    img = np.full((h, w), bg, dtype=np.float64)
    if stars:
        yy, xx = np.mgrid[0:h, 0:w]
        for cx, cy, peak, sigma in stars:
            g = peak * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
            img += g
    cards = [
        "SIMPLE  =                    T",
        "NAXIS   =                    2",
        f"NAXIS1  =               {w:>5d}",
        f"NAXIS2  =               {h:>5d}",
        "BITPIX  =                   16",
        "END",
    ]
    header = "".join(c.ljust(80) for c in cards).ljust(2880)
    data = np.array(img, dtype=">i2").tobytes()
    return header.encode("ascii") + data


def inject_fits(fits_bytes):
    b64 = base64.b64encode(fits_bytes).decode()
    return api_post("/api/test/fits-store", {"data": b64})


def clear_image():
    return api_post("/api/test/fits-store", {"data": ""})


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


# ── Test functions ──────────────────────────────────────────────

def test_autofocus_status_idle():
    print("\n=== Test: autofocus status (idle) ===")
    api_post("/api/focuser/autofocus/reset")
    r = api_get("/api/focuser/autofocus/status")
    check(r.get("state") == "idle", f"State is idle (got {r.get('state')})")


def test_autofocus_start_stop():
    print("\n=== Test: autofocus start → stop ===")
    r = api_post("/api/focuser/autofocus/start", {"center": 5000, "range": 1000, "points": 11})
    check(r.get("ok"), "start → ok")
    check(r.get("state") == "running", f"state=running (got {r.get('state')})")
    check(len(r.get("positions", [])) == 11, f"11 positions (got {len(r.get('positions', []))})")

    r = api_post("/api/focuser/autofocus/stop")
    check(r.get("state") == "stopped", f"state=stopped after stop (got {r.get('state')})")


def test_autofocus_full_vcurve():
    print("\n=== Test: autofocus full V-curve with real focus metric ===")
    api_post("/api/focuser/autofocus/reset")

    # Start
    r = api_post("/api/focuser/autofocus/start", {"center": 0, "range": 500, "points": 9})
    check(r.get("ok"), "start → ok")
    positions = r.get("positions", [])
    check(len(positions) == 9, f"9 positions (got {len(positions)})")

    # Feed synthetic V-curve data
    for pos in positions:
        dist = abs(pos) / 500.0
        hfr = 1.0 + 8.0 * dist ** 2
        fwhm = hfr * 0.8

        # Inject FITS with varying star sharpness (simulate focus change)
        sigma = 1.0 + 4.0 * dist  # stars blur as we move away from best
        fits = make_test_fits(200, 200, [(100, 100, 8000, sigma)], bg=100)
        inject_fits(fits)

        sr = api_post("/api/focuser/autofocus/step", {"position": pos, "hfr": hfr, "fwhm": fwhm})
        check(sr.get("ok"), f"step pos={pos} hfr={hfr:.2f} → ok")
        check(sr.get("current_step", 0) > 0, f"current_step incremented")

    # Finish
    fr = api_post("/api/focuser/autofocus/finish")
    check(fr.get("ok"), "finish → ok")
    check(fr.get("state") == "done", f"state=done (got {fr.get('state')})")
    check(fr.get("best_position") is not None, f"best_position found (got {fr.get('best_position')})")

    # Check that best position is near 0
    bp = fr.get("best_position", 99999)
    check(abs(bp) < 200, f"best_position near 0 (got {bp})")


def test_cameras_endpoint():
    print("\n=== Test: cameras endpoint ===")
    r = api_get("/api/cameras")
    check(isinstance(r, list), "cameras returns a list")
    if len(r) > 0:
        check("name" in r[0], "camera has 'name'")
        check("connected" in r[0], "camera has 'connected'")


def test_focus_metric_with_device():
    print("\n=== Test: focus-metric with device param ===")
    fits = make_test_fits(200, 200, [(100, 100, 8000, 3.0)], bg=100)
    inject_fits(fits)
    r = api_get("/api/focuser/focus-metric")
    check(r.get("ok"), "focus-metric without device param works")
    check(r.get("hfr", 0) > 0, f"hfr > 0 (got {r.get('hfr')})")


# ── Main ────────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Autofocus Flow Integration Tests")
    print("=" * 60)

    # Kill any leftover processes
    for port in [MOCK_PORT, WEB_PORT]:
        try:
            subprocess.run(["fuser", "-k", f"{port}/tcp"],
                           timeout=2, capture_output=True)
        except Exception:
            pass
    time.sleep(0.5)

    # Start mock INDIGO
    print("\nStarting mock INDIGO server...")
    mock_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "tests", "mock_indigo.py"), "--port", str(MOCK_PORT)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    time.sleep(1.5)

    # Start web server
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

    # Wait for INDIGO connection
    print("Waiting for INDIGO connection...")
    for _ in range(20):
        conn = api_get("/api/connection")
        if conn.get("connected"):
            break
        time.sleep(1)

    try:
        test_autofocus_status_idle()
        test_autofocus_start_stop()
        test_autofocus_full_vcurve()
        test_cameras_endpoint()
        test_focus_metric_with_device()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        try:
            subprocess.run(["fuser", "-k", f"{WEB_PORT}/tcp"],
                           timeout=2, capture_output=True)
        except Exception:
            pass

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    else:
        print("All autofocus integration tests passed!")


if __name__ == "__main__":
    main()
