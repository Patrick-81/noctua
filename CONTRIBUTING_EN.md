# Contributing to Noctua

*Version française : [CONTRIBUTING.md](CONTRIBUTING.md)*

Thank you for your interest in Noctua! This project is a gift to the amateur astronomy community. Contributions are welcome and reviewed to keep quality and coherence.

> **Alpha stage: the best time to join.** The app runs in the lab (mock INDIGO), not yet in the field. Your field test, screenshot or small fix directly shapes the beta.

## Why contribute now?

- **Field testing** on your setup (mount serial `/dev/ttyUSB0` or network `host:port`) is as valuable as code
- **MIT, vanilla JS, no build** — readable, forkable in 5 minutes
- One `good first issue` = one concrete improvement for the beta

## Types of contributions

- **Feedback** — open an issue with `enhancement` / `bug` + mobile screenshot
- **Bug fixes** — fork → fix → PR
- **New features** — discuss first in an issue
- **Docs & translations** (i18n FR/EN)

## Quick start

```bash
git clone https://github.com/Patrick-81/noctua.git && cd noctua
git checkout portage-mobile
./install.sh
./start-mock-server.sh --port 17624  # terminal 1: simulated INDIGO
./start.sh 127.0.0.1:17624 --port 8080 # terminal 2: Noctua on mock
# then http://localhost:8080 from any device
```

With real hardware: `./start.sh 192.168.1.x:7624`

## Contribution process

1. **Open an issue** first to discuss
2. **Fork** and create a branch (`git checkout -b feat/my-feature`)
3. **Code** following project conventions
4. **Test**: `pytest tests/ -q` must pass, plus `node --check web/static/*.js`
5. **Open a PR** with a clear description and screenshot if UI

## Rules

### Code

- **No frameworks** — frontend is vanilla JS (classic scripts, no ES modules except `app.js`/`sky-engine.js`)
- **Python 3.10+** with type hints
- **No secrets** — never commit API keys or passwords
- **Single venv** — `.venv` is the standard

### Tests

- New features should include tests
- `pytest tests/ -q` must pass (285 tests)
- Playwright specs `tests/*.spec.js` for UI, mock `tests/mock_indigo.py` for dry runs

### Style

- Indent: 4 spaces (Python & JS)
- Python `snake_case`, JS `camelCase`
- One JS file = one domain (`mount.js`, `focuser.js`...)

## Project structure

```
indigo/       — Python backend (INDIGO client, devices, protocol)
web/static/   — Vanilla JS frontend
web/routers/  — FastAPI routes
tests/        — Pytest + Playwright
docs/         — User & dev docs (ALPHA.md / ALPHA_EN.md)
```

## Questions?

Open an issue with `question` or join Discussions / Discord.
