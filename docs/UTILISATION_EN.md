*Version française : [UTILISATION.md](UTILISATION.md)*

# Noctua — User Guide

Web interface for controlling INDIGO astronomical equipment (mount, cameras, focuser, filter wheel).
This guide describes the modes, panels, and settings available in the browser.

> Configuration file reference: [CONFIGURATION.md](CONFIGURATION.md).
> Developer view: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Getting Started

### 1.1 Prerequisites

- Python 3.10+, an INDIGO server (`indigo_server`) accessible on the LAN — real or simulators
- Pip: `pip install -r requirements.txt`

### 1.2 Starting the Web Server

```bash
./start.sh                        # uses config.yaml (INDIGO + web)
./start.sh <indigo_host>:7624      # overrides the INDIGO server address
./start.sh 127.0.0.1:17624 --port 8080
```

Test without hardware (simulated INDIGO server):

```bash
./start-mock-server.sh --port 17624          # in one terminal
./start.sh 127.0.0.1:17624 --port 8080       # in another
```

Then open **http://<host>:8080**.

> Security: the interface listens on `0.0.0.0` by default and **has no authentication**.
> Use it only on a local LAN; do not expose it to the Internet.

---

## 2. Connection Bar

Always visible at the top, full width `calc(100vw-16px)`:

| Field | Purpose |
| ----- | ------- |
| Protocol | `Connect` (auto-connect) or `Attach` (manual driver selection) |
| Host / Port | INDIGO server address |
| ● CONN | Establish / re-establish the connection |
| FR/EN · Theme | Language selector (see § 3) and palette (`Noctua/Sobre/Graphite/Twilight/Ember`) |
| 📍 lat/lon + LEDs | Site coordinates + **compact LEDs** `T` (mount) `C` (camera) `A` (autoguiding) `F` (focuser) `R`/`W` (wheel) — neutral grey → green `#44cc44` when the device for that role is connected (visible even in `graphite/sobre`) |
| Driver / Serial port | Hidden on mobile (`<1100px`) — managed from the Hardware panel |

The connection status is displayed inline (`● Offline` / `● Online`). The driver line is no longer shown on mobile; the icon column starts below the banner (`top 124px`, `144px` on phones) so it does not overlap.

---

## 3. Mode Bar

Seven modes accessible via the bar at the top left:

| Mode | Icon | Displayed Panels |
| ---- | ---- | ----------------- |
| Hardware | 🔧 | Device list, per-role connection, INDIGO property editing |
| Mount | 🔭 | Mount status, control, pointing console, sky map |
| Focuser | 🔍 | Focuser control, position, autofocus (HFR V-curve) |
| Guiding | 🎯 | 3-step checklist, guide camera preview, drift graph, parameters, calibration, session (flip) |
| Capture | 📷 | Exposure settings, **flat wizard**, preview, simple acquisition plan (SEQUENCE), live stacking, session (flip) |
| Sequencer | ▶ | **Multi-target acquisition plan** (targets/plans/templates/mosaic) |
| Astro | ⭐ | Plate solver, target (centering), polar alignment, pointing model, preview |

The **Sequencer** is the main planner (see § 9): it manages multiple targets in sequence, each with
its own plan, optional mosaic, and options. The **SEQUENCE** panel in Capture mode is a simplified form
(a single current plan) inherited from early versions, still functional for quick needs.

Each panel is **movable** (drag by its title bar), **collapsible** (`−` / `+` button) and **pinnable** (📌 locks position). Positions and states are remembered per mode in `ui.yaml` via `POST /api/ui`.

> **Tablet / phone (`<1100px`)**: full-width banner at the top, `#bottom-nav` (7 icons at the bottom), central area `skymap/panels` `width:calc(100vw-66px)` to the left of the icon column, scrollable `#mobile-stack` (map fixed behind, `pointer-events:none` on the layer, 8px gap, no overlap), right vertical dock `#mobile-dock` `top:124px` (`144px` on `<599px`) `44×44` uniform (hover = title, tap = show/hide, cyan pulse, `off` orange), horizontal swipe between modes, `−` buttons hidden.

### Interface Language

A **FR / EN** selector is located in the connection bar (to the right of the connection status).

- The language detected on first load is the browser's (`navigator.language`), otherwise French by default.
- The choice is **persisted** in `localStorage`: it is retained across reloads.
- Changing the language applies immediately (interface + log messages). Dictionaries live in `web/static/i18n.{fr,en}.js`; every string is referenced by an `i18n('…')` key and tagged `data-i18n` in `index.html`.

