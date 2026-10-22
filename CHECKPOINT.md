# Checkpoint — Noctua (autoguidage + contrôle INDIGO)

## Session 2026-10-15 (suite) — Définitif pourri : stride Bayer + //257 (branche `master`)

### Diagnostic (preview bon, définitif HS)
- Layout RGB vérifié dans les sources INDIGO (`indigo_process_image` transpose BIP→planaire) : notre `reshape((3,h,w))` est correct, pas de scramble de ce côté.
- Deux vrais bugs trouvés par tests de contenu (les tests précédents ne vérifiaient que « c'est un JPEG ») :
  1. **Stride avant dématriçage** : `mosaïque[::2,::2]` ne garde qu'une phase sur 4 → 3 couleurs sur 4 jetées, couleurs fausses (étoile rouge vue bleue).
  2. **`// 257` 16→8 bits avant stretch** : pleine dynamique 12 bits écrasée à 0-15 (étoiles faibles à 0/1) avant même l'étirement.
- Fix : vignette = **binning 2×2 exact des quads** (chaque pixel RGB complet) ; pleine = bilinéaire pleine résolution ; stretch en pleine profondeur (BZERO soustrait, jamais de passage uint8 intermédiaire) ; couleur RGB planaire préservée (transpose = vue, pas de copie).
- `tests/test_jpeg_thumb.py` : RGB planaire (R=242/B=21), Bayer GRBG uint8, **Bayer 16 bits + BZERO étoiles faibles** (le cas SV305PRO), fond sombre (médiane 0, hot pixels blancs).
- Gate : pytest **316** ✓, mount_flow 53/53 ✓, hub 39 ✓.
- Note live : trame RisingCam du moment noire (R≤13/G≤22/B 17px — capuchon ?), pas de démo couleur possible sans signal.

## Session 2026-10-15 (suite) — Badge preview/définitif + bouton capture qui se réarme (branche `fresh-capture`)

### Diagnostic terrain (log RisingCam)
- Jonglage d'images : preview driver 403 Ko (pleine) → vignette FITS → pleine FITS, trois rendus d'aspects différents sans indication → confusion.
- Bouton EXPOSER resté désactivé jusqu'au Stop : `waitExposureDone` n'armait `started` que sur `exposure_time > 0`, or le driver signale Busy **sans durée** (`t=0.0s` en permanence) → attente du timeout plein (121 s). Retardataires pose N-1 en prime.

### Fix
- **Badge de stade** : `_push_jpg(..., stage)` (`preview` = JPEG driver provisoire, `final` = dérivé FITS) → `ws:image` → `handleCameraImage(..., stage='final')` → pastille `#cap-image-stage` (`◌ Aperçu` ambre / `● Définitif` vert, i18n `cap.stage_*`, préservée par `viewer.setInfo`).
- **`waitExposureDone(cam, timeout, aliveFn)` réécrit et partagé** (`capture.js`, délégué par `_mfWaitImage`/`_autofocusWaitImage` + timeouts AF passés à `exp+120s`) : démarrage via flag `exposing` (pas la durée), fin = idle + image fraîche **de cette caméra** (`_lastWsImageByDev`, ignore les retardataires), caméra disparue → échec en ~5 s.
- Tests node ad hoc (4 cas : Busy-sans-durée, jamais-démarré, caméra absente, straggler) ✓ ; pytest + flow OK (ci-dessous).

## Session 2026-10-15 — MAP manuelle + aide Bahtinov (branche `fresh-capture`)

### Feature — Mise au point manuelle (sans focuser motorisé)
- Nouvel applet **✋ Mise au point manuelle** (mode Focuser, bas-gauche) : `Pose` + `📏 Mesurer` (HFR sur dernière image) + `🔁 Loop` / `⏹ Stop` (poses en boucle + mesure auto, abort à l'arrêt). Aucun ordre focuser — marche sans focuser branché. Les points alimentent le graphe HFR existant (`foc-hfr-canvas`) + overlay cercles.
- Boucle coupée au lancement de l'autofocus V-curve (caméra partagée).
- i18n FR/EN : clés `mf.*`. Docs `03-focuser` FR/EN.

### Feature — Masque de Bahtinov
- Backend **`indigo/devices/bahtinov.py`** : étoile brillante non saturée (ou clic ±80px, max flux), crop 257px, Radon discret (angles → 2 diagonales + scan centrale décalée), raffinement ±3°/0.5°, positions latérales, croisement diagonales vs centrale → **offset signé px + direction** ; garde anti-faux-positif (support de flux sur toute la longueur après retrait du profil radial + contraste + symétrie → confiance).
- Endpoint **`GET /api/focuser/bahtinov?device=&x=&y=`** (+ `width/height` pour l'échelle d'overlay).
- Frontend : toggle `▦ Bahtinov`, clic aperçu (garde anti-drag, conversion client→FITS comme curseur ADU), overlay 3 segments (centrale jaune, diagonales cyan, croix rouge) sur `focus-overlay-canvas`, lecture `Δ ±N px → ⟩⟩/⟨⟨` (vert <2px, orange <6, rouge sinon), historique 12 pastilles, bouton `⇄` (sens masque-dépendant, persisté `localStorage`). En Loop, ré-analyse auto de la même étoile.
- Histogrammes `*HISTOGRAM*` droppés côté `Camera.on_blob_data` (2 Ko rendus comme image avant).

### Tests
- `tests/test_bahtinov.py` (nouveau, 6 tests, pytest + direct) : offsets synthétiques +8/−6/0 retrouvés à <1px avec direction, clic proche, étoile ronde rejetée (`ok:false`), preview JPEG +8 retrouvé (+8,2).
- Live mock : `/api/focuser/bahtinov` sur frame sans spikes → `ok:false` propre ; `focus-metric` OK (HFR 3.4, 8 étoiles).
- **HFR/Bahtinov sur previews JPEG** : `decode_image()` (FITS/JPEG/PNG, +`source`) — la loop manuelle ne mesurait rien tant que seul le JPEG preview était arrivé (`parse_fits` échouait en silence). Plancher de détection mixte bruit/dynamique (le JPEG atténue les aigrettes).
- Gate : pytest **306** ✓, `test_mount_flow` **53/53** ✓ (1 flaky isolé), `test_focus_flow` **24** ✓, `test_hub` **39** ✓, `node --check` ✓.

## Session 2026-09-23 (suite 2) — Capture unitaire + loop test dans Paramètres guidage (branche `fresh-capture`)

### Feature
- Panneau **AUTOGUIDAGE → Paramètres** : section **Test / mise au point** après Binning — `📷 Capture` (pose unitaire) + `🔁 Loop` / `⏹ Stop loop` (boucle de poses pour la mise au point **sans** démarrer le guidage, ni corrections monture).
- `_guideCapHandler` (`guide.js`) applique désormais le **binning** via `POST /api/camera/expose {binning}` (nouveau champ optionnel, `Camera.set_binning` avant expose — pattern Flat Wizard).
- Loop frontend : `_guideTestLoopToggle` / `_guideStopTestLoop` — relit exposition à chaque itération, attend pose+0.5 s pour l’image WS, coupe via `/api/camera/abort` au stop. **Coupée automatiquement** avant `▶ Lancer` (`_guideStart`) et au `⏹ Stop` guidage.
- i18n FR/EN : `guide.test*`, `log.guide.loop_*`. Cache-bust `guide.js` + `i18n.*` `?v=20260923c`.
- Docs : `docs/panneaux/04-guidage.md` + `docs/en/panneaux/04-guiding.md` (section Paramètres).

### Tests
- `tests/guide-validation.spec.js` : nouveau test « paramètres : capture unitaire + loop test (toggle) » + helper `expandGuidingPanels` (desktop dense escamote les 6 panneaux guidage au `switchMode` — forcer `display` + retrait `collapsed` après mode click et après reload calibration).
- Résultats : Playwright `guide-validation` **3/3 ✓**, `hardware-ui` **11/11 ✓**, pytest **299 ✓**, `mount_flow` **53 ✓**, `guide_flow` **38 ✓**, `guide_loop_flow` **15 ✓**, `hardware_flow` **50 ✓**, `hub` **39 ✓**, `node --check` OK.

### Terrain (avant commit `fresh-capture`)
- Mode Guidage → Paramètres → Caméra SV305PRO → pose 1 s / binning 2×2 → `📷 Capture` (image dans Aperçu + étoiles) → `🔁 Loop` ( poses continues, bouton → Stop) → `⏹ Stop` → `▶ Lancer` (loop coupée, guidage OK).

## Session 2026-09-23 (suite) — Scan ports série + profil stale `ttyUSB1` (branche `fresh-capture`)

### Constat terrain
- Seul `/dev/ttyUSB2` existe (CP2102) ; profil actif `setup 150` → `mount_endpoint: /dev/ttyUSB1` **stale** (rénumérotation USB ttyUSB0→1→2).
- Noctua n'ouvre aucun tty (client TCP INDIGO) — il **pousse un chemin périmé** via `DEVICE_PORT` avant CONNECT.
- `indigo_worker` détient des FD `(deleted)` sur les anciens nœuds.

### Feature
- `GET /api/serial/ports` (`web/routers/hardware.py` : `_scan_serial_ports` + route) : scan `/dev/ttyUSB*` + `/dev/ttyACM*`, symlink `by-id` (path **stable** recommandé `preferred`), description udev, holders `fuser` (`busy`), + santé `profile.mount_endpoint` (`exists`).
- UI : `<datalist id="serial-port-list">` partagé sur `#indigo-serial` (bandeau) et `#hw-mount-endpoint` (panneau Matériel) ; bouton **⟳ Scanner ports série** (`hw-scan-serial`) avec choix numéroté + écriture du `preferred` ; hint `hw-serial-hint` orange si profil stale / vert si OK.
- `hwScanSerialPorts({force,silent})` dans `hardware.js` (cache 3 s) — appelé au boot, au refresh Matériel, à l'entrée du mode Matériel, et quand la ligne série du bandeau devient visible.
- i18n FR/EN : `conn.serial_*`, `hw.scan_serial`, `hw.serial_*`. Cache-bust `?v=20260923a`.

### Validation
- `pytest` **296 ✓** (+4 `tests/test_serial_ports.py`), `test_mount_flow` **53/53 ✓**, `test_hardware_flow` **50/50 ✓** (dont `/api/serial/ports`), `test_hub` **39 ✓**, `node --check` JS OK.

### Terrain
- Ouvrir Matériel → Scanner → pick `by-id` stable → APPLIQUER → connect monture ; vérifier `SEND:…` et pilotage joystick.
- Optionnel : mettre `profiles.yaml` `mount_endpoint` sur le symlink `by-id` après validation UI.

## Session 2026-09-23 — BUG joystick : rate CENTERING écrasait les items (branche `fresh-capture`)

### Diagnostic
- Chemin : `controls.js startSlew` → `mountMove` (`mount.js`) → `POST /api/mount/move` → `Mount.move()`.
- **Bug racine** : la route appelait `set_slew_rate(rate_UI)` puis `m.move(direction)` avec le défaut `rate="CENTERING"`. `set_slew_rate` comparait **strictement** `it.name == rate_name` : items INDIGO `Guide/Centering/Find/Max` ne matchent pas `"CENTERING"` → **tous les items partaient à Off**, aucun rate actif → monture immobile (pseudo-park, unpark « non effectif »).
- Garde anti-parké frontend (`mount.js:215` / `controls.js:122`) OK après unpark (ws:state vérifié) — pas la cause.
- `TELESCOPE_MOTION_NS/WE` absents de `MOUNT_PROPERTIES` (upgrade device INDI legacy) — ajoutés.
- Logs UI `move/halt` étaient en niveau `debug` (masqué par défaut) → **impossible de diagnostiquer** sans cocher debug.

### Fix (non commité, avec le reste de `fresh-capture`)
- `set_slew_rate` : match **case-insensitive** ; si aucun item ne matche → **ne rien envoyer** (on garde le rate courant) + `log.warning`.
- `move(direction, rate=None)` : applique le rate **seulement si fourni** ; plus de défaut `CENTERING` qui écrase.
- Route `/api/mount/move` : un seul appel `m.move(direction, rate)` (plus de double `set_slew_rate`).
- `MOUNT_PROPERTIES` : + `TELESCOPE_MOTION_NS`, `TELESCOPE_MOTION_WE`.
- Logs `indigo.mount` **INFO** sur `move` (prop résolue + items envoyés + `prop_found`) et `set_slew_rate`.
- UI `mountMove`/`mountHaltMove` : `addLog` en **info** (visible sans filtre debug).

### Validation
- Unité `set_slew_rate` : `CENTERING`→Centering=On, `Find`→Find=On, `NOPE`→no-send ; `move(NORTH)` sans rate n'envoie que `MOUNT_MOTION_NS`.
- `python tests/test_mount_flow.py` : **53/53 ✓** (1er run 1 flaky NORTH, 2e OK).
- `pytest tests/ -q` : **292 ✓** ; `node tests/test_hub.js` **39 ✓** ; polar JS **53 ✓** ; `node --check` tous les JS ✓.

### Terrain (prochaine session)
- Relancer serveur + appui joystick : s'attendre à log UI `move north rate=Find` + backend `move NORTH → MOUNT_MOTION_* items=… prop_found=True` + `SEND: …MOTION…`.
- Si `prop_found=False` : nom de prop réel LX200 à capturer dans les defs (`/api/mount` → `properties`).

## Session 2026-09-22 — États monture : park/unpark OK terrain, bug joystick (branche `fresh-capture`, non commité)

### Contexte
- Branche `fresh-capture` : 8 fichiers modifiés (~+406/-125) — rework park/unpark/home (`indigo/devices/mount.py`), génération `connect()` anti-sockets orphelines (`indigo/client.py`), `disconnect()` systématique avant changement host (`web/routers/mount.py`), UI PARK/HOME toujours actifs + confirm SET PARK/HOME (`mount.js`/`controls.js`/i18n).
- Test RisingCam écarté ; chantier = **gestion des états monture**.

### Diagnostic "monture parquée non vue" → faux diagnostic, backend sain
- Monture parquée via frontend INDIGO (Noctua arrêté — le frontend ne connecte pas si le port est pris).
- Au redémarrage Noctua : `/api/devices` → `MOUNT_PARK PARKED=True/UNPARKED=False Ok` ; `/api/mount` → `parked:true, park_state:Ok` ; log `park: False -> True state=->Ok items=[('PARKED', True), ('UNPARKED', False)]`.
- Affichage UI confirmé : LED PARK + bouton UNPARK. Chaîne `state_dict → WS state (push immédiat à la connexion, `ws_test.py:32`) → `ws.js` → `renderMountPanel()` OK.

### Preuve unpark terrain (Mount LX200 réel, 23:19:40)
- `POST /api/mount/unpark` → `sending MOUNT_PARK bi PARKED Off / UNPARKED On` → `True -> False Ok->Busy` → `Busy->Busy msg='Unparking'` → `Busy->Ok` → `unpark: success (parked False, state Ok)`.

### Reste
- **BUG joystick inopérant** (inscrit TODO_LIST) : après unpark réussi, aucun mouvement → effectivité physique du unpark non vérifiable. Pistes : garde anti-parké `mountMove` (`mount.js:215`), nom prop mouvement, `set_slew_rate`, `_resolve_prop_name` sur LX200 réel.
- À reprendre demain : logs `indigo.mount` + `SEND:` sur appui joystick, puis `test_mount_flow.py` gate + commit `fresh-capture`.

## Session 2026-08-22 — Hub : état partagé + requêtes/réponses, payload capteur, fix parsing INDIGO

### Feature — Hub étendu (`web/static/hub.js`)
- **État partagé** : `Hub.setState(key, value)` / `getState(key)` (copie profonde) / `watchState(key, source, fn)` (reçoit l'état courant immédiatement, retourne unwatch). Ancien `getState(topic)` (booléen d'abonnement) → renommé `topics(topic)`.
- **Requête/réponse async** : `Hub.request(topic, payload, {source, timeoutMs})` → promesse résolue par `Hub.respond(env, value)` sur le même `reqId` ; timeout par défaut 5 s, rejet sinon. Enveloppe `kind='request'` + `reqId` tracés dans le log.
- **Payload `device:connected` enrichi** (`web/static/hardware.js`) : porte désormais `sensor = {width_px, height_px, pixel_size_um, focal_length_mm}` depuis `ws:state`.
- **Mock INDIGO** : items `CCD_INFO` renommés `WIDTH`/`HEIGHT`/`PIXEL_SIZE`/`BITSPERPIXEL` (noms réels INDIGO, sans préfixe `CCD_`).

### Fix — parsing INDIGO (`indigo/protocol.py`, `indigo/registry.py`)
- `defNumber` : la valeur peut être dans l'attribut `value` (def*) OU dans le texte (set*/new*) — les deux acceptés, texte prioritaire.
- `registry.py` : un `def*Vector` est un schéma, pas une mise à jour d'état — l'état `connected` n'est plus écrasé par la valeur (souvent stale) du switch `CONNECT`/`CONNECTED` du def ; seul le vecteur `CONNECTION` (confirmation serveur) le met à jour. L'auto-connect teste `dev.connected`.

### Tests
- `tests/test_hub.js` : **39/39** (nouveau : état partagé round-trip, watcher tardif, copie getState, request/respond, timeout, respond sans reqId).
- `tests/hub-ui.spec.js` : **3/3** (attend la confirmation des 4 panneaux après `HUB_CONFIRM_MS`, vérifie `sensor` 1920×1080/3.75 µm dans le payload).
- `tests/test_protocol.py` + `tests/test_registry.py` : **8/8**.

## Session 2026-08-15 — Bus de messages `events.js` : implémenté (checkpoint à tenir à jour)

## Projet
`Noctua` : interface web (FastAPI + Vanilla JS) pour contrôle d'équipements astronomiques via serveur INDIGO.

## Architecture
INDIGO Server → Python FastAPI backend → Browser UI (Vanilla JS)
L'autoguidage est orchestré par le frontend : expose guide camera → mesure centroïde → corrige la monture.

## Session 2026-08-15 — Bus de messages `events.js` : implémenté (checkpoint à tenir à jour)

### Contexte
`ws.js` faisait des appels directs aux modules (renderMountPanel, renderCapturePanel, renderHardwareMode, updateSolverHints, handleGuideImage/CameraImage…), couplage fort. Objectif : **bus pub/sub global** `Bus` (script classique chargé avant `layout.js`, après `state.js`), `ws.js` réduit à un simple traducteur, chaque module abonné met à jour son propre panneau.

### Design (reflété dans `docs/bus-architecture.svg`)
- Enveloppe : `{ id, ts, topic, source, targets, kind, reqId, payload }` — **payload = données pures uniquement** (jamais de callbacks), pour permettre transfert réseau ou `structuredClone` ultérieur.
- `Bus.emit(topic, payload, {source, kind, reqId})` ; `Bus.on(topic, fn)` retourne une fonction d'unsubscribe ; `Bus.off/once`.
- Topics namespacés `<domaine>:<événement>` ; normalisation `'foo'` → `'app:foo'` ; registre `REGISTRY` (source + targets) avec **validation en dev** : `console.error` si topic inconnu émis, `console.warn` si source ≠ source attendue.
- **Registre (9 topics)** :
  | Topic | Source | Targets |
  |---|---|---|
  | `ws:state` | ws | mount, capture, focuser, solver, guide, hardware |
  | `ws:image` | ws | preview |
  | `ws:log` | ws | api |
  | `solver:result` | solver | target, preview |
  | `mode:changed` | app | solver, hardware |
  | `calibration:done` | calibration | app, guide |
  | `capture:progress` | capture | sequence, stacking, app |
  | `guide:starSelected` | preview | guide |
  | `mount:slewed` | mount | target |

### Branchements (testés)
- **ws.js = traducteur** : `Bus.emit('ws:state', {devices})`, `ws:log`, `ws:image`, `solver:result` (source `solver`). Reste en direct : `renderDevices()` (liste devices, son rôle) + `selectDevice()` (UX device-list → `renderMountPanel()`). Gardes `typeof renderHardwareMode === 'function'` supprimées.
- **Émetteurs** : app.js (`mode:changed` dans `switchMode` — blocs directs refreshSolverStatus/renderHardwareMode retirés) ; calibration.js (`calibration:done` — auto-gains + popup déplacés) ; preview.js (`guide:starSelected` clic + best star auto) ; capture.js (`capture:progress` dans `updateCaptureProgress` — exclusion caméra + progression en direct) ; mount.js (`mount:slewed` sur transition `slewing`→idle dans le consommateur `ws:state`).
- **Abonnés** : api (`ws:log`→addLog) ; preview (`ws:image`→routing guide/capture) ; mount (`ws:state`→updateCameraFov+auto-sélection+renderMountPanel) ; capture (`ws:state`→renderCapturePanel) ; focuser (`ws:state`→renderFocuserPanel+refresh liste) ; solver (`ws:state`→hints, `solver:result`→handleSolverWsResult, `mode:changed`→refresh status) ; target (`solver:result`→`_centeringStep`, `mount:slewed`→relance `_centeringNextStep` dès la fin du nudge, fallback 5 s) ; guide (`ws:state`→refresh liste caméra, `calibration:done`→auto-population gains RA/DEC, `guide:starSelected`→médaillon recentré) ; hardware (`ws:state`→rebuild `_hwDevices`+render, `mode:changed`→render mode) ; app (`calibration:done`→toast+Démarrer guidage, `capture:progress`→toast fin de capture rapide, abort non annoncé) ; sequence (`capture:progress`→start désactivé + progression de la capture rapide reflétée quand aucune séquence serveur) ; stacking (`capture:progress`→start désactivé + statut « Capture rapide en cours…»).
- **Câblés (session 2026-08-16)** : les 9 topics du registre sont branchés. `capture:progress` = progression du panneau Capture (capture rapide) : les panneaux SÉQUENCE/LIVE STACKING se mettent en attente (exclusion caméra, deux processus d'acquisition ne peuvent pas tourner en même temps) et reflètent la progression sans attendre le poll 1 s. `mount:slewed` = fin de slew détectée par transition d'état (le serveur pousse `ws:state` à chaque mise à jour device). `guide:starSelected` = guide.js recentre le médaillon d'étoile.

### Validation
- `node --check` sur les 8 fichiers touchés (events, ws, api, preview, mount, capture, focuser, solver, target, guide, hardware, app, calibration, sequence, stacking, i18n).
- Playwright **48 specs** (4.0m) — inclut toast « Calibration terminée », auto-population gains RA/DEC, guidage réel, panneau SÉQUENCE.
- pytest **134/134** ; smoke headless : 0 erreur console, 0 warning `Bus:`, panneau matériel alimenté par `ws:state`.

## Session 2026-08-15 — Schéma du bus de messages : checkpoint à tenir à jour

### Checkpoint supplémentaire — `docs/bus-architecture.svg`
Documentation vivante de l'architecture des échanges entre modules frontend (voir section « Bus » du TODO). **À régénérer et mettre à jour à chaque évolution des modules, topics ou du design du bus** (cf. `TODO_LIST.md` → bus `events.js`).

- **Générateur versionné** : `docs/gen_bus_architecture.py` (python3, sans dépendance). Commande : `python3 docs/gen_bus_architecture.py` → réécrit `docs/bus-architecture.svg`.
- **Validation** (à refaire après chaque régénération) :
  1. XML : `ET.parse('docs/bus-architecture.svg')` OK.
  2. JS : extraire le `<script><![CDATA[…]]>` et `node --check` sur le fichier extrait.
  3. Playwright headless (`NODE_PATH=…/node_modules node …`) : survol de chaque module → bulle visible (vérifier le **CSS calculé** `visibility`, pas l'attribut), texte dans le cadre (0..1300), 0 erreur console ; animation → 17/17 modules passent.
- **Contenu** : 2 barres bus horizontales (BUS — `events.js` et suite), 17 modules, 9 topics mappés, légende, boutons « ▶ Animer le flux » / « ⟲ Réinitialiser ». Interaction : survol module/stub/tag/légende (focus + info-bar), survol module → **bulle descriptive** (texte sur plusieurs lignes, largeur fixe 230, clamp aux bords), animation → marqueur cyan + surbrillance `.buspass` + bulle au passage.
- **Piège CSS documenté** : ne jamais piloter la visibilité de la bulle par l'attribut SVG `visibility` — la règle CSS `#bubble { visibility:hidden }` l'écrase (le CSS prime sur les presentation attributes). Utiliser une classe `.show` (`#bubble.show { visibility:visible }`).
- Description des modules : dictionnaire `DESC` dans le générateur (à maintenir quand un module change de rôle).

## Session 2026-08-15 — Découpage `app.js` en modules (maintenance)

### Contexte
`app.js` (7720 lignes) monolithique : difficile à maintenir. Objectif : dépouiller `app.js` par extraction incrémentale vers des modules classiques ≤ 1000 lignes chacun, en scripts classiques + globals partagés (cohérent avec `i18n.js`/`layout.js` déjà chargés ainsi), sans build step.

### Stratégie
- Scripts **classiques** chargés dans l'ordre dans `index.html` **avant** `app.js` (qui reste un module ES — `import { SkyEngine }`).
- Les variables d'état et helpers sont des **bindings lexicaux globaux** (script classique) : accessibles depuis les modules suivants et depuis `app.js` sans renommage.
- Pour chaque extraction : repérer les dépendances de la classe/fonctions, déplacer l'état associé dans `state.js`, publier le reste via globals.

### Modules créés / adoptés
| Module | Lignes | Contenu |
|---|---|---|
| `state.js` *(nouveau)* | 99 | État global (`ws`, `devices`, `uiConfig`, `currentMode`…), `MODES`, `captureViewer`/`guideViewer`, helpers config, vars preview/histogramme/guide |
| `viewer.js` *(nouveau)* | 699 | Classe `Viewer` complète (FITS parsing/rendu asinh, zoom/pan, histogramme, `renderGuide`) |
| `layout.js` *(adopté)* | 226 | Layout panneaux (overlap, clamp, positions) + `ChecklistPanel` + `toggleMinimize`/`applyCollapsedState` |
| `utils.js` *(réparé)* | 43 | Helpers purs + `i18n`/`i18nFmt` + `sleep` (les `export` d'origine cassaient le script classique) |
| `api.js` *(nouveau)* | 127 | `apiPost`, `setSwitch/Number/TextItem`, `addLog`, `showToast`, log copy/filters, `escapeAttr/HTML` |
| `mount.js` *(nouveau)* | 228 | `findMount`, `renderMountPanel/FlipPanel`, `updateCameraFov`, `setTargetObject`, commandes monture |
| `controls.js` *(nouveau)* | 140 | `initDpad`, `initButtons`, `initJoystick` |
| `ws.js` *(nouveau)* | 440 | `connectWS` + handler, device list (`renderDevices`/`renderProps`…), `DRIVER_TYPE_KEYWORDS`/`filterDriversByType`, `refreshDriverList`, `initConnectionBar`, `initLocationUpdate` |
| `objects.js` *(nouveau)* | 384 | Object search + selector (GOTO), catalogs, `initSitePopup`, `initTimeControls` |
| `hardware.js` *(nouveau)* | 350 | Panneau Matériel + profils (`HW_ROLES`, `hwLoad`, `renderHardwarePanel`…), mode dédié |
| `capture.js` *(nouveau)* | 493 | Capture panel, `startSequence`, countdown, `renderCapturePanel`, filtre (roue) |
| `sequence.js` *(nouveau)* | 271 | Panneau SÉQUENCE (table de poses, `seqStart`, poll status) |
| `stacking.js` *(nouveau)* | 156 | Panneau LIVE STACKING (`stkStart/Stop/Reset`, poll status) |
| `preview.js` *(nouveau)* | 604 | FITS image handling (`handleGuideImage`/`handleCameraImage`, `_guideDetectStars`, `_guideClick`+`window._guideClick`), histogramme, resize, zoom/pan, save, overlays offset/focus |
| `testharness.js` *(nouveau)* | 145 | Dev / no-camera testing (`_testHarness`, `loadTestFITS`, `mockSolveResult`…) |
| `solver.js` *(nouveau)* | 288 | Plate Solver panel, `refreshSolverStatus`, `handleSolverWsResult` |
| `target.js` *(nouveau)* | 242 | Target centering panel + centering loop (`_centeringStep`) |
| `polar.js` *(nouveau)* | 558 | Polar alignment 3-point (auto/manual, diagramme) |
| `focuser.js` *(nouveau)* | 625 | Focuser panel + autofocus sequence (V-curve, `_autofocus*`) |
| `guide.js` *(nouveau)* | 717 | Guide panel, `_guideLoop`, drift graph, RMS/SNR, `_guideCleanup` |
| `calibration.js` *(nouveau)* | 500 | Calibration monture (`_calibrateStart/Loop/Done`) |

### Résultats
- **`app.js` : 6273 → 457 lignes** (retrait ~5820 lignes). Il ne garde que : Mode Manager (`switchMode`/`configureViewerForMode`/`initModeBar`), `initI18nSelector`, `initSkyEngine`, `initLayerToggles`, `initDraggableApplets`, exports globaux, et le boot `DOMContentLoaded`.
- **Déplacements d'état** : `MODES` + `captureViewer`/`guideViewer` → `state.js` ; `DRIVER_TYPE_KEYWORDS`/`filterDriversByType` → `ws.js` ; `sleep` → `utils.js` ; `ChecklistPanel` → `layout.js` (tous en bindings lexicaux globaux pour rester accessibles aux scripts classiques).
- Tous les modules ≤ 1000 lignes (seuls `sky-engine.js` 1148 — module ES bibliothèque — et `i18n.js` 1025 — dictionnaires — dépassent).
- Vars mortes supprimées : `_histAuto`, `_histBlackPct`, `_guidePreviewZoom/PanX/PanY` (déclarées, jamais lues).
- `window._guideClick = _guideClick` publié (classe Viewer en script classique) ; les helpers `hexToRgb`/`decToSexa`/`sexaToDec` dédupliqués (implémentations canoniques d'app.js → `utils.js`).
- `.gitignore` : `backups/` ajouté ; `web/static/app.js.refactored` (brouillon refonte totale) supprimé.
- **Ordre de chargement** : `i18n.js → utils.js → state.js → layout.js → viewer.js → api.js → mount.js → controls.js → ws.js → objects.js → hardware.js → capture.js → sequence.js → stacking.js → preview.js → testharness.js → solver.js → target.js → polar.js → focuser.js → guide.js → calibration.js → app.js (module)`.

### Validation
- `node --check` OK sur tous les fichiers.
- **Playwright : 48 specs** ✓ (viewer, polar, hardware, sequence, guide-validation).

### Fichiers
- Nouveaux : `state.js`, `viewer.js`, `api.js`, `mount.js`, `controls.js`, `ws.js`, `objects.js`, `hardware.js`, `capture.js`, `sequence.js`, `stacking.js`, `preview.js`, `testharness.js`, `solver.js`, `target.js`, `polar.js`, `focuser.js`, `guide.js`, `calibration.js` (dans `web/static/`).
- Modifiés : `app.js` (dépouillé 457 lignes), `index.html` (ordre scripts), `utils.js`, `layout.js`, `state.js`, `TODO_LIST.md`, `CHECKPOINT.md`, `.gitignore`.
- Supprimé : `web/static/app.js.refactored`.

## Session 2026-08-11 — Validation UI section « À tester » (items 1–11) + infra Playwright guidage

### Contexte
Résidu de la section « À tester » de `TODO_LIST.md` : 4 items live-stacking (déjà couverts par les flow tests) + 7 items guidage/calibration/aperçu. Objectif : automatiser le reste en Playwright, confirmer/rejeter la CR « Étoile perdue », cocher les items, puis suite complète verte.

### Items 1–4 — Live stacking (déjà implémentés, tests ajoutés)
- `tests/test_live_stack_flow.py` enrichi de 3 tests (**52 checks, 0 failed**) :
  - `test_continuous_session_manual_stop` : `max_frames=0` (continu) + STOP manuel → snapshot PNG, master FITS+PNG dans la session, état complet.
  - `test_calibration_only_with_dirs` : dark/flat masters appliqués **seulement** si les dossiers sont renseignés (sinon aucune calibration).
  - `test_dirs_filters_separation` : `capture_TS/{filtre}/` strictement séparé de `livestack_TS/`.
- Imports ajoutés : `numpy`, `_arr_to_fits` depuis `indigo.devices.live_stack` (`sys.path.insert(0, ROOT)`).
- Fix assertion trop stricte : `master_*.fits` autorisé dans `livestack_TS/` (la sauvegarde master y est légitime).

### Items 5–10 — Nouvelle spec Playwright `tests/guide-validation.spec.js` (2 tests, **2 passed**)
- **Item 5 (CR « Étoile perdue »)** : calibration complète après `page.reload()` (hypothèse cache stale refutée) ; **retry focus-metric 3× vérifié** en injectant 2 échecs transitoires via `page.route` → calibration aboutit quand même, log « Métrique étoile indisponible (tentative N/3) ».
- **Items 7–8** : toast « Calibration terminée » + bouton « Démarrer guidage » ; gains RA/DEC **auto-populés** depuis `x_rate`/`y_rate` (`guide-ra-gain`/`guide-dec-gain` ≠ 1.0) ; tracé calibration non vide ; re-calibration après refresh toujours OK.
- **Items 9 + 6** : workflow **Capture → Auto → Lancer** → frame_count ≥ 2, graphe 120 s dessiné, **courbe SNR jaune** vérifiée côté backend (`/api/guide/status` history porte `snr > 0`).
- **Item 10 (zoom/pan)** : molette (zoom > 1), clic-glisser (panX change), boutons 1:1 (=1.0) / ◻ (fit < 1), **double-clic reset**.
- Helper `uiClick()` : `dispatchEvent(new MouseEvent('click'))` car le panneau Dérive chevauche le bas du panneau Aperçu et intercepte les vrais clics pointer.

### Fix déterré par le test — double-clic en mode guidage
`Viewer.initZoomPan()` : le dbl-click cliquait en dur `#cap-zoom-enlarge` (bouton du viewer **capture**), donc ne resettait **jamais** le zoom guide. Corrigé : utilise `this.zoomEnlargeId` et `resetZoom()` quand `isGuide` (`web/static/app.js`).

### Item 11 — BUG aperçu GUIDAGE « match=true sans image »
**Non reproductible** : `tests/repro_guide_preview.js` (graphique) — canvas 640×480 rendu, 50 étoiles détectées, status «✨ 50 étoiles», status bar OK. Cosmétique : `console.log` WS ligne 968 affiche les `%s` non substitués (sans impact).

### TODO + suites
- `TODO_LIST.md` : les 11 items de « À tester » cochés (avec références de test), section 100 % validée.
- **Playwright complet : 48 specs** (viewer 11 + polar 10 + hardware 3 + sequence 3 + guide-validation 2… ; specs existantes non régressées). `node --check web/static/app.js` ✓.

### Fichiers modifiés / ajoutés
- `web/static/app.js` : fix dbl-click guide (`initZoomPan`).
- `tests/guide-validation.spec.js` *(nouveau)*, `tests/repro_guide_preview.js` *(nouveau)*.
- `tests/test_live_stack_flow.py` : +3 tests items 1–4.
- `TODO_LIST.md` : items 1–11 cochés.

## Session 2026-08-10 — Live stacking automatisé + séparation capture / stacking (P3)

### Contexte — deux processus distincts
Avant : le stacking n'était pilotable que via `sequence.stack.enabled` (poussée des LIGHT de la séquence dans l'empileur), aucune UI dédiée, confusion entre « pose unitaire » et « accumulation en direct ». Décision : **deux panneaux séparés** dans le mode Capture.

### Feature — Panneau LIVE STACKING dédié (`#applet-stacking`)
- Nouvel applet en mode capture (durée de pose, **poses à empiler**, filtre, root, dark/flat optionnels).
- Backend : session auto-stacking — loop de poses courtes : expose → attente image fraîche → sauvegarde FITS → push `LiveStackEngine` → snapshot WS (vue empilée étirée dans l'aperçu).
- **`max_frames`** : nombre de LIGHT **acceptées** avant arrêt automatique (**0 = continu**) ; `LiveStackEngine` refuse les pushes une fois `complete` ; état `complete`/`max_frames` dans `status()`.
- **Dark/flat optionnels** par session : dossiers FITS → masters de calibration (`build_masters`) appliqués à chaque pose avant empilement.
- Répertoire de session : `<root>/livestack_YYYYMMDD_HHMMSS/` (FITS individuels complets, exploitables ensuite).
- Endpoints : `POST /api/stacking/{start,stop}`, `GET /api/stacking/status` (+`session`, `session_dir`).
- Fix bug critique déterré : `_push_array` re-prenait `self._lock` (lock non réentrant) → deadlock bloquait tout push.

### Feature — Séquence = captures unitaires avec session dir (`capture_TS/`)
- `/api/sequence/start` crée `<root>/capture_YYYYMMDD_HHMMSS/` et l'injecte via `_seq_hooks(save_dir=…)`.
- `_seq_hooks` accepte une surcharge `save_dir` (réutilisée par la session stacking).
- Fichiers alignés par filtre dans `<root>/capture_TS/{filtre}/light_{filtre}_NNN_{ts}.fits`.

### Feature — Distinction documentée + UI
- `docs/UTILISATION.md` : table des deux processus, sections 8.3 (SÉQUENCE) et 8.4 (LIVE STACKING), arborescence racine partagée `capture_TS/` vs `livestack_TS/`, bloc `sequence.stack` rétro-compat.
- `config.yaml` : `stack.max_frames: 0`.
- Robustesse frontend : détection de fin de séquence par compteurs quand un run rapide termine entre deux polls (pas seulement la transition running→idle).

### Tests
- `tests/test_live_stack.py` : +`test_max_frames_completes`, `test_max_frames_zero_is_continuous` (+9 checks).
- `tests/test_live_stack_flow.py` : session auto-stacking (démarrage, `livestack_TS/`, auto-complete à 3, master sauvegardé dans la session dir).
- `tests/test_sequence_flow.py` : fichiers vérifiés sous `capture_TS/L/`.
- Suites complètes : **pytest 134** ✓, flow séquence **26** ✓, flow live-stack **23** ✓, **Playwright 48 specs** ✓, `node --check app.js` ✓.

### Fichiers modifiés
- `indigo/devices/live_stack.py` : `max_frames`, `complete`, `_maybe_complete`, configure/reset/status étendus, fix lock.
- `web/server.py` : `_stacking_session_loop`, endpoints stacking start/stop/status, `_seq_hooks(save_dir)`, session `capture_TS/`.
- `web/static/index.html` + `app.js` : applet LIVE STACKING, init/bootstrap, robustesse fin séquence.
- `config.yaml`, `docs/UTILISATION.md`, `tests/test_live_stack.py`, `tests/test_live_stack_flow.py`, `tests/test_sequence_flow.py`.

## Session 2026-08-04 — Affichages RMS/SNR, durcissement calibration, panneau Dérive

## Session 2026-08-04 — Affichages RMS/SNR, durcissement calibration, panneau Dérive

### Feature — RMS AD/DEC/Total dans le panneau Dérive
Ajout de `#guide-rms-ra`, `#guide-rms-dec`, `#guide-rms-total` (jaune `#ffcc00`). Fenêtre glissante 60 s alignée sur `_guideDrawDrift()` ; calculs dans `_guideUpdateRms()`/`_guideRmsWindow()`.

### Feature — Courbe SNR superposée au canvas de dérive
Chaîne complète backend → frontend :
- `focus_metrics.py` : `star["snr"] = round((peak - bg_median)/max(bg_std,1), 1)`
- `guide.py` : `current_snr` + `snr` dans chaque entrée d'historique
- `server.py /api/guide/step` : transmet `body.snr`
- `app.js _guideLoop()` : envoie `snr: star.snr ?? null`
- `_guideDrawDrift()` : courbe SNR jaune `#ffaa00` sur axe droit 0/25/50 (ticks + point dernière valeur), réutilisant slots/firstSlot/lastSlot/xStep de la dérive
- Canvas `#guide-snr-canvas` dédié supprimé (élément, variable, liaison, fonction `_guideDrawSnr`, 3 appels)

### Feature — Impulsions de correction dans le panneau Dérive
Bloc « Correction » retiré des paramètres de guidage ; `#guide-corr-ra` (vert `#44cc44`) et `#guide-corr-dec` (bleu `#4488ff`) ajoutés dans `#applet-guiding-graph` sous le RMS. Layout final : **Trames / RA / DEC / Corr.RA / Corr.DEC sur la même ligne**, ligne RMS en dessous, puis canvas.

### Fix — Calibration « Étoile perdue » : retry métrique 3×
CR : calibration stoppée ~10 s après départ (« Étoile perdue ») + tempête `Auto-connecting device retries=0` et aucun « Exposure complete » dans la fenêtre.
- **Diagnostic** : non reproductible sur code courant + mock (sous la tempête de connexion exacte : calibration complète 22 steps, `ok:true` et `star_count:1` à 100 % des focus-metric, 0 BLOB tronqué). Piste principale : cache navigateur stale (`app.js`).
- **Durcissement** : `_calibrateLoop` retente `focus-metric` 3× (sleep 800 ms, log warning « Métrique étoile indisponible (tentative N/3) ») avant `_calibrateAbort('Étoile perdue')`. Vérifié via route Playwright injectant une panne transitoire : calibration quand même complete (21 steps).
- **Robustesse défensive** : `client.py` discard des BLOB tronqués (taille décodée ≠ déclarée) ; `focus_metrics.py` tolère les FITS tronqués (image partielle récupérée).

### Feature — Popup confirmation calibration + démarrage guidage en un clic
Helpers `showToast(message, {color,duration,action,onAction})` + `hexToRgb()` après `addLog`. `_calibrateDone` affiche « Calibration terminée — qualité X » (durée `bad?8000:0`, couleur `#ff5577` si poor/insufficient_data sinon `#4a4`) avec bouton « Démarrer guidage » (qualité bonne/acceptable uniquement) → bascule mode GUIDAGE + `_guideStart()` après 600 ms.

### Fix — Rendu fond noir / étoiles blanches (asinh)
Ancienne formule : `v = asinh((raw - sky)/soft)/asinh(k); val = (v + 1) * 127.5` (fond gris 128). Nouvelle : `v = asinh(max(0, raw - sky)/soft)/asinh(k); val = v * 255` (fond noir 0, étoiles blanches 255) dans `_renderStretched` + les 2 rendus d'overlay. Vérifié pixels : coins `[0,0,0,255]`, étoile `[255,255,255,255]`.

### Fix — Couleurs graphe de calibration alignées
W/E (RA) = vert `#44cc44`, N/S (DEC) = bleu `#4488ff`, labels `WEST (RA)`/`EAST (RA)`/`NORTH (DEC)`/`SOUTH (DEC)` ; légende `['#44cc44','#4488ff']`.

### Fix — CSS overlay aperçu guidage
`transform-origin` ajouté à `#guide-preview-canvas`/`#guide-preview-overlay` ; retrait des `max-height` viewport enlarged (capture + guide preview).

### Infra tests
- `indigo/devices/autofocus.py` enfin commité (server.py l'importe depuis le refactor Viewer ; HEAD était cassé sans lui)
- Playwright : `package.json`, `package-lock.json`, `playwright.config.js` (workers:1), `tests/viewer-ui.spec.js`, `tests/polar-ui.spec.js`
- `tests/test_guide.py` : `test_snr_recorded`, `test_snr_optional` ; `tests/test_autofocus.py`, `tests/test_focus_flow.py`, `tests/test_polar_flow.py`, `tests/test_polar_math.js` + `tests/polar_math.js` ; docs `TESTS.md`, `tests/MANUAL_TESTS.md`

### Fichiers modifiés
- `indigo/client.py` : garde BLOB tronqué (~l.478)
- `indigo/devices/focus_metrics.py` : `star["snr"]`, tolérance FITS tronqué
- `indigo/devices/guide.py` : `current_snr`, `snr` dans l'historique
- `web/server.py` : `/api/guide/step` transmet `snr`
- `web/static/app.js` : `showToast`/`hexToRgb`, `_renderStretched` asinh, `_guideDrawDrift` + courbe SNR, `_guideUpdateRms`/`_guideRmsWindow`, `_guideLoop` snr, retry métrique `_calibrateLoop`, `_calibrateDone` toast + action
- `web/static/index.html` : RMS, Corr. RA/DEC sur la même ligne que Trames/RA/DEC, retrait `#guide-snr-canvas`
- `web/static/style.css` : transform-origin overlays
- `.gitignore` : `node_modules/`, `test-results/`
- Nouveaux : `indigo/devices/autofocus.py`, `package.json`, `package-lock.json`, `playwright.config.js`, `tests/test_guide.py`, `tests/test_autofocus.py`, `tests/test_focus_flow.py`, `tests/test_polar_flow.py`, `tests/test_polar_math.js`, `tests/polar_math.js`, `tests/viewer-ui.spec.js`, `tests/polar-ui.spec.js`, `tests/MANUAL_TESTS.md`, `TESTS.md`

## Session 2026-07-28 — Corrections display DPR + tests

### Fix DPR 1 — Drift canvas feedback loop
`_guideDrawDrift()` lisait `canvas.clientWidth` et multipliait par DPR à chaque frame, ce qui modifiait la taille intrinsèque du canvas et pouvait créer une boucle de feedback.
**Correction** : variables `_guideDriftLastCSSW/H` pour tracker les dimensions CSS et ne redimensionner le buffer DPR que quand elles changent réellement.

### Fix DPR 2 — Star canvas sans DPR
`handleGuideImage()` utilisait un buffer 120×120 fixe sans `devicePixelRatio`.
**Correction** : buffer = `120 × dpr` avec CSS 120px. Image nette sur écrans Retina/HiDPI.

### Fix DPR 3 — Crosshair au centroïde
La croix était toujours au centre du canvas, pas à la position de l'étoile mesurée.
**Correction** : variable `_guideLastCentroid` stockée par `_guideLoop()`. Le crosshair vert suit le centroïde, cercle pointillé montre la cible de référence.

### Fix DPR 4 — Épaisseurs de trait
Tous les `lineWidth`, `font`, `arc`, `setLineDash` dans `_guideDrawDrift()` étaient fixes (px CSS) au lieu de `px × dpr`.

### Fix DPR 5 — Zone tolérance renforcée
Ajouté fill semi-transparent `rgba(255,68,68,0.08)` entre les lignes ±2″.

### Fix tests flow — Compatibilité pytest
Les flow tests (`test_guide_flow.py`, `test_autofocus_flow.py`) sont conçus pour être exécutés via `python tests/test_X_flow.py` (ils démarrent mock + serveur). pytest les découvrait et les exécutait sans serveur → faux positifs.
**Correction** : ajouté `__test__ = False` dans les modules flow. Exécution recommandée via leur `main()`.

### Fix guide.start() — Reset drift_arcsec
`start()` ne réinitialisait pas `drift_arcsec_x` et `drift_arcsec_y`, pouvant laisser des valeurs résiduelles entre sessions.

### Fix guide.mock — Guide drift simulation
Ajouté `GuideDriftSim` dans `mock_indigo.py` : génère une séquence d'images FITS avec étoile qui dérive progressivement (RA/DEC). Les corrections guide (`MOUNT_MOTION_NS/WE`) sont relayées au sim pour réduire la dérive. Permet de tester visuellement l'autoguidage sans caméra réelle.
- `tests/mock_indigo.py` : `GuideDriftSim`, `MOUNT_MOTION_NS/WE` defs + handlers, `star_override` sur `MockCamera`
- `start-mock-server.sh` : nouveau script avec params `--drift-vel-x/y`, `--correction-strength`, `--no-drift`

### Fichiers modifiés cette session
- `web/static/index.html` : favicon, drift canvas width/height
- `web/static/app.js` : handleGuideImage DPR + centroid, _guideDrawDrift DPR + cache CSS
- `indigo/devices/guide.py` : start() reset drift_arcsec_x/y
- `tests/test_guide_flow.py` : __test__ = False
- `tests/test_autofocus_flow.py` : __test__ = False
- `tests/mock_indigo.py` : GuideDriftSim + MOUNT_MOTION_NS/WE + star_override
- `start-mock-server.sh` : nouveau script
- `PLAN_D3_CELESTIAL.md` : supprimé (obsolète)

## Session 2026-07-28 (suite) — Phase 5 Autofocus : boucle complète

### Fix _autofocusWaitImage() — Stub → attente réelle
La fonction `_autofocusWaitImage()` retournait `true` après 500ms sans vérifier la disponibilité de l'image.
**Correction** : utilise le même pattern que `waitExposureDone()` — poll `devices[camName].exposure_time` jusqu'à ≤ 0, timeout à 30s. L'arrêt utilisateur (`_afRunning = false`) interrompt aussi l'attente.

### Fix _autofocusFinish() — Move to best + vérification
`_autofocusFinish()` affichait le meilleur point mais ne bougeait pas le focuser.
**Correction** : après l'analyse V-curve, enchaîne :
1. `POST /api/focuser/move` vers `best_position`
2. `_autofocusWaitFocuser()` jusqu'à arrivée
3. `POST /api/camera/expose` pour capture de vérification
4. `_autofocusWaitImage()` jusqu'à réception
5. Affichage "✅ Terminé"

### Ajout display HFR courant + Position
Ajouté `#af-info-line` dans l'UI avec `#af-curr-hfr` et `#af-curr-pos`.
Pendant le scan, affiche : `HFR: X.XX → meilleur: Y.YY` et `Pos: ZZZZ`.
Mis à jour à chaque step, réinitialisé au start.

### Fichiers modifiés cette session
- `web/static/app.js` : _autofocusWaitImage(), _autofocusFinish(), _autofocusStart() + HFR info line
- `web/static/index.html` : #af-info-line dans af-progress-wrap

## Session 2026-07-28 (fin) — Crosshair cible, tolérance configurable, beep

### Crosshair 2D RA/DEC
Nouvelle fonction `_guideDrawCrosshair()` : vue scatter 2D avec RA horizontale, DEC verticale. Centre = (0,0). Trajectoire complète en points dégradés (alpha). Position courante : croix cyan brillante + point blanc. Boîte de tolérance rouge pointillée. Légende et valeurs numériques.

### Graphique temporel amélioré
`_guideDrawDrift()` repensé : polices bold plus grandes (`10px`), couleurs plus claires (`#999`/`#bbb`), lignes plus épaisses (`2px`), valeur du dernier point affichée sur chaque ligne. Échelle Y dynamique depuis le champ tolérance. Grille 4 divisions. Label `±X″` sur la zone.

### Tolérance configurable
Ajouté champ `#guide-tolerance` (±1–120″, défaut 10″) dans les paramètres de guidage. Contrôle l'échelle du graphique temporel ET la boîte du crosshair.

### Bip de dépassement
`_guideBeep()` : oscillateur Web Audio 880Hz square wave, 0.3s. Déclenché à chaque frame où RA ou DEC dépasse la tolérance.

### Panneau extensible
Bouton **⊕ Cible** dans l'en-tête du panneau dérive pour afficher/masquer la vue crosshair. Panneau élargi à 560px.

### Fichiers modifiés
- `web/static/app.js` : _guideDrawDrift() amélioré, _guideDrawCrosshair() nouveau, _guideBeep(), _guideUpdateUI() crosshair + beep, initGuidePanel() expand btn
- `web/static/index.html` : #guide-tolerance, #guide-crosshair-canvas/wrap, #guide-expand-btn, panel 560px

## Session 2026-07-29 — Calibration fix + guidage + UI

### Fix calibration — Origin des phases retour (EAST/SOUTH)
`GuideCalibration._check_transition()` mesurait la distance depuis le départ de la phase retour au lieu de l'origine réelle, rendant `at_origin` impossible et `went_past` prématuré.
**Correction** : `_original_origin` sauvegardé au début des phases aller (WEST/NORTH) et utilisé pour les phases retour (EAST/SOUTH). Ajout de `set_origin(x,y)` pour fixer l'origine AVANT le premier pulse.

### Fix guide — Drift réactivé après calibration
`_calibrate_set_drift(False)` désactivait la dérive mock pendant la calibration mais `guide_start` ne la réactivait pas. Passage de `asyncio.ensure_future` à `await` pour garantir la synchronisation.

### UI calibration — Panneau agrandi
Panneau 380→520px, polices 0.55→0.75rem, canvas 360×180→500×260. Onglets Graphe/Cible dans le panneau.

### UI guidage — Fenêtre 120s + graduation temporelle
Graphe de dérive : fenêtre glissante remplacée par fenêtre fixe de 120s. Graduation en secondes sur l'axe X.

### Binning guide — Nouveau sélecteur
Ajout binning 1×1/2×2/4×4 dans les paramètres d'autoguidage.

### Épingles — Tous les panneaux
Bouton 📌 dans chaque panneau pour figer la position (cyan = épinglé). Positions épinglées restaurées depuis localStorage.

### Fichiers modifiés
- `indigo/devices/guide_calibration.py` : _original_origin, set_origin()
- `web/server.py` : await _calibrate_set_drift, set-origin endpoint, guide binning
- `web/static/app.js` : calibration graph refactor, tabs, crosshair tab, 120s window, pin buttons, guide binning
- `web/static/index.html` : panel sizes, tabs, binning selector, guide settings width
- `web/static/style.css` : .cal-tab-active

## Session 2026-07-29 (suite) — Aperçu guidage, sélection étoile, workflow

### Aperçu guidage — Panneau dédié
Nouveau panneau `applet-guide-preview` avec canvas 380×240 pour l'affichage de la caméra guide, overlay pour les marqueurs d'étoiles, support asinh stretch.

### Sélection d'étoile — Manuel + Auto + Gaussian quality
- **Manuel** : clic sur l'aperçu → étoile la plus proche sélectionnée → `POST /api/guide/set-reference`
- **Auto** : appelle `focus-metric` → prend la meilleure étoile par `gaussian_quality`
- **Python** `focus_metrics.py` : ajout de `gaussian_quality` (0–1) basé sur SNR, HFR idéal ~2.5px, pénalité saturation. Tri par qualité descendante.
- **JS** `handleGuideImage` refactoré : rendu asinh stretch sur deux canvas (aperçu + vignette)

### Zoom/Pan aperçu
Molette zoom centré souris, clic-glisser pan (quand zoomé), double-clic reset, boutons 1:1 / ◻. Simple clic = sélection étoile.

### Retrait doublons
- Crosshair `_guideDrawCrosshair` supprimé du panneau Autoguidage (la cible reste dans l'onglet Calibration)
- `applet-capture-preview` retiré du mode guiding
- Boutons Rafraîchir/Effacer supprimés (remplacés par zoom controls)

### Fichiers modifiés
- `indigo/devices/focus_metrics.py` : gaussian_quality, tri par qualité
- `tests/test_focus_metrics.py` : test gaussian_quality
- `web/static/app.js` : handleGuideImage refactor, _guideDetectStars, zoom/pan, capture/auto/clear handlers, retrait _guideDrawCrosshair
- `web/static/index.html` : nouveau panneau guide-preview, retrait crosshair du guiding-graph
- `web/static/style.css` : classes .guide-star-marker

## État des tests
- **Via pytest** : 134/134
- **Polar math JS** : 53/53
- **Playwright** : 48 specs (10 fichiers)

## Session 2026-08-05 — Panneau Matériel + profils + roue à filtres (P1)

### Feature — Panneau Matériel indépendant (widget + mode dédié)
- Widget `#applet-hardware` (toujours visible) : liste des devices détectés (icône, statut connecté/hors ligne, rôle via select, bouton CONN/DÉC), commandes Tout connecter / Tout déconnecter / Rafraîchir, statut serveur.
- Mode dédié `#applet-hardware-mode` (bouton 🔧 Matériel) : grand panneau avec liste des devices, sélecteur de device, édition des propriétés (`buildPropsHTML`).

### Feature — Gestion de profils (persistance YAML)
- `indigo/profiles.py` : `ProfileStore` (load/save YAML) ; profil = { monture, caméra, caméra guide, focuser (opt), roue à filtres (opt), optique (opt) }.
- CRUD via `/api/profiles` + activate/delete/apply. `apply` = connecter tous les devices du profil.
- `run.py` : chemin via `INDIGO_PROFILES_PATH` (défaut `profiles.yaml`).

### Feature — Roue à filtres dans la prise de vue
- `indigo/devices/filterwheel.py` : modèle complet — `slots_list()`, `current_slot`, `set_slot()` (switch OneOfMany). Détection par nom (`matches_name`) et propriété (`FILTER_SLOT`).
- Mock INDIGO : device Filter Wheel (CONNECTION + FILTER_SLOT L/R/G/B/Ha), état émis, sélection de slot gérée.
- API : `GET /api/filterwheel` (slots + current), `POST /api/filterwheel/slot`.
- UI Capture : sélecteur « Filtre » (`#cap-filter-select`) alimenté par la roue, champ « Séquence filtres » (ex L,R,G,B) pour la boucle LRGB/NB.
- Boucle capture : `startSequence` alterne les filtres de la séquence à chaque pose (implique `set_slot` avant chaque expo).
- Nommage : `/api/camera/save` produit `capture_{filtre}_{timestamp}.fits`.

### Fix — BLOB/switch parsing
- `indigo/protocol.py` : les switches INDIGO utilisent l'attribut `value` (en plus du texte INDI) → accepté des deux.

### Fichiers nouveaux / modifiés
- Nouveaux : `indigo/devices/filterwheel.py`, `indigo/profiles.py`, `tests/test_filterwheel.py`, `tests/test_hardware_flow.py`, `tests/test_profiles.py`, `tests/hardware-ui.spec.js`
- `indigo/registry.py` : `get_filterwheel()`, classe FilterWheel ajoutée
- `web/server.py` : endpoints hardware/profiles/filterwheel, save avec filtre
- `web/static/app.js` : renderHardwarePanel/HardwareMode, profils, sélecteur filtre + boucle
- `web/static/index.html`, `web/static/style.css` : panneaux + styles

## État des tests (2026-08-05)
- **pytest** : 65/65
- **Flux** : hardware 45/45, guide 38/38, autofocus 34/34, focus 24/24, polar 29/30 (2 flaky pré-existants)
- **Polar math JS** : 53/53
- **Playwright** : 27/27 (viewer + polar + hardware)

## Session 2026-08-08 — Séquence (P2) : moteur, panneau UI, tests ; prép. test à blanc indigo_server

### Feature — Moteur de séquence d'acquisition (`indigo/devices/sequence.py`)
- `SequenceRunner` pur async : `start(plan)` → `run(hooks)` → pose par pose (**set_filter → expose → wait image → save FITS → dither**), avec `pause/resume/stop/reset`, `status()` (running, done, total, current, last_error, last_saved, last_dither, progress).
- Hooks injectés par le serveur (le module reste device-agnostic) : `expose`, `wait_exposure`, `set_filter`, `save`, `dither`, `delay`, `log`.
- `camera.py` : flag `exposing` (CCD_EXPOSURE Busy→Ok) = détection de fin de pose.
- **Correction race BLOB** : le BLOB arrive souvent APRÈS le passage Busy→Idle. `wait_exposure` poll désormais jusqu'à l'arrivée d'une **image fraîche** de la caméra exposée (baseline par pose), puis petit settle.
- Endpoints : `GET /api/sequence/{status,defaults}`, `POST /api/sequence/{start,stop,pause,resume,reset}`. `start` refuse un plan vide (fix : `frames=[]` ≠ config par défaut).
- Config : bloc `sequence:` dans `config.yaml` (`save_dir`, `dither {enabled, amount}`, `frames` par défaut).

### Feature — Panneau « SÉQUENCE » (mode Capture)
- `#applet-sequence` : table de poses éditable (Type/Durée/Filtre/×/Pause), ajout/retrait de ligne, boutons ▶ DÉMARRER / ⏸ Pauser / ▶ Reprendre / ⏹ STOP / ⟲ Reset, barre de progression `n/total`, pose courante, statut dither, dernier fichier, erreur.
- Poll `/api/sequence/status` 1 s (l'option « pousser via WS » reste ouverte → à faire si besoin).
- `config.yaml` : défauts de plan chargés via `/api/sequence/defaults`.

### Tests ajoutés
- `tests/test_sequence.py` (10 unitaires) : totaux, validation, groupement de paths, états du runner (ordre, pause/resume, stop, erreurs, reset).
- `tests/test_sequence_flow.py` (26 checks, `python tests/test_sequence_flow.py`) : mock INDIGO, run 2 poses jusqu'au bout, FITS sur disque, dither, pause/resume/reset, stop en cours.
- `tests/sequence-ui.spec.js` (3 Playwright) : rendu panel, run 2 poses avec progression + sauvegarde + log, stop en cours.
- Suites complètes : pytest **134**, Playwright **48 specs**, flow séquence **26**.

### Préparation — Test à blanc avec `indigo_server` (devices simulateurs)
- `indigo_server` v2.0-374 est installé ; les drivers simulateurs sont présents dans `/usr/bin/`.
- **Protocole vérifié** : le client du projet (XML brut sur TCP) répond sur `indigo_server` 2.x (probe → `defTextVector`…). Port dédié `-p`.
- Commandes de lancement validées → `PLANS/plan_test_blanc_simulators.md`.

### Commit du jour
- `7032b55` feat: sequence engine + SÉQUENCE panel (P2)
- `d54b626` feat: hardware mode rework — per-role device selectors (P1)
- `80f915a` test: deterministic LST
- `a84259f` fix: reject empty sequence plan
- `c93a148` test: sequence unit + flow + Playwright (P2)

## Session 2026-10-22 — Gestion du serveur (indiserver/indigo_server)

### Feature
- Support de `indiserver` ou `indigo_server` via `server_type` et `auto_start` dans `config.yaml`.
- Implémentation de `indigo/server_manager.py` pour gérer le cycle de vie des processus serveurs (start/stop/monitor).
- Intégration dans `run.py` pour démarrer le serveur si `auto_start` est activé et l'arrêter proprement à la fermeture.

### Validation
- `run.py` syntax OK.
- `ServerManager` implémenté.
- `config.yaml` mis à jour.
