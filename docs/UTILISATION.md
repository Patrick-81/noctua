# Noctua — Guide d'utilisation

Interface web de pilotage d'équipements astronomiques INDIGO (monture, caméras, focuser, roue à filtres).
Ce guide décrit les modes, panneaux et réglages disponibles côté navigateur.

> Référence des fichiers de configuration : [CONFIGURATION.md](CONFIGURATION.md).
> Vue développeur : [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Démarrage

### 1.1 Prérequis

- Python 3.10+, un serveur INDIGO (`indigo_server`) accessible sur le LAN — réel ou simulateurs
- Pip : `pip install -r requirements.txt`

### 1.2 Lancer le serveur web

```bash
./start.sh                        # utilise config.yaml (INDIGO + web)
./start.sh <indigo_host>:7624      # surcharge l'adresse du serveur INDIGO
./start.sh 127.0.0.1:17624 --port 8080
```

Test sans matériel (serveur INDIGO simulé) :

```bash
./start-mock-server.sh --port 17624          # dans un terminal
./start.sh 127.0.0.1:17624 --port 8080       # dans un autre
```

Puis ouvrir **http://<hôte>:8080**.

> Sécurité : l'interface écoute sur `0.0.0.0` par défaut et **n'a pas d'authentification**.
> Réservez-la à un LAN local, ne l'exposez pas sur Internet.

---

## 2. Barre de connexion

Toujours visible en haut, pleine largeur `calc(100vw-16px)` :

| Champ | Rôle |
| ----- | ---- |
| Protocole | `Connect` (connexion auto) ou `Attach` (sélection d'un driver manuel) |
| Hôte / Port | Adresse du serveur INDIGO |
| ● CONN | Établit / rétablit la connexion |
| FR/EN · Thème | Sélecteur de langue (voir § 3) et palette (`Noctua/Sobre/Graphite/Twilight/Ember`) |
| 📍 lat/lon + LEDs | Coordonnées du site + **LEDs compactes** `T` (monture) `C` (caméra) `A` (autoguidage) `F` (focuser) `R`/`W` (roue) — gris neutre → vert `#44cc44` quand le device du rôle est connecté (visible même en `graphite/sobre`) |
| Driver / Port série | Masqués en mobile (`<1100px`) — gérés depuis le panneau Matériel |

L'état de la connexion est affiché en ligne (`● Hors ligne` / `● En ligne`). La ligne driver n'est plus affichée en mobile, la colonne d'icônes démarre sous le bandeau (`top 124px`, `144px` en téléphone) pour ne pas mordre dessus.

---

## 3. Barre de modes

Sept modes accessibles par la barre en haut à gauche :

| Mode | Icône | Panneaux affichés |
| ---- | ----- | ----------------- |
| Matériel | 🔧 | Liste des périphériques, connexion par rôle, édition des propriétés INDIGO |
| Monture | 🔭 | État monture, pilotage, console de pointage, carte du ciel |
| Focuser | 🔍 | Contrôle focuser, position, autofocus (V-courbe HFR) |
| Guidage | 🎯 | Checklist 3 étapes, aperçu caméra guide, graphique de dérive, paramètres, calibration, session (flip) |
| Capture | 📷 | Paramètres de pose, **flat wizard**, aperçu, plan d'acquisition simple (SÉQUENCE), live stacking, session (flip) |
| Séquenceur | ▶ | **Plan d'acquisition multi-cibles** (cibles/plans/templates/mosaïque) |
| Astro | ⭐ | Plate solver, cible (centrage), polaire, modèle de pointage, aperçu |

Le **Séquenceur** est le planificateur principal (voir § 9) : il gère plusieurs cibles à la suite, chacune avec
son plan, sa possible mosaïque et ses options. Le panneau **SÉQUENCE** du mode Capture est une forme simplifiée
(un seul plan courant) héritée des premières versions, toujours fonctionnelle pour des besoins rapides.

Chaque panneau est **mobile** (glisser par sa barre de titre), **réductible** (bouton `−` / `+`) et **épinglable** (📌 fige la position). Positions et états sont mémorisés par mode dans `ui.yaml` via `POST /api/ui`.

> **Tablette / téléphone (`<1100px`)** : bandeau pleine largeur en haut, `#bottom-nav` (7 icônes en bas), zone centrale `skymap/panneaux` `width:calc(100vw-66px)` à gauche de la colonne d'icônes, `#mobile-stack` scrollable (carte fixe derrière, `pointer-events:none` sur la couche, gap 8px, pas de recouvrement), dock vertical droit `#mobile-dock` `top:124px` (`144px` en `<599px`) `44×44` uniformes (survol = titre, tap = afficher/masquer, pulse cyan, `off` orange), swipe horizontal entre modes, boutons `−` masqués.

### Langue de l'interface

Un sélecteur **FR / EN** se trouve dans la barre de connexion (à droite de l'état de connexion).

- La langue détectée au premier chargement est celle du navigateur (`navigator.language`), sinon français par défaut.
- Le choix est **persisté** dans `localStorage` : il est conservé d'un chargement à l'autre.
- Le changement de langue s'applique immédiatement (interface + messages du journal). Les dictionnaires vivent dans `web/static/i18n.{fr,en}.js` ; toute chaîne est référencée par une clé `i18n('…')` et balisée `data-i18n` dans `index.html`.

---

## 4. Mode Matériel (🔧)

- Liste des périphériques détectés avec leur rôle et état (connecté / erreur).
- Connexion **par rôle** ou **tout d'un coup** (boutons dédiés).
- **MONTURE — CONNEXION** : sélecteur `Série` vs `Réseau host:port` + champ endpoint (`/dev/ttyUSB0` ou `192.168.1.10:7624`), sauvegardé dans le profil (`mount_interface`, `mount_endpoint`) et appliqué à la connexion.
- Profils persistants : enregistrer / charger / appliquer un profil = connecter son set de périphériques (profils stockent aussi l'interface monture).
- Édition des propriétés INDIGO de l'objet sélectionné.

---

## 5. Mode Monture (🔭)

- **État** : coordonnées RA/DEC, suivi, park.
- **Pilotage** : goto (RA/Dec ou objet), vitesse, stop, park/unpark.
- **Carte du ciel** : étoiles, grille, équateur, écliptique, méridien, horizon ; couches de catalogues activables (M/NGC/IC/Caldwell/Sh2/LDN/…), limite de magnitude.
- **Heure** : temps réel ou manuel (saisie date/heure).
- **Cap de suivi** : verrouillage zénith / est-ouest.
- **Flip méridien** : détection de proximité et déclenchement (auto ou manuel, voir § 11). Après un flip, le recentrage de la cible peut être automatique (par solve d'image) si l'option est active.

---

## 6. Mode Focuser (🔍)

- Contrôle manuel : déplacement absolu / relatif, vitesse.
- Lecture de position en temps réel.
- **Autofocus** : scan en V-courbe mesurant le **HFR** (half-flux radius) ; sélection du meilleur point puis repositionnement + vérification.
- Métrique de qualité de mise au point affichée sur l'aperçu.

L'**autofocus automatique** en cours de séquence (entre deux poses) est configurable dans le Séquenceur (§ 9) et `config.yaml` (§ refocus, Lot B3).

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

### Dithering et « settle »

Quand le dithering est activé dans une séquence, un décalage gaussien de la **référence de guidage** est appliqué
entre deux poses. Optionnellement un **settle** attend que la dérive redevienne inférieure à un seuil
(`settle_rms` en ″) pendant plusieurs échantillons consécutifs (`settle_stable`), avec une durée maximum
(`settle_timeout`). Le statut apparaît dans le panneau séquence (`seq-dither-status`) et dans le journal.

---

## 8. Mode Capture (📷)

Le mode Capture regroupe les réglages caméra, le flat wizard, l'aperçu, le plan d'acquisition simple et le live stacking :

| Processus | Panneau | Usage | Destination FITS |
| --------- | ------- | ----- | ----------------- |
| **Capture unitaire / série** | SÉQUENCE | poses longues sauvegardées pour **traitement ultérieur** | `<save_dir>/<…>` |
| **Live stacking** | LIVE STACKING | poses courtes accumulées **en direct** en une seule image (vue empilée) | `<root>/livestack_YYYYMMDD_HHMMSS/` |
| **Autres poses** | CAPTURE | poses simples (LIGHT/DARK/FLAT/BIAS) exposées à l'écran, sauvegardables | `<save_dir>` |

### 8.1 Paramètres de pose (CAPTURE)

- Caméra (sélecteur si plusieurs), binning, gain, offset, température (courante + cible), type de pose (LIGHT/DARK/FLAT/BIAS).
- Roue à filtres : sélecteur + séquence de filtres (ex. `L,R,G,B` ou `Ha,R,G,B`).
- **EXPOSER** : lance `count` poses avec `delay` inter-pose, affichées au fur et à mesure dans l'aperçu.
- **Mesurer le ciel** (temps de pose idéal) : une ou trois poses de test (« Mesurer le ciel », `shots` dans config) mesurent le fond de ciel en ADU/s et extrapolent la durée atteignant le fond cible (`exposure.target_bg`), avec garde anti-saturation des étoiles et SNR projeté.

### 8.2 Flat wizard (section dépliable du panneau CAPTURE)

Assistant de série de **flats** : vise un niveau d'illumination cible en ADU (défaut ~22 000) dans une tolérance donnée.

- **Configurer** : ADU cible, tolérance (%), durée de départ, durée max.
- **Étape** : une pose est prise, mesurée, et la durée suivante est corrigée par proportionnalité (`suggest_duration`).
- **AUTO** : exécute les étapes en boucle jusqu'à convergence (mesure dans la tolérance).
- **Reset** : réinitialise la machine à états.
- Le statut affiche la cible, la dernière mesure, l'avancement (`step/max_steps`) et l'état `done`.

### 8.3 Aperçu

- Image FITS affichée avec **étirement automatique** (histogramme) ou manuel (curseur « Noir », mode AUTO).
- Zoom/pan, bouton **1:1**, **◻ adapter**, **⤢ plein écran** (Échap ou re-clic pour sortir), redimensionner par `⣿`.
- **Enregistrer** : sauvegarde du FITS couramment affiché dans le répertoire racine.
- Pendant un live stacking, l'aperçu montre la **vue empilée étirée** (push WebSocket) au lieu du dernier FITS.

> Le panneau d'aperçu ne disparaît jamais tout seul : s'il semble masqué, vérifiez qu'aucun panneau superposé ne
> le recouvre (épingles 📌) et que le mode Capture/Séquenceur/Astro est actif.

### 8.4 Panneau SÉQUENCE (plan simple)

Version simplifiée du planificateur (voir le Séquenceur § 9 pour l'usage complet) :

- Plan éditable : type de pose (LIGHT/DARK/FLAT/BIAS), durée, filtre, nombre de poses, pause entre poses.
- Contrôles : **Démarrer**, pause, reprendre, arrêt, reset — progression affichée.
- **Dithering** (si activé), répertoire de sauvegarde éventuellement surchargé.

### 8.5 Live stacking (panneau LIVE STACKING)

Objectif : voir un objet **s'accumuler en direct** en poses courtes. La 1ʳᵉ image sert de référence ; les suivantes
sont alignées (appariement d'étoiles), les images trop décalées ou trop pauvres en étoiles sont **rejetées**.
L'aperçu affiche l'image empilée étirée, mise à jour après chaque pose acceptée.

- **Durée de pose (s)** : poses courtes (quelques secondes), adaptées au flux accumulé.
- **Poses à empiler** : nombre de LIGHT à **accepter** avant arrêt automatique (**0 = en continu**).
- **Filtre** : filtre éventuellement appliqué (roue à filtres).
- **Calibration (optionnel)** : chemins de dossiers de **dark** et/ou **flat** (FITS) — ou mieux, la bibliothèque de masters (§ 10) qu'ils alimentent — bâtissant les masters appliqués à chaque pose.
- Contrôles : **DÉMARRER**, **STOP**, **⟲ Reset**, **Master**, **Master PNG**.
- **Session terminée** : à la cible, le master est **sauvegardé automatiquement** dans `<root>/masters/master_YYYYMMDD_HHMMSS.fits` et le chemin s'affiche dans le statut. STOP arrête sans sauvegarde auto.

---

## 9. Mode Séquenceur (▶) — plan d'acquisition multi-cibles

Le Séquenceur est le planificateur principal (modèle type « NINA ») : une **liste de cibles**, chacune avec son **plan**,
ses éventuelles **réglages de mosaïque**, l'ensemble piloté par des **options globales** (dither+settle, refocus auto,
répertoire racine) et des **templates** réutilisables. Il gère aussi la **reprise** de session interrompue.

### 9.1 Cibles

- **＋ ajouter**, **⧉ dupliquer**, **✕ supprimer** : la liste de gauche.
- Chaque cible est activable (case) et porte : **nom** (utilisé pour le rangement des sessions), **RA/Dec** (heures/degrés, ou recherche **🌌 catalogue** — Messier, NGC, IC, etc.), **rotation** (position angle de l'instrument).
- L'ordre de la liste est l'ordre d'exécution.

### 9.2 Détail d'une cible (colonne droite)

- **Plan d'exposition** : liste de poses (type, durée, filtre, ×, gain, offset, binning, délai). Pendant une session, les touches du plan s'éditionnent comme d'habitude ; une session en cours verrouille les champs.
- **Mosaïque (Lot D1)** — plus bas, la section « Mosaïque » :
  - case **« Étendre en grille N×M »** ; si cochée : taille couverte W×H **en arcmin**, **recouvrement** entre tuiles (%).
  - bouton **Planifier** : le serveur calcule la grille (nombre de tuiles = `ceil(span / pas)` avec pas = FOV×(1−recouvrement), correction RA au cosinus de la déclinaison) à partir du **FOV réel** de l'instrument (largeur de capteur, focale). Le résultat s'affiche : « R×C = N tuiles ».
  - Le FOV est calculé côté serveur depuis la géométrie de la caméra et la **focale** ; il dépend donc de la propriété focale renseignée pour la caméra (mode Matériel → propriétés du device). Sans focale, « Planifier » affiche « FOV caméra indisponible » (le FOV est mis en cache par page — recharger la page après avoir renseigné la focale).
  - L'aperçu de la grille se dessine en **orange sur la sky map** (tuile courante en gras).
  - À l'exécution, pour chaque tuile : la monture se déplace, on **attend la fin du slew**, puis un **recentrage par solve** (pose courte + résolution Seiza, si focale connue) garantit la mise en place AVANT de prendre la pose. Les déplacements se font une seule fois par tuile ; les poses suivantes de la même tuile ne redéclenchent rien. Les images portent les keywords `MOSN` (nombre total), `MOSROW` et `MOSCOL` (indices de la tuile).

### 9.3 Templates (Lot C3)

- Sauvegarder (**+💾**) le plan courant sous un nom, **charger** un template dans la cible sélectionnée, **supprimer**.
- **⇪ exporter** : copie le JSON de tous les templates dans le presse-papiers ; **⇓ importer** : colle un JSON pour les restaurer.
- Stockage : `sequence_templates.yaml` (relativement à la config, surchargeable par `INDIGO_SEQUENCE_TEMPLATES_PATH`).

### 9.4 Options globales

- **Dither** (voir § 7) : décalage ±px et **settle** (seuil ″, durée max s).
- **Refocus auto** (Lot B3) : après N **minutes** et/ou un Δ d'**altitude** (°) — une V-courbe HFR est mesurée côté serveur entre deux poses, la mise au point est repositionnée, la séquence continue. La première pose ne déclenche jamais (ligne de base enregistrée au départ).
- **Sauver dans** : répertoire racine (défaut `sequence.save_dir`).

### 9.5 Rangement des fichiers (Lot C2)

Avec une cible nommée, la session écrit dans ` <save_dir>/<cible>/<YYYY-MM-DD>/<HHMMSS>/` ; sans cible, dans
`<save_dir>/capture_YYYYMMDD_HHMMSS/` (legacy). À l'intérieur, les images sont groupées par type
(`lights/`, `darks/`, `flats/`, `biases/`) et nommées `{type}_{filtre}_{NNN}_{timestamp}.fits` avec des **index
continus** (`NNN`), ainsi que le fichier `journal.json`.

Chaque session persiste ce **`journal.json`** (plan, progression, tuiles mosaïque, contexte). En cas d'interruption,
le bouton **↻ Reprendre** (barre d'actions) relance la session : **seules les poses non sauvegardées sont reprises**,
les index de fichiers continuent (pas d'écrasement).

### 9.6 Contrôles d'exécution

- **▶ DÉMARRER** : envoie toutes les cibles activées (plan + mosaic) ; **⏸ Pauser / ▶ reprendre**, **⏹ STOP**, **⟲ Reset**.
- Progression globale (`done/total`), pose courante, derniers dither/refocus/save et erreur éventuelle dans la barre de statut.

---

## 10. Bibliothèque de masters (Lot C1)

La **MasterLibrary** catalogue et résout les masters de calibration **bias/dark/flat**, organisés en
`<dir>/masters/<type>/…` (racine = `masters.dir` ou `sequence.save_dir`).

- **Construction** : depuis une série de raws FITS → master combiné (médiane), avec entête normalisé (filtre, binning, température, exposition si pertinente).
- **Résolution** : pour un contexte d'acquisition (filtre, binning, température, exposition), retrouve le **meilleur master** (correspondance exacte d'abord, puis dégradations).
- **Intégration** : le live stacking peut être calibré depuis la bibliothèque (résolution bias/dark/flat → application aux poses).

Elle est pilotable par les endpoints `/api/masters/*` (construction, résolution, calibration du live stacking —
voir [ARCHITECTURE.md](ARCHITECTURE.md)). Les raws produits par les sessions de séquence portent les **entêtes
normalisés (C4)** qui permettent précisément de construire et cataloguer les masters.

---

## 11. Flip méridien

- **Anticipation** : marge d'angle horaire (`telescope.hour_angle_margin`), anti-re-flip (ne re-flippe pas juste après un flip), altitude minimale (`telescope.min_altitude`).
- **Pendant une séquence** : le flip est déclenché entre deux poses ; si `telescope.recenter_after_flip` et la focale le permettent, un **recentrage par solve** replace la cible.
- **Manuel** : `POST /api/mount/flip` (bouton du panneau Monture ou SESSION).

---

## 12. Mode Astro (⭐)

- **Plate solver** (Seiza) : mode **Indice** (position monture + échelle, rapide) ou **Blind** (sans indice, lent). Indice auto (monture + caméra) ou manuel (RA/DEC/échelle). Statut dans le panneau ; les solutions alimentent aussi `record-solve` du modèle de pointage.
- **Cible** : saisie RA/DEC, pointage, vignettage d'offset.
- **Polaire** : calcul LST + assistant de mise en station en 3 étapes (captures manuelles ou automatiques).
- **Modèle de pointage** : collection d'échantillons (ajout manuel ou automatique via `record-solve` — solveur « Indice » + centrage tolérance), **fit paramétrique** + correction **interpolée (IDW)** des erreurs résiduelles ; après ajustement, les go-tos (`correct`) reçoivent la correction du modèle. Panneau avec statut des échantillons.
- **Framing assistant (Lot D3)** : panneau cadreur — FOV réglable (auto caméra/focale ou manuel), **rotation du senseur** 0–360° (boutons « Solve » : angle du dernier plate solve ; « Nord ↑ » : 0°), cible par **nom/id de catalogue** (ex. `M42`, sélection depuis le panneau Cible) ou RA/DEC saisie. Boutons « Définir » (superpose le rectangle de la cible à sa taille angulaire réelle sur la carte), « GOTO » (pointage centré) et « ✕ » (efface). Le **fit-check** indique si la cible (majeur/mineur + angle de position) tient dans le champ à la rotation choisie.

---

## 13. Entêtes FITS normalisés (Lot C4)

Les images sauvegardées par les sessions portent des métadonnées normalisées, injectées par **réécriture binaire** de l'entête (aucune dépendance astropy, données bit-identiques). Principaux keywords :

| Keyword | Contenu |
| ------- | ------- |
| `OBJECT` | Nom de la cible |
| `IMAGETYP` | `Light Frame` / `Dark Frame` / `Flat Frame` / `Bias Frame` |
| `FILTER` | Filtre utilisé |
| `EXPTIME` | Durée de pose (s) |
| `DATE-OBS` / `DATE-END` / `DATE` | Début / fin / écriture (UTC) |
| `INSTRUME` | Instrument |
| `CCD-TEMP` / `SET-TEMP` | Température CCD mesurée / consigne |
| `GAIN` / `OFFSET` | Gain et offset appliqués |
| `XBINNING` / `YBINNING` | Binning |
| `PIXSIZE1` / `PIXSIZE2` (µm) / `FOCALLEN` (mm) | Géométrie capteur / focale |
| `TELESCOP` / `SITELAT` / `SITELONG` / `SITELEV` | Télescope et site |
| `SWCREATE` | Marqueur logiciel |
| `MOSN` / `MOSROW` / `MOSCOL` | Mosaïque : total de tuiles / rangée / colonne (poses mosaïque) |

Les mots-clés absents sont omis ; les valeurs hors normes sont nettoyées. Les master/library s'appuient sur ces entêtes pour cataloguer (C1).

---

## 14. Triggers (Lot A2)

Les **triggers** réagissent automatiquement aux événements de la séquence sans intervention front. Ils se déclarent
**dans `config.yaml`** (voir [CONFIGURATION.md](CONFIGURATION.md)§7.6). Événements disponibles :

`sequence_start`, `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`.

Actions : `log` (message via journal, niveau), `script` (commande externe avec timeout), `mount_goto`
(coordonnées — `"now"` = position actuelle). Variables dans les messages : `{done}`, `{total}`, `{filter}`,
`{error}`, `{index}`… Un endpoint de test (`POST /api/triggers/test`) permet de déclencher un trigger à la main.

---

## 15. Fichiers de configuration

| Fichier | Contenu |
| ------- | ------- |
| `config.yaml` | INDIGO (hôte/port), web (hôte/port), site, telescope (flip), exposure (pose idéale + recentrage), masters, sequence (save_dir, dither+settle, refocus, stack, frames, triggers) |
| `profiles.yaml` | Profils matériel : `{ name, mount, camera, guide_camera, focuser, filter_wheel, optics, mount_interface, mount_endpoint }` (`mount_interface: serial|network`, `mount_endpoint: /dev/ttyUSB0` ou `host:port`) |
| `ui.yaml` | Disposition des panneaux par mode, log levels, couches du ciel, histogramme, driver sélectionné |
| `sequence_templates.yaml` | Templates de séquences nommés (C3) |
| `web/static/i18n.{fr,en}.js` | Dictionnaires FR/EN de l'interface |

> La référence exhaustive de chaque clé, avec exemples, est dans **[CONFIGURATION.md](CONFIGURATION.md)**.

---

## 16. Dépannage rapide

| Symptôme | Piste |
| ------- | ----- |
| « Hors ligne » | Vérifier le serveur INDIGO (port 7624) et le LAN ; sinon utiliser `./start-mock-server.sh` |
| Un panneau semble manquant | Peut être réduit (`+` dans sa barre) ou recouvert — vérifier les épingles 📌 et les positions sauvegardées |
| Cache navigateur obsolète | Ctrl+Shift+R pour recharger les scripts |
| Aperçu vide après une pose | Consulter le journal (niveaux error/warning) et la barre de statut du panneau aperçu |
| Stacking n'accepte aucune pose | Trop de dérive, pas assez d'étoiles, ou calibration dark/flat inadaptée — consulter `rejected` et la raison dans le statut |
| Mosaïque : « Planifier » n'affiche rien | FOV caméra indisponible — renseigner la **focale** dans les propriétés du device caméra (mode Matériel), puis **recharger la page** (le FOV est mis en cache par page) |
| Mosaïque : solve de recentrage KO | Le recentrage par solve exige un `scale_hint` (focale connue) ; sinon la tuile est prise à la position du slew (pas de recentrage) |
| Refocus auto ne se déclenche pas | Vérifier les options globales (case Refocus auto + valeurs), et qu'un autofocus manuel a déjà fonctionné (le HFR nécessite une V-courbe valide) |
| Reprendre ne s'affiche pas | Pas de session interrompue connue (le statut expose `resumable`) ; vérifier le `journal.json` du dossier de session |
| Les entêtes FITS semblent absents | Certains devices n'exposent pas focale/température/gain — les mots-clés non connus sont simplement omis |