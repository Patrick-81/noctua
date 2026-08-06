# Chantier Meridian Flip (P0) — Plan

## Objectif

Intégrer le meridian flip à la **configuration du télescope** (bloc `telescope` de
`config.yaml`) et fournir :
1. la **détection** du franchissement du méridien (heure angulaire HA),
2. une **alerte + état** dans l'UI Monture,
3. un **bouton manuel "Flip"** qui exécute : arrêt propre guidage/capture → abort
   → slew vers la même cible → recentrage.

Périmètre validé utilisateur :
- Config dans `site:`/`telescope:` de `config.yaml` (via `/api/config` et UI Monture).
- Portée : détection + alerte + bouton manuel.
- Coordination : arrêt propre guidage+capture, flip, reprise manuelle.

---

## 1. Concepts astronomiques

- **Heure angulaire** `HA = LST − RA` (en heures).
- **LST** (Local Sidereal Time) calculée depuis longitude du site + horloge système.
- À l'est du méridien (cible en montée) : `HA < 0`. À l'ouest (descendante) : `HA > 0`.
- **Franchissement du méridien** : `HA` passe de négatif à positif (sur une monture
  équatoriale GEM), c'est le moment du flip.
- **Marge de flip** (conf) : flip déclenché/périmètre quand `HA >= hour_angle_margin`
  (par défaut ~0.0 soit exactement au méridien ; on peut anticiper avec une marge
  négative ou positive).
- **Altitude min** (conf) : ne pas tenter un flip sous une altitude horizon minimum
  (évite l'image retournée / butée). Par défaut ~0°.

Formules de LST (réutilisées côté JS, cf. `_lstDegrees` du `sky-engine.js`) :

```
jd  = jd(now)
T  = (jd - 2451545.0) / 36525.0
lst = (GMST + lon) mod 360         # degrés
HA  = (LST_deg - RA_deg) / 15     # heures, normalisé dans [-12, +12]
```

---

## 2. Configuration `config.yaml`

```
site:
  name: Montdurausse
  latitude: 43.952
  longitude: 1.568
  elevation: 210
  timezone: Europe/Paris
telescope:
  flip_enabled: true
  hour_angle_margin: 0.5      # heures (0 = au méridien exact ; >0 anticipe)
  min_altitude: 5.0           # degrés — pas de flip sous cette altitude
  flip_slew_rate: Centering   # vitesse de repos pour le flip (Guide/Centering/Find/Max)
  recenter_after_flip: true   # relance solve+centre après le flip
```

- Lu/écrit par `WebServer` via le même mécanisme que `site:` (persistance écriture
  `config.yaml`).
- Exposé par `GET /api/config` (fusionne `site` + `telescope`).
- Modifiable par `POST /api/config` (bloc `telescope`).

---

## 3. Backend — module flip

Nouveau module léger `indigo/devices/meridian.py` (pur Python, sans dépendance) :

```python
def local_sidereal_time_deg(longitude_deg, now=None) -> float   # LST en degrés
def hour_angle_hours(ra_hours, lst_deg) -> float                # normalisé dans [-12,+12]
def flip_due(ha_hours, margin_hours, min_alt_deg, alt_deg) -> bool
def time_to_flip(ha_hours, margin_hours) -> float               # heures ; négatif si déjà passé
```

Intégré dans :
- `Mount.state_dict()` : renvoie `lst_deg`, `ha_hours`, `ha_time_to_flip`, `flip_due`,
  `flip_side` (est/ouest) et la config `telescope`.
- Le calcul HA/LST se fait côté serveur (le site-config du serveur), à chaque
  émission d'état (`_emit_state()`) ou appel de `GET /api/mount`, pour rester frais.

Note : le mock n'émet pas de `side_of_pier` — on détermine le côté par le signe de
`HA` (est/ouest). On l'affiche comme info.

---

## 4. Endpoints API

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/config` | retourne `{site, telescope}` |
| POST | `/api/config` | enregistre `telescope` dans `config.yaml`, recharge |
| GET | `/api/mount/flip/status` | état flip calculé + config |
| POST | `/api/mount/flip` | exécute la séquence de flip |

**POST `/api/mount/flip` — séquence :**
1. Capture en cours → stop propre (exposition en cours arrêtée).
2. Guidage en cours → `/api/guide/stop`.
3. `abort()` sur la monture.
4. Slew vers la coordonnée actuelle (capturée avant abort) `/api/mount/slew`.
5. Optionnel : si `recenter_after_flip` et solveur dispo → solve+centre sur la cible.
6. Réactive tracking le cas échéant.

Retourne `{ok, phases:[...]}` ou une erreur `{ok:false,error}`.

---

## 5. Mock INDIGO — support flip

- Le serveur calcule HA/LST à partir du site + horloge réelle (pas besoin d'horloge
  simulée pour la détection).
- Ajouter une propriété `side_of_pier` (setSwitch) simulée qu'on peut forcer pour le
  test de détection, et un `defSwitch` `MOUNT_FLIP` simulé pour tester le déclenchement
  sans vraie monture.

---

## 6. Frontend — panneau Monture

Ajouter au panneau PILOTAGE (`#applet-pilotage`) un bloc "MERIDIAN FLIP" :
- **Toggle** "Flip auto" (config `telescope.flip_enabled`).
- **Champ "Marge HA"** (heures).
- **Champ "Alt min"** (degrés).
- **Indicateur état** : "HA +0h20 — flip dans 5 min" ou "FLIP DUE (ouest)" coloré
  rouge/vert selon `flip_due`.
- **Bouton** "⟳ FLIP" : appelle `/api/mount/flip` et log.

Rendu intégré à `renderMountPanel()` (ou un `renderFlipPanel()` dédié appelé dans le
flux de rendu).

---

## 7. Tests et validation finale

- `tests/test_meridian_calc.py` : tests unitaires (LST/HA/flip_due/time_to_flip).
- `tests/test_mount_flip.py` : intégration backend (calcul HA, state_dict, endpoint
  flip, config).
- Tests Playwright : détection/état dans l'UI Monture + bouton Flip.
- Non-régression : suite pytest complète + Playwright complète + polar JS.
- Lint (`node --check`, import Python) avant commit.
