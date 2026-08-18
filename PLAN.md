# Noctua — Plan du projet

## Objectif
Contrôler des périphériques INDIGO (monture, caméra, focuser, roue à filtres) via une interface web minimaliste.

## Architecture
```
[INDIGO Server — indigo_server (réel 192.168.1.25:7624 ou simulateurs)]
        ↕ TCP/XML (INDI legacy)
[Python indigo_devices]
  indigo/    → client, registry, devices
  web/       → FastAPI (REST + WebSocket)
        ↕ HTTP/WS
[Browser — vanilla JS]
```

## Stack
- **Backend** : Python 3.10, FastAPI, uvicorn, WebSocket, PyYAML
- **Frontend** : Vanilla JS (ES modules), HTML5 Canvas, CSS glassmorphisme
- **Protocole** : INDIGO/INDI XML over TCP (pas WebSocket côté serveur)
- **Dépendances Python** : fastapi, uvicorn, pyyaml, Pillow

## Modules Python

| Fichier | Rôle |
|---|---|
| `indigo/protocol.py` | Parseur XML INDIGO + builders (switch/number/text) |
| `indigo/client.py` | Client TCP asynchrone, auto-reconnect, probe_loop |
| `indigo/registry.py` | Découverte des devices, auto-connect, upgrade type |
| `indigo/profiles.py` | Persistance des profils matériel (YAML) |
| `indigo/devices/base.py` | BaseDevice + GenericDevice, sérialisation propriétés |
| `indigo/devices/mount.py` | Monture — résolution noms INDIGO↔INDI, commands, flip méridien |
| `indigo/devices/camera.py` | Caméra CCD — expose(), abort(), is_ready, BLOB handling |
| `indigo/devices/focuser.py` | Focuser |
| `indigo/devices/filterwheel.py` | Roue à filtres |
| `indigo/devices/guide.py` | Caméra guide + boucle de guidage orchestrée |
| `indigo/devices/autofocus.py` | Autofocus (scan V-courbe) |
| `indigo/devices/sequence.py` | Ordonnanceur de séquences (pause/resume/stop/reset, dither) |
| `indigo/devices/live_stack.py` | Empilement temps réel |
| `indigo/devices/exposure.py` | Temps de pose idéal : pose(s) test → extrapolation du fond de ciel (ADU/s), mode 1 prise (bias=BZERO) et 3 prises (fit linéaire bias-indépendant + détection de saturation), garde anti-saturation |
| `indigo/devices/solver.py` | Solveur astrométrique |
| `indigo/devices/focus_metrics.py` | Métriques de focus (HFR/FWHM) |
| `indigo/devices/guide_calibration.py` | Calibration du guidage |
| `indigo/devices/meridian.py` | Calculs méridien / flip |
| `web/server.py` | Câblage FastAPI : registres, solver, séquence, stacking, broadcast WS, statiques |
| `web/routers/*.py` | Routes REST découpées par domaine (chacune expose `register(app, server)`) |
| `web/weblog.py` | Handler Python → WebSocket (logs temps réel) |
| `web/sky_chart.py` | **Obsolète** — gardé comme archive (ancien renderer starplot) |

## Modules Frontend

| Fichier | Rôle |
|---|---|
| `web/static/index.html` | Layout split, barre de modes, panneaux |
| `web/static/i18n.fr.js` / `i18n.en.js` / `i18n.js` | Dictionnaires FR/EN + moteur i18n |
| `web/static/ws.js` | Client WebSocket + dispatch `Bus` |
| `web/static/events.js` | Bus d'événements (pub/sub entre panneaux) |
| `web/static/state.js` / `api.js` | État partagé + accès API |
| `web/static/sky-engine.js` | Renderer ciel canvas (batch étoiles, catalogues en cache) |
| `web/static/*.js` (par panneau) | hardware, mount, camera/capture, focuser, guide, polar, sequence, stacking, session, target, objects, solver, preview, viewer, calibration, controls, layout, utils |

