"""Tests unitaires du parsing XML/INDI (indigo/protocol.py)."""
import pytest

from indigo.protocol import parse_xml_message


def _parse_first(xml: str):
    out = parse_xml_message(xml)
    assert out is not None
    tag, pv = out
    assert pv is not None
    return pv


def test_def_number_value_from_attribute():
    """Les defs INDIGO portent la valeur dans l'attribut value, pas en texte."""
    xml = (
        '<defNumberVector device="Main Camera" name="CCD_INFO" state="Ok">'
        '<defNumber name="WIDTH" value="1920" label="Width"/>'
        '<defNumber name="HEIGHT" value="1080" label="Height"/>'
        '<defNumber name="PIXEL_SIZE" value="3.75" label="Pixel Size"/>'
        '</defNumberVector>'
    )
    pv = _parse_first(xml)
    assert pv.get_item("WIDTH").value == 1920
    assert pv.get_item("HEIGHT").value == 1080
    assert pv.get_item("PIXEL_SIZE").value == 3.75


def test_one_number_value_from_text():
    """Les set*Vector portent la valeur en texte de l'élément."""
    xml = (
        '<setNumberVector device="Main Camera" name="CCD_INFO" state="Ok">'
        '<oneNumber name="WIDTH">1920</oneNumber>'
        '</setNumberVector>'
    )
    pv = _parse_first(xml)
    assert pv.get_item("WIDTH").value == 1920


def test_number_text_takes_priority_when_both_present():
    xml = (
        '<setNumberVector device="Cam" name="X" state="Ok">'
        '<oneNumber name="A" value="1">42</oneNumber>'
        '</setNumberVector>'
    )
    pv = _parse_first(xml)
    assert pv.get_item("A").value == 42
