# Checklist de tests — Hub Phase 1 (avec explications)

Checklist de validation de la **Phase 1 du Hub** (coexistence Bus legacy + Hub).
Chaque case est un point de contrôle indépendant : **but** = ce qu'on vérifie et pourquoi,
**méthode** = comment, **attendu** = le résultat qui fait cocher la case.

Légende : ✅ = vert = la case est passée.

---

## A. Tests automatisés (à lancer en premier, ~3 min)

- [ ] **A1. Unitaires Hub — `node tests/test_hub.js`**
  - *But* : valider le contrat du Hub en isolation (pas de navigateur) :
    subscribe/emit/getState, format de l'enveloppe `{id, ts, topic, source, targets, kind, payload}`,
    isolation des erreurs d'un handler, `emit` sur topic non déclaré → `null`.
  - *Méthode* : `node tests/test_hub.js`
  - *Attendu* : `20 passés, 0 échoués`.

- [ ] **A2. UI Hub — `npx playwright test hub-ui.spec.js`**
  - *But* : vérifier en navigateur réel (mock INDIGO + serveur web) que :
    1. hub.js charge sans erreur et coexiste avec `Bus`,
    2. la connexion d'une caméra mock produit **une** ligne `[Hub] hardware.emit(device:connected) → guide, stacking, target, sky-engine` dans le panneau Log et notifie les 4 abonnés,
    3. le bus legacy reçoit toujours `ws:state` (flux anciens intacts).
  - *Méthode* : `npx playwright test hub-ui.spec.js` (la spec lance elle-même mock sur 17640 + web sur 18098)
  - *Attendu* : `3 passed`.

- [ ] **A3. Rétrogression guidage — `npx playwright test guide-validation.spec.js`**
  - *But* : le guidage est le flux le plus sensible (détection de connexion + calibration).
    Garantir que le débouncing 1200 ms et les abonnés Hub ne cassent pas le workflow
    calibration → gains auto → guidage.
  - *Méthode* : `npx playwright test guide-validation.spec.js`
  - *Attendu* : `2 passed`.

- [ ] **A4. Suite pytest — `venv/bin/python -m pytest tests/ -q`**
  - *But* : aucun impact côté serveur (le Hub est 100 % frontend, mais la règle du jeu).
  - *Méthode* : `venv/bin/python -m pytest tests/ -q`
  - *Attendu* : 0 échec hors `tests/test_plate_solve.py` (6 échecs **préexistants**,
    problème de catalogue seiza, sans rapport avec le Hub).

- [ ] **A5. Zéro diff sur le bus legacy — `git diff` ciblé**
  - *But* : critère de coexistence — `events.js` et ses 9 topics ne doivent
    **aucunement** avoir bougé.
  - *Méthode* : `git diff HEAD -- web/static/events.js` (doit être vide) et
    `git show --stat HEAD` (vérifier qu'aucun topic events.js n'est modifié).
  - *Attendu* : aucun changement dans `events.js`.

- [ ] **A6. Syntaxe JS — `node --check` sur les fichiers modifiés**
  - *But* : détection de toute erreur de syntaxe résiduelle avant de lancer le navigateur.
  - *Méthode* : `for f in hub.js hardware.js guide.js stacking.js target.js app.js; do node --check web/static/$f; done`
  - *Attendu* : silence (aucune sortie = OK).

---

## B. Tests manuels navigateur (mock INDIGO, ~10 min)

Prérequis : `python tests/mock_indigo.py --port 17624` (T1) puis
`python run.py 127.0.0.1:17624 --port 8080` (T2), ouvrir `http://localhost:8080`.

- [ ] **B1. Chargement propre**
  - *But* : hub.js s'ajoute au chargement sans casser l'initialisation de l'UI.
  - *Méthode* : ouvrir la page, F12 → Console, attendre 3 s.
  - *Attendu* : zéro erreur rouge ; `typeof Hub` → `"object"` ; `typeof Bus` → `"object"`.

- [ ] **B2. Une seule ligne [Hub] malgré les flaps de démarrage**
  - *But* : le mock envoie des on/off rapides au démarrage (jusqu'à 9 ms d'écart).
    Le débouncing 1200 ms doit les absorber : c'est LE comportement clé de la Phase 1.
  - *Méthode* : ouvrir le panneau **Log**, attendre la connexion auto de la caméra.
  - *Attendu* : **exactement une** ligne `[Hub] hardware.emit(device:connected) → guide, stacking, target, sky-engine`,
    pas une rafale.

