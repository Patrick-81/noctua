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

# ── Chemins ───────────────────────────────────
COLLIMATION_ROOT = Path(__file__).parent.parent / "collimation"
MODEL_DIR = COLLIMATION_ROOT / "models"
MODEL_PATH = MODEL_DIR / "best_model.pt"
DATASET_DIR = COLLIMATION_ROOT / "dataset"
DATASET_LABELS = DATASET_DIR / "labels.json"
DATASET_PREVIEW = DATASET_DIR / "preview.png"
METRICS_PATH = MODEL_DIR / "metrics.json"
# fallbacks legacy Collimation standalone (dev)
FALLBACK_MODEL = Path("/home/pat/Programmes/Collimation/model_output/best_model.pt")
FALLBACK_LABELS = Path("/home/pat/Programmes/Collimation/dataset/labels.json")
FALLBACK_METRICS = Path("/home/pat/Programmes/Collimation/model_output/metrics.json")

PHYSICAL = {
    "decenter_max_mm": 2.0,
    "tilt_max_deg": 0.3,
    "mm_per_turn": 0.5,
    "deg_per_turn": 1.5,
}

# ── Config instrument (éditable, comme CollimAI dashboard) ──
DEFAULT_HARDWARE = {
    "diametre_mm": 203,
    "focale_mm": 800,
    "obstruction_ratio": 0.345,
    "n_araignees": 4,
    "epaisseur_araignee": 0.0005,
    "pixel_size_um": 3.76,
    "patch_size_px": 128,
    "defocus_waves": 4.5,
    "wavelength_um": 0.55,
    "npix_pupil": 256,
}
DEFAULT_VIS = {
    "pas_secondaire_mm": 0.7,
    "pas_primaire_mm": 1.0,
    "rayon_levier_mm": 82,
}
DEFAULT_CONFIG = {
    "hardware": DEFAULT_HARDWARE.copy(),
    "vis": DEFAULT_VIS.copy(),
    "dataset": {"n_samples": 10000, "decenter_max_mm": 2.0, "tilt_max_deg": 0.3},
    "train": {"epochs": 40, "batch_size": 32, "lr": 1e-3},
}
CONFIG_PATH = COLLIMATION_ROOT / "config.json"
FALLBACK_CONFIG = Path("/home/pat/Programmes/Collimation/config.json")

def load_config() -> dict:
    for p in (CONFIG_PATH, FALLBACK_CONFIG):
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                pass
    # fallback : dérive depuis labels.json si présent
    ds = get_dataset_info()
    if ds.get("exists"):
        cfg = DEFAULT_CONFIG.copy()
        cfg["hardware"] = ds.get("hardware", DEFAULT_HARDWARE).copy()
        cfg["vis"] = ds.get("vis", DEFAULT_VIS).copy()
        return cfg
    return json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy

def save_config(cfg: dict) -> dict:
    # validation minimale
    hw = cfg.get("hardware", {})
    for k in ("diametre_mm","focale_mm","obstruction_ratio","pixel_size_um"):
        if k in hw:
            try: hw[k] = float(hw[k])
            except: pass
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    return cfg

