---
layout: default
title: 7 · Astro — solve & frame
parent: Panels — How-to 🇬🇧
nav_order: 7
permalink: /en/panneaux/07-astro/
---

# 7 · Astro — solve, center, polar ⭐
{: .fs-6 }

Panels: **Plate solver** (Seiza), **Target / Framing**, **Polar**, **Pointing model**.

![Polar — alignment](../../screenshots/polar.png)

*Polar alignment: 3-step helper (manual/auto captures) from LST and pole position.*

## 7.1 Plate solver

* **Index** (fast, mount RA/DEC + scale) vs **Blind** (no index, slow). Index auto (mount + camera) or manual.
* Status in panel; an **Index** solve also feeds `record-solve` of the **pointing model**.

{: .note }
> **Astro deep-dive — astrometry**
> Seiza index (~26 MB in `data/catalogs/`) = star triangulation. Without `scale_hint` (focal length) solve falls back to *blind* and mosaic/polar lose recenter. Always enter focal length + pixel size.
> → [Plate solving sheet](../astrotech/platesolve.html)

## 7.2 Target & Framing

* **Target**: RA/DEC entry, slew, offset thumbnail.
* **Framing** (D3): adjustable FOV (auto camera/focal or manual), **rotation 0–360°** (`Solve` = angle from last solve, `North ↑` = 0°), target by `catalog id` (`M42`) or RA/DEC. `Define` overlays the rectangle at **true angular scale** on the map, `GOTO` centers, `✕` clears, **fit-check** (major/minor + PA fits in field?).

![Capture example](../../screenshots/capture.png)

*📷 coming: `framing-m42-rotation.png` — M42 rectangle at 23° overflowing FOV (red fit-check) vs at 0° (green).*

## 7.3 Polar

**3-pose** helper (60° RA apart) → computes true pole vs instrumental pole → correction arrows. Manual or auto captures. Math tested by `tests/test_polar_math.js`.

## 7.4 Pointing model

Collection of **samples** (manual add or auto `record-solve`, centering tolerance) → **parametric fit** + **IDW** (residual interpolation). After fit, `GOTO (correct)` gets the correction. Panel = sample status.

{: .warning }
> **Pitfalls** — Solve `KO` every time: scale wrong by ×2 (binning missed), exposure too short (3 stars) or saturated. Model *degrading* pointing: < 5 samples or spread over 10° → sample wide (E/W, high/low).

## 📷 Coming soon

* Photo `astro-solve-index.png` — solve `Index OK 1.2″/px`
* Photo `polar-step2.png` — step 2/3 with correction arrow

> 🇫🇷 [Version française]({{ site.baseurl }}{% link panneaux/07-astro.md %})
