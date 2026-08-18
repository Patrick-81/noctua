# TODO List — Prochaines étapes

## Faits
- [x] Bus de messages pub/sub `events.js` (9 topics, registre + validation dev) : ws.js = traducteur, abonnements posés dans api/preview/mount/capture/focuser/solver/target/guide/hardware/app/calibration, gardes `typeof` supprimées — **Playwright 36/36 ✓, pytest 105/105 ✓** (cf. section « Bus de messages events.js » de CHECKPOINT.md)
- [x] 3 topics bus câblés : `capture:progress` (capture.js émet — exclusion caméra + progression en direct dans séquence/stacking, toast fin de capture dans app), `mount:slewed` (mount.js émet sur fin de slew, target.js relance la boucle de centrage), `guide:starSelected` (guide.js abonné — médaillon recentré) — Playwright 36/36 ✓, pytest 105/105 ✓
- [x] Live stacking automatisé : panneau LIVE STACKING dédié (poses courtes, compteur `max_frames` 0=continu, dark/flat optionnels)
- [x] Séparation claire capture / stacking : SÉQUENCE = poses unitaires dans `<root>/capture_TS/`, LIVE STACKING = `<root>/livestack_TS/`
- [x] Répertoire racine unique partagé (`sequence.save_dir`) + sous-dossiers horodatés typés par processus
- [x] Session stacking auto : boucle expose→save FITS→push empileur→snapshot WS, arrêt sur cible atteinte ou STOP
- [x] Masters dark/flat optionnels appliqués à chaque pose (calibration avant empilement)
- [x] Doc UTILISATION.md : table des deux processus + sections 8.3/8.4 + arborescence
- [x] Robustesse UI : détection fin de séquence par compteurs (run rapide entre deux polls)
- [x] RMS AD/DEC/Total (fenêtre 60 s) dans le panneau Dérive
- [x] Courbe SNR jaune superposée au canvas de dérive (axe droit 0/25/50)
- [x] Impulsions de correction dans le panneau Dérive (même ligne Trames/RA/DEC)
- [x] Popup confirmation calibration + bouton « Démarrer guidage » en un clic
- [x] Durcissement calibration : retry focus-metric 3× avant « Étoile perdue »
- [x] Robustesse BLOB/FITS tronqués (discard / image partielle)
- [x] Rendu asinh fond noir / étoiles blanches
- [x] Simulation de dérive guide caméra dans mock_indigo.py
- [x] Phase 5 Autofocus : boucle complète (move→expose→measure→finish→move→verify)
  - [x] _autofocusWaitImage() : stub → attente réelle via exposure_time
  - [x] _autofocusFinish() : move to best + vérification capture
  - [x] HFR courant + position affichés pendant le scan
