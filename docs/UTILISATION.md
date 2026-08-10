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

### 8.1 Paramètres

- Caméra (sélecteur si plusieurs), binning, gain, offset, température (courante + cible), type de pose (LIGHT/DARK/FLAT/BIAS).
- Roue à filtres : sélecteur + séquence de filtres (ex. `L,R,G,B` ou `Ha,R,G,B`).

### 8.2 Aperçu

- Image FITS affichée avec **étirement automatique** (histogramme) ou manuel (curseur « Noir », mode AUTO).
- Zoom/pan, bouton **1:1**, **◻ adapter**, **⤢ plein écran** (Échap ou re-clic pour sortir).
- Redimensionner le panneau par la poignée `⣿`.
- **Enregistrer** (mode Capture uniquement) : sauvegarde du FITS couramment affiché.

> Le panneau d'aperçu ne disparaît jamais tout seul pour une raison quelconque : s'il semble masqué,
> vérifiez qu'aucun panneau superposé ne le recouvre (épingles 📌) et que le mode Capture est actif.

### 8.3 Séquence d'acquisition

- Plan éditable : type de pose, durée, filtre, nombre de poses, pause entre poses.
- Contrôles : **Démarrer**, pause, reprendre, arrêt, reset — progression affichée.
- **Dithering** (si activé dans `config.yaml`) entre les poses.
- **Live stacking** (optionnel) : empilement en direct des poses, reset, masters, sauvegarde du résultat.
- Fichiers nommés `capture_{filtre}_{timestamp}.fits` dans `sequence.save_dir`.

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
| Répertoire FITS | `config.yaml` (`sequence.save_dir`) | destinéation des captures |
| Profils | `profiles.yaml` | sets de périphériques nommés |

---

## 11. Fichiers de configuration

| Fichier | Contenu |
| ------- | ------- |
| `config.yaml` | INDIGO (hôte/port), web (hôte/port), site, telescope (flip), sequence (save_dir, dither, stack) |
| `profiles.yaml` | Profils matériel : `{ name, mount, camera, guide_camera, focuser, filter_wheel, optics }` |
| `ui.yaml` | Disposition des panneaux par mode, log levels, couches du ciel, histogramme, driver sélectionné |

---

## 12. Dépannage rapide

| Symptôme | Piste |
| ------- | ----- |
| « Hors ligne » | Vérifier le serveur INDIGO (port 7624) et le LAN ; sinon utiliser `./start-mock-server.sh` |
| Un panneau semble manquant | Peut être réduit (`+` dans sa barre) ou recouvert — vérifier les épingles 📌 et les positions sauvegardées |
| Cache navigateur obsolète | Ctrl+Shift+R pour recharger `app.js` |
| Aperçu vide après une pose | Consulter le journal (niveaux error/warning) et la barre de statut du panneau aperçu |