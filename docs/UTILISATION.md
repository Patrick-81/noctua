# Noctua — Guide d'utilisation

Interface web de pilotage d'équipements astronomiques INDIGO (monture, caméras, focuser, roue à filtres).
Ce guide décrit les modes, panneaux et réglages disponibles côté navigateur.

---

## 1. Démarrage

### 1.1 Prérequis

- Python 3.10+, un serveur INDIGO (`indigo_server`) accessible sur le LAN — réel ou simulateurs
- Pip : `pip install -r requirements.txt`

### 1.2 Lancer le serveur web

```bash
./start.sh                        # utilise config.yaml (INDIGO + web)
./start.sh 192.168.1.25:7624      # surcharge l'adresse du serveur INDIGO
./start.sh 127.0.0.1:17624 --port 8080
```

Test sans matériel (simulateur de dérive) :

```bash
./start-mock-server.sh --port 17624          # dans un terminal
./start.sh 127.0.0.1:17624 --port 8080       # dans un autre
```

Puis ouvrir **http://<hôte>:8080**.

> Sécurité : l'interface écoute sur `0.0.0.0` par défaut et **n'a pas d'authentification**.
> Réservez-la à un LAN local, ne l'exposez pas sur Internet.

---

## 2. Barre de connexion

Toujours visible en haut au centre :

