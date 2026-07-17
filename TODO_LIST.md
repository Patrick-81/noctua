# TODO LIST — indigo_devices

## Priorité haute

### Bug D-pad
- [x] Diagnostiquer pourquoi les boutons D-pad n'envoient pas de POST au serveur
- [x] Vérifier que `findMount()` retourne un résultat dans le contexte du navigateur
- [x] Tester en ajoutant `console.log` dans `mountMove()`
- [x] Vérifier que les handlers `onmousedown`/`onmouseup` sont bien appelés
- [x] Alternative : passer les handlers en Pointer Events avec setPointerCapture

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

### Site d'observation
- [x] Backend: `/api/site` GET/POST (lit/écrit config.yaml)
- [x] Backend: `/api/site/cities` (recherche fuzzy sur 122 villes)
- [x] Base de données 122 villes mondiales (`web/cities.py`)
- [x] Popup HTML: nom, ville (autocomplete), lat/lng, altitude, timezone, GPS
- [x] CSS: overlay + panel + résultats autocomplete
- [x] JS: open/close, city search debounced, GPS geolocation, save → POST
- [x] Save met à jour le sky chart en temps réel

## Priorité moyenne

### Focuser
- [ ] Panneau focuser dédié (position, GOTO, direction, speed)
- [ ] Position display + input
- [ ] Boutons in/out (small/large step)
- [ ] Speed slider

### Carte céleste améliorations
- [ ] Sélecteur d'objets (recherche par nom/catalogue)
- [x] Clic sur objet → info popup + GOTO (context menu)
- [ ] Indicateur FOV caméra sur la carte
- [ ] Labels DSO plus lisibles (fond semi-transparent)
- [ ] Performance : culling hors-écran pour les étoiles
- [x] Crosshair amélioré (glow, centre dot, label RA/Dec)
- [x] Auto-centrage sur position télescope
- [x] Mode suivi pendant les slews
- [x] Bouton Suivre/Libre + désactivation au pan manuel
- [x] Ligne d'horizon + labels cardinaux (N/S/E/W + intercardinaux)
- [x] Barre compass (azimut projeté, ticks, labels N/NE/E/SE/S/SW/W/NW)
- [x] Voile sud (overlay semi-transparent sous l'horizon)
- [x] GOTO direct depuis context menu
- [x] Canvas clip region + try/finally pour ctx.restore()
- [x] Render errors catchées — ne bloquent plus le drag ni les WS updates

### UI
- [ ] Indicateur état connexion INDIGO dans header
- [ ] Notification toast pour erreurs API
- [ ] Responsive mobile (pour tablette à lalescope)
- [x] D-pad: Pointer Events avec setPointerCapture (robuste touch+mouse)
- [x] D-pad: visuel actif (glow bleu) pendant le move

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
