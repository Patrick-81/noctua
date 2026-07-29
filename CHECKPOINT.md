# Checkpoint — Autoguidage Viewer + Corrections Display

## Projet
`indigo_devices` : interface web (FastAPI + Vanilla JS) pour contrôle d'équipements astronomiques via serveur INDIGO.

## Architecture
INDIGO Server → Python FastAPI backend → Browser UI (Vanilla JS)
L'autoguidage est orchestré par le frontend : expose guide camera → mesure centroïde → corrige la monture.

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
- **Via pytest** : 50/50
- **Guide flow (main)** : 38/38
- **Autofocus flow (main)** : 34/34
- **Playwright** : 19/19
- **Polar math JS** : 53/53
- **Total : 194/194**
