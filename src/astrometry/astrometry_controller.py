"""
Astrometry controller — Vue 3 composable that bridges the frontend
with the INDIGO server's astrometry backend.

Provides:
  - Connection state (connected, solving, status)
  - Fake image generation for testing
  - Plate solving via POST /api/astrometrie/solve
  - Result display helpers
"""

import json
import asyncio
import requests
from pathlib import Path

from .fake_fits import generate_fake_fits


# ── Fake image catalogue ────────────────────────────────────────────

FAKE_IMAGES = [
    {
        "name": "Orion Nebula (fake)",
        "path": "fake_fits/orion_nebula.tif",
        "width": 1920,
        "height": 1080,
        "description": "Simulated Orion Nebula field with ~500 stars",
    },
    {
        "name": "Pleiades (fake)",
        "path": "fake_fits/pleiades.tif",
        "width": 1024,
        "height": 1024,
        "description": "Simulated Pleiades cluster field",
    },
    {
        "name": "Galaxy Cluster (fake)",
        "path": "fake_fits/galaxy_cluster.tif",
        "width": 2048,
        "height": 2048,
        "description": "Simulated galaxy cluster with deep field",
    },
]


# ── Controller class ────────────────────────────────────────────────

class AstrometryController:
    """Async controller for astrometry operations."""

    def __init__(self, base_url: str = "http://localhost:8080"):
        self.base_url = base_url
        self._connected = False
        self._solving = False
        self._status = "Disconnecté"
        self._results = None
        self._log: list[dict] = []

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def solving(self) -> bool:
        return self._solving

    @property
    def status(self) -> str:
        return self._status

    @property
    def fake_images(self) -> list[dict]:
        return FAKE_IMAGES

    @property
    def results(self) -> dict | None:
        return self._results

    @property
    def log(self) -> list[dict]:
        return self._log

    @property
    def status_text(self) -> str:
        return self._status

    # ── Connection ────────────────────────────────────────────────

    async def connect(self) -> bool:
        """Check connectivity to the astrometry backend."""
        try:
            resp = requests.get(
                f"{self.base_url}/api/astrometrie/status",
                timeout=3,
            )
            if resp.status_code == 200:
                self._connected = True
                self._status = "Connecté"
                self._log.append({
                    "time": self._now_time(),
                    "message": "Connecté au serveur d'astrométrie",
                    "error": False,
                })
                return True
        except requests.RequestException:
            self._connected = False
            self._status = "Disconnecté"
            self._log.append({
                "time": self._now_time(),
                "message": "Incapable de se connecter au serveur",
                "error": True,
            })
        return self._connected

    async def disconnect(self) -> None:
        self._connected = False
        self._status = "Disconnecté"
        self._log.append({
            "time": self._now_time(),
            "message": "Déconnexion du serveur d'astrométrie",
            "error": False,
        })

    # ── Plate solving ─────────────────────────────────────────────

    async def solve(self, mode: str = "mount",
                    image: str = "",
                    threshold: int = 100,
                    ra_deg: float | None = None,
                    dec_deg: float | None = None) -> dict | None:
        """Send a plate solving request to the backend.

        Args:
            mode: 'mount' (with approximate position) or 'blind'
            image: Path to the image file or 'capture' for live
            threshold: Star detection threshold
            ra_deg: Approximate RA in degrees (for mount mode)
            dec_deg: Approximate DEC in degrees (for mount mode)

        Returns:
            Result dict or None on failure.
        """
        self._solving = True
        self._status = "Résolution en cours..."
        self._log.append({
            "time": self._now_time(),
            "message": f"Démarrage de la résolution (mode: {mode})",
            "error": False,
        })

        # Build the request payload
        payload = {
            "mode": mode,
            "image": image,
            "threshold": threshold,
        }
        if mode == "mount" and ra_deg is not None and dec_deg is not None:
            payload["ra_deg"] = ra_deg
            payload["dec_deg"] = dec_deg

        try:
            url = f"{self.base_url}/api/astrometrie/solve"
            resp = requests.post(url, json=payload, timeout=30)

            if resp.status_code == 200:
                result = resp.json()
                self._results = result
                self._log.append({
                    "time": self._now_time(),
                    "message": f"Résolution terminée — {result.get('matched_stars', 0)} étoiles matchées",
                    "error": False,
                })
            else:
                error_msg = resp.json().get("error", "Erreur inconnue")
                self._log.append({
                    "time": self._now_time(),
                    "message": f"Erreur de résolution: {error_msg}",
                    "error": True,
                })
                self._results = None

        except requests.RequestException as exc:
            self._log.append({
                "time": self._now_time(),
                "message": f"Erreur réseau: {str(exc)}",
                "error": True,
            })
            self._results = None

        except Exception as exc:
            self._log.append({
                "time": self._now_time(),
                "message": f"Erreur inattendue: {str(exc)}",
                "error": True,
            })
            self._results = None

        finally:
            self._solving = False
            if self._results:
                self._status = "Résolution terminée"
            else:
                self._status = "Disconnecté"

        return self._results

    # ── Fake image generation ─────────────────────────────────────

    async def generate_fake_image(self, image_name: str,
                                 output_dir: str = "fake_fits") -> str | None:
        """Generate a fake FITS image for testing.

        Args:
            image_name: One of the names in FAKE_IMAGES or custom name
            output_dir: Directory to write the FITS file

        Returns:
            Path to the generated FITS file, or None on failure.
        """
        try:
            img_config = None
            for cfg in FAKE_IMAGES:
                if cfg["name"] == image_name:
                    img_config = cfg
                    break

            if not img_config:
                # Generate a generic image
                img_config = {
                    "name": image_name,
                    "path": f"{output_dir}/{image_name}.fits",
                    "width": 1920,
                    "height": 1080,
                    "description": f"Simulated field: {image_name}",
                }

            output_path = img_config["path"]
            generate_fake_fits(
                output_path=output_path,
                width=img_config["width"],
                height=img_config["height"],
                description=img_config.get("description", ""),
                ra_center=180.0,
                dec_center=30.0,
                scale_arcsec_px=0.25,
            )

            self._log.append({
                "time": self._now_time(),
                "message": f"Image fake générée: {output_path}",
                "error": False,
            })
            return output_path

        except Exception as exc:
            self._log.append({
                "time": self._now_time(),
                "message": f"Erreur génération image: {str(exc)}",
                "error": True,
            })
            return None

    # ── Helpers ───────────────────────────────────────────────────

    def _now_time(self) -> str:
        return asyncio.get_event_loop().time()

    def clear_results(self) -> None:
        self._results = None
        self._status = "Disconnecté"
        self._log.append({
            "time": self._now_time(),
            "message": "Résultats effacés",
            "error": False,
        })

    def add_log_entry(self, message: str, is_error: bool = False) -> None:
        self._log.append({
            "time": self._now_time(),
            "message": message,
            "error": is_error,
        })
        if len(self._log) > 100:
            self._log = self._log[-100:]
