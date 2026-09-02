*Version française : [remarques.md](../remarques.md)*

# Remarks — Noctua vs N.I.N.A.

Comparison of Noctua (`indigo_devices`) features with N.I.N.A.
(nighttime-imaging), and planned evolutions.

> **Verified as of 30/08/2026** against the code (`master` state + working tree):
> statuses below (done / not started) are up to date. Remaining gaps
> are real (see "Next steps" section for the proposed order).

## What Noctua Already Covers Well

- **Capture sequence**: multi-frame LIGHT, exposures per filter, dithering
  (`dither()` hook in `SequenceRunner`), delays between frames, parallel live stacking,
  scheduling. This is the core that competes well with N.I.N.A.
- **Autofocus**: parabolic HFR autofocus (fit + V-curve), autofocus step,
  search range.
- **Autoguiding**: 4-phase calibration (EW/NS with return), quality metrics
  (orthogonality, camera angle), closed-loop guiding.
- **Polar alignment** (polar.js), **plate solving** (astrometry),
  **interactive D3 sky map**.
- **Real-time live stacking** (Seiza), hardware control, profiles.

## Major Gaps vs N.I.N.A. (to implement)

1. **Flat Wizard & dark/flat/bias library** — ✅ **Flat Wizard done**
   (state machine `flat_wizard.py`, endpoints `camera.py`, collapsible UI in the
   capture panel — target ADU, AUTO, filter/binning). ✅ **Master library
   done (C1, 29/08)**: combines and matches bias/dark/flat by
   filter/binning/temperature (see Lot C1). One refinement remains: **automatic
   dark capture at end of sequence** (item 16).

2. **Weather management** — No dedicated endpoint or UI. N.I.N.A. stops /
   alerts on sensors (rain, wind, clouds) during a sequence.

3. **Trigger Manager / conditional actions** — ✅ **Done (A2, 28/08)**:
   `indigo/devices/triggers.py` — sequence events (`frame_done`,
   `series_done`, `error`…) → configurable actions (log, script, mount_goto)
   with conditions and templating. The sequence remains driven by
   `SequenceRunner` with conditional hooks (see Lot A2).

4. **Automatic meridian flip in the sequence** — ✅ **Done**: `before_frame`
   hook in `SequenceRunner._run_one`, auto flip (post-meridian margin
   via `hour_angle_margin`), anti-re-flip, and **iterative solve-based
   recentering** (`_recenter_by_solve`) with blocking resume. See "Work in progress".

5. **Pointing model / pointing error model** — A **local** corrective model
   (IDW) already exists (`indigo/devices/pointing.py`): samples
   `(ra, dec, delta_ra, delta_dec)` automatically collected at each solve-based
   recentering (frontend `target.js` + server post-flip), interpolated correction
   applied to GOTOs. The gap with N.I.N.A. is the **multi-term parametric
   model** (see detailed analysis below).

    ### Detailed Analysis — Pointing Error Model

    **What exists (collection + application OK)**
    - `PointingModel.correct()` (IDW, `pointing.py:62`): distance-weighted average
      over neighboring samples. Good for smoothing noise **near**
      a sample.
    - Automatic feeding: `_recordPointingSample()` (`target.js:97`) at
      each recentering, and `_recenter_by_solve` (server) after flip.
    - Application: `_applyPointingCorrection()` (`target.js:116`) on every
      GOTO if "apply to GOTOs" is checked. Strengths preserved.

    **The real gap (what N.I.N.A. does in addition)**
    IDW is **purely local**: it does not generalize beyond the neighborhood of
    samples, does not separate **systematic** errors (repeatable, to be
    corrected) from **random** errors (seeing, should not be memorized), and each
    new sample "propagates" nothing elsewhere. N.I.N.A. fits a global model
    that describes systematic error as a function of position.

    **Result — parametric model implemented ✓**
    - `pointing.py`: least-squares fit (numpy) of systematic terms,
      `_predict()`, and `correct()` = **model + IDW(residuals)** (generalizes outside
      the cloud, accurate nearby). Pure IDW fallback if < 6 samples.
    - `status()` exposes `model_fit` (active, star count, RMS, coeffs, labels).
    - Endpoint `POST /api/pointing/fit` + UI button "⌘ Fit model"
      (display coeffs/RMS/star count); `_applyPointingCorrection` applies the
      combined correction via `/correct`.
    - Tests: coefficient recovery on synthetic samples,
      out-of-cloud generalization, RMS, fallback, endpoint, clear (7 tests).

    **Minimum viable to keep**: auto collection + IDW remain the safe fallback; the
    parametric model only enables `model + residual` correction when enough
    samples are available (e.g. ≥ 6) for a significant fit.

