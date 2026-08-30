# Noctua — Référence de configuration

Référence exhaustive des fichiers de configuration. Le modèle est `config.example.yaml` (copiez-le vers
`config.yaml` puis ajustez) :

```bash
cp config.example.yaml config.yaml
```

- `config.yaml` : serveur INDIGO, web, site, télescope/flip, pose idéale, masters, séquence (dither, refocus, stack, frames, triggers).
- `profiles.yaml` : profils de matériel nommés.
- `ui.yaml` : état runtime de l'interface (positions des panneaux) — **ne pas éditer à la main** (réécrit par l'app).
- `sequence_templates.yaml` : templates de plans (Lot C3), gérés depuis l'interface.

---

## 1. `indigo` — serveur INDIGO

```yaml
indigo:
  host: 127.0.0.1        # adresse du serveur INDIGO (réel ou simulateurs)
  port: 7624             # le port INDIGO/INDI est toujours 7624
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `host` | `127.0.0.1` | Hôte du serveur INDIGO |
| `port` | `7624` | Port TCP (protocole INDI/XML) |
| `protocol` | `connect` | `connect` (connexion auto) ou `attach` (sélection manuelle d'un driver) |

> `./start.sh <host>:7624` et `--port 8080` surchargent ces valeurs sans toucher au fichier.

---

## 2. `web` — serveur HTTP

```yaml
web:
  host: 0.0.0.0          # interface d'écoute (0.0.0.0 = LAN local)
  port: 8080
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `host` | `0.0.0.0` | Adresse d'écoute de l'interface web |
| `port` | `8080` | Port de l'interface web (WS temps réel sur la même origine) |

⚠️ **Pas d'authentification** : réserver à un LAN local.

---

## 3. `site` — lieu d'observation

```yaml
site:
  name: Montdurausse
  latitude: 43.952        # degrés Nord (positif)
  longitude: 1.568        # degrés Est (positif)
  elevation: 210          # mètres
  timezone: Europe/Paris
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `name` | — | Nom du site → entête FITS (`SITEOBS` dans certains flux) et affichage |
| `latitude` / `longitude` | — | Coordonnées (degrés, N/E positifs) — calcul LST, altitude, visibilité |
| `elevation` | — | Altitude (m) |
| `timezone` | — | Fuseau IANA (ex. `Europe/Paris`) — horloges du site |

---

## 4. `exposure` — pose idéale et recentrage

```yaml
exposure:
  target_bg: 4000         # fond de ciel cible (ADU au-dessus du bias)
  shots: 1                # 1 = une pose (bias = BZERO) ; 3 = fit linéaire ADU(t)=bias+m·t
  test_min: 5.0           # pose de test la plus courte (s)
  test_mid: 15.0          # pose intermédiaire (mode 3 prises)
  test_max: 30.0          # pose de test la plus longue (s)
  min_exposure: 1.0
  max_exposure: 600.0
  saturation_frac: 0.6    # les pics d'étoiles restent sous cette fraction du plein-échelle
  recenter_duration: 2.0  # durée de pose (s) des recentrages par solve (flip/mosaïque)
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `target_bg` | `4000` | Fond de ciel cible en ADU au-dessus du biais pour « Mesurer le ciel » |
| `shots` | `1` | `1` = estimation bias-indépendante simple ; `3` = fit linéaire avec détection de saturation |
| `test_min` | `5.0` | Durée de la pose de test la plus courte (s) |
| `test_mid` | `15.0` | Pose intermédiaire (mode 3 prises) |
| `test_max` | `30.0` | Pose de test la plus longue (s) |
| `min_exposure` | `1.0` | Borne basse de la pose recommandée (s) |
| `max_exposure` | `600.0` | Borne haute de la pose recommandée (s) |
| `saturation_frac` | `0.6` | Les pics d'étoiles doivent rester sous cette fraction du plein-échelle |
| `recenter_duration` | `2.0` | Durée de pose (s) des poses de recentrage par solve (post-flip, tuiles mosaïque) |

---

## 5. `telescope` — flip méridien et télescope

