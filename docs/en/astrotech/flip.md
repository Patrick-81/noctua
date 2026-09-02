---
layout: default
title: Meridian flip
parent: Astro — deep dive 🇬🇧
nav_order: 4
permalink: /en/astrotech/flip/
---

# Meridian flip

When `HA = LST − RA` crosses 0 h, the mount must swing (tube to the other side of the meridian) to avoid hitting the tripod and tracking past the meridian.

* **Margin** `hour_angle_margin` (h): flip *before* the meridian if you want to finish an exposure cleanly (0.2 h ≈ 12 min).
* **Alt min**: prevents flipping below horizon / obstacle.
* **Anti-reflip**: after a flip `HA` becomes negative; detector inhibits immediate re-flip.
* In sequence: flip **between** two exposures + if `recenter_after_flip` and focal length → short `recenter_duration` (2 s) + Seiza solve → recenter.

📷 coming: HA/LST diagram and tube position before/after flip.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link astrotech/flip.md %})
