# AGENTS.md — Guide pour agents IA

## 1. Vue d'ensemble

**Noctua** (`indigo_devices`) : interface web (FastAPI + Vanilla JS) pour contrôler des équipements astronomiques via un serveur [INDIGO](https://www.indigo-astronomy.org/).

- **Backend Python** : client INDIGO natif (XML/INDI sur TCP, port 7624) + FastAPI/uvicorn + WebSocket temps réel vers le navigateur.
- **Frontend Vanilla JS** : pas de framework, pas de build step. La majorité des scripts sont des scripts classiques chargés dans l'ordre dans `index.html`. Exceptions : la couche "sky map" (`app.js`, `sky-engine.js`, `sky-projection.js`) est constituée de vrais modules ES (`import`/`export`), chargés via `<script type="module" src="/app.js">`. Ces modules communiquent avec les scripts classiques via des globales exposées sur `window` (ex. `window.setOffsetTarget` défini par `preview.js`, appelé optionnellement dans `sky-engine.js`).
- **Fonctionnalités** : monture, caméras, focuser, roue à filtres, autoguidage, dithering piloté par le guide (shift de référence + settle), autofocus HFR (+ refocus automatique temps/altitude côté serveur), calibration, séquences d'acquisition, stacking live, mise en station polaire, sky map D3, résolution d'astrométrie.
- Python 3.10+, dépendances : `fastapi`, `uvicorn`, `PyYAML`, `Pillow`, `seiza`, `numpy`.

## 2. Structure des répertoires

```
run.py                  # Point d'entrée : client INDIGO + serveur web (argparse : host:port, --port)
install.sh              # Installation : crée .venv, installe les dépendances, copie config.example.yaml
indigo/
  client.py             # IndigoClient : TCP XML/INDI, auto-reconnect (RECONNECT_DELAY=3.0, MAX_RECONNECT=10)
  protocol.py           # PropertyVector, parse_xml_message, build_* (construction/parsing XML)
  registry.py           # DeviceRegistry : découverte d'appareils, auto-connect, dispatch des events
  profiles.py           # ProfileStore : persistance YAML des profils
  plate_solve.py        # Résolution d'astrométrie (backend)
  devices/
    base.py             # BaseDevice (à étendre), GenericDevice ; _sanitize NaN/Inf
    mount.py camera.py focuser.py filterwheel.py guide.py
    guide_calibration.py autofocus.py exposure.py focus_metrics.py
    meridian.py         # Détection/anticipation du flip méridien (marge, anti-re-flip)
    sequence.py live_stack.py solver.py triggers.py   # Trigger Manager (Lot A2) ; séquences cible/date + reprise (Lot C2)
    templates.py        # Séquence templates nommés YAML (Lot C3) ; export/import JSON
    fitsmeta.py         # Métadonnées FITS normalisées (Lot C4) : read_header/inject_meta/frame_meta (réécriture binaire sans astropy)
    masters.py          # Bibliothèque de masters bias/dark/flat (Lot C1) : scan/build/resolve/delete + headers normalisés
    refocus.py          # Refocus auto temps/altitude (Lot B3), V-curve serveur
    flat_wizard.py      # Machine à états du Flat Wizard (série de flat, ADU cible, AUTO)
    pointing.py         # Modèle d'erreur de pointage (fit paramétrique + résidu IDW)
web/
  server.py             # WebServer : câblage FastAPI, broadcast WebSocket ; init MasterLibrary + injection FITS livestack (C4)
  astrometry.py cities.py weblog.py
  routers/              # 1 module = 1 domaine, chacun expose register(app, server)
    camera.py mount.py focuser.py guide.py hardware.py
    sequence.py stacking.py config.py common.py ws_test.py
    pointing.py visibility.py triggers.py masters.py   # /api/masters (Lot C1) + /api/camera/save normalisé (C4)
  static/               # index.html + JS (scripts classiques), CSS, assets
    hub.js              # Médiateur inter-panneaux (pub/sub + état partagé + request/respond) — SUCCÈDE à events.js (supprimé)
    api.js              # addLog() journal + consommateurs Hub (ws:log, ws:image)
    ...                 # panneaux : mount, capture, sequence, guide, solver, target, calibration, preview, ...
tests/
  test_*.py             # pytest unitaires/intégration (265 tests)
  test_*_flow.py        # tests de flux : LANCÉS DIRECTEMENT (pas par pytest)
  test_*_*.js           # tests unitaires node lancés directement (ex. test_hub.js, test_polar_math.js)
  *.spec.js             # specs Playwright (UI)
  mock_indigo.py        # serveur INDIGO mock (port 17624)
  test_blanc_indigo.py  # test E2E complet
  polar_math.js         # maths polaires testées par node
config.example.yaml     # modèle de config (copier vers config.yaml)
```

## 3. Commandes build / test

Un seul venv est présent : `.venv` (dépendances OK). **`start.sh` préfère `.venv`**, sinon `venv`.

| Tâche | Commande |
|-------|----------|
| Lancer le serveur | `./start.sh` ou `python run.py [indigo_host:port] [--port 8080]` |
| Lancer le mock INDIGO | `./start-mock-server.sh` (mock INDIGO, port 17624) |
| Tests pytest | `.venv/bin/python -m pytest tests/ -q` (265 tests, ~78 s) |
| Tests flux (directement) | `python tests/test_exposure.py`, `python tests/test_guide_flow.py`, `python tests/test_sequence_flow.py` (75 checks) |
| Tests unitaires JS | `node tests/test_hub.js` (39 tests), `node tests/test_polar_math.js` |
| Tests UI (Playwright) | `npx playwright test` (specs `tests/*.spec.js`) |
| Test E2E complet | `python tests/test_blanc_indigo.py` (lançouter `indigo_server` simulateurs) |
| Vérifier syntaxe JS | `for f in web/static/*.js; do node --check "$f"; done` |

## 4. Hub inter-panneaux (hub.js)

`events.js` (bus legacy) a été **supprimé** : tous les flux de communication passent par `Hub`.

- API : `subscribe(topic, source, fn)` / `emit(topic, payload, {source})` / `setState` / `getState` / `watchState` / `request(topic, payload, {timeoutMs})` / `respond(env, value)` / `topics([topic])`.
- Topics enveloppe `{ id, ts, topic, source, targets, kind, reqId, payload }` ; un handler qui lève n'empêche jamais la diffusion aux autres abonnés.
- **Traces `[Hub]`** : ligne `[Hub] source.emit(topic) → targets` visible dans le panneau Log **niveau `debug`** — activer `Hub.debug = true` (console) et le filtre `debug` du panneau Log pour les voir.
- Consommateurs principaux : `ws.js` (traducteur WS → topics Hub), `hardware.js` (`ws:state` + `device:connected` débouncing 1200 ms), `capture.js`/`stacking.js` (`capture:progress`, `stacking:update`), `sequence.js` (`sequence:update`), `solver.js`/`target.js` (`solver:result`), `mount.js` (`mount:slewed`), `app.js` (`mode:changed`, `calibration:done`).