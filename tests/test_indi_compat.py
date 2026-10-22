"""INDI compatibility tests (camera / focuser / filter wheel / mount).

Covers the property/item names used by libindi drivers, which differ from
the INDIGO v2 conventions the app was originally written against.
"""

import asyncio
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from indigo.protocol import Item, PropertyVector, PropRule, VectorType  # noqa: E402
from indigo.devices.camera import Camera  # noqa: E402
from indigo.devices.focuser import Focuser  # noqa: E402
from indigo.devices.filterwheel import FilterWheel  # noqa: E402
from indigo.devices.mount import Mount, _normalize_rate  # noqa: E402
from indigo.indiweb import categorize_driver  # noqa: E402


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send_new_switch(self, device, prop_name, items):
        self.sent.append(("switch", prop_name, items))

    async def send_new_number(self, device, prop_name, items):
        self.sent.append(("number", prop_name, items))

    async def send_new_text(self, device, prop_name, items):
        self.sent.append(("text", prop_name, items))

    async def send_get_properties(self, device=None, prop_name=None):
        self.sent.append(("get", prop_name))


def _pv(device, name, vt, items, rule=None):
    return PropertyVector(
        device=device, name=name, vector_type=vt, rule=rule,
        items=[Item(name=n, value=v) for n, v in items],
    )


def test_camera_indi_info_and_temperature():
    c = FakeClient()
    cam = Camera("CCD Simulator", c)
    cam.on_def("defNumberVector", _pv("CCD Simulator", "CCD_INFO",
                                      VectorType.NUMBER, [
                                          ("CCD_MAX_X", 4656),
                                          ("CCD_MAX_Y", 3520),
                                          ("CCD_PIXEL_SIZE", 3.8),
                                      ]))
    assert (cam.width_px, cam.height_px, cam.pixel_size_um) == (4656, 3520, 3.8)

    cam.on_def("defNumberVector", _pv("CCD Simulator", "CCD_TEMPERATURE",
                                      VectorType.NUMBER, [
                                          ("CCD_TEMPERATURE_VALUE", 20.0),
                                      ]))
    asyncio.run(cam.set_temperature(-10))
    assert cam.target_temp == -10
    assert c.sent[-1] == ("number", "CCD_TEMPERATURE",
                          [{"name": "CCD_TEMPERATURE_VALUE", "value": -10}])


def test_camera_abort_uses_indi_switch():
    c = FakeClient()
    cam = Camera("CCD Simulator", c)
    cam.on_def("defSwitchVector", _pv("CCD Simulator", "CCD_ABORT_EXPOSURE",
                                      VectorType.SWITCH, [("ABORT", False)],
                                      rule=PropRule.AT_MOST_ONE))
    asyncio.run(cam.abort())
    assert c.sent[-1] == ("switch", "CCD_ABORT_EXPOSURE",
                          [{"name": "ABORT", "value": True}])


def test_focuser_indi_absolute_and_relative():
    c = FakeClient()
    f = Focuser("Focuser Simulator", c)
    f.on_def("defNumberVector", _pv("F", "ABS_FOCUS_POSITION",
                                    VectorType.NUMBER, [
                                        ("FOCUS_ABSOLUTE_POSITION", 1000),
                                    ]))
    assert f.position == 1000

    f.on_def("defSwitchVector", _pv("F", "FOCUS_MOTION", VectorType.SWITCH, [
        ("FOCUS_INWARD", True), ("FOCUS_OUTWARD", False),
    ], rule=PropRule.ONE_OF_MANY))
    f.on_def("defNumberVector", _pv("F", "REL_FOCUS_POSITION",
                                    VectorType.NUMBER, [
                                        ("FOCUS_RELATIVE_POSITION", 0),
                                    ]))

    asyncio.run(f.move_to(1200))
    asyncio.run(f.move_relative("OUT", 50))

    assert c.sent[0] == ("number", "ABS_FOCUS_POSITION",
                         [{"name": "FOCUS_ABSOLUTE_POSITION", "value": 1200}])
    assert c.sent[1] == ("switch", "FOCUS_MOTION", [
        {"name": "FOCUS_INWARD", "value": False},
        {"name": "FOCUS_OUTWARD", "value": True},
    ])
    assert c.sent[2] == ("number", "REL_FOCUS_POSITION",
                         [{"name": "FOCUS_RELATIVE_POSITION", "value": 50}])


def test_filterwheel_indi_number_and_names():
    c = FakeClient()
    w = FilterWheel("W", c)
    w.on_def("defTextVector", _pv("W", "FILTER_NAME", VectorType.TEXT, [
        ("FILTER_SLOT_NAME_1", "L"), ("FILTER_SLOT_NAME_2", "R"),
    ]))
    w.on_def("defNumberVector", _pv("W", "FILTER_SLOT", VectorType.NUMBER, [
        ("FILTER_SLOT_VALUE", 1),
    ]))
    assert [s["name"] for s in w.slots] == ["L", "R"]
    assert w.current_slot == "L"

    asyncio.run(w.set_slot("R"))
    assert c.sent[-1] == ("number", "FILTER_SLOT",
                          [{"name": "FILTER_SLOT_VALUE", "value": 2.0}])


def test_mount_slew_rate_normalization():
    assert _normalize_rate("SLEW_CENTERING") == _normalize_rate("Centering")
    c = FakeClient()
    m = Mount("Telescope Simulator", c)
    m.on_def("defSwitchVector", _pv("T", "TELESCOPE_SLEW_RATE",
                                    VectorType.SWITCH, [
                                        ("SLEW_GUIDE", False),
                                        ("SLEW_CENTERING", True),
                                        ("SLEW_FIND", False),
                                        ("SLEW_MAX", False),
                                    ], rule=PropRule.ONE_OF_MANY))
    asyncio.run(m.set_slew_rate("Guide"))
    assert c.sent[-1] == ("switch", "TELESCOPE_SLEW_RATE", [
        {"name": "SLEW_GUIDE", "value": True},
        {"name": "SLEW_CENTERING", "value": False},
        {"name": "SLEW_FIND", "value": False},
        {"name": "SLEW_MAX", "value": False},
    ])


def test_mount_pulse_uses_timed_guide():
    c = FakeClient()
    m = Mount("Telescope Simulator", c)
    m.on_def("defNumberVector", _pv("T", "TELESCOPE_TIMED_GUIDE_NS",
                                    VectorType.NUMBER, [
                                        ("TIMED_GUIDE_N", 0),
                                        ("TIMED_GUIDE_S", 0),
                                    ]))
    asyncio.run(m.pulse("North", 150))
    assert c.sent[-1] == ("number", "TELESCOPE_TIMED_GUIDE_NS",
                          [{"name": "TIMED_GUIDE_N", "value": 150.0}])


def test_indiweb_categorization():
    assert categorize_driver({"family": "CCDs"}) == "camera"
    assert categorize_driver({"binary": "indi_eqmod_telescope"}) == "mount"
    assert categorize_driver({"label": "ZWO Filter Wheel"}) == "filter_wheel"
