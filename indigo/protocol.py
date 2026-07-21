"""
protocol.py — INDIGO protocol parser and message builder.

Handles XML-mode INDIGO messages over raw TCP.
The INDIGO server speaks XML (not JSON).

Supported tags:
  def*Vector   — property definitions (number, switch, text, blob)
  set*Vector   — property value updates from server
  new*Vector   — property commands from client
  delProperty  — property/device removal
  getProperties — request all properties
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from xml.etree import ElementTree as ET

log = logging.getLogger("indigo.protocol")


# ── Data types ──────────────────────────────────────────────────────

class PropPerm(str, Enum):
    RO = "ro"
    RW = "rw"
    WO = "wo"

class PropRule(str, Enum):
    ONE_OF_MANY = "OneOfMany"
    AT_MOST_ONE = "AtMostOne"
    ANY_OF_MANY = "AnyOfMany"

class VectorType(str, Enum):
    NUMBER = "number"
    SWITCH = "switch"
    TEXT = "text"
    BLOB = "blob"


@dataclass
class Item:
    name: str
    value: Any = None
    label: str = ""
    min: float = 0.0
    max: float = 0.0
    step: float = 0.0
    size: int = 0
    format: str = ""


@dataclass
class PropertyVector:
    device: str
    name: str
    vector_type: VectorType
    state: str = ""
    label: str = ""
    group: str = ""
    perm: PropPerm = PropPerm.RO
    rule: PropRule | None = None
    timeout: int = 0
    message: str = ""
    items: list[Item] = field(default_factory=list)

    def get_item(self, name: str) -> Item | None:
        upper = name.upper()
        for item in self.items:
            if item.name.upper() == upper:
                return item
        return None

    def get_item_value(self, name: str, default=None):
        item = self.get_item(name)
        if item is None:
            return default
        return item.value


# ── XML parsing ─────────────────────────────────────────────────────

VECTOR_TYPE_MAP = {
    "defNumberVector": VectorType.NUMBER,
    "defSwitchVector": VectorType.SWITCH,
    "defTextVector": VectorType.TEXT,
    "defBlobVector": VectorType.BLOB,
    "setNumberVector": VectorType.NUMBER,
    "setSwitchVector": VectorType.SWITCH,
    "setTextVector": VectorType.TEXT,
    "setBlobVector": VectorType.BLOB,
    "newNumberVector": VectorType.NUMBER,
    "newSwitchVector": VectorType.SWITCH,
    "newTextVector": VectorType.TEXT,
    "newBlobVector": VectorType.BLOB,
}


def _parse_xml_item(el: ET.Element, vector_type: VectorType) -> Item:
    """Parse one <oneNumber>, <oneSwitch>, <oneText>, or <oneBlob> element."""
    name = el.get("name", "")
    label = el.get("label", name)

    item = Item(name=name, label=label)

    text = (el.text or "").strip()

    if vector_type == VectorType.NUMBER:
        try:
            item.value = float(text) if text else 0.0
        except ValueError:
            item.value = 0.0
        item.min = float(el.get("min", "0") or "0")
        item.max = float(el.get("max", "0") or "0")
        item.step = float(el.get("step", "0") or "0")
    elif vector_type == VectorType.SWITCH:
        item.value = text.lower() in ("on", "true", "1", "enabled")
    elif vector_type == VectorType.TEXT:
        item.value = text
    elif vector_type == VectorType.BLOB:
        item.value = el.get("value", "")
        item.size = int(el.get("size", "0") or "0")
        item.format = el.get("format", "")

    return item


def parse_xml_message(xml_str: str) -> tuple[str, PropertyVector | dict | None]:
    """Parse a single INDIGO XML message.

    Returns (tag, parsed_object).
    """
    xml_str = xml_str.strip()
    if not xml_str:
        return ("empty", None)

    # Self-closing tags: <getProperties .../> or <delProperty .../>
    if xml_str.startswith("<") and xml_str.endswith("/>"):
        # Extract tag and attributes
        inner = xml_str[1:-2].strip()
        parts = inner.split(None, 1)
        tag = parts[0] if parts else ""
        attrs = {}
        if len(parts) > 1:
            attrs = dict(re.findall(r"""(\w+)=(['"])(.*?)\2""", parts[1]))

        if tag == "delProperty":
            return ("delProperty", {
                "device": attrs.get("device", ""),
                "name": attrs.get("name", ""),
            })
        if tag == "getProperties":
            return ("getProperties", attrs)
        return (tag, None)

    # Tags with content: <defSwitchVector ...>...</defSwitchVector>
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        # Maybe there's junk after the first element — try wrapping in a root
        try:
            root = ET.fromstring(f"<wrapper>{xml_str}</wrapper>")
            if root[0] is not None:
                root = root[0]
            else:
                return ("error", None)
        except ET.ParseError:
            log.warning("XML parse error — raw: %s", xml_str[:120])
            return ("error", None)

    tag = root.tag

    # ── delProperty (with content) ──────────────────────────────
    if tag == "delProperty":
        return ("delProperty", {
            "device": root.get("device", ""),
            "name": root.get("name", ""),
        })

    # ── getProperties ───────────────────────────────────────────
    if tag == "getProperties":
        return ("getProperties", dict(root.attrib))

    # ── Vector types ────────────────────────────────────────────
    vtype = VECTOR_TYPE_MAP.get(tag)
    if vtype is None:
        log.debug("Unknown XML tag: %s", tag)
        return (tag, None)

    pv = PropertyVector(
        device=root.get("device", ""),
        name=root.get("name", ""),
        vector_type=vtype,
        state=root.get("state", ""),
        label=root.get("label", root.get("name", "")),
        group=root.get("group", ""),
        timeout=int(root.get("timeout", "0") or "0"),
        message=root.get("message", ""),
    )

    # Permission
    perm_str = root.get("perm", "ro")
    try:
        pv.perm = PropPerm(perm_str)
    except ValueError:
        pv.perm = PropPerm.RO

    # Rule (switch vectors)
    rule_str = root.get("rule")
    if rule_str:
        try:
            pv.rule = PropRule(rule_str)
        except ValueError:
            pass

    # Items — child elements
    # def*Vector uses <defNumber>/<defSwitch>/<defText>/<defBlob>
    # set*/new*Vector uses <oneNumber>/<oneSwitch>/<oneText>/<oneBlob>
    is_def = tag.startswith("def")
    item_tag = {
        VectorType.NUMBER: "defNumber" if is_def else "oneNumber",
        VectorType.SWITCH: "defSwitch" if is_def else "oneSwitch",
        VectorType.TEXT: "defText" if is_def else "oneText",
        VectorType.BLOB: "defBlob" if is_def else "oneBlob",
    }.get(vtype, "defNumber")

    for child in root.findall(item_tag):
        pv.items.append(_parse_xml_item(child, vtype))

    return (tag, pv)


# ── Sexagesimal conversion ─────────────────────────────────────────

def parse_sexagesimal(s: str) -> float | None:
    """Parse INDIGO sexagesimal string to float."""
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        pass
    parts = []
    for p in s.replace("h", ":").replace("m", ":").replace("s", ":").replace("d", ":").split(":"):
        p = p.strip()
        if p:
            try:
                parts.append(float(p))
            except ValueError:
                return None
    if not parts:
        return None
    val = parts[0]
    if len(parts) >= 2:
        val += parts[1] / 60.0
    if len(parts) >= 3:
        val += parts[2] / 3600.0
    return val


def to_sexagesimal(deg: float, is_ra: bool = False) -> str:
    """Convert decimal degrees to INDIGO sexagesimal string."""
    if is_ra:
        h = deg / 15.0
        hh = int(h)
        mm = int((h - hh) * 60)
        ss = ((h - hh) * 60 - mm) * 60
        return f"{hh}:{mm:02d}:{ss:05.2f}"
    else:
        sign = "+" if deg >= 0 else "-"
        d = abs(deg)
        dd = int(d)
        mm = int((d - dd) * 60)
        ss = ((d - dd) * 60 - mm) * 60
        return f"{sign}{dd}:{mm:02d}:{ss:05.2f}"


# ── XML message builders (client → server) ─────────────────────────

def _xml_attr_str(s: str) -> str:
    """Escape a string for use in XML attributes."""
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def build_get_properties(device: str | None = None,
                         prop_name: str | None = None) -> str:
    """Build a getProperties XML message."""
    parts = ['<getProperties version="1.7"']
    if device:
        parts.append(f' device="{_xml_attr_str(device)}"')
    if prop_name:
        parts.append(f' name="{_xml_attr_str(prop_name)}"')
    parts.append("/>")
    return "".join(parts)


def build_new_number_vector(device: str, prop_name: str,
                            items: list[dict]) -> str:
    """Build a newNumberVector XML command."""
    lines = [
        f'<newNumberVector device="{_xml_attr_str(device)}" name="{_xml_attr_str(prop_name)}">'
    ]
    for item in items:
        name = item["name"]
        v = item["value"]
        try:
            v = float(v)
        except (ValueError, TypeError):
            v = 0.0
        lines.append(f'    <oneNumber name="{_xml_attr_str(name)}">{v}</oneNumber>')
    lines.append("</newNumberVector>")
    return "\n".join(lines)


def build_new_switch_vector(device: str, prop_name: str,
                            items: list[dict]) -> str:
    """Build a newSwitchVector XML command."""
    lines = [
        f'<newSwitchVector device="{_xml_attr_str(device)}" name="{_xml_attr_str(prop_name)}">'
    ]
    for item in items:
        name = item["name"]
        v = item["value"]
        if isinstance(v, str):
            v = v.lower() in ("on", "true", "1")
        state = "On" if v else "Off"
        lines.append(f'    <oneSwitch name="{_xml_attr_str(name)}">{state}</oneSwitch>')
    lines.append("</newSwitchVector>")
    return "\n".join(lines)


def build_new_text_vector(device: str, prop_name: str,
                          items: list[dict]) -> str:
    """Build a newTextVector XML command."""
    lines = [
        f'<newTextVector device="{_xml_attr_str(device)}" name="{_xml_attr_str(prop_name)}">'
    ]
    for item in items:
        name = item["name"]
        val = str(item["value"])
        lines.append(f'    <oneText name="{_xml_attr_str(name)}">{_xml_attr_str(val)}</oneText>')
    lines.append("</newTextVector>")
    return "\n".join(lines)


def build_attach_driver(driver_name: str) -> str:
    """Build a DRIVERS switch to load a driver on the server."""
    return build_new_switch_vector("Server", "DRIVERS", [
        {"name": driver_name, "value": True},
    ])