## Intermediate Gaps

6. **Complete framing assistant** — ✅ **Done (D3, 30/08)**: **rotatable** FOV overlay
   (configurable sensor rotation, 0 = north up), **target bounding box**
   drawn at its true angular size (`size_arcmin` from catalog,
   oriented by position angle + rotation), dedicated **Framing** panel in
   astrometry mode (auto camera/focal-length FOV or manual, 0–360° rotation + 
   "Solve" (rotation from last plate solve) / "North ↑" buttons, target by name/id or
   RA/Dec with Set/GOTO/✕ buttons, **fit-check**: does the target fit in
   the field?). Selection from the Target panel (catalog) automatically
   feeds the framing.

7. **Target/date scheduling** — ✅ **Done (C2, 28/08)**: structure
   `<save_dir>/<target>/<YYYY-MM-DD>/<HHMMSS>` (or `capture_<TS>` without target),
   `journal.json` log and resumption of an interrupted sequence (see Lot C2).

## Evolutions You Might Not Have Thought Of

8. **Time/altitude-dependent automatic refocus** — ✅ **Done (B3, 28/08)**:
   `sequence.refocus` policy (`interval_min`, `alt_trigger_deg`) with fully
   server-side HFR V-curve (`refocus.py`, see Lot B3).

9. ~~**Dithering actually driven by the guider**~~ — **DONE (A1, 28/08)**:
   `apply_dither()` in `guide.py` shifts the guider reference (= mount pulse
   via its corrections) then waits for **settle** (`wait_settle()`,
   RMS residual < `settle_rms` over N samples, timeout) before the next
   exposure. `sequence.dither` config: `amount` (px), `settle_rms` (″),
   `settle_timeout` (s), `settle_stable`. UI in the sequencer (Settle inputs)
   + `last_dither.settle` status displayed after each frame. Tests
   `tests/test_dither.py` (11), 205 pytest OK.

10. **Dome / rolloff roof automation** — control of automated roofs
     for unattended installations.

11. **Reusable sequence templates / presets** — ✅ **Done (C3, 28/08)**:
     named plans (L, RGB, Ha) shareable via JSON export/import (see Lot C3).

12. **Automatic mosaic** — ✅ **Done (D1, 29/08)**: planning of an
     N×M grid centered on the target (`/api/mosaic/plan`, 0–90% overlap,
     cos(dec) correction), expansion of the exposure plan to as many tiles
     (`MOSN`/`MOSROW`/`MOSCOL` in FITS header), automatic mount slewing
     with solve-based recentering between tiles (`before_frame`) and
     grid preview on the sky map.

13. **Vision / "Live view" with stretch** — autostretch + histogram already in
     place in the preview (Black slider, AUTO); **remaining**: narrowband LUT
     (Ha/OIII/SII) and per-camera saved stretch. *Partial — autostretch OK.*

14. **Journaling** — ✅ **Done (C4, 29/08)**: per-exposure metadata written
     **into the FITS header** of images (date/time, target, exposure time, gain,
     offset, sensor temperature, binning, optics, site) — see Lot C4.

15. **Alerts / push notifications** (webhook, Telegram, email) on error /
     end of night.

16. **Automatic darks at end of sequence** — ◐ **Partial**: the master
     library (C1, 29/08) allows building and reusing darks; **automatic
     capture at end of night** remains to be done.

---

## Work in Progress

- **Flat Wizard** — ✅ **Done**: state machine `flat_wizard.py`, endpoints
  `camera.py`, collapsible UI in the capture panel (target ADU, AUTO, filter/binning).
