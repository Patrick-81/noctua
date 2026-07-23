# CHECKPOINT — 23 juillet 2026

## État actuel
SVBONY SV305PRO **connectée et fonctionnelle** : `connected=True`, `is_ready=True`, 1920×1080, 2.9µm pixel. 30 propriétés CCD reçues.

## Changements majeurs (session 23 juillet)

### Fix auto-connect SVBONY SV305PRO
- **Bug racine** : `_schedule_connect()` envoyait toujours `{"name": "CONNECT"}` mais le driver SVBONY utilise `CONNECTED` comme nom d'item
- **Fix** : récupère le vrai nom d'item depuis `defConnection` et le passe à `_schedule_connect`
- **Stockage** : propriété CONNECTION stockée dans `_properties` avant le return précoce
- **Retry** : `_auto_connect_retry_loop()` toutes les 10s (max 3), gestion des Alert
- **UI** : bouton "CONNECTER" manuel + endpoint `POST /api/device/connect`

### Logs épurés
- 15 logs INFO downgrade vers DEBUG (BLOB, CONNECTION, def property, exposure, WS events)
- Les logs INFO ne polluent plus le terminal

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
