# Noctua — Portage ergonomique tablette / téléphone

Pré-étude (à valider) basée sur l'analyse **visuelle** des interfaces **ASIAIR** (ZWO)
et **StellarMate App** (IKARUS/KStars) à partir des captures de référence.
Objectif : adapter l'UI web actuelle (desktop, panneaux flottants par mode) à une
utilisation **tactile** sur tablette (usage principal) et téléphone (surveillance).

> Captures de référence conservées **en local** dans `/tmp/opencode/ui_refs/`
> (hors git). Détails et sources en §4–5.

---

## 1. Synthèse comparative — analyse visuelle

### 1.1 ASIAIR (ZWO) — smartphone en portrait

Le PDF officiel analysé (`asiair_manual.pdf`, 31 p., 910×1287, ratio 0,71) est
une version ancienne centrée sur la **connexion** (hotspot 5G, choix `Main
Camera / Guide Camera / Mount / Filter Wheel`, focales). Il ne contient pas de
screenshots du mode Preview/Plan/Live complet, mais confirme le positionnement
produit : **téléphone en main** devant la monture (`pg-05.png`), setup en une
page avec gros boutons verts `Connect` / `Enter` (`pg-10.png`).

Complété par la doc web V3 (2026) :
- **4 zones** sur l'écran Preview : top bar devices (icônes ASIAIR, caméras,
  monture, EFW, focuser, CAA — allumées/grisées), barre verticale droite des
  **modes** (Preview/Focus/PA/Autorun/Plan/Live/Video), barre verticale gauche
  des **outils du mode** (histogramme, solve, HFD, crosshair, binning…), **info
  bar basse** (résolution, gain, température, puissance refroidissement, état).
- **Thème sombre** intégral, gros bouton capture central à **anneau de
  progression**, statut « d'un coup d'œil ».
- V3 : page d'accueil avec **carte de statut d'imagerie** + gestion Wi-Fi/devices
  regroupée + SkyAtlas et mosaic planner.

**Ratio observé : portrait 9:16** — ASIAIR vise le téléphone d'abord, tablette en
portrait ensuite.

### 1.2 StellarMate App (KStars/Ekos) — tablette en paysage

Toutes les captures du manuel officiel sont en **paysage ~4:3** (1469×861,
1477×911, 1479×923, 969×629), optimisées tablette — l'app tourne sur téléphone
mais « for a better experience, please use a tablet ».

**Thème visuel observé** — fond noir, orange `#FF8C00` pour l'actif/sélection,
texte gris clair, icônes blanches fines. Lisible dans le noir.

#### Écran Ekos Expert (`ekos_main.jpg`, `canvas.jpg`)

- **Top bar** (fine, noire) : `Idle` (pastille grise) | icône monture `RA 08:06:58`
  `DE +00:00:00` | `CCD Simulator` `Red` `0.0` | `Idle` (pastille) | Wi-Fi, batterie
  `1:29 100%`. Tout le contexte en une ligne.
- **Main Canvas** central : l'image astro (ex. nébuleuse du Cœur) occupe ~75% de
  la largeur. Deux sous-zones annotées : **Upper Canvas** (image pure) et
  **Lower Canvas** (barre d'outils sous l'image : œil barré, croix, histogramme…,
  voir `canvas.jpg`).
- **Barre verticale gauche** : 5 icônes fines (loupe, cible, boussole, info,
  notes) — `Canvas Operations` (recherche, centrage, orientation, infos, logs).
- **Quick Controls** (haut droite, overlay) : icônes télescope + caméra + filtres
  + bouton orange **`Basic`** (bascule Expert↔Basic).
- **Status bars** (haut et bas du canvas, orange) : `AZ / AL / HA / Pier Side` +
  `1280x1024` `1x1` `200` `0` + icône sauvegarde. Deux barres : monture en haut,
  caméra en bas.
