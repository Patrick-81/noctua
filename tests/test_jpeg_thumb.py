"""Tests for color thumbnails + noise-floor stretch (WebServer._jpeg_thumb)."""
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image as _PIL

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from web.server import WebServer

WS = WebServer.__new__(WebServer)
H, W = 480, 640


def fits_hdr(cards):
    return "".join(c.ljust(80) for c in cards).ljust(2880)[:2880].encode("ascii")


def color_scene():
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:H, 0:W]
    scene = np.zeros((H, W, 3))
    for x, y, peak, sigma, ch in [(150, 200, 200, 4, 0), (450, 300, 180, 4, 2),
                                  (300, 100, 120, 3, 1)]:
        scene[:, :, ch] += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
    scene += 8 + rng.normal(0, 2, scene.shape)
    return np.clip(scene, 0, 255).astype(np.uint8)


def thumb_img(jpg):
    assert jpg and jpg[:2] == b"\xff\xd8", "not a JPEG"
    return np.asarray(_PIL.open(io.BytesIO(jpg)).convert("RGB")).astype(float)


def test_rgb_planar_keeps_color():
    s8 = color_scene()
    planar = np.stack([s8[:, :, 0], s8[:, :, 1], s8[:, :, 2]], axis=0)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    8",
                    "NAXIS   =                    3", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "NAXIS3  =                    3", "END"])
    d = thumb_img(WS._jpeg_thumb(hdr + planar.tobytes(), 320))
    s = 320 / max(H, W)
    r = d[int(200 * s) - 3:int(200 * s) + 4, int(150 * s) - 3:int(150 * s) + 4].mean(axis=(0, 1))
    b = d[int(300 * s) - 3:int(300 * s) + 4, int(450 * s) - 3:int(450 * s) + 4].mean(axis=(0, 1))
    assert r[0] > r[2] + 20, r
    assert b[2] > b[0] + 20, b


def test_bayer_debayer_color():
    s8 = color_scene()
    mos = np.zeros((H, W), np.uint8)
    mos[0::2, 1::2] = s8[0::2, 1::2, 0]
    mos[1::2, 0::2] = s8[1::2, 0::2, 2]
    mos[0::2, 0::2] = s8[0::2, 0::2, 1]
    mos[1::2, 1::2] = s8[1::2, 1::2, 1]
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    8",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'", "END"])
    d = thumb_img(WS._jpeg_thumb(hdr + mos.tobytes(), 320))
    s = 320 / max(H, W)
    r = d[int(200 * s) - 3:int(200 * s) + 4, int(150 * s) - 3:int(150 * s) + 4].mean(axis=(0, 1))
    b = d[int(300 * s) - 3:int(300 * s) + 4, int(450 * s) - 3:int(450 * s) + 4].mean(axis=(0, 1))
    assert r[0] > r[2] + 15, r
    assert b[2] > b[0] + 15, b


def test_bayer_16bit_faint_stars_survive():
    # Cas réel SV305PRO RAW16 : offset 32768, étoiles faibles ~100-300 ADU.
    # Un passage uint8 intermédiaire (//257) les écraserait à 0/1.
    rng = np.random.default_rng(5)
    yy, xx = np.mgrid[0:H, 0:W]
    img = np.full((H, W), 48.0)
    for x, y, peak in [(150, 200, 250.0), (450, 300, 400.0), (300, 100, 150.0)]:
        img += peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 3.0 ** 2))
    img += rng.normal(0, 6, img.shape)
    raw16 = np.clip(img, 0, 4095).astype(np.int32) + 32768
    # Mosaïque GRBG : sous-échantillonne chaque phase (le motif survit).
    mos = np.zeros((H, W), np.int32)
    mos[0::2, 1::2] = raw16[0::2, 1::2]
    mos[1::2, 0::2] = raw16[1::2, 0::2]
    mos[0::2, 0::2] = raw16[0::2, 0::2]
    mos[1::2, 1::2] = raw16[1::2, 1::2]
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                   16",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'",
                    "BZERO   =                32768", "END"])
    d = thumb_img(WS._jpeg_thumb(hdr + mos.astype(">i2").tobytes(), 320))
    s = 320 / max(H, W)
    for x, y in [(150, 200), (450, 300), (300, 100)]:
        v = d[int(y * s) - 2:int(y * s) + 3, int(x * s) - 2:int(x * s) + 3].mean()
        assert v > 40, (x, y, v)
    assert float(np.median(d)) < 30, float(np.median(d))


