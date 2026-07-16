# TODO LIST — indigo_devices

## Priorité haute

### Bug D-pad
- [ ] Diagnostiquer pourquoi les boutons D-pad n'envoient pas de POST au serveur
- [ ] Vérifier que `findMount()` retourne un résultat dans le contexte du navigateur
- [ ] Tester en ajoutant `console.log` dans `mountMove()`
- [ ] Vérifier que les handlers `onmousedown`/`onmouseup` sont bien appelés
- [ ] Alternative : passer les handlers en addEventListener dans `initSkyCanvas()`

### Caméra (Phase A — contrôles)
- [ ] Panneau caméra dédié (sélection device, exposition, température, binning)
- [ ] Sélection caméra par dropdown (devices avec CCD_* properties)
- [ ] Exposition : durée, type frame (Light/Dark/Flat/Bias), Start/Stop
- [ ] Température : lecture + slider + SET
- [ ] Gain / Offset / Binning : inputs + SET

### Caméra (Phase B — image viewer)
- [ ] Parser FITS (BITPIX, NAXIS, BSCALE/BZERO)
- [ ] Canvas image viewer avec auto-stretch (arcsinh)
- [ ] Stretch manuel (power-law slider)
- [ ] Réception BLOB frames (base64 + binary WS)

## Priorité moyenne

### Focuser
- [ ] Panneau focuser dédié (position, GOTO, direction, speed)
- [ ] Position display + input
- [ ] Boutons in/out (small/large step)
- [ ] Speed slider

### Carte céleste améliorations
- [ ] Sélecteur d'objets (recherche par nom/catalogue)
- [ ] Clic sur objet → info popup + GOTO
- [ ] Indicateur FOV caméra sur la carte
- [ ] Labels DSO plus lisibles (fond semi-transparent)
- [ ] Performance : culling hors-écran pour les étoiles

### UI
- [ ] Indicateur état connexion INDIGO dans header
- [ ] Notification toast pour erreurs API
- [ ] Responsive mobile (pour tablette à lalescope)

## Priorité basse

### Architecture
- [ ] Supprimer `web/sky_chart.py` (obsolète)
- [ ] Tests unitaires (protocol parser, mount name resolution)
- [ ] Linting Python (ruff) + JS (eslint)
- [ ] CI/CD (GitHub Actions)
- [ ] Documentation API (OpenAPI/FastAPI auto-générée)

### Fonctionnalités avancées
- [ ] Suivi planètes (ephemeris JPL DE421)
- [ ] Carte du ciel avec projection personnalisable (Mercator, Aitoff)
- [ ] Session d'imagerie (séquence de poses)
- [ ] Autoguiding (basique)
- [ ] Export FITS
- [ ] Multi-telescope support

### Données
- [ ] Import catalogue Hipparcos complet
- [ ] Catalogue NGC complet (pas juste les 32 objets bright)
- [ ] Objets du catalogue local (indigo_xtens/public/catalogs/)
