"""Tests d'intégration du flip méridien via l'API réelle (web/routers/mount.py)."""

import pytest
from fastapi.testclient import TestClient

from indigo.devices.mount import Mount
from indigo.protocol import PropertyVector
from indigo.registry import DeviceRegistry
from web.server import WebServer


def _dummy_client():
    """Objet minimal acceptant les callbacks assignés par DeviceRegistry."""
    return type("Client", (), {})()


@pytest.fixture
def registry():
    registry = DeviceRegistry(_dummy_client())
    mount = Mount("CGEM", registry.client)
    mount.connected = True
    mount.ra_hours = 5.0
    mount.dec_deg = 30.0
    mount.az_deg = 180.0
    mount.alt_deg = 40.0
    registry._devices["CGEM"] = mount
    return registry


@pytest.fixture
def client(registry):
    server = WebServer(
        registry,
        site_config={"longitude": 0.0},
        telescope_config={
            "flip_enabled": True,
            "hour_angle_margin": 0.0,
            "min_altitude": 5.0,
        },
    )
    server.registry._devices["CGEM"].client = server.registry.client
    return TestClient(server.app)


def _mount(server):
    return server.registry.get_mount()


def test_no_mount_returns_error():
    reg = DeviceRegistry(_dummy_client())
    server = WebServer(reg, site_config={"longitude": 0.0}, telescope_config={})
    tc = TestClient(server.app)
    resp = tc.get("/api/mount/flip/status")
    assert resp.status_code == 200
    assert resp.json()["error"] == "no mount"


def test_mount_flip_status_shape(client):
    """La route /api/mount/flip/status renvoie bien l'objet flip structuré."""
    resp = client.get("/api/mount/flip/status")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data["flip_due"], bool)
    assert data["flip_side"] in ("est", "ouest", "meridien", "inconnu")
    assert isinstance(data["time_to_flip_fmt"], str)
    assert isinstance(data["ha_fmt"], str)
    assert data["enabled"] is True
    assert "hour_angle_margin" in data
    assert "min_altitude" in data


def test_mount_status_embeds_flip(client):
    """La route /api/mount intègre les figures de flip dans le dict de la monture."""
    resp = client.get("/api/mount")
    assert resp.status_code == 200
    data = resp.json()
    assert data["type"] == "mount"
    assert "flip" in data
    assert "flip_due" in data["flip"]
    assert "flip_side" in data["flip"]
    assert "time_to_flip_fmt" in data["flip"]


def test_mount_without_coordinates_yields_null_ha():
    """Sans RA, le flip doit renvoyer ha_hours à None sans planter."""
    reg = DeviceRegistry(_dummy_client())
    mount = Mount("CGEM", reg.client)
    mount.connected = True
    mount.ra_hours = None
    reg._devices["CGEM"] = mount
    server = WebServer(reg, site_config={"longitude": 0.0}, telescope_config={})
    tc = TestClient(server.app)
    data = tc.get("/api/mount/flip/status").json()
    assert data["ha_hours"] is None
    assert data["flip_due"] is False


def test_flip_auto_recenters_by_solve():
    """_do_meridian_flip exécute un recentrage par solve itératif et renvoie
    flipped=True + recenter.done (le flip auto est bloquant et se recadre)."""
    import asyncio
    import types

    from indigo.devices.camera import Camera

    reg = DeviceRegistry(_dummy_client())
    mount = Mount("CGEM", reg.client)
    mount.connected = True
    mount.ra_hours = 5.0
    mount.dec_deg = 30.0

    server = WebServer(
        reg, site_config={"longitude": 0.0},
        telescope_config={"flip_enabled": True, "recenter_after_flip": True},
    )
    reg._devices["CGEM"] = mount
    server.registry._devices["CGEM"] = mount

    # Mock camera (a real Camera subclass) so the recenter can take a short
    # exposure and have a plate scale hint.
    class Cam(Camera):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._snap = 0

        async def expose(self, dur, typ):  # noqa: D102
            self._snap += 1
            self.exposing = True
            await asyncio.sleep(0.01)
            self.exposing = False
            # Unique image per exposure so the recenter detects a new frame.
            server._camera_images[self.name] = b"FAKE-%d" % self._snap

        async def abort(self):  # noqa: D102
            pass

    cam = Cam("MainCam", reg.client)
    cam._properties["CCD_EXPOSURE"] = {}
    cam.pixel_size_um = 3.76
    cam.focal_length_mm = 500.0
    reg._devices["MainCam"] = cam
    server.registry._devices["MainCam"] = cam

    # Mount motion methods are coroutines on the real device; stub them.
    slew_calls = []

    async def _abort():
        pass

    async def _slew(ra, dec):
        slew_calls.append((ra, dec))

    async def _set_rate(rate):
        pass

    mount.abort = _abort
    mount.slew_to = _slew
    mount.set_slew_rate = _set_rate

    # Fake plate solver: first pass off by ~6' in DEC (just over the 1'
    # tolerance) so it must nudge, second pass centered → converged.
    passes = {"n": 0}

    def fake_solve(img, fmt="fits", ra_hint=None, dec_hint=None, scale_hint=None, **kw):
        passes["n"] += 1
        if passes["n"] == 1:
            return {"ok": True, "ra": ra_hint, "dec": dec_hint + 0.1}
        return {"ok": True, "ra": ra_hint, "dec": dec_hint}

    server.solver = types.SimpleNamespace(solve_image=fake_solve)

    res = asyncio.run(server._do_meridian_flip())

    assert res["ok"] is True
    assert res["flipped"] is True
    assert res["recenter"]["done"] is True
    assert res["recenter"]["passes"] == 2
    assert res["target"]["ra_hours"] == 5.0
    # The flip slew + at least one corrective nudge happened.
    assert len(slew_calls) >= 2
    # The nudge slew moved the mount south because pass 1 overshot north.
    assert all(abs(ra) < 24 for ra, _ in slew_calls)


def test_flip_auto_recenter_skips_without_recenter_flag(monkeypatch):
    """Sans recenter_after_flip, aucun recentrage/solve n'est tenté."""
    import asyncio

    reg = DeviceRegistry(_dummy_client())
    mount = Mount("CGEM", reg.client)
    mount.connected = True
    mount.ra_hours = 5.0
    mount.dec_deg = 30.0

    server = WebServer(
        reg, site_config={"longitude": 0.0},
        telescope_config={"flip_enabled": True, "recenter_after_flip": False},
    )
    reg._devices["CGEM"] = mount
    server.registry._devices["CGEM"] = mount

    called = {"recenter": 0}

    async def spy(*a, **k):
        called["recenter"] += 1
        return {"done": True, "passes": 0, "error": None}

    server._recenter_by_solve = spy

    async def _abort(): pass
    async def _slew(ra, dec): pass
    async def _set_rate(rate): pass
    mount.abort = _abort; mount.slew_to = _slew; mount.set_slew_rate = _set_rate

    res = asyncio.run(server._do_meridian_flip())
    assert called["recenter"] == 0
    assert res["ok"] is True
    assert res["flipped"] is True
    assert res["recenter"]["done"] is False
