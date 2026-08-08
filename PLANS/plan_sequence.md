# Chantier Séquence & Automatisation (P2) — Plan

## Objectif

Ajouter un **moteur de séquence d'acquisition** qui enchaîne automatiquement les
poses (LIGHT/dark/flat, filtre, durée, compteur), puis boucle (dithering entre
poses). Objectif : transformer l'outil d'un contrôle pièce par pièce vers une
session d'imagerie **semi-autonome**, réutilisant l'infrastructure existante
(capture FITS, BLOB push WS, solveur, monture, roue à filtres, config).

Périmètre proposé (à valider utilisateur) :
- Un moteur de séquence **backend** (nouveau module `indigo/devices/sequence.py`).
- Endpoints REST + état poussé via WS.
- Panneau « SÉQUENCE » dans le mode **Capture**.
- **Dithering** entre poses (mouvement guidage décorellée de la période de lecture).
- Base des **exécutions multiples** : ×N poses, séquence de filtres, boucle.

### Hors périmètre (v1)
- Pas de darks/biats/flats automatiques avec soustraction de calibration réelle
  (il faut un moteur FITS de calibration → chantier séparé).
- Pas de scheduling astronomique (calcul de visibilité / auto-start à l'heure).
- Pas de moteur de plan complet (centreur+autofocus+guidage+dithering) en une
  étape ; la séquence requiert déjà un guidage/recentrage manuel avant.

---

## 1. Concepts

- Une **séquence** est une liste de cibles de capture (frames). Chaque cible :
  `device`, `frame_type` (LIGHT/DARK/BIAS/FLAT), `duration`, `filter`,
  `count` (= nombres de poses), `delay` (pause entre poses).
- Le moteur exécute chaque cible en série : pour chaque répétition → filtre →
  expose → **attend la fin d'exposition** (capture auto via BLOB push, cf.
  infra) → sauvegarder FITS → optionnellement **dither** → pose suivante.
- **Dither** : demande au guide de déplacer la ±quelques pixels aléatoirement,
  attend stabilisation avant la pose suivante. Propagation de l'état via WS.
- La séquence est **asynchrone** : le moteur tourne en tâche de fond ; l'UI
  reçoit un état (position, progression, frame courante, log) par WS sans bloquer.

## 2. Tâche backend : `indigo/devices/sequence.py`

```python
class SequencePlan:
    frames: list[dict]   # [{duration, frame_type, filter, count, delay}]
    total(): int         # nb total de poses

class SequenceRunner:
    stop(): ...
    reset(): ...
    status() -> dict      # running, plan index, frame, done, total, last_error
    async run(plan, save_dir):   # boucle principale
```

- **Dépend de l'exposition** : pour savoir qu'une pose est terminée, on peut soit
  s'appuyer sur le **BLOB push** (l'image arrive sur WS → on avance), soit sur le
  passage de `CCD_EXPOSE` de `Busy` → `Idle`. Cette 2e voie est plus fiable pour
  un moteur (élimine les soucis de timing réseau). → le runner surveille l'état
  caméra (`camera.state_dict()['exposing']`) jusqu'à `False`, puis lit
  `_last_image_data`.
- **Sauvegarde** : réutilise la logique de `/api/camera/save` mais en batch :
  sous le répertoire par cible (`{dir}/{obj}/{filter}/frame_YYYYMMDD_hhmmss.fits`).

## 3. WebServer — endpoints & persistance

```
GET  /api/sequence/status                     → runner.status()
POST /api/sequence/start   {save_dir, frames} → start (1) task
POST /api/sequence/stop                      → stop()
POST /api/sequence/pause | /api/sequence/resume
GET  /api/sequence/plan    → liste des cibles par défaut (config)
```

- La config par défaut de séquence dans `config.yaml` → bloc `sequence:` (sera
  lu via `/api/config`, identique à `telescope:`).

## 4. Frontend — panneau « SÉQUENCE » (mode Capture)

- Table d'édition des frames : par ligne `durée | filtre | type | count | delay`.
- Boutons **▶ DÉMARRER**, **⏸ Pauser**, **⏹ STOP**, **Reset**.
- **Barre de progression** + compte `now/nowtotal` + frame courante (objet du
  log) poussé par WS.
- Afficher le **statut dither** (décalage appliqué, attendre).
- Log live dans le `applet-log` existant.

## 5. Dithering

- Endpoint du guide (`/api/guide/dither`) présumé réutilisable ; sinon
  implémenter un petit mouvement RA/DEC aléatoire dans la référence du guide
  (PHD2-style). Le runner appelle ce endpoint entre deux poses si la cfg
  `dither.enabled` et que le guidage fonctionne.

## 6. Tests

- Unitaire : `tests/test_sequence.py` (calcul de total, répartition des frames,
  progression, transition LIGHT→filtre→pose suivante, stop anticipé).
- Intégration : `tests/test_sequence_flow.py` (mock INDIGO + runner + save +
  dither) — même infra que `test_mount_flip.py`.
- UI : ajouter un spec Playwright (bouton DÉMARRER, progression, STOP).

## 7. Livraison

1. `sequence.py` + runner.
2. Endpoints + WS state.
3. Panneau UI + bindings.
4. Config `sequence:` par défaut.
5. Tests (unitaires, intégration, UI).
6. Lint (py, js) + suites complètes puis commit.

---

## Open questions à valider

- **Détection de fin de pose** : `CCD_EXPOSE` Idle vs `BLOB` push — choix d'implémentation.
- **Besoins du dithering** : déplacement max (pixels) et type (gaussien / uniforme).
- **Formats de pose** : distinguer `LIGHT` (avec filtre) vs `FLAT` (avec plage
  d'expiration) — besoin présumé minimal en v1.
- Le répertoire de sauvegarde : par cible/filtre questionne la structure existante.