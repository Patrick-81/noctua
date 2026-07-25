# Seiza — Plate Solving

**Site** : https://seiza.fyi  
**Repo** : https://github.com/theatrus/seiza  
**Licence** : Apache-2.0

## Installation

```bash
pip install seiza
```

Binary wheels pour Linux (x86_64, aarch64), macOS (universal2), Windows (x64).  
CPython 3.9+ requis. Type stubs inclus.

## Téléchargement des catalogues

```python
import seiza

# Catalogue léger Tycho-2 (recommandé pour usage courant)
paths = seiza.fetch_catalogs()
# → {"stars-lite-tycho2.bin": "...", "objects-lite.json": "..."}

# Catalogue deep Gaia G≤16 (pour champ faint)
paths = seiza.fetch_catalogs(["stars-deep-gaia17.bin", "blind-gaia16.idx"])

# Tout
paths = seiza.fetch_catalogs("all")
```

**CLI** :
```bash
seiza download-data prebuilt --output data
seiza setup   # wizard interactif
```

**Variable d'env** : `SEIZA_CACHE_DIR` ou `SEIZA_CATALOG_DIR`

## API Python

### Détection d'étoiles

```python
import numpy as np
import seiza

# Image 2D float32 ou uint8
stars = seiza.detect(image_array)
# → liste de (x, y, flux) tuples
```

### Solve avec indice (hinted)

```python
catalog = seiza.StarCatalog.open(paths["stars-lite-tycho2.bin"])

solution = seiza.solve(
    stars, catalog,
    width=1920, height=1080,
    ra=100.5,              # RA en degrés (hint)
    dec=35.2,              # DEC en degrés (hint)
    scale_arcsec_px=2.5,   # échelle en arcsec/pixel (hint)
    sip_order=3,           # distortion SIP (optionnel)
)
```

### Blind solve (sans indice)

```python
index = seiza.BlindIndex.open(paths["blind-gaia16.idx"])

solution = seiza.solve_blind(
    stars, catalog, index,
    width=1920, height=1080,
    min_scale_arcsec_px=0.5,
    max_scale_arcsec_px=15.0,
)
```

### Résultat (Solution)

```python
solution.ra             # RA centroïde (degrés J2000)
solution.dec            # DEC centroïde (degrés J2000)
solution.rotation_deg   # Rotation de l'image (degrés)
solution.flipped        # Image mirée (bool)
solution.scale_arcsec_px  # Échelle résolue (arcsec/pixel)
solution.matches        # Nombre d'étoiles matchées
solution.rms            # RMS du fit (arcsec)
solution.wcs            # Objet WCS (transformations pix ↔ world)

# Conversion pixel → coordonnées
ra, dec = solution.wcs.pixel_to_world(x, y)
```

### FITS WCS output

```python
fits_header = solution.to_fits_header()
# → dict avec CRPIX, CRVAL, CD, CDELT, PROJ, etc.
```

### Étoiles depuis tuples (autre détecteur)

```python
stars = [(x1, y1, flux1), (x2, y2, flux2), ...]
solution = seiza.solve(stars, catalog, w, h, ra=..., dec=..., scale_arcsec_px=...)
```

## Performance

- Le GIL est libéré pendant `detect()` et `solve()`
- Les catalogues sont memory-mapped (pas de chargement complet en RAM)
- Résolution typique : **fraction de seconde** pour hinted, **5-30s** pour blind
- SHA-256 vérifié au téléchargement des catalogues

## Catalogues disponibles

| Catalogue | Contenu | Usage |
|---|---|---|
| `stars-lite-tycho2.bin` | ~2500 étoiles Tycho-2 | Hinted solving (recommandé) |
| `stars-deep-gaia17.bin` | ~500k étoiles Gaia G≤16 | Hinted faint fields |
| `stars-deep-gaia20.bin` | ~5M étoiles Gaia G≤20 | Deep blind (9 GB) |
| `blind-gaia16.idx` | Index pattern whole-sky | Blind solving |
| `objects-lite.json` | DSO + étoiles nommées | Recherche objets |

## CLI

```bash
# Hinted solve
seiza solve image.fits --data data --scale 2.5 --ra 6.75 --dec -16.7

# Blind solve
seiza solve-blind image.jpg --data data --min-scale 0.5 --max-scale 15

# Recherche objet
seiza catalog object --data data "Andromeda Galaxy"

# Recherche cone
seiza catalog objects --data data --ra 10.68 --dec 41.27 --radius 3 --format json
```

## Worker (pour usage intensif)

```bash
# Démarrer un worker qui garde les catalogues ouverts
seiza worker --data data --index data

# Ou envoyer au serveur Seiza public
seiza worker --server http://solver-seiza.fyi:8080
```

## Intégration indigo_devices

### Pipeline dans solver.py

```python
import seiza
from astropy.io import fits as pyfits

class Solver:
    def __init__(self):
        self._catalog = None
        self._index = None

    def load_catalogs(self):
        paths = seiza.fetch_catalogs()
        self._catalog = seiza.StarCatalog.open(paths["stars-lite-tycho2.bin"])
        try:
            self._index = seiza.BlindIndex.open(paths["blind-gaia16.idx"])
        except Exception:
            pass  # Pas de blind index

    def solve_from_fits(self, fits_bytes, ra_hint=None, dec_hint=None, scale_hint=None):
        """Parse FITS → detect stars → solve → return solution dict."""
        # Parse FITS avec astropy ou seiza-fits
        img = parse_fits(fits_bytes)
        stars = seiza.detect(img)

        if ra_hint and dec_hint and scale_hint:
            solution = seiza.solve(stars, self._catalog, w, h,
                                   ra=ra_hint, dec=dec_hint,
                                   scale_arcsec_px=scale_hint)
        else:
            solution = seiza.solve_blind(stars, self._catalog, self._index, w, h,
                                         min_scale_arcsec_px=0.5,
                                         max_scale_arcsec_px=15.0)

        return {
            "ra": solution.ra,
            "dec": solution.dec,
            "rotation": solution.rotation_deg,
            "flipped": solution.flipped,
            "scale": solution.scale_arcsec_px,
            "matches": solution.matches,
            "rms": solution.rms,
            "wcs_header": solution.to_fits_header(),
        }
```

### Récupérer la position monture comme hint

```python
mount = registry.get_mount()
if mount and mount.ra_hours is not None:
    ra_hint = mount.ra_hours * 15  # heures → degrés
    dec_hint = mount.dec_deg
```

### Calculer l'échelle depuis la caméra

```python
camera = registry.get_camera()
if camera and camera.pixel_size_um and camera.focal_length_mm:
    scale = (camera.pixel_size_um / 1000) / (camera.focal_length_mm / 1000) * 206.265
    # scale en arcsec/pixel
```
