# CHECKPOINT — 17 juillet 2026

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
- [x] `_safe_send()` — wrapper WS send anti-flood (évite erreurs ConnectionClosedOK)

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
- [x] Bouton « Copier » dans le header du log (copyLog)

### Carte céleste (sky-canvas.js)
- [x] Projection stéréographique en JS pur (centre = chartH/2)
- [x] 9096 étoiles (BSC5), 743 segments constellation
- [x] 110 Messier + 32 NGC/Caldwell
- [x] Grille RA/Dec (sans labels — causait des artefacts)
- [x] Crosshair télescope (rouge, glow, centre dot, label RA/Dec)
- [x] Zoom molette (2°–120°)
- [x] Pan drag (projection inverse stéréographique)
- [x] Instantané — zéro clignotement, zéro round-trip serveur
- [x] Suivi: centre la carte pendant les slews, désactivé au drag manuel
- [x] Bouton « Suivre / Libre » dans la barre d'info
- [x] Bouton « Centrer » pour recentrage manuel
- [x] Ligne d'horizon + labels cardinaux (N/S/E/W + intercardinaux)
- [x] Barre compass (azimut projeté via _altAzToRaDec + _project, ticks, labels)
- [x] Voile sud — overlay semi-transparent sous l'horizon (polygon trié par x)
- [x] Context menu clic droit — hit test étoiles/Messier/NGC, popup coords + GOTO
- [x] GOTO direct depuis context menu (bypass sexaToDec, envoie ra_hours/dec_deg)
- [x] Canvas clip region pour séparer chart de compass bar
- [x] try/finally dans render() pour ctx.restore() garanti
- [x] try/catch dans render() — erreurs jamais propagées aux callers
- [x] try/catch séparé pour compass bar — erreurs compass n'arrêtent pas le chart
- [x] Render errors loggées en console.error pour debug

### D-pad (corrigé)
- [x] Remplacement mouse/touch events → Pointer Events (setPointerCapture)
- [x] Suppression du `mouseleave` qui stoppait le move prématurément
- [x] `pointerup` global document comme garde-fou
- [x] Visuel : `.dpad-btn.active` avec glow bleu pendant le move
- [x] Debug logging dans `mountMove()` et `mountHaltMove()`
- [x] Bouton STOP : `stopMove()` + `mountAbort()`

### Site d'observation (popup config)
- [x] Backend: `/api/site` GET/POST (lit/écrit config.yaml)
- [x] Backend: `/api/site/cities` (recherche fuzzy sur 122 villes)
- [x] Base de données 122 villes mondiales (`web/cities.py`)
- [x] Popup HTML: nom, ville (autocomplete), lat/lng, altitude, timezone, GPS
- [x] CSS: overlay + panel + résultats autocomplete
- [x] JS: open/close, city search debounced, GPS geolocation, save → POST
- [x] Save met à jour le sky chart en temps réel (siteLat/siteLng/siteElev)
- [x] config.yaml: schema complet (name/lat/lng/elevation/timezone)

## Ce qui ne marche pas / incomplet

### Bugs connus
- [ ] D-pad : à tester avec le serveur réel (debug logging ajouté)

### Fonctionnalités manquantes
- [ ] Caméra : pas de panneau dédié (juste les propriétés interactives)
- [ ] Focuser : pas de panneau dédié
- [ ] Search/sélecteur d'objets sur la carte
- [ ] Indicateur FOV caméra sur la carte
- [ ] Gestion erreurs connexion INDIGO dans l'UI

### Architecture
- [ ] `web/sky_chart.py` est obsolète (ancien renderer starplot) — peut être supprimé
- [ ] Les catalogues sont copiés dans `public/catalogs/` depuis `indigo_xtens`
- [ ] Aucun test unitaire
- [ ] Pas de CI/CD

## Fichiers modifiés ce jour (17 juillet)
- `web/static/app.js` — D-pad (Pointer Events), debug, sky follow/center buttons, site popup logic, wait overlay fix
- `web/static/sky-canvas.js` — crosshair, setTelPosition(), follow, horizon+compass+veil, context menu, render try/catch
- `web/static/index.html` — sky-chart-info buttons, site popup overlay HTML, context menu div
- `web/static/style.css` — `.dpad-btn.active`, `.sky-follow-on/off`, popup styles, `#sky-chart-wait pointer-events: none`
- `web/server.py` — `/api/config`, `/api/site` GET/POST, `/api/site/cities`, `/api/mount/slew`, `_safe_send()`
- `web/cities.py` — 122 villes + search_cities()
- `run.py` — passes config_path to WebServer
- `config.yaml` — schema site complet (name/lat/lng/elevation/timezone)