- **Bottom nav** (barre noire, 8–9 onglets) : `Setup | Ekos● | Sky | Targets |
  Community | Stella | Device | Viewer | Settings` — `Ekos` actif en orange avec
  pastille de notification. Icônes + label, hauteur ~48 px.
- **Bouton Stella** (bas droite, bulle verte/orange avec étoile) — assistant
  IA/compagnon, hors sujet Noctua mais signe d'une app « plateforme ».
- `main.jpg` / `main1.jpg` : vues **Community / Leaderboard** (hors cœur
  acquisition) — même bottom nav, header `Leaderboard` + cartes `1st/2nd/3rd` —
  confirme que la nav basse est **globale** à l'app.

#### Sky-map (`sky-map.jpg`)

- Plein écran ciel avec **FOV rectangulaire orange rotaté** labellisé
  `CCD Simulator  55.2'x44.1'` le long du bord — nord = flèche + `N`.
- **Popup cible** `IC 1805 (Gaseous Nebula)` : mag `7.03`, `RA 02:34:40`
  `DE +61:34:28` `HA +01:39:27` `AZ +340:10:37`… + 4 boutons orange
  `GOTO | Sync | Go & Solve | Schedule` (hauteur ~36 px, très tactiles).
- **Barre d'outils ciel** (haut centre) : ~10 icônes (étoile favori, FOV,
  cible, vent, S-curve, grille…) — `galactic grid`, `HiPS`.
- **Top droite** : icônes transparence télescope/caméra/lock (Quick Controls).

#### Framing Assistant (`framing_assistant.jpg` — référence directe pour D3)

- **Split 60/40** : gauche = sky survey (M33) avec **3 rectangles FOV
  superposés** (vert, orange, bleu) + labels `39.6'x21.0'` (FOV) en haut gauche,
  `0° E of N` en haut droite, `87.8'x87.8'` (survey) en bas gauche ; droite =
  panneau de contrôles sur fond noir.
- Panneau droit : onglets `Pan & Rotate` (actif orange) `| Pan Only | Rotate Only`,
  bloc **Rotation** avec `Target Position Angle  +000` + **slider orange/blanc**
  pleine largeur, `Angular Offset  0 ✓`, bloc **Center** `RA 01:33:05  DE +30:35:06`
  + bouton reset, deux **gros boutons ronds orange** `▶` (Go) et `📋` (Save) en
  bas, zoom `⊕ ⊖` en overlay bas-droite de l'image.
- **Enseignement** : contrôles **tous à droite**, image **toujours visible** à
  gauche, slider tactile pleine largeur, boutons d'action ≥56 px.

#### Live Stacking (`live-stacking.jpg`)

- Image pleine + **overlay noir arrondi en bas** : `▶` orange grand (Play/Pause) +
  `Method [Average ▼]  Weight [Equal ▼]` + `Downscale [4x4 ▼]  [Masters]` bleu +
  bouton galerie orange. Barre verticale droite d'outils (caméra, flip, vidéo,
  carré rouge, **`LIVE` encadré orange** + gear). Le LIVE est un **toggle**
  très visible.

#### Mosaic Planner (`mosaic_planner.png`)

- Écran formulaire sombre : `Target [M31]`, zone **CSV** multi-ligne (5 panes avec
  `RA, DEC, PA, width/height arcmins, Overlap`), `Sequence [/…/RGB_300s.esq]`,
  checkboxes `Track | Focus | Align | Guide`, bouton `Import Mosaic`. Basique mais
  montre que la mosaïque est gérée comme **liste de panes sérialisable**.

#### Basic mode — workflow guidé (`basic_*.jpg`, `top-row.jpg` / `bottom-row.jpg`)

- **Stepper horizontal** en haut : `Polar Alignment > Targets > Focus > Guide >
  Capture > Summary` — l'étape active en **orange**, les autres en gris/orange
  foncé, `Expert` bouton en haut droite pour sortir du guidage.
