# Checklist de tests — Hub (médiateur unique, Phase 3 atteinte)

Checklist de validation de la **migration complète vers le Hub** (`events.js`
supprimé). Légende : ✅ = passe, ⛔ = échoue.

---

## A. Tests automatisés (à lancer en premier)

- [ ] **A1. Unitaires Hub — `node tests/test_hub.js`**
  - *But* : valider le contrat du Hub en isolation (pas de navigateur) :
    subscribe/emit, enveloppe `{id, ts, topic, source, targets, kind, payload}`,
    isolation d'un handler en erreur, désabonnement, état partagé
    (setState/getState/watchState), requêtes/réponses (request/respond), traces
    `[Hub]` (dépend de `Hub.debug = true`, activé dans le test).
  - *Méthode* : `node tests/test_hub.js`
  - *Attendu* : `39 passés, 0 échoués`.

- [ ] **A2. UI Hub — `npx playwright test hub-ui.spec.js`**
  - *But* : vérifier en navigateur réel (mock INDIGO + serveur web) que :
    1. hub.js charge sans erreur et **le Bus legacy a disparu** (`typeof Bus === 'undefined'`),
    2. la connexion d'une caméra mock produit une ligne
       `[Hub] hardware.emit(device:connected) → …` dans le panneau Log (mode
       `Hub.debug = true` + filtre `debug` actif) et délivre le payload aux abonnés,
    3. les flux WebSocket (`ws:state`) arrivent bien via le Hub.
  - *Méthode* : `npx playwright test hub-ui.spec.js` (la spec lance elle-même mock sur 17640 + web sur 18098)
  - *Attendu* : `3 passed`.

- [ ] **A3. Suite pytest — `.venv/bin/python -m pytest tests/ -q`**
  - *But* : le Hub est 100 % frontend, mais la règle du jeu : pas de régression
    côté serveur.
  - *Attendu* : `194 passed, 0 échoué`.

- [ ] **A4. Plus aucune trace de `Bus` — `rg -n "Bus" web/static/`**
  - *But* : preuve de la Phase 3 — le bus legacy n'existe plus.
  - *Attendu* : aucune occurrence de `Bus.on`/`Bus.emit`/`bus.` dans le code
    (uniquement d'éventuels commentaires explicatifs).

- [ ] **A5. Syntaxe JS — `node --check` sur les fichiers modifiés**
  - *But* : détection de toute erreur de syntaxe résiduelle.
  - *Attendu* : silence (aucune sortie = OK).

---

## B. Tests manuels navigateur (mock INDIGO, ~5 min)

Prérequis : `python tests/mock_indigo.py --port 17624` (T1) puis
`python run.py 127.0.0.1:17624 --port 8080` (T2), ouvrir `http://localhost:8080`.

- [ ] **B1. Chargement propre**
  - *Action* : ouvrir la page, F12 → Console, attendre 3 s.
  - *Attendu* : zéro erreur rouge ; `typeof Hub` → `"object"` ; `typeof Bus` → `"undefined"`.

- [ ] **B2. Traces `[Hub]` dans le panneau Log**
  - *Action* : Console → `Hub.debug = true`, cocher le filtre `debug` du panneau
    Log, puis déconnecter/reconnecter une caméra dans le panneau Matériel.
  - *Attendu* : une ligne `[Hub] hardware.emit(device:connected) → guide, stacking`
    après ~1,2 s de stabilité (débouncing 1200 ms).

- [ ] **B3. Résilience : un handler qui plante n'abîme pas les autres**
  - *Action* : Console →
    `Hub.subscribe('device:connected', () => { throw new Error('boom'); })`
    puis reconnexion caméra.
  - *Attendu* : l'erreur est loggée avec stack trace au niveau `error`, les
    abonnés de `guide`/`stacking` sont quand même notifiés, l'UI reste utilisable.

- [ ] **B4. Topic sans abonné → log de diagnostic, pas d'exception**
  - *Action* : Console → `Hub.emit('topic:test', {}, { source: 'manuel' })`.
  - *Attendu* : ligne `[Hub] manuel.emit(topic:test) → (aucun)` (si debug actif),
    retour d'une enveloppe, aucune exception.

---

## C. Critères d'acceptation (récapitulatif)

| # | Critère | Prouvé par |
|---|---------|-----------|
| 0 | hub.js chargé sans erreur, suites existantes intactes | A1, A3, B1 |
| 1 | flux WebSocket migrés (ws:state, ws:image, ws:log, solver:result…) | A2.3, B1 |
| 2 | `device:connected` notifie les abonnés + ligne `[Hub]` au debug | A1, A2.2, B2 |
| 3 | Un handler qui lève n'bloque pas les autres abonnés | A1, B3 |
| 4 | `events.js` supprimé — zéro référence au Bus legacy | A2.1, A4, B1 |

## D. Pièges

- **Traces `[Hub]`** : le panneau Log les masque tant que le filtre `debug` est
  décoché (par défaut) ; de plus elles ne sont émises que si `Hub.debug = true`.
- **Flaps du mock INDIGO** : au démarrage le mock fait osciller les états de
  connexion très vite — c'est normal et c'est précisément ce que le débouncing
  1200 ms doit absorber.
- **Le serveur Python ne se recharge pas** : après toute modif Python → relancer
  `run.py`. Le JS, lui, se recharge au refresh du navigateur.
- **Ports** : la spec `hub-ui.spec.js` utilise 17640/18098 ; ne pas la lancer en
  parallèle d'un serveur manuel sur ces ports (`fuser -k 17640/tcp` si besoin).