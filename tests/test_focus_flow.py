"""
test_focus_flow.py — Integration tests for focus metrics pipeline.

Tests the full flow: mock INDIGO + web server + FITS injection + focus-metric API.
No real hardware required.
"""

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
WEB_PORT = 18085
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
    """Create synthetic FITS bytes with Gaussian stars."""
    import numpy as np

    img = np.full((h, w), bg, dtype=np.float64)
    if stars:
        yy, xx = np.mgrid[0:h, 0:w]
        for cx, cy, peak, sigma in stars:
            g = peak * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
            img += g

    # FITS header
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

def test_focus_metric_no_image():
    print("\n=== Test: focus metric with no image ===")
    clear_image()
    result = api_get("/api/focuser/focus-metric")
    check(result.get("ok") is False, "No image → ok=False")
    check("no image" in result.get("error", "").lower(), f"Error message mentions 'no image'")


def test_focus_metric_inject_single():
    print("\n=== Test: inject single FITS + focus metric ===")
    fits = make_test_fits(200, 200, [
        (50, 50, 5000, 3.0),
        (150, 80, 3000, 2.5),
        (100, 150, 8000, 3.5),
    ], bg=100)
    r = inject_fits(fits)
    check(r.get("ok"), f"FITs injected (size={r.get('size', 0)})")

    result = api_get("/api/focuser/focus-metric")
    check(result.get("ok"), "Focus metric computed")
    check(result.get("star_count", 0) >= 3, f"Found >=3 stars (got {result.get('star_count')})")
    check(result.get("hfr", 0) > 0, f"HFR > 0 (got {result.get('hfr')})")
    check(result.get("fwhm", 0) > 0, f"FWHM > 0 (got {result.get('fwhm')})")
    check(result.get("width") == 200, f"Width=200 (got {result.get('width')})")
    check(result.get("height") == 200, f"Height=200 (got {result.get('height')})")
    check(len(result.get("stars", [])) >= 3, "At least 3 stars in response")


def test_focus_metric_inject_multiple():
    print("\n=== Test: inject multiple FITS (simulate focus sequence) ===")
    hfrs = []
    for i, sigma in enumerate([5.0, 3.5, 2.5, 3.0, 4.5]):
        fits = make_test_fits(200, 200, [
            (100, 100, 8000, sigma),
        ], bg=100)
        inject_fits(fits)
        result = api_get("/api/focuser/focus-metric")
        hfr = result.get("hfr", 0)
        hfrs.append(hfr)
        check(result.get("ok"), f"Step {i}: sigma={sigma} → HFR={hfr:.2f}")

    # HFR should follow sigma trend (smaller sigma = smaller HFR)
    check(hfrs[2] < hfrs[0],
          f"Best focus (sigma=2.5) HFR={hfrs[2]:.2f} < worst (sigma=5.0) HFR={hfrs[0]:.2f}")


def test_focus_metric_empty_image():
    print("\n=== Test: empty FITS (no stars) ===")
    fits = make_test_fits(100, 100, [], bg=100)
    inject_fits(fits)
    result = api_get("/api/focuser/focus-metric")
    check(result.get("ok"), "Empty image returns ok")
    check(result.get("star_count", 0) == 0, f"0 stars (got {result.get('star_count')})")


def test_focus_metric_clear():
    print("\n=== Test: clear image ===")
    fits = make_test_fits(100, 100, [(50, 50, 5000, 3.0)], bg=100)
    inject_fits(fits)
    clear_image()
    result = api_get("/api/focuser/focus-metric")
    check(result.get("ok") is False, "After clear → ok=False")


def test_focuser_api():
    print("\n=== Test: focuser API endpoints ===")
    result = api_get("/api/focuser")
    check("position" in result, f"GET /api/focuser has position (got {result.get('position')})")
    check("speed" in result, f"GET /api/focuser has speed (got {result.get('speed')})")

    # Move relative
    r = api_post("/api/focuser/move_relative", {"direction": "OUT", "steps": 100})
    check(r.get("ok"), f"move_relative OUT 100 → ok")
    time.sleep(0.3)

    # Set speed
    r = api_post("/api/focuser/speed", {"speed": 500})
    check(r.get("ok"), "set_speed → ok")

    # Halt
    r = api_post("/api/focuser/halt")
    check(r.get("ok"), "halt → ok")


# ── Main ────────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Focus Flow Integration Tests")
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
        test_focus_metric_no_image()
        test_focus_metric_inject_single()
        test_focus_metric_inject_multiple()
        test_focus_metric_empty_image()
        test_focus_metric_clear()
        test_focuser_api()
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
        print("All integration tests passed!")


if __name__ == "__main__":
    main()
