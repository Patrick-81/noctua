# CHECKPOINT — 16 juillet 2026

## État actuel
Le serveur est **fonctionnel** et connecté à l'INDIGO réel.

## Ce qui marche

### Backend Python
- [x] Connexion TCP à l'INDIGO server (192.168.1.25:7624)
- [x] Parse XML INDIGO avec fallback junk-after-document
- [x] Auto-reconnect en cas de déconnexion
- [x] Découverte automatique des devices (LX200 OnStep, SVBONY SV305PRO)
- [x] Upgrade vers types spécialisés (Mount, Camera, Focuser)
- [x] Auto-connect des devices au démarrage
- [x] Résolution noms INDIGO v2.0 ↔ INDI legacy (PROP_ALIASES)
- [x] Assainissement NaN/Inf pour JSON
- [x] WebLogHandler — logs Python → WebSocket

### Frontend JS
- [x] WebSocket état temps réel + logs
- [x] Split layout redimensionnable (gauche/droite)
- [x] Panneau monture : coordonnées sexagesimales + décimales
- [x] GOTO (input hh:mm:ss / dd:mm:ss → /api/mount/slew)
- [x] D-pad avec sélection vitesse (dédié /api/mount/move)
- [x] Park / Unpark / Abort / Tracking / Home
- [x] OnStep Status (tous les items, white-space: pre-wrap)
- [x] Badges tracking/park/slewing
- [x] Panneau propriétés interactives (switch/number/text, groupes pliables)
- [x] Canvas carte stéréographique client-side (sky-canvas.js)

### Carte céleste (sky-canvas.js)
- [x] Projection stéréographique en JS pur
- [x] 9096 étoiles (BSC5), 743 segments constellation
- [x] 110 Messier + 32 NGC/Caldwell
- [x] Grille RA/Dec avec labels
- [x] Crosshair télescope (rouge, mis à jour via WS)
- [x] Zoom molette (2°–120°)
- [x] Pan drag (projection inverse stéréographique)
- [x] Instantané — zéro clignotement, zéro round-trip serveur

## Ce qui ne marche pas / incomplet

### Bugs connus
- [ ] D-pad : les boutons n'envoient pas de requête POST au serveur
  - Hypothèse : `findMount()` retourne null ou erreur silencieuse JS
  - Le serveur ne voit aucune requête POST quand on clique les boutons
  - Le panneau monture s'affiche bien → le WS reçoit le state
  - Les boutons utilisent `onmousedown`/`onmouseup` inline

### Fonctionnalités manquantes
- [ ] Caméra : pas de panneau dédié (juste les propriétés interactives)
- [ ] Focuser : pas de panneau dédié
- [ ] Search/sélecteur d'objets sur la carte
- [ ] Indicateur FOV caméra sur la carte
- [ ] Calibration site (lat/lng pour calcul altitude étoiles)
- [ ] Gestion erreurs connexion INDIGO dans l'UI

### Architecture
- [ ] `web/sky_chart.py` est obsolète (ancien renderer starplot) — peut être supprimé
- [ ] Les catalogues sont copiés dans `public/catalogs/` depuis `indigo_xtens`
- [ ] Aucun test unitaire
- [ ] Pas de CI/CD

## Fichiers modifiés ce jour
- `web/static/sky-canvas.js` — **nouveau** : renderer stéréographique client-side
- `web/static/app.js` — réécrit : import ES module, sky-canvas, boutons dédiés
- `web/static/index.html` — canvas unique remplace img+overlay
- `web/static/style.css` — canvas styling
- `web/server.py` — supprimé sky_chart/worker, ajouté mount endpoints, /catalogs
- `requirements.txt` — starplot supprimé
- `public/catalogs/` — copiés depuis indigo_xtens

## Données serveur (dernière capture)
```
Monture: LX200 OnStep
  RA:  15.0525 h (10h02m06.0s)
  DEC:  90.0° (+90:00:00.0)
  Tracking: OFF
  Parked: false

Caméra: SVBONY CCD SV305PRO
  128 properties registered
```