- **Panneau gauche (contrôles)** : lignes `Type [L][B][D][F]` (chips), `Exposure
  [- 2.5 +]`, `Filter [Red ▼]`, `Binning [1x1][2x2][4x4]` (chips), `Format [Mono ▼]`,
  `Temperature [- -5 +] [X]`, `Gain [- 298 +]`, `Offset`, `Count [- 7 +]` — tous
  avec steppers `− / +` rectangulaires gris/orange, hauteur ~28 px.
- **Panneau droit (séquences)** : liste `1 — ●━━━━ 0/7 X` avec chips filtres
  (`FLA/B/L`, `1x1`, horloge, gain) — compact, lisible.
- **Actions basses** : deux gros ronds orange `+` (ajouter séquence) et `▶` (lancer)
  + toggle `Live Stacking ○` à droite.
- `basic_guide.jpg` : même gauche + à droite **graphe RMS** (0,2–1,0) + `RA RMS:
  0.04  DE RMS: 0.03  Total RMS: 0.05` en couleur + imagette étoile guide avec
  carré vert.
- `basic_focus.jpg` : graphe **HFR Plot** hyperbolique + `HFR: 1.38` + imagette
  défocalisée + contrôles `Steps / Position / Step Size / TS.`
- `top-row.jpg` : mode **Capture Expert** — gauche `Train [Primary]`, `Preset
  [L_1S_100G_00]` ; droite `Sequences — light.esq` avec **barre de progression
  orange** `1 ━━━ 2/5 X` + widget flottant `Start & Stop Sequences ● 00:00:04`.

**Points communs visuels à retenir**
- **Navigation basse globale** (8–9 onglets) + **top bar contexte** — jamais de
  menu hamburger.
- **Gros boutons d'action orange** (56–64 px) : `▶`, `+`, `■` — toujours en bas
  ou en overlay, jamais perdus dans un formulaire.
- **Steppers `− [valeur] +`** partout pour les nombres (mieux que spinner natif
  au doigt).
- **Overlays noirs arrondis** sur l'image pour les contrôles d'acquisition
  (live-stack, séquences) — l'image reste visible dessous.
- **Slider pleine largeur** pour la rotation (framing) — geste horizontal naturel.
- Tailles tactiles observées : onglets ~48 px, boutons action ~56 px, steppers
  ~28 px, chips ~28 px — cohérent avec la cible 44–48 px.

### 1.3 Comparatif ciblé

| Critère | ASIAIR | StellarMate App | Noctua (actuel) |
|---|---|---|---|
| Orientation dominante | **Portrait** 9:16 (téléphone) | **Paysage** 4:3 (tablette) | Desktop paysage, panneaux flottants |
| Navigation | Modes verticaux droite + info bar basse | **Bottom nav globale** 8–9 onglets + top bar | Barre de modes en haut + applets flottants |
| Statut toujours visible | Barre basse temp/gain/état | **2 status bars** (monture haut / caméra bas) + badge | Log + état device (panneau Matériel — pas sticky) |
| Contrôles numériques | Gros boutons + sliders | **Steppers `− [val] +` + chips** + sliders | Inputs number natifs |
| Actions principales | Bouton capture + anneau progression | **Gros ronds orange `▶/+/■`** en bas | Boutons locaux par panneau |
| Ciblage | Simple plug-&-play | **Basic guidé** + Expert complet | Avancé seul |
| Thème | Sombre intégral | **Sombre + orange**, overlays arrondis | Sombre partiel |

---

## 2. Constats pour Noctua

Noctua partage l'ADN des deux (monture, caméras, focuser/EFW, guidage, dithering,
autofocus, PA, séquences, stacking live, sky map + FOV D1, framing D3, solve).
C'est une **web app** (HTML/CSS/JS vanilla + WebSocket) : le portage est
**responsive/tactile**, pas une réécriture native.

