"""Tests unitaires de BaseDevice (indigo/devices/base.py)."""
from indigo.devices.base import BaseDevice
from indigo.protocol import Item, PropertyVector, VectorType


def _device_with_items(*names):
    dev = BaseDevice("Cam", client=None)
    dev._properties["PROP"] = PropertyVector(
        device="Cam",
        name="PROP",
        vector_type=VectorType.TEXT,
        items=[Item(name=n) for n in names],
    )
    return dev


def test_get_item_name_returns_matching_candidate_in_order():
    dev = _device_with_items("POSITION", "STEPS")
    assert dev.get_item_name("PROP", "TARGET_POSITION", "POSITION") == "POSITION"


def test_get_item_name_falls_back_to_first_item_when_no_candidate():
    dev = _device_with_items("RAW")
    assert dev.get_item_name("PROP", "EXPOSURE", "DURATION") == "RAW"


def test_get_item_name_returns_candidate_when_prop_missing():
    dev = _device_with_items("STEPS")
    assert dev.get_item_name("UNKNOWN", "EXPOSURE", "DURATION") == "EXPOSURE"


def test_get_item_name_empty_without_prop_or_candidates():
    dev = _device_with_items("STEPS")
    assert dev.get_item_name("UNKNOWN") == ""
