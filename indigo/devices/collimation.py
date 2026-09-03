"""
collimation.py — Atelier Collimation (CollimAI) — logique pure.

Porte l'inférence CollimNet (128x128) + détection RPi pour griser l'apprentissage.

Architecture identique à inference.py (CollimAI) :
  - CollimNet : 4 blocs conv 1->32->64->128, head 2048->256->4 (Tanh)
  - predict() : 30 passes MC Dropout -> decenter/tilt -> tours de vis

RPi detection : platform.machine + /proc/device-tree/model
"""

from __future__ import annotations

import json
import platform
import subprocess
import time
from pathlib import Path
from typing import Tuple

import numpy as np

# ── Modèle local ────────────────────────────────
MODEL_DIR = Path(__file__).parent.parent / "collimation" / "models"
MODEL_PATH = MODEL_DIR / "best_model.pt"
# fallback legacy Collimation standalone (dev)
FALLBACK_MODEL = Path("/home/pat/Programmes/Collimation/model_output/best_model.pt")

PHYSICAL = {
    "decenter_max_mm": 2.0,
    "tilt_max_deg": 0.3,
    "mm_per_turn": 0.5,
    "deg_per_turn": 1.5,
}


# ── RPi detection ──────────────────────────────
def is_rpi() -> bool:
    m = platform.machine()
    if m in ("aarch64", "armv7l", "armv6l"):
        # Vérifie que c'est bien un Pi, pas une VM aarch64
        try:
            txt = Path("/proc/device-tree/model").read_text(errors="ignore")
            if "Raspberry Pi" in txt:
                return True
            # Sur Pi sans device-tree accessible, on considère aarch64 = RPi
            return True
        except Exception:
            return True
    try:
        txt = Path("/proc/device-tree/model").read_text(errors="ignore")
        if "Raspberry Pi" in txt:
            return True
    except Exception:
        pass
    return False


def allow_training() -> bool:
    """False sur RPi, True ailleurs. Override via env NOCTUA_ALLOW_TRAINING=1."""
    import os
    if os.environ.get("NOCTUA_ALLOW_TRAINING") == "1":
        return True
    if os.environ.get("NOCTUA_ALLOW_TRAINING") == "0":
        return False
    return not is_rpi()


def hardware_info() -> dict:
    return {
        "is_rpi": is_rpi(),
        "allow_training": allow_training(),
        "machine": platform.machine(),
        "model_exists": _model_path().exists(),
        "model_path": str(_model_path()),
    }


def _model_path() -> Path:
    if MODEL_PATH.exists():
        return MODEL_PATH
    return FALLBACK_MODEL


