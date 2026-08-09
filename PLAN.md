# Noctua — Plan du projet

## Objectif
Contrôler des périphériques INDIGO (monture, caméra, focuser) via une interface web minimaliste.

## Architecture
```
[INDIGO Server 192.168.1.25:7624]
        ↕ TCP/XML (INDI legacy)
[Python indigo_devices] ←→ [FastAPI + WebSocket]
        ↕ HTTP/WS
[Browser — vanilla JS]
```

## Stack
- **Backend** : Python 3.10, FastAPI, uvicorn, WebSocket
- **Frontend** : Vanilla JS (ES modules), HTML5 Canvas, CSS
- **Protocole** : INDIGO/INDI XML over TCP (pas WebSocket côté serveur)
- **Dépendances Python** : fastapi, uvicorn, pyyaml, Pillow (supprimé starplot)

## Modules Python

| Fichier | Rôle |
|---|---|
| `indigo/protocol.py` | Parseur XML INDIGO + builders (switch/number/text) |
| `indigo/client.py` | Client TCP asynchrone, auto-reconnect, probe_loop |
| `indigo/registry.py` | Découverte des devices, auto-connect, upgrade type |
| `indigo/devices/base.py` | BaseDevice + GenericDevice, sérialisation propriétés |
| `indigo/devices/mount.py` | Monture — résolution noms INDIGO↔INDI, commands |
| `indigo/devices/camera.py` | Caméra CCD — expose(), abort(), is_ready, BLOB handling |
| `indigo/devices/focuser.py` | Focuser |
| `web/server.py` | FastAPI REST/WS, static files, endpoints monture/site |
| `web/weblog.py` | Handler Python → WebSocket (logs temps réel) |
| `web/cities.py` | 122 villes mondiales + recherche fuzzy |
| `web/sky_chart.py` | **Obsolète** — gardé comme archive (ancien renderer starplot) |

## Modules Frontend

| Fichier | Rôle |
|---|---|
| `web/static/index.html` | Layout split (gauche contrôles / droite carte), site popup, context menu |
| `web/static/app.js` | WS client, panneau monture, propriétés interactives, site config |
| `web/static/sky-canvas.js` | Canvas stéréographique pur client-side (horizon, compass, context menu) |
| `web/static/style.css` | Dark theme, split layout, monture, carte, popups |

## Endpoints API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/devices` | Tous les devices avec état |
| GET | `/api/mount` | État monture |
| POST | `/api/mount/slew` | GOTO (ra_hours, dec_deg) |
| POST | `/api/mount/move` | Mouvement manuel (direction, rate) |
| POST | `/api/mount/halt` | Arrêt mouvement |
| POST | `/api/mount/abort` | Abort |
| POST | `/api/mount/tracking` | Tracking on/off |
| POST | `/api/mount/park` | Park |
| POST | `/api/mount/unpark` | Unpark |
| GET | `/api/camera` | État caméra (inclut `is_ready`) |
| POST | `/api/camera/expose` | Lancer exposition (duration, frame_type) — vérifie `is_ready` |
| POST | `/api/camera/abort` | Stopper exposition |
| POST | `/api/camera/temperature` | Régler température CCD |
| GET | `/api/focuser` | État focuser |
| POST | `/api/focuser/move` | Déplacer focuser (position) |
| POST | `/api/focuser/halt` | Stopper focuser |
| POST | `/api/property` | Setter générique (switch/number/text) |
| GET | `/api/site` | Lire site d'observation (config.yaml) |
| POST | `/api/site` | Sauvegarder site d'observation |
| GET | `/api/site/cities?q=` | Recherche fuzzy de villes (122 villes) |
| GET | `/api/config` | Configuration complète |
| GET | `/api/drivers` | Liste des drivers INDIGO disponibles |
| POST | `/api/drivers/attach` | Attacher (charger) un driver sur le serveur |
| GET | `/api/connection` | État connexion INDIGO |
| POST | `/api/connection` | Changer host/port/protocol et reconnexion |
| GET | `/ws` | WebSocket état temps réel + logs |

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
