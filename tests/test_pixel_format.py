"""Tests for RAW16 pixel-format preference (indigo/devices/camera.py)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from indigo.devices.camera import raw16_upgrade, raw16_mode_upgrade


def test_raw8_to_raw16_svb():
    items = [(n, n == "RAW 8") for n in
             ["RAW 8", "RGB 24", "RAW 16", "Y 8", "Y 16"]]
    assert raw16_upgrade(items) == "RAW 16"


def test_already_16bit_left_alone():
    items = [(n, n == "RAW 16") for n in ["RAW 8", "RGB 24", "RAW 16"]]
    assert raw16_upgrade(items) is None


def test_rgb_untouched():
    items = [(n, n == "RGB 24") for n in ["RAW 8", "RGB 24", "RAW 16"]]
    assert raw16_upgrade(items) is None


def test_no_16bit_option():
    items = [(n, n == "RAW 8") for n in ["RAW 8", "Y 8"]]
    assert raw16_upgrade(items) is None


def test_case_spacing_tolerant():
    items = [("raw 8", True), ("raw16", False)]
    assert raw16_upgrade(items) == "raw16"


def test_y8_to_y16():
    items = [("Y 8", True), ("Y 16", False)]
    assert raw16_upgrade(items) == "Y 16"


def test_mode_raw8_to_raw16_same_geometry():
    items = [(n, n == "RAW 8 1x1") for n in ["RAW 8 1x1", "RAW 16 1x1"]]
    assert raw16_mode_upgrade(items) == "RAW 16 1x1"


def test_mode_already_16bit():
    items = [(n, n == "RAW 16 1x1") for n in ["RAW 8 1x1", "RAW 16 1x1"]]
    assert raw16_mode_upgrade(items) is None


def test_mode_rgb_untouched():
    items = [(n, n == "RGB08_1") for n in ["RGB08_1", "RAW 16 1x1"]]
    assert raw16_mode_upgrade(items) is None


def test_mode_no_16bit_sibling():
    items = [("RAW 8 1x1", True)]
    assert raw16_mode_upgrade(items) is None


def test_mode_binning_suffix_kept():
    items = [(n, n == "RAW 8 2x2") for n in
             ["RAW 8 1x1", "RAW 8 2x2", "RAW 16 1x1", "RAW 16 2x2"]]
    assert raw16_mode_upgrade(items) == "RAW 16 2x2"


if __name__ == "__main__":
    for fn in (test_raw8_to_raw16_svb, test_already_16bit_left_alone,
                test_rgb_untouched, test_no_16bit_option,
                test_case_spacing_tolerant, test_y8_to_y16,
                test_mode_raw8_to_raw16_same_geometry,
                test_mode_already_16bit, test_mode_rgb_untouched,
                test_mode_no_16bit_sibling, test_mode_binning_suffix_kept):
        print(f"{fn.__name__} ...")
        fn()
    print("PIXEL FORMAT OK")
