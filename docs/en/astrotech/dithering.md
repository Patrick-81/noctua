---
layout: default
title: Dithering & settle
parent: Astro — deep dive 🇬🇧
nav_order: 3
permalink: /en/astrotech/dithering/
---

# Dithering & settle

**Dithering** = intentional offset of the **guiding reference** between two exposures (`amount` px, Gaussian) so sensor defects (hot pixels, pattern) don't align in stacking. Without dither, median stacking cannot reject them.

**Settle**: after dithering, guiding is disturbed. Noctua waits until `RMS < settle_rms` over `settle_stable` consecutive samples, up to `settle_timeout`. On timeout → exposure starts anyway (warning) — a slightly shaky frame is better than stalling the night.

Trade-off: `amount` 1–2 px subtle, 3–5 px aggressive (walking noise ↓ but time lost ↑). `settle_rms` 0 = no wait (dither without settle).

📷 coming: guiding graph with dither spike and settle convergence.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/dithering.md %})