```yaml
telescope:
  name: Newton 250/1000     # nom du télescope → entête FITS (TELESCOP)
  flip_enabled: true
  hour_angle_margin: 0.2
  min_altitude: 5.0
  flip_slew_rate: Centering
  recenter_after_flip: true
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `name` | — | Nom du télescope → `TELESCOP` dans les FITS |
| `flip_enabled` | `false` | Activer la bascule au méridien |
| `hour_angle_margin` | `0.2` | Marge d'angle horaire (heures) pour anticiper le flip |
| `min_altitude` | `0.0` | Altitude minimale pour autoriser le flip |
| `flip_slew_rate` | `Centering` | Vitesse de slew après flip |
| `recenter_after_flip` | `true` | Recentrer la cible par solve après le flip (nécessite la focale) |

L'anti-re-flip est géré automatiquement (le flip ne re-déclenche pas immédiatement après un flip).

---

## 6. `masters` — bibliothèque de masters (Lot C1)

```yaml
masters:
  dir: ~/asteo/captures/
```

| Clé | Défaut | Rôle |
|-----|--------|------|
| `dir` | `sequence.save_dir` | Racine de la bibliothèque : `<dir>/masters/<type>/{bias,dark,flat}/...` |

La bibliothèque catalogue les masters d'après les entêtes **normalisés** (filtre, binning, température,
exposition) et les résout automatiquement pour un contexte d'acquisition. Penser **bias<dark<flat** pour la
chaîne de calibration (le dark inclut le biais).

---

## 7. `sequence` — séquence d'acquisition

```yaml
sequence:
  save_dir: ~/asteo/captures/
  dither:
    enabled: true
    amount: 2.0                  # σ du décalage gaussien (px) appliqué à la référence de guidage
    settle_rms: 1.0              # seuil de stabilisation du guidage (″) — 0 = pas d'attente
    settle_timeout: 20.0         # temps max d'attente du settle (s)
    settle_stable: 3             # échantillons consécutifs sous le seuil pour considérer le settle OK
  refocus:
    enabled: false
    interval_min: 20             # refocus toutes les N minutes (0 = désactivé)
    alt_trigger_deg: 3.0         # refocus après un Δ d'altitude de N ° (0 = désactivé)
    exposure_sec: 1.0            # exposition de mesure du HFR (s)
    range: 2000                  # demi-plage de recherche de la V-curve (steps)
    points: 25                   # nombre de points de mesure
  stack:
    enabled: false
    max_frames: 0
  frames:
    - duration: 60.0
      frame_type: LIGHT
      filter: ""
      count: 1
      delay: 1.0
  triggers:
    - name: alerte-fin-de-serie
      event: series_done
      actions:
        - type: log
          level: info
          message: "Série terminée : {done}/{total} poses"
