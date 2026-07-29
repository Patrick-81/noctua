# TODO List — Prochaines étapes

## Faits
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
- [ ] Calibration : vérifier tracé correct + auto-population gains
- [ ] Guidage : clic étoile → Capture → Auto → Lancer → graphe 120s
- [ ] Zoom/Pan : molette, clic-glisser, double-clic reset, 1:1 / ◻
- [ ] **BUG** Aperçu GUIDAGE : `WS image: ... match=true` mais pas d'image affichée dans le panneau. Le `handleGuideImage` est appelé, la caméra envoie `.fits`. Vérifier si le rendu canvas fonctionne (observer console.log + status bar après refresh).

## Améliorations possibles
- [ ] Workflow automatique : bouton unique « Démarrer » qui enchaîne capture→sélection→calibration→guidage
- [ ] Réduire les violations requestAnimationFrame (sky chart canvas lourd)
- [ ] Découper `app.js` en modules séparés

## Notes techniques
- Le serveur Python doit être redémarré manuellement par l'utilisateur
- Les JS sont servis en statique, un simple refresh suffit après modification
- Flow tests : exécuter via `python tests/test_X_flow.py` (pas pytest)
- Tests : `python tests/test_autofocus.py && python tests/test_autofocus_flow.py && python tests/test_guide_flow.py`
- Suite : `python -m pytest tests/ -q && node tests/test_polar_math.js`
