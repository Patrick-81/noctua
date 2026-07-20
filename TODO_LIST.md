# TODO LIST — indigo_devices

## Priorité haute

### Applets — Autoguidage
- [ ] Panneau graphique dérive RA/DEC (canvas)
- [ ] Panneau paramètres (tolérance, corrections, pulsations)
- [ ] Panneau stats (RMS, frames, drift)
- [ ] Routine calibration

### Applets — Capture
- [ ] Panneau paramètres (exposition, type frame, gain, offset, binning)
- [ ] Panneau preview (image FITS rendue, auto-stretch)
- [ ] Panneau séquence (plan de poses)
- [ ] Parser FITS (BITPIX, NAXIS, BSCALE/BZERO)

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

### Carte céleste
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
- [ ] Session d'imagerie (séquence de poses)
- [ ] Autoguiding basique
- [ ] Export FITS
- [ ] Multi-telescope support

### Données
- [ ] Import catalogue Hipparcos complet
- [ ] Catalogue NGC complet
- [ ] Objets du catalogue local (indigo_xtens/public/catalogs/)

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
