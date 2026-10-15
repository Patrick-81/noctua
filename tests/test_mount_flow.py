"""
test_mount_flow.py — Sanctuarisation du pilotage monture.

Tests bout-en-bout (mock INDIGO + web server) couvrant park/unpark, slew,
tracking, home, move/halt — ET l'isolation monture↔caméra : une séquence de
capture en cours ne doit jamais casser le pilotage monture.

Le but : toute modification sur la caméra/aperçu ne doit pas régresser la
monture — c'est le filet de sécurité qui le vérifie.

Run via: python tests/test_mount_flow.py
"""

__test__ = False  # pytest: run via python tests/test_mount_flow.py

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
PYTHON = os.path.join(ROOT, "venv", "bin", "python") if os.path.isdir(os.path.join(ROOT, "venv")) else os.path.join(ROOT, ".venv", "bin", "python")
MOCK_PORT = 17626
WEB_PORT = 18089
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
        resp = urllib.request.urlopen(req, timeout=15)
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


def mount_state():
    return api_get("/api/mount")


def kill_proc(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def connect_all():
    api_post("/api/hardware/connect-all")
    wait_until(lambda: mount_state().get("connected") is True, timeout=10)


# ── Tests monture ───────────────────────────────────────────

def test_mount_initial_state():
    print("\n=== Test: /api/mount état initial ===")
    # Le def MOUNT_PARK porte UNPARKED=On puis le setState pousse PARKED=On :
    # laisser l'état se stabiliser avant d'assert.
    parked_settled = wait_until(lambda: mount_state().get("parked") is True, timeout=10)
    r = mount_state()
    check(r.get("type") == "mount", f"type=mount (got {r.get('type')})")
    check(r.get("connected") is True, "mount connected")
    check(parked_settled, f"parked initial au setState du mock (got {r.get('parked')})")
    check(r.get("park_state") not in (None, ""), f"park_state renseigné (got {r.get('park_state')})")


def test_unpark_park_cycle():
    print("\n=== Test: unpark → park (cycle) ===")
    if not mount_state().get("parked"):
        api_post("/api/mount/park")
        wait_until(lambda: mount_state().get("parked") is True)
    # unpark
    r = api_post("/api/mount/unpark")
    check(r.get("ok") is True, f"POST /api/mount/unpark → ok (got {r})")
    parked = wait_until(lambda: mount_state().get("parked") is False, timeout=5)
    check(parked, "unpark: parked → False")
    st = mount_state()
    check(st.get("connected") is True, "unpark: toujours connecté")
    check(st.get("tracking") is False, f"unpark: tracking resté False (got {st.get('tracking')})")
    # park
    r = api_post("/api/mount/park")
    check(r.get("ok") is True, f"POST /api/mount/park → ok (got {r})")
    parked = wait_until(lambda: mount_state().get("parked") is True, timeout=5)
    check(parked, "park: parked → True")


def test_tracking_toggle():
    print("\n=== Test: tracking ON/OFF ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    r = api_post("/api/mount/tracking", {"on": True})
    check(r.get("ok") is True, f"tracking on → ok (got {r})")
    on = wait_until(lambda: mount_state().get("tracking") is True)
    check(on, f"tracking True (got {mount_state().get('tracking')})")
    r = api_post("/api/mount/tracking", {"on": False})
    check(r.get("ok") is True, "tracking off → ok")
    off = wait_until(lambda: mount_state().get("tracking") is False)
    check(off, f"tracking False (got {mount_state().get('tracking')})")


def test_slew():
    print("\n=== Test: slew + détection de fin ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    r = api_post("/api/mount/slew", {"ra_hours": 11.0, "dec_deg": 67.0})
    check(r.get("ok") is True, f"POST /api/mount/slew → ok (got {r})")
    slewing = wait_until(lambda: mount_state().get("slewing") is True, timeout=3)
    check(slewing, "slewing → True pendant le slew")
    done = wait_until(lambda: mount_state().get("slewing") is False, timeout=8)
    check(done, "slewing → False (slew terminé)")
    st = mount_state()
    check(abs(st.get("ra_hours", 0) - 11.0) < 0.01, f"RA≈11h (got {st.get('ra_hours')})")
    check(abs(st.get("dec_deg", 0) - 67.0) < 0.01, f"DEC≈67° (got {st.get('dec_deg')})")


def test_abort_slew():
    print("\n=== Test: abort interrompt un slew ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    api_post("/api/mount/slew", {"ra_hours": 1.0, "dec_deg": -40.0})
    wait_until(lambda: mount_state().get("slewing") is True, timeout=3)
    r = api_post("/api/mount/abort")
    check(r.get("ok") is True, f"POST /api/mount/abort → ok (got {r})")
    stopped = wait_until(lambda: mount_state().get("slewing") is False, timeout=3)
    check(stopped, "slewing → False après abort")
    # Le mock est asynchrone et bloque sa boucle de lecture pendant ~3s de
    # simulation : attendre que les coords se stabilisent (mock réellement
    # idle) avant de passer au test suivant.
    read_settled(timeout=12)


def test_home():
    print("\n=== Test: home ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    r = api_post("/api/mount/home")
    check(r.get("ok") is True, f"POST /api/mount/home → ok (got {r})")
    homing = wait_until(lambda: mount_state().get("homing") is True, timeout=3)
    check(homing, "homing → True pendant home")
    done = wait_until(lambda: mount_state().get("homing") is False, timeout=8)
    check(done, "homing → False (home terminé)")
    check(mount_state().get("homed") is True, "homed → True après home (LED verte)")
    r = api_post("/api/mount/slew", {"ra_hours": 11.0, "dec_deg": 67.0})
    check(r.get("ok") is True, "slew après home → ok")
    wait_until(lambda: mount_state().get("slewing") is True, timeout=5)
    wait_until(lambda: mount_state().get("slewing") is False, timeout=8)
    check(mount_state().get("homed") is False, "homed → False après slew (sortie de home)")


def read_settled(timeout=8, window=0.35, reads=3):
    """Read mount coords until they are stable across `reads` consecutive reads.

    Les coords ne sont poussées par le mock que pendant les mouvements : après
    un halt, laisser le temps au client de traiter le backlog de l'event loop.
    """
    last = None
    stable = 0
    end = time.time() + timeout
    while time.time() < end:
        st = mount_state()
        cur = (round(st.get("ra_hours", 0), 4), round(st.get("dec_deg", 0), 4))
        if last is not None and cur == last:
            stable += 1
            if stable >= reads:
                return cur
        else:
            stable = 0
        last = cur
        time.sleep(window)
    return last


# ── ws:state — chemin UI (unpark button + handpad) ───────────

async def _ws_until_parked(ws, want, timeout=10):
    """Read ws recv until a state broadcast reports devices.Mount.parked == want."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.2, deadline - loop.time()))
        except (asyncio.TimeoutError, Exception):
            return False
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("type") != "state":
            continue
        m = msg.get("devices", {}).get("Mount")
        if m and m.get("parked") is want:
            return True
    return False


async def _ws_drain_initial(ws):
    for _ in range(30):
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("type") == "state":
            return msg
    return None


def test_ws_state_mount_broadcast():
    print("\n=== Test: ws:state reflète park/unpark (chemin UI) ===")
    import asyncio as _ai
    import websockets

    async def _run():
        async with websockets.connect(f"ws://127.0.0.1:{WEB_PORT}/ws",
                                      max_size=None) as ws:
            initial = await _ws_drain_initial(ws)
            check(initial and "Mount" in initial.get("devices", {}),
                  "état initial ws:state contient la monture")
            # Garantit un point de départ parké
            await _ai.to_thread(api_post, "/api/mount/park", {})
            check(await _ws_until_parked(ws, True, 10),
                  "ws:state → parked=True (park)")
            # unpark → le bouton UI passe à actif
            r = await _ai.to_thread(api_post, "/api/mount/unpark", {})
            check(r.get("ok") is True, f"unpark HTTP ok (got {r})")
            check(await _ws_until_parked(ws, False, 10),
                  "ws:state → parked=False (unpark)")
            # park à nouveau
            r = await _ai.to_thread(api_post, "/api/mount/park", {})
            check(await _ws_until_parked(ws, True, 10),
                  "ws:state → parked=True (re-park)")

    try:
        _ai.run(_run())
    except Exception as e:  # noqa: BLE001
        check(False, f"ws:state mount broadcast failed: {e}")


def test_ws_state_mount_during_capture():
    print("\n=== Test: ws:state monture réactif pendant capture caméra ===")
    import asyncio as _ai
    import websockets

    # Sécurité : caméra connectée
    if not api_get("/api/hardware").get("devices", {}).get("Main Camera", {}).get("connected"):
        api_post("/api/hardware/connect", {"device": "Main Camera"})
        wait_until(lambda: api_get("/api/hardware").get("devices", {}).get("Main Camera", {}).get("connected") is True, timeout=8)

    async def _run():
        async with websockets.connect(f"ws://127.0.0.1:{WEB_PORT}/ws",
                                      max_size=None) as ws:
            await _ws_drain_initial(ws)
            await _ai.to_thread(api_post, "/api/mount/park", {})
            await _ws_until_parked(ws, True, 10)
            # Capture en cours (FITS >2 Mo → thumbs JPEG côté serveur), et
            # pendant ce temps l'UI doit voir l'unpark : c'est la régression
            # «unpark inopérant / handpad figé» à verrouiller.
            r = await _ai.to_thread(api_post, "/api/camera/expose",
                                    {"device": "Main Camera", "duration": 1.0})
            check(r.get("ok") is True, f"expose caméra pendant ws (got {r})")
            await _ai.sleep(0.3)
            r = await _ai.to_thread(api_post, "/api/mount/unpark", {})
            check(r.get("ok") is True, f"unpark pendant capture → ok (got {r})")
            t0 = _ai.get_event_loop().time()
            ok = await _ws_until_parked(ws, False, 10)
            dt = _ai.get_event_loop().time() - t0
            check(ok, f"ws:state parked=False arrive pendant capture ({dt*1000:.0f}ms)")
            # L'image termine bien son cycle thumbs
            await _ai.to_thread(wait_until, lambda: api_post("/api/camera/save", {"dir": "/tmp"}).get("ok") is True, 8)

    try:
        _ai.run(_run())
    except Exception as e:  # noqa: BLE001
        check(False, f"ws:state pendant capture failed: {e}")


def test_move_and_halt():
    print("\n=== Test: move N/S/E/W + halt ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    # Repartir d'une position médiane (home laisse DEC=90° : pas de marge NORTH)
    api_post("/api/mount/slew", {"ra_hours": 5.0, "dec_deg": 30.0})
    wait_until(lambda: mount_state().get("slewing") is False, timeout=8)
    # Sync initial : un petit move NORTH + halt force le mock à pousser les
    # coords courantes et resynchronise le client avant les asserts.
    api_post("/api/mount/move", {"direction": "NORTH", "rate": "Centering"})
    time.sleep(0.5)
    api_post("/api/mount/halt")
    read_settled()

    # NORTH : DEC augmente
    before = read_settled()
    r = api_post("/api/mount/move", {"direction": "NORTH", "rate": "Centering"})
    check(r.get("ok") is True, f"move NORTH → ok (got {r})")
    time.sleep(1.0)
    r = api_post("/api/mount/halt")
    check(r.get("ok") is True, f"halt → ok (got {r})")
    after = read_settled()
    check(after[1] > before[1], f"move NORTH: DEC a augmenté ({before[0]:.3f},{before[1]:.3f} → {after[0]:.3f},{after[1]:.3f})")

    # SOUTH : DEC diminue
    before = read_settled()
    r = api_post("/api/mount/move", {"direction": "SOUTH", "rate": "Centering"})
    time.sleep(1.0)
    api_post("/api/mount/halt")
    after = read_settled()
    check(after[1] < before[1], f"move SOUTH: DEC a diminué ({before[0]:.3f},{before[1]:.3f} → {after[0]:.3f},{after[1]:.3f})")

    # WEST : RA augmente (vers 24h)
    before = read_settled()
    r = api_post("/api/mount/move", {"direction": "WEST", "rate": "Centering"})
    time.sleep(1.0)
    api_post("/api/mount/halt")
    after = read_settled()
    check(after[0] > before[0], f"move WEST: RA a augmenté ({before[0]:.3f},{before[1]:.3f} → {after[0]:.3f},{after[1]:.3f})")

    # EAST : RA diminue
    before = read_settled()
    r = api_post("/api/mount/move", {"direction": "EAST", "rate": "Centering"})
    time.sleep(1.0)
    api_post("/api/mount/halt")
    after = read_settled()
    check(after[0] < before[0], f"move EAST: RA a diminué ({before[0]:.3f},{before[1]:.3f} → {after[0]:.3f},{after[1]:.3f})")

    st = mount_state()
    check(st.get("slewing") is False, "après la série: slewing False")


def test_move_while_parked():
    print("\n=== Test: move sur monture parkée ne casse pas le backend ===")
    api_post("/api/mount/park")
    wait_until(lambda: mount_state().get("parked") is True)
    r = api_post("/api/mount/move", {"direction": "NORTH"})
    check(r.get("ok") is True, f"move ne plante pas backend (got {r})")
    # La monture reste identifiée parkée côté client
    check(mount_state().get("parked") is True, "parked reste True après move")
    # Cleanup : stop le mouvement du mock relancé par le move
    api_post("/api/mount/halt")
    api_post("/api/mount/park")
    wait_until(lambda: mount_state().get("parked") is True)


# ── Isolation monture ↔ caméra ──────────────────────────────

def test_camera_capture_does_not_break_mount():
    print("\n=== Test: capture caméra + commande monture simultanées ===")
    # Sécurité : s'assurer que la caméra principale est connectée
    if not api_get("/api/hardware").get("devices", {}).get("Main Camera", {}).get("connected"):
        api_post("/api/hardware/connect", {"device": "Main Camera"})
    wait_until(lambda: api_get("/api/hardware").get("devices", {}).get("Main Camera", {}).get("connected") is True, timeout=8)
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)

    # On lance une capture (le FITS >2 Mo déclenche les thumbnails JPEG côté
    # serveur — le chemin qui a introduit la régression).
    exp_r = api_post("/api/camera/expose", {"device": "Main Camera", "duration": 1.0})
    check(exp_r.get("ok") is True, f"expose caméra → ok (got {exp_r})")
    time.sleep(0.5)

    # Pendant la capture, la monture doit répondre immédiatement.
    t0 = time.time()
    r = api_post("/api/mount/tracking", {"on": True})
    dt = time.time() - t0
    check(r.get("ok") is True, f"mount/tracking répond pendant capture (got {r}, {dt*1000:.0f}ms)")
    check(dt < 5.0, f"latence commande monture < 5s pendant capture ({dt*1000:.0f}ms)")

    r = api_post("/api/mount/move", {"direction": "EAST", "rate": "Centering"})
    check(r.get("ok") is True, "mount/move pendant capture → ok")
    time.sleep(0.5)
    api_post("/api/mount/halt")

    # L'image arrive bien (le FITS a déclenché les thumbs — l'event loop a tenu).
    def _image_ready():
        sav = api_post("/api/camera/save", {"dir": "/tmp"})
        return sav.get("ok") is True
    ready = wait_until(_image_ready, timeout=15)
    check(ready, "image caméra bien arrivée pendant/t après la commande monture")

    # L'état monture est toujours cohérent
    st = mount_state()
    check(st.get("connected") is True, "monture toujours connectée après capture")
    check(st.get("slewing") is False, "monture pas en slewing résiduel")


def test_long_camera_stream_keeps_mount_responsive():
    print("\n=== Test: rafale de poses + monture réactive ===")
    api_post("/api/mount/unpark")
    wait_until(lambda: mount_state().get("parked") is False)
    # 3 poses rapides en arrière-plan (chaque FITS >2Mo → 2 thumbs)
    for i in range(3):
        api_post("/api/camera/expose", {"device": "Main Camera", "duration": 0.2})
        time.sleep(2.2)
    # La monture répond après la rafale
    t0 = time.time()
    r = api_post("/api/mount/tracking", {"on": False})
    dt = time.time() - t0
    check(r.get("ok") is True, f"monture répond après rafale poses (got {r})")
    check(dt < 3.0, f"latence après rafale < 3s ({dt*1000:.0f}ms)")


# ── Main ────────────────────────────────────────────────────

def main():
    global passed, failed

    print("=" * 60)
    print("Mount Flow Integration Tests (sanctuarisation monture)")
    print("=" * 60)

    profiles_path = os.path.join(tempfile.mkdtemp(), "profiles.yaml")

    for port in [MOCK_PORT, WEB_PORT]:
        try:
            subprocess.run(["fuser", "-k", f"{port}/tcp"], timeout=2, capture_output=True)
        except Exception:
            pass
    time.sleep(0.5)

    print("\nStarting mock INDIGO server...")
    log_dir = tempfile.mkdtemp(prefix="mountflow_")
    mock_log = open(os.path.join(log_dir, "mock_indigo.log"), "w")
    web_log = open(os.path.join(log_dir, "web_server.log"), "w")
    mock_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "tests", "mock_indigo.py"), "--port", str(MOCK_PORT)],
        cwd=ROOT, stdout=mock_log, stderr=subprocess.STDOUT
    )
    time.sleep(1.5)

    print("Starting web server...")
    env = dict(os.environ)
    env["INDIGO_PROFILES_PATH"] = profiles_path
    web_proc = subprocess.Popen(
        [PYTHON, os.path.join(ROOT, "run.py"), f"127.0.0.1:{MOCK_PORT}", "--port", str(WEB_PORT)],
        cwd=ROOT, stdout=web_log, stderr=subprocess.STDOUT, env=env
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
        connect_all()
        test_mount_initial_state()
        test_unpark_park_cycle()
        test_tracking_toggle()
        test_slew()
        test_abort_slew()
        test_home()
        test_move_and_halt()
        test_move_while_parked()
        test_camera_capture_does_not_break_mount()
        test_long_camera_stream_keeps_mount_responsive()
        test_ws_state_mount_broadcast()
        test_ws_state_mount_during_capture()
    finally:
        print("\n\nShutting down...")
        kill_proc(web_proc)
        kill_proc(mock_proc)
        mock_log.close()
        web_log.close()
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
        print("All mount integration tests passed!")


if __name__ == "__main__":
    main()