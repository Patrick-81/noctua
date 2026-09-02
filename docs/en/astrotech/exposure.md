---
layout: default
title: Exposure & sky background
parent: Astro — deep dive 🇬🇧
nav_order: 1
permalink: /en/astrotech/exposure/
---

# Exposure & sky background

**Goal**: aim for a **sky background** high enough above read noise, low enough to keep star headroom (~15–25 % full well).

* **ADU** = digital levels after `bias (BZERO)`. Frame ≈ `bias + sky·t + stars`.
* **Measure sky** in Noctua: 1 frame → `bias = BZERO`, `sky = (ADU−bias)/t`; 3 frames → linear fit `ADU(t)=bias+m·t` (bias-independent, detects saturation). Extrapolation → `t* = (target_bg − bias)/m`, clamped `[min_exposure, max_exposure]` and below `saturation_frac` (~60 %).
* `target_bg` 4000 ADU above bias ≈ good compromise under suburban sky; tune per filter (Ha narrowband = very faint sky → longer exposures).

📷 coming: histogram of a frame at `target_bg` well exposed vs over/under.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/exposition.md %})