# ── Architecture CollimNet (identique inference.py / train_model.py) ──
try:
    import torch
    import torch.nn as nn

    class CollimNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.features = nn.Sequential(
                nn.Conv2d(1, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
                nn.Conv2d(32, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(128, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(),
                nn.AdaptiveAvgPool2d(4),
            )
            self.head = nn.Sequential(
                nn.Flatten(),
                nn.Linear(128 * 4 * 4, 256),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(256, 4),
                nn.Tanh()
            )

        def forward(self, x):
            return self.head(self.features(x))

    _TORCH_AVAILABLE = True
except Exception:
    CollimNet = None  # type: ignore
    _TORCH_AVAILABLE = False


def _load_model(device: str = "cpu"):
    if not _TORCH_AVAILABLE:
        raise RuntimeError("torch non installé : pip install torch --index-url https://download.pytorch.org/whl/cpu")
    mp = _model_path()
    if not mp.exists():
        raise FileNotFoundError(f"Modèle introuvable : {mp}")
    import torch
    model = CollimNet().to(device)  # type: ignore
    model.load_state_dict(torch.load(str(mp), map_location=device, weights_only=True))
    model.eval()
    return model


def _center_crop(img: np.ndarray, size: int = 128) -> np.ndarray:
    h, w = img.shape[-2], img.shape[-1]
    if h == size and w == size:
        return img
    total = float(img.sum()) + 1e-12
    ys = np.arange(h)
    xs = np.arange(w)
    cy = int((img * ys[:, None]).sum() / total)
    cx = int((img * xs[None, :]).sum() / total)
    half = size // 2
    y0 = max(0, cy - half); y1 = y0 + size
    x0 = max(0, cx - half); x1 = x0 + size
    if y1 > h: y0, y1 = h - size, h
    if x1 > w: x0, x1 = w - size, w
    return img[y0:y1, x0:x1]


def load_image(path: str | Path, target_size: int = 128) -> np.ndarray:
    """Charge FITS/PNG/JPG -> patch 128x128 float32 [0,1] centré."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".npy":
        img = np.load(p).astype(np.float32)
    elif ext in (".fit", ".fits"):
        try:
            from astropy.io import fits
        except ImportError as e:
            raise RuntimeError("astropy requis pour FITS : pip install astropy") from e
        with fits.open(p) as hdul:
            img = None
            for hdu in hdul:
                if hdu.data is not None and getattr(hdu.data, "ndim", 0) >= 2:
                    img = hdu.data.astype(np.float32)
                    break
            if img is None:
                raise ValueError("Aucune donnée image dans le FITS")
            while img.ndim > 2:
                img = img[0]
    elif ext in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
        from PIL import Image
        pil = Image.open(p).convert("L")
        img = np.array(pil, dtype=np.float32)
    else:
        raise ValueError(f"Format non supporté : {ext}")
    img = _center_crop(img, target_size)
    img = (img - img.min()) / (img.max() - img.min() + 1e-12)
    return img.astype(np.float32)


def predict(image_path: str | Path, star_x: float | None = None, star_y: float | None = None) -> tuple[dict, np.ndarray]:
    """
    Inférence CollimAI sur une image.
    Si star_x/y fournis, on crop autour de l'étoile dans l'image plein champ.
    Sinon barycentre global.
    Retourne (result_dict, patch_img 128x128).
    """
    import torch
    import torch.nn as nn

    device = torch.device("cpu")
    model = _load_model(device="cpu")

    # Si coords étoile fournies, extraire patch autour de l'étoile depuis l'image plein champ
    if star_x is not None and star_y is not None:
        # Charger plein champ sans center_crop barycentrique
        p = Path(image_path)
        ext = p.suffix.lower()
        if ext in (".fit", ".fits"):
            from astropy.io import fits
            with fits.open(p) as hdul:
                img_full = None
                for hdu in hdul:
                    if hdu.data is not None and getattr(hdu.data, "ndim", 0) >= 2:
                        img_full = hdu.data.astype(np.float32)
                        break
                if img_full is None:
                    raise ValueError("Aucune donnée image dans le FITS")
                while img_full.ndim > 2:
                    img_full = img_full[0]
        elif ext in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
            from PIL import Image
            img_full = np.array(Image.open(p).convert("L"), dtype=np.float32)
        elif ext == ".npy":
            img_full = np.load(p).astype(np.float32)
        else:
            raise ValueError(f"Format non supporté : {ext}")
        # Crop 128 autour de star_x/y
        h, w = img_full.shape
        half = 64
        x0 = int(max(0, min(w - 128, int(round(star_x)) - half)))
        y0 = int(max(0, min(h - 128, int(round(star_y)) - half)))
        patch = img_full[y0:y0+128, x0:x0+128].astype(np.float32)
        patch = (patch - patch.min()) / (patch.max() - patch.min() + 1e-12)
        img = patch
    else:
        img = load_image(image_path, 128)

    img_t = torch.from_numpy(img).unsqueeze(0).unsqueeze(0)

    def enable_dropout(m):
        if isinstance(m, nn.Dropout):
            m.train()
    model.apply(enable_dropout)

    N_MC = 30
    preds = []
    with torch.no_grad():
        for _ in range(N_MC):
            preds.append(model(img_t).squeeze().cpu().numpy())
    preds = np.stack(preds)
    mean = preds.mean(axis=0)
    std = preds.std(axis=0)

    dx_mm = float(mean[0]) * PHYSICAL["decenter_max_mm"]
    dy_mm = float(mean[1]) * PHYSICAL["decenter_max_mm"]
    tx_deg = float(mean[2]) * PHYSICAL["tilt_max_deg"]
    ty_deg = float(mean[3]) * PHYSICAL["tilt_max_deg"]
    dx_unc = float(std[0]) * PHYSICAL["decenter_max_mm"]
    dy_unc = float(std[1]) * PHYSICAL["decenter_max_mm"]

    v = PHYSICAL["mm_per_turn"]
    angles_vis = np.radians([90, 210, 330])
    tours_dec = np.array([(dx_mm * np.cos(a) + dy_mm * np.sin(a)) / v for a in angles_vis])
    tours_tilt = np.array([(tx_deg * np.cos(a) + ty_deg * np.sin(a)) / PHYSICAL["deg_per_turn"] for a in angles_vis])

    collim_score = float(np.sqrt(
        (dx_mm / PHYSICAL["decenter_max_mm"])**2 +
        (dy_mm / PHYSICAL["decenter_max_mm"])**2 +
        (tx_deg / PHYSICAL["tilt_max_deg"])**2 +
        (ty_deg / PHYSICAL["tilt_max_deg"])**2
    ) / 2)

    result = {
        "decenter_x_mm": round(dx_mm, 3),
        "decenter_y_mm": round(dy_mm, 3),
        "tilt_x_deg": round(tx_deg, 4),
        "tilt_y_deg": round(ty_deg, 4),
        "incertitude_dx": round(dx_unc, 3),
        "incertitude_dy": round(dy_unc, 3),
        "collimation_score": round(collim_score, 3),
        "correction_vis": {
            "secondaire_vis1_tours": round(float(tours_dec[0]), 2),
            "secondaire_vis2_tours": round(float(tours_dec[1]), 2),
            "secondaire_vis3_tours": round(float(tours_dec[2]), 2),
            "primaire_vis1_tours": round(float(tours_tilt[0]), 2),
            "primaire_vis2_tours": round(float(tours_tilt[1]), 2),
            "primaire_vis3_tours": round(float(tours_tilt[2]), 2),
        }
    }
    return result, img
