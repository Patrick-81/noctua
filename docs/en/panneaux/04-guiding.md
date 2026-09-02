---
layout: default
title: 4 · Guiding — lock tracking
parent: Panels — How-to 🇬🇧
nav_order: 4
permalink: /en/panneaux/04-guiding/
---

# 4 · Guiding — lock tracking 🎯
{: .fs-6 }

Panels: **Checklist** (3 steps) → **Guide preview** → **Drift** (graph + RMS) → **Settings** + **Calibration**.

![Guiding](../../screenshots/guiding.png)

*Guiding mode: checklist, guide camera preview with selected star, RA/DEC drift graph and params (exposure, aggressiveness, gains).*

## Checklist — 3 greens

1. **Camera selected** — guide camera selector (e.g. `Guider Simulator` / ASI120).
2. **Mount online** — otherwise `Mount offline`.
3. **Calibration done** — run `Calibration` (short exposures, brightest-star only). **Star lost** → auto-retry up to 3× else `Retry`.

Then:

* **Preview**: `📷 Capture` or `⭐ Auto` (auto = brightest star, Gaussian quality: SNR, HFR, saturation). Zoom/pan (wheel, drag, double-click, `1:1` / `◻`), `⤢` enlarge. Click = manual guide star pick.
* **▶ Start**: short loop, centroid → `RA/DEC` pulses (ms) via `MOUNT_MOTION_NS/WE` at `Guide` rate. Mock drift simulator (`drift_vel 3.0/1.5 px/frame`, correction 8 px/pulse) shows closed-loop effect.
* **Graph**: drifts `RA (arcsec)`, `DEC (arcsec)` over 120 s, **RMS RA / DEC / total**, `Tolerance` (red) and `SNR` (orange), `Frames`, `Corr. RA/DEC ms` and 140×140 star thumbnail.

{: .note }
> **Astro deep-dive — RMS, aggressiveness & seeing**
> **RMS** = drift std-dev: < 0.8″ good, > 1.5″ = wind / seeing. **Aggressiveness** (0–1) = fraction of error corrected each pulse: 0.8 = 80 % → stable; 1.0 oscillates. **RA/DEC gains** (px→ms) convert pixel error → pulse length. **Binning** 2×2 doubles SNR but halves resolution.
> → [Dithering sheet](../astrotech/dithering.html)

## Settings

* **Exposure** (0.1–30 s): 1 s default; longer = SNR ↑ but latency ↑.
* **Binning** 1×1 / 2×2 / 4×4.
* **Aggressiveness** 0.8, **RA/DEC gains** 1.0, **Max pulse** 2000 ms, **Tolerance** 10″ (± audible alert).

## Dithering (from Sequencer)

Between two exposures Noctua **offsets the guiding reference** by a Gaussian vector (`dither.amount` px) then **settles**: waits for `RMS < settle_rms` over `settle_stable` consecutive samples, up to `settle_timeout` (s). Status `seq-dither-status` and journal reflect the wait.

{: .warning }
> **Pitfalls** — Checklist stuck on calibration: star saturated or too faint → lower/raise guide exposure, avoid edges. RMS blowing up after GOTO: redo calibration (flexure).

## 📷 Coming soon

* Photo `guide-checklist-3greens.png` — 3 green checks
* Photo `guide-drift-rms.png` — graph with `RMS Total 0.62″` and tolerance at 1.0″
* Clip `guide-dither-settle.mp4` — dither + settle wait between two exposures

> 🇫🇷 [Version française]({{ site.baseurl }}{% link panneaux/04-guidage.md %})
