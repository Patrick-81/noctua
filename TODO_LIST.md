# TODO LIST — indigo_devices

## Priorité haute

### Test end-to-end BLOB pipeline
- [x] Vérifier que la caméra SVBONY est branchée en USB sur le serveur INDIGO
- [x] Capture live fonctionne avec la vraie SVBONY (expose → FITS → affichage)
- [ ] Agrandissement du viewer (plein écran ou mode élargi)
- [ ] Zoom dans le viewer (scroll wheel ou pinch)
- [ ] Pan dans le viewer (drag pour naviguer dans l'image zoomée)
- [ ] Countdown numerique + barre pendant exposition (déjà fait, à vérifier)

### Applets — Autoguidage
- [ ] Panneau graphique dérive RA/DEC (canvas)
- [ ] Panneau paramètres (tolérance, corrections, pulsations)
- [ ] Panneau stats (RMS, frames, drift)
- [ ] Routine calibration

### Applets — Astrométrie
- [x] Panneau solver (image + coords résolues) — **FAIT (Seiza)**
- [x] Tests solver end-to-end (33/33 passent) — FITS, détection, résolution, précision — **FAIT**
- [x] Overlay canvas vecteur décalage sur viewer (flèche + réticule cible + cardinaux) — **FAIT**
- [x] Affichage FITS dans viewer — auto-stretch percentile (p1/p99) — **FIXÉ**
- [x] Solver status UI — retry + refresh au switch mode — **FIXÉ**
- [ ] Panneau centrage cible (inputs RA/DEC cible, boutons Nudge/GOTO, décalage affiché)
- [ ] Panneau mise en station polaire (séquence 3-points, calcul erreur Alt/Az)
- [ ] Routine calibration polaire

## Priorité moyenne

### UI existante
- [x] Tester D-pad avec le serveur réel
- [x] Tester GOTO depuis la carte avec le serveur réel
- [ ] Tester panneau propriétés caméra/focuser
- [ ] Ajouter panneau OnStep Status dans mode Pilotage
- [ ] Ajouter panneau device list (sélection multi-device)
- [ ] Notifications toast pour erreurs API
- [ ] Responsive mobile amélioré (tablette à lalescope)

### Carte céleste — Drag / Rotation verrous
- [x] Le drag tourne autour des axes alt/az avec verrous Zénith (vertical) et E/O (horizontal) — **FIXÉ**
- [x] Performance : culling hors-écran pour les étoiles
- [x] Filtrage catalogues vérifié avec données réelles

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

## DONE — 23 juillet 2026 (session 3)

### Fix auto-connect retry storm
- [x] Supprimé `_auto_connect_retry_loop` redondant (server.py)
- [x] `pv.state == "Alert"` prioritaire sur la valeur de l'item
- [x] `_confirm_connection` différé 3s pour laisser le temps au Ok/Alert
- [x] Cooldown 60s (`_connect_gave_up`) après 3 échecs
- [x] `_connect_retries` persiste entre cycles `_on_def` (pas de reset à 0)
- [x] Guard `_connect_gave_up` dans handler Alert empêche relance
- [x] Fix WS crash : `_ws_clients.remove(ws)` ValueError sur race condition

### Capture live fonctionnelle
- [x] Exposition → FITS → image affichée dans le canvas
- [x] Reste : agrandissement du viewer, zoom et pan dans le viewer

### Carte céleste
- [x] Drag avec verrous alt/az corrigé — **FIXÉ**
- [x] Culling hors-écran
- [x] Filtrage catalogues vérifié

## DONE — 23 juillet 2026 (session 2)

### Logs épurés
- [x] 15 logs INFO downgrade vers DEBUG (BLOB, CONNECTION, def, exposure, WS)
- [x] Les logs INFO ne polluent plus le terminal

### Fix config UI
- [x] Flag `_initDone` empêche `saveUiConfig()` pendant l'initialisation
- [x] La config n'est plus écrasée par `switchMode()` au chargement

### Preview redimensionnable
- [x] Poignée `⣿` bas-droite du panneau aperçu
- [x] Drag horizontal pour ajuster la largeur (200px→95vw)
- [x] Positions sauvegardées dans `ui.yaml`

### Histogramme
- [x] Canvas histogramme 256 bins (log scale) sous l'image
- [x] Slider "Noir" pour le point noir (0-100%)
- [x] Bouton AUTO toggle extension auto vs manuelle
- [x] Stretch appliqué en temps réel sur le canvas
- [x] État persisté dans `ui.yaml` par mode

### Sauvegarde images
- [x] Input répertoire + bouton "Sauver" dans panneau capture
- [x] Endpoint `POST /api/camera/save` — crée le dossier, fichier `capture_YYYYMMDD_HHMMSS.fits`
- [x] Dernière image stockée côté serveur (`_last_image_data`)

## DONE — 23 juillet 2026 (session 1)

### Fix auto-connect SVBONY SV305PRO
- [x] Bug : `_schedule_connect` envoyait `CONNECT` au lieu de `CONNECTED` (vrai nom d'item du driver)
- [x] Fix : récupère le vrai nom d'item depuis `defConnection` et le passe à `_schedule_connect`
- [x] Stockage de la propriété CONNECTION dans `_properties` (return précoce corrigé)
- [x] Retry auto-connect : `_auto_connect_retry_loop()` vérifie toutes les 10s, max 3 retries
- [x] Gestion des réponses Alert : retry après 5s
- [x] Bouton "CONNECTER" manuel dans l'UI + endpoint `POST /api/device/connect`
- [x] Caméra connectée : 1920×1080, 2.9µm, is_ready=True, 30 propriétés CCD

### Guard expose + cleanup
- [x] `Camera.is_ready` property (True si CCD_EXPOSURE dans _properties)
- [x] `Camera.expose()` lève RuntimeError si pas prêt
- [x] `/api/camera/expose` vérifie is_ready, retourne error si pas prêt
- [x] `Camera.state_dict()` inclut is_ready
- [x] Supprimé handler `_debug_msg` (RECV: logs)
- [x] Supprimé log `_extract_blob: tag_type=... buffer_len=...`
- [x] Supprimé log `BLOB raw details: device=... prop=... item=...`
- [x] Réduit SEND log à 200 chars,降級 à debug
- [x] Nettoyé logs _enable_blob_upload, _on_camera_image

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