- [ ] **B3. Reconnexion → une ligne de plus**
  - *But* : vérifier que le timer est annulé/reposé proprement à chaque cycle
    (pas de timer orphelin, pas de double émission).
  - *Méthode* : panneau Matériel → déconnecter **Main Camera** → reconnecter.
  - *Attendu* : une seule nouvelle ligne `[Hub]` après ~1,2 s de stabilité.

- [ ] **B4. Les 4 panneaux sont réellement notifiés**
  - *But* : la ligne `[Hub]` prouve l'émission ; les compteurs prouvent la **réception**.
  - *Méthode* : Console → `window.__hubGuideNotified`, `__hubStackingNotified`,
    `__hubTargetNotified`, `__hubSkyNotified` → noter → reconnexion caméra → relire.
  - *Attendu* : les 4 compteurs ont chacun augmenté de 1.

- [ ] **B5. Résilience : un handler qui plante n'abime pas les autres**
  - *But* : critère de résilience du plan — un panneau en erreur ne doit pas
    bloquer la diffusion aux autres abonnés.
  - *Méthode* : Console →
    `Hub.subscribe('device:connected', () => { throw new Error('boom'); })`
    puis reconnexion caméra.
  - *Attendu* : l'erreur est loggée avec stack trace, les 3 autres abonnés sont
    quand même notifiés (compteurs +1), l'UI reste utilisable.

- [ ] **B6. Topic sans abonné → log de diagnostic, pas d'exception**
  - *But* : debug facilité — toute émission sur topic non déclaré est tracée
    dans le panneau Log (format `[Hub] source.emit(topic) → targets`).
  - *Méthode* : Console → `Hub.emit('topic:test', {}, { source: 'manuel' })`.
  - *Attendu* : ligne `[Hub] manuel.emit(topic:test) → …` dans le Log, retour `null`,
    aucune exception.

- [ ] **B7. Le bus legacy reste seul propriétaire des flux anciens**
  - *But* : preuve de coexistence — images live, états INDIGO, toasts passent
    **toujours** par `events.js`, pas par le Hub.
  - *Méthode* : Console → `Bus.on('ws:state', () => console.log('ws:state OK'))`,
    attendre, puis lancer une capture rapide.
  - *Attendu* : `ws:state OK` s'affiche ; l'image live arrive dans l'aperçu ;
    aucun `console.error` `[Hub] topic inconnu`.

- [ ] **B8. Workflow guidage complet (rétrogression finale)**
  - *But* : le parcours utilisateur le plus complet qui traverse la détection de
    connexion (modifiée) + calibration + guidage.
  - *Méthode* : mode Guidage → caméra mock → sélectionner étoile → calibration →
    démarrer guidage → laisser tourner 30 s.
  - *Attendu* : calibration OK, graphe 120 s qui se dessine, pas de rafale `[Hub]`
    dans le Log pendant le guidage.

---

## C. Critères d'acceptation Phase 1 (récapitulatif)

| # | Critère | Prouvé par |
|---|---------|-----------|
| 0 | hub.js chargé sans erreur, suites existantes intactes | A1, A2, A3, A4, B1 |
| 1 | `emit` topic non déclaré → ligne `[Hub]` visible dans le Log | A1, B6 |
| 2 | Un handler qui lève n'bloque pas les autres abonnés | A1, B5 |
| 3 | Connexion caméra (mock) → guide/target/stacking/sky-engine notifiés | A2, B2, B3, B4 |
| 4 | Zéro modification des topics events.js | A5, B7 |

## D. Connaître avant de tester (pièges)

- **Flaps du mock INDIGO** : au démarrage le mock fait osciller les états de
  connexion très vite. C'est **normal** et attendu — c'est précisément ce que le
  débouncing 1200 ms doit absorber. Si on voit une rafale `[Hub]`, c'est un échec.
- **Le serveur Python ne se recharge pas** : après toute modif Python → relancer
  `run.py`. Le JS, lui, se recharge au refresh du navigateur.
- **Ports** : la spec `hub-ui.spec.js` utilise 17640/18098 ; ne pas la lancer en
  parallèle d'un serveur manuel sur ces ports (`fuser -k 17640/tcp` si besoin).
- **Échecs préexistants (ne pas attribuer au Hub)** : pytest `test_plate_solve.py`
  (6 échecs, catalogue seiza), Playwright `session-ui.spec.js` (panneau meridian-flip)
  et `sky-projection.spec.js` (slider magnitude) — ils échouent aussi sans le Hub.
