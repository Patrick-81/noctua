---
layout: default
title: HFR & V-curve
parent: Astro — deep dive 🇬🇧
nav_order: 2
permalink: /en/astrotech/hfr/
---

# HFR & V-curve

**HFR** (half-flux radius) = radius holding 50 % of a star's flux. Minimum at focus, linear either side → **V**.

* Measure: Gaussian fit (SNR, FWHM, saturation) in `focus_metrics.py`.
* **V-curve**: `points` measures over `±range/2` steps → parabola fit → `Best`. A saturated or double star breaks the V (artificially low HFR).
* Typical step: `range 2000 / points 25` → ~80 steps/point. More points = robust but slow.
* **Auto-refocus** (sequencer): re-runs V-curve if `interval_min` or `Δ altitude` exceeded — seeing is temperature-dependent.

📷 coming: perfect V-curve vs noisy V-curve (wind).

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/hfr.md %})
