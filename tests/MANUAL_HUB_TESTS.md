# Protocole de test manuel — Hub (coexistence Bus legacy + Hub)

## Périmètre

Vérifie que le **Hub** (`web/static/hub.js`) fonctionne en parallèle du bus legacy
(`web/static/events.js`) sans perturber les flux existants :

- hub.js chargé sans erreur, coexiste avec `Bus`
- Émission `device:connected` à la connexion d'un appareil (débouncing 1200 ms)
- Ligne `[Hub] source.emit(topic) → targets` visible dans le panneau Log
- Les 4 panneaux abonnés (guide, stacking, target, sky-engine) sont notifiés
- Le bus legacy reste seul propriétaire des flux anciens (`ws:state`, `ws:image`, …)

Aucun équipement physique nécessaire : le mock INDIGO simule les appareils.

---

## Prérequis

```bash
# Terminal 1 : Mock INDIGO
source venv/bin/activate
python tests/mock_indigo.py --port 17624

# Terminal 2 : Serveur web
source venv/bin/activate
python run.py 127.0.0.1:17624 --port 8080
```

Ouvrir `http://localhost:8080` dans le navigateur.

---

## Tests automatisés (à lancer d'abord)

```bash
# Unitaires Hub (node) — attendu : « 20 passés, 0 échoués »
node tests/test_hub.js

# UI Playwright (Hub) — attendu : 3 passed
npx playwright test hub-ui.spec.js

# Rétrogression : le flux legacy guidage n'est pas cassé — attendu : 2 passed
npx playwright test guide-validation.spec.js

# Suite pytest complète — attendu : aucun échec hors tests/plate_solve.py
venv/bin/python -m pytest tests/ -q
```

> Les 2 échecs Playwright connus et préexistants (`session-ui.spec.js` panneau
> meridian-flip, `sky-projection.spec.js` slider magnitude) échouent aussi sans
> les changements Hub — ne pas les attribuer au Hub.

---

## Test 1 — Chargement de hub.js sans erreur

**But** : vérifier que le Hub est disponible et que rien ne casse au chargement.

### Étapes

1. Ouvrir `http://localhost:8080`
2. Ouvrir la console du navigateur (F12 → Console)
3. Attendre ~3 s que la page s'initialise et que la caméra mock se connecte

### Résultat attendu

- Aucune erreur rouge dans la console
- Dans la console : `typeof Hub` → `"object"`, `typeof Bus` → `"object"`
- `Hub` expose `subscribe`, `emit`, `getState`

---

## Test 2 — Connexion caméra → ligne [Hub] dans le Log

**But** : vérifier l'émission `device:connected` et son log visible.

### Étapes

1. Panneau **Matériel** : noter l'état de **Main Camera** (doit passer à « connecté »
   automatiquement après quelques secondes)
2. Ouvrir le panneau **Log** (mode Capture ou barre de modes)
3. Observer les lignes `[Hub]`

### Résultat attendu

- **Exactement une** ligne (pas un flot) :
  `[Hub] hardware.emit(device:connected) → guide, stacking, target, sky-engine`
- La ligne apparaît **1,2 s après** la stabilisation de la connexion (débouncing)
- Malgré les flaps de démarrage du mock (on/off rapides), une seule émission passe

### Cas limite à piquer

- Redémarrer le mock INDIGO (Ctrl+C puis relancer) : à la reconnexion, **une seule**
  nouvelle ligne `[Hub]` doit apparaître, pas une rafale
- Déconnecter la caméra depuis le panneau Matériel puis la reconnecter : une ligne
  `[Hub]` de plus, pas plus

---

## Test 3 — Notification des 4 panneaux abonnés

**But** : vérifier que guide, stacking, target et sky-engine reçoivent l'événement.

### Étapes

1. Console navigateur : noter les compteurs de test
   `window.__hubGuideNotified`, `window.__hubStackingNotified`,
   `window.__hubTargetNotified`, `window.__hubSkyNotified`