- **Automatic meridian flip** — ✅ **Done**: `before_frame` hook in the
  sequence + auto flip + anti-re-flip re-arming. **Iterative solve-based recentering**
  integrated (`_recenter_by_solve`, server, ≤ 3 passes) with **blocking resume**:
  `_do_meridian_flip` returns `flipped` and waits for flip+recentering to finish before the
  next exposure.
- **Pointing model** — ✅ **Strengthened**: **global parametric** model (least-squares
  fit: index, cone `sin(dec)`, ortho/flexure `sin/cos(ra)·cos(dec)`)
  combined with **IDW residual** in `correct()`. Endpoint `/api/pointing/fit` +
  UI button "Fit model" (coeffs/RMS/stars). Auto feeding by
  recenterings (frontend + post-flip). Pure IDW fallback (< 6 samples).

## Evolutions Added This Session

- **24h visibility on target selection**: popup opened on `setTargetObject`
  with `GET /api/visibility` → 24h altitude curve (SVG), rise/transit/set,
  observability window; catalog enrichment (Messier/NGC/Bright Star/
  Sharpless): mag, **computed surface brightness** (mag + size), size, type,
  constellation. 14 tests.

---

## Next Steps (planned on 28/08/2026)

> **Prerequisite**: completed work (A1, A2, B3, C1–C4 including C3 from the working
> tree) was committed on 29/08 (checked Lots launched above).

### Lot A — Harden Automation (foundations)

- [x] ~~**A1. Dithering actually driven by the guider**~~ — **DONE (28/08)**:
  server-side guider reference shift (`apply_dither`/`wait_settle`
  in `guide.py`) + configurable settle (RMS ″ / timeout / stability),
  exposed in the sequencer UI and API defaults. One possible refinement remains:
  dither via direct mount pulse (mode `pulse`) instead of reference shift only.
- [x] ~~**A2. Trigger Manager**~~ — **DONE (28/08)**: `indigo/devices/triggers.py`
  (TriggerManager) emits sequence events (`sequence_start`,
  `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`)
  to configurable actions — `log`, `script` (shell + timeout), and
  `mount_goto` (RA/DEC). Optional conditions (e.g. `frame_type`) and
  `{…}` templating of messages/commands. **Non-blocking** firing (a failing action
  never breaks the sequence). UI/API: GET `/api/triggers/status` +
  POST `/api/triggers/test`. Hooked via `on_frame_start`/`on_error`/`on_end`
  in `SequenceRunner`. **Foundation for Lot B** (B2 will plug Telegram/webhook alerts
  as a new action). Tests `tests/test_triggers.py` (12)
  + hooks in `test_sequence.py` + E2E coverage in `test_sequence_flow.py`
  → 219 pytest OK.

### Lot B — Supervision & Safety

- [ ] **B1. Weather management** — **DISCARDED**: Noctua's control tower is not
  intended to communicate over the internet (decision on 28/08). No weather
  drivers or automatic weather stop.
- [ ] **B2. Push alerts** — **DISCARDED** (same as B1: nothing goes out to the internet —
  webhook/Telegram/email not applicable).
- [x] ~~**B3. Auto refocus**~~ — **DONE (28/08)**: `indigo/devices/refocus.py`.
  `RefocusPolicy` (`sequence.refocus`: `interval_min`,
  `alt_trigger_deg` — 0 = dimension disabled) triggering on LIGHT exposures,
  between two exposures, a **fully server-side** refocus: HFR V-curve via
  `run_autofocus()` (move focuser → short exposure → `focus_metrics` → `AutoFocus`
  machine → return to best point). The 1st exposure records the baseline
  (never a surprise refocus at start); a failure (HFR not measurable, focuser
  timeout) does not break the sequence and retries after 5 min cooldown. Brutal
  in-app: `seq-ref-*` checkboxes, status in panel. Tests
  `tests/test_refocus.py` (11) → 230 pytest OK. **Next → Lot C.**

### Lot C — Quality & Organization

