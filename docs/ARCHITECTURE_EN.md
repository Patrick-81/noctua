---
nav_exclude: true
---

*Version française : [ARCHITECTURE.md](ARCHITECTURE.md)*

# Noctua — Architecture (developer view)

Noctua is a **web interface** (FastAPI + Vanilla JS, no build step) for controlling astronomical equipment
via an [INDIGO](https://www.indigo-astronomy.org/) server (INDI/XML protocol over TCP, port 7624).

Two "worlds":

1. **Python backend**: a native INDIGO client (TCP), a device layer (`indigo/devices`), and an
   HTTP/WebSocket server (FastAPI) that exposes states and commands to the browser.
2. **Frontend**: classic scripts loaded in order by `index.html` + a "sky map" layer as real
   ES modules (`app.js`, `sky-engine.js`, `sky-projection.js`). All inter-panel flows go through
   **`hub.js`** (pub/sub bus + shared state).

```
┌───────────────┐   HTTP REST + WS   ┌───────────────────────┐   TCP/INDI(XML)   ┌────────────────┐
│   browser     │ ◄────────────────► │  WebServer (FastAPI)  │ ◄───────────────► │  indigo_server  │
│  hub.js + ▸◂  │                    │  routers/* + server.py│                   │  (port 7624)    │
└───────────────┘                    └──────────┬────────────┘                   └────────────────┘
                                                 │
                                     indigo/ (DeviceRegistry, devices/*)
```

---

## 1. Directory Structure

```
run.py                 # entry point: loads config → IndigoClient + DeviceRegistry + WebServer
indigo/
  client.py            # IndigoClient: TCP XML, auto-reconnect (RECONNECT_DELAY=3.0, MAX_RECONNECT=10)
  protocol.py          # PropertyVector, parse_xml_message, build_* (INDIGO XML)
  registry.py          # DeviceRegistry: discovery, auto-connect, dispatch of def/set
   profiles.py          # ProfileStore: YAML profiles (fields mount_interface/mount_endpoint)
  plate_solve.py       # backend astrometric solver (Seiza)
  devices/             # pure logic (no HTTP dependency)
    base.py            # BaseDevice (to extend), GenericDevice; _sanitize NaN/Inf
    mount.py camera.py focuser.py filterwheel.py guide.py
    guide_calibration.py   # mount calibration state (short exposures, lost star → retry)
    autofocus.py           # V-curve/refocus: HFR V-curve scan, run_autofocus
    focus_metrics.py       # HFR/FWHM of a star, Gaussian quality
    exposure.py            # exposure estimation (ADU/s, 3-frame fit)
    meridian.py            # LST, hour angle, flip anticipation (margin, anti-re-flip)
    live_stack.py          # LiveStackEngine (alignment, rejection, calibration, master)
    sequence.py            # SequenceRunner (plan, pause/resume/stop, journal) + file helpers
    solver.py              # Solver (Seiza): solve_image (index/blind), WCS
    triggers.py            # TriggerManager: events → actions (log/script/goto)
    templates.py           # SequenceTemplateStore: named YAML templates (C3)
    fitsmeta.py            # normalized FITS headers: read_header/inject_meta/frame_meta (binary, without astropy)
    masters.py             # MasterLibrary (C1): scan/build/resolve/delete
    refocus.py             # RefocusPolicy (time/altitude) + server-side V-curve (B3)
    flat_wizard.py         # FlatWizard: state machine (target ADU, AUTO)
    pointing.py            # PointingModel: samples, parametric fit + IDW correction
    mosaic.py              # plan_mosaic / camera_fov / expand_frames (D1, pure)
web/
  server.py            # WebServer: FastAPI wiring, WS broadcast, MasterLibrary, PointingModel,
                       # refocus_policy, _recenter_by_solve, FITS saving + header injection (C4)
  routers/             # register(app, server) per domain
  static/              # UI: index.html, hub.js, ws.js, api.js, i18n.{fr,en}.js, panels *.js, style.css
tests/                 # pytest + flows run directly + node tests + Playwright specs
docs/                  # UTILISATION.md, CONFIGURATION.md, ARCHITECTURE.md, screenshots
```

## 2. Backend — Client and Devices

### 2.1 Connection (`indigo/client.py`, `protocol.py`, `registry.py`)

- `IndigoClient(indigo_host_port, protocol)`: TCP socket, INDIGO XML frame (`<def>`, `<set>`, `<getProperties>`).
  Automatic reconnection (`RECONNECT_DELAY`, `MAX_RECONNECT`).
- `protocol.py`: `PropertyVector` (property vector normalization), `parse_xml_message`,
  `build_*` (building XML requests).
- `DeviceRegistry`: maintains discovered devices, applies auto-connect, and **dispatches** each `def`/`set`
  to the relevant `BaseDevice` (methods `_apply_def` / `_apply_set`).

### 2.2 Device Layer (`indigo/devices/`)

Each device extends `BaseDevice` and exposes a `state_dict()` (real-time state) + command methods.
Key points:

- `_sanitize` (base.py) neutralizes `NaN`/`Inf` before any serialization.
- **Names**: `mount.py`, `camera.py`, etc. resolve **native INDIGO names** (`MOUNT_EQUATORIAL_COORDINATES`,
  `CCD_EXPOSURE`…) and handle variants (alias-based resolution, see `_resolve_prop_name`/`_resolve_item_name`).
- **Guiding**: calibration and the guiding loop are orchestrated **on the frontend** (centroid measurement, pulses),
  but **dithering and settle** are applied **server-side** from the sequence (`indigo/devices/guide.py`
  `apply_dither`: reference shift + stabilization wait `settle_rms`/`settle_stable`/`settle_timeout`).

### 2.3 Business Logic (pure modules, testable without INDIGO)

| Module | Responsibility |
|--------|----------------|
| `mosaic.py` (D1) | `camera_fov()` (FOV = `width_px·pixel_µm/1000`/focal length, independent of binning), `plan_mosaic()` (N×M grid: `cols = ceil(span_x/step_x)`, `step = fov·(1−overlap)`, RA correction `step_w/cos(dec)` clamped `MIN_COS_DEC=0.15`, wrap `%360`, `MAX_OVERLAP=0.90`), `expand_frames()` (plan expansion into exposures per tile: keys `tile`, `goto_ra_hours`, `goto_dec_deg`, `tiles_total`) |
| `fitsmeta.py` (C4) | Normalized FITS header without astropy: `frame_meta()` (standard KEYWORDS), `inject_meta()` (binary rewrite of 80-byte cards, DATA bit-identical; vocabulary ≤ 8 characters, accents transliterated), `read_header()` |
| `masters.py` (C1) | `MasterLibrary`: `scan()` (catalog `<root>/masters/<type>/…` from headers), `build()` (median of a raw series), `resolve()`/`resolve_all()` (best master by filter/binning/temperature with fallbacks), `delete()` |
| `refocus.py` (B3) | `RefocusPolicy`: `should_refocus(now, alt)` on time interval and/or altitude Δ; `run_autofocus` V-curve **entirely server-side**; `mark_refocused` refreshes the baseline |
| `triggers.py` (A2) | `TriggerManager`: condition evaluation on events, dispatch of actions (`log`, `script`, `mount_goto`), best effort |
| `templates.py` (C3) | `SequenceTemplateStore`: named YAML persistence, JSON import/export |
| `exposure.py` | Ideal exposure estimation (ADU/s, 3-frame linear fit, anti-saturation guard) |
| `flat_wizard.py` | State machine (target ADU, tolerance, recommended duration, AUTO convergence) |
| `pointing.py` | `PointingModel`: RA/Dec samples, `fit()` (parametric), `correct()` (fit + IDW-interpolated residual), fed by `record-solve` |
| `meridian.py` | LST, hour angle, `flip_due`, anti-re-flip, 24h visibility |
| `sequence.py` | `SequenceRunner` (plan, pause/resume/stop/reset, status `{done,total,...}`), `build_path` (target/date organization, continuous indices), `save_journal`/`load_journal` (resume) |
| `live_stack.py` | `LiveStackEngine`: aligned stacking (Seiza), rejection of shifted/poor images, masters calibration, master FITS/PNG |

## 3. Web Server (`web/server.py` + `routers/`)

### 3.1 `WebServer`

- Builds/attaches: `DeviceRegistry`, `Solver`, `LiveStackEngine`, **`MasterLibrary`** (root `masters.dir` or
  `sequence.save_dir`), **`PointingModel`**, **`RefocusPolicy`**, **`FlatWizard`**, `GuideCalibration`, `SequenceRunner`,
  templates — all initialized via modules (*lazy imports* in `web/server.py`).
- `_recenter_by_solve(ra_deg, dec_deg)`: short exposure, Seiza solve (`scale_hint` required = known focal length, otherwise
  early return), corrects position with a sample for the pointing model. Used for **post-flip recentering**
  and **mosaic tile moves**.
- Sequence FITS saving: `fitsmeta.frame_meta(...)` + `inject_meta` → bit-identical data, normalized
  header (C4).
- Broker: asyncio loop → WebSocket broadcast of states (`state`, `log`, `image`, `stacking`…).

### 3.2 REST Routing

Each `web/routers/<domain>.py` exposes `register(app, server)` and uses `common.SanitizedJSONResponse`
(neutralizes NaN/Inf). Summary of endpoint families:

| File | Endpoints (excerpt) |
|---------|---------------------|
| `hardware.py` | `/api/devices`, `/api/drivers[/attach]`, `/api/device/connect`, `/api/hardware/{connect,disconnect,connect-all,disconnect-all}`, `/api/profiles{/activate,/delete,/apply}`, `/api/filterwheel{,/slot}`, `/api/property` |
| `camera.py` | `/api/camera`, `/api/cameras`, `/api/camera/expose`, `/api/camera/abort`, `/api/camera/save` (normalized C4), `/api/camera/temperature`, `/api/camera/exposure/recommend`, `/api/camera/exposure/estimate`, `/api/camera/flat-wizard/{status,configure,step,reset}`, `/api/solver/{status,catalogs,solve}` |
| `mount.py` | `/api/connection`, `/api/mount{,/flip/status,/slew,/abort,/park,/unpark,/home,/tracking,/move,/halt,/flip}` |
| `focuser.py` | `/api/focuser{,/move,/halt,/move_relative,/speed}`, `/api/focuser/focus-metric`, `/api/focuser/autofocus/{status,start,step,finish,stop,reset}` |
| `guide.py` | `/api/guide/{status,start,step,set-reference,pause,resume,stop,reset}`, `/api/guide/calibrate/{status,start,set-origin,step,stop,finish,reset}` |
| `sequence.py` | `/api/sequence/{status,defaults,start,stop,pause,resume,reset,resume-session}`, `/api/sequence/templates{/delete,/export,/import}` |
| `mosaic.py` (D1) | `/api/mosaic/fov` (actual instrument FOV; `ok:false` without focal length), `/api/mosaic/plan` (grid from `target_coords`+`size_arcmin`+`overlap_frac`) |
| `masters.py` (C1) | `/api/masters{/build,/resolve,/delete,/calibrate}` |
| `stacking.py` | `/api/stacking/{status,reset,configure,masters,save,snapshot,start,stop}` |
| `pointing.py` | `/api/pointing/{status,add,correct,clear,fit,record-solve}` |
| `triggers.py` (A2) | `/api/triggers/{status,test}` |
| `visibility.py` | `/api/visibility` (24h altitude/visibility of an object) |
| `config.py` | `/api/config{/ui,/site{,/cities}}` |
| `astrometry.py` | `/api/astrometrie/{status,solve,generate_fake_image,fake_images}` |
| `ws_test.py` | `/ws` (real-time WebSocket), `/api/test/fits*` (test images) |

### 3.3 Sequence Execution (orchestration)

`POST /api/sequence/start` (`web/routers/sequence.py`):
1. **Expansion**: each enabled target expands its plan; a **mosaic** target has its exposures multiplied
   (`mosaic.expand_frames`) with keys `goto_ra_hours`/`goto_dec_deg`/`tile`/`tiles_total`.
2. `SequenceRunner.start(frames)` (possible resume indices); `save_journal` is written AFTER starting
   (correct total).
3. For each exposure, `before_frame` (hooks) in order:
   - **mosaic tile move** (`_move_to_tile`: slew + wait for `slewing` to finish ≤ 120 s + recentering via
     solve; best effort) — once per tile;
   - **meridian flip** if due (then post-flip recentering via solve);
   - **automatic refocus** (B3, if `should_refocus`);
   - LIGHT vs calibration control, dithering+settle, inter-exposure pause;
   - FITS writing: `_frame_meta` (filter, binning, temperature, gain, `MOSN/MOSROW/MOSCOL`…) + `inject_meta`;
   - journal updated after each exposure (resume).
   Each hook is **best effort and isolated**: failures are logged (warning/error) without interrupting the
   sequence (e.g. tile move impossible → tile captured at slew position; refocus failed → next attempt
   after cooldown).

## 4. Frontend (`web/static/`)

- **`hub.js`** — single mediator: `subscribe(topic, source, fn)` / `emit(topic, payload, {source})` /
  `request/respond` / `setState`/`getState`/`watchState`. Envelopes `{id, ts, topic, source, targets, kind, reqId,
  payload}`; a handler that throws never prevents delivery to other subscribers. `[Hub]` traces at `debug` log level.
- **`ws.js`** — WebSocket → `Hub` topics translator (`ws:state`, `ws:log`, `ws:image`, `ws:stacking`…).
- **`hardware.js`** — `ws:state` + `device:connected` (1200 ms debouncing), hardware panel + compact `T C A F R/W` LED strip `renderConnLeds()` (5 roles always visible grey→green `#44cc44`, `R`/`W` per `I18N.current`) + `MOUNT — CONNECTION` section (selector `serial|network` + endpoint `/dev/ttyUSB0` or `host:port` saved in profile `mount_interface/mount_endpoint`).
- **`sequence.js`** — drives both panels (Simple SEQUENCE in Capture mode; **SEQUENCER** in Sequencer mode:
  targets, per-target plan, mosaic `seqPlanMosaic` via `/api/mosaic/*`, templates via `/api/sequence/templates/*`,
  global options, `resume-session`).
- **`sky-engine.js`** (ES module) — sky map; **mosaic tile** overlay (`setMosaicTiles`,
  `setMosaicCurrent`); correct camera FOV (checkerboard `halfX/cos(dec)`); **Framing (D3)**
  (`cameraRotDeg`, `cameraTarget`, `_fovCorners`, `_renderTargetBox`, `setCameraRotation`,
  `setCameraTarget`) — rotatable FOV + target bounding box at its angular size.
- **`framing.js`** — Framing panel (astrometry mode): auto camera/focal-length FOV or manual
  (`_frameCameraFov`, same formula as `mount.js`), 0–360° rotation via slider
  (`skyEngine.setCameraRotation`), buttons ⟳ Solve (rotation from last plate solve via
  `solver:result`) / North ↑, target by id (`/api/visibility?id=…`) or entered RA/Dec +
  GOTO (pointing correction + slew), **fit-check** (`_frameFitCheck`: bounding box
  of a rotated rectangle `w=maj·cosA+min·sinA`); catalog selection (target.js) →
  `frameSetTargetObject`.
- **`capture.js` / `stacking.js`** — consumed via `capture:progress` / `stacking:update`.
- **`target.js` / `solver.js`** — `solver:result`, `record-solve` → pointing model.
- **`app.js`** — mode manager (`MODES`→applets in `state.js`), `mode:changed`, `calibration:done`.
- **`layout.js` / `app.js` responsive (`<1100px`)** — full-width `Connection` banner `calc(100vw-16px)` at top (2 rows `row wrap space-between`, `clamp()` inputs, `conn-row-attach/serial` hidden), `#applets-layer{flex-direction:column;pointer-events:none}` (keeps skymap interactable outside panels), `#mobile-stack` left of icon column `width:calc(100vw-66px)` `max-height:calc(100vh-...-110px)` scroll `overflow-y:auto`, `#mobile-dock` fixed right `44×44` `top:124px` (`144px` in `<599px`) `gap:6px` icons `PANEL_ICONS` `title` hover `.active` pulse, `#bottom-nav` 7 modes at bottom, `initSwipeNav()` (horizontal swipe). `toggleMinimize` hidden on mobile, panels `position:relative` `gap:8px` without overlap, `T C A F R/W` LEDs compact `6×6` `conn-led` neutral grey → green `#44cc44` (theme-independent).

ES modules vs classic scripts: `app.js`, `sky-engine.js`, `sky-projection.js` are modules; they
communicate with the rest via `window.*` globals exposed by `preview.js` (e.g. `setOffsetTarget`) and the
`Hub` bus (exposed globally).

## 5. Real-time (WebSocket)

1. INDIGO (`def`/`set`) → `DeviceRegistry` → `state_dict()` of devices.
2. `WebServer` pushes states and logs via `/ws` (JSON message protocol: `state`, `log`, `image`,
   `stacking`).
3. `ws.js` translates to `Hub` topics → subscribed panels (debouncing for `device:connected`).

## 6. Testing Strategy

| Level | Files | Execution |
|--------|----------|-----------|
| Unit/integration | `tests/test_*.py` | `python -m pytest tests/ -q` (284 tests, ~79 s) |
| Flows (end-to-end without hardware, TestClient + mock stub) | `tests/test_*_flow.py` (e.g. `test_mosaic_flow`, `test_sequence_flow`) | **run directly**: `python tests/test_sequence_flow.py` (98 checks) |
| INDIGO simulations | `tests/mock_indigo.py` (port 17624) | `./start-mock-server.sh` |
| E2E against a real `indigo_server` (simulators) | `tests/test_blanc_indigo.py` | `python tests/test_blanc_indigo.py` |
| JS (node) | `tests/test_hub.js`, `tests/test_polar_math.js` | `node tests/test_hub.js` |
| UI (Playwright) | `tests/*.spec.js` | `npx playwright test` |
| JS syntax | `node --check web/static/*.js` | bash loop |

Pure features (mosaic, fitsmeta, masters, exposure, meridian…) are tested without an INDIGO server
(`tests/test_*.py`), HTTP flows via TestClient with device **stubs** (`tests/test_*_flow.py`).

## 7. Useful Commands

```bash
./start.sh                          # server (config.yaml)
./start-mock-server.sh              # mock INDIGO (17624)
.venv/bin/python -m pytest tests/ -q
python tests/test_sequence_flow.py  # sequences + mosaic + resume
```
