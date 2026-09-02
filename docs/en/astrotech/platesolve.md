---
layout: default
title: Plate solving
parent: Astro — deep dive 🇬🇧
nav_order: 7
permalink: /en/astrotech/platesolve/
---

# Plate solving (Seiza)

**Astrometry** = recovering RA/DEC + rotation + scale from an image by triangulating stars against an index (~26 MB).

* **Index**: you give an estimate (mount RA/DEC + scale `≈ 206.265·pixel/focal`) → fast (< 2 s).
* **Blind**: no index → slow (scans whole sky) — fallback only.
* Typical failure: scale wrong by ×2 (binning missed), exposure too short (3 stars) or saturated.

Noctua use: mosaic/flip recenter, `record-solve` for pointing model, framing angle.

📷 coming: image before/after solve with WCS and matched star circles.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/platesolve.md %})
