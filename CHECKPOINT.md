# CHECKPOINT — 23 juillet 2026

## État actuel
SVBONY SV305PRO **connectée et fonctionnelle** : `connected=True`, `is_ready=True`, 1920×1080, 2.9µm pixel. 30 propriétés CCD reçues.
**Capture live fonctionne** : exposition → FITS → image dans le canvas preview. Reste : zoom/pan/agrandissement viewer.
**Carte céleste** : drag avec verrous alt/az corrigé, culling, filtrage catalogues OK.
**Logs propres** : 5 devices échouent proprement en ~1min, puis silence total.

## Changements majeurs (session 23 juillet)

### Fix auto-connect SVBONY SV305PRO
- **Bug racine** : `_schedule_connect()` envoyait toujours `{"name": "CONNECT"}` mais le driver SVBONY utilise `CONNECTED` comme nom d'item
- **Fix** : récupère le vrai nom d'item depuis `defConnection` et le passe à `_schedule_connect`
- **Stockage** : propriété CONNECTION stockée dans `_properties` avant le return précoce
- **Retry** : gestion des Alert avec max 3 retries, 5s delay entre chaque
- **UI** : bouton "CONNECTER" manuel + endpoint `POST /api/device/connect`

### Fix auto-connect retry storm (session 23 juillet — suite)
- **Bug racine** : deux mécanismes de retry se cumulaient (`_auto_connect_retry_loop` dans server.py + Alert retry dans registry.py) → boucle exponentielle infinie pour les devices qui ne peuvent pas connecter (AAG CloudWatcher, CCD File Simulator)
- **Bug racine 2** : INDIGO server envoie `set CONNECTION (Ok)` puis immédiatement `set CONNECTION (Alert)` → le Ok resettait les retries à 0 → cycle infini
- **Fix 1** : supprimé `_auto_connect_retry_loop` (redondant avec Alert retry)
- **Fix 2** : `pv.state == "Alert"` prend priorité sur la valeur de l'item (même si `CONNECTED=On`, un Alert = échec)
- **Fix 3** : `_confirm_connection` différé de 3s pour laisser le temps au Ok de se confirmer
- **Fix 4** : cooldown 60s (`_connect_gave_up`) — après 3 échecs, le device est ignoré pendant 60s
- **Fix 5** : `_connect_retries` persiste entre les cycles `_on_def` (pas de reset à 0)
- **Fix 6** : guard `_connect_gave_up` dans le handler Alert empêche de relancer après give-up
- **Résultat** : 5 devices échouent proprement en ~1min, puis silence total (218 lignes au lieu de milliers)

### Logs épurés
- 15+ logs INFO downgrade vers DEBUG (BLOB, CONNECTION, def property, exposure, WS events, delProperty, device discovery/upgrade)
- Les logs INFO ne polluent plus le terminal
- Fix WS crash : `ValueError` sur `_ws_clients.remove(ws)` quand WS déjà supprimé (race condition)

### Fix config UI
- Flag `_initDone` empêche `saveUiConfig()` pendant l'initialisation
- La config n'est plus écrasée par `switchMode()` au chargement

### Preview redimensionnable
- Poignée `⣿` bas-droite, drag horizontal pour ajuster la largeur
- Positions sauvegardées dans `ui.yaml`

### Histogramme
- Canvas histogramme 256 bins (log scale) sous l'image
- Slider "Noir" pour le point noir (0-100%)
- Bouton AUTO toggle extension auto vs manuelle
- Stretch appliqué en temps réel sur le canvas
- État persisté dans `ui.yaml` par mode

### Sauvegarde images
- Input répertoire + bouton "Sauver" dans le panneau capture
- Endpoint `POST /api/camera/save` — crée le dossier, fichier `capture_YYYYMMDD_HHMMSS.fits`
- Dernière image stockée côté serveur (`_last_image_data`)

### Carte céleste
- Drag avec verrous alt/az (Zénith = vertical, E/O = horizontal) — **FIXÉ**
- Culling hors-écran pour les étoiles
- Filtrage catalogues vérifié avec données réelles

### Capture live
- Exposition → FITS → image dans le canvas preview — **FONCTIONNEL**
- Reste : zoom/pan/agrandissement viewer

## Architecture cible

```
MODE: PILOTAGE
  [commun] connection, coords, legend, log
  [monture] status, joystick, commands, hud, search

MODE: FOCUSER
  [commun] connection, coords, legend, log
  [focuser] control, position

MODE: AUTOGUIDAGE
  [commun] connection, coords, legend, log
  [guiding] graph, settings, stats

MODE: CAPTURE
  [commun] connection, coords, legend, log
  [capture] settings, preview (resize + histogram), sequence, countdown, save

MODE: ASTROMÉTRIE
  [commun] connection, coords, legend, log
  [astrometry] solver, polar
```
