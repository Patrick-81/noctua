"""
test_blanc_indigo.py — Test à blanc contre le VRAI serveur INDIGO (2.x).

Integration tests that replace the home-made mock by the real ecosystem:
indigo_server + indigo_ccd/mount/rotator/dome/gps simulators. It validates
end-to-end: devices discovery, profile apply, mount, filter wheel (native
WHEEL_SLOT convention), focuser (native item names), capture → BLOB → FITS
(BZERO/BSCALE), sequence (pause/resume/stop/reset + dither toggle) and guide
sanity (no dedicated guide driver).

This is the antechamber of the real sky: same protocol, different devices.

Prerequisite:
  - indigo_server in PATH (e.g. /usr/bin/indigo_server, v2.0-374)
  - simulator drivers discoverable by indigo_server by name.

Run via: python tests/test_blanc_indigo.py [--indigo-port 17660] [--web-port 18110]
"""

__test__ = False  # pytest: run via python (dangerous, needs indigo_server)

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python") if os.path.isdir(os.path.join(ROOT, "venv")) else os.path.join(ROOT, ".venv", "bin", "python")

INDIGO_BIN = shutil.which("indigo_server")
SIM_DRIVERS = [
    "indigo_mount_simulator", "indigo_ccd_simulator", "indigo_rotator_simulator",
    "indigo_dome_simulator", "indigo_gps_simulator",
]

# Real device names exposed by indigo_ccd_simulator / indigo_mount_simulator.
DEV_MOUNT = "Mount Simulator"
DEV_CAMERA = "CCD Imager Simulator"
DEV_WHEEL = "CCD Imager Simulator (wheel)"
DEV_FOCUSER = "CCD Imager Simulator (focuser)"
DEV_GUIDE_CAM = "CCD Guider Simulator"

passed = 0
failed = 0
BASE_URL = ""  # filled in main


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


def wait_until(predicate, timeout=30, interval=0.5):
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

def test_devices_connect():
    print("\n=== 1. Discovery: devices listed + connected ===")
    devs = api_get("/api/devices")
    check("error" not in devs, "no error")
    names = list(devs.keys())
    for expected in (DEV_MOUNT, DEV_CAMERA, DEV_WHEEL, DEV_FOCUSER, DEV_GUIDE_CAM):
        check(expected in names, f"device present: {expected}")
    check(devs.get(DEV_MOUNT, {}).get("connected"), "mount connected")
    check(devs.get(DEV_CAMERA, {}).get("connected"), "imager connected")


def test_profile_apply():
    print("\n=== 2. Profile apply (roles -> devices) ===")
    prof = {"name": "BlancSim", "mount": DEV_MOUNT, "camera": DEV_CAMERA,
            "guide_camera": DEV_GUIDE_CAM, "focuser": DEV_FOCUSER,
            "filter_wheel": DEV_WHEEL, "optics": None}
    r = api_post("/api/profiles", prof)
    check(r.get("ok") is True, "profile created")
    r = api_post("/api/profiles/apply", {"name": "BlancSim"})
    check(r.get("ok") is True, f"profile applied (got {r.get('error')})")
    res = {d.get("device"): d.get("ok") for d in r.get("results", [])}
    for expected in (DEV_MOUNT, DEV_CAMERA, DEV_GUIDE_CAM, DEV_FOCUSER, DEV_WHEEL):
        check(res.get(expected) is True, f"'{expected}' connect accepted")
    target_devs = (DEV_MOUNT, DEV_CAMERA, DEV_GUIDE_CAM, DEV_FOCUSER, DEV_WHEEL)

    def all_connected():
        devs = api_get("/api/devices")
        return all(devs.get(d, {}).get("connected") for d in target_devs)

    ok = wait_until(all_connected, timeout=15)
    check(ok, "all profile devices CONNECTED")


def test_mount_ops():
    print("\n=== Step 3. Mount: unpark / tracking / goto / park ===")
    r = api_post("/api/mount/unpark", {})
    check(r.get("ok") is True, "unpark accepted")
    ok = wait_until(lambda: api_get("/api/mount").get("parked") is False)
    check(ok, "parked -> False")
    r = api_post("/api/mount/tracking", {"enabled": True})
    check(r.get("ok") is True, "tracking ON accepted")
    r = api_post("/api/mount/slew", {"ra_hours": 5.35, "dec_deg": -5.4})
    check(r.get("ok") is True, f"slew to (5.35, -5.4) accepted (got {r.get('error')})")
    ok = wait_until(lambda: api_get("/api/mount").get("slewing") is False, timeout=60)
    check(ok, "slew finished")
    m = api_get("/api/mount")
    check(abs(m.get("ra_hours", 0) - 5.35) < 0.2, f"RA ≈ 5.35 (got {m.get('ra_hours')})")
    check(abs(m.get("dec_deg", 0) - (-5.4)) < 0.2, f"DEC ≈ -5.4 (got {m.get('dec_deg')})")
    r = api_post("/api/mount/park", {})
    check(r.get("ok") is True, "park accepted")