---

## 4. Hardware Mode (🔧)

- List of detected devices with their role and status (connected / error).
- **Per-role** or **all at once** connection (dedicated buttons).
- **MOUNT — CONNECTION**: `Serial` vs `Network host:port` selector + endpoint field (`/dev/ttyUSB0` or `192.168.1.10:7624`), saved in the profile (`mount_interface`, `mount_endpoint`) and applied on connection.
- Persistent profiles: save / load / apply a profile = connect its set of devices (profiles also store the mount interface).
- Edit INDIGO properties of the selected object.

---

## 5. Mount Mode (🔭)

- **Status**: RA/DEC coordinates, tracking, park.
- **Control**: goto (RA/Dec or object), speed, stop, park/unpark.
- **Sky map**: stars, grid, equator, ecliptic, meridian, horizon; toggleable catalogue layers (M/NGC/IC/Caldwell/Sh2/LDN/…), magnitude limit.
- **Time**: real-time or manual (date/time input).
- **Tracking cap**: zenith / east-west lock.
- **Meridian flip**: proximity detection and triggering (auto or manual, see § 11). After a flip, target recentering can be automatic (via image solve) if the option is enabled.

---

## 6. Focuser Mode (🔍)

- Manual control: absolute / relative move, speed.
- Real-time position readout.
- **Autofocus**: V-curve scan measuring **HFR** (half-flux radius); selection of the best point then repositioning + verification.
- Focus quality metric displayed on the preview.

**Automatic autofocus** during a sequence (between two exposures) is configurable in the Sequencer (§ 9) and `config.yaml` (§ refocus, Lot B3).

---

## 7. Guiding Mode (🎯)

3-step workflow (checklist):

1. **Camera selected** — choose the guide camera in the selector.
2. **Mount online** — a connected mount is required.
3. **Calibration done** — run calibration (short exposures, detection of the brightest star only). **Star lost** → automatically retried up to 3×, otherwise a Retry button appears.

Then:

- **Guide preview**: guide camera image, star detection, click to select the guide star (Gaussian quality: SNR, HFR, saturation), zoom/pan (wheel, drag, double-click).
- **Start guiding**: continuous short exposures, centroid measurement, RA/DEC correction pulses.
- **Graph**: RA/DEC and total drift over 120 s, RMS, correction pulses, target with reticle.
- **Tolerance** (±1–120″): exceeded → audible alert.
- **Parameters**: exposure time, aggressiveness, RA/DEC gains, max pulse, guide binning.

### Dithering and "Settle"

When dithering is enabled in a sequence, a Gaussian offset of the **guiding reference** is applied
between two exposures. Optionally a **settle** waits until the drift falls back below a threshold
(`settle_rms` in ″) for several consecutive samples (`settle_stable`), with a maximum duration
(`settle_timeout`). Status appears in the sequence panel (`seq-dither-status`) and in the log.

---

## 8. Capture Mode (📷)

Capture mode groups camera settings, the flat wizard, preview, the simple acquisition plan, and live stacking:

| Process | Panel | Usage | FITS Destination |
| ------- | ----- | ----- | ----------------- |
| **Single / series capture** | SEQUENCE | Long exposures saved for **later processing** | `<save_dir>/<…>` |
| **Live stacking** | LIVE STACKING | Short exposures accumulated **live** into a single image (stacked view) | `<root>/livestack_YYYYMMDD_HHMMSS/` |
| **Other exposures** | CAPTURE | Simple exposures (LIGHT/DARK/FLAT/BIAS) displayed on screen, saveable | `<save_dir>` |

### 8.1 Exposure Parameters (CAPTURE)

- Camera (selector if multiple), binning, gain, offset, temperature (current + target), exposure type (LIGHT/DARK/FLAT/BIAS).
- Filter wheel: selector + filter sequence (e.g. `L,R,G,B` or `Ha,R,G,B`).
- **EXPOSE**: runs `count` exposures with `delay` between exposures, displayed progressively in the preview.
- **Measure sky** (ideal exposure time): one or three test exposures ("Measure sky", `shots` in config) measure the sky background in ADU/s and extrapolate the duration needed to reach the target background (`exposure.target_bg`), with star anti-saturation guard and projected SNR.