2. Déconnecter puis reconnecter **Main Camera** depuis le panneau Matériel
3. Relire les 4 compteurs

### Résultat attendu

- Les 4 compteurs ont chacun **augmenté de 1**
- Aucun panneau ne plante (pas d'erreur console)

---

## Test 4 — Le bus legacy reste intouchable

**But** : vérifier qu'aucun flux ancien n'a été migré ou cassé.

### Étapes

1. Console navigateur :
   ```js
   Bus.on('ws:state', () => console.log('ws:state OK'))
   ```
2. Attendre quelques secondes (les états INDIGO arrivent en continu)
3. Déclencher une capture depuis le panneau Capture
4. Observer : l'image live apparaît dans l'aperçu, les panneaux matériel/cible se
   mettent à jour comme avant le Hub

### Résultat attendu

- `ws:state OK` s'affiche dans la console
- L'image de capture arrive **sans** passer par le Hub (flux `ws:image` legacy)
- Aucun `console.error` du type `[Hub] topic inconnu`

---

## Test 5 — Isolation des erreurs de handlers

**But** : vérifier qu'un handler qui plante n'affecte pas les autres abonnés.

### Étapes

1. Console navigateur :
   ```js
   Hub.subscribe('device:connected', () => { throw new Error('boom test'); });
   ```
2. Déconnecter puis reconnecter **Main Camera**
3. Observer la console et le panneau Log

### Résultat attendu

- L'erreur `boom test` est loggée avec sa stack trace
- Les 3 autres abonnés (stacking, target, sky-engine) sont **toujours notifiés**
  (leurs compteurs `window.__hub*Notified` augmentent quand même)
- Le reste de l'UI reste fonctionnel (pas de crash)

---

## Test 6 — Topic non déclaré → log de diagnostic

**But** : vérifier qu'un `emit` sur un topic sans abonné est tracé.

### Étapes

1. Console navigateur :
   ```js
   Hub.emit('topic:test', { hello: 'world' }, { source: 'manuel' });
   ```

### Résultat attendu

- Ligne dans le panneau Log :
  `[Hub] manuel.emit(topic:test) → (aucun abonné)` (ou équivalent déclaratif)
- Aucune erreur levée, `emit` retourne `null`

---

## Test 7 — Rétrogression guidage (le flux le plus sensible)

**But** : le guidage est le flux qui a régressé pendant le développement du débouncing.

### Étapes

1. Mode **Guidage** : sélectionner la caméra mock, choisir une étoile, lancer la calibration
2. Lancer le guidage, laisser tourner ~30 s
3. Observer le graphe 120 s (RA/DEC) et le panneau Log

### Résultat attendu

- La calibration se termine, le guidage démarre, le graphe se dessine
- Pas de ligne `[Hub]` en rafale pendant le guidage
- `npx playwright test guide-validation.spec.js` → 2 passed (automatisé équivalent)

---

## Critères de régression globaux

| Suite | Commande | Attendu |
|-------|----------|---------|
| Unitaires Hub | `node tests/test_hub.js` | 20 passés, 0 échoués |
| Hub UI | `npx playwright test hub-ui.spec.js` | 3 passed |
| Guidage (rétro) | `npx playwright test guide-validation.spec.js` | 2 passed |
| pytest | `venv/bin/python -m pytest tests/ -q` | 0 échec hors `test_plate_solve.py` (préexistant) |
| Maths polaires | `node tests/test_polar_math.js` | 53/53 |

## Notes

- Le serveur Python doit être **redémarré** après toute modif Python ; le JS se
  recharge avec un simple refresh du navigateur.
- Les compteurs `window.__hub*Notified` sont du scaffolding de test exposé
  volontairement pour ces vérifications manuelles.
- Ports des specs Playwright Hub : mock 17640 / web 18098 (définis dans
  `tests/hub-ui.spec.js`, ne pas coller avec le serveur manuelle sur 8080).
