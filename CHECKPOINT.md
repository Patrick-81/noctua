# CHECKPOINT — 20 juillet 2026

## État actuel
Migration UI terminée — applets flottants glassmorphisme + mode manager + correctifs bugs critiques.

## Changements majeurs (20 juillet)

### Architecture UI
- [x] **Suppression du layout split** — plus de header, footer, split-container
- [x] **Canvas plein écran** — carte céleste en fond (100vw × 100vh)
- [x] **Applets flottants glassmorphisme** — panneaux superposés au canvas
- [x] **Système de modes** — sélecteur Pilotage / Focuser / Guidage / Capture / Astrométrie
- [x] **Mode manager** — chaque mode affiche ses propres applets, les autres sont cachés
- [x] **Applets communs** — connexion, coords, légende, log toujours visibles

### Moteur carte céleste
- [x] **sky-engine.js** — nouveau moteur D3 v3 orthographic sur canvas HTML5
- [x] Projection orthographique (clip 90°, globe)
- [x] Couche 1-18 : fond, voie lactée, grille, équateur, écliptique, méridien, **horizon** (orange tirets, recalé en temps réel selon lat/LST), constellations, étoiles, labels méridiens, DSOs, planètes, zenith, labels cardinaux, réticule centre, indicateur télescope, highlight objet, FOV caméra
- [x] Synchronisation sidérale temps réel (setInterval 1s)
- [x] Mode temps manuel (date/heure sélecteur)
- [x] Drag rotation + scroll zoom
- [x] Context menu clic droit avec hit-test + GOTO
- [x] Recherche d'objets avec autocomplete multi-catalogue
- [x] Limite de magnitude (slider)
- [x] **Filtrage par catalogue DSO** — panneau déroulant AFFICHAGE avec 13 catalogues (M, NGC, IC, Caldwell, Sh2, LDN, Ced, VdB, LBN, RCW, SNR, Cr, Autres)
- [x] **Terre exclue** de l'affichage planètes

### Fix bugs critiques

#### Joystick (D-pad)
- [x] **Direction mismatch** — `data-dir="north"` ne correspondait pas à `"N"` dans `mount.move()`. Ajout d'un `_DIR_MAP` (`mount.py`)
- [x] **Bouton Stop** — `data-dir="stop"` routait vers `mountMove()` au lieu de `mountAbort()`

#### Connexion INDIGO
- [x] **Ligne ATTACHER cachée** — en mode "Connect", la ligne driver était masquée. Affichée dès que connecté
- [x] **Indicateur de statut faux** — le WebSocket local affichait "Connecté" dès le chargement. Polling `/api/connection` pour le vrai statut INDIGO
- [x] **Pas de reconnexion** — changer host/port while connected ne faisait rien. Déconnexion + reconnexion propre
- [x] **Fuite event listeners** — `addEventListener` dans `refreshDriverList()` (appelée toutes les 3s) déplacé hors de la boucle

#### Clipboard
- [x] **Copy log cassé** — `navigator.clipboard` nécessite contexte sécurisé. Fallback `textarea` + `execCommand('copy')`

### CSS
- [x] Design glassmorphisme (`backdrop-filter: blur(10px)`)
- [x] Palette : fond #020205, accent cyan #00ffcc, reticule rouge #ff0055, telescope orange #ff8800
- [x] Buttons `.btn-glass` avec variantes success/warning/danger
- [x] Inputs stylisés (fond dark, bordure cyan)
- [x] Status animés (pulse pour slewing/parking)
- [x] Responsive mobile (max-width: 768px)
- [x] **Panneau AFFICHAGE déroulant** — bouton toggle + sections Couches/Grilles/Catalogues
- [x] **Mode bar big icons** — boutons 56×56px avec emoji + label

### Backend
- [x] **Endpoint `/api/drivers/attach`** — POST pour charger un driver via Mount/CCD/Focuser Agent
- [x] **Endpoint `/api/connection`** — GET/POST pour paramètres de connexion INDIGO
- [x] **`IndigoClient`** — paramètre `protocol` (connect/attach), méthode `disconnect()`
- [x] **`DeviceRegistry.drivers_list()`** — retourne la liste des drivers disponibles
- [x] **Filtrage drivers par mode** — `DRIVER_TYPE_KEYWORDS` mappe modes → mots-clés

### Fichiers modifiés
- [x] `web/static/index.html` — structure applets, mode bar icons, connexion bar (3 rangs), panneau AFFICHAGE
- [x] `web/static/style.css` — glassmorphisme, mode-btn icons, drag handles, display-panel
- [x] `web/static/app.js` — mode manager, driver filtering, layer/catalog toggle, connection bar, drag system, clipboard fallback
- [x] `web/static/sky-engine.js` — layers object, catalog visibility, horizon line, Earth skip, Ced/VdB/LBN/RCW/SNR filtering
- [x] `web/server.py` — endpoints connection/drivers/attach, disconnect before reconnect
- [x] `indigo/client.py` — protocol parameter, disconnect method
- [x] `indigo/devices/mount.py` — `_DIR_MAP` for direction normalization

### Fichiers supprimés
- [x] `celestial-wrapper.js` — remplacé par sky-engine.js
- [x] `sky-canvas.js` — déjà obsolète
- [x] CDN d3-celestial (script + CSS)

### Fichiers ajoutés
- [x] `sky-engine.js` — moteur cartographique
- [x] `lib/d3.min.js` — D3 v3 local (plus de CDN)

## Ce qui reste à faire

### Applets placeholder (à implémenter)
- [ ] **Autoguidage** : graphique dérive, paramètres, stats
- [ ] **Capture** : paramètres exposition, preview FITS, séquence
- [ ] **Astrométrie** : solver, mise en station polaire

### Fonctionnalités existantes à vérifier
- [ ] Tester D-pad avec le serveur réel
- [ ] Tester GOTO depuis la carte
- [ ] Vérifier le panneau propriétés pour caméra/focuser
- [ ] Tester filtrage catalogues avec la carte réelle

### Améliorations possibles
- [ ] Ajouter un panneau OnStep Status dans le mode Pilotage
- [ ] Ajouter un panneau device list (sélection multi-device)

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
  [capture] settings, preview, sequence

MODE: ASTROMÉTRIE
  [commun] connection, coords, legend, log
  [astrometry] solver, polar
```
