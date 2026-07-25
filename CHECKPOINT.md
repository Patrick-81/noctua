# CHECKPOINT — 24 juillet 2026

## État actuel
SVBONY SV305PRO **connectée et fonctionnelle** : `connected=True`, `is_ready=True`, 1920×1080, 2.9µm pixel. 30 propriétés CCD reçues.
**Capture live fonctionne** : exposition → FITS → image dans le canvas preview.
**Carte céleste** : drag avec verrous alt/az corrigé, culling, filtrage catalogues OK.
**Logs propres** : 5 devices échouent proprement en ~1min, puis silence totalet.
**Plate Solver** : Seiza intégré — résolution hinted (rapide) et blind, auto-hint monture+caméra, résultats WS temps réel.
**Tests solver** : 33/33 tests passent — FITS parsing, détection étoiles, résolution hinted, précision sur champs synthétiques.
**Viewer FITS** : Affichage corrigé — auto-stretch percentile (p1/p99) au lieu du linéaire min/max qui rendait les images noires.
**Solver status** : Refresh avec retry (2 tentatives) + refresh automatique au passage en mode astrométrie.

## Changements majeurs (session 24 juillet — suite)

### Fix affichage FITS dans le viewer
- **Bug** : Les images FITS apparaissaient noires/grises bruitées
- **Cause** : Stretch linéaire min→max avec des images astronomiques à haute dynamique (fond ~50, étoiles ~31000) → le fond mappe à ~0/255
- **Fix** : Auto-stretch percentile (p0.5 / p99.5) au lieu de min/max — les étoiles restent visibles
- **Parser FITS JS** : END keyword détecté via carte 80 chars (pas `includes('END')` qui matchait `EXTEND`)
- **Regex headers** : Parser card-by-card (80 chars) au lieu de regex sur la string entière — plus robuste

### Fix solver status UI
- **Bug** : Bouton solver grisée "Seiza non installé" malgré API retournant `available:true`
- **Cause** : `refreshSolverStatus()` appelé une seule fois à l'init, jamais repris en cas d'échec
- **Fix** : Retry (2 tentatives, 500ms delay) + refresh automatique quand on passe en mode astrométrie

### Fix générateur images synthétiques
- **Bug** : `hash(field_name)` non-déterministe (PYTHONHASHSEED) → positions étoiles changeaient à chaque génération
- **Fix** : Seed déterministe `int.from_bytes(field_name.encode()) % 10000`
- **Bug** : Ligne NAXIS dupliquée dans l'header FITS
- **Fix** : Supprimé, padding simplifié (36 cards × 80 = 2880)
- **Fix Orion** : Centre déplacé (-1.5 → -1.0), scale augmenté (2.5 → 3.0) pour capturer plus d'étoiles bright dans le FOV

## Changements majeurs (session 24 juillet)

### Plate Solver Seiza
- **Librairie** : Seiza (Rust/Python) — résolution de plaques haute performance
- **Documentation** : `docs/seiza.md` — API Python, CLI, catalogues, intégration
- **Backend** : `indigo/devices/solver.py` — wrapper Seiza avec detect/solve/solve_blind
- **Parsing FITS** : parser natif (sans astropy) — support BITPIX 8/16/32/64, END keyword correct, cards 80 chars
- **Détection étoiles** : sigma=2.0 par défaut (au lieu de 4.0) pour meilleure sensibilité
- **API routes** :
  - `GET /api/solver/status` — état du solver
  - `POST /api/solver/catalogs` — charger les catalogues
  - `POST /api/solver/solve` — résoudre une image (+ paramètre `sigma`)
- **Auto-hint** : position monture (RA/DEC) + échelle caméra (pixel_size/focal_length)
- **Modes** : hinted (rapide, <1s) et blind (lent, 5-30s)
- **Frontend** : applet-solver complet avec :
  - Sélection mode (Indice/Blind)
  - Paramètres auto/manuels
  - Barre de progression
  - Résultats (RA/DEC/rotation/échelle/étoiles/RMS/FoV)
  - Boutons SYNC monture + Centrer carte
  - Status LED (Seiza prêt/catalogues/erreur)
- **WebSocket** : broadcast résultats solver en temps réel
- **Styles** : glass morphism cohérent avec le reste de l'UI

### Tests Solver
- **Générateur images synthétiques** : `tests/generate_test_images.py` — 10 champs test (Orion, Pléiades, M42, Gémeaux, Grande Ourse, Cygne, Scorpion, Cassiopée, Andromède, grand champ)
- **Suite de tests** : `tests/test_solver.py` — 33 tests (parsing FITS, détection étoiles, résolution hinted, précision multi-champs)
- **Doc images** : `tests/fake_sky/README.md` — catalogue des images synthétiques
- **Fix bugs** :
  - Parser FITS : END keyword détecté incorrectement → re-parser carte par carte
  - Attribut `solution.rms` → `solution.rms_arcsec` (API Seiza)
  - Attribut `solution.matches` → `solution.matched_stars`
  - Seuil sigma trop strict (4.0) → 2.0 pour images propres

### Overlay canvas — Vecteur décalage viewer
- **Canvas overlay** : `#offset-overlay-canvas` dans `#cap-preview-viewport`, synchronisé avec le zoom/pan du viewer
- **Vecteur de décalage** : dessine une flèche cyan du centre (position résolue) vers la cible
  - Longueur proportionnelle au décalage RA/DEC (en arcmin)
  - Rotation image appliquée pour orientation correcte
  - Étiquette distance avec fond lisibilité
  - Réticule cible (cercle+croix orange) à la pointe du vecteur
  - Flèches cardinales N/E tournées selon la rotation
