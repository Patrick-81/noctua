#!/usr/bin/env python3
"""test_polar_flow.py — Integration test for polar alignment flow.

Starts a mock INDIGO server + web server, then tests:
1. Mount control (slew, tracking, unpark, abort)
2. FITS image injection + solving
3. Slew + solve sequence (simulated polar step)

Usage:
    python tests/test_polar_flow.py          # from project root
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_PORT = 17624
WEB_PORT = 18080
HOST = "127.0.0.1"
passed = 0
failed = 0


def check(condition, msg):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {msg}")
    else:
        failed += 1
        print(f"  ✗ {msg}")


def wait_for(url, timeout=15):
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def api_get(path):
    url = f"http://{HOST}:{WEB_PORT}{path}"
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())


def api_post(path, data):
    url = f"http://{HOST}:{WEB_PORT}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body,
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def wait_mount(timeout=10):
    start = time.time()
    while time.time() - start < timeout:
        try:
            m = api_get("/api/mount")
            if m and m.get("type") == "mount":
                return m
        except Exception:
            pass
        time.sleep(0.5)
    return None


def wait_settle(timeout=15):
    start = time.time()
    while time.time() - start < timeout:
        try:
            m = api_get("/api/mount")
            if m and not m.get("slewing"):
                return m
        except Exception:
            pass
        time.sleep(0.3)
    return None


def load_test_fits():
    """Load all available test FITS images from fake_sky/."""
    fits_dir = os.path.join(ROOT, "tests", "fake_sky")
    if not os.path.isdir(fits_dir):
        return []
    images = []
    for f in sorted(os.listdir(fits_dir)):
        if f.endswith(".fits"):
            path = os.path.join(fits_dir, f)
            with open(path, "rb") as fh:
                data = fh.read()
            # Also load JSON metadata if available
            meta_path = path.replace(".fits", ".json")
            meta = {}
            if os.path.exists(meta_path):
                with open(meta_path) as jf:
                    meta = json.load(jf)
            images.append({"filename": f, "data": data, "meta": meta})
    return images


def inject_fits(fits_bytes):
    b64 = base64.b64encode(fits_bytes).decode()
    return api_post("/api/test/fits-store", {"data": b64})


# ── Main ───────────────────────────────────────────────────────────

def main():
    global passed, failed

    mock_proc = None
    web_proc = None

    try:
        print("=" * 60)
        print("Couche 2 : Mock INDIGO + FITS injection + solve")
        print("=" * 60)

        # ── Start servers ──────────────────────────────────────
        print("\n--- Starting servers ---")

        mock_proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "tests", "mock_indigo.py"),
             "--port", str(MOCK_PORT)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        time.sleep(1)
        check(mock_proc.poll() is None, "Mock INDIGO server started")

        web_proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "run.py"),
             f"{HOST}:{MOCK_PORT}", "--port", str(WEB_PORT)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        check(wait_for(f"http://{HOST}:{WEB_PORT}/api/connection", 15),
              "Web server started")

        # ── Wait for INDIGO client ─────────────────────────────
        print("\n--- Waiting for INDIGO connection ---")
        connected = False
        for _ in range(20):
            try:
                c = api_get("/api/connection")
                if c.get("connected"):
                    connected = True
                    break
            except Exception:
                pass
            time.sleep(1)
        check(connected, "INDIGO client connected to mock server")

        mount = wait_mount(10)
        check(mount is not None, "Mount device discovered")
        check(mount and mount.get("name") == "Mount", f"Mount name: {mount.get('name') if mount else 'N/A'}")

        # ── Test 1: Mount control ──────────────────────────────
        print("\n--- Test 1: Mount control ---")

        # Unpark
        r = api_post("/api/mount/unpark", {})
        check(r.get("ok"), "Unpark command accepted")
        time.sleep(1)
        m = api_get("/api/mount")
        check(not m.get("parked"), "Mount is unparked")

        # Tracking ON
        r = api_post("/api/mount/tracking", {"on": True})
        check(r.get("ok"), "Tracking ON accepted")
        time.sleep(0.5)
        m = api_get("/api/mount")
        check(m.get("tracking"), "Tracking is ON")

        # Slew
        r = api_post("/api/mount/slew", {"ra_hours": 5.0, "dec_deg": 30.0})
        check(r.get("ok"), "Slew command accepted")
        m = wait_settle(5)
        check(m is not None, "Mount settled after slew")
        if m:
            check(abs(m.get("ra_hours", 0) - 5.0) < 0.1,
                  f"RA ≈ 5h (got {m.get('ra_hours'):.4f})")
            check(abs(m.get("dec_deg", 0) - 30.0) < 0.1,
                  f"DEC ≈ 30° (got {m.get('dec_deg'):.4f})")

        # Abort
        api_post("/api/mount/slew", {"ra_hours": 2.0, "dec_deg": 60.0})
        time.sleep(0.2)
        r = api_post("/api/mount/abort", {})
        check(r.get("ok"), "Abort command accepted")
        time.sleep(0.5)
        m = api_get("/api/mount")
        check(not m.get("slewing"), "Mount not slewing after abort")

        # Park
        r = api_post("/api/mount/park", {})
        check(r.get("ok"), "Park command accepted")
        time.sleep(1)
        m = api_get("/api/mount")
        check(m.get("parked"), "Mount is parked")

        # ── Test 2: FITS injection + solve ─────────────────────
        print("\n--- Test 2: FITS injection + solve ---")

        test_images = load_test_fits()
        check(len(test_images) > 0, f"Found {len(test_images)} test FITS images")

        if test_images:
            img = test_images[0]
            print(f"  Using: {img['filename']}")
            r = inject_fits(img["data"])
            check(r.get("ok"), f"FITS injected ({r.get('size')} bytes)")

            # Unpark + slewing to a position for hinting
            api_post("/api/mount/unpark", {})
            time.sleep(0.5)

            # Solve
            r = api_post("/api/solver/solve", {"mode": "last_image"})
            check(r.get("ok"), f"Plate solve succeeded (matches={r.get('matches', 0)})")
            if r.get("ok"):
                check(r.get("matches", 0) >= 5, f"Enough star matches ({r.get('matches')})")
                check("ra" in r and "dec" in r, f"Result has RA/DEC")

        # ── Test 3: 3-step polar sequence (slew + solve) ───────
        print("\n--- Test 3: 3-step polar sequence ---")

        if len(test_images) >= 3:
            for step in range(3):
                img = test_images[step]
                # Unpark, slew
                api_post("/api/mount/unpark", {})
                api_post("/api/mount/tracking", {"on": True})
                ra_h = 4.0 + step * 4  # 4h, 8h, 12h
                dec_d = 60.0 + step * 5  # 60°, 65°, 70°
                api_post("/api/mount/slew", {"ra_hours": ra_h, "dec_deg": dec_d})
                m = wait_settle(5)
                check(m is not None, f"Step {step+1}: Mount settled at RA={ra_h}h DEC={dec_d}°")

                # Inject + solve
                inject_fits(img["data"])
                r = api_post("/api/solver/solve", {"mode": "last_image"})
                check(r.get("ok"), f"Step {step+1}: Solve OK (matches={r.get('matches', 0)})")
        else:
            print("  Skipped (need ≥3 FITS images)")

        # ── Test 4: Error cases ────────────────────────────────
        print("\n--- Test 4: Error cases ---")

        # Solve with no image
        api_post("/api/test/fits-store", {"data": ""})
        r = api_post("/api/solver/solve", {"mode": "last_image"})
        check(not r.get("ok") or "error" in r, "Solve with empty image returns error")

        # Slew without mount (not possible in this setup, but test the endpoint)
        r = api_post("/api/mount/slew", {"ra_hours": 0, "dec_deg": 0})
        check(r.get("ok"), "Slew with valid coords accepted")

        # ── Summary ────────────────────────────────────────────
        print("\n" + "=" * 60)
        total = passed + failed
        print(f"Résultat: {passed}/{total} passés, {failed} échoués")
        if failed == 0:
            print("Couche 2 : TOUS LES TESTS SONT PASSÉS ✓")
        print("=" * 60)
        return 0 if failed == 0 else 1

    except Exception as e:
        print(f"\nFATAL: {e}")
        import traceback
        traceback.print_exc()
        return 1

    finally:
        if web_proc:
            web_proc.terminate()
            try:
                web_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                web_proc.kill()
        if mock_proc:
            mock_proc.terminate()
            try:
                mock_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_proc.kill()


if __name__ == "__main__":
    sys.exit(main())
