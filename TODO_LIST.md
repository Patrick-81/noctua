# TODO LIST — indigo_devices

## Priorité haute

### Test end-to-end BLOB pipeline
- [ ] Lancer INDIGO + CCD Imager Simulator, vérifier logs `BLOB: ... size=N format=image/fits`
- [ ] Vérifier image rendue dans canvas preview capture
- [ ] Vérifier countdown numerique + barre pendant exposition

### Applets — Autoguidage
- [ ] Panneau graphique dérive RA/DEC (canvas)
- [ ] Panneau paramètres (tolérance, corrections, pulsations)
- [ ] Panneau stats (RMS, frames, drift)
- [ ] Routine calibration

### Applets — Astrométrie
- [ ] Panneau solver (image + coords résolues)
- [ ] Panneau mise en station polaire (erreurs d'alignement)
- [ ] Routine calibration polaire

## Priorité moyenne

### UI existante
- [ ] Tester D-pad avec le serveur réel
- [ ] Tester GOTO depuis la carte avec le serveur réel
- [ ] Tester panneau propriétés caméra/focuser
- [ ] Ajouter panneau OnStep Status dans mode Pilotage
- [ ] Ajouter panneau device list (sélection multi-device)
- [ ] Notifications toast pour erreurs API
- [ ] Responsive mobile amélioré (tablette à lalescope)

### Carte céleste — Drag / Rotation verrous
- [ ] **URGENT** : le drag ne tourne pas autour des axes alt/az malgré la conversion alt/az dans le handler. Le verrou Zénith devrait limiter au drag vertical (altitude), le verrou E/O au drag horizontal (azimut), mais l'horizon bascule toujours.
- [ ] Performance : culling hors-écran pour les étoiles
- [ ] Filtrage catalogues vérifié avec données réelles

## Priorité basse

### Architecture
- [ ] Tests unitaires (protocol parser, mount name resolution)
- [ ] Linting Python (ruff) + JS (eslint)
- [ ] CI/CD (GitHub Actions)
- [ ] Documentation API (OpenAPI/FastAPI auto-générée)

### Fonctionnalités avancées
- [ ] Suivi planètes (ephemeris JPL DE421)
- [ ] Autoguiding basique
- [ ] Export FITS
- [ ] Multi-telescope support

### Données
- [ ] Import catalogue Hipparcos complet
- [ ] Catalogue NGC complet
- [ ] Objets du catalogue local (indigo_xtens/public/catalogs/)

## DONE — 21 juillet 2026

### BLOB pipeline
- [x] `_extract_blob` regex : single + double quotes pour attributs INDIGO
- [x] `_extract_blob` retour : 6 valeurs (device, prop_name, item_name, fmt, binary_data, consumed)
- [x] Extraction prop_name depuis tag parent `<setBlobVector>`
- [x] Dispatch 5 args → registry._on_blob → camera.on_blob_data → on_image
- [x] BlobHandler type aligné (5 args)
- [x] `_re_vector` regex : `[\s/>]` pour self-closing
- [x] Validation nesting : count open tags avant close tag
- [x] delProperty content element handling (non-self-closing)
- [x] parse_xml_message : regex attrs single quotes

### Capture timer
- [x] HTML : cap-countdown-row avec label + MM:SS.d + barre exposition
- [x] JS : startCountdown / stopCountdown / _tickCountdown (rAF 60fps)
- [x] JS : _exposureStartMs / _exposureDurationMs tracking
- [x] JS : integration dans startSequence + abort
- [x] CSS : countdown-value monospace cyan, exp-fill transition 100ms

## DONE — 20 juillet 2026

- [x] D-pad : `_DIR_MAP` pour direction (north→N)
- [x] D-pad : bouton Stop → `mountAbort()`
- [x] Connexion : ligne ATTACHER visible dès connecté
- [x] Connexion : statut INDIGO réel via polling `/api/connection`
- [x] Connexion : reconnexion propre (disconnect + reconnect)
- [x] Connexion : fuite event listeners fixée
- [x] Copy log : fallback textarea
- [x] Carte : couche horizon (orange tirets, temps réel)
- [x] Carte : filtrage Ced, VdB, LBN, RCW, SNR, Cr + Autres
- [x] Carte : Terre exclue de l'affichage planètes
- [x] Carte : graduations azimutales sur l'horizon (N/30°/60°/E/...)
- [x] Carte : angle parallactique γ pour aligner l'horizon à l'écran
- [x] Carte : conversion alt/az↔RA/DEC dans le drag handler
- [x] Carte : _radecToAltAz() et _altAzToRadec() — conversion correcte vérifiée (round-trip OK)
- [x] Drag : handler réécrit 3× (RA/DC direct → alt/az → parallactic γ + alt/az)
- [x] Commits : c10c856, aee522f, cef826a, 196d5c4, a88ff4c, aa63c54