## Endpoints API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/devices` | Tous les devices avec état |
| GET | `/api/hardware` | État panneau matériel |
| POST | `/api/hardware/connect`, `/connect-all`, `/disconnect` | Connexion / déconnexion |
| GET/POST | `/api/profiles` | Profils matériel (list/apply/delete) |
| GET | `/api/mount` | État monture |
| GET | `/api/mount/flip/status` | État flip méridien (due, HA, marge) |
| POST | `/api/mount/slew`, `/move`, `/halt`, `/abort`, `/tracking`, `/park`, `/unpark` | Pilotage monture |
| GET | `/api/camera` | État caméra (inclut `is_ready`) |
| POST | `/api/camera/expose`, `/abort`, `/temperature`, `/save` | Capture + température |
| GET | `/api/camera/exposure/recommend` | Pose idéale depuis la dernière image (fond de ciel mesuré) |
| POST | `/api/camera/exposure/estimate` | Pose(s) test → recommande le temps de pose : `shots` 1|3, `test_min/mid/max` (fond cible, anti-saturation) |
| GET | `/api/filterwheel` | État roue |
| POST | `/api/filterwheel/slot` | Changer de slot |
| GET | `/api/focuser` | État focuser |
| POST | `/api/focuser/move`, `/move_relative`, `/halt`, `/speed` | Pilotage focuser |
| GET/POST | `/api/focuser/autofocus/status`, `/start`, `/stop`, `/step`, `/finish`, `/reset` | Autofocus |
| GET | `/api/focuser/focus-metric` | HFR/FWHM |
| GET/POST | `/api/guide/status`, `/start`, `/stop`, `/step`, `/set-reference`, `/pause`, `/resume`, `/reset` | Boucle de guidage |
| GET/POST | `/api/guide/calibrate/*` | Calibration du guidage |
| GET | `/api/sequence/status`, `/api/sequence/defaults` | Statut + défauts séquence |
| POST | `/api/sequence/start`, `/stop`, `/pause`, `/resume`, `/reset` | Contrôle séquence |
| GET | `/api/stacking/status`, `/api/stacking/snapshot` | Statut stacking |
| POST | `/api/stacking/start`, `/stop`, `/reset`, `/save`, `/configure`, `/masters` | Empilement |
| GET | `/api/solver/status` | Statut solveur |
| POST | `/api/solver/solve`, `/api/solver/catalogs` | Résolution astrométrique |
| GET/POST | `/api/config` | Configuration complète |
| GET/POST | `/api/ui` | Positions de panneaux / état UI persisté |
| GET | `/api/site`, `/api/site/cities` | Site d'observation + recherche villes |
| GET | `/api/connection`, POST `/api/connection` | État et changement host/port/protocol |
| GET | `/api/drivers`, POST `/api/drivers/attach` | Drivers INDIGO |
| POST | `/api/property` | Setter générique (switch/number/text) |
| GET | `/ws` | WebSocket : état temps réel, logs, images, stacking, séquence |

## Poussées WebSocket (type)

- `state` — état des devices (diffusion à intervalle)
- `log` — lignes de log serveur temps réel
- `image` — BLOB caméra encodé
- `solver_result` — résultat de résolution
- `stacking` — statut d'empilement (plus de polling front)
- `sequence` — statut de séquence (plus de polling front)

## Données catalogue

| Fichier | Contenu | Taille |
|---|---|---|
| `public/catalogs/bsc5.json` | 9096 étoiles (BSC5) | 2.6 MB |
| `public/catalogs/constellations.lines.json` | 743 segments constellation | 92 KB |
| `public/catalogs/messier.json` | 110 objets Messier | 39 KB |
| `public/catalogs/ngc_ic.json` | 32 objets NGC/Caldwell | 10 KB |
| `public/catalogs/stars.json` | Étoiles supplémentaires | 18 KB |

## Protocole INDIGO/INDI

- Le serveur parle **INDI legacy** (noms `EQUATORIAL_EOD_COORD`, `TELESCOPE_MOTION_NS`, etc.)
- La classe Mount utilise `PROP_ALIASES` + `_resolve_prop_name()` pour mapper INDIGO v2.0 → INDI legacy
- Le client envoie `getProperties` au démarrage, le serveur répond par des `def*` puis des `set*`
- Les floats NaN/Inf sont assainis pour le JSON

## Tests

| Suite | Commande | État |
|---|---|---|
| Unitaires pytest | `python -m pytest tests/ -q` | 117/117 |
| Flow guide | `python tests/test_guide_flow.py` | vert |
| Flow séquence | `python tests/test_sequence_flow.py` | 27/27 |
| Flow live-stack | `python tests/test_live_stack_flow.py` | 65/65 |
| Flow autofocus | `python tests/test_autofocus_flow.py` | vert |
| Flow focus | `python tests/test_focus_flow.py` | vert |
| Flow hardware | `python tests/test_hardware_flow.py` | 45/45 |
| UI Playwright | `npx playwright test` | 42/42 |
| À blanc simulateurs | `python tests/test_blanc_indigo.py` | voir TODO 6 |

## Démarrage
```bash
./start.sh                    # Relance le serveur (tue le précédent)
# ou
source venv/bin/activate && python3 run.py
```

## Serveur INDIGO
- `./start-mock-server.sh` pour le serveur mock (dev)
- INDIGO réel : `192.168.1.25:7624`
- Serveur web : `http://0.0.0.0:8080`
