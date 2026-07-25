"""
solver.py — Plate solving with Seiza.

Wraps the Seiza Python library for star detection and plate solving.
Supports both hinted (fast, uses mount position) and blind (slower, no hint) solving.

Seiza: https://seiza.fyi — Rust-based, high-performance plate solver.
"""

from __future__ import annotations

import io
import logging
import struct
import threading
import time
from typing import Any

import numpy as np

log = logging.getLogger("indigo.solver")

# Lazy imports — seiza may not be installed
_seiza = None
_seiza_available = None


def _ensure_seiza():
    global _seiza, _seiza_available
    if _seiza_available is not None:
        return _seiza is not None
    try:
        import seiza as _sz
        _seiza = _sz
        _seiza_available = True
        log.info("Seiza library loaded successfully")
    except Exception as e:
        _seiza_available = False
        log.warning("Seiza not available — %s: %s", type(e).__name__, e)
    return _seiza is not None


class Solver:
    """Plate solver using Seiza."""

    def __init__(self):
        self._catalog = None
        self._index = None
        self._catalogs_loaded = False
        self._catalogs_dir = None
        self._lock = threading.Lock()
        self._solving = False
        self._last_result: dict | None = None

    @property
    def is_ready(self) -> bool:
        return _ensure_seiza() and self._catalog is not None

    @property
    def has_blind_index(self) -> bool:
        return self._index is not None

    @property
    def is_solving(self) -> bool:
        return self._solving

    def load_catalogs(self, catalog_dir: str | None = None) -> dict:
        """Load star catalogs. Call once at startup or when catalog dir changes.

        Returns dict with status info.
        """
        if not _ensure_seiza():
            return {"ok": False, "error": "Seiza not installed"}

        with self._lock:
            try:
                paths = _seiza.fetch_catalogs(cache_dir=catalog_dir)
                self._catalog = _seiza.StarCatalog.open(paths["stars-lite-tycho2.bin"])
                log.info("Star catalog loaded: %s", paths.get("stars-lite-tycho2.bin", "?"))

                # Try to load blind index
                try:
                    blind_path = paths.get("blind-gaia16.idx")
                    if blind_path:
                        self._index = _seiza.BlindIndex.open(blind_path)
                        log.info("Blind index loaded: %s", blind_path)
                except Exception as e:
                    log.debug("Blind index not available: %s", e)
                    self._index = None

                self._catalogs_loaded = True
                self._catalogs_dir = catalog_dir
                return {
                    "ok": True,
                    "catalog": str(paths.get("stars-lite-tycho2.bin", "")),
                    "blind_index": str(paths.get("blind-gaia16.idx", "")) if self._index else None,
                }
            except Exception as e:
                log.error("Failed to load catalogs: %s", e)
                return {"ok": False, "error": str(e)}

    def status(self) -> dict:
        """Return solver status."""
        return {
            "available": _ensure_seiza(),
            "catalogs_loaded": self._catalogs_loaded,
            "has_blind_index": self._index is not None,
            "solving": self._solving,
            "last_result": self._last_result,
        }

    def _extract_wcs(self, data: bytes) -> dict | None:
        """Extract WCS keywords from FITS header bytes."""
        try:
            header_str = ""
            offset = 0
            end_found = False
            while offset + 2880 <= len(data):
                block = data[offset:offset + 2880]
                header_str += block.decode('ascii', errors='replace')
                offset += 2880
                last_block = header_str[-2880:]
                for i in range(0, len(last_block), 80):
                    if last_block[i:i + 3].strip() == 'END':
                        end_found = True
                        break
                if end_found:
                    break
            if not end_found:
                return None
            def get(key):
                for i in range(0, len(header_str), 80):
                    card = header_str[i:i + 80]
                    if card[:8].strip() == key:
                        eq = card.find('=')
                        if eq < 0:
                            continue
                        val = card[eq + 1:].split('/')[0].strip().strip("'\"")
                        try:
                            return float(val)
                        except ValueError:
                            return val
                return None
            result = {}
            for key in ('CRVAL1', 'CRVAL2', 'CRPIX1', 'CRPIX2', 'CDELT1', 'CDELT2',
                         'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2', 'NAXIS1', 'NAXIS2'):
                v = get(key)
                if v is not None:
                    result[key.lower()] = v
            return result if result else None
        except Exception:
            return None

    def solve_image(
        self,
        image_data: bytes,
        *,
        fmt: str = "fits",
        ra_hint: float | None = None,
        dec_hint: float | None = None,
        scale_hint: float | None = None,
        min_scale: float = 0.5,
        max_scale: float = 15.0,
        sigma: float = 2.0,
    ) -> dict:
        """Solve a plate from image bytes.

        Args:
            image_data: Raw image bytes (FITS or standard image format)
            fmt: Image format ("fits", "jpeg", "png")
            ra_hint: RA center hint in degrees (J2000)
            dec_hint: DEC center hint in degrees (J2000)
            scale_hint: Pixel scale hint in arcsec/pixel
            min_scale: Minimum scale for blind solve (arcsec/pixel)
            max_scale: Maximum scale for blind solve (arcsec/pixel)

        Returns:
            dict with solution or error
        """
        if not self.is_ready:
            return {"ok": False, "error": "Solver not ready — catalogs not loaded"}

        self._solving = True
        start_time = time.monotonic()

        try:
            # Parse image to numpy array
            img, width, height = self._parse_image(image_data, fmt)
            if img is None:
                return {"ok": False, "error": "Failed to parse image"}

            log.debug("Image parsed: %dx%d, range [%.1f, %.1f]",
                      width, height, float(np.nanmin(img)), float(np.nanmax(img)))

            # Detect stars
            stars = _seiza.detect(img, sigma=sigma)
            log.debug("Stars detected: %d", len(stars))

            if len(stars) < 5:
                return {
                    "ok": False,
                    "error": f"Too few stars detected ({len(stars)}). Image may be too dark or blurry.",
                    "stars_detected": len(stars),
                }

            # Choose solve mode
            use_hint = (ra_hint is not None and dec_hint is not None and scale_hint is not None)

            if use_hint:
                log.debug("Hinted solve: RA=%.2f DEC=%.2f scale=%.2f arcsec/px",
                          ra_hint, dec_hint, scale_hint)
                solution = _seiza.solve(
                    stars, self._catalog,
                    width, height,
                    ra=ra_hint,
                    dec=dec_hint,
                    scale_arcsec_px=scale_hint,
                )
            else:
                if self._index is None:
                    return {
                        "ok": False,
                        "error": "No blind index available. Use hinted mode (provide RA/DEC/scale) or download blind index.",
                        "stars_detected": len(stars),
                    }
                log.debug("Blind solve: scale range [%.1f, %.1f] arcsec/px", min_scale, max_scale)
                solution = _seiza.solve_blind(
                    stars, self._catalog, self._index,
                    width, height,
                    min_scale_arcsec_px=min_scale,
                    max_scale_arcsec_px=max_scale,
                )

            elapsed = time.monotonic() - start_time

            result = {
                "ok": True,
                "ra": float(solution.ra),
                "dec": float(solution.dec),
                "rotation": float(solution.rotation_deg),
                "flipped": bool(solution.flipped),
                "scale": float(solution.scale_arcsec_px),
                "matches": int(solution.matched_stars),
                "rms": float(solution.rms_arcsec),
                "width": width,
                "height": height,
                "stars_detected": len(stars),
                "mode": "hinted" if use_hint else "blind",
                "elapsed_ms": round(elapsed * 1000, 1),
            }

            self._last_result = result
            log.info("Solved in %.1fms: RA=%.4f DEC=%.4f scale=%.2f arcsec/px, %d matches, RMS=%.2f\"",
                     elapsed * 1000, result["ra"], result["dec"], result["scale"],
                     result["matches"], result["rms"])

            return result

        except Exception as e:
            elapsed = time.monotonic() - start_time
            log.error("Solve failed after %.1fms: %s", elapsed * 1000, e)
            return {"ok": False, "error": str(e), "elapsed_ms": round(elapsed * 1000, 1)}
        finally:
            self._solving = False

    def _parse_image(self, data: bytes, fmt: str) -> tuple[np.ndarray | None, int, int]:
        """Parse image bytes to a 2D numpy float32 array.

        Returns (array, width, height) or (None, 0, 0) on error.
        """
        fmt_lower = fmt.lower()

        if fmt_lower in ("fits", "image/fits", "application/fits"):
            return self._parse_fits(data)
        elif fmt_lower in ("jpeg", "jpg", "image/jpeg"):
            return self._parse_pillow(data)
        elif fmt_lower in ("png", "image/png"):
            return self._parse_pillow(data)
        else:
            # Try FITS magic byte, then fallback to Pillow
            if len(data) > 3 and data[0:3] == b'SIM':
                return self._parse_fits(data)
            return self._parse_pillow(data)

    def _parse_fits(self, data: bytes) -> tuple[np.ndarray | None, int, int]:
        """Parse FITS bytes to 2D numpy array."""
        try:
            import re

            # Read header blocks (each 2880 bytes = 36 cards × 80 chars)
            header_str = ""
            offset = 0
            end_found = False

            while offset + 2880 <= len(data):
                block = data[offset:offset + 2880]
                header_str += block.decode('ascii', errors='replace')
                offset += 2880

                # Check last 36 cards (2880 chars) for END keyword
                # END must be in the first 3 chars of an 80-char card
                last_block = header_str[-2880:]
                for i in range(0, len(last_block), 80):
                    card = last_block[i:i+80]
                    if card[:3].strip() == 'END':
                        end_found = True
                        break
                if end_found:
                    break

            if not end_found:
                log.warning("FITS header: END keyword not found")
                return None, 0, 0

            # Parse header cards (each 80 chars)
            def get(key):
                # Search in 80-char cards
                for i in range(0, len(header_str), 80):
                    card = header_str[i:i+80]
                    # FITS card format: KEYWORD = value / comment
                    m = re.match(rf'^{key}\s*=\s*(.+?)(?:\s*/\s*.*)?$', card.strip())
                    if m:
                        val = m.group(1).strip().strip("'\"")
                        # For string values, take everything before the closing quote
                        if "'" in val:
                            val = val.split("'")[0]
                        else:
                            # For numeric values, take first token
                            val = val.split()[0] if val.split() else val
                        return val
                return None

            naxis = int(get('NAXIS') or '0')
            w = int(get('NAXIS1') or '0')
            h = int(get('NAXIS2') or '0')
            bitpix = int(get('BITPIX') or '32')

            if naxis < 2 or w == 0 or h == 0:
                log.warning("Invalid FITS header: NAXIS=%d %dx%d", naxis, w, h)
                return None, 0, 0

            data_start = offset
            remaining = len(data) - data_start

            if bitpix == 32:
                count = min(w * h, remaining // 4)
                arr = np.frombuffer(data[data_start:data_start + count * 4], dtype='>i4', count=count)
                pixels = arr.astype(np.float64)
            elif bitpix == -32:
                count = min(w * h, remaining // 4)
                arr = np.frombuffer(data[data_start:data_start + count * 4], dtype='>f4', count=count)
                pixels = arr.astype(np.float64)
            elif bitpix == 16:
                count = min(w * h, remaining // 2)
                arr = np.frombuffer(data[data_start:data_start + count * 2], dtype='>i2', count=count)
                pixels = arr.astype(np.float64)
            elif bitpix == -16:
                count = min(w * h, remaining // 2)
                arr = np.frombuffer(data[data_start:data_start + count * 2], dtype='>u2', count=count)
                pixels = arr.astype(np.float64)
            elif bitpix == 64:
                count = min(w * h, remaining // 8)
                arr = np.frombuffer(data[data_start:data_start + count * 8], dtype='>f8', count=count)
                pixels = arr.astype(np.float64)
            elif bitpix == 8:
                count = min(w * h, remaining)
                pixels = np.frombuffer(data[data_start:data_start + count], dtype=np.uint8, count=count).astype(np.float64)
            else:
                log.warning("Unsupported BITPIX: %d", bitpix)
                return None, 0, 0

            # Handle FITS convention: reverse rows (bottom-up to top-down)
            if pixels.size >= w * h:
                img = pixels[:w * h].reshape(h, w)[::-1].copy()
            else:
                log.warning("FITS data too small: got %d values, expected %d", pixels.size, w * h)
                return None, 0, 0

            return img.astype(np.float32), w, h

        except Exception as e:
            log.error("FITS parse error: %s", e)
            return None, 0, 0

    def _parse_pillow(self, data: bytes) -> tuple[np.ndarray | None, int, int]:
        """Parse JPEG/PNG to 2D numpy array using Pillow."""
        try:
            from PIL import Image
            import io

            img_pil = Image.open(io.BytesIO(data))
            w, h = img_pil.size

            # Convert to grayscale if needed
            if img_pil.mode != 'L':
                img_pil = img_pil.convert('L')

            arr = np.array(img_pil, dtype=np.float32)
            return arr, w, h

        except Exception as e:
            log.error("Image parse error: %s", e)
            return None, 0, 0