### 8.2 Flat Wizard (collapsible section of the CAPTURE panel)

Assistant for a **flat** series: targets a given illumination level in ADU (default ~22,000) within a tolerance.

- **Configure**: target ADU, tolerance (%), starting duration, max duration.
- **Step**: one exposure is taken, measured, and the next duration is corrected proportionally (`suggest_duration`).
- **AUTO**: runs steps in a loop until convergence (measurement within tolerance).
- **Reset**: resets the state machine.
- Status shows the target, the last measurement, progress (`step/max_steps`) and `done` state.

### 8.3 Preview

- FITS image displayed with **automatic stretch** (histogram) or manual (slider "Black", AUTO mode).
- Zoom/pan, **1:1** button, **◻ fit**, **⤢ fullscreen** (Esc or click again to exit), resize via `⣿`.
- **Save**: saves the currently displayed FITS to the root directory.
- During live stacking, the preview shows the **stretched stacked view** (WebSocket push) instead of the last FITS.

> The preview panel never disappears on its own: if it appears hidden, check that no overlapping panel
> is covering it (📌 pins) and that Capture/Sequencer/Astro mode is active.

### 8.4 SEQUENCE Panel (simple plan)

Simplified version of the planner (see the Sequencer § 9 for full usage):

- Editable plan: exposure type (LIGHT/DARK/FLAT/BIAS), duration, filter, number of exposures, pause between exposures.
- Controls: **Start**, pause, resume, stop, reset — progress displayed.
- **Dithering** (if enabled), save directory optionally overridden.

### 8.5 Live Stacking (LIVE STACKING panel)

Goal: see an object **accumulate live** in short exposures. The 1st image serves as reference; subsequent ones
are aligned (star matching); images that are too shifted or too star-poor are **rejected**.
The preview shows the stretched stacked image, updated after each accepted exposure.

- **Exposure time (s)**: short exposures (a few seconds), suited to the accumulated flux.
- **Exposures to stack**: number of LIGHT frames to **accept** before automatic stop (**0 = continuous**).
- **Filter**: optional filter applied (filter wheel).
- **Calibration (optional)**: paths to **dark** and/or **flat** folders (FITS) — or better, the master library (§ 10) they feed — building the masters applied to each exposure.
- Controls: **START**, **STOP**, **⟲ Reset**, **Master**, **Master PNG**.
- **Session finished**: on target, the master is **automatically saved** to `<root>/masters/master_YYYYMMDD_HHMMSS.fits` and the path is shown in the status. STOP stops without auto-save.

---

## 9. Sequencer Mode (▶) — Multi-Target Acquisition Plan

The Sequencer is the main planner ("NINA-like" model): a **list of targets**, each with its **plan**,
optional **mosaic settings**, the whole driven by **global options** (dither+settle, auto refocus,
root directory) and reusable **templates**. It also handles **resuming** an interrupted session.

### 9.1 Targets

- **＋ add**, **⧉ duplicate**, **✕ delete**: the list on the left.
- Each target can be enabled (checkbox) and has: **name** (used for session folder organization), **RA/Dec** (hours/degrees, or **🌌 catalogue** search — Messier, NGC, IC, etc.), **rotation** (instrument position angle).
- The list order is the execution order.

### 9.2 Target Details (right column)

- **Exposure plan**: list of exposures (type, duration, filter, ×, gain, offset, binning, delay). During a session, the plan keys remain editable as usual; a running session locks the fields.
- **Mosaic (Lot D1)** — further down, the "Mosaic" section:
  - **"Expand into N×M grid"** checkbox; if checked: covered size W×H **in arcmin**, **overlap** between tiles (%).
  - **Plan** button: the server computes the grid (number of tiles = `ceil(span / step)` with step = FOV×(1−overlap), RA correction by cosine of declination) from the instrument's **real FOV** (sensor width, focal length). The result is displayed: "R×C = N tiles".
  - The FOV is computed server-side from the camera geometry and **focal length**; it therefore depends on the focal length property set for the camera (Hardware mode → device properties). Without a focal length, "Plan" shows "Camera FOV unavailable" (FOV is cached per page — reload the page after setting the focal length).
  - The grid preview is drawn in **orange on the sky map** (current tile in bold).
  - At execution time, for each tile: the mount slews, we **wait for the slew to finish**, then a **solve-based recentering** (short exposure + Seiza solve, if focal length is known) ensures placement BEFORE taking the exposure. Moves happen only once per tile; subsequent exposures on the same tile do not re-trigger them. Images carry the keywords `MOSN` (total count), `MOSROW` and `MOSCOL` (tile indices).

