# Hub — Communication inter-panneaux (état : migration COMPLÈTE)

## Objectif

Remplacer les mutations DOM directes, appels REST inline et variables globales par un **médiateur unique** où chaque panneau déclare ses dépendances au démarrage. Plus de « comment ça marche ? », tout passe par le Hub avec logs debug visibles dans le panneau Log.

> **État actuel (28/08/2026) : les 3 phases sont terminées.** Le bus legacy
> `events.js` a été **supprimé** — il n'est plus chargé dans `index.html` ni
> référencé nulle part. Tous les flux passent par `Hub`. Une seule exception
> assumée : la couche sky map (`sky-engine.js`/`app.js`, modules ES) communique
> avec les scripts classiques via des globales `window.*` documentées.

---

## Architecture du Hub

```
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│   Panneau A   │     │   Panneau B   │     │   Panneau C   │
│  (ex: Capture)│     │  (ex: Guide)  │     │  (ex: Séq.)    │
└───────┬───────┘     └───────┬───────┘     └───────┬───────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│                    📡 NOCTUA HUB                              │
│                                                              │
│  • Pub/sub centralisé (bus + topics dynamiques)             │
│  • API unifiée : subscribe/emit + setState/getState/watchState │
│  • Requêtes/réponses async (request/respond + reqId)         │
│  • Logs de communication (debug visible dans le log paneau)  │
│  • Gestionnaire d'erreurs cross-panel                        │
└──────────────────────────────────────────────────────────────┘
```

---

## API

| Méthode | Rôle |
|---------|------|
| `Hub.subscribe(topic, source, fn)` | écoute un topic, retourne `unsubscribe` ; `fn` optionnelle = simple traçage |
| `Hub.emit(topic, payload, {source, kind, reqId})` | publie ; enveloppe `{id, ts, topic, source, targets, kind, reqId, payload}` |
| `Hub.setState(key, value)` / `Hub.getState(key)` | état partagé (copie défensive) |
| `Hub.watchState(key, source, fn)` | observe une clé d'état (servi immédiatement si déjà présent) |
| `Hub.request(topic, payload, {timeoutMs})` / `Hub.respond(env, value)` | requête/réponse async |
| `Hub.topics([topic])` | liste des topics suivis, ou présence d'un topic donné |
| `Hub.debug` (get/set) | active les traces `[Hub] source.emit(topic) → targets` (niveau `debug`) |

## Topics en service

- **Depuis WebSocket** (`ws.js`) : `ws:state`, `ws:log`, `ws:image`, `solver:result`, `stacking:update`, `sequence:update`
- **Monture** : `mount:slewed` (emit `mount.js`), `mode:changed` (emit `app.js`)
- **Appareils** : `device:connected` (emit `hardware.js`, débouncing 1200 ms, payload enrichi `sensor` = dimensions/pixel capteur)
- **Capture** : `capture:progress` (emit `capture.js`)
- **Calibration** : `calibration:done` (emit `calibration.js`)
- **Guidage** : `guide:starSelected` (emit `preview.js`)

## Consommateurs

| Consommateur | Topics écoutés |
|--------------|----------------|
| `ws.js` | — (producteur) |
| `api.js` | `ws:log`, `ws:image` |
| `hardware.js` | `ws:state`, `mode:changed` |
| `mount.js` | `ws:state` |
| `capture.js` | `ws:state` |
| `focuser.js` | `ws:state` |
| `guide.js` | `ws:state`, `device:connected`, `guide:starSelected`, `calibration:done` |
| `stacking.js` | `stacking:update`, `device:connected`, `mode:changed`, `capture:progress` |
| `sequence.js` | `sequence:update`, `capture:progress` |
| `solver.js` | `solver:result`, `ws:state`, `mode:changed` |
| `target.js` | `solver:result`, `mount:slewed` |
| `session.js` | `mount:slewed` |
| `dashboard.js` | `sequence:update`, `capture:progress` |
| `preview.js` | `ws:image` |
| `app.js` | `calibration:done`, `capture:progress` |

---

## Historique de la migration

### Phase 1 — Coexistence bus + Hub ✅
- `web/static/hub.js` créé (subscribe/emit, enveloppe standardisée, isolation des erreurs), CAS 1 câblé (`device:connected`), tests `test_hub.js`.
- État partagé `setState`/`getState`/`watchState` + requêtes/réponses async `request`/`respond`.

### Phase 2 — Migration des flux ✅
- Topics migrés topic par topic : `ws:state`, `ws:image`, `ws:log`, `solver:result`, `stacking:update`, `sequence:update`, `capture:progress`, `guide:starSelected`, `mount:slewed`, `device:connected`, `calibration:done`, `mode:changed`. Chaque migration vérifiée avec les specs Playwright.

### Phase 3 — Suppression du bus legacy ✅
- `events.js` **supprimé** de `index.html`, puis du dépôt. Plus aucune référence au `Bus` dans le code (seul un commentaire résiduel corrigé).
- `Hub` est désormais le **médiateur unique**.

---

## Tests

### Unitaires (node)

```bash
node tests/test_hub.js        # 39 tests — emit/état/request, isolation erreurs, [Hub] traces
node tests/test_polar_math.js # maths polaires
```

### UI (Playwright)

```bash
npx playwright test hub-ui.spec.js   # 3 tests — chargement sans Bus, device:connected + ligne [Hub], ws:state via Hub
```

## Critères d'acceptation (tous atteints)

1. **Communication complète** : tous les cas d'usage couverts par le Hub ✅
2. **Fluide** : pas de lag visible, mise à jour instantanée des panneaux concernés (débouncing 1200 ms sur `device:connected`) ✅
3. **Facile à faire évoluer** : ajouter un topic = une ligne de subscription ✅
4. **Debug facile** : `Hub.debug = true` + filtre `debug` du panneau Log → lignes `[Hub] source.emit(topic) → targets` ✅
5. **Résilient** : un handler qui lève n'affecte pas les autres abonnés (isolé + tracé) ✅