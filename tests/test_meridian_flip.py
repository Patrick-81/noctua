"""Tests de la détection de crossing du méridien et du flip manuel."""

import asyncio
import pytest

from fastapi.testclient import TestClient
from indigo.client import IndigoClient
from indigo.registry import DeviceRegistry
from indigo.devices.mount import Mount
from web.server import WebServer


class MockIndigoClient:
    """Mock client pour les tests de meridian flip."""

    def __init__(self):
        self.connected = True
        self._properties = {}

    def send_get_properties(self, device_name, prop_name):
        """Simule une réponse de coordonnées."""
        pass

    def send_switch(self, prop_name, items):
        """Simule l'envoi d'un switch."""
        pass

    def send_number(self, prop_name, items):
        """Simule l'envoi d'un nombre."""
        pass

    def on_property_def(self, pv):
        """Renvoie un vecteur de propriétés mock."""
        self._properties[pv.name] = pv

    def on_property_set(self, pv):
        """Renvoie un vecteur de propriétés mock."""
        self._properties[pv.name] = pv

    def on_property_new(self, pv):
        """Renvoie un vecteur de propriétés mock."""
        self._properties[pv.name] = pv

    def on_property_del(self, pv):
        """Renvoie un vecteur de propriétés mock."""
        self._properties.pop(pv.name, None)


@pytest.fixture
def mock_client():
    """Crée un client mock."""
    return MockIndigoClient()


@pytest.fixture
def registry(mock_client):
    """Crée un registry avec une monture configurée."""
    client = mock_client
    registry = DeviceRegistry(client)

    # Simuler une monture avec ses propriétés
    mount = Mount("CGEM", client)
    mount.connected = True
    mount._properties["MOUNT_EQUATORIAL_COORDINATES"] = PropertyVector(
        "MOUNT_EQUATORIAL_COORDINATES", "Ok",
        items=[
            {"name": "RA", "value": 100.5, "unit": "hours"},
            {"name": "DEC", "value": "-5.2", "unit": "degrees"},
        ]
    )
    mount._properties["MOUNT_TRACKING"] = PropertyVector(
        "MOUNT_TRACKING", "On",
        items=[
            {"name": "TRACK_ON", "value": True},
            {"name": "TRACK_OFF", "value": False},
        ]
    )
    mount._properties["MOUNT_PARK"] = PropertyVector(
        "MOUNT_PARK", "Ok",
        items=[
            {"name": "PARKED", "value": False},
            {"name": "UNPARKED", "value": True},
        ]
    )
    mount._properties["MOUNT_MOTION_DEC"] = PropertyVector(
        "MOUNT_MOTION_DEC", "Ok",
        items=[
            {"name": "MOTION_NORTH", "value": False},
            {"name": "MOTION_SOUTH", "value": False},
        ]
    )
    mount._properties["MOUNT_MOTION_RA"] = PropertyVector(
        "MOUNT_MOTION_RA", "Ok",
        items=[
            {"name": "MOTION_EAST", "value": False},
            {"name": "MOTION_WEST", "value": False},
        ]
    )
    mount._properties["MOUNT_ABORT_MOTION"] = PropertyVector(
        "MOUNT_ABORT_MOTION", "Ok",
        items=[
            {"name": "ABORT_MOTION", "value": False},
        ]
    )
    mount._properties["MOUNT_ON_COORDINATES_SET"] = PropertyVector(
        "MOUNT_ON_COORDINATES_SET", "Ok",
        items=[
            {"name": "SLEW", "value": False},
        ]
    )
    mount._properties["MOUNT_SLEW_RATE"] = PropertyVector(
        "MOUNT_SLEW_RATE", "Centering",
        items=[
            {"name": "Guide", "value": False},
            {"name": "Centering", "value": True},
            {"name": "Find", "value": False},
            {"name": "Max", "value": False},
        ]
    )
    mount._properties["MOUNT_HOME"] = PropertyVector(
        "MOUNT_HOME", "Ok",
        items=[
            {"name": "HOME", "value": False},
        ]
    )
    registry.devices["CGEM"] = mount

    return registry


@pytest.fixture
def client(registry):
    """Crée un client de test avec un registry configuré."""
    server = WebServer(registry)
    test_client = TestClient(server.app)
    return test_client


class PropertyVector:
    """Classe simple pour simuler un PropertyVector."""

    def __init__(self, name, state, items=None):
        self.name = name
        self.state = state
        self._items = items or []

    def get_item(self, item_name):
        for item in self._items:
            if item["name"] == item_name:
                return item
        return None

    @property
    def items(self):
        return self._items


@pytest.mark.parametrize("crossing, expected", [
    # (prev_ha, curr_ha, expected_flip_side)
    ((-0.2, 0.05), "east"),
    ((-0.15, 0.0), "east"),
    ((-0.1, 0.01), "east"),
    ((0.0, 0.05), "west"),
    ((0.05, 0.2), "west"),
    ((-0.1, -0.05), None),  # pas de crossing
    ((-0.05, -0.01), None),  # pas de crossing
])
def test_meridian_crossing_detection(client, crossing, expected):
    """Test de la détection de crossing du méridien."""
    # Mock de la monture
    mount = type("MockMount", (), {
        "get_property": lambda name, default=None: {
            "RA": 100.5, "DEC": -5.2,
            "RA_RATE": 15.041068, "DEC_RATE": 15.041068,
            "MOUNT_MODE": "SLEW", "GUIDING": "OFF",
            "MOUNT_NAME": "CGEM", "RA_DEC_ERROR": 0.1,
        }.get(name, default),
        "get_item_value": lambda name, default=None: {
            "RA": 100.5, "DEC": -5.2,
            "RA_RATE": 15.041068, "DEC_RATE": 15.041068,
            "MOUNT_MODE": "SLEW", "GUIDING": "OFF",
            "MOUNT_NAME": "CGEM", "RA_DEC_ERROR": 0.1,
        }.get(name, default),
    })()

    # Injecter le mock dans le registry
    server = client.app.state.server
    server.registry.devices["CGEM"] = mount

    response = client.get("/api/mount/flip/detection")
    assert response.status_code == 200
    data = response.json()
    assert "flip_due" in data
    assert "time_to_flip_fmt" in data

    if expected:
        assert data["flip_due"] == expected
    else:
        assert data["flip_due"] is None


def test_meridian_crossing_no_crossing(client):
    """Aucun crossing détecté."""
    response = client.get("/api/mount/flip/detection")
    assert response.status_code == 200
    data = response.json()
    assert data["flip_due"] is None


@pytest.mark.parametrize("flip_side, time_to_flip, expected_fmt", [
    ("east", 3600, "1:00:00"),
    ("west", 7200, "2:00:00"),
    ("east", 900, "0:15:00"),
    ("west", 0, "0:00:00"),
])
def test_time_to_flip_format(client, flip_side, time_to_flip, expected_fmt):
    """Formatage du temps restant avant le flip."""
    response = client.get("/api/mount/flip/detection")
    assert response.status_code == 200
    data = response.json()

    # On simule un crossing détecté
    data["flip_due"] = flip_side
    expected_hours = time_to_flip / 3600
    expected_mins = int((time_to_flip % 3600) / 60)
    expected_secs = time_to_flip % 60
    expected = f"{expected_hours}:{expected_mins:02d}:{expected_secs:02d}"
    assert data["time_to_flip_fmt"] == expected