| Champ | Rôle |
| ----- | ---- |
| Protocole | `Connect` (connexion auto) ou `Attach` (sélection d'un driver manuel) |
| Hôte / Port | Adresse du serveur INDIGO |
| ● CONN | Établit / rétablit la connexion |
| Driver (Attach) | Sélection du driver à attacher, puis **ATTACHER** |
| Port (série) | Port série pour périphériques connectés par câble (monture, focuser…) — masqué en modes capture/astro |
| Coordonnées 📍 | Latitude / longitude du site |
| Langue FR/EN | Sélecteur de langue de l'interface (voir § 3) |

L'état de la connexion est affiché en ligne (`● Hors ligne` / `● En ligne`).

---

## 3. Barre de modes

Six modes accessibles par la barre en haut à gauche :

| Mode | Icône | Panneaux affichés |
| ---- | ----- | ----------------- |
| Matériel | 🔧 | Liste des périphériques, connexion par rôle (monture/caméra/guide/focuser/roue), édition des propriétés INDIGO |
| Monture | 🔭 | État monture, pilotage (goto, park/unpark, tracking), carte du ciel |
| Focuser | 🔍 | Contrôle focuser, position, autofocus (V-courbe HFR) |
| Guidage | 🎯 | Checklist 3 étapes, aperçu caméra guide, graphique de dérive, paramètres, calibration |
| Capture | 📷 | Paramètres de pose, aperçu, séquence d'acquisition |
| Astro | ⭐ | Plate solver, cible, polaire |

Chaque panneau est **mobile** (glisser par sa barre de titre), **réductible** (bouton `−` / `+`) et **épinglable** (📌 fige la position). Positions et états sont mémorisés par mode dans `ui.yaml` via `POST /api/ui`.

### Langue de l'interface

Un sélecteur **FR / EN** se trouve dans la barre de connexion (à droite de l'état de connexion).

- La langue détectée au premier chargement est celle du navigateur (`navigator.language`), sinon français par défaut.
- Le choix est **persisté** dans `localStorage` : il est conservé d'un chargement à l'autre.
- Le changement de langue s'applique immédiatement (interface + messages du journal). Les dictionnaires vivent dans `web/static/i18n.js` (`fr` / `en`) ; toute chaîne est référencée par une clé `i18n('…')` et balisée `data-i18n` dans `index.html`.

---

## 4. Mode Matériel (🔧)

- Liste des périphériques détectés avec leur rôle et état (connecté / erreur).
- Connexion **par rôle** ou **tout d'un coup** (boutons dédiés).
- Profils persistants : enregistrer / charger / appliquer un profil = connecter son set de périphériques.
- Édition des propriétés INDIGO de l'objet sélectionné.

---

## 5. Mode Monture (🔭)

- **État** : coordonnées RA/DEC, suivi, park.
- **Pilotage** : goto (RA/Dec ou objet), vitesse, stop, park/unpark.
- **Carte du ciel** : étoiles, grille, équateur, écliptique, méridien, horizon ; couches activables ; limite de magnitude.
- **Heure** : temps réel ou manuel (saisie date/heure).
- **Cap de suivi** : verrouillage zénith / est-ouest.
- **Flip méridien** : détection de proximité et déclenchement (auto ou manuel).

---

## 6. Mode Focuser (🔍)

- Contrôle manuel : déplacement absolu / relatif, vitesse.
- Lecture de position en temps réel.
- **Autofocus** : scan en V-courbe mesurant le **HFR** (half-flux radius) ; sélection du meilleur point puis repositionnement + vérification.
- Métrique de qualité de mise au point affichée sur l'aperçu.

---

## 7. Mode Guidage (🎯)

Workflow en 3 étapes (checklist) :

1. **Caméra sélectionnée** — choisir la caméra guide dans le sélecteur.
2. **Monture en ligne** — une monture connectée est nécessaire.
3. **Calibration faite** — lancer la calibration (exposures courtes, détection de l'étoile la plus brillante uniquement). **Étoile perdue** → relancé automatiquement jusqu'à 3×, sinon bouton Recommencer.

Puis :

- **Aperçu guide** : image de la caméra guide, détection d'étoiles, clic pour sélectionner l'étoile guide (qualité gaussienne : SNR, HFR, saturation), zoom/pan (molette, glisser, double-clic).
- **Démarrer le guidage** : pose courte en continu, mesure du centroïde, impulsions de correction RA/DEC.
- **Graphique** : dérive RA/DEC et total sur 120 s, RMS, impulsions de correction, cible avec réticule.
- **Tolérance** (±1–120″) : dépassement → alerte sonore.
- **Paramètres** : durée de pose, aggressivité, gains RA/DEC, impulsion max, binning guide.

---

## 8. Mode Capture (📷)

Le mode Capture regroupe **deux processus distincts** qui ne doivent pas être confondus :

| Processus | Panneau | Usage | Destination FITS |
| --------- | ------- | ----- | ----------------- |
| **Capture unitaire / série** | SÉQUENCE | poses longues, une par une, sauvegardées pour **traitement ultérieur** | `<root>/capture_YYYYMMDD_HHMMSS/` |
| **Live stacking** | LIVE STACKING | poses courtes accumulées **en direct** en une seule image (vue empilée) | `<root>/livestack_YYYYMMDD_HHMMSS/` |

Les deux partagent le même **répertoire racine** (`sequence.save_dir` dans `config.yaml`). Chaque session ouvre son propre sous-dossier horodaté et typé, ce qui les rend identifiables tout en gardant les images individuelles du live stacking exploitables pour un traitement postérieur (elles sont des FITS complets).

### 8.1 Paramètres de pose

Panneau CAPTURE SETTINGS (paramètres caméra) :

- Caméra (sélecteur si plusieurs), binning, gain, offset, température (courante + cible), type de pose (LIGHT/DARK/FLAT/BIAS).
- Roue à filtres : sélecteur + séquence de filtres (ex. `L,R,G,B` ou `Ha,R,G,B`).
- **EXPOSER** : lance `count` poses avec `delay` inter-pose, affichées au fur et à mesure dans l'aperçu.

### 8.2 Aperçu

- Image FITS affichée avec **étirement automatique** (histogramme) ou manuel (curseur « Noir », mode AUTO).
- Zoom/pan, bouton **1:1**, **◻ adapter**, **⤢ plein écran** (Échap ou re-clic pour sortir).
- Redimensionner le panneau par la poignée `⣿`.
- **Enregistrer** : sauvegarde du FITS couramment affiché dans le répertoire racine.
- Pendant un live stacking, l'aperçu montre la **vue empilée étirée** (push WebSocket) au lieu du dernier FITS.

> Le panneau d'aperçu ne disparaît jamais tout seul pour une raison quelconque : s'il semble masqué,
> vérifiez qu'aucun panneau superposé ne le recouvre (épingles 📌) et que le mode Capture est actif.

### 8.3 Capture unitaire / série (panneau SÉQUENCE)

Objectif : accumuler des poses qui seront **traitées plus tard** (Siril, PixInsight…). Les temps de pose sont
généralement longs ; chaque image est sauvegardée individuellement.

- Plan éditable : type de pose (LIGHT/DARK/FLAT/BIAS), durée, filtre, nombre de poses, pause entre poses.
- Contrôles : **Démarrer**, pause, reprendre, arrêt, reset — progression affichée.
- **Dithering** (si activé dans `config.yaml`) entre les poses.
- Fichiers alignés par filtre dans `capture_YYYYMMDD_HHMMSS/{filtre}/`, nommés `light_{filtre}_NNN_{timestamp}.fits`.
- ⚠️ **Pose unitaire ≠ stacking** : chaque FITS est indépendant, aucune accumulation n'est faite.

### 8.4 Live stacking (panneau LIVE STACKING)

Objectif : voir un objet **s'accumuler en direct** en poses courtes. La 1ʳᵉ image sert de référence ; les suivantes
sont alignées (appariement d'étoiles), les images trop décalées ou trop pauvres en étoiles sont **rejetées**.
L'aperçu affiche l'image empilée étirée, mise à jour après chaque pose acceptée.

- **Durée de pose (s)** : poses courtes (quelques secondes), adaptées au flux accumulé.
- **Poses à empiler** : nombre de LIGHT à **accepter** avant arrêt automatique de la session.
  **0 = en continu** jusqu'au bouton STOP. Si des poses sont rejetées, elle ne comptent pas.
- **Filtre** : filtre éventuellement appliqué (roue à filtres) avant la session.
- **Sauver dans (root)** : répertoire racine partagé (défaut `sequence.save_dir`).
  Les images vont dans `livestack_YYYYMMDD_HHMMSS/` ; le master est sauvegardé dans `<root>/masters/`.
- **Calibration (optionnel)** : chemins vers des dossiers de **dark** et/ou **flat** (FITS) servant à bâtir les
  masters de calibration appliqués à chaque pose avant empilement.
- Contrôles : **DÉMARRER**, **STOP**, **⟲ Reset**, **Master** (le master empilé en FITS), **Master PNG**.
- **Session terminée** : quand le nombre de poses acceptées atteint la cible, la session s'arrête et **le master
  est sauvegardé automatiquement** dans `<root>/masters/master_YYYYMMDD_HHMMSS.fits` (le chemin apparaît dans le
  statut du panneau). Le bouton STOP arrête toute session en cours (avec ou sans cible, sans sauvegarde auto).

---

## 9. Mode Astro (⭐)

- **Plate solver** (Seiza) : mode **Indice** (position monture + échelle, rapide) ou **Blind** (sans indice, lent).
- Indice auto (monture + caméra) ou manuel (RA/DEC/échelle saisies).
- Bouton ⭐ pour les images de test (dev).
- **Cible** : saisie RA/DEC, pointage, vignettage d'offset.
- **Polaire** : calcul LST + assistant de mise en station en 3 étapes (captures manuelles ou automatiques).

---

## 10. Options générales

| Réglage | Lieu | Rôle |
| ------- | ---- | ---- |
| Niveaux de log | filtre du panneau journal | info / warning / error / debug |
| Logs | `✓` dans le journal des événements | traçabilité (WebSocket `log`) |
| Site / fuseau | `config.yaml` | calcul LST, hauteur méridienne |
| Flip méridien | `config.yaml` (`telescope.*`) | marge angulaire, altitude min, recentrage |
| Répertoire racine FITS | `config.yaml` (`sequence.save_dir`) | racine des sessions `capture_TS/`, `livestack_TS/` et des masters `masters/` |
| Profils | `profiles.yaml` | sets de périphériques nommés |

---

## 11. Fichiers de configuration

| Fichier | Contenu |
| ------- | ------- |
| `config.yaml` | INDIGO (hôte/port), web (hôte/port), site, telescope (flip), sequence (save_dir, dither, stack, max_frames) |
| `profiles.yaml` | Profils matériel : `{ name, mount, camera, guide_camera, focuser, filter_wheel, optics }` |
| `ui.yaml` | Disposition des panneaux par mode, log levels, couches du ciel, histogramme, driver sélectionné |
| `web/static/i18n.js` | Dictionnaires FR/EN de l'interface (toutes les chaînes via clés `i18n('…')`) |

Le bloc `sequence.stack` de `config.yaml` permet la rétro-compatibilité (l'ancienne poussée automatique des
poses de la séquence vers l'empileur) :

```yaml
sequence:
  save_dir: ~/asteo/captures/   # racine partagée unique
  stack:
    enabled: false              # false → stacking piloté par le panneau LIVE STACKING
    max_frames: 0               # 0 = continu ; sinon nb de LIGHT à empiler
```

---

## 12. Dépannage rapide

| Symptôme | Piste |
| ------- | ----- |
| « Hors ligne » | Vérifier le serveur INDIGO (port 7624) et le LAN ; sinon utiliser `./start-mock-server.sh` |
| Un panneau semble manquant | Peut être réduit (`+` dans sa barre) ou recouvert — vérifier les épingles 📌 et les positions sauvegardées |
| Cache navigateur obsolète | Ctrl+Shift+R pour recharger `app.js` |
| Aperçu vide après une pose | Consulter le journal (niveaux error/warning) et la barre de statut du panneau aperçu |
| Stacking n'accepte aucune pose | Trop de dérive, pas assez d'étoiles, ou calibration dark/flat inadaptée — consulter `rejected` et la raison dans le statut |