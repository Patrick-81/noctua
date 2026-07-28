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

## État des tests
- **Via pytest** : 50/50 (incl. 16 autofocus unit)
- **Guide flow (main)** : 38/38
- **Autofocus flow (main)** : 34/34
- **Playwright** : 19/19
- **Polar math JS** : 53/53
- **Total : 194/194****
