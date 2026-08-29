"""Tests d'intégration de la mosaïque (Lot D1) via l'API réelle.

La partie "déplacement de tuile" est testée à travers ``_move_to_tile``
(directement, comme le flip) ; l'exécution complète d'une mini séquence
HTTP mosaïque est vérifiée par le flux `test_sequence_flow.py`.
"""

import asyncio
import types

import pytest
from fastapi.testclient import TestClient

from indigo.devices.camera import Camera
from indigo.devices.mosaic import expand_frames, plan_mosaic
from indigo.devices.mount import Mount
from indigo.registry import DeviceRegistry
from web.routers.sequence import _move_to_tile
from web.server import WebServer


def _dummy_client():
    return type("Client", (), {})()


@pytest.fixture
def server_stub():
    reg = DeviceRegistry(_dummy_client())
    mount = Mount("CGEM", reg.client)
    mount.connected = True
    mount.ra_hours = 5.0
    mount.dec_deg = 30.0
    reg._devices["CGEM"] = mount

    server = WebServer(
        reg, site_config={"longitude": 0.0},
        telescope_config={"flip_enabled": False},
    )
    reg._devices["CGEM"].client = reg.client
    return server


def _fake_camera(server):
    """Caméra factice : exposition courte et image unique par pose."""
    class Cam(Camera):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._snap = 0
            self.pixel_size_um = 3.76
            self.focal_length_mm = 500.0
            self.width_px = 1920
            self.height_px = 1080

        async def expose(self, dur, typ):
            self._snap += 1
            self.exposing = True
            await asyncio.sleep(0.01)
            self.exposing = False
            server._camera_images[self.name] = b"FAKE-%d" % self._snap

        async def abort(self):
            pass

    cam = Cam("MainCam", server.registry.client)
    cam._properties["CCD_EXPOSURE"] = {}
    server.registry._devices["MainCam"] = cam
    return cam


def test_fov_route_from_camera(server_stub):
    _fake_camera(server_stub)
    client = TestClient(server_stub.app)
    resp = client.get("/api/mosaic/fov")
    assert resp.status_code == 200
    d = resp.json()
    assert d["ok"] is True
    assert d["fov_x_deg"] > 0 and d["fov_y_deg"] > 0
    assert d["camera"] == "MainCam"


def test_start_rejects_mosaic_without_target_coords(server_stub):
    _fake_camera(server_stub)
    client = TestClient(server_stub.app)
    body = {
        "frames": [{"duration": 0.1, "frame_type": "LIGHT",
                    "filter": "", "count": 1, "delay": 0.0}],
        "target": "X",
        "mosaic": {"size_arcmin": {"w": 60, "h": 60},
                   "overlap_frac": 0.1,
                   "fov_x_deg": 10.0, "fov_y_deg": 10.0},
    }
    resp = client.post("/api/sequence/start", json=body)
    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert "target_coords" in resp.json()["error"]


def test_start_rejects_mosaic_without_fov(server_stub):
    client = TestClient(server_stub.app)
    body = {
        "frames": [{"duration": 0.1, "frame_type": "LIGHT",
                    "filter": "", "count": 1, "delay": 0.0}],
        "target": "X",
        "target_coords": {"ra_hours": 1.0, "dec_deg": 40.0},
        "mosaic": {"size_arcmin": {"w": 60, "h": 60}, "overlap_frac": 0.1},
    }
    resp = client.post("/api/sequence/start", json=body)
    assert resp.status_code == 200
    assert resp.json()["ok"] is False
    assert "FOV" in resp.json()["error"]


def test_plan_route_with_explicit_fov(server_stub):
    client = TestClient(server_stub.app)
    resp = client.post("/api/mosaic/plan", json={
        "target_coords": {"ra_hours": 6.7833, "dec_deg": 41.0617},
        "size_arcmin": {"w": 60, "h": 60},
        "overlap_frac": 0.5,
        "fov_x_deg": 1.0, "fov_y_deg": 1.0,
    })
    assert resp.status_code == 200
    plan = resp.json()
    assert plan["ok"] is True
    assert plan["rows"] == 2 and plan["cols"] == 2
    assert len(plan["tiles"]) == 4
    assert plan["tiles"][3]["row"] == 1 and plan["tiles"][3]["col"] == 1


def test_plan_route_rejects_unknown_fov(server_stub):
    client = TestClient(server_stub.app)
    resp = client.post("/api/mosaic/plan", json={
        "target_coords": {"ra_hours": 6.7833, "dec_deg": 41.0617},
        "size_arcmin": {"w": 60, "h": 60},
        "overlap_frac": 0.5,
    })
    d = resp.json()
    assert d["ok"] is False
    assert "FOV" in d["error"]


def test_move_to_tile_slews_and_recenters(server_stub):
    server = server_stub
    mount = server.registry.get_mount()

    _fake_camera(server)

    slew_calls = []
    recenter_calls = []

    async def _slew(ra, dec):
        slew_calls.append((ra, dec))

    async def _abort():
        pass

    async def _set_rate(rate):
        pass

    mount.abort = _abort
    mount.slew_to = _slew
    mount.set_slew_rate = _set_rate

    def fake_solve(img, fmt="fits", ra_hint=None, dec_hint=None, scale_hint=None, **kw):
        return {"ok": True, "ra": ra_hint, "dec": dec_hint}

    server.solver = types.SimpleNamespace(solve_image=fake_solve)

    async def _monkey_recenter(ra, dec, **kw):
        recenter_calls.append((ra, dec))
        return {"done": True, "passes": 1, "error": None}

    server._recenter_by_solve = _monkey_recenter

    res = asyncio.run(_move_to_tile(server, 2, 1.2, 35.0))
    assert res["moved"] is True
    assert res["tile"] == 2
    assert res["recenter"]["done"] is True
    assert slew_calls == [(1.2, 35.0)]
    assert recenter_calls == [(1.2, 35.0)]


def test_move_to_tile_no_mount_degrades_gracefully(server_stub):
    server = server_stub

    async def _boom(*a, **k):
        raise AssertionError("recenter appelé sans monture")

    server._recenter_by_solve = _boom
    mount = server.registry.get_mount()
    mount.connected = False

    res = asyncio.run(_move_to_tile(server, 1, 1.0, 30.0))
    assert res["moved"] is False
    assert res["error"] == "no mount"


def test_expand_via_module():
    plan = plan_mosaic(50, 20, 60, 60, 1.0, 1.0, 0.5)
    frames = [{"duration": 5.0, "count": 1}]
    out = expand_frames(frames, plan)
    assert len(out) == 4
    assert out[0]["tile"] == 0 and out[3]["tile"] == 3
    assert out[1]["tile_row"] == 0 and out[1]["tile_col"] == 1