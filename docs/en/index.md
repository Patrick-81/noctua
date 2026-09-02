---
layout: default
title: Home — Noctua 🇬🇧
nav_order: 4
description: INDIGO web UI for mount, cameras, focuser, guiding and sequences — panel-by-panel user guide.
permalink: /en/
---

# Noctua — User Documentation 🇬🇧
{: .fs-6 .fw-300 }

Web UI (FastAPI + Vanilla JS, no build step) to drive astronomical gear via an [INDIGO](https://www.indigo-astronomy.org/) server — mount, cameras, focuser, filter wheel, autoguiding, sequences and live stacking.

[![Python 3.10+](https://img.shields.io/badge/python-3.10-blue)](#) [![285 tests](https://img.shields.io/badge/tests-285%20pytest-green)](#) [![INDIGO](https://img.shields.io/badge/INDIGO-7624-lightgrey)](#)

> 🇫🇷 Version française : [Accueil — Noctua]({{ site.baseurl }}{% link index.md %}) · This is the **English** version. Every page has a FR/EN switch at the top.

---

## Where do I start?

| If you want to… | Go to… |
|---|---|
| Plug hardware and connect | [1 · Startup & connection]({{ site.baseurl }}{% link en/panneaux/01-hardware.md %}) |
| Slew / track a target | [2 · Mount & sky map]({{ site.baseurl }}{% link en/panneaux/02-mount.md %}) |
| Get focus | [3 · Focuser & Autofocus]({{ site.baseurl }}{% link en/panneaux/03-focuser.md %}) |
| Guide without trailing | [4 · Autoguiding]({{ site.baseurl }}{% link en/panneaux/04-guiding.md %}) |
| Take a single frame (flat / bias) | [5 · Capture & Flat Wizard]({{ site.baseurl }}{% link en/panneaux/05-capture.md %}) |
| Run a full multi-target night | [6 · Sequencer]({{ site.baseurl }}{% link en/panneaux/06-sequencer.md %}) |
| Solve / center / do polar alignment | [7 · Astrometry]({{ site.baseurl }}{% link en/panneaux/07-astro.md %}) |
| Understand *why* your star is soft | [Astro deep-dive]({{ site.baseurl }}{% link en/astrotech/index.md %}) |

{: .note }
> **Embryo** — This docs site lives on GitHub Pages (left nav / right content, photos per panel). Existing screenshots (`docs/screenshots/*.png`) are embedded; blue callouts are **astro-technique** explainers. `📷 coming soon` placeholders keep the same dark 1920×1080 framing.

---

## Overview

Noctua shows **7 modes** switched from the top bar (🔧 Hardware → 🔭 Mount → 🔍 Focuser → 🎯 Guiding → 📷 Capture → 📋 Sequencer → ⭐ Astro). Each mode only shows the panels that matter at that moment of the night. The **full-screen D3 sky map** and pointing console stay reachable from Mount. Panel position / collapse / pin is persisted per mode (`ui.yaml`).

![Sky Map](../screenshots/skymap.png)

*Full-screen sky map — stars, Milky Way, equator / ecliptic / meridian / horizon, filterable DSO catalogs (M, NGC, IC, Caldwell, Sh2…), limiting magnitude, LST real or manual.*

### Quick wiring

```
[INDIGO server : indigo_server (port 7624)]  ←TCP/XML—  [Noctua: indigo/client.py + DeviceRegistry + web/server.py (FastAPI/WS)]  —HTTP/WS→  [Browser: hub.js + panels]
```

Single binary to run:

```bash
cp config.example.yaml config.yaml   # once
./start-mock-server.sh   # terminal 1 — without hardware (port 17624)
./start.sh 127.0.0.1:17624 --port 8080  # terminal 2 — UI on http://localhost:8080
# or Windows: windows\install.bat → windows\launch-Noctua.bat / windows\start-mock-server.bat
```

> **LAN only** — `0.0.0.0:8080` with no auth. Do not expose to the Internet.

---

## The 7 panels in 30 s

| Mode | Panels | Night use |
|---|---|---|
| **Hardware** 🔧 | Devices, profiles, roles, mount connection (serial / network), raw INDIGO props | You declare *who is what* |
| **Mount** 🔭 | Slew (GOTO, joystick, slew, SYNC, PARK/HOME), meridian flip, sky map, LST clock | You slew |
| **Focuser** 🔍 | Position, HFR V-curve, HFR/history graphs | You focus |
| **Guiding** 🎯 | Checklist, guide preview, drift graph RA/DEC, params, calibration | You lock tracking |
| **Capture** 📷 | Single capture, flat wizard, FITS preview, simple SEQUENCE, live stacking | You take a frame |
| **Sequencer** 📋 | Multi-target plans, templates, mosaic, dithering, auto-refocus, journal | You chain the night |
| **Astro** ⭐ | Plate solve (Seiza), target, polar, pointing model, framing | You fix and frame |

Each left-nav entry details: **what the panel does → step-by-step → screenshot → astro callout → pitfalls → coming photo**.

---

## Conventions

* **📷 coming soon** = planned shot (same `screenshots/*.png` framing, 1920×1080, dark Noctua theme).
* Blue `{: .note }` / `{: .warning }` = short astro explainer. Full [Astro deep-dive]({{ site.baseurl }}{% link en/astrotech/index.md %}) expands.
* UI strings are `FR / EN` (`web/static/i18n.*.js`, FR/EN selector in top bar).

---

## Legacy references

* Full historical guide : [UTILISATION_EN.md](https://github.com/Patrick-81/noctua/blob/master/docs/UTILISATION_EN.md)
* Exhaustive config : [CONFIGURATION_EN.md](https://github.com/Patrick-81/noctua/blob/master/docs/CONFIGURATION_EN.md) (`config.example.yaml` commented)
* Dev view : [ARCHITECTURE_EN.md](https://github.com/Patrick-81/noctua/blob/master/docs/ARCHITECTURE_EN.md)

Next: open [1 · Hardware — plug and connect →]({{ site.baseurl }}{% link en/panneaux/01-hardware.md %})

