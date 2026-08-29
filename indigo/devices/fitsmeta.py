"""
fitsmeta.py — Normalized FITS header metadata injection (Lot C4).

Writes acquisition metadata into the primary FITS header of raw camera frames
using standard FITS keywords: sensor characteristics, filter, optics, exposure
time, gain, offset, sensor temperature, observation dates…

Pure binary rewrite (no astropy): the 80-byte ASCII header cards are decoded,
updated in place or appended before ``END``, re-padded to a 2880-byte multiple,
then the original data block is re-attached. Malformed/truncated input is
returned unchanged so a capture is never corrupted by the enrichment step.
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from typing import Any

log = logging.getLogger("indigo.fitsmeta")

# A data card is ``KEYWORD= value`` (keyword left-justified in cols 1-8).
_KEYWORD_RE = re.compile(r"^\s*([A-Za-z0-9_-]{1,8})\s*=\s*(.*)$")

_END_CARD = "END".ljust(80)

# Short human-readable comments attached to the keywords we add/update.
_COMMENTS = {
    "OBJECT": "Nom de la cible",
    "IMAGETYP": "Type de frame (Light/Dark/Flat/Bias)",
    "FILTER": "Filtre",
    "EXPTIME": "Durée d'exposition (s)",
    "DATE-OBS": "Début de pose (UTC)",
    "DATE-END": "Fin de pose (UTC)",
    "DATE": "Date d'écriture (UTC)",
    "INSTRUME": "Caméra",
    "CCD-TEMP": "Température capteur (°C)",
    "SET-TEMP": "Température de consigne (°C)",
    "PIXSIZE1": "Taille de pixel X (µm)",
    "PIXSIZE2": "Taille de pixel Y (µm)",
    "XBINNING": "Binning X",
    "YBINNING": "Binning Y",
    "GAIN": "Gain capteur",
    "OFFSET": "Offset capteur",
    "FOCALLEN": "Longueur focale (mm)",
    "TELESCOP": "Télescope",
    "SITELAT": "Latitude de l'observatoire (°)",
    "SITELONG": "Longitude de l'observatoire (°)",
    "SITELEV": "Altitude de l'observatoire (m)",
    "SWCREATE": "Logiciel créateur",
    "NCOMBINE": "Nombre de frames combinées",
    "OBJTHOUR": "Heure sidérale locale (h)",
    "OBJTDEC": "Déclinaison du télescope (°)",
}


def _format_value(value: Any) -> str | None:
    """Render a Python value into a FITS card value section (no comment).

    Returns ``None`` for values that must not be written (None, NaN, Inf,
    empty strings, non-finite floats). Strings are single-quoted FITS-style
    (embedded quotes doubled), numbers are unquoted.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return "T" if value else "F"
    if isinstance(value, int):
        return str(int(value))
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        if value == int(value) and abs(value) < 1e15:
            return str(int(value))
        return f"{value:.6g}"
    s = str(value).strip()
    if not s:
        return None
    # FITS headers are ASCII: drop accents/diacritics before quoting.
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").strip()
    if not s:
        return None
    if len(s) > 60:
        s = s[:60]
    return "'" + s.replace("'", "''") + "'"


def _make_card(keyword: str, value_section: str, comment: str = "") -> str:
    """Build one 80-char FITS card. ``value_section`` already formatted."""
    line = f"{keyword:<8}= {value_section}"
    if comment:
        with_comment = f"{line} / {comment}"
        line = with_comment if len(with_comment) <= 80 else line
    return line.ljust(80)[:80]


def read_header(data: bytes) -> tuple[dict[str, str], list[str], int]:
    """Parse the primary FITS header.

    Args:
        data: Raw FITS bytes.

    Returns:
        ``(values, cards, header_bytes)``:
          - ``values``: keyword (uppercase) → un-quoted value string.
          - ``cards``:  list of 80-char cards in file order (``END`` excluded).
          - ``header_bytes``: byte size of the header (multiple of 2880);
            the image data block starts at this offset. ``-1`` when no ``END``
            card was found (file is not a parseable FITS image).
    """
    cards: list[str] = []
    values: dict[str, str] = {}
    offset = 0
    while offset + 2880 <= len(data):
        block = data[offset : offset + 2880]
        text = block.decode("ascii", errors="replace")
        offset += 2880
        for i in range(0, 2880, 80):
            card = text[i : i + 80]
            kw = card[:8].strip()
            if kw == "END":
                return values, cards, offset
            cards.append(card)
            m = _KEYWORD_RE.match(card)
            if m is None:
                continue  # COMMENT/HISTORY/blank — preserve the raw card
            raw = m.group(2).strip()
            if raw.startswith("'"):
                end = None
                out: list[str] = []
                i = 1
                while i < len(raw):
                    if raw[i] == "'":
                        if i + 1 < len(raw) and raw[i + 1] == "'":
                            out.append("'")
                            i += 2
                            continue
                        end = i
                        break
                    out.append(raw[i])
                    i += 1
                val = "".join(out)
            else:
                if " / " in raw or raw.startswith("/"):
                    raw = raw.split("/", 1)[0]
                val = raw.strip()
            values[m.group(1).upper()] = val
    # END card never found.
    return values, cards, -1


