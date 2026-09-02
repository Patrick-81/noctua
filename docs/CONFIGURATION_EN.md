---
nav_exclude: true
---

*Version française : [CONFIGURATION.md](CONFIGURATION.md)*

# Noctua — Configuration Reference

Comprehensive reference for configuration files. The template is `config.example.yaml` (copy it to
`config.yaml` then adjust):

```bash
cp config.example.yaml config.yaml
```

- `config.yaml`: INDIGO server, web, site, telescope/flip, ideal exposure, masters, sequence (dither, refocus, stack, frames, triggers).
- `profiles.yaml`: named hardware profiles.
- `ui.yaml`: runtime UI state (panel positions) — **do not edit manually** (rewritten by the app).
- `sequence_templates.yaml`: plan templates (Batch C3), managed from the interface.

---

## 1. `indigo` — INDIGO server

```yaml
indigo:
  host: 127.0.0.1        # address of the INDIGO server (real or simulators)
  port: 7624             # INDIGO/INDI port is always 7624
```

| Key | Default | Role |
|-----|--------|------|
| `host` | `127.0.0.1` | INDIGO server host |
| `port` | `7624` | TCP port (INDI/XML protocol) |
| `protocol` | `connect` | `connect` (auto-connect) or `attach` (manual driver selection) |

> `./start.sh <host>:7624` and `--port 8080` override these values without modifying the file.

---

## 2. `web` — HTTP server

```yaml
web:
  host: 0.0.0.0          # listen interface (0.0.0.0 = local LAN)
  port: 8080
```

| Key | Default | Role |
|-----|--------|------|
| `host` | `0.0.0.0` | Web interface listen address |
| `port` | `8080` | Web interface port (real-time WS on the same origin) |

⚠️ **No authentication**: restrict to a local LAN.

---

## 3. `site` — observing site

```yaml
site:
  name: Montdurausse
  latitude: 43.952        # degrees North (positive)
  longitude: 1.568        # degrees East (positive)
  elevation: 210          # meters
  timezone: Europe/Paris
```

| Key | Default | Role |
|-----|--------|------|
| `name` | — | Site name → FITS header (`SITEOBS` in some flows) and display |
| `latitude` / `longitude` | — | Coordinates (degrees, N/E positive) — LST, altitude, visibility calculations |
| `elevation` | — | Altitude (m) |
| `timezone` | — | IANA timezone (e.g. `Europe/Paris`) — site clocks |

---

## 4. `exposure` — ideal exposure and recentering

```yaml
exposure:
  target_bg: 4000         # target sky background (ADU above bias)
  shots: 1                # 1 = single exposure (bias = BZERO) ; 3 = linear fit ADU(t)=bias+m·t
  test_min: 5.0           # shortest test exposure (s)
  test_mid: 15.0          # intermediate exposure (3-shot mode)
  test_max: 30.0          # longest test exposure (s)
  min_exposure: 1.0
  max_exposure: 600.0
  saturation_frac: 0.6    # star peaks stay below this fraction of full scale
  recenter_duration: 2.0  # exposure duration (s) for solve-based recenterings (flip/mosaic)
```

| Key | Default | Role |
|-----|--------|------|
| `target_bg` | `4000` | Target sky background in ADU above bias for "Measure sky" |
| `shots` | `1` | `1` = simple bias-independent estimate ; `3` = linear fit with saturation detection |
| `test_min` | `5.0` | Shortest test exposure duration (s) |
| `test_mid` | `15.0` | Intermediate exposure (3-shot mode) |
| `test_max` | `30.0` | Longest test exposure (s) |
| `min_exposure` | `1.0` | Lower bound for the recommended exposure (s) |
| `max_exposure` | `600.0` | Upper bound for the recommended exposure (s) |
| `saturation_frac` | `0.6` | Star peaks must stay below this fraction of full scale |
| `recenter_duration` | `2.0` | Exposure duration (s) for solve-based recentering exposures (post-flip, mosaic tiles) |

---

