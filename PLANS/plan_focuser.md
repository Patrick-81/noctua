# Chantier Mise au point (Focuser) — Plan

## État actuel

| Composant | Statut |
|-----------|--------|
| `indigo/devices/focuser.py` | ✅ Complet — move_to, move_relative, halt, set_speed |
| API routes | ⚠️ Partiel — GET /api/focuser, POST /move, POST /halt (manque: move_relative, set_speed) |
| Frontend focuser | ❌ Placeholder "À implémenter" |
| Viewer FITS | ✅ Complet — zoom, pan, histogram, stretch, resize, overlay |
| Viewer multi-mode | ❌ Visible uniquement en mode Capture |
| Caméra guide | ❌ Pas de séparation guide/principale |

---

## Phase 1 — Refonte du Viewer multi-modes ✅

Le viewer est un composant central. Il doit être accessible partout sauf en mode Monture.

### 1.1 Extraire le viewer en composant réutilisable ✅

**Objectif** : Un seul `<div id="viewer-panel">` partagé entre les modes, avec des features activées/désactivées selon le mode.

**Modifications `index.html`** :
- Garder `mode-specific` class (pour le cycle hide/show de `switchMode()`)
- Retirer `data-modes="capture"` (le viewer est maintenant dans les applet lists de chaque mode)
- Titre dynamique via `#viewer-title` (mis à jour par `configureViewerForMode()`)

**Modifications `app.js`** :
- `VIEWER_MODE_CONFIG` : config par mode (title, save, histogram, stretch)
- `configureViewerForMode(mode)` : toggle elements individuellement (save, histogram controls)
- `switchMode()` appelle `configureViewerForMode()` après avoir montré les applets
- Viewer ajouté aux applet lists : capture, focuser, astrométrie, guidage

### 1.2 State du viewer persistant ✅

- L'image affichée persiste entre les changements de mode
- Le zoom/pan state est préservé

### 1.3 Tests ✅ (9/9)
- Viewer caché en mode Monture
- Viewer visible en modes Capture, Astrométrie, Focuser, Guidage
- Titre change selon le mode
- Save button visible uniquement en Capture
- Histogram visible en Capture et Focuser, caché en Guidage

---

## Phase 2 — Panneau Focuser (UI)

### 2.1 Layout du panneau focuser

```
┌──────────────────────────────┐
│ ⣿⣿  ◎ FOCUSER              │
├──────────────────────────────┤
│ Position:  12450 / 20000     │  ← position actuelle / max (si connu)
│ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░        │  ← barre de position relative
├──────────────────────────────┤
│ Vitesse:  [▼ 500] steps/s    │  ← dropdown ou slider
├──────────────────────────────┤
│ Absolu:  [12450    ] [Aller] │  → POST /api/focuser/move
├──────────────────────────────┤
│ Relatif:                     │
│   [◄◄ -1000] [◄ -100]       │  → POST /api/focuser/move_relative
│   [+100 ►]  [+1000 ►►]      │
├──────────────────────────────┤
│ [⛔ Arrêter]                  │  → POST /api/focuser/halt
└──────────────────────────────┘
```

### 2.2 Éléments HTML (`#applet-focuser-control`)

- **Position actuelle** : texte `12450` + position max si connue
- **Barre de progression** : pour visualiser la position relative
- **Vitesse** : input number ou dropdown (100, 250, 500, 1000, 2000, 5000)
- **Entrée absolue** : input number + bouton "Aller"
- **Boutons relatifs** : -1000, -100, +100, +1000 (configurable via input "step size")
- **Bouton Arrêter** : halt immédiat

### 2.3 Éléments HTML (`#applet-focuser-position`)

- **Position actuelle** (gros chiffre)
- **Historique mouvement** : mini-graphique des 20 dernières positions (canvas)
- **Status** : "Idle" / "Moving..." / "Error"

### 2.4 JavaScript focuser (`app.js`)

```
initFocuserPanel()     → setup event listeners
updateFocuserPanel()   → called from WS state updates
focuserMoveTo(pos)     → POST /api/focuser/move
focuserMoveRel(dir)    → POST /api/focuser/move_relative
focuserHalt()          → POST /api/focuser/halt
focuserSetSpeed(speed) → POST /api/focuser/set_speed
```