def inject_meta(data: bytes, meta: dict[str, Any], replace: bool = True) -> bytes:
    """Add/update FITS header keywords and return the rewritten file bytes.

    ``meta`` keys become FITS keywords (uppercased, truncated to 8 chars).
    Existing cards are updated **in place** (position preserved); new cards are
    appended before ``END``. Values that are None/NaN/Inf/empty are skipped.

    With ``replace=False`` existing keywords are left untouched (the driver's
    own header wins); absent keywords are still added. Returns the input bytes
    unchanged when the file is not a parseable FITS image.
    """
    if not data:
        return data
    values, cards, header_bytes = read_header(data)
    if header_bytes < 0 or not cards:
        return data

    pending: dict[str, str] = {}
    for key, value in meta.items():
        if value is None:
            continue
        kw = str(key).upper()[:8]
        if not kw:
            continue
        if not replace and kw in values:
            continue
        section = _format_value(value)
        if section is None:
            continue
        pending[kw] = section

    new_cards: list[str] = []
    for card in cards:
        kw = card[:8].strip().upper()
        if kw in pending:
            card = _make_card(kw, pending.pop(kw), _COMMENTS.get(kw, ""))
        new_cards.append(card)
    for kw, section in pending.items():
        new_cards.append(_make_card(kw, section, _COMMENTS.get(kw, "")))
    new_cards.append(_END_CARD)

    total = 0
    lines: list[str] = []
    for card in new_cards:
        line = card[:80].ljust(80)
        lines.append(line)
        total += 80
    pad = (2880 - (total % 2880)) % 2880
    if pad:
        lines.append(" " * pad)
    header = "".join(lines).encode("ascii", errors="replace")
    return header + data[header_bytes:]


def get_value(data: bytes, keyword: str) -> str | None:
    """Return a single header value string (None when absent/unparseable)."""
    try:
        values, _cards, header_bytes = read_header(data)
    except Exception:  # noqa: BLE001
        return None
    if header_bytes < 0:
        return None
    return values.get(keyword.upper())


# ── Frame metadata assembly (Lot C4) ─────────────────────────────

FRAME_TYPE_CARDS = {
    "LIGHT": "Light Frame",
    "DARK": "Dark Frame",
    "FLAT": "Flat Field",
    "BIAS": "Bias Frame",
}


def _iso(dt) -> str:
    from datetime import timezone
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def frame_meta(
    *,
    target: str = "",
    frame_type: str = "LIGHT",
    filter_name: str = "",
    exposure_sec: float = 0.0,
    instrument: str = "",
    ccd_temp: float | None = None,
    set_temp: float | None = None,
    pixel_size_um: float | None = None,
    binning_x: int | None = None,
    binning_y: int | None = None,
    gain: int | None = None,
    offset: int | None = None,
    focal_length_mm: float | None = None,
    telescope: str = "",
    sitelat: float | None = None,
    sitelong: float | None = None,
    sitelev: float | None = None,
    date_obs=None,
    swcreate: str = "Noctua indigo_devices",
) -> dict:
    """Assemble normalized FITS header metadata (standard keywords).

    Values that are None/empty are omitted by ``inject_meta``. ``date_obs`` is
    the exposure start (datetime) when known, otherwise the write time is used
    for both DATE-OBS and DATE-END.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    ftype = (frame_type or "LIGHT").upper()
    meta = {
        "OBJECT": (target or "")[:60] or None,
        "IMAGETYP": FRAME_TYPE_CARDS.get(ftype, "Light Frame"),
        "FILTER": (filter_name or "")[:60] or None,
        "EXPTIME": float(exposure_sec or 0),
        "DATE-OBS": _iso(date_obs) if date_obs else _iso(now),
        "DATE-END": _iso(now),
        "DATE": _iso(now),
        "SWCREATE": swcreate,
    }
    if instrument:
        meta["INSTRUME"] = instrument[:60]
    if ccd_temp is not None:
        meta["CCD-TEMP"] = ccd_temp
    if set_temp is not None:
        meta["SET-TEMP"] = set_temp
    if pixel_size_um is not None:
        meta["PIXSIZE1"] = pixel_size_um
        meta["PIXSIZE2"] = pixel_size_um
    if binning_x is not None:
        meta["XBINNING"] = binning_x
    if binning_y is not None:
        meta["YBINNING"] = binning_y
    if gain is not None:
        meta["GAIN"] = gain
    if offset is not None:
        meta["OFFSET"] = offset
    if focal_length_mm is not None:
        meta["FOCALLEN"] = focal_length_mm
    if telescope:
        meta["TELESCOP"] = telescope[:60]
    if sitelat is not None:
        meta["SITELAT"] = sitelat
    if sitelong is not None:
        meta["SITELONG"] = sitelong
    if sitelev is not None:
        meta["SITELEV"] = sitelev
    return meta