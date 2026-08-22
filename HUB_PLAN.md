# Hub — Communication inter-panneaux complète

## Objectif
Remplacer les mutations DOM directes, appels REST inline et variables globales par un **médiateur unique** où chaque panneau déclare ses dépendances au démarrage. Plus de "comment ça marche ?", tout passe par le Hub avec logs debug visibles dans le log paneau.

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
│  • API unifiée : emit() / on() / getState() / setState()   │
│  • Tracking des dépendances (qui écoute qui ?)              │
│  • Logs de communication (debug visible dans le log paneau)│
│  • Gestionnaire d'erreurs cross-panel                       │
└──────────────────────────────────────────────────────────────┘
```

---

## Fonctionnalités du Hub

### 1. Pub/Sub centralisé
- Topics dynamiques (pas besoin de déclarer à l'avance)
- Enveloppe standardisée : `{ id, ts, topic, source, targets, kind, payload }`
- Support des requêtes/reponses async (`emit + reqId`)

### 2. Tracking des dépendances
- Chaque panneau déclare au Hub ce qu'il écoute au démarrage : `Hub.subscribe('device:connected', handler)` 
- Le Hub trace les subscriptions pour debug et validation
- Détection automatique si un consommateur est supprimé (nettoyage mémoire)

### 3. État partagé global
- `Hub.getState('mount')` → retourne l'état de la monture sans appel REST direct
- `Hub.setState('mount', { slewing: true })` → met à jour et notifie tous les abonnés
- Pas de mutation DOM directe entre panneaux

### 4. Logs de communication
- Chaque émission passe par le log paneau : `[Hub] capture.emit(device:connected) → guide, target, stacking`
- Visible dans le panneau Log → debug facile sans lire le code

### 5. Gestionnaire d'erreurs
- Si un handler plante, les autres ne sont pas affectés
- Logs l'erreur avec stack trace et continue la diffusion aux autres abonnés
- Pas de crash silencieux comme aujourd'hui

---

## Cas d'usage vérifiables (exemples concrets)

### CAS 1 : Connecter une caméra → carte du ciel FOV automatique
**Actuellement** : mutation DOM directe dans hardware.js, sky-engine ne sait pas qu'une caméra est connectée  
**Avec Hub** : `Hub.emit('device:connected', { name, type, sensorWidth, sensorHeight })` → guide, target, stacking, sky-engine tous mis à jour

### CAS 2 : Séquence en cours → flip méridien auto
**Actuellement** : code inline dans sequence.js pour gérer le flip  
**Avec Hub** : `Hub.emit('sequence:meridian_approaching', { timeLeft })` → séquence arrête capture/guidage, déclenche flip auto via mount

### CAS 3 : Calibration terminée → toast + démarrage guidage
**Actuellement** : déjà implémenté via bus events.js  
**Avec Hub** : même flux mais avec tracking des dépendances et logs debug

### CAS 4 : Capture en cours → stacking live update
**Actuellement** : push du statut via WebSocket au lieu du poll  
**Avec Hub** : `Hub.emit('capture:progress', { running, total, done })` → sequence, stacking, app tous mis à jour automatiquement

---

## Migration progressive (pas de big bang)

### Phase 1 : Coexistence bus + Hub ✅
- Garder le bus events.js tel quel pour les flux existants
- Le Hub est ajouté en parallèle avec les nouveaux cas d'usage
- Validation : les flux anciens continuent de fonctionner, les nouveaux passent par le Hub
- **Fait** : `web/static/hub.js` (subscribe/emit, enveloppe standardisée, logs `[Hub]` dans le panneau Log, isolation des erreurs), CAS 1 câblé (`device:connected` → guide/stacking/target/sky-engine, débouncing 1200 ms, payload enrichi `sensor` = dimensions/pixel capteur), tests : `tests/test_hub.js` (39/39), `tests/hub-ui.spec.js` (3/3), protocole manuel `tests/MANUAL_HUB_TESTS.md`, checklist annotée `tests/HUB_CHECKLIST.md`
- **Fait (2026-08-22)** : état partagé `setState`/`getState`/`watchState` (copie défensive, watcher tardif servi immédiatement) + requête/réponse async `request`/`respond` (reqId, timeout, log) ; ancien `getState(topic)` → `topics(topic)`

### Phase 2 : Migration des flux actuels vers le Hub
- Migrer topic par topic (ws:state, ws:image, solver:result, etc.)
- Chaque migration vérifiée avec tests Playwright + pytest

### Phase 3 : Suppression du bus legacy
- Une fois tous les flux migrés, supprimer events.js
- Tout passe par le Hub

---

## Tests et validation

### Unitaires (pytest)
- Test que le Hub émet/notifie correctement pour chaque cas d'usage
- Test de rollback si un handler plante

### UI (Playwright)
- Test que les panneaux se mettent à jour automatiquement quand un device se connecte
- Test que la séquence met en pause auto quand le flip est approché

### Integration (test_blanc_indigo)
- Test complet end-to-end avec simulateurs INDIGO

---

## Critères d'acceptation finaux

1. **Communication complète** : tous les cas d'usage sont couverts par le Hub
2. **Fluide** : pas de lag visible, mise à jour instantanée des panneaux concernés
3. **Facile à faire évoluer** : ajouter un nouveau topic = une ligne dans la subscription
4. **Debug facile** : logs visibles dans le panneau Log
5. **Résilient** : si un handler plante, les autres ne sont pas affectés
