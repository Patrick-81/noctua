*Version française : [PLAN.md](PLAN.md)*

# Noctua — Project Plan

## Objective
Control INDIGO devices (mount, camera, focuser, filter wheel) via a minimalist web interface.

## Architecture
```
[INDIGO Server — indigo_server (real <indigo_host>:7624 or simulators)]
        ↕ TCP/XML (INDI legacy)
[Python indigo_devices]
  indigo/    → client, registry, devices
  web/       → FastAPI (REST + WebSocket)
        ↕ HTTP/WS
[Browser — vanilla JS]
```

## Stack
- **Backend**: Python 3.10, FastAPI, uvicorn, WebSocket, PyYAML
- **Frontend**: Vanilla JS (plain scripts, no build step), HTML5 Canvas, CSS glassmorphism
- **Protocol**: INDIGO/INDI XML over TCP (not WebSocket on the server side)
- **Python dependencies**: fastapi, uvicorn, websockets, pyyaml, Pillow, seiza, numpy

## Python Modules

| File | Role |
|---|---|
| `indigo/protocol.py` | INDIGO XML parser + builders (switch/number/text) |
| `indigo/client.py` | Asynchronous TCP client, auto-reconnect, probe_loop |
| `indigo/registry.py` | Device discovery, auto-connect, type upgrade |
| `indigo/profiles.py` | Hardware profile persistence (YAML) |
| `indigo/devices/base.py` | BaseDevice + GenericDevice, property serialization |
| `indigo/devices/mount.py` | Mount — INDIGO↔INDI name resolution, commands, meridian flip |
| `indigo/devices/camera.py` | CCD camera — expose(), abort(), is_ready, BLOB handling |
| `indigo/devices/focuser.py` | Focuser |
| `indigo/devices/filterwheel.py` | Filter wheel |
| `indigo/devices/guide.py` | Guide camera + orchestrated guiding loop |
| `indigo/devices/autofocus.py` | Autofocus (V-curve scan) |
| `indigo/devices/sequence.py` | Sequence scheduler (pause/resume/stop/reset, dithering) |
| `indigo/devices/live_stack.py` | Real-time stacking |
| `indigo/devices/exposure.py` | Ideal exposure time: test shot(s) → sky background extrapolation (ADU/s), 1-shot mode (bias=BZERO) and 3-shot mode (bias-independent linear fit + saturation detection), anti-saturation guard |
| `indigo/devices/solver.py` | Astrometric solver |
| `indigo/devices/focus_metrics.py` | Focus metrics (HFR/FWHM) |
| `indigo/devices/guide_calibration.py` | Guiding calibration |
| `indigo/devices/meridian.py` | Meridian / flip calculations |
| `web/server.py` | FastAPI wiring: registries, solver, sequence, stacking, WS broadcast, statics |
| `web/routers/*.py` | REST routes split by domain (each exposes `register(app, server)`) |
| `web/weblog.py` | Python handler → WebSocket (real-time logs) |

## Frontend Modules

| File | Role |
|---|---|
| `web/static/index.html` | Split layout, mode bar, panels |
| `web/static/i18n.fr.js` / `i18n.en.js` / `i18n.js` | FR/EN dictionaries + i18n engine |
| `web/static/ws.js` | WebSocket client + `Bus` dispatch |
| `web/static/events.js` | Event bus (pub/sub between panels) |
| `web/static/state.js` / `api.js` | Shared state + API access |
| `web/static/sky-engine.js` | Sky canvas renderer (star batching, cached catalogs) |
| `web/static/*.js` (per panel) | hardware, mount, camera/capture, focuser, guide, polar, sequence, stacking, session, target, objects, solver, preview, viewer, calibration, controls, layout, utils |

## API Endpoints

