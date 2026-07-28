# TODO List — Prochaines étapes

## Faits
- [x] Simulation de dérive guide caméra dans mock_indigo.py
- [x] Phase 5 Autofocus : boucle complète (move→expose→measure→finish→move→verify)
  - [x] _autofocusWaitImage() : stub → attente réelle via exposure_time
  - [x] _autofocusFinish() : move to best + vérification capture
  - [x] HFR courant + position affichés pendant le scan

## À tester
- [ ] Rafraîchir le navigateur et tester l'autoguidage visuellement
  - Vérifier le drift canvas (plus de feedback loop DPR)
  - Vérifier le star canvas (net sur HiDPI)
  - Vérifier le crosshair qui suit l'étoile
  - Vérifier la boucle dérive + correction avec le mock
- [ ] Tester l'autofocus V-curve visuellement dans le navigateur

## Améliorations possibles
- [ ] Phase 6 Caméra guide (séparation guide/principale, plan_focuser.md)
- [ ] Réduire les violations requestAnimationFrame (sky chart canvas lourd)
- [ ] Découper `app.js` en modules séparés

## Notes techniques
- Le serveur Python doit être redémarré manuellement par l'utilisateur
- Les JS sont servis en statique, un simple refresh suffit après modification
- Flow tests : exécuter via `python tests/test_X_flow.py` (pas pytest)
- Tests : `python tests/test_autofocus.py && python tests/test_autofocus_flow.py && python tests/test_guide_flow.py`
- Suite : `python -m pytest tests/ -q && node tests/test_polar_math.js`
