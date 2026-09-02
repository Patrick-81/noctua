---
layout: default
title: 5 · Capture — take a frame
parent: Panels — How-to 🇬🇧
nav_order: 5
permalink: /en/panneaux/05-capture/
---

# 5 · Capture — take a frame 📷
{: .fs-6 }

Panels: **Capture** (single frame, sky measure, flat wizard, wheel), **Preview** (stretched FITS), **SEQUENCE** (simple plan) and **LIVE STACKING**.

![Capture](../../screenshots/capture.png)

*Capture mode: camera/filter/binning/type selectors, EXPOSE, Measure sky, Flat Wizard, FITS preview and SEQUENCE progress.*

## 5.1 Single capture

* **Camera / binning / gain / offset / temperature** (current + target), **type** `LIGHT/DARK/FLAT/BIAS`, **wheel** (`L,R,G,B,Ha`).
* `EXPOSE`: runs `count` frames with `delay` inter-frame → each FITS shows in preview.
* **Measure sky** (`exposure.target_bg ~4000 ADU`, `shots 1|3`): 1 or 3 test frames extrapolate the duration reaching the target sky background (ADU/s), anti-saturation guard (`saturation_frac` 60 %) and projected SNR.

{: .note }
> **Astro deep-dive — ADU, bias & sky**
> Frame ≈ `bias (BZERO) + sky·t + stars`. In `1 shot` mode bias comes from FITS; in `3 shots` linear fit `ADU(t)=bias+m·t` (bias-independent, detects saturation). Target `target_bg` ~4000 ADU above bias ≈ 15–25 % full well: high enough above read noise, low enough to keep star headroom.
> → [Exposure sheet](../astrotech/exposure.html)

## 5.2 Flat wizard (collapsible)

Aims for **target ADU** (~22 000) within **tolerance** %: `Configure` (ADU, `tol%`, start/max duration) → `Step` (expose + measure + proportional `suggest_duration`) → `AUTO` (loop to convergence) → `Reset`.

## 5.3 Preview

FITS with **auto-stretch** (histogram) or manual (`Black` slider, `AUTO`), zoom/pan, `1:1`, `◻ fit`, `⤢ fullscreen` (Esc), `⣿` resize, `Save` (copy to `<save_dir>`). In live stacking, preview shows the **stacked stretched view** (WS push).

## 5.4 Simple SEQUENCE (single plan)

Editable plan: `LIGHT/DARK…`, duration, filter, `×`, gain/offset/binning, `delay`. `Start / pause / resume / stop / reset`. If **dithering** enabled, `dither` status shows here.

## 5.5 Live stacking

Continuous short exposures — 1st is **reference**; next are **aligned** (star matching) and too-shifted / star-poor frames are **rejected** (`rejected + reason`).

* **Duration** (s), **Frames to stack** (`0 = continuous`), **Filter**, **Calibration** (dark/flat folders or masters library).
* `START / STOP / ⟲ Reset / Master / Master PNG`. On auto session end: master saved `masters/master_YYYYMMDD_HHMMSS.fits`.

{: .warning }
> **Pitfalls** — Black preview after exposure: histogram clipped — switch to `AUTO` or drag `Black`. Stacking `0/0 rejected`: drift too large or not enough stars → check guiding or lengthen exposure.

## 📷 Coming soon

* Photo `capture-flat-wizard-auto.png` — flat wizard `AUTO` at `ADU 22100 ±5%`
* Photo `capture-preview-histo.png` — preview with stretched histo and Black slider
* Photo `capture-livestack-rejected.png` — status `12/20 · 3 rejected (too shifted)`

> 🇫🇷 [Version française]({{ site.baseurl }}{% link panneaux/05-capture.md %})