```

### 7.1 `save_dir`

Racine partagée des sessions. Layout (Lot C2) : avec une cible nommée → `<save_dir>/<cible>/<YYYY-MM-DD>/<HHMMSS>/`,
sinon `<save_dir>/capture_YYYYMMDD_HHMMSS/`. Chaque session persiste `journal.json` (progression, plan, tuiles
mosaïque) → **reprise** des poses manquantes aux index continus.

### 7.2 `dither` (Lot A1)

| Clé | Défaut | Rôle |
|-----|--------|------|
| `enabled` | `false` | Décaler la référence de guidage entre chaque pose |
| `amount` | `2.0` | σ du décalage gaussien en pixels |
| `settle_rms` | `1.0` | Seuil de dérive (″) sous lequel le settle est accepté ; `0` = pas d'attente |
| `settle_timeout` | `20.0` | Durée maximale d'attente du settle (s) |
| `settle_stable` | `3` | Nb d'échantillons consécutifs sous le seuil avant de valider le settle |

### 7.3 `refocus` (Lot B3)

| Clé | Défaut | Rôle |
|-----|--------|------|
| `enabled` | `false` | Refocalisation HFR automatique entre les poses |
| `interval_min` | `20` | Déclenchement après N minutes écoulées (0 = désactivé) |
| `alt_trigger_deg` | `3.0` | Déclenchement après un Δ d'altitude de N degrés (0 = désactivé) |
| `exposure_sec` | `1.0` | Durée de pose de mesure du HFR |
| `range` | `2000` | Demi-plage de recherche de la V-courbe (steps) |
| `points` | `25` | Nb de points de la V-courbe |

La **première pose** ne déclenche jamais (ligne de base enregistrée au départ). Un échec de refocus n'interrompt
pas la séquence (warning, continue).

### 7.4 `stack`

Rétro-compatibilité de l'ancienne poussée automatique des poses vers l'empileur :
`enabled: false` → stacking piloté uniquement par le panneau LIVE STACKING. `max_frames: 0` = continu.

### 7.5 `frames`

Plan d'exposition par défaut (chargé quand l'interface n'en fournit pas un). Chaque pose : `duration`,
`frame_type` (`LIGHT`/`DARK`/`FLAT`/`BIAS`), `filter`, `count`, `delay`.

### 7.6 `triggers` (Lot A2)

Réactions automatiques aux événements de la séquence. Un trigger a un `name`, un `event`, une liste `actions`,
et optionnel des `conditions` (ex. `frame_type: LIGHT` filtre les événements `frame_done`).

**Événements** : `sequence_start`, `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`.

**Actions** :

| Type | Paramètres | Effet |
|------|-----------|-------|
| `log` | `level` (info/warning/error), `message` | Écrit dans le journal |
| `script` | `command`, `timeout` | Exécute une commande externe (avec variables de contexte) |
| `mount_goto` | `ra` (heures), `dec` (°), `rate`* | Goto monture — `"now"` = position actuelle |

**Variables** disponibles dans `message`/`command` (selon l'événement) : `{done}`, `{total}`, `{index}`,
`{frame_type}`, `{filter}`, `{duration}`, `{saved_path}`, `{last_dither}`, `{error}`, `{frames}`, `{target}`,
`{session_dir}`, `{resumed}`. Les scripts reçoivent aussi les variables d'environnement `NOCTUA_<VAR>`
(mêmes clés, majuscules).

> Un trigger qui échoue n'arrête **jamais** la séquence (best effort, loggé).

---

## 8. `profiles.yaml` — profils matériel

```yaml
mon_profil:
  name: mon_profil
  mount: "Telescope Simulator"
  camera: "CCD Simulator"
  guide_camera: "Guider Simulator"
  focuser: "Focuser Simulator"
  filter_wheel: "Wheel Simulator"
  optics: {}
```

Chaque profil associe un rôle à un device (par nom). Activé depuis le mode Matériel. Chemin surchargeable par
`INDIGO_PROFILES_PATH`.

| Clé | Rôle |
|-----|------|
| `mount` | Nom du device monture |
| `camera` | Nom du device CCD principal |
| `guide_camera` | Nom du device CCD guide |
| `focuser` | Nom du device focuser |
| `filter_wheel` | Nom du device roue à filtres |
| `optics` | Données optiques éventuelles (non obligatoires) |

---

## 9. Variables d'environnement

| Variable | Rôle |
|----------|------|
| `INDIGO_PROFILES_PATH` | Chemin de `profiles.yaml` |
| `INDIGO_SEQUENCE_TEMPLATES_PATH` | Chemin de `sequence_templates.yaml` (templates Lot C3) |

---

## 10. Récapitulatif — nouvelles clés par lot

| Lot | Clés config |
|-----|-------------|
| A1 (dithering+settle) | `sequence.dither.{amount,settle_rms,settle_timeout,settle_stable}` |
| A2 (triggers) | `sequence.triggers[].{name,event,conditions,actions}` |
| B3 (refocus auto) | `sequence.refocus.{enabled,interval_min,alt_trigger_deg,exposure_sec,range,points}` |
| C1 (masters) | `masters.dir` |
| C2 (sessions/journaux) | `sequence.save_dir` (layout cible/date + journal.json) |
| C3 (templates) | fichier `sequence_templates.yaml` (+ var d'env) |
| C4 (entêtes FITS) | `telescope.name`, `site.*` (utilisés dans les entêtes) |
| D1 (mosaïque) | passée depuis l'interface (aucune clé dédiée nécessaire) |
| Flip + recentrage | `exposure.recenter_duration`, `telescope.recenter_after_flip` |