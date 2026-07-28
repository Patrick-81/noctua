# TODO List — Prochaines étapes

## En test
- [x] Simulation de dérive guide caméra dans mock_indigo.py
- [ ] Rafraîchir le navigateur et tester l'autoguidage visuellement
  - Vérifier le drift canvas (plus de feedback loop DPR)
  - Vérifier le star canvas (net sur HiDPI)
  - Vérifier le crosshair qui suit l'étoile
  - Vérifier la boucle dérive + correction avec le mock

## Améliorations possibles
- [ ] Phase 5 Autofocus (V-curve complète, plan_focuser.md)
- [ ] Phase 6 Caméra guide (séparation guide/principale, plan_focuser.md)
- [ ] Réduire les violations requestAnimationFrame (sky chart canvas lourd)
- [ ] Découper `app.js` (5137 lignes) en modules séparés

## Notes techniques
- Le serveur Python doit être redémarré manuellement par l'utilisateur
- Les JS sont servis en statique, un simple refresh suffit après modification
- Flow tests : exécuter via `python tests/test_X_flow.py` (pas pytest)
- Tests : `python tests/test_guide_flow.py && python tests/test_autofocus_flow.py`