**Forces réutilisables**
- Hub inter-panneaux + applets par mode — logique « vue par mode » déjà proche de
  StellarMate.
- Sky map + FOV + framing rotatif D3 (FOV corners + target box + fit-check) —
  très proche du framing assistant StellarMate observé.
- Live stacking, séquences (C2), autofocus, PA, solve — couverture fonctionnelle
  équivalente.

**Freins pour le mobile**
- Panneaux `position: absolute` (`top/left/width` fixes) + `layout.yaml` — non
  adaptés aux petits écrans et au tactile.
- Nav par **modes en haut** + Matériel dans un mode : pas de statut sticky
  (top bar devices / status bar caméra).
- Pas de gestures (appui long, swipe, pinch) ; inputs natifs petits au doigt.
- 8 modes + applets débordent en largeur téléphone.

---

## 3. Plan d'adaptation multi-plateformes

### 3.1 Cibles et breakpoints

| Cible | Usage | Orientation | Breakpoint | Layout |
|---|---|---|---|---|
| **Desktop** | Station fixe | Paysage ≥1100 px | `≥1100px` | Actuel (grille large), bottom nav désactivée |
| **Tablette paysage** | **Pilotage principal** | Paysage 900–1099 px | `900–1099px` | Canvas central + panneaux latéraux repliables + top/bottom status bars |
| **Tablette portrait / grand téléphone** | Cadrage léger | Portrait 600–899 px | `600–899px` | 1 panneau plein largeur à la fois, top bar compacte, bottom nav |
| **Téléphone** | Surveillance | Portrait <600 px | `<600px` | **Monomode** : 1 atelier plein écran, bottom nav, actions sticky en bas |

Orientation détectée par `matchMedia("(orientation: portrait)")` + `visualViewport`.

### 3.2 Architecture commune (toutes cibles)

Reprendre le modèle StellarMate/ASIAIR → **3 zones + nav basse** :

1. **Top bar (sticky, 40–44 px)** — contexte + statut : pastille `Idle/Capturing`,
   `RA / DE`, `CCD Simulator / Red / Temp`, batterie/Wi-Fi. Icônes devices
   cliquables vers réglages (comme ASIAIR top bar). Masque partiellement en
   `<600px` (ne garde que RA/DE + temp).
2. **Zone centrale** — atelier du **mode courant** :
   - Desktop/tablette paysage : canvas (sky map / preview / guide) + panneaux
     latéraux en **tiroirs** (drawer) plutôt que flottants.
   - Téléphone : **plein écran** monomode, swipe horizontal pour changer de mode
     (optionnel).
3. **Bottom nav (sticky, 48–56 px)** — onglets globaux `Setup | Capture | Sky |
   Targets | Guidage | Device | Viewer | Settings` (icône + label, actif orange).
   Remplace la barre de modes actuelle en `<900px` ; coexiste au-dessus en
   `≥900px` (barre de modes repliée).
4. **Barres de statut caméra/monture (sticky, 28–32 px)** — au-dessus/au-dessous
   du canvas : `AZ / AL / HA / Pier Side` + `1280x1024  1x1  200  0  [save]` —
   visibles en paysage, repliées en téléphone (icône seule).
5. **Overlays d'acquisition** (live-stack, séquences) — bloc noir arrondi
   **par-dessus le bas de l'image** (comme StellarMate `live-stacking.jpg`), pas
   un panneau séparé.
6. **Logs** — tiroir **swipe depuis le bord gauche** (comme StellarMate) + pastille
   de notification sur l'onglet.

### 3.3 Règles tactiles (déduites des captures)

- Cibles ≥ **44 px** (onglets), actions principales **56–64 px** (ronds orange
  `▶/+/■`), steppers **28–32 px** — remplacer tous les `<button>` natifs petits.
- Remplacer les `<input type="number">` par **steppers `− [val] +`** (comme Basic
  mode) + chips `1x1/2x2/4x4`, `L/B/D/F` — bien plus utilisables au doigt.
