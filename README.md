# Noctua

Interface web (FastAPI + Vanilla JS) pour le contrôle d'équipements astronomiques via un serveur [INDIGO](https://www.indigo-astronomy.org/).

![App](https://img.shields.io/badge/python-3.10-blue) ![Tests](https://img.shields.io/badge/tests-134%20pytest-green)

Piloter monture, caméras, focuser et roue à filtres depuis le navigateur : autoguidage en étoile, autofocus HFR, calibration, séquences d'acquisition et mise au point polaire assistée.

## Captures d'écran

| Mode Monture | Mode Capture | Mode Autoguidage |
|:---:|:---:|:---:|
| ![Monture](docs/screenshots/mount.png) | ![Capture](docs/screenshots/capture.png) | ![Guidage](docs/screenshots/guiding.png) |

| Sky Map | Dashboard | Mise en station polaire |
|:---:|:---:|:---:|
| ![Sky Map](docs/screenshots/skymap.png) | ![Dashboard](docs/screenshots/dashboard.png) | ![Polaire](docs/screenshots/polar.png) |

> Pour prendre les screenshots : lancez le serveur avec le mock (`./start-mock-server.sh`), ouvrez l'interface, naviguez dans chaque onglet, et faites un screenshot du navigateur (Ctrl+Shift+S dans Firefox, ou F12 → screenshot node).

## Fonctionnalités

- **Périphériques INDIGO** via client XML/INDI natif (mount, CCD, guide CCD, focuser, roue à filtres, dôme), auto-reconnect
- **Panneau capteur / profils** : détection des appareils, profils persistants (YAML « profils »)
- **Autoguidage** : boucle de guidage orchestrée côté front (mesure centroïde), calibration, dérive RA/DEC en temps réel, RMS/SNR, crosshair, bips de tolérance
- **Autofocus** : scan V-courbe, **HFR** (half-flux radius) par mesure du FWHM gaussien, adaptation
- **Séquence d'acquisition** : plan éditable (type/durée/filtre/×/pause), pause/reprendre/stop/reset, dithering
- **Capture** : exposition, réduction **BZERO/BSCALE**, sauvegarde des FITS nommés `capture_{filtre}_{timestamp}.fits`
- **Sky map fluide** : orthographique canvas, projection des étoiles accélérée (vecteurs unitaires), catalogue **41 411 étoiles** (mag ≤ 8), recherche d'objets (NGC/IC/Sharpless + noms multilingues)
- **Temps de pose idéal** : pose(s) test (bouton « Mesurer le ciel », 1 ou 3 prises) → mesure du fond de ciel en ADU/s, extrapolation vers un fond cible, fit linéaire bias-indépendant (3 prises) avec détection de saturation, garde anti-saturation des étoiles, SNR projeté
- **Mise en station polaire** : calcul LST + assistant 3 étapes
- **Orientation** : bascule au méridien (flip) gérée par la monture

## Stack

- **Backend** : Python 3.10+, FastAPI, uvicorn, PyYAML
- **Frontend** : JS vanilla (scripts classiques, pas de build step), Canvas, CSS glassmorphisme
- **Protocole** : INDIGO/INDI XML via TCP (le client parlé INDI au serveur ; le navigateur rejoint le serveur web via WebSocket pour l'état temps réel)

## Démarrage

```bash
# D'un terminal, côté serveur INDIGO réel ou simulateurs :
indigo_server -p 7624 indigo_mount_simulator indigo_ccd_simulator ...

# Côté client :
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./start.sh                    # lit config.yaml (INDIGO + web)
./start.sh 192.168.1.100:7624 # surcharge l'adresse du serveur
./start.sh --port 8080        # surcharge le port web
```

Puis ouvrir **http://<host>:8080** dans le navigateur.

> ⚠️ **Note** : Le projet utilise `.venv` comme environnement unique. Les scripts `start.sh` et `start-mock-server.sh` le pointent tous deux vers `.venv/bin/python`. Si vous avez créé d'anciennes venvs (`venv`, `venv_new`, `venv_temp`), elles sont ignorées. Supprimez-les avec `rm -rf venv venv_new venv_temp` pour éviter toute confusion.

## Configuration

`config.yaml` :
- `indigo` : adresse `host:port` du serveur INDIGO et protocole (`connect`)
- `web` : hôte/port d'écoute (défaut `0.0.0.0:8080`)
- `site` : nom du site, coordonnées, fuseau (utilisés pour la distance LST et le flip méridien)
- `telescope` : flip méridien, marge d'angle horaire, altitude min, taux de slew recherche
- `sequence` : répertoire de sauvegarde des FITS, dither `{enabled, amount}`, plan par défaut
  - `exposure` : pose idéale — `target_bg` (fond cible en ADU au-dessus du biais), `shots` (1 ou 3 prises de test), `test_min`/`test_mid`/`test_max` (durées de test), `min_exposure`/`max_exposure` (bornes), `saturation_frac` (seuil de saturation des étoiles)

`profiles.yaml` : stocke les profils de matériel (monture/caméra/caméra guide/focuser/roue). Chemin surchargeable par `INDIGO_PROFILES_PATH`.

> **Attention** : par défaut l'interface se bind sur `0.0.0.0`. **Ne pas exposer sur Internet** — réservez à un LAN local ou derrière authentification (état : authentification encore absente).

## Test à blanc

Un test bout-en-bout automatisé contre le vrai serveur `indigo_server` (drivers simulateurs) :

```bash
python tests/test_blanc_indigo.py            # ports par défaut 17660/18110
python tests/test_blanc_indigo.py --port 17660 --web-port 18110
```

Vérifie : connexion + détection, application de profil, monture (unpark/goto/tracking/park), roue (WHEEL_SLOT natif), focuser (noms natifs + relatif), capture→FITS (vérifie BZERO/BSCALE), séquence (pause/resume/stop/reset/dither), guidage (référence + dérive).

Suites unitaires / flux :

```bash
python -m pytest tests/ -q
python tests/test_exposure.py   # temps de pose idéal (fond de ciel, saturation)
python tests/test_guide_flow.py
python tests/test_sequence_flow.py
npx playwright test   # tests UI (voir tests/)
```

## Structure

```
config.yaml          # configuration (INDIGO, web, séquence, flip)
ui.yaml, profiles.yaml # état runtime (positions panneaux, profils) — gitignorés
run.py               # point d'entrée serveur (INDIGO client + web)
indigo/
  client.py          # client TCP XML INDIGO
  registry.py        # découverte + auto-connexion
  devices/           # mount, camera, focuser, filterwheel, guide, autofocus, sequence, live_stack, solver
  profiles.py        # persistance profils YAML
web/
  server.py          # API FastAPI (REST + WS) — câblage
  routers/           # routes REST par domaine (register(app, server))
  static/            # UI (index.html, i18n.{fr,en}.js, ws.js, panneaux *.js, style.css)
tests/               # unit + flow + à-blanc + specs Playwright
docs/screenshots/    # captures d'écran pour le README
PLAN.md, CHECKPOINT.md, TODO_LIST.md, TESTS.md
```

## Licence

Projet personnel — code source sous licence open-source MIT (à définir).

## Avertissement

- Le contrôle de matériel astronomique réel présente des risques : utilisez à vos risques et périls, toujours en couvrant votre équipement, et testez d'abord avec les simulateurs.
- L'application suppose que le serveur INDIGO et la caméra sont sur le même LAN.