### 2.5 API routes manquantes (`web/server.py`)

- `POST /api/focuser/move_relative` → `{direction: "in"|"out", steps: int}`
- `POST /api/focuser/speed` → `{speed: int}`

---

## Phase 3 — Focus HFR/FWHM (métriques)

### 3.1 Calcul HFR côté serveur

**Nouveau module** : `indigo/devices/focus_metrics.py`

- `compute_hfr(image_data, x, y, radius)` → Half Flux Radius autour d'un point
- `compute_fwhm(image_data, x, y, radius)` → Full Width Half Maximum
- `find_stars(image_data, threshold)` → liste de positions d'étoiles + HFR
- `compute_average_hfr(image_data)` → HFR moyen de toutes les étoiles de l'image

Algorithme HFR :
1. Trouver le pic (étoile brightest pixel)
2. Calculer flux total dans un rayon donné
3. Trouver le rayon qui contient 50% du flux total
4. Ce rayon = HFR (en pixels)

### 3.2 API endpoint

- `GET /api/focuser/focus-metric` → `{hfr: float, fwhm: float, star_count: int, stars: [{x, y, hfr, flux}]}`
- Calcule sur la dernière image capturée (`_last_image_data`)

### 3.3 Affichage dans le viewer

- Overlay canvas avec cercles sur les étoiles détectées
- Texte HFR moyen en haut à gauche du viewer
- Quand on est en mode Focuser, le HFR s'affiche en temps réel après chaque capture

---

## Phase 4 — Focus assisté (manuel avec métriques)

### 4.1 Workflow

1. L'utilisateur est en mode Focuser
2. Il clique "Capturer" → une image est prise
3. Le serveur calcule le HFR
4. Le viewer affiche l'image + HFR + étoiles marquées
5. L'utilisateur bouge le focuser d'un step
6. Nouvelle capture → nouveau HFR
7. Le graphique des positions montre la tendance

### 4.2 Mini-graphique focus

Canvas dans le panneau focuser position :
- X = step number (0, 1, 2, ...)
- Y = HFR value
- Le but : trouver le minimum du HFR (meilleure mise au point)
- L'utilisateur peut voir la courbe se dessiner au fur et à mesure

---

## Phase 5 — Autofocus

### 5.1 Algorithme V-curve

1. Définir la plage de recherche : position centrale ± N steps
2. Séquence de captures : bouger le focuser → capturer → mesurer HFR
3. Nombre de points : 20-40 positions régulièrement espacées
4. Ajuster une parabole sur les points autour du minimum
5. La position du minimum de la parabole = meilleure mise au point
6. Commander le focuser à cette position
7. Capturer une image de vérification

### 5.2 UI Autofocus

```
┌──────────────────────────────────────┐
│ 🔍 AUTOFOCUS                         │
├──────────────────────────────────────┤
│ Plage:  [± 2000] steps              │
│ Points: [25]  (tous les 160 steps)  │
├──────────────────────────────────────┤
│ [▶ Lancer]  [⏹ Stop]                │
├──────────────────────────────────────┤
│ Progression: ████████░░░░ 16/25      │
│ Position: 12450 → meilleur: 12680    │
│ HFR actuel: 3.2px → optimal: 2.1px  │
├──────────────────────────────────────┤
│ [Canvas V-curve]                     │
│  HFR                                │
│  5 ┤    ·                            │
│  4 ┤  ·   ·                          │
│  3 ┤ ·       ·                       │
│  2 ┤·     ★     ·                    │
│  1 ┤               ·                 │
│    └──────────────────── Position    │
└──────────────────────────────────────┘
```

### 5.3 Backend autofocus

**Nouveau module** : `indigo/devices/autofocus.py`

- `class AutoFocus` : state machine pour la séquence autofocus
- Étapes : IDLE → MOVING → CAPTURING → MEASURING → (repeat) → DONE
- Paramètres : center_pos, range, num_points, step_size
- Calcul parabole : fitting polynomial degree 2 sur les points
- Callbacks : on_step_complete, on_focus_found, on_error