- **Slider pleine largeur** pour la rotation/intensité (framing, focus) — piste
  4 px, pouce 24 px.
- **Appui long** sur sky map → `GOTO / Sync / Go & Solve` (popup 4 boutons comme
  `sky-map.jpg`) ; **pinch** pour zoom sky map ; **pan** 1 doigt.
- **Bouton capture universel** rond orange sticky en bas à droite (téléphone) ou
  en overlay bas du canvas (tablette) avec **anneau de progression** SVG pendant
  l'expo — remplace les boutons locaux.
- **Thème sombre** renforcé : fond `#0a0a0a`, surface `#1a1a1a`, accent
  `#ff8c00`, texte `#e0e0e0` — pas de blanc pur la nuit.
- Panneaux en **grille CSS** (`grid` + `flex`), plus de `position: absolute`
  fixe — breakpoint `900px` réorganise `grid-template-areas`.

### 3.4 Plan par phases (sans code dans cette étape)

**P0 — Fondations responsive (CSS seul, faible risque)**
- `meta viewport` + `touch-action` + `env(safe-area-inset-*)`.
- Thème sombre étendu + tailles tactiles de base (48 px nav, 44 px boutons).
- Convertir `layout.yaml` : `position: absolute` → `grid-area` par mode ;
  media queries `≥1100 / 900 / 600`.
- Critère de sortie : desktop inchangé visuellement, tablette paysage sans
  débordement horizontal, Lighthouse mobile ≥85.

**P1 — Shell multi-plateformes (top/bottom bars + tiroirs)**
- Nouvelle top bar sticky (RA/DE, devices, temp) + bottom nav globale (8 onglets).
- Tiroirs latéraux (gauche = canvas ops, droite = quick controls) en `<900px`
  (overlay), en colonnes fixes en `≥900px`.
- Status bars monture/caméra collées au canvas.
- Migration progressive : barre de modes actuelle conservée en `≥1100px`,
  masquée en `<1100px` au profit de la bottom nav (feature flag CSS).

**P2 — Overlays & steppers (composants tactiles)**
- Composant `Stepper` (`− [val] +` + long-press accéléré) + `ChipGroup`.
- Overlays d'acquisition (live-stack, séquences) par-dessus l'image.
- Slider rotation pleine largeur pour le framing (réutilise `framing.js` — ne
  change que le CSS du slider).
- Bouton capture universel + anneau SVG (progression `stroke-dashoffset`).

**P3 — Gestures (JS léger)**
- `pointerdown`/`pointerup` (300 ms) → appui long sky map → popup 4 actions.
- `pinch` (2 pointers) → zoom sky map ; `pan` → déplacement.
- Swipe gauche → logs, swipe horizontal → changement de mode (téléphone).
- Pas de lib externe : `Pointer Events` natifs, `touch-action: none` sur canvas.

**P4 — Mode Téléphone monomode + wizard (optionnel)**
- En `<600px` : 1 seul atelier visible, les autres en `display:none` (pas de
  grille multi-panneaux).
- Wizard **Basic** optionnel (stepper `PA > Cibles > Focus > Guide > Capture >
  Summary` comme `basic_*.jpg`) — guide débutant, expert reste défaut.
- PWA : `manifest.json` + `fullscreen` + icônes, installable depuis le navigateur
  (pas de store).

### 3.5 Ce qui ne change pas

- **Hub** (`hub.js`) : `subscribe/emit/request` inchangé — seuls les panneaux
  s'abonnent à de nouveaux topics `nav:changed` / `overlay:opened`.
- **Protocole INDIGO** et backend FastAPI : aucun impact.
- **Logique métier** (séquences, autofocus, PA, solve) : seule la présentation
  change.

### 3.6 Questions à trancher avant P0

