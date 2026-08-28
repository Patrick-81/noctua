# Protocole de test manuel — Hub (médiateur unique, événements legacy supprimés)

> **Checklist annotée (but / méthode / attendu par case)** : `tests/HUB_CHECKLIST.md`

## Périmètre

Vérifie que le **Hub** (`web/static/hub.js`) est le médiateur unique de la
communication inter-panneaux :

- hub.js chargé sans erreur, **le Bus legacy (`events.js`) a été supprimé**
- Traces `[Hub] source.emit(topic) → targets` visibles dans le panneau Log
  (niveau `debug`, activées par `Hub.debug = true`)
- Notifications croisées entre panneaux (appareil connecté, flux WebSocket)
- Un handler qui lève n'empêche jamais la diffusion aux autres abonnés

Aucun équipement physique nécessaire : le mock INDIGO simule les appareils.

---

## Prérequis

```bash
# Terminal 1 : Mock INDIGO
source .venv/bin/activate
python tests/mock_indigo.py --port 17624

# Terminal 2 : Serveur web
source .venv/bin/activate
python run.py 127.0.0.1:17624 --port 8080
```

Ouvrir `http://localhost:8080` dans le navigateur.

---

## Tests automatisés (à lancer d'abord)

```bash
# Unitaires Hub (node) — attendu : « 39 passés, 0 échoués »
node tests/test_hub.js

# UI Playwright (Hub) — attendu : 3 passed (médiateur unique, plus de Bus)
npx playwright test hub-ui.spec.js

# Suite pytest complète — attendu : 194 passed, 0 échec
.venv/bin/python -m pytest tests/ -q
```

---

## Test 1 — Chargement de hub.js sans erreur, Bus supprimé

**But** : vérifier que le Hub est disponible et que le bus legacy a disparu.

**Méthode** : ouvrir la page, F12 → Console.

**Attendu** :
- `typeof Hub` → `"object"`
- `typeof Bus` → `"undefined"`
- zéro erreur dans la console

---

## Test 2 — Traces [Hub] dans le panneau Log

**But** : chaque émission est tracée, au niveau `debug`, avec la liste des
consommateurs (`targets`).

**Méthode** :
1. Console : `Hub.debug = true`
2. Panneau Log : cocher le filtre `debug`
3. Panneau Matériel : déconnecter puis reconnecter « Main Camera »

**Attendu** : ligne `[Hub] hardware.emit(device:connected) → guide, stacking`
après ~1,2 s (débouncing), pas de rafale.

---

## Test 3 — Un handler qui plante n'abîme pas les autres

**But** : résilience du Hub.

**Méthode** : Console →
`Hub.subscribe('device:connected', () => { throw new Error('boom'); })`, puis
reconnecter la caméra.

**Attendu** : erreur tracée au niveau `error` (avec stack), les abonnés de
`guide` et `stacking` quand même notifiés, UI utilisable.

---

## Test 4 — Flux WebSocket via le Hub

**But** : les informations serveur arrivent par le Hub et font vivre les panneaux.

**Méthode** : Console →
`Hub.subscribe('ws:state', 'manuel', e => console.log('ws:state OK', e.targets))`,
puis reconnecter un appareil.

**Attendu** : `ws:state OK` s'affiche ; certains panneaux se mettent à jour
(capture, focuser, monture…).