def test_dark_stays_black():
    dark = np.zeros((H, W), np.uint8)
    dark[10, 10] = 200
    dark[400, 500] = 150
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    8",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "END"])
    d = np.asarray(_PIL.open(io.BytesIO(
        WS._jpeg_thumb(hdr + dark.tobytes(), 320))).convert("L")).astype(float)
    assert float(np.median(d)) < 25, float(np.median(d))
    assert float(d.max()) > 150, float(d.max())


def test_tungsten_ceiling_balanced():
    # Cas réel SV305PRO : plafond éclairé chaud, GRBG 16 bits, BZERO=32768.
    # R=12473 G=9689 B=2615 (+bruit) → sans balance, la vignette sort orange ;
    # avec balance gris-moyen, les 3 canaux du fond s'égalisent (neutre).
    rng = np.random.default_rng(7)
    phys = np.zeros((H, W, 3))
    phys[:, :, 0] = 12473.0
    phys[:, :, 1] = 9689.0
    phys[:, :, 2] = 2615.0
    phys += rng.normal(0, 60, phys.shape)
    mos = np.zeros((H, W), np.int32)
    mos[0::2, 0::2] = (phys[0::2, 0::2, 1] - 32768)
    mos[0::2, 1::2] = (phys[0::2, 1::2, 0] - 32768)
    mos[1::2, 0::2] = (phys[1::2, 0::2, 2] - 32768)
    mos[1::2, 1::2] = (phys[1::2, 1::2, 1] - 32768)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                   16",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'",
                    "BZERO   =                32768", "END"])
    d = thumb_img(WS._jpeg_thumb(hdr + mos.astype(">i2").tobytes(), 320))
    meds = [float(np.median(d[:, :, c])) for c in range(3)]
    spread = max(meds) - min(meds)
    assert spread < 40, meds
    assert sum(meds) / 3 > 100, meds  # fond clair, pas noir


def _warm_mosaic(bzero_card, bscale_card, V):
    """Mosaïque GRBG 16 bits d'un fond chaud R>G>B (cas SV305PRO)."""
    rng = np.random.default_rng(21)
    phys = np.zeros((H, W, 3))
    phys[:, :, 0] = 12473.0
    phys[:, :, 1] = 9689.0
    phys[:, :, 2] = 2615.0
    phys += rng.normal(0, 50, phys.shape)
    mos = np.zeros((H, W), np.int32)
    if bzero_card:
        mos[0::2, 0::2] = (phys[0::2, 0::2, 1] - V)
        mos[0::2, 1::2] = (phys[0::2, 1::2, 0] - V)
        mos[1::2, 0::2] = (phys[1::2, 0::2, 2] - V)
        mos[1::2, 1::2] = (phys[1::2, 1::2, 1] - V)
    else:
        for (yy, xx), ch in [((0, 0), 1), ((0, 1), 0), ((1, 0), 2), ((1, 1), 1)]:
            mos[yy::2, xx::2] = phys[yy::2, xx::2, ch]
    return mos


def _neutral(jpg, tol=45):
    d = thumb_img(jpg)
    meds = [float(np.median(d[:, :, c])) for c in range(3)]
    assert max(meds) - min(meds) < tol, meds
    assert sum(meds) / 3 > 80, meds
    return meds