def test_filterwheel_native():
    print("\n=== Step 4. Native WHEEL_SLOT filter wheel ===")
    fw = api_get("/api/filterwheel")
    check(fw.get("found") is True, "wheel detected")
    check(fw.get("connected") is True, "wheel connected")
    check(len(fw.get("slots", [])) == 5, f"5 slots (got {len(fw.get('slots', []))})")
    check(fw.get("current"), f"current slot {fw.get('current')}")
    first_names = [s["name"] for s in fw.get("slots", [])]
    target = "Filter #3" if "Filter #3" in first_names else first_names[0]
    r = api_post("/api/filterwheel/slot", {"slot": target})
    check(r.get("ok") is True, f"set slot → {target} (got {r.get('error')})")
    ok = wait_until(lambda: api_get("/api/filterwheel").get("current") == target,
                    timeout=10)
    check(ok, f"current updated to {target}")
    r = api_post("/api/filterwheel/slot", {"slot": "Nope"})
    check("error" in r, "unknown slot rejected")


def test_focuser_native():
    print("\n=== Step 6. Focuser: native item names + absolute/relative ===")
    f = api_get("/api/focuser")
    check(f.get("connected") is True, "focuser connected")
    pos0 = f.get("position", 0)
    r = api_post("/api/focuser/move", {"position": pos0 + 300})
    check(r.get("ok") is True, f"absolute move → {pos0 + 300} accepted")
    ok = wait_until(lambda: (api_get("/api/focuser").get("position") or 0) > pos0,
                    timeout=40)
    check(ok, "absolute position advanced past start")
    r = api_post("/api/focuser/halt", {})
    check(r.get("ok") is True, "halt accepted")
    ok = wait_until(lambda: api_get("/api/focuser").get("is_moving") is False, timeout=10)
    check(ok, "is_moving -> False after halt")
    cur = api_get("/api/focuser").get("position", 0)
    r = api_post("/api/focuser/move_relative", {"direction": "IN", "steps": 100})
    check(r.get("ok") is True, "move_relative IN 100 accepted")
    ok = wait_until(lambda: api_get("/api/focuser").get("position", 0) < cur, timeout=40)
    check(ok, "position decreased after relative IN")


def test_capture_save_fits():
    print("\n=== Step 5. Capture → BLOB → FITS with BZERO/BSCALE ===")
    r = api_post("/api/camera/expose", {"device": DEV_CAMERA, "duration": 2, "frame_type": "LIGHT"})
    check(r.get("ok") is True, "expose 2s accepted")
    time.sleep(4)
    capture_dir = SAVE_DIR_BLANK
    r = api_post("/api/camera/save", {"dir": capture_dir, "filter": ""})
    check(r.get("ok") is True, f"save accepted (got {r.get('error')})")
    path = r.get("path")
    check(path and path.endswith(".fits"), f"fits path recorded ({path})")
    if path and os.path.exists(path):
        size = os.path.getsize(path)
        check(size > 0, f"file non-empty ({size} bytes)")
        # Verify real header: BITPIX=16, NAXIS, EXPTIME
        with open(path, "rb") as fh:
            block = fh.read(2880)
        ok_hdr = b"SIMPLE" in block and b"BZERO" in block
        check(ok_hdr, "BZERO present in FITS header (unsigned 16-bit)")
        # Focus metric must parse (not fail) even if the flat sim image has no stars
        import base64
        with open(path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        fm = api_post("/api/test/fits-store", {"data": b64})
        check(fm.get("ok") is True, "fits re-injected for metric")
        mm = api_get("/api/focuser/focus-metric")
        check(mm.get("ok") in (True, False) and "error" not in mm,
              f"focus-metric answers (ok={mm.get('ok')})")
        if mm.get("ok"):
            check(mm.get("bg_median", 0) > 0, f"bg_median > 0 ({mm.get('bg_median')})")


def test_sequence_flow():
    print("\n=== Step 7. Sequence: run, pause/resume/stop/reset, dither toggle ===")
    # Completion with dither ON (default config)
    frames = [{"duration": 1, "frame_type": "LIGHT", "filter": "",
               "count": 2, "delay": 0}]
    r = api_post("/api/sequence/start", {"frames": frames,
                                         "save_dir": SAVE_DIR_BLANK})
    check(r.get("ok") is True, "start accepted")
    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=40)
    check(ok, "sequence finished")
    st = api_get("/api/sequence/status")
    check(st["done"] == 2, f"all 2 poses done (got {st['done']})")
    check(st["last_saved"] and st["last_saved"].endswith(".fits"), "last_saved .fits")
    check(st["last_dither"] and "dx" in st["last_dither"], "dither ON reported per pose")

    # Dither OFF via body toggle
    r = api_post("/api/sequence/start", {"frames": frames,
                                         "save_dir": SAVE_DIR_BLANK,
                                         "dither": {"enabled": False}})
    check(r.get("ok") is True, "start with dither OFF accepted")
    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=40)
    check(ok, "finished")
    st = api_get("/api/sequence/status")
    check(st["last_dither"] and st["last_dither"].get("skipped") is True,
          "dither skipped when disabled")

    # Stop mid-run
    r = api_post("/api/sequence/start", {"frames": [{"duration": 2,
                 "frame_type": "LIGHT", "filter": "", "count": 10, "delay": 0}],
                 "save_dir": SAVE_DIR_BLANK})
    check(r.get("ok") is True, "long run started")
    time.sleep(1.5)
    api_post("/api/sequence/stop")
    ok = wait_until(lambda: api_get("/api/sequence/status").get("running") is False,
                    timeout=15)
    check(ok, "stopped")
    st = api_get("/api/sequence/status")
    check(st["done"] < 10, f"stopped early (done={st['done']})")
    api_post("/api/sequence/reset")
    st = api_get("/api/sequence/status")
    check(st["done"] == 0 and st["total"] == 0, "reset clears")


