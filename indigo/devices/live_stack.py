"""
live_stack.py — Live stacking engine.

Wraps Seiza's ``LiveStacker`` to accumulate a linear stack frame by frame as
they arrive from the sequence/capture pipeline. Handles:
  - registration (drift-tolerant alignment) against the first accepted frame,
  - rejection of bad frames (too few stars, drift out of bounds) with the
    reason from Seiza's ``FrameDisposition``,
  - optional master calibration (bias/dark/flat) built by ``build_*``,
  - an incremental snapshot (stretched PNG) for live display.

Seiza is already a dependency (v0.12) and exposes the full stacker API
(``LiveStacker``, ``StackOptions``, ``FrameDisposition``, ``build_bias/...``).
"""

from __future__ import annotations

import io
import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("indigo.live_stack")

_seiza = None
_seiza_available: bool | None = None


def _ensure_seiza():
    global _seiza, _seiza_available
    if _seiza_available is not None:
        return _seiza is not None
    try:
        import seiza as _sz
        _seiza = _sz
        _seiza_available = True
        log.info("Seiza loader OK")
    except Exception as e:  # noqa: BLE001
        _seiza_available = False
        log.warning("Seiza not available: %s: %s", type(e).__name__, e)
    return _seiza is not None


def _stack_options(opts: dict | None):
    """Build a Seiza StackOptions from a config dict (constructor kwargs)."""
    kwargs = {}
    if not opts:
        return _seiza.StackOptions()

    norm = opts.get("normalization")
    if norm in ("global", "local"):
        kwargs["normalization"] = norm
    rej = opts.get("rejection")
    if rej in ("delta-sigma", "none"):
        kwargs["rejection"] = rej
    max_drift = opts.get("maximum_drift_fraction")
    if isinstance(max_drift, (int, float)) and 0 < max_drift <= 1.0:
        kwargs["maximum_drift_fraction"] = float(max_drift)
    max_px = opts.get("maximum_drift_pixels")
    if isinstance(max_px, (int, float)) and max_px > 0:
        kwargs["maximum_drift_pixels"] = float(max_px)

    try:
        return _seiza.StackOptions(**kwargs)
    except Exception:  # noqa: BLE001
        # Unknown/unwritable combos fall back to defaults
        try:
            return _seiza.StackOptions()
        except Exception:  # noqa: BLE001
            return None