def test_rgb_planar_16bit_bzero_applies_scaling():
    # RGB planaire (RisingCam) : le BZERO doit s'appliquer comme en Bayer,
    # sinon les valeurs restent négatives → balance sautée → canaux inversés.
    rng = np.random.default_rng(3)
    phys = np.zeros((H, W, 3))
    phys[:, :, 0], phys[:, :, 1], phys[:, :, 2] = 12473.0, 9689.0, 2615.0
    phys += rng.normal(0, 50, phys.shape)
    stored = (phys - 32768).astype(np.int16)
    planar = np.stack([stored[:, :, 0], stored[:, :, 1], stored[:, :, 2]], axis=0)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    16",
                    "NAXIS   =                    3", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "NAXIS3  =                    3",
                    "BZERO   =                32768", "END"])
    _neutral(WS._jpeg_thumb(hdr + planar.astype(">i2").tobytes(), 320))


def test_bayer_bzero_scientific_notation():
    # Certains drivers écrivent BZERO en notation scientifique (E). Sans
    # prise en charge, l'offset est tronqué (3.2768) et la vignette teinte.
    mos = _warm_mosaic(True, False, 32768)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    16",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'",
                    "BZERO   =        3.2768000000000E+04", "END"])
    _neutral(WS._jpeg_thumb(hdr + mos.astype(">i2").tobytes(), 320))


def test_bayer_negative_int16_autodetect_offset():
    # Entête sans BZERO mais données 16 bits négatives (offset 32768 non
    # déclaré) : le repli doit rétablir un rendu neutre, pas saturer R/G.
    mos = _warm_mosaic(False, False, 0)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    16",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'", "END"])
    _neutral(WS._jpeg_thumb(hdr + mos.astype(">i2").tobytes(), 320))


def test_saturated_flat_field_stays_neutral():
    # Cas terrain : capteur saturé (~99 % plein-échelle), champ quasi
    # uniforme (plafond lumineux). Le bruit de lecture ne doit PAS être
    # étiré sur toute la dynamique (moucheture arc-en-ciel) : aplat neutre.
    rng = np.random.default_rng(9)
    phys = np.full((H, W, 3), 64631.0)
    phys[:, :, 0] += 300.0
    phys[:, :, 2] -= 800.0
    phys += rng.normal(0, 120, phys.shape)
    mos = np.zeros((H, W), np.int32)
    mos[0::2, 0::2] = (phys[0::2, 0::2, 1] - 32768)
    mos[0::2, 1::2] = (phys[0::2, 1::2, 0] - 32768)
    mos[1::2, 0::2] = (phys[1::2, 0::2, 2] - 32768)
    mos[1::2, 1::2] = (phys[1::2, 1::2, 1] - 32768)
    hdr = fits_hdr(["SIMPLE  =                    T", "BITPIX  =                    16",
                    "NAXIS   =                    2", f"NAXIS1  =                 {W}",
                    f"NAXIS2  =                 {H}", "BAYERPAT= 'GRBG'",
                    "BZERO   =                32768", "END"])
    d = thumb_img(WS._jpeg_thumb(hdr + mos.astype(">i2").tobytes(), 320))
    meds = [float(np.median(d[:, :, c])) for c in range(3)]
    assert max(meds) - min(meds) < 12, meds
    spread = float(np.percentile(d, 99)) - float(np.percentile(d, 1))
    assert spread < 20, spread


if __name__ == "__main__":
    for fn in (test_rgb_planar_keeps_color, test_bayer_debayer_color,
                test_bayer_16bit_faint_stars_survive, test_dark_stays_black,
                test_tungsten_ceiling_balanced,
                test_rgb_planar_16bit_bzero_applies_scaling,
                test_bayer_bzero_scientific_notation,
                test_bayer_negative_int16_autodetect_offset,
                test_saturated_flat_field_stays_neutral):
        print(f"{fn.__name__} ...")
        fn()
    print("THUMB OK")
