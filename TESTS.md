# Plan de tests — Polar Alignment

## Couche 1 : Validation mathématique (automatisé, rapide) ✅ 53/53
- [x] Extraire les fonctions polar (`_polarComputeTargets`, `polarCompute`) dans un module JS testable
- [x] Tests LST, normalisation d'angle, format sexagésimal
- [x] Tests targets (4 angles : 5min, 30min, 60min, 120min)
- [x] Tests vecteurs unitaires, fit circulaire (cross product)
- [x] Tests polarCompute : alignement parfait, vérification formule erreur
- [x] Tests cas dégénérés : points équatoriaux, doublons → NaN, quasi-doublons
- [x] Fichiers : `tests/polar_math.js`, `tests/test_polar_math.js`
- [x] Exécution : `node tests/test_polar_math.js` → 53/53

## Couche 2 : Mock INDIGO + images de test (automatisé, moyen) ✅ 30/30
- [x] `tests/mock_indigo.py` : serveur INDIGO minimal TCP (slew, tracking, park, abort, GET position)
- [x] `tests/test_polar_flow.py` : orchestrateur (lance mock + web server, vérifie résultats)
- [x] Endpoint `POST /api/test/fits-store` (injection FITS en base64 + effacement avec data vide)
- [x] Test 1 : Mount control (unpark, tracking, slew, abort, park) — 12/12
- [x] Test 2 : FITS injection + plate solve — 4/4 (29 matches, Andromède)
- [x] Test 3 : Séquence polar 3 étapes (slew+solve × 3) — 6/6
- [x] Test 4 : Cas d'erreur (empty image + slew valid) — 2/2
- [x] Fix : multi-line XML buffering, sexagésimal parsing, send_state async, fits-store clear
- [x] Exécution : `source venv/bin/activate && python tests/test_polar_flow.py` → 30/30

## Couche 3 : Tests UI avec Playwright (automatisé, lent) ✅ 10/10
- [x] Installer Playwright (`npm init -y && npm i -D @playwright/test`, chromium)
- [x] Config : `playwright.config.js` (headless chromium, 1 worker)
- [x] Test : panel visible en mode astrométrie, caché en mode Pilotage
- [x] Test : mode Auto → boutons "Capturer" cachés, "Démarrer" visible
- [x] Test : mode Manuel → boutons "Capturer" visibles, "Démarrer" caché
- [x] Test : changement d'angle → labels mis à jour (min→hours conversion)
- [x] Test : boutons mount (Tracking ON, Unpark, Stop) existent
- [x] Test : clic "Tracking ON" → appel API envoyé + état vérifié
- [x] Test : clic "Unpark" → appel API envoyé + état vérifié
- [x] Test : Reset → step statuses cleared, results/progress hidden
- [x] Test : angle input min/max constraints (5-120, défaut 30)
- [x] Fichiers : `tests/polar-ui.spec.js`, `playwright.config.js`
- [x] Exécution : `npx playwright test` → 10/10

## Couche 4 : Protocole de test manuel (document) ✅
- [x] Rédiger le guide pas-à-pas avec le mock INDIGO — `tests/MANUAL_TESTS.md`
- [x] Test 1 — Mode Auto complet (3 GOTO + solve → résultats)
- [x] Test 2 — Mode Manuel (captures individuelles)
- [x] Test 3 — Changement d'angle (labels min↔hours)
- [x] Test 4 — Abort au milieu
- [x] Test 5 — Reset après séquence
- [x] Test 6 — Switch mode pendant séquence
- [x] Test 7 — Vérification requêtes réseau
