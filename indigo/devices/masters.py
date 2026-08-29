"""
masters.py — Master calibration library (Lot C1).

Catalogs master calibration frames (bias/dark/flat) stored under
``<root>/masters/<type>/`` and resolves the best match for an acquisition
context (filter + binning + temperature + exposure), the way N.I.N.A.'s
calibration library does per-filter/binning/temperature.

  - ``build()``: median-combine a set of raw FITS frames (with normalized
    headers, Lot C4) into a master, then register it in the library.
  - ``scan()``: index existing masters by reading their FITS headers.
  - ``resolve()``: pick the best master for a requested context.
  - ``resolve_all()``: convenience — bias + dark + flat at once (for stacking).

The data block is untouched by header writes (``fitsmeta``); frame combination
uses the same bit-depth-tolerant parser as the rest of the app.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Iterable

import numpy as np

from . import fitsmeta
from .focus_metrics import parse_fits

log = logging.getLogger("indigo.masters")

MASTER_TYPES = ("bias", "dark", "flat")

# Maximum |ΔT| (°C) between a dark master and the light frame it calibrates.
DARK_TEMP_TOLERANCE = 5.0


def _norm_type(frame_type: str) -> str:
    """Normalize any IMAGETYP / folder name to a library type."""
    s = (frame_type or "").lower().replace("_", " ").strip()
    for t in MASTER_TYPES:
        if t in s:
            return t
    return "flat" if "flat" in s else "light"


def _num(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value):
    v = _num(value)
    return int(v) if v is not None else None


class MasterLibrary:
    """Catalog of master calibration frames under ``<root>/masters/``."""

    def __init__(self, root_dir: str | Path = ""):
        self.root = Path(root_dir or "")
        self.index: list[dict] = []
        self.scanned_at: float = 0.0

    @property
    def masters_dir(self) -> Path:
        return self.root / "masters"

    def scan(self, force: bool = False) -> list[dict]:
        """Rebuild the catalog from master files on disk (green path)."""
        if self.index and not force:
            return self.index
        records = []
        for t in MASTER_TYPES:
            tdir = self.masters_dir / t
            if not tdir.is_dir():
                continue
            for path in sorted(tdir.iterdir()):
                if path.suffix.lower() not in (".fits", ".fit", ".fts"):
                    continue
                rec = self._read_master(path)
                if rec:
                    records.append(rec)
        self.index = records
        self.scanned_at = datetime.now().timestamp()
        return records

    def _read_master(self, path: Path) -> dict | None:
        try:
            data = path.read_bytes()
        except OSError:
            return None
        values, _cards, header_bytes = fitsmeta.read_header(data)
        if header_bytes < 0:
            return None
        img_type = values.get("IMAGETYP", "")
        bx = _int(values.get("XBINNING"))
        by = _int(values.get("YBINNING"))
        return {
            "path": str(path),
            "name": path.stem,
            "type": _norm_type(img_type or path.parent.name),
            "frame_type": img_type or path.parent.name,
            "filter": (values.get("FILTER") or "").strip(),
            "binning_x": bx,
            "binning_y": by,
            "binning": f"{bx}x{by}" if bx and by else "",
            "temperature": _num(values.get("CCD-TEMP")),
            "exposure": _num(values.get("EXPTIME")),
            "width": _int(values.get("NAXIS1")) or 0,
            "height": _int(values.get("NAXIS2")) or 0,
            "framecount": _int(values.get("NCOMBINE")),
            "date_obs": values.get("DATE-OBS") or values.get("DATE") or "",
            "instrument": values.get("INSTRUME") or "",
            "size": path.stat().st_size if path.exists() else 0,
        }

    # ── Building masters ─────────────────────────────────────────

    def build(
        self,
        files: Iterable[str | Path] | str | Path,
        frame_type: str = "flat",
        name: str = "",
        *,
        filter_name: str | None = None,
        binning: str | None = None,
        temperature: float | None = None,
        exposure: float | None = None,
    ) -> dict:
        """Median-combine raw FITS frames into a master in the library.

        ``files`` may be a directory (all its FITS), a single master-style FITS
        file, or an iterable of paths. Header metadata (Lot C4) from the first
        usable frame seeds the master header; explicit overrides win. Returns
        ``{"ok": True, "path": …, "record": …}`` or ``{"ok": False, ...}``.
        """
        t = _norm_type(frame_type)
        paths = self._expand_files(files)
        if not paths:
            return {"ok": False, "error": "no FITS files to combine"}

        arrays = []
        header: dict[str, str] = {}
        for p in paths:
            img, w, h = parse_fits(p.read_bytes())
            if img is None:
                continue
            arrays.append(np.asarray(img, dtype=np.float32))
            if not header:
                values, _c, _hb = fitsmeta.read_header(p.read_bytes())
                header = values

        if not arrays:
            return {"ok": False, "error": "no parseable frames among sources"}

        stack = np.median(np.stack(arrays), axis=0).astype(np.float32)
        w = stack.shape[1] if stack.ndim == 2 else 0
        h = stack.shape[0] if stack.ndim == 2 else 0
        if not w or not h:
            return {"ok": False, "error": "frames have no 2D image data"}

        filter_name = filter_name if filter_name is not None else header.get("FILTER", "")
        binning = binning or ""
        if not binning and header.get("XBINNING") and header.get("YBINNING"):
            bx, by = _int(header.get("XBINNING")), _int(header.get("YBINNING"))
            binning = f"{bx}x{by}" if bx and by else ""
        temperature = (temperature if temperature is not None
                       else _num(header.get("CCD-TEMP")))
        exposure = (exposure if exposure is not None
                    else _num(header.get("EXPTIME")))

        meta = {
            "IMAGETYP": fitsmeta.FRAME_TYPE_CARDS.get(t.upper(), f"{t.capitalize()} Frame"),
            "FILTER": filter_name or None,
            "EXPTIME": exposure,
            "CCD-TEMP": temperature,
            "DATE-OBS": header.get("DATE-OBS"),
            "DATE": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "NCOMBINE": len(arrays),
        }
        # Copy sensor/optics provenance when present.
        for src_key, dst_key in (("XBINNING", "XBINNING"), ("YBINNING", "YBINNING"),
                                 ("GAIN", "GAIN"), ("OFFSET", "OFFSET"),
                                 ("PIXSIZE1", "PIXSIZE1"), ("PIXSIZE2", "PIXSIZE2"),
                                 ("FOCALLEN", "FOCALLEN"), ("INSTRUME", "INSTRUME"),
                                 ("TELESCOP", "TELESCOP"), ("SITELAT", "SITELAT"),
                                 ("SITELONG", "SITELONG"), ("SITELEV", "SITELEV"),
                                 ("SWCREATE", "SWCREATE")):
            if header.get(src_key):
                meta[dst_key] = header[src_key]

        fname = name or self._default_name(t, filter_name or "", binning)
        if not fname.lower().endswith((".fits", ".fit", ".fts")):
            fname += ".fits"
        out = self.masters_dir / t / fname
        out.parent.mkdir(parents=True, exist_ok=True)
        if not self._write_master(stack, out, meta):
            return {"ok": False, "error": f"write failed: {out}"}

        rec = self._read_master(out) or {}
        self.scan(force=True)
        log.info("master built: %s (%d frames)", out, len(arrays))
        return {"ok": True, "path": str(out), "record": rec,
                "frames": len(arrays), "type": t}

    def _expand_files(self, files) -> list[Path]:
        if isinstance(files, (str, Path)):
            p = Path(files)
            if p.is_dir() and not p.suffix.lower() in (".fits", ".fit", ".fts"):
                return self._fits_in_dir(p)
            return [p] if p.is_file() else []
        out = []
        for f in files:
            p = Path(f)
            if p.is_dir():
                out.extend(self._fits_in_dir(p))
            elif p.suffix.lower() in (".fits", ".fit", ".fts") and p.is_file():
                out.append(p)
        return [p for p in out if p.exists()]

    @staticmethod
    def _fits_in_dir(d: Path) -> list[Path]:
        out = []
        for ext in ("*.fits", "*.fit", "*.fts"):
            out.extend(sorted(d.glob(ext)))
        return out

    @staticmethod
    def _default_name(t: str, filter_name: str, binning: str) -> str:
        parts = [t, filter_name if filter_name else None, binning if binning else None]
        return "_".join(x for x in parts if x) + ".fits"

    @staticmethod
    def _write_master(image: np.ndarray, path: Path, meta: dict) -> bool:
        """Write a float32 FITS master with its normalized header."""
        try:
            h, w = image.shape
            lines = ["SIMPLE  =                    T",
                     "BITPIX  =                  -32",
                     "NAXIS   =                    2",
                     f"NAXIS1  =                {w:11d}",
                     f"NAXIS2  =                {h:11d}",
                     "BZERO   =                 0e+00",
                     "END"]
            header = "".join(card.ljust(80) for card in lines)
            header += " " * ((2880 - len(header) % 2880) % 2880)
            base = header.encode("ascii") + image.astype(">f4").tobytes()
            base += b"\x00" * ((2880 - len(base) % 2880) % 2880)
            path.write_bytes(fitsmeta.inject_meta(base, meta))
            return True
        except Exception as e:  # noqa: BLE001
            log.exception("master write failed: %s", e)
            return False

    # ── Resolution ──────────────────────────────────────────────

    def resolve(
        self,
        frame_type: str = "light",
        filter_name: str = "",
        binning: str = "",
        temperature: float | None = None,
        exposure: float | None = None,
    ) -> dict | None:
        """Best master for the requested acquisition context, or None.

        - Bias/dark: binning must match; dark adds temperature (§ tolerance)
          and exposure (prefer ≥ requested) ranking.
        - Flat: filter and binning must match (when given).
        """
        self.scan()
        t = _norm_type(frame_type)
        binning = (binning or "").strip().lower()
        filter_name = (filter_name or "").strip()
        cands = [r for r in self.index if r["type"] == t]

        if binning:
            cands = [r for r in cands if not r["binning"] or r["binning"] == binning]
        if t == "flat" and filter_name:
            cands = [r for r in cands if r["filter"] == filter_name]
        if not cands:
            return None

        if t in ("dark", "bias"):
            if temperature is not None and t == "dark":
                within = [r for r in cands if r["temperature"] is not None
                          and abs(r["temperature"] - temperature) <= DARK_TEMP_TOLERANCE]
                if not within:
                    # A dark at the wrong temperature would bias the
                    # calibration — never fall back to a far master.
                    return None
                cands = sorted(within, key=lambda r: abs(r["temperature"] - temperature))
            if exposure is not None and t == "dark":
                known = [r for r in cands if r["exposure"] is not None]
                if known:
                    ge = [r for r in known if r["exposure"] >= exposure]
                    cands = [sorted(ge, key=lambda r: r["exposure"])[0]] if ge \
                        else [sorted(known, key=lambda r: abs(r["exposure"] - exposure))[0]]
        return cands[0]

    def resolve_all(
        self,
        filter_name: str = "",
        binning: str = "",
        temperature: float | None = None,
        exposure: float | None = None,
    ) -> dict:
        """Resolve bias, dark and flat (if any) for a light-frame context."""
        return {
            "bias": self._path("bias", binning=binning),
            "dark": self._path("dark", binning=binning, temperature=temperature,
                               exposure=exposure),
            "flat": self._path("flat", filter_name=filter_name, binning=binning),
        }

    def _path(self, frame_type, **kw) -> str | None:
        rec = self.resolve(frame_type, **kw)
        return rec["path"] if rec else None

    # ── Deletion ─────────────────────────────────────────────────

    def delete(self, name: str) -> dict:
        """Delete a master by file name (basename or full path)."""
        name = Path(name).name
        name = (name or "").rstrip(".fits")
        if not name:
            return {"ok": False, "error": "name requis"}
        for rec in self.scan():
            if rec["name"] == name:
                try:
                    os.remove(rec["path"])
                except OSError as e:
                    return {"ok": False, "error": str(e)}
                self.scan(force=True)
                return {"ok": True, "deleted": rec["path"]}
        return {"ok": False, "error": "master not found"}

    def status(self) -> dict:
        return {
            "root": str(self.root) or None,
            "masters_dir": str(self.masters_dir) if self.root else None,
            "masters": self.scan(),
            "count": len(self.index),
        }