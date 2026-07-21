# CHECKPOINT — 21 juillet 2026

## État actuel
BLOB pipeline corrigée — regex quotes + arity mismatch + XML robustness. Capture timer ajouté (compteur MM:SS.d + barre exposition). Prêt pour test end-to-end avec CCD Imager Simulator.

## Changements majeurs (21 juillet)

### BLOB pipeline (critique)

#### Bug 1 : Regex quotes dans `_extract_blob`
- **Problème** : les regex utilisaient `name="..."` (double quotes) mais INDIGO envoie `name='...'` (single quotes). Résultat : aucun BLOB n'était jamais extrait.
- **Fix** : toutes les regex dans `_extract_blob` (`client.py:349`) acceptent désormais `['"]` pour les attributs. Extraction du `prop_name` (vecteur parent) + `item_name` (oneBlob) + `device` + `fmt` + `binary_data`.

#### Bug 2 : Arity mismatch `_on_blob`
- **Problème** : `client.py` dispatchait 4 args `(device, name, fmt, binary_data)` mais `registry._on_blob` attendait 5 `(device_name, prop_name, item_name, fmt, data)`. TypeError à l'arrivée du premier BLOB.
- **Fix** : `_extract_blob` retourne maintenant 6 valeurs (dont `prop_name` extrait du tag parent). Dispatch 5 args. Chaîne complète : `client.on_blob → registry._on_blob → camera.on_blob_data → on_image → server._on_camera_image → WebSocket → frontend`.

### XML parsing robustness

- **`_re_vector`** : regex élargie `[\s/>]` pour matcher les vecteurs self-closing.
- **Validation nesting** : avant d'accepter un close tag, on compte les open tags du même type. Si >1, le close tag appartient au 2e vecteur → on attend (évite 2 vecteurs concaténés en 1 XML invalide).
- **`delProperty` non-self-closing** : gestion explicite des `<delProperty>...</delProperty>` au lieu de skip une ligne.
- **`parse_xml_message`** : regex attrs self-closing corrigée pour single quotes via `(\w+)=(['"])(.*?)\2`.

### Capture timer

- **HTML** (`index.html`) : nouvelle row `cap-countdown-row` dans la section progression — label "Exposition", affichage `MM:SS.d` en monospace cyan, barre fine d'exposition.
- **JS** (`app.js`) :
  - Variables `_exposureStartMs`, `_exposureDurationMs`, `_countdownRaf`
  - `startCountdown()` / `stopCountdown()` — `requestAnimationFrame` pour 60fps
  - `_tickCountdown()` : calcule remaining = duration - elapsed, affiche MM:SS.d + pourcentage barre
  - `startSequence()` : lance le compteur au début de chaque pose
  - `updateCaptureProgress()` : appelle `stopCountdown()` à l'arrêt
  - Bouton STOP : reset propre via `updateCaptureProgress()`
- **CSS** (`style.css`) : `.cap-countdown-row`, `.cap-countdown-value` (monospace cyan bold), `.cap-exp-fill` (transition 100ms)

### Chaîne BLOB complète vérifiée
```
INDIGO server → TCP raw bytes
→ _process_buffer() (bytes-based, regex quotes OK)
→ _extract_blob() (prop_name + item_name + fmt + binary_data)
→ dispatch on_blob(device, prop_name, item_name, fmt, data)
→ registry._on_blob()
→ camera.on_blob_data()
→ camera.on_image(data, fmt)
→ server._on_camera_image()
→ WebSocket {"type":"image", "format":"image/fits", "data":"base64..."}
→ frontend handleCameraImage()
→ renderFITSImage() → canvas
```

### Fichiers modifiés
- `indigo/client.py` — _extract_blob rewrite (quotes + prop_name + 6 returns), dispatch 5 args, _re_vector broadened, nesting validation, delProperty content handling
- `indigo/protocol.py` — parse_xml_message self-close attrs regex single/double quotes
- `web/static/app.js` — capture countdown timer (startCountdown/stopCountdown/_tickCountdown), exposure tracking vars
- `web/static/index.html` — cap-countdown-row HTML
- `web/static/style.css` — countdown + exp-fill styles

## Ce qui reste à faire

### Test end-to-end (PRIORITÉ)
- [ ] Lancer INDIGO server + CCD Imager Simulator
- [ ] Vérifier `BLOB: device.prop [item] size=N format=image/fits` dans les logs
- [ ] Vérifier image rendue dans le canvas de preview capture
- [ ] Vérifier countdown pendant l'exposition

### Applets placeholder (à implémenter)
- [ ] **Autoguidage** : graphique dérive, paramètres, stats
- [ ] **Astrométrie** : solver, mise en station polaire

### Bugs ouverts
- [ ] **Drag rotation** — les verrous Zénith/E/O ne fonctionnent pas (voir historique tentatives)

### Fonctionnalités existantes à vérifier
- [ ] Tester D-pad avec le serveur réel
- [ ] Tester GOTO depuis la carte
- [ ] Vérifier le panneau propriétés pour caméra/focuser

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
  [capture] settings, preview, sequence, countdown

MODE: ASTROMÉTRIE
  [commun] connection, coords, legend, log
  [astrometry] solver, polar
```