def _parse_fits_bytes(data: bytes) -> tuple[np.ndarray | None, int, int]:
    """Parse a raw FITS blob into a float32 2D array (bottom-up reverted).

    Reuses the exact same parsing logic as ``indigo.devices.solver``: raw bytes
    → numpy 2D float32. Handles BITPIX 8/16/-16/32/-32/64 (native endian big).
    """
    try:
        import re

        header_str = ""
        offset = 0
        end_found = False
        while offset + 2880 <= len(data):
            block = data[offset:offset + 2880]
            header_str += block.decode("ascii", errors="replace")
            offset += 2880
            last_block = header_str[-2880:]
            for i in range(0, len(last_block), 80):
                if last_block[i:i + 3].strip() == "END":
                    end_found = True
                    break
            if end_found:
                break
        if not end_found:
            return None, 0, 0

        def get(key):
            for i in range(0, len(header_str), 80):
                card = header_str[i:i + 80]
                m = re.match(rf"^{key}\s*=\s*(.+?)(?:\s*/\s*.*)?$", card.strip())
                if m:
                    val = m.group(1).strip().strip("'\"")
                    if "'" in val:
                        val = val.split("'")[0]
                    else:
                        val = val.split()[0] if val.split() else val
                    return val
            return None

        naxis = int(get("NAXIS") or "0")
        w = int(get("NAXIS1") or "0")
        h = int(get("NAXIS2") or "0")
        bitpix = int(get("BITPIX") or "32")
        if naxis < 2 or w == 0 or h == 0:
            return None, 0, 0

        data_start = offset
        remaining = len(data) - data_start

        if bitpix == 32:
            count = min(w * h, remaining // 4)
            arr = np.frombuffer(data[data_start:data_start + count * 4], dtype=">i4", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == -32:
            count = min(w * h, remaining // 4)
            arr = np.frombuffer(data[data_start:data_start + count * 4], dtype=">f4", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 16:
            count = min(w * h, remaining // 2)
            arr = np.frombuffer(data[data_start:data_start + count * 2], dtype=">i2", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == -16:
            count = min(w * h, remaining // 2)
            arr = np.frombuffer(data[data_start:data_start + count * 2], dtype=">u2", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 64:
            count = min(w * h, remaining // 8)
            arr = np.frombuffer(data[data_start:data_start + count * 8], dtype=">f8", count=count)
            pixels = arr.astype(np.float64)
        elif bitpix == 8:
            count = min(w * h, remaining)
            pixels = np.frombuffer(data[data_start:data_start + count], dtype=np.uint8, count=count).astype(np.float64)
        else:
            return None, 0, 0

        if pixels.size >= w * h:
            img = pixels[:w * h].reshape(h, w)[::-1].copy()
        else:
            return None, 0, 0

        return img.astype(np.float32), w, h
    except Exception as e:  # noqa: BLE001
        log.warning("FITS parse error: %s", e)
        return None, 0, 0


class LiveStackEngine:
    """Incremental live stacker wrapping Seiza's ``LiveStacker``."""

    def __init__(self, options: dict | None = None):
        if not _ensure_seiza():
            raise RuntimeError("Seiza not installed — live stacking unavailable")
        self._lock = threading.Lock()
        self._opts = dict(options or {})
        self._stacker: Any = None
        self._ref_set = False
        self._accepted = 0
        self._rejected = 0
        self._disposition: dict | None = None
        self._window: int | None = None  # last snapshot png (PNG bytes of the stretched stack)
        self._last_error: str | None = None
        # Number of LIGHT frames to stack before auto-completing.
        # 0 (default) = unlimited (continuous until stopped).
        self._max_frames: int = int(dict(options or {}).get("max_frames", 0) or 0)
        self._complete = False

        # Master calibration images (float32 arrays), built lazily
        self._calibration: dict[str, np.ndarray | None] = {"bias": None, "dark": None, "flat": None}

    # ── Control ────────────────────────────────────────────────

    def configure(self, options: dict) -> dict:
        with self._lock:
            self._opts.update({k: v for k, v in (options or {}).items() if k in (
                "normalization", "rejection", "maximum_drift_fraction", "maximum_drift_pixels")})
            if options and "max_frames" in options:
                mf = int(options["max_frames"] or 0)
                self._max_frames = max(0, mf)
                self._opts["max_frames"] = self._max_frames
                self._complete = False
        return self.status()

    def reset(self) -> dict:
        with self._lock:
            self._stacker = None
            self._ref_set = False
            self._accepted = 0
            self._rejected = 0
            self._disposition = None
            self._window = None
            self._last_error = None
            self._complete = False
        log.info("Live stack reset")
        return self.status()

    def status(self) -> dict:
        with self._lock:
            return {
                "ok": True,
                "available": _seiza is not None,
                "running": self._ref_set,
                "accepted": self._accepted,
                "rejected": self._rejected,
                "last": self._disposition,
                "error": self._last_error,
                "has_window": self._window is not None,
                "max_frames": self._max_frames,
                "complete": self._complete,
            }

    def _options(self):
        return _stack_options(self._opts)

    # ── Calibration masters ─────────────────────────────────────

    def build_masters(self, *, bias_dir=None, dark_dir=None, flat_dir=None,
                      exposure_seconds: float | None = None) -> dict:
        """Build (or reload) master calibration frames from directories of FITS.

        Additionally, a single master FITS can be passed as a string path for
        any of the three.
        """
        with self._lock:
            _build = self._build_master_from_fits
            self._calibration["bias"] = _build(bias_dir) if bias_dir else self._calibration["bias"]
            self._calibration["dark"] = _build(dark_dir) if dark_dir else self._calibration["dark"]
            self._calibration["flat"] = _build(flat_dir) if flat_dir else self._calibration["flat"]
        result = {k: (v is not None) for k, v in self._calibration.items()}
        log.info("calibration masters: %s", result)
        return {"ok": True, "calibration": result}

    def _build_master_from_fits(self, path_or_dir) -> np.ndarray | None:
        """Load a single FITS (master) or stack a directory into a master."""
        p = Path(path_or_dir)
        if p.is_file():
            data = p.read_bytes()
            img, w, h = _parse_fits_bytes(data)
            return img
        if p.is_dir():
            files = sorted(p.glob("*.fits")) + sorted(p.glob("*.fit")) + sorted(p.glob("*.fts"))
            if not files:
                return None
            imgs = []
            for f in files:
                img, w, h = _parse_fits_bytes(f.read_bytes())
                if img is not None:
                    imgs.append(img)
            if not imgs:
                return None
            stack = np.median(np.stack(imgs), axis=0)
            return stack.astype(np.float32)
        return None

    # ── Pushing frames ──────────────────────────────────────────

    def push_fits(self, data: bytes) -> dict:
        """Push a raw FITS frame into the stack. Returns disposition dict."""
        with self._lock:
            img, w, h = _parse_fits_bytes(data)
            if img is None:
                self._last_error = "frame parse failed"
                return {"ok": False, "error": "frame parse failed"}
            return self._push_array(img)

    def push_array(self, img: np.ndarray) -> dict:
        with self._lock:
            return self._push_array(img)

    def _push_array(self, img: np.ndarray) -> dict:
        # NOTE: callers (push_fits/push_array) already hold self._lock.
        if self._max_frames > 0 and self._complete:
            return {"ok": False, "error": "stack complete", "complete": True}
        # If we have masters, calibrate the frame first (bias/dark subtraction, flat division).
        img = self._apply_calibration(img)

        if not self._ref_set:
            try:
                self._stacker = _seiza.LiveStacker.from_array(img, options=_stack_options(self._opts))
            except Exception as e:  # noqa: BLE001
                self._last_error = f"stack init failed: {e}"
                return {"ok": False, "error": self._last_error}
            self._ref_set = True
            self._accepted = 1
            self._disposition = {"accepted": True, "frame": 1, "reason": "reference"}
            self._maybe_complete()
            return {"ok": True, "accepted": True, **self._disposition}

        try:
            disp = self._stacker.push(img)
        except Exception as e:  # noqa: BLE001
            self._last_error = f"stack push failed: {e}"
            return {"ok": False, "error": self._last_error}

        d = self._disposition_from(disp)
        if disp.accepted:
            self._accepted += 1
        else:
            self._rejected += 1
        self._disposition = d
        self._maybe_complete()
        return {"ok": True, **d}

    def _maybe_complete(self) -> None:
        if self._max_frames > 0 and self._accepted >= self._max_frames:
            self._complete = True

    def _disposition_from(self, disp) -> dict:
        fields = ("accepted", "matched_stars", "rms_pixels", "translation_x", "translation_y",
                  "rotation_degrees", "scale", "overlap_fraction", "normalization_mean_gain",
                  "normalization_mean_offset", "integrated_fraction", "reason")
        out = {}
        for f in fields:
            try:
                v = getattr(disp, f)
                if v is not None:
                    almost = None
                    if isinstance(v, float):
                        almost = round(v, 4)
                    elif isinstance(v, (int, bool, str)):
                        almost = v
                    out[f] = almost
            except Exception:  # noqa: BLE001
                pass
        return out

    def _apply_calibration(self, img: np.ndarray) -> np.ndarray:
        img = img.astype(np.float32)
        bias = self._calibration.get("bias")
        dark = self._calibration.get("dark")
        flat = self._calibration.get("flat")

        if bias is not None:
            if bias.shape == img.shape:
                img = img - bias
        if dark is not None:
            if dark.shape == img.shape:
                img = img - dark
        if flat is not None:
            if flat.shape == img.shape:
                # Flat field: divide by normalized flat (avoid div-by-zero)
                f = flat.astype(np.float32)
                f = np.maximum(f, np.percentile(f, 1))
                img = img / f
        # Bias was already part of dark; keep simple
        return img

    # ── Snapshot (live view) ────────────────────────────────────

    def snapshot_png(self, max_size: int = 1024) -> bytes | None:
        """Return the stretched, downscaled stack as PNG bytes (live preview).

        Returns ``None`` if no frame has been appended yet, or on failure.
        """
        with self._lock:
            if self._stacker is None:
                return None
            try:
                snap = self._stacker.snapshot()
                image = getattr(snap, "image", None)
                if image is None:
                    return None
                png = _image_to_png(image, max_size)
                self._window = png
                return png
            except Exception as e:  # noqa: BLE001
                log.warning("snapshot failed: %s", e)
                return None

    def save_master(self, output_dir, name: str = "master", fmt: str = "fits") -> dict:
        """Save the current stack as a FITS master (or stretched PNG)."""
        with self._lock:
            if self._stacker is None:
                return {"ok": False, "error": "no stack — no frames appended"}
            try:
                out = Path(output_dir)
                out.mkdir(parents=True, exist_ok=True)
                if fmt == "png":
                    snap = self._stacker.snapshot()
                    image = getattr(snap, "image", None)
                    png = _image_to_png(image) if image is not None else None
                    if png is None:
                        return {"ok": False, "error": "no image available"}
                    f = out / f"{name}_{datetime_stamp()}.png"
                    f.write_bytes(png)
                    return {"ok": True, "path": str(f)}
                # FITS master
                snap = self._stacker.snapshot()
                image = getattr(snap, "image", None)
                if image is None:
                    return {"ok": False, "error": "no image available"}
                f = out / f"{name}_{datetime_stamp()}.fits"
                _arr_to_fits(image, f)
                return {"ok": True, "path": str(f), "format": fmt}
            except Exception as e:  # noqa: BLE001
                log.error("master save failed: %s", e)
                return {"ok": False, "error": str(e)}


def datetime_stamp() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _image_to_png(image: np.ndarray, max_size: int = 1024) -> bytes | None:
    """Stretch + downsample a float32 image to a small PNG."""
    try:
        from PIL import Image
        arr = image.astype(np.float32)
        # Downsample preserving aspect
        h, w = arr.shape
        scale = min(1.0, max_size / max(w, h))
        if scale < 1.0:
            nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
            imgc = np.array(Image.fromarray(arr).resize((nw, nh), Image.BILINEAR))
            arr = imgc.astype(np.float32)
        # Stretch with Seiza
        if _seiza is not None:
            try:
                arr = _seiza.stretch(arr)
            except Exception:  # noqa: BLE001
                pass
        # Normalize 0..255
        lo, hi = np.nanpercentile(arr, 1), np.nanpercentile(arr, 99)
        if hi > lo:
            arr = np.clip((arr - lo) / (hi - lo), 0, 1)
        a8 = (arr * 255).astype(np.uint8)
        img = Image.fromarray(a8, mode="L")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:  # noqa: BLE001
        log.warning("PNG encode failed: %s", e)
        return None


def _arr_to_fits(image: np.ndarray, path) -> None:
    """Really minimal FITS writer (header + big-endian int16)."""
    h, w = image.shape
    lines = ["SIMPLE  =                    T", "BITPIX  =                  -32",
             "NAXIS   =                    2", f"NAXIS1  =                {w:11d}",
             f"NAXIS2  =                {h:11d}", "BZERO   =                 0e+00",
             "END"]
    header = "".join(card.ljust(80) for card in lines)
    header += " " * ((2880 - len(header) % 2880) % 2880)
    data = image.astype(">f4").tobytes()
    pad = (2880 - len(data) % 2880) % 2880
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data)
        f.write(b"\x00" * pad)