# ── LLM free lookup (PC uniquement) ──────────────────────────
async def llm_lookup_instrument(query: str) -> dict | None:
    """Interroge un LLM chat public free pour récupérer les specs d'un instrument.

    Providers supportés (ordre) :
      1. OpenRouter free (OPENROUTER_API_KEY) — modèle : meta-llama/llama-3.1-8b-instruct:free
      2. HuggingFace Inference (HF_TOKEN) — modèle : mistralai/Mistral-7B-Instruct-v0.3
    Retourne {"hardware": {...}, "vis": {...}, "source": "llm", "provider": "..."}
    ou None si aucun provider configuré.
    """
    import os
    query = query.strip()
    if not query:
        return None

    # Prompt commun
    system = (
        "Tu es expert en télescopes Newton. Réponds UNIQUEMENT en JSON valide, sans markdown, "
        "sans explication. Clés attendues : diametre_mm (int), focale_mm (int), "
        "obstruction_ratio (float 0-1, ex 0.345 pour 70/203), n_araignees (int), "
        "epaisseur_araignee (float mètres, ex 0.0005 pour 0.5mm), pixel_size_um (float, défaut 3.76), "
        "patch_size_px (int 128), defocus_waves (float 4.5), wavelength_um (0.55), "
        "pas_secondaire_mm (0.7), pas_primaire_mm (1.0), rayon_levier_mm (82). "
        "Si une valeur est inconnue, mets la valeur par défaut GSO 200/800."
    )
    user = f"Instrument : {query}\nRetourne JSON avec clés hardware (diametre_mm, focale_mm, obstruction_ratio, n_araignees, epaisseur_araignee, pixel_size_um, patch_size_px, defocus_waves, wavelength_um) et vis (pas_secondaire_mm, pas_primaire_mm, rayon_levier_mm). Exemple: {{\"hardware\":{{\"diametre_mm\":203,\"focale_mm\":800,\"obstruction_ratio\":0.345,\"n_araignees\":4,\"epaisseur_araignee\":0.0005,\"pixel_size_um\":3.76,\"patch_size_px\":128,\"defocus_waves\":4.5,\"wavelength_um\":0.55}},\"vis\":{{\"pas_secondaire_mm\":0.7,\"pas_primaire_mm\":1.0,\"rayon_levier_mm\":82}}}}"

    # ── 1. OpenRouter free ───────────────────────────────────
    or_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OR_API_KEY")
    or_model = os.environ.get("COLLM_LLM_MODEL") or "meta-llama/llama-3.1-8b-instruct:free"
    if or_key:
        try:
            import urllib.request, urllib.error
            payload = json.dumps({
                "model": or_model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": 0.2,
                "max_tokens": 600,
            }).encode()
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=payload,
                headers={
                    "Authorization": f"Bearer {or_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://noctua.local",
                    "X-Title": "Noctua Collimation",
                },
                method="POST",
            )
            import asyncio
            def _do():
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return json.loads(resp.read().decode())
            data = await asyncio.to_thread(_do)
            content = data["choices"][0]["message"]["content"]
            # Extraire JSON (peut être entouré de ```)
            import re
            m = re.search(r"\{.*\}", content, re.DOTALL)
            if m:
                parsed = json.loads(m.group(0))
                hw = parsed.get("hardware") or {}
                vis = parsed.get("vis") or {}
                # normaliser epaisseur_araignee si en mm
                if "epaisseur_araignee" in hw and hw["epaisseur_araignee"] > 0.01:
                    hw["epaisseur_araignee"] = float(hw["epaisseur_araignee"]) / 1000
                return {"hardware": hw, "vis": vis, "source": "openrouter", "provider": f"openrouter:{or_model}", "raw": content}
        except Exception as e:
            # log côté appelant
            raise RuntimeError(f"OpenRouter failed: {e}") from e

    # ── 2. HuggingFace Inference ─────────────────────────────
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    hf_model = os.environ.get("COLLM_HF_MODEL") or "mistralai/Mistral-7B-Instruct-v0.3"
    if hf_token:
        try:
            import urllib.request
            prompt = f"{system}\n\n{user}\n\nJSON:"
            payload = json.dumps({"inputs": prompt, "parameters": {"max_new_tokens": 500, "temperature": 0.2}}).encode()
            req = urllib.request.Request(
                f"https://api-inference.huggingface.co/models/{hf_model}",
                data=payload,
                headers={"Authorization": f"Bearer {hf_token}", "Content-Type": "application/json"},
                method="POST",
            )
            import asyncio
            def _do2():
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return json.loads(resp.read().decode())
            data = await asyncio.to_thread(_do2)
            # HF retourne liste avec generated_text
            text = data[0]["generated_text"] if isinstance(data, list) else str(data)
            import re
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                parsed = json.loads(m.group(0))
                hw = parsed.get("hardware") or {}
                vis = parsed.get("vis") or {}
                return {"hardware": hw, "vis": vis, "source": "huggingface", "provider": f"hf:{hf_model}", "raw": text}
        except Exception as e:
            raise RuntimeError(f"HuggingFace failed: {e}") from e

    # Aucun provider configuré → fallback heuristique géré côté router
    return None


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


def _dataset_labels_path() -> Path | None:
    if DATASET_LABELS.exists():
        return DATASET_LABELS
    if FALLBACK_LABELS.exists():
        return FALLBACK_LABELS
    return None

def _metrics_path() -> Path | None:
    if METRICS_PATH.exists():
        return METRICS_PATH
    if FALLBACK_METRICS.exists():
        return FALLBACK_METRICS
    return None

def get_dataset_info() -> dict:
    p = _dataset_labels_path()
    if p and p.exists():
        try:
            data = json.loads(p.read_text())
            hw = data.get("hardware") or DEFAULT_HARDWARE
            vis = data.get("vis") or DEFAULT_VIS
            return {
                "exists": True,
                "path": str(p),
                "telescope": data.get("telescope", "GSO Photon 8\" F4 — 203mm/800mm"),
                "hardware": hw,
                "vis": vis,
                "n_samples": data.get("n_samples", len(data.get("samples", []))),
                "decenter_range": data.get("decenter_range", 2.0),
                "tilt_range": data.get("tilt_range", 0.3),
                "preview_exists": DATASET_PREVIEW.exists() or Path("/home/pat/Programmes/Collimation/dataset/preview.png").exists(),
            }
        except Exception:
            pass
    return {"exists": False, "hardware": DEFAULT_HARDWARE, "vis": DEFAULT_VIS, "n_samples": 0}

def get_metrics() -> dict | None:
    p = _metrics_path()
    if p and p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return None
    return None

def hardware_info() -> dict:
    ds = get_dataset_info()
    metrics = get_metrics()
    return {
        "is_rpi": is_rpi(),
        "allow_training": allow_training(),
        "machine": platform.machine(),
        "model_exists": _model_path().exists(),
        "model_path": str(_model_path()),
        "dataset": ds,
        "metrics": metrics,
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
