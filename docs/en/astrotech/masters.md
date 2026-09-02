---
layout: default
title: Masters & calibration
parent: Astro — deep dive 🇬🇧
nav_order: 6
permalink: /en/astrotech/masters/
---

# Masters & calibration

**Bias / dark / flat** = instrumental signatures to subtract/divide:

* **Bias**: electronic offset (0 s, shutter closed).
* **Dark**: bias + dark current (temperature + time dependent).
* **Flat**: vignetting + dust (target ADU ~22 k, flat wizard).

Noctua combines raw series → **median master** (`MasterLibrary`, `<masters.dir>/masters/<type>/…`) with normalized C4 header (FILTER, BINNING, CCD-TEMP, EXPTIME). At acquisition, the **resolver** picks the best master for the context (filter/binning/temperature, exposure for dark) — exact match first, then fallbacks.

**Live stacking** can use these masters (bias/dark/flat) to calibrate each frame before alignment; without masters, pure alignment.

📷 coming: master dark vs raw light, flat and dust corrected.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/masters.md %})
