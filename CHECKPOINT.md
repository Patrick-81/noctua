# Checkpoint — Noctua (autoguidage + contrôle INDIGO)

## Projet
`Noctua` : interface web (FastAPI + Vanilla JS) pour contrôle d'équipements astronomiques via serveur INDIGO.

## Architecture
INDIGO Server → Python FastAPI backend → Browser UI (Vanilla JS)
L'autoguidage est orchestré par le frontend : expose guide camera → mesure centroïde → corrige la monture.

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
- Suites complètes : **pytest 105** ✓, flow séquence **27** ✓, flow live-stack **23** ✓, **Playwright 34** ✓, `node --check app.js` ✓.

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
- **Via pytest** : 52/52
- **Polar math JS** : 53/53
- **Playwright** : à jour via `npx playwright test` (specs viewer-ui + polar-ui)

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
- Suites complètes : pytest **91**, Playwright **32**, flow séquence **26**.

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
