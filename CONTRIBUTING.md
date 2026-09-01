# Contribuer à Noctua

*English version: [CONTRIBUTING_EN.md](CONTRIBUTING_EN.md)*

Merci de votre intérêt pour Noctua ! Ce projet est un cadeau à la communauté des astronomes amateurs. Les contributions sont les bienvenues et revues pour garder qualité et cohérence.

> **Alpha : le meilleur moment pour rejoindre.** L'app tourne en labo (mock INDIGO), pas encore sur le terrain. Votre test terrain, screen ou petit fix façonne directement la bêta.

## Pourquoi contribuer maintenant ?

- **Test terrain** sur votre setup (monture série `/dev/ttyUSB0` ou réseau `host:port`) vaut autant que du code
- **MIT, vanilla JS, sans build** — lisible, forkable en 5 minutes
- Un `good first issue` = une amélioration concrète pour la bêta

## Types de contributions acceptées

- **Retours** — ouvrez une issue `enhancement`/`bug` + screen mobile
- **Corrections de bugs** — fork → fix → PR
- **Nouvelles fonctionnalités** — discutez d'abord dans une issue
- **Docs & traductions** (i18n FR/EN)

## Démarrage rapide (alpha)

```bash
git clone https://github.com/Patrick-81/noctua.git && cd noctua
git checkout portage-mobile
./install.sh
./start-mock-server.sh --port 17624  # terminal 1 : INDIGO simulé
./start.sh 127.0.0.1:17624 --port 8080 # terminal 2 : Noctua sur mock
# puis http://localhost:8080 depuis n'importe quel appareil
```

Avec vrai matériel : `./start.sh 192.168.1.x:7624`

## Processus de contribution

1. **Ouvrez une issue** d'abord pour discuter
2. **Forkez** et créez une branche (`git checkout -b feat/ma-fonctionnalite`)
3. **Codez** en suivant les conventions
4. **Testez** : `pytest tests/ -q` doit passer, plus `node --check web/static/*.js`
5. **Envoyez une PR** avec description claire + capture si UI

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
