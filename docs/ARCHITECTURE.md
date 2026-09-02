---
nav_exclude: true
---

# Noctua — Architecture (vue développeur)

*English version: [ARCHITECTURE_EN.md](ARCHITECTURE_EN.md)*

Noctua est une **interface web** (FastAPI + Vanilla JS, sans build step) pilotant des équipements astronomiques
via un serveur [INDIGO](https://www.indigo-astronomy.org/) (protocole INDI/XML sur TCP, port 7624).

Deux « mondes » :

1. **Backend Python** : un client INDIGO natif (TCP), une couche d'appareils (`indigo/devices`), et un serveur
   HTTP/WebSocket Express (FastAPI) qui expose états et commandes au navigateur.
2. **Frontend** : scripts classiques chargés dans l'ordre par `index.html` + une couche "sky map" en vrais
   modules ES (`app.js`, `sky-engine.js`, `sky-projection.js`). Tous les flux inter-panneaux passent par
   **`hub.js`** (bus pub/sub + état partagé).

```
┌───────────────┐   HTTP REST + WS   ┌───────────────────────┐   TCP/INDI(XML)   ┌────────────────┐
│   navigateur  │ ◄────────────────► │  WebServer (FastAPI)  │ ◄───────────────► │  indigo_server  │
│  hub.js + ▸◂  │                    │  routers/* + server.py│                   │  (port 7624)    │
└───────────────┘                    └──────────┬────────────┘                   └────────────────┘
                                                │
                                    indigo/ (DeviceRegistry, devices/*)
```

---

## 1. Arborescence

```
run.py                 # point d'entrée : charge config → IndigoClient + DeviceRegistry + WebServer
indigo/
  client.py            # IndigoClient : TCP XML, auto-reconnect (RECONNECT_DELAY=3.0, MAX_RECONNECT=10)
  protocol.py          # PropertyVector, parse_xml_message, build_* (XML INDIGO)
  registry.py          # DeviceRegistry : découverte, auto-connexion, dispatch des def/set
   profiles.py          # ProfileStore : profils YAML (fields mount_interface/mount_endpoint)
  plate_solve.py       # solveur astrométrique backend (Seiza)
  devices/             # logique pure (pas de dépendance HTTP)
    base.py            # BaseDevice (à étendre), GenericDevice ; _sanitize NaN/Inf
    mount.py camera.py focuser.py filterwheel.py guide.py
    guide_calibration.py   # état calibration monture (expos courtes, étoile perdue → relance)
    autofocus.py           # ACurve/refocus : scan V-courbe HFR, run_autofocus
    focus_metrics.py       # HFR/FWHM d'une étoile, qualité gaussienne
    exposure.py            # estimation des poses (ADU/s, fit 3 prises)
    meridian.py            # LST, angle horaire, anticipation flip (marge, anti-re-flip)
    live_stack.py          # LiveStackEngine (alignement, rejet, calibration, master)
    sequence.py            # SequenceRunner (plan, pause/reprise/stop, journal) + helpers fichiers
    solver.py              # Solver (Seiza) : solve_image (indice/blind), WCS
    triggers.py            # TriggerManager : événements → actions (log/script/goto)
    templates.py           # SequenceTemplateStore : templates YAML nommés (C3)
    fitsmeta.py            # entêtes FITS normalisés : read_header/inject_meta/frame_meta (binaire, sans astropy)
    masters.py             # MasterLibrary (C1) : scan/build/resolve/delete
    refocus.py             # RefocusPolicy (temps/altitude) + V-curve serveur (B3)
    flat_wizard.py         # FlatWizard : machine à états (ADU cible, AUTO)
    pointing.py            # PointingModel : échantillons, fit paramétrique + correction IDW
    mosaic.py              # plan_mosaic / camera_fov / expand_frames (D1, pur)
web/
  server.py            # WebServer : câblage FastAPI, WS broadcast, MasterLibrary, PointingModel,
                       # refocus_policy, _recenter_by_solve, sauvegarde FITS + injection d'entête (C4)
  routers/             # register(app, server) par domaine
  static/              # UI : index.html, hub.js, ws.js, api.js, i18n.{fr,en}.js, panneaux *.js, style.css
tests/                 # pytest + flows lancés directement + tests node + specs Playwright
docs/                  # UTILISATION.md, CONFIGURATION.md, ARCHITECTURE.md, screenshots
```

## 2. Backend — client et appareils

### 2.1 Connexion (`indigo/client.py`, `protocol.py`, `registry.py`)

- `IndigoClient(indigo_host_port, protocol)` : socket TCP, trame XML « INDIGO » (`<def>`, `<set>`, `<getProperties>`).
  Reconnexion automatique (`RECONNECT_DELAY`, `MAX_RECONNECT`).
- `protocol.py` : `PropertyVector` (normalisation des vecteurs de propriétés), `parse_xml_message`,
  `build_*` (construction des requêtes XML).
- `DeviceRegistry` : maintient les appareils découverts, applique l'auto-connexion, et **dispatche** chaque `def`/`set`
  vers le `BaseDevice` concerné (méthodes `_apply_def` / `_apply_set`).

### 2.2 Couche appareils (`indigo/devices/`)

Chaque device étend `BaseDevice` et expose un `state_dict()` (état temps réel) + des méthodes de commande.
Points clés :

- `_sanitize` (base.py) neutralise `NaN`/`Inf` avant toute sérialisation.
- **Noms** : `mount.py`, `camera.py`, etc. résolvent les **noms natifs INDIGO** (`MOUNT_EQUATORIAL_COORDINATES`,
  `CCD_EXPOSURE`…) et gèrent les variantes (résolution par alias, cf. `_resolve_prop_name`/`_resolve_item_name`).
- **Guidage** : la calibration et la boucle de guidage sont orchestrées **côté front** (mesure centroïde, impulsions),
  mais le **dithering et le settle** sont appliqués **côté serveur** depuis la séquence (`indigo/devices/guide.py`
  `apply_dither` : décalage de référence + attente de stabilisation `settle_rms`/`settle_stable`/`settle_timeout`).

### 2.3 Logique métier (modules purs, testables sans INDIGO)

| Module | Responsabilité |
|--------|----------------|
| `mosaic.py` (D1) | `camera_fov()` (FOV = `largeur_px·pixel_µm/1000`/focale, indépendant du binning), `plan_mosaic()` (grille N×M : `cols = ceil(span_x/pas_x)`, `pas = fov·(1−overlap)`, correction RA `step_w/cos(dec)` clampée `MIN_COS_DEC=0.15`, wrap `%360`, `MAX_OVERLAP=0.90`), `expand_frames()` (expansion du plan en poses par tuile : clés `tile`, `goto_ra_hours`, `goto_dec_deg`, `tiles_total`) |
| `fitsmeta.py` (C4) | Entête FITS normalisé sans astropy : `frame_meta()` (KEYWORDS standards), `inject_meta()` (réécriture binaire des cartes 80 octets, DONNÉES bit-identiques ; vocabulaire ≤ 8 caractères, accents translittérés), `read_header()` |
| `masters.py` (C1) | `MasterLibrary` : `scan()` (catalogue `<root>/masters/<type>/…` d'après les entêtes), `build()` (médiane d'une série de raws), `resolve()`/`resolve_all()` (meilleur master par filtre/binning/température avec dégradations), `delete()` |
| `refocus.py` (B3) | `RefocusPolicy` : `should_refocus(now, alt)` sur intervalle de temps et/ou Δ d'altitude ; `run_autofocus` V-courbe **entièrement côté serveur** ; `mark_refocused` rafraîchit la ligne de base |
| `triggers.py` (A2) | `TriggerManager` : évaluation des conditions sur événements, dispatch des actions (`log`, `script`, `mount_goto`), best effort |
| `templates.py` (C3) | `SequenceTemplateStore` : persistance YAML nommée, import/export JSON |
| `exposure.py` | Estimation de la pose idéale (ADU/s, fit linéaire 3 prises, garde anti-saturation) |
| `flat_wizard.py` | Machine à états (ADU cible, tolérance, durée conseillée, convergence AUTO) |
| `pointing.py` | `PointingModel` : échantillons RA/Dec, `fit()` (paramétrique), `correct()` (fit + résidu interpolé IDW), alimenté par `record-solve` |
| `meridian.py` | LST, angle horaire, `flip_due`, anti-re-flip, visibilité sur 24 h |
| `sequence.py` | `SequenceRunner` (plan, pause/reprise/stop/reset, statut `{done,total,...}`), `build_path` (rangement cible/date, index continus), `save_journal`/`load_journal` (reprise) |
| `live_stack.py` | `LiveStackEngine` : empilement aligné (Seiza), rejet des images décalées/pauvres, calibration masters, master FITS/PNG |

## 3. Serveur web (`web/server.py` + `routers/`)

### 3.1 `WebServer`

- Construit/rattache : `DeviceRegistry`, `Solver`, `LiveStackEngine`, **`MasterLibrary`** (racine `masters.dir` ou
  `sequence.save_dir`), **`PointingModel`**, **`RefocusPolicy`**, **`FlatWizard`**, `GuideCalibration`, `SequenceRunner`,
  templates — tous initialisés par modules (*lazy imports* dans `web/server.py`).
- `_recenter_by_solve(ra_deg, dec_deg)` : pose courte, résolution Seiza (`scale_hint` requis = focale connue, sinon
  retour rapide), corrige la position avec échantillon pour le modèle de pointage. Utilisé pour le **recentrage
  post-flip** et le **déplacement des tuiles mosaïque**.
- Sauvegarde des FITS de séquence : `fitsmeta.frame_meta(...)` + `inject_meta` → données bit-identiques, entête
  normalisé (C4).
- Broker : boucle asyncio → broadcast WebSocket des états (`state`, `log`, `image`, `stacking`…).

### 3.2 Routage REST

Chaque `web/routers/<domaine>.py` expose `register(app, server)` et utilise `common.SanitizedJSONResponse`
(neutralise NaN/Inf). Résumé des familles d'endpoints :

| Fichier | Endpoints (extrait) |
|---------|---------------------|
| `hardware.py` | `/api/devices`, `/api/drivers[/attach]`, `/api/device/connect`, `/api/hardware/{connect,disconnect,connect-all,disconnect-all}`, `/api/profiles{/activate,/delete,/apply}`, `/api/filterwheel{,/slot}`, `/api/property` |
| `camera.py` | `/api/camera`, `/api/cameras`, `/api/camera/expose`, `/api/camera/abort`, `/api/camera/save` (normalisé C4), `/api/camera/temperature`, `/api/camera/exposure/recommend`, `/api/camera/exposure/estimate`, `/api/camera/flat-wizard/{status,configure,step,reset}`, `/api/solver/{status,catalogs,solve}` |
| `mount.py` | `/api/connection`, `/api/mount{,/flip/status,/slew,/abort,/park,/unpark,/home,/tracking,/move,/halt,/flip}` |
| `focuser.py` | `/api/focuser{,/move,/halt,/move_relative,/speed}`, `/api/focuser/focus-metric`, `/api/focuser/autofocus/{status,start,step,finish,stop,reset}` |
| `guide.py` | `/api/guide/{status,start,step,set-reference,pause,resume,stop,reset}`, `/api/guide/calibrate/{status,start,set-origin,step,stop,finish,reset}` |
| `sequence.py` | `/api/sequence/{status,defaults,start,stop,pause,resume,reset,resume-session}`, `/api/sequence/templates{/delete,/export,/import}` |
| `mosaic.py` (D1) | `/api/mosaic/fov` (FOV réel de l'instrument ; `ok:false` sans focale), `/api/mosaic/plan` (grille depuis `target_coords`+`size_arcmin`+`overlap_frac`) |
| `masters.py` (C1) | `/api/masters{/build,/resolve,/delete,/calibrate}` |
| `stacking.py` | `/api/stacking/{status,reset,configure,masters,save,snapshot,start,stop}` |
| `pointing.py` | `/api/pointing/{status,add,correct,clear,fit,record-solve}` |
| `triggers.py` (A2) | `/api/triggers/{status,test}` |
| `visibility.py` | `/api/visibility` (hauteur/visibilité 24 h d'un objet) |
| `config.py` | `/api/config{/ui,/site{,/cities}}` |
| `astrometry.py` | `/api/astrometrie/{status,solve,generate_fake_image,fake_images}` |
| `ws_test.py` | `/ws` (WebSocket temps réel), `/api/test/fits*` (images de test) |

### 3.3 Déroulement d'une séquence (orchestration)

`POST /api/sequence/start` (`web/routers/sequence.py`) :
1. **Expansion** : chaque cible activée étend son plan ; une cible **mosaïque** voit ses poses multipliées
   (`mosaic.expand_frames`) avec clés `goto_ra_hours`/`goto_dec_deg`/`tile`/`tiles_total`.
2. `SequenceRunner.start(frames)` (indices de reprise possibles) ; `save_journal` écrit APRÈS le démarrage
   (total correct).
3. Pour chaque pose, `before_frame` (hooks) dans l'ordre :
   - **déplacement de tuile mosaïque** (`_move_to_tile` : slew + attente `slewing` fini ≤ 120 s + recentrage par
     solve ; best effort) — une seule fois par tuile ;
   - **flip méridien** si dû (puis recentrage post-flip par solve) ;
   - **refocus automatique** (B3, si `should_refocus`) ;
   - contrôle LIGHT vs calibration, dithering+settle, pause inter-poses ;
   - écriture FITS : `_frame_meta` (filtre, binning, température, gain, `MOSN/MOSROW/MOSCOL`…) + `inject_meta` ;
   - journal mis à jour après chaque pose (reprise).
   Chaque hook est **best effort et cloisonné** : les échecs sont loggés (warning/error) sans interrompre la
   séquence (ex. déplacement de tuile impossible → tuile prise à la position du slew ; refocus KO → tentative
   suivante après cooldown).

## 4. Frontend (`web/static/`)

- **`hub.js`** — médiateur unique : `subscribe(topic, source, fn)` / `emit(topic, payload, {source})` /
  `request/respond` / `setState`/`getState`/`watchState`. Enveloppes `{id, ts, topic, source, targets, kind, reqId,
  payload}` ; un handler qui lève n'empêche jamais la diffusion. Traces `[Hub]` en niveau de log `debug`.
- **`ws.js`** — traducteur WebSocket → topics `Hub` (`ws:state`, `ws:log`, `ws:image`, `ws:stacking`…).
- **`hardware.js`** — `ws:state` + `device:connected` (débouncing 1200 ms), panneau matériel + bandeau LEDs `T C A F R/W` compact `renderConnLeds()` (5 rôles toujours visibles gris→vert `#44cc44`, `R`/`W` selon `I18N.current`) + section `MONTURE — CONNEXION` (sélecteur `série|réseau` + endpoint `/dev/ttyUSB0` ou `host:port` sauvegardés dans le profil `mount_interface/mount_endpoint`).
- **`sequence.js`** — pilote les deux panels (SÉQUENCE simple en mode Capture ; **SÉQUENCEUR** du mode Séquenceur :
  cibles, plan par cible, mosaïque `seqPlanMosaic` via `/api/mosaic/*`, templates via `/api/sequence/templates/*`,
  options globales, `resume-session`).
- **`sky-engine.js`** (module ES) — carte du ciel ; overlay **tuiles mosaïque** (`setMosaicTiles`,
  `setMosaicCurrent`) ; FOV caméra correct (damier `halfX/cos(dec)`) ; **Framing (D3)**
  (`cameraRotDeg`, `cameraTarget`, `_fovCorners`, `_renderTargetBox`, `setCameraRotation`,
  `setCameraTarget`) — FOV rotatif + bounding box de la cible à sa taille angulaire.
- **`framing.js`** — panneau Framing (mode astrometry) : FOV auto caméra/focale ou manuel
  (`_frameCameraFov`, même formule que `mount.js`), rotation 0–360° via slider
  (`skyEngine.setCameraRotation`), boutons ⟳ Solve (rotation du dernier plate solve via
  `solver:result`) / Nord ↑, cible par id (`/api/visibility?id=…`) ou RA/Dec saisi +
  GOTO (correction de pointage + slew), **fit-check** (`_frameFitCheck` : boîte englobante
  d'un rectangle tourné `w=maj·cosA+min·sinA`) ; sélection catalogue (target.js) →
  `frameSetTargetObject`.
- **`capture.js` / `stacking.js`** — consommé via `capture:progress` / `stacking:update`.
- **`target.js` / `solver.js`** — `solver:result`, `record-solve` → modèle de pointage.
- **`app.js`** — mode manager (`MODES`→applets dans `state.js`), `mode:changed`, `calibration:done`.
- **`layout.js` / `app.js` responsive (`<1100px`)** — bandeau `Connexion` pleine largeur `calc(100vw-16px)` en haut (2 rangées `row wrap space-between`, `clamp()` inputs, `conn-row-attach/serial` masqués), `#applets-layer{flex-direction:column;pointer-events:none}` (laisse la skymap manipulable hors panneaux), `#mobile-stack` à gauche de la colonne d'icônes `width:calc(100vw-66px)` `max-height:calc(100vh-...-110px)` scroll `overflow-y:auto`, `#mobile-dock` fixe droite `44×44` `top:124px` (`144px` en `<599px`) `gap:6px` icônes `PANEL_ICONS` `title` hover `.active` pulse, `#bottom-nav` 7 modes en bas, `initSwipeNav()` (swipe horizontal). `toggleMinimize` masqué sur mobile, panneaux `position:relative` `gap:8px` sans recouvrement, LEDs `T C A F R/W` compact `6×6` `conn-led` neutre gris → vert `#44cc44` (indépendant du thème).

Modules ES vs scripts classiques : `app.js`, `sky-engine.js`, `sky-projection.js` sont des modules ; ils
communiquent avec le reste via des globales `window.*` exposées par `preview.js` (ex. `setOffsetTarget`) et le bus
`Hub` (exposé globalement).

## 5. Temps réel (WebSocket)

1. INDIGO (`def`/`set`) → `DeviceRegistry` → `state_dict()` des devices.
2. `WebServer` pousse les états et journaux via `/ws` (protocole messages JSON : `state`, `log`, `image`,
   `stacking`).
3. `ws.js` traduit en topics `Hub` → panneaux abonnés (débouncing pour `device:connected`).

## 6. Stratégie de tests

| Niveau | Fichiers | Exécution |
|--------|----------|-----------|
| Unitaires/intégration | `tests/test_*.py` | `python -m pytest tests/ -q` (284 tests, ~79 s) |
| Flows (bout-en-bout sans matériel, TestClient + mock stub) | `tests/test_*_flow.py` (ex. `test_mosaic_flow`, `test_sequence_flow`) | **lancés directement** : `python tests/test_sequence_flow.py` (98 checks) |
| Simulations INDIGO | `tests/mock_indigo.py` (port 17624) | `./start-mock-server.sh` |
| E2E contre un vrai `indigo_server` (simulateurs) | `tests/test_blanc_indigo.py` | `python tests/test_blanc_indigo.py` |
| JS (node) | `tests/test_hub.js`, `tests/test_polar_math.js` | `node tests/test_hub.js` |
| UI (Playwright) | `tests/*.spec.js` | `npx playwright test` |
| Syntaxe JS | `node --check web/static/*.js` | boucle bash |

Les features « pur » (mosaïque, fitsmeta, masters, exposure, meridian…) sont testées sans serveur INDIGO
(`tests/test_*.py`), les flux HTTP via TestClient avec des **stubs** de devices (`tests/test_*_flow.py`).

## 7. Commandes utiles

```bash
./start.sh                          # serveur (config.yaml)
./start-mock-server.sh              # mock INDIGO (17624)
.venv/bin/python -m pytest tests/ -q
python tests/test_sequence_flow.py  # séquences + mosaïque + reprise
```