## 5. `telescope` — meridian flip and telescope

```yaml
telescope:
  name: Newton 250/1000     # telescope name → FITS header (TELESCOP)
  flip_enabled: true
  hour_angle_margin: 0.2
  min_altitude: 5.0
  flip_slew_rate: Centering
  recenter_after_flip: true
```

| Key | Default | Role |
|-----|--------|------|
| `name` | — | Telescope name → `TELESCOP` in FITS headers |
| `flip_enabled` | `false` | Enable meridian flip |
| `hour_angle_margin` | `0.2` | Hour-angle margin (hours) to anticipate the flip |
| `min_altitude` | `0.0` | Minimum altitude to allow the flip |
| `flip_slew_rate` | `Centering` | Slew rate after flip |
| `recenter_after_flip` | `true` | Recenter target via solve after flip (requires focal length) |

Anti-re-flip is handled automatically (the flip does not re-trigger immediately after a flip).

---

## 6. `masters` — master library (Batch C1)

```yaml
masters:
  dir: ~/asteo/captures/
```

| Key | Default | Role |
|-----|--------|------|
| `dir` | `sequence.save_dir` | Library root: `<dir>/masters/<type>/{bias,dark,flat}/...` |

The library indexes masters according to **normalized** headers (filter, binning, temperature,
exposure) and resolves them automatically for a given acquisition context. Think **bias < dark < flat** for the
calibration chain (dark includes bias).

---

## 7. `sequence` — acquisition sequence

```yaml
sequence:
  save_dir: ~/asteo/captures/
  dither:
    enabled: true
    amount: 2.0                  # sigma of Gaussian offset (px) applied to guide reference
    settle_rms: 1.0              # guiding settle threshold (″) — 0 = no wait
    settle_timeout: 20.0         # max settle wait time (s)
    settle_stable: 3             # consecutive samples below threshold to consider settle OK
  refocus:
    enabled: false
    interval_min: 20             # refocus every N minutes (0 = disabled)
    alt_trigger_deg: 3.0         # refocus after altitude delta of N ° (0 = disabled)
    exposure_sec: 1.0            # HFR measurement exposure (s)
    range: 2000                  # half search range for V-curve (steps)
    points: 25                   # number of measurement points
  stack:
    enabled: false
    max_frames: 0
  frames:
    - duration: 60.0
      frame_type: LIGHT
      filter: ""
      count: 1
      delay: 1.0
  triggers:
    - name: series-end-alert
      event: series_done
      actions:
        - type: log
          level: info
          message: "Series complete: {done}/{total} frames"
```

### 7.1 `save_dir`

Shared root for sessions. Layout (Batch C2): with a named target → `<save_dir>/<target>/<YYYY-MM-DD>/<HHMMSS>/`,
otherwise `<save_dir>/capture_YYYYMMDD_HHMMSS/`. Each session persists `journal.json` (progress, plan, mosaic
tiles) → **resumption** of missing frames at continuous indices.

### 7.2 `dither` (Batch A1)

| Key | Default | Role |
|-----|--------|------|
| `enabled` | `false` | Shift guiding reference between each frame |
| `amount` | `2.0` | Sigma of Gaussian offset in pixels |
| `settle_rms` | `1.0` | Drift threshold (″) below which settle is accepted ; `0` = no wait |
| `settle_timeout` | `20.0` | Maximum settle wait duration (s) |
| `settle_stable` | `3` | Number of consecutive samples below threshold before validating settle |

### 7.3 `refocus` (Batch B3)

| Key | Default | Role |
|-----|--------|------|
| `enabled` | `false` | Automatic HFR refocusing between frames |
| `interval_min` | `20` | Trigger after N elapsed minutes (0 = disabled) |
| `alt_trigger_deg` | `3.0` | Trigger after altitude delta of N degrees (0 = disabled) |
| `exposure_sec` | `1.0` | HFR measurement exposure duration |
| `range` | `2000` | Half search range of the V-curve (steps) |
| `points` | `25` | Number of V-curve points |