### 9.3 Templates (Lot C3)

- Save (**+💾**) the current plan under a name, **load** a template into the selected target, **delete**.
- **⇪ export**: copies the JSON of all templates to the clipboard; **⇓ import**: pastes JSON to restore them.
- Storage: `sequence_templates.yaml` (relative to config, overridable via `INDIGO_SEQUENCE_TEMPLATES_PATH`).

### 9.4 Global Options

- **Dither** (see § 7): offset ±px and **settle** (threshold ″, max duration s).
- **Auto refocus** (Lot B3): after N **minutes** and/or a Δ in **altitude** (°) — an HFR V-curve is measured server-side between two exposures, focus is repositioned, the sequence continues. The first exposure never triggers it (baseline recorded at start).
- **Save to**: root directory (default `sequence.save_dir`).

### 9.5 File Organization (Lot C2)

With a named target, the session writes to `<save_dir>/<target>/<YYYY-MM-DD>/<HHMMSS>/`; without a target, to
`<save_dir>/capture_YYYYMMDD_HHMMSS/` (legacy). Inside, images are grouped by type
(`lights/`, `darks/`, `flats/`, `biases/`) and named `{type}_{filter}_{NNN}_{timestamp}.fits` with **continuous
indices** (`NNN`), along with the `journal.json` file.

Each session persists this **`journal.json`** (plan, progress, mosaic tiles, context). If interrupted,
the **↻ Resume** button (action bar) restarts the session: **only unsaved exposures are resumed**,
file indices continue (no overwrite).

### 9.6 Execution Controls

- **▶ START**: sends all enabled targets (plan + mosaic); **⏸ Pause / ▶ Resume**, **⏹ STOP**, **⟲ Reset**.
- Overall progress (`done/total`), current exposure, last dither/refocus/save and any error in the status bar.

---

## 10. Master Library (Lot C1)

The **MasterLibrary** catalogs and resolves **bias/dark/flat** calibration masters, organized as
`<dir>/masters/<type>/…` (root = `masters.dir` or `sequence.save_dir`).

- **Building**: from a series of raw FITS → combined master (median), with normalized header (filter, binning, temperature, exposure when relevant).
- **Resolving**: for a given acquisition context (filter, binning, temperature, exposure), finds the **best master** (exact match first, then fallbacks).
- **Integration**: live stacking can be calibrated from the library (bias/dark/flat resolution → applied to exposures).

It can be driven via the `/api/masters/*` endpoints (building, resolving, live-stack calibration —
see [ARCHITECTURE.md](ARCHITECTURE.md)). Raw frames produced by sequence sessions carry the **normalized
headers (C4)** that make it possible to build and catalog masters accurately.

---

## 11. Meridian Flip

- **Anticipation**: hour-angle margin (`telescope.hour_angle_margin`), anti-re-flip (does not flip again just after a flip), minimum altitude (`telescope.min_altitude`).
- **During a sequence**: the flip is triggered between two exposures; if `telescope.recenter_after_flip` and the focal length allow it, a **solve-based recentering** puts the target back in place.
- **Manual**: `POST /api/mount/flip` (Mount or SESSION panel button).

---

## 12. Astro Mode (⭐)

- **Plate solver** (Seiza): **Index** mode (mount position + scale, fast) or **Blind** (no hint, slow). Auto hint (mount + camera) or manual (RA/DEC/scale). Status in the panel; solutions also feed the pointing model's `record-solve`.
- **Target**: RA/DEC input, pointing, offset thumbnail.
- **Polar**: LST calculation + 3-step polar alignment assistant (manual or automatic captures).
- **Pointing model**: sample collection (manual add or automatic via `record-solve` — "Index" solver + centering tolerance), **parametric fit** + **interpolated (IDW)** correction of residual errors; after fitting, go-tos (`correct`) receive the model's correction. Panel with sample status.
- **Framing assistant (Lot D3)**: framing panel — adjustable FOV (auto camera/focal length or manual), **sensor rotation** 0–360° ("Solve" button: angle from last plate solve; "North ↑": 0°), target by **catalog name/id** (e.g. `M42`, selection from the Target panel) or typed RA/DEC. "Define" button (overlays the target rectangle at its true angular size on the map), "GOTO" (centered slew) and "✕" (clear). The **fit-check** indicates whether the target (major/minor + position angle) fits in the field at the chosen rotation.

