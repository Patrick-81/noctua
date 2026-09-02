---
layout: default
title: Mosaic & FOV
parent: Astro — deep dive 🇬🇧
nav_order: 5
permalink: /en/astrotech/mosaic/
---

# Mosaic & FOV

**FOV** (field) = `2·arctan(sensor width / 2·focal)`. Noctua computes it from `CCD_INFO` (pixel size × pixel count) and focal length entered in camera props.

**Grid**: `step = FOV·(1−overlap)`, tiles `ceil(span/step)` with RA correction `cos(dec)` (RA gaps in hours tighten toward the pole: `ΔRA = Δ°/15/cos(dec)`). Orange overlay on the map.

At run: for each tile → slew → wait `slew.state Ok` → solve `recenter_duration` → corrected GOTO → exposures (`MOSN/MOSROW/MOSCOL` in FITS). Subsequent exposures of the same tile don't re-slew.

📷 coming: M31 2×3 with 10 % vs 20 % overlap (visible gaps).

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/mosaique.md %})
