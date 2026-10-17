"""Tests for display-only FITS binning (WebServer._fits_bin).

Le binning sert l'affichage navigateur des gros capteurs ; il ne doit pas
toucher aux analyses (qui restent sur le FITS complet côté serveur).
"""
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from web.server import WebServer

WS = WebServer.__new__(WebServer)


def fits(phys, bzero=0.0, bscale=1.0, bitpix=16):
    phys = np.asarray(phys, dtype=np.float64)
    planes = phys.shape[0] if phys.ndim == 3 else 1
    h, w = (phys.shape[1], phys.shape[2]) if planes > 1 else phys.shape
    naxis = 3 if planes > 1 else 2
    cards = ["SIMPLE  =                    T", f"BITPIX  = {bitpix:>21}",
             f"NAXIS   = {naxis:>21}", f"NAXIS1  = {w:>21}", f"NAXIS2  = {h:>21}"]
    if naxis == 3:
        cards.append(f"NAXIS3  = {planes:>21}")
    cards += [f"BZERO   = {bzero:>21.1f}", f"BSCALE  = {bscale:>21.1f}", "END"]
    hdr = "".join(c.ljust(80)[:80] for c in cards).ljust(2880).encode("ascii")
    vals = (phys - bzero) / bscale if bscale else phys - bzero
    if bitpix == 8:
        stored = np.clip(np.rint(vals), 0, 255).astype(">u1")
    elif bitpix == -32:
        stored = vals.astype(">f4")
    else:
        stored = np.rint(vals).astype(">i2")
    body = stored.tobytes()
    body += b"\x00" * ((-len(body)) % 2880)
    return hdr + body


def dims(data):
    hdr = data[:2880].decode("ascii", errors="ignore")
    return [int(x) for x in re.findall(r"NAXIS[123]\s*=\s*(\d+)", hdr)]


def bitpix_of(data):
    return re.search(r"BITPIX\s*=\s*([-\d]+)", data[:2880].decode()).group(1)


def test_mono_bin2_halves_dims_and_averages():
    phys = 32000 + np.arange(64).reshape(8, 8)  # BZERO=32768 -> unsigned 16 bits
    out = WS._fits_bin(fits(phys, bzero=32768.0), 2)
    assert out is not None
    assert dims(out) == [4, 4]
    data = np.frombuffer(out[2880:2880 + 4 * 4 * 2], dtype=">i2").astype(float) + 32768.0
    assert data[0] == np.rint(phys[0:2, 0:2].mean())
    assert data[1] == np.rint(phys[0:2, 2:4].mean())
    assert "BZERO   =              32768.0" in out[:2880].decode()


def test_rgb_planar_keeps_planes():
    phys = 30000 + np.arange(3 * 8 * 8).reshape(3, 8, 8)
    out = WS._fits_bin(fits(phys, bzero=32768.0), 2)
    assert out is not None
    assert dims(out) == [4, 4, 3]  # NAXIS1, NAXIS2, NAXIS3


def test_rgb8_risingcam_style():
    # RisingCam ATR2600C : 8 bits RGB planaire, sans BZERO/BSCALE.
    phys = (10 + np.arange(3 * 8 * 8) % 200).reshape(3, 8, 8).astype(float)
    out = WS._fits_bin(fits(phys, bitpix=8), 2)
    assert out is not None
    assert bitpix_of(out) == "8"
    assert dims(out) == [4, 4, 3]
    # plan 0, bloc (0..2,0..2) = moyenne des 4 valeurs, en 8 bits
    got = np.frombuffer(out[2880:2880 + 3 * 4 * 4], dtype=">u1").reshape(3, 4, 4)
    assert got[0, 0, 0] == round(phys[0, 0:2, 0:2].mean())


def test_float32_bin():
    phys = 1.5 + np.arange(64).reshape(8, 8) / 10.0
    out = WS._fits_bin(fits(phys, bitpix=-32), 2)
    assert out is not None
    assert bitpix_of(out) == "-32"
    got = np.frombuffer(out[2880:2880 + 4 * 4 * 4], dtype=">f4")
    assert abs(float(got[0]) - phys[0:2, 0:2].mean()) < 1e-4


def test_not_applicable_returns_none():
    phys = 100 + np.arange(64).reshape(8, 8)
    assert WS._fits_bin(fits(phys, bitpix=1), 2) is None  # BITPIX inconnu
    assert WS._fits_bin(fits(phys, bzero=32768.0), 1) is None  # factor < 2
    assert WS._fits_bin(b"not a fits", 2) is None