---

## 13. Normalized FITS Headers (Lot C4)

Images saved by sessions carry normalized metadata, injected by **binary rewriting** of the header (no astropy dependency, bit-identical data). Main keywords:

| Keyword | Content |
| ------- | ------- |
| `OBJECT` | Target name |
| `IMAGETYP` | `Light Frame` / `Dark Frame` / `Flat Frame` / `Bias Frame` |
| `FILTER` | Filter used |
| `EXPTIME` | Exposure time (s) |
| `DATE-OBS` / `DATE-END` / `DATE` | Start / end / write (UTC) |
| `INSTRUME` | Instrument |
| `CCD-TEMP` / `SET-TEMP` | Measured / set CCD temperature |
| `GAIN` / `OFFSET` | Applied gain and offset |
| `XBINNING` / `YBINNING` | Binning |
| `PIXSIZE1` / `PIXSIZE2` (µm) / `FOCALLEN` (mm) | Sensor geometry / focal length |
| `TELESCOP` / `SITELAT` / `SITELONG` / `SITELEV` | Telescope and site |
| `SWCREATE` | Software marker |
| `MOSN` / `MOSROW` / `MOSCOL` | Mosaic: total tiles / row / column (mosaic exposures) |

Missing keywords are omitted; out-of-spec values are cleaned. The master library relies on these headers for cataloging (C1).

---

## 14. Triggers (Lot A2)

**Triggers** automatically react to sequence events without front-end intervention. They are declared
**in `config.yaml`** (see [CONFIGURATION.md](CONFIGURATION.md) §7.6). Available events:

`sequence_start`, `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`.

Actions: `log` (message via log, level), `script` (external command with timeout), `mount_goto`
(coordinates — `"now"` = current position). Variables in messages: `{done}`, `{total}`, `{filter}`,
`{error}`, `{index}`… A test endpoint (`POST /api/triggers/test`) allows triggering a trigger manually.

---

## 15. Configuration Files

| File | Content |
| ---- | ------- |
| `config.yaml` | INDIGO (host/port), web (host/port), site, telescope (flip), exposure (ideal exposure + recentering), masters, sequence (save_dir, dither+settle, refocus, stack, frames, triggers) |
| `profiles.yaml` | Hardware profiles: `{ name, mount, camera, guide_camera, focuser, filter_wheel, optics, mount_interface, mount_endpoint }` (`mount_interface: serial\|network`, `mount_endpoint: /dev/ttyUSB0` or `host:port`) |
| `ui.yaml` | Panel layout per mode, log levels, sky layers, histogram, selected driver |
| `sequence_templates.yaml` | Named sequence templates (C3) |
| `web/static/i18n.{fr,en}.js` | FR/EN interface dictionaries |

> The exhaustive reference for each key, with examples, is in **[CONFIGURATION.md](CONFIGURATION.md)**.

---

## 16. Quick Troubleshooting

| Symptom | Hint |
| ------- | ----- |
| "Offline" | Check the INDIGO server (port 7624) and the LAN; otherwise use `./start-mock-server.sh` |
| A panel seems missing | May be collapsed (`+` in its title bar) or covered — check 📌 pins and saved positions |
| Stale browser cache | Ctrl+Shift+R to reload scripts |
| Empty preview after an exposure | Check the log (error/warning levels) and the preview panel status bar |
| Stacking accepts no exposures | Too much drift, not enough stars, or unsuitable dark/flat calibration — check `rejected` and the reason in the status |
| Mosaic: "Plan" shows nothing | Camera FOV unavailable — set the **focal length** in the camera device properties (Hardware mode), then **reload the page** (FOV is cached per page) |
| Mosaic: recentering solve failed | Solve-based recentering requires a `scale_hint` (known focal length); otherwise the tile is taken at the slew position (no recentering) |
| Auto refocus not triggering | Check global options (Auto refocus checkbox + values), and that a manual autofocus has already succeeded (HFR requires a valid V-curve) |
| Resume not showing | No known interrupted session (status exposes `resumable`); check the session folder's `journal.json` |
| FITS headers seem missing | Some devices do not expose focal length/temperature/gain — unknown keywords are simply omitted |