| Method | Route | Role |
|---|---|---|
| GET | `/api/devices` | All devices with state |
| GET | `/api/hardware` | Hardware panel state |
| POST | `/api/hardware/connect`, `/connect-all`, `/disconnect` | Connect / disconnect |
| GET/POST | `/api/profiles` | Hardware profiles (list/apply/delete) |
| GET | `/api/mount` | Mount state |
| GET | `/api/mount/flip/status` | Meridian flip status (due, HA, margin) |
| POST | `/api/mount/slew`, `/move`, `/halt`, `/abort`, `/tracking`, `/park`, `/unpark` | Mount control |
| GET | `/api/camera` | Camera state (includes `is_ready`) |
| POST | `/api/camera/expose`, `/abort`, `/temperature`, `/save` | Capture + temperature |
| GET | `/api/camera/exposure/recommend` | Ideal exposure from last image (measured sky background) |
| POST | `/api/camera/exposure/estimate` | Test shot(s) → recommend exposure time: `shots` 1\|3, `test_min/mid/max` (target background, anti-saturation) |
| GET | `/api/filterwheel` | Filter wheel state |
| POST | `/api/filterwheel/slot` | Change slot |
| GET | `/api/focuser` | Focuser state |
| POST | `/api/focuser/move`, `/move_relative`, `/halt`, `/speed` | Focuser control |
| GET/POST | `/api/focuser/autofocus/status`, `/start`, `/stop`, `/step`, `/finish`, `/reset` | Autofocus |
| GET | `/api/focuser/focus-metric` | HFR/FWHM |
| GET/POST | `/api/guide/status`, `/start`, `/stop`, `/step`, `/set-reference`, `/pause`, `/resume`, `/reset` | Guiding loop |
| GET/POST | `/api/guide/calibrate/*` | Guiding calibration |
| GET | `/api/sequence/status`, `/api/sequence/defaults` | Sequence status + defaults |
| POST | `/api/sequence/start`, `/stop`, `/pause`, `/resume`, `/reset` | Sequence control |
| GET | `/api/stacking/status`, `/api/stacking/snapshot` | Stacking status |
| POST | `/api/stacking/start`, `/stop`, `/reset`, `/save`, `/configure`, `/masters` | Stacking |
| GET | `/api/solver/status` | Solver status |
| POST | `/api/solver/solve`, `/api/solver/catalogs` | Astrometric solving |
| GET/POST | `/api/config` | Full configuration |
| GET/POST | `/api/ui` | Panel positions / persisted UI state |
| GET | `/api/site`, `/api/site/cities` | Observatory site + city search |
| GET | `/api/connection`, POST `/api/connection` | Connection state and host/port/protocol switching |
| GET | `/api/drivers`, POST `/api/drivers/attach` | INDIGO drivers |
| POST | `/api/property` | Generic setter (switch/number/text) |
| GET | `/ws` | WebSocket: real-time state, logs, images, stacking, sequence |

## WebSocket Pushes (type)

- `state` — device state (broadcast at interval)
- `log` — real-time server log lines
- `image` — encoded camera BLOB
- `solver_result` — solving result
- `stacking` — stacking status (no more frontend polling)
- `sequence` — sequence status (no more frontend polling)

## Catalog Data

| File | Content | Size |
|---|---|---|
| `public/celestial-data/stars.8.json` | **41411 stars** (magnitude ≤ 8, displayed via mag slider) | 5.4 MB |
| `public/celestial-data/dsos.6.bright.json` | 1383 DSOs rendered on the map (+ 3311 from the full catalog in search) | 260 KB |
| `public/celestial-data/dsonames.json` | 724 multilingual DSO names (English + French searchable) | 236 KB |
| `public/catalogs/bsc5.json` | 9096 stars (BSC5) | 2.6 MB |
| `public/catalogs/constellations.lines.json` | 743 constellation segments | 92 KB |
| `public/catalogs/messier.json` | 110 Messier objects | 39 KB |
| `public/catalogs/stars.json` | Additional stars | 18 KB |

Sky rendering: `web/static/sky-projection.js` (fast orthographic projection via unit
vectors + dot products, no d3 per star) — parity verified against
`d3.geo.orthographic` by `tests/sky-projection.spec.js` (1000+ points). No 80 ms
throttle on rendering, DSO position cache, fast-path `fillRect`, capped at
7000 stars drawn (brightest first) → drag/zoom at 60 FPS even at mag 8.

## INDIGO/INDI Protocol

- The server speaks **INDI legacy** (names `EQUATORIAL_EOD_COORD`, `TELESCOPE_MOTION_NS`, etc.)
- The Mount class uses `PROP_ALIASES` + `_resolve_prop_name()` to map INDIGO v2.0 → INDI legacy
- The client sends `getProperties` at startup, the server responds with `def*` then `set*`
- NaN/Inf floats are sanitized for JSON

## Tests

| Suite | Command | Status |
|---|---|---|
| Pytest unit tests | `python -m pytest tests/ -q` | 134/134 |
| Guide flow | `python tests/test_guide_flow.py` | pass |
| Sequence flow | `python tests/test_sequence_flow.py` | 27/27 |
| Live-stack flow | `python tests/test_live_stack_flow.py` | 65/65 |
| Autofocus flow | `python tests/test_autofocus_flow.py` | pass |
| Focus flow | `python tests/test_focus_flow.py` | pass |
| Hardware flow | `python tests/test_hardware_flow.py` | 45/45 |
| Playwright UI | `npx playwright test` | 48 specs (10 files) |
| Simulator dry run | `python tests/test_blanc_indigo.py` | see TODO 6 |

## Startup
```bash
./start.sh                    # Restart server (kills previous)
# or
source .venv/bin/activate && python3 run.py
```

## INDIGO Server
- `./start-mock-server.sh` for the mock server (dev)
- Real INDIGO: `<indigo_host>:7624`
- Web server: `http://0.0.0.0:8080`