### 5.4 API routes

- `POST /api/focuser/autofocus/start` → `{center: int, range: int, points: int}`
- `POST /api/focuser/autofocus/stop`
- `GET /api/focuser/autofocus/status` → `{state, progress, best_pos, best_hfr, vcurve_data}`

### 5.5 Séquence autofocus côté JS

Le frontend orchestre la boucle (pas le backend) :
1. `startAutofocus()` → calcul des positions à tester
2. Boucle : move_to(position) → attendre fin → capturer → attendre image → calculer HFR
3. Stocker les résultats (position, HFR) pour le graphique
4. Quand tous les points sont faits, ajuster la parabole et commander la position optimale
5. Mettre à jour le graphique V-curve en temps réel

---

## Phase 6 — Caméra guide (focus)

### 6.1 Séparation guide/principale

- Le mode Capture utilise la caméra principale
- Le mode Focuser peut utiliser **les deux** (sélection caméra)
- Un dropdown "Caméra" dans le panneau focuser permet de choisir :
  - "Principale" (caméra CCD principale)
  - "Guide" (caméra guide)

### 6.2 API modifications

- `POST /api/focuser/move` → ajouter `device` optionnel (nom du focuser)
- `GET /api/focuser` → retourne l'état du focuser sélectionné
- Le registry doit gérer 2 focusers si nécessaire (un par caméra)

### 6.3 Focus séparé

- Chaque caméra a son propre focuser (souvent le même物理iquement, mais pas toujours)
- Le UI doit permettre de switcher entre les deux
- L'historique HFR est séparé par caméra

---

## Phase 7 — Tests

### 7.1 Tests automatisés

| Couche | Type | Contenu |
|--------|------|---------|
| 1 | Unit tests JS | Calcul HFR, FWHM, fitting parabole |
| 2 | Mock INDIGO | Focuser mock (position, move, halt) + FITS images |
| 3 | Playwright UI | Panneau focuser, boutons, séquence autofocus |
| 4 | Manuel | Guide pas-à-pas avec mock |

### 7.2 Mock focuser

Ajouter au mock INDIGO (`tests/mock_indigo.py`) :
- `defNumberVector FOCUSER_POSITION` (position actuelle)
- `defNumberVector FOCUSER_SPEED`
- `defSwitchVector FOCUSER_DIRECTION` (IN/OUT)
- `newNumberVector FOCUSER_POSITION` → mouvement simulé (0.5s)
- `newSwitchVector FOCUSER_ABORT_MOTION` → arrêt

---

## Ordre de réalisation

| Phase | Priorité | Durée estimée | Dépendances | Statut |
|-------|----------|---------------|-------------|--------|
| 1. Viewer multi-modes | 🔴 Haute | 2-3h | — | ✅ 9/9 tests |
| 2. Panneau Focuser UI | 🔴 Haute | 3-4h | Phase 1 | ✅ speed + bar + is_moving fix |
| 5. Autofocus | 🟡 Moyenne | 4-6h | Phase 2, 3 | |
| 3. Focus HFR/FWHM | 🟡 Moyenne | 3-4h | Phase 2 | ✅ focus_metrics + overlay + API |
| 4. Focus assisté | 🟡 Moyenne | 2-3h | Phase 3 | ✅ HFR chart + tracking |
| 6. Caméra guide | 🟢 Basse | 2-3h | Phase 2, 6 | |
| 7. Tests | 🔴 Haute | 3-4h | Toutes les phases | ✅ 67 tests (34 unit + 24 int + 9 PW) |

**Total estimé : 20-28h**

---

## Notes techniques

- Le focuser backend gère déjà `FOCUSER_POSITION`, `FOCUSER_SPEED`, `FOCUSER_DIRECTION`, `FOCUSER_STEPS`
- Les API routes existent pour move/halt mais pas pour move_relative/speed
- Le HFR est la métrique standard en astronomie (plus simple que FWHM à calculer)
- L'algorithme V-curve est le standard industry pour l'autofocus
- La caméra guide partage souvent le même focuser que la caméra principale
- Le viewer doit supporter plusieurs overlays simultanés (HFR stars + offset vector)
