# Contribuer à Noctua

Merci de votre intérêt pour Noctua ! Ce projet est un cadeau à la communauté des astronomes amateurs. Les contributions sont les bienvenues, mais sont soumises à évaluation pour maintenir la qualité et la cohérence du projet.

## Types de contributions acceptées

- **Suggestions d'amélioration** — ouvrez une issue avec le tag `enhancement`
- **Signalement de bugs** — ouvrez une issue avec le tag `bug`
- **Corrections de bugs** — fork → fix → PR
- **Nouvelles fonctionnalités** — discutez d'abord dans une issue avant de coder
- **Améliorations de documentation**
- **Traductions** (i18n)

## Processus de contribution

1. **Ouvrez une issue** d'abord pour discuter de l'amélioration ou du bug
2. **Forkez** le dépôt
3. **Créez une branche** pour votre travail (`git checkout -b feat/ma-fonctionnalite`)
4. **Codez** en suivant les conventions du projet
5. **Testez** — les tests doivent passer (`pytest tests/ -q`)
6. **Envoyez une PR** avec une description claire

## Règles de contribution

### Code

- **Pas de frameworks** — le frontend est en JS vanilla (scripts classiques, pas de modules ES)
- **Python 3.10+** — utilisez les features modernes (type hints, match, etc.)
- **Pas de commentaires inutiles** — le code doit être lisible sans comments
- **Pas de secrets** — ne jamais committer de clés API, mots de passe, etc.
- **Un seul venv** — `.venv` est le répertoire standard

### Tests

- Tout ajout de fonctionnalité doit inclure des tests
- `pytest tests/ -q` doit passer
- Les specs Playwright (`tests/*.spec.js`) pour les tests UI
- Le mock INDIGO (`tests/mock_indigo.py`) permet de tester sans matériel

### Style

- Indentation : 4 espaces (Python), 4 espaces (JS)
- Noms de variables : `snake_case` (Python), `camelCase` (JS)
- Fichiers JS : un fichier = un domaine (mount.js, focuser.js, etc.)
- Les fichiers JS sont des scripts classiques (pas de modules ES), sauf `app.js`

## Structure du projet

```
indigo/          — Backend Python (client INDIGO, devices, protocol)
web/static/      — Frontend JS vanilla
web/routers/     — Routes FastAPI
tests/           — Tests pytest + Playwright
```

## Questions ?

Ouvrez une issue avec le tag `question` pour toute question sur le projet.