- [x] Crosshair cible RA/DEC + graphique temporel amélioré
- [x] Tolérance configurable (±1–120″) + beep de dépassement
- [x] Panneau extensible (bouton ⊕ Cible pour crosshair)
- [x] Calibration : origine vraie (set_origin), _original_origin pour phases retour
- [x] Calibration : graphe avec échelle fixe (target_px*2), onglets Graphe/Cible
- [x] Guidage : fenêtre temporelle 120s, graduation en secondes
- [x] Binning guide : sélecteur 1×1/2×2/4×4 dans paramètres guidage
- [x] Épingles : 📌 sur tous les panneaux mobiles (positions sauvegardées)
- [x] Gaussian quality pour sélection étoile guide (SNR, HFR, saturation)
- [x] Aperçu guidage : capture, marqueurs étoiles, clic sélection, zoom/pan
- [x] Workflow : Aperçu → Capture → Sélection étoile → Calibration → Guidage
- [x] Temps de pose idéal : bouton « Mesurer le ciel » → pose test, mesure du fond en ADU/s (BZERO/BSCALE gérés), extrapolation vers `exposure.target_bg`, garde anti-saturation (SNR projeté, bornes min/max) — `indigo/devices/exposure.py`, `/api/camera/exposure/{estimate,recommend}`, badge dans le panneau Capture — **`test_exposure.py` ✓, pytest 112/112 ✓, Playwright 39/39 ✓**
- [x] Mode multi-prises « Mesurer le ciel » : sélecteur 1/3 prises dans le panneau Capture, backend `estimate_exposure_multi` (fit linéaire ADU(t)=bias+m·t par moindres carrés, bias-indépendant, détection de knee de saturation avec cap empirique, R², fallback 1 prise), frames réutilisées par `/recommend` (`_last_exposure_frames`), mock INDIGO avec fond de ciel ∝ durée de pose, affichage reco mode-aware (pente ADU/s, linéarité R², warning non-linéaire) — **`test_exposure.py` 45/45 ✓, pytest 117/117 ✓, Playwright 42/42 ✓**
- [x] Fluidité de la skymap + catalogues enrichis : suppression du throttle 80 ms (`sky-engine.js` → rendu coalescé rAF, drag/zoom ~60 FPS), projection rapi**de** des étoiles (`web/static/sky-projection.js` : vecteurs unitaires + produits scalaires, sans d3 par étoile ; `fillRect` fast-path ; plafonnement à 7000 étoiles dessinées les plus brillantes d'abord), cache de positions des DSO (clé rotation+mag+échelle+catalogues), chargement de `stars.8.json` (41 411 étoiles, slider mag 6→8 enfin effectif), recherche d'objets enrichie (dsos.6.json complet 3 311 DSO + noms multilingues depuis `dsonames.json`, recherche en français) — parité vérifiée contre `d3.geo.orthographic` par `tests/sky-projection.spec.js` (3 tests) — **pytest 117/117 ✓, polar JS 53/53 ✓, Playwright 43/44 ✓** (1 flake pré-existant session-ui dépendant de l'heure)

## À tester
- [x] Live stacking réel : session continue (max_frames=0) STOP manuel, aperçu empilé mis à jour en direct → `test_live_stack_flow.py::test_continuous_session_manual_stop`
- [x] Live stacking avec dark/flat : masters po seulement si les dossiers sont renseignés (sinon aucune calibration) → `test_calibration_only_with_dirs`
- [x] Sauvegarde master (FITS + PNG) après une session terminée dans `livestack_TS/` → inclus dans `test_continuous_session_manual_stop`
- [x] Fichiers `capture_TS/{filtre}/` bien séparés de `livestack_TS/` → `test_dirs_filters_separation`
- [x] **CR « Étoile perdue »** : re-tester calibration après Ctrl+Shift+R (hypothèse cache navigateur stale `app.js`). Si reproduit → fournir log mock + log serveur (`run.py`) pendant l'échec → **non reproductible** : calibration re-testée après refresh complet, retry focus-metric 3× vérifié (échecs transitoires injectés), gains auto + toast confirmés par `tests/guide-validation.spec.js`
- [x] Courbe SNR jaune visible pendant un guidage réel (mock ou caméra) — testé : historique `/api/guide/status` porte le SNR, canvas drift dessiné
- [x] Toast « Calibration terminée » + bouton « Démarrer guidage »
- [x] Calibration : vérifier tracé correct + auto-population gains
- [x] Guidage : clic étoile → Capture → Auto → Lancer → graphe 120s
- [x] Zoom/Pan : molette, clic-glisser, double-clic reset, 1:1 / ◻ — **fix** : double-clic en mode guidage cliquait `#cap-zoom-enlarge` (panneau capture) au lieu de reset le zoom (`Viewer.initZoomPan`, app.js)
- [x] **BUG** Aperçu GUIDAGE : `WS image: ... match=true` mais pas d'image affichée dans le panneau. Le `handleGuideImage` est appelé, la caméra envoie `.fits`. Vérifier si le rendu canvas fonctionne (observer console.log + status bar après refresh). → **non reproductible** : `tests/repro_guide_preview.js` (canvas 640×480, détection 50 étoiles, status «✨ 50 étoiles»). Cosmétique : `console.log` ligne 968 affiche les `%s` non substitués (sans impact).

## En chantier — Internationalisation FR/EN + mobile/tablette (session interrompue le 2026-08-12)

État du travail non commité (`git status` : app.js, index.html, style.css, start.sh modifiés + fichiers non suivis).

### Internationalisation (FR/EN) — fait
- [x] `web/static/i18n.js` (nouveau, ~950 l) : dictionnaires fr/en complets, détection langue navigateur, persistance JSON localStorage, API `I18N.t()` / `I18N.tfmt()` / `apply()` / `setLang()`
- [x] `index.html` : balisage `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` sur l'ensemble de l'UI statique + chargement de `i18n.js` avant `app.js`
- [x] `app.js` : shims locaux `i18n()`/`i18nFmt()`, sélecteur de langue `#i18n-lang` (initI18nSelector), ~31 messages `addLog` migrés vers des clés i18n
- [x] Vérification croisée : les 311 clés référencées existent bien dans les 2 dictionnaires (fr + en) — script de contrôle OK

### Internationalisation — restant
- [x] **~28 messages** `addLog` encore en français littéral — migrés (balayage des 14 modules JS, 0 littéral restant vérifié)
- [x] Vérifier boutons/places restantes sans `data-i18n` — balayé (résiduel volontaire hors périmètre : logs console dev dans events.js, commentaire state.js, labels de scénarios testharness.js)
- [x] Mettre à jour `docs/UTILISATION.md` (mention sélecteur de langue, fichiers i18n)

### Mobile / tablette — fait
- [x] Icônes PWA/favicons (favicon.svg/ico/png, icon-16/32/64/192/256, apple-touch-icon) + `index.html` head lié
- [x] Vueport mobile : layout des panneaux clampé dans le viewport — `resolvePanelLayout()`/`sanitizePanelLayout()` + refacto `checkOverlap` (app.js), panneaux glissables cantonnés (margin + blocage overlap via `getBlockingRects`)
- [x] Media query `@media (max-width: 768px)` existante (style.css) pour barre modes/connexion/panneaux
- [x] Live stacking sorti des applets auto-visibles du mode capture → **bouton toggle** `#cap-stacking-toggle` + classe `.stacking-on` (style.css)

### Mobile / tablette — restant
- [x] Vérifier que le toggle stacking se ré-affiche correctement après un changement de mode capture — **fix** : état `_stkPanelHidden` persisté et ré-appliqué sur `mode:changed`, indicateur `.stacking-on` resynchronisé → `tests/stacking-toggle.spec.js`
- [x] Optionnel : manifest.json PWA + thème couleur — `manifest.webmanifest` + `icon-512.png` généré, `theme-color` #020205, servis avec le bon MIME

## Améliorations possibles
- [x] Live stacking : push du statut (accepted/rejected) via WebSocket au lieu du poll 1 s — commit `9350475`
- [x] Live stacking : bouton « sauver le master » auto à la fin d'une session avec cible — auto-save dans `<root>/masters/` + `master_path` exposé dans le statut (WS + `/api/stacking/status`)
- [x] Sauvegarde des masters dans le root partagé (sous-dossier `masters/`) — `save_master()` route vers `<dir>/masters/`
- [x] Réduire les violations requestAnimationFrame (sky chart canvas lourd) — sky-engine.js : étoiles projetées en un seul `path`+`fill` batchées avec cache des positions (clé rotation+mag+échelle, réutilisé entre ticks sidéraux), graticule/équateur/écliptique/horizon mis en cache dans `init()`, Voie lactée décimée au chargement (30676 → 6142 points, cap 40/anneau) — rendu mesuré (1280×720, mag 6, headless Chromium, médiane 8 itérations) : sweep 20.9 → 10.8 ms, MW seul 16 → ~5 ms
- [x] **Découpage `app.js` (terminé)** : `state.js` (état/config), `viewer.js` (classe Viewer), `layout.js` (layout + `ChecklistPanel`), `utils.js` (i18n + helpers purs + `sleep`), `api.js` (API/log/toasts), `mount.js` (panneau + commandes monture), `controls.js` (D-pad/boutons/joystick), `ws.js`, `objects.js`, `hardware.js`, `capture.js`, `sequence.js`, `stacking.js`, `preview.js`, `testharness.js`, `solver.js`, `target.js`, `polar.js`, `focuser.js`, `guide.js`, `calibration.js` — **app.js 7720 → 457 lignes**, scripts classiques globals chargés avant app.js, tous modules ≤ 1000 lignes, Playwright **36/36 ✓**
- [x] Supprimer `web/static/app.js.refactored` (brouillon de la refonte totale, obsolète) + ignorer `backups/`

## Planifiés (décision 2026-08-04, cf. COMPARISON_NINA.md)

### P0 — Meridian flip
- [x] Détection de proximité du méridien (position monture + heure sidérale) en amont du flip — commit `aca49d7`
- [x] Séquence : halt guidage → pause capture → flip (slew → côté opposé) → re-centrage (solve) → reprise guidage → reprise capture — commit `aca49d7`
- [x] État/indicateur dans l'UI + option automatique/manuel dans un mode « session » — commit `aca49d7`

### P1 — Roue à filtres dans la prise de vue
- [x] Device FilterWheel côté INDIGO (modèle + sélecteur dans le panneau matériel)
- [x] Intégration dans la prise de vue : sélecteur de filtre, positions nominales (roue motorisée) / focale
- [x] Nommage des fichiers par filtre (`capture_{filtre}_*.fits`) + boucle capture par filtre (LRGB/NB via séquence)

### P1 — Gestion de profils + panneau matériel indépendant
- [x] Profil = { monture, caméra, caméra d'autoguidage, focuser (optionnel), roue à filtres (optionnel), optique (optionnel) } — commit `5fec1b1`
- [x] Persistance des profils (fichier YAML/JSON) + sélection/suppression dans l'UI — commit `5fec1b1` (`ProfileStore`, `/api/profiles` CRUD)
- [x] Panneau matériel indépendant : état des devices (connecté/erreur), connexion **élément par élément** ou **tout d'un coup** — commit `5fec1b1`
- [x] Binding profil ↔ connexion : appliquer un profil = connecter son set de devices — commit `5fec1b1` (`/api/profiles/apply`)

## Notes techniques
- Le serveur Python doit être redémarré manuellement par l'utilisateur
- Les JS sont servis en statique, un simple refresh suffit après modification
- Flow tests : exécuter via `python tests/test_X_flow.py` (pas pytest)
- Tests : `python tests/test_autofocus.py && python tests/test_autofocus_flow.py && python tests/test_guide_flow.py`
- Suite : `python -m pytest tests/ -q && node tests/test_polar_math.js && python tests/test_exposure.py`