- Téléphone **prioritaire** ou tablette seule en P0–P2 ?
- Wizard Basic souhaité ou Noctua reste expert-only ?
- PWA installable dès P4 ou plus tard ?
- Conserver `layout.yaml` en desktop et n'appliquer la grille qu'en `<1100px`
  (compat ascendante), ou basculer toute la grille dès P0 ?

---

## 4. Captures de référence (visuel vérifié)

Dossier local **`/tmp/opencode/ui_refs/`** (hors git) — toutes lues visuellement :

**StellarMate (manuel officiel `stellarmate.com/help/manual/stellarmate-app/`)**
- `ekos_main.jpg` — Ekos Expert : top bar RA/DE, Main Canvas nébuleuse, barre
  gauche Canvas Ops, Quick Controls haut droite, 2 status bars orange, bottom nav
  8 onglets, bulle Stella bas droite.
- `canvas.jpg` — Upper/Lower Canvas annotés (M31).
- `sky-map.jpg` — Sky-map avec FOV orange rotaté `55.2'x44.1'`, popup `IC 1805`
  `GOTO|Sync|Go&Solve|Schedule`, barre d'outils 10 icônes.
- `framing_assistant.jpg` + `framing_assistant_rotation.jpg` — M33, split 60/40,
  3 FOV superposés, slider Rotation pleine largeur, `RA 01:33:05 DE +30:35:06`,
  boutons ronds orange `▶/📋`, zoom `⊕⊖`.
- `live-stacking.jpg` — overlay noir `Method Average | Weight Equal | Downscale
  4x4 | Masters` + barre verticale `LIVE` orange.
- `mosaic_planner.png` — formulaire `Target M31`, CSV 5 panes, `Import Mosaic`.
- `basic_capture.jpg` — stepper `PA>Targets>Focus>Guide>Capture>Summary`, steppers
  `−[val]+`, chips `1x1/2x2/4x4` `L/B/D/F`, liste 3 séquences, boutons `+/▶` orange.
- `basic_guide.jpg` — graphe RMS `RA 0.04 DE 0.03 Total 0.05`, imagette guide
  carrée verte, steppers Exposure/Gain/Delay/Binning.
- `basic_focus.jpg` — HFR Plot hyperbolique `HFR:1.38`, graphe LIP, imagette
  défocalisée.
- `top-row.jpg` / `bottom-row.jpg` — Capture Expert : `Train/Preset/Count`,
  barre progression `1 ━━━ 2/5`, widget `Start & Stop 00:00:04`.
- `status-bar.jpg`, `overall-status.jpg`, `quick-settings.jpg`, `ekos-connected.jpg`,
  `main.jpg` (Leaderboard), `modules1.jpg`, etc. — vues complémentaires.
- Ratio **paysage ~4:3**, optimisées tablette.

**ASIAIR (`asiair/asiair_manual.pdf` → `pg-*.png`)**
- `pg-05.png` — intro : monture + téléphone en main (positionnement produit).
- `pg-10.png` — setup : `Guide Camera ZWO ASI120MC-S | Main Camera ZWO ASI1600MM
  Pro | Mount SynScan | Filter Wheel None`, focales + `Connect`/`Enter` verts.
- `pg-01…pg-31.png` — 31 p. portrait 9:16 — pas de screenshots Preview/Plan complets
  (version ancienne), mais ratio et parcours setup confirmés.

## 5. Sources

- ZWO : `zwoastro.com` (V3.0 features), `i.zwoastro.com/.../ZWO_ASIAIR_User_Manual.pdf`.
- StellarMate : `stellarmate.com/help/manual/stellarmate-app/` (toutes pages
  Ekos/Sky/Targets/Community/Device/Viewer/Settings + captures ci-dessus).
- Critiques : AppBrain, Play Store, High Point Scientific, AstroBackyard (retours
  StellaMate : bonne ergonomie, critiques sur stabilité et setup initial).