The **first frame** never triggers (baseline recorded at start). A refocus failure does not
interrupt the sequence (warning, continues).

### 7.4 `stack`

Backward compatibility for the former automatic frame push to the stacker:
`enabled: false` → stacking controlled only by the LIVE STACKING panel. `max_frames: 0` = continuous.

### 7.5 `frames`

Default exposure plan (loaded when the UI does not provide one). Each frame: `duration`,
`frame_type` (`LIGHT`/`DARK`/`FLAT`/`BIAS`), `filter`, `count`, `delay`.

### 7.6 `triggers` (Batch A2)

Automatic reactions to sequence events. A trigger has a `name`, an `event`, a list of `actions`,
and optionally `conditions` (e.g. `frame_type: LIGHT` filters `frame_done` events).

**Events**: `sequence_start`, `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`.

**Actions**:

| Type | Parameters | Effect |
|------|-----------|-------|
| `log` | `level` (info/warning/error), `message` | Writes to the log |
| `script` | `command`, `timeout` | Executes an external command (with context variables) |
| `mount_goto` | `ra` (hours), `dec` (°), `rate`* | Mount goto — `"now"` = current position |

**Variables** available in `message`/`command` (depending on event): `{done}`, `{total}`, `{index}`,
`{frame_type}`, `{filter}`, `{duration}`, `{saved_path}`, `{last_dither}`, `{error}`, `{frames}`, `{target}`,
`{session_dir}`, `{resumed}`. Scripts also receive environment variables `NOCTUA_<VAR>`
(same keys, uppercase).

> A failing trigger **never** stops the sequence (best effort, logged).

---

## 8. `profiles.yaml` — hardware profiles

```yaml
mon_profil:
  name: mon_profil
  mount: "Telescope Simulator"
  camera: "CCD Simulator"
  guide_camera: "Guider Simulator"
  focuser: "Focuser Simulator"
  filter_wheel: "Wheel Simulator"
  optics: {}
  mount_interface: serial        # serial | network
  mount_endpoint: /dev/ttyUSB0   # /dev/ttyUSB0 or host:port (e.g. 192.168.1.10:7624)
```

Each profile maps a role to a device (by name). Activated from Hardware mode. Path can be overridden via
`INDIGO_PROFILES_PATH`.

| Key | Role |
|-----|------|
| `mount` | Mount device name |
| `camera` | Primary CCD device name |
| `guide_camera` | Guide CCD device name |
| `focuser` | Focuser device name |
| `filter_wheel` | Filter wheel device name |
| `optics` | Optional optics data (not required) |
| `mount_interface` | Mount interface: `serial` or `network` |
| `mount_endpoint` | Mount endpoint: `/dev/ttyUSB0` (serial) or `host:port` (network) |

---

## 9. Environment variables

| Variable | Role |
|----------|------|
| `INDIGO_PROFILES_PATH` | Path to `profiles.yaml` |
| `INDIGO_SEQUENCE_TEMPLATES_PATH` | Path to `sequence_templates.yaml` (Batch C3 templates) |

---

## 10. Summary — new keys by batch

| Batch | Config keys |
|-----|-------------|
| A1 (dithering+settle) | `sequence.dither.{amount,settle_rms,settle_timeout,settle_stable}` |
| A2 (triggers) | `sequence.triggers[].{name,event,conditions,actions}` |
| B3 (auto refocus) | `sequence.refocus.{enabled,interval_min,alt_trigger_deg,exposure_sec,range,points}` |
| C1 (masters) | `masters.dir` |
| C2 (sessions/logs) | `sequence.save_dir` (target/date layout + journal.json) |
| C3 (templates) | `sequence_templates.yaml` file (+ env var) |
| C4 (FITS headers) | `telescope.name`, `site.*` (used in headers) |
| D1 (mosaic) | passed from the interface (no dedicated key needed) |
| Flip + recentering | `exposure.recenter_duration`, `telescope.recenter_after_flip` |