- [x] ~~**C1. Master library**~~ — **DONE (29/08)**:
  `indigo/devices/masters.py` (`MasterLibrary`) — combines raw frames into
  calibration masters (bias/dark/flat) cataloged by normalized FITS header
  : filter, binning, temperature, exposure, NCOMBINE, provenance
  (instrument/telescope/site). Resolution: binning must match, dark within
  ±5 °C (never a "hot" master outside tolerance) with preferred exposure
  ≥ requested, flat by filter + binning. Endpoints `/api/masters`
  (GET status, POST build dir|files, resolve, delete, calibrate → inject into
  livestack). Default root `sequence.save_dir`, override
  `masters.dir`. The Flat Wizard can thus produce reusable automatic flats.
  Unit tests `tests/test_masters.py` (8) + HTTP E2E smoke.
- [x] ~~**C2. Target/date scheduling + resume**~~ — **DONE (28/08)**: structure
  `<save_dir>/<slug-target>/<YYYY-MM-DD>/<HHMMSS>` (without target → legacy
  `capture_<TS>`), `journal.json` log (atomic write, `created_at`
  preserved) updated at each exposure; **Resume** button (hidden if session
  finished) → `POST /api/sequence/resume-session` → runner skips exposures
  already done (`start(frames, resume_from=done)`) and **continues file
  indexes** (no overwrite), journal marked `complete` at the end. Helpers
  `slugify`/`build_session_dir`/`save_journal`/`load_journal` (unit tests) +
  target/date flow and resume → **237 pytest OK, sequence flow 55 OK**.
- [x] ~~**C3. Named sequence templates**~~ — **DONE (28/08)**:
  `indigo/devices/templates.py` (`SequenceTemplateStore`, persistent YAML,
  validation via `validate_frames`). Endpoints `/api/sequence/templates`
  (GET/list, POST upsert, delete, import, export); UI: Templates row
  (select + 💾 save / 🗑 / ⇪ export → clipboard / ⇓ import pasted JSON
  ). Reusable plans (L, RGB, Ha…) shareable via
  `{version, exported_at, templates}`. Unit tests `tests/test_templates.py` +
  CRUD flow → **246 pytest OK, sequence flow 65 OK**.
- [x] ~~**C4. Journaling by target**~~ — **DONE (29/08)**: metadata **in
  the FITS header of images** (`indigo/devices/fitsmeta.py`, binary rewrite
  without astropy, data preserved bit-identical). Normalized keywords:
  IMAGETYP/DATE-OBS, target (OBJECT, OBJTHOUR, OBJTDEC), exposure (EXPTIME), sensor
  (INSTRUME, CCD-TEMP, SET-TEMP, PIXSIZE, GAIN, OFFSET, binning H/V), optics
  (FOCALLEN), telescope (TELESCOP), site (SITELAT/LONG/ELEV), provenance
  (SWCREATE). Injection wired to: sequence save
  (`web/routers/sequence.py`), livestack session (`web/server.py`) and
  `/api/camera/save`. Missing values (None/NaN/Inf) skipped, accents
  transliterated (ASCII FITS). Unit tests `tests/test_fitsmeta.py` (11) + header
  checks in flow → **265 pytest OK, sequence flow 75 OK**.

### Lot D — Advanced (later)

- [x] **D1.** Automatic mosaic (tiling into chained tiles).
- [ ] **D2.** Dome / rolloff roof.
- [x] **D3.** Complete framing assistant (sensor orientation, pivot, target framing) — **DONE (30/08)**: see gap 6. Framing panel in astrometry mode, rotatable FOV overlay + target bounding box, fit-check, auto rotation from solve.
- [ ] **D4. Narrowband LUT** — **DISCARDED (28/08)**: final color composition
  (Ha/OIII/SII palettes, stretches) belongs to post-processing (Siril
  ChannelCombination, PixInsight) on calibrated masters; a live
  false-color preview would only composite a single mono filter per exposure.

### Recommended Order

A1 → A2 → B3 → ~~C2~~ → ~~C3~~ → ~~C4~~ → ~~C1~~ → Lot D.
(B1 weather and B2 alerts discarded — no internet communication.)
In Lot D, **D1 (mosaic)** done on 29/08 and **D3 (framing assistant)** done
on 30/08; D2 (dome/roof) on hold, D4 (narrowband LUT) discarded
(post-processing).

---

*Reviewed on 30/08/2026.*