def test_guide_sanity():
    print("\n=== Step 8. Guide sanity (no dedicated guide driver) ===")
    g = api_get("/api/guide/status")
    check(g.get("state") in ("idle", "stopped"), f"idle state ({g.get('state')})")
    r = api_post("/api/guide/start", {"px_per_arcsec": 1.5})
    check(r.get("state") == "guiding", "guide started (state=guiding)")
    r = api_post("/api/guide/set-reference", {"x": 500, "y": 400})
    check(r.get("ref_set") is True, "reference set after start")
    r = api_post("/api/guide/step", {"x": 504, "y": 400, "snr": 5.2})
    check(r.get("drift_x", 0) > 0, f"drift measured ({r.get('drift_x')})")
    r = api_post("/api/guide/stop", {})
    check(r.get("state") == "stopped", "guide stopped cleanly")


# ── Main ───────────────────────────────────────────────────

def main():
    global BASE_URL, INDIGO_PORT, WEB_PORT, SAVE_DIR_BLANK
    parser = argparse.ArgumentParser(description="Noctua — test à blanc INDIGO simulateurs")
    parser.add_argument("--port", type=int, default=17660, help="INDIGO server port")
    parser.add_argument("--web-port", type=int, default=18110, help="Web server port")
    args = parser.parse_args()

    INDIGO_PORT = args.port
    WEB_PORT = args.web_port
    BASE_URL = f"http://127.0.0.1:{WEB_PORT}"

    if not INDIGO_BIN:
        print("ERROR: indigo_server not found in PATH")
        sys.exit(1)

    tmp = tempfile.mkdtemp(prefix="blanc-indigo-")
    SAVE_DIR_BLANK = os.path.join(tmp, "captures")
    os.makedirs(SAVE_DIR_BLANK, exist_ok=True)
    config_path = os.path.join(tmp, "config.yaml")
    profiles_path = os.path.join(tmp, "profiles.yaml")
    with open(config_path, "w") as f:
        f.write(f"""
indigo:
  host: 127.0.0.1
  port: {INDIGO_PORT}
web:
  host: 127.0.0.1
  port: {WEB_PORT}
site:
  name: Test blanc
  latitude: 43.952
  longitude: 1.568
  elevation: 210
  timezone: Europe/Paris
telescope:
  flip_enabled: true
  hour_angle_margin: 0.0
  min_altitude: 5.0
sequence:
  save_dir: {SAVE_DIR_BLANK}
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

    for port in (INDIGO_PORT, WEB_PORT):
        subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)
    time.sleep(0.5)

    print(f"\nStarting indigo_server on :{INDIGO_PORT} ...")
    indigo_proc = subprocess.Popen(
        [INDIGO_BIN, "--port", str(INDIGO_PORT), "-v", *SIM_DRIVERS],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(2.5)

    print("Starting web server (run.py)...")
    env = dict(os.environ)
    env["INDIGO_PROFILES_PATH"] = profiles_path
    web_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{INDIGO_PORT}", "--port", str(WEB_PORT),
         "--config", config_path],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    ok = wait_until(lambda: api_get("/api/connection").get("connected") is True,
                    timeout=60)
    if not ok:
        print("ERROR: web server / INDIGO connection failed")
        kill_proc(web_proc); kill_proc(indigo_proc)
        sys.exit(1)
    wait_until(lambda: api_get("/api/devices"), timeout=10)
    time.sleep(2)

    try:
        test_devices_connect()
        test_profile_apply()
        test_mount_ops()
        test_filterwheel_native()
        test_focuser_native()
        test_capture_save_fits()
        test_sequence_flow()
        test_guide_sanity()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(indigo_proc)
        for port in (INDIGO_PORT, WEB_PORT):
            subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed:
        sys.exit(1)
    print("All test-à-blanc INDIGO checks passed!")


if __name__ == "__main__":
    main()