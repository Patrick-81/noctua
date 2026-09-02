---
layout: default
title: 2 · Mount — slew & track
parent: Panels — How-to 🇬🇧
nav_order: 2
permalink: /en/panneaux/02-mount/
---

# 2 · Mount — slew & track 🔭
{: .fs-6 }

Panels: **Slew** (joystick, GOTO, park/home) + **Pointing console** (D3 sky map) + **Meridian flip**.

![Mount — slew and console](../../screenshots/mount.png)

*Mount mode: joystick, speed, SYNC / centering, PARK/HOME/TRACK/SLEW LEDs and full-screen map behind.*

![Sky map](../../screenshots/skymap.png)

*Sky map: Milky Way, equator / ecliptic / meridian, horizon, constellations, DSO, planets, limiting magnitude, rotation locks (Zenith / E/W), LST clock.*

## Step-by-step

1. **Find a target**: `Search (M1, NGC 7000…)` field or `🌌 OBJECT` button → catalog (M/NGC/IC/Caldwell/Sh2/LDN…). Drag / wheel = pan / zoom map; toggle layers in `☰ DISPLAY`.
2. **GOTO**: `➤ GOTO` (or RA/DEC click → GOTO). Slew shows `Busy` then `Ok`; reticle coords (RA/DEC) and `Station 43.95°N / 1.57°E` update.
3. **Joystick**: `▲▼◄►` (hold = continuous) + speed `Guide/Centering/Find/Max`. `● STOP` and `🛑 EMERGENCY` abort.
4. **SYNC / TEL**: `⟳ SYNC` syncs mount on target, `◎ TEL` centers telescope on reticle.
5. **PARK / HOME / TRACK**: toggle `⏸ PARK`, `🏠 HOME`, `🔭 TRACK`. LEDs at bottom reflect state; `SET PARK` / `SET HOME` memorize current position.
6. **Meridian flip**: `auto` checkbox, `HA` and `margin` (h), `Alt min` (°). Triggered between two exposures in a sequence; if `recenter_after_flip` + focal length → solve + auto-recenter.

{: .note }
> **Astro deep-dive — hour angle & flip**
> Flip happens when **hour angle** `HA = LST − RA` crosses the meridian. Margin `hour_angle_margin` (h) anticipates the crossing; `min_altitude` prevents flipping too low. Anti-reflip inhibits immediate re-flip. Watch `LST` in the pointing console and `HA --- (pending)` → value when mount is online.
> → [Flip sheet](../astrotech/flip.html)

## Console & time

* **Limiting magnitude** (0–8): filters faint stars (D3 batch).
* **LST** local sidereal time computed from `site.longitude` + `jd`; **Manual** mode (date/time) to plan.
* **Grids**: equator, ecliptic (Earth orbit plane), local meridian, horizon, Milky Way.

{: .warning }
> **Pitfalls** — `HA ---` = mount offline. Empty `Search` = DSO catalog unchecked (`M/NGC…`) or limiting magnitude too low. After entering focal length, **reload the page** (FOV cached).

## 📷 Coming soon

* Photo `mount-flip-ha.png` — flip panel with `HA 0.15h / margin 0.2h`
* Short clip `skymap-goto.mp4` — GOTO M42 and orange telescope trail

> 🇫🇷 [Version française]({{ site.baseurl }}{% link panneaux/02-monture.md %})
