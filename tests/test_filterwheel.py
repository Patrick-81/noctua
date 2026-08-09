"""
test_filterwheel.py — Unit tests for the FilterWheel device + slot parsing.
"""

import sys
import os
from pathlib import Path

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.protocol import PropertyVector, VectorType, PropRule  # noqa: E402
from indigo.devices.filterwheel import FilterWheel  # noqa: E402


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send_new_switch(self, device, prop_name, items):
        self.sent.append((prop_name, items))

    async def send_new_number(self, device, prop_name, items):
        self.sent.append((prop_name, items))


def _slot_pv(items, rule=PropRule.ONE_OF_MANY):
    """Build a FILTER_SLOT switch PropertyVector from (name, label, value) tuples."""
    from indigo.protocol import Item
    return PropertyVector(
        device="Filter Wheel", name="FILTER_SLOT", vector_type=VectorType.SWITCH,
        state="Ok", rule=rule,
        items=[Item(name=n, label=l, value=v) for n, l, v in items],
    )


def make_fw():
    client = FakeClient()
    return FilterWheel("Filter Wheel", client)


def test_def_parses_slots_and_labels():
    fw = make_fw()
    fw.on_def("defSwitchVector", _slot_pv([
        ("L", "Luminance", True), ("R", "Red", False),
        ("G", "Green", False), ("B", "Blue", False), ("Ha", "Ha", False),
    ]))
    assert fw.current_slot == "L"
    assert [s["name"] for s in fw.slots] == ["L", "R", "G", "B", "Ha"]
    assert [s["label"] for s in fw.slots] == ["Luminance", "Red", "Green", "Blue", "Ha"]


def test_set_reply_preserves_def_labels():
    fw = make_fw()
    fw.on_def("defSwitchVector", _slot_pv([
        ("L", "Luminance", True), ("R", "Red", False), ("G", "Green", False),
        ("B", "Blue", False), ("Ha", "Ha", False),
    ]))
    # State reply with no labels → labels must survive
    fw.on_set("setSwitchVector", _slot_pv([
        ("L", "L", False), ("R", "R", True), ("G", "G", False),
        ("B", "B", False), ("Ha", "Ha", False),
    ]))
    assert fw.current_slot == "R"
    labels = {s["name"]: s["label"] for s in fw.slots}
    assert labels["L"] == "Luminance"
    assert labels["R"] == "Red"


def test_set_slot_sends_switch():
    import asyncio
    fw = make_fw()
    fw.on_def("defSwitchVector", _slot_pv([("L", "L", True), ("R", "R", False)]))
    asyncio.run(fw.set_slot("R"))
    assert fw.client.sent == [("FILTER_SLOT", [{"name": "R", "value": True}])]


def test_set_slot_unknown_raises():
    import asyncio
    fw = make_fw()
    fw.on_def("defSwitchVector", _slot_pv([("L", "L", True), ("R", "R", False)]))
    try:
        asyncio.run(fw.set_slot("Nope"))
        assert False, "should raise"
    except ValueError as e:
        assert "Unknown filter slot" in str(e)


def test_set_slot_without_property_raises():
    import asyncio
    fw = make_fw()
    try:
        asyncio.run(fw.set_slot("L"))
        assert False, "should raise"
    except RuntimeError as e:
        assert "FILTER_SLOT" in str(e)


def test_slots_list_fallback_to_prop():
    fw = make_fw()
    assert fw.slots_list() == []
    fw.on_def("defSwitchVector", _slot_pv([("L", "L", True), ("R", "R", False)]))
    names = [s["name"] for s in fw.slots_list()]
    assert names == ["L", "R"]


def test_state_dict_contains_filterwheel_type():
    fw = make_fw()
    fw.on_def("defSwitchVector", _slot_pv([("L", "L", True)]))
    sd = fw.state_dict()
    assert sd["type"] == "filterwheel"
    assert "FILTER_SLOT" in sd["properties"]


# ── Native INDIGO 2.x convention: WHEEL_SLOT / WHEEL_SLOT_NAME ──


def _pv_number(name, items):
    """Build a number PropertyVector from (item_name, value) tuples."""
    from indigo.protocol import Item
    return PropertyVector(
        device="Filter Wheel", name=name, vector_type=VectorType.NUMBER,
        state="Ok", items=[Item(name=n, value=v) for n, v in items],
    )


def _pv_text(name, items):
    from indigo.protocol import Item
    return PropertyVector(
        device="Filter Wheel", name=name, vector_type=VectorType.TEXT,
        state="Ok", items=[Item(name=n, value=v) for n, v in items],
    )


def test_wheel_names_parses_slots():
    fw = make_fw()
    fw.connected = True
    fw.on_def("defTextVector", _pv_text("WHEEL_SLOT_NAME", [
        ("SLOT_NAME_1", "Filter #1"), ("SLOT_NAME_2", "Filter #2"),
        ("SLOT_NAME_3", "Filter #3"),
    ]))
    fw.on_def("defNumberVector", _pv_number("WHEEL_SLOT", [("SLOT", 2.0)]))
    assert [s["name"] for s in fw.slots] == ["Filter #1", "Filter #2", "Filter #3"]
    assert fw.current_slot == "Filter #2"
    assert fw.is_attached()


def test_wheel_set_slot_sends_number():
    import asyncio
    fw = make_fw()
    fw.on_def("defTextVector", _pv_text("WHEEL_SLOT_NAME", [
        ("SLOT_NAME_1", "Filter #1"), ("SLOT_NAME_2", "Filter #2"),
        ("SLOT_NAME_3", "Filter #3"),
    ]))
    fw.on_def("defNumberVector", _pv_number("WHEEL_SLOT", [("SLOT", 1.0)]))
    asyncio.run(fw.set_slot("Filter #3"))
    assert fw.client.sent == [("WHEEL_SLOT", [{"name": "SLOT", "value": 3.0}])]
    assert fw.current_slot == "Filter #3"


def test_wheel_set_slot_unknown_raises():
    import asyncio
    fw = make_fw()
    fw.on_def("defTextVector", _pv_text("WHEEL_SLOT_NAME", [
        ("SLOT_NAME_1", "Filter #1"), ("SLOT_NAME_2", "Filter #2"),
    ]))
    fw.on_def("defNumberVector", _pv_number("WHEEL_SLOT", [("SLOT", 1.0)]))
    try:
        asyncio.run(fw.set_slot("Nope"))
        assert False, "should raise"
    except ValueError as e:
        assert "Unknown filter slot" in str(e)


def test_wheel_requires_property_to_set():
    import asyncio
    fw = make_fw()
    try:
        asyncio.run(fw.set_slot("Filter #1"))
        assert False, "should raise"
    except RuntimeError as e:
        assert "FILTER_SLOT/WHEEL_SLOT" in str(e)


def test_wheel_slots_list():
    fw = make_fw()
    assert fw.slots_list() == []
    fw.on_def("defTextVector", _pv_text("WHEEL_SLOT_NAME", [
        ("SLOT_NAME_1", "Red"), ("SLOT_NAME_2", "Green"),
    ]))
    names = [s["name"] for s in fw.slots_list()]
    assert names == ["Red", "Green"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} filterwheel tests passed")
