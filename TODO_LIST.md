# TODO List — Prochaines étapes

## Faits
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

## À tester
- [ ] Live stacking réel : session continue (max_frames=0) STOP manuel, aperçu empilé mis à jour en direct
- [ ] Live stacking avec dark/flat : masters po seulement si les dossiers sont renseignés (sinon aucune calibration)
- [ ] Sauvegarde master (FITS + PNG) après une session terminée dans `livestack_TS/`
- [ ] Fichiers `capture_TS/{filtre}/` bien séparés de `livestack_TS/`
- [ ] **CR « Étoile perdue »** : re-tester calibration après Ctrl+Shift+R (hypothèse cache navigateur stale `app.js`). Si reproduit → fournir log mock + log serveur (`run.py`) pendant l'échec
- [ ] Courbe SNR jaune visible pendant un guidage réel (mock ou caméra)
- [ ] Toast « Calibration terminée » + bouton « Démarrer guidage »
- [ ] Calibration : vérifier tracé correct + auto-population gains
- [ ] Guidage : clic étoile → Capture → Auto → Lancer → graphe 120s
- [ ] Zoom/Pan : molette, clic-glisser, double-clic reset, 1:1 / ◻
- [ ] **BUG** Aperçu GUIDAGE : `WS image: ... match=true` mais pas d'image affichée dans le panneau. Le `handleGuideImage` est appelé, la caméra envoie `.fits`. Vérifier si le rendu canvas fonctionne (observer console.log + status bar après refresh).

## Améliorations possibles
- [ ] Live stacking : push du statut (accepted/rejected) via WebSocket au lieu du poll 1 s
- [ ] Live stacking : bouton « sauver le master » auto à la fin d'une session avec cible
- [ ] Sauvegarde des masters dans le root partagé (sous-dossier `masters/`)
- [ ] Réduire les violations requestAnimationFrame (sky chart canvas lourd)
- [ ] Découper `app.js` en modules séparés

## Planifiés (décision 2026-08-04, cf. COMPARISON_NINA.md)

### P0 — Meridian flip
- [ ] Détection de proximité du méridien (position monture + heure sidérale) en amont du flip
- [ ] Séquence : halt guidage → pause capture → flip (slew → côté opposé) → re-centrage (solve) → reprise guidage → reprise capture
- [ ] État/indicateur dans l'UI + option automatique/manuel dans un mode « session »

### P1 — Roue à filtres dans la prise de vue
- [x] Device FilterWheel côté INDIGO (modèle + sélecteur dans le panneau matériel)
- [x] Intégration dans la prise de vue : sélecteur de filtre, positions nominales (roue motorisée) / focale
- [x] Nommage des fichiers par filtre (`capture_{filtre}_*.fits`) + boucle capture par filtre (LRGB/NB via séquence)

### P1 — Gestion de profils + panneau matériel indépendant
- [ ] Profil = { monture, caméra, caméra d'autoguidage, focuser (optionnel), roue à filtres (optionnel), optique (optionnel) }
- [ ] Persistance des profils (fichier YAML/JSON) + sélection/suppression dans l'UI
- [ ] Panneau matériel indépendant : état des devices (connecté/erreur), connexion **élément par élément** ou **tout d'un coup**
- [ ] Binding profil ↔ connexion : appliquer un profil = connecter son set de devices

## Notes techniques
- Le serveur Python doit être redémarré manuellement par l'utilisateur
- Les JS sont servis en statique, un simple refresh suffit après modification
- Flow tests : exécuter via `python tests/test_X_flow.py` (pas pytest)
- Tests : `python tests/test_autofocus.py && python tests/test_autofocus_flow.py && python tests/test_guide_flow.py`
- Suite : `python -m pytest tests/ -q && node tests/test_polar_math.js`
