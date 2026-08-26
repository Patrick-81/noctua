# AGENTS.md — Guide pour agents IA

## 1. Vue d'ensemble

**Noctua** (`indigo_devices`) : interface web (FastAPI + Vanilla JS) pour contrôler des équipements astronomiques via un serveur [INDIGO](https://www.indigo-astronomy.org/).

- **Backend Python** : client INDIGO natif (XML/INDI sur TCP, port 7624) + FastAPI/uvicorn + WebSocket temps réel vers le navigateur.
- **Frontend Vanilla JS** : pas de framework, pas de build step. Scripts classiques (pas de modules ES malgré le README) chargés dans l'ordre dans `index.html`.
- **Fonctionnalités** : monture, caméras, focuser, roue à filtres, autoguidage, autofocus HFR, calibration, séquences d'acquisition, stacking live, mise en station polaire, sky map D3, résolution d''astrométrie.
- Python 3.10+, dépendances : `fastapi`, `uvicorn`, `PyYAML`, `Pillow`, `seiza`, `numpy`.

## 2. Structure des répertoires

```
run.py                  # Point d'entrée : client INDIGO + serveur web (argparse : host:port, --port)
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
    meridian.py sequence.py live_stack.py solver.py
web/
  server.py             # WebServer : câblage FastAPI, broadcast WebSocket
  astrometry.py cities.py weblog.py
  routers/              # 1 module = 1 domaine, chacun expose register(app, server)
    camera.py mount.py focuser.py guide.py hardware.py
    sequence.py stacking.py config.py common.py ws_test.py
  static/               # index.html + JS (scripts classiques), CSS, assets
tests/
  test_*.py             # pytest unitaires/intégration (146 tests)
  test_*_flow.py        # tests de flux : LANCÉS DIRECTEMENT (pas par pytest)
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
| Lancer le mock INDIGO | `./start-m