- **Fonctions JS** :
  - `setOffsetTarget(ra, dec)` — définit la position cible
  - `setOffsetSolved(ra, dec, scale, rotation)` — définit la position résolue
  - `drawOffsetVector()` — dessine le vecteur sur l'overlay
  - `clearOffsetOverlay()` — efface l'overlay
  - `window.setOffsetTarget()` — exposé globalement pour sky-engine
- **Menu contextuel carte** : bouton "◎ Définir cible" ajouté dans sky-engine.js
- **Nettoyage automatique** : overlay effacé à chaque nouvelle image capturée
- **Visibilité mode** : overlay visible uniquement en mode astrométrie

### Test harness (pas de caméra nécessaire)
- **Endpoints serveur** :
  - `GET /api/test/fits-list` — liste les 10 images FITS synthétiques disponibles
  - `GET /api/test/fits/{filename}` — retourne l'image en base64 pour le viewer
- **Bouton 🧪** dans le panneau solver — dropdown avec la liste des images de test, clic pour charger
- **Fonctions JS** (console `_testHarness`):
  - `loadTestFITS('test_orion.fits')` — charge une image dans le viewer
  - `mockSolveResult(ra, dec, scale, rotation)` — simule un résultat solver
  - `mockSetTarget(ra, dec)` — définit la cible
  - `testOverlayScenario('north|east|southeast|rotated|small|large')` — scénarios prédéfinis
- **Scénarios** : 6 cas test (N, E, SE, image rotée, petit offset, grand offset)

## Changements majeurs (session 23 juillet)

### Fix auto-connect SVBONY SV305PRO
- **Bug racine** : `_schedule_connect()` envoyait toujours `{"name": "CONNECT"}` mais le driver SVBONY utilise `CONNECTED` comme nom d'item
- **Fix** : récupère le vrai nom d'item depuis `defConnection` et le passe à `_schedule_connect`
- **Stockage** : propriété CONNECTION stockée dans `_properties` avant le return précoce
- **Retry** : gestion des Alert avec max 3 retries, 5s delay entre chaque
- **UI** : bouton "CONNECTER" manuel + endpoint `POST /api/device/connect`

### Fix auto-connect retry storm (session 23 juillet — suite)
- **Bug racine** : deux mécanismes de retry se cumulaient (`_auto_connect_retry_loop` dans server.py + Alert retry dans registry.py) → boucle exponentielle infinie pour les devices qui ne peuvent pas connecter (AAG CloudWatcher, CCD File Simulator)
- **Bug racine 2** : INDIGO server envoie `set CONNECTION (Ok)` puis immédiatement `set CONNECTION (Alert)` → le Ok resettait les retries à 0 → cycle infini
- **Fix 1** : supprimé `_auto_connect_retry_loop` (redondant avec Alert retry)
- **Fix 2** : `pv.state == "Alert"` prend priorité sur la valeur de l'item (même si `CONNECTED=On`, un Alert = échec)
- **Fix 3** : `_confirm_connection` différé de 3s pour laisser le temps au Ok de se confirmer
- **Fix 4** : cooldown 60s (`_connect_gave_up`) — après 3 échecs, le device est ignoré pendant 60s
- **Fix 5** : `_connect_retries` persiste entre les cycles `_on_def` (pas de reset à 0)
- **Fix 6** : guard `_connect_gave_up` dans le handler Alert empêche de relancer après give-up
- **Résultat** : 5 devices échouent proprement en ~1min, puis silence total (218 lignes au lieu de milliers)

### Logs épurés
- 15+ logs INFO downgrade vers DEBUG (BLOB, CONNECTION, def property, exposure, WS events, delProperty, device discovery/upgrade)
- Les logs INFO ne polluent plus le terminal
- Fix WS crash : `ValueError` sur `_ws_clients.remove(ws)` quand WS déjà supprimé (race condition)

### Fix config UI
- Flag `_initDone` empêche `saveUiConfig()` pendant l'initialisation
- La config n'est plus écrasée par `switchMode()` au chargement

### Preview redimensionnable
- Poignée `⣿` bas-droite, drag horizontal pour ajuster la largeur
- Positions sauvegardées dans `ui.yaml`

### Histogramme
- Canvas histogramme 256 bins (log scale) sous l'image
- Slider "Noir" pour le point noir (0-100%)
- Bouton AUTO toggle extension auto vs manuelle
- Stretch appliqué en temps réel sur le canvas
- État persisté dans `ui.yaml` par mode

### Sauvegarde images
- Input répertoire + bouton "Sauver" dans le panneau capture
- Endpoint `POST /api/camera/save` — crée le dossier, fichier `capture_YYYYMMDD_HHMMSS.fits`
- Dernière image stockée côté serveur (`_last_image_data`)

### Carte céleste
- Drag avec verrous alt/az (Zénith = vertical, E/O = horizontal) — **FIXÉ**
- Culling hors-écran pour les étoiles
- Filtrage catalogues vérifié avec données réelles

### Capture live
- Exposition → FITS → image dans le canvas preview — **FONCTIONNEL**
- Reste : zoom/pan/agrandissement viewer

## Architecture cible

```
MODE: PILOTAGE
  [commun] connection, coords, legend, log
  [monture] status, joystick, commands, hud, search

MODE: FOCUSER
  [commun] connection, coords, legend, log
  [focuser] control, position

MODE: AUTOGUIDAGE
  [commun] connection, coords, legend, log
  [guiding] graph, settings, stats

MODE: CAPTURE
  [commun] connection, coords, legend, log
  [capture] settings, preview (resize + histogram), sequence, countdown, save

MODE: ASTROMÉTRIE
  [commun] connection, coords, legend, log
  [astrometry] solver, polar
```
