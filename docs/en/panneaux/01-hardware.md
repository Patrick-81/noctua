---
layout: default
title: 1 · Hardware — plug & connect
parent: Panels — How-to 🇬🇧
nav_order: 1
permalink: /en/panneaux/01-hardware/
---

# 1 · Hardware — plug & connect 🔧
{: .fs-6 }

Declare *who is what* before slewing. A **profile** freezes the mapping roles → INDIGO devices + how the mount connects (serial vs network).

![Hardware — profiles, devices, roles](../../screenshots/hardware.png)

*Hardware panel: detected devices, persistent profiles, roles, mount connection and raw INDIGO properties.*

## Step-by-step

1. **Start the server** (`./start.sh` or `windows\launch-Noctua.bat`) → the top bar shows `● Offline` then `● Online` when `indigo_server` answers.
2. Open **🔧 Hardware** → **DEVICES**: tick what you use (e.g. `Telescope Simulator`, `CCD Simulator`).
3. **MOUNT — CONNECTION**: pick `Serial` (`/dev/ttyUSB0`, `/dev/ttyACM0`) or `Network host:port` (`192.168.1.10:7624`). The pair `mount_interface` / `mount_endpoint` is saved in the profile.
4. **ROLES**: assign `mount`, `camera`, `guide_camera`, `focuser`, `filter_wheel`. The top-bar LEDs (`T C A F W`) turn green when the role is connected.
5. **Profile**: `＋` (new), `💾` (save), **APPLY** (connects the whole set). Profile lives in `profiles.yaml` (override `INDIGO_PROFILES_PATH`).
6. **DEVICE PROPERTIES**: pick a device → direct edit of INDIGO vectors (`CONNECTION`, `FOCUSER_POSITION`, `CCD_INFO` …) — use it to enter the **focal length** (mandatory for mosaic / solve).

{: .note }
> **Astro deep-dive — why focal length matters**
> Without focal length Noctua cannot compute the **field of view (FOV)**: `FOV = 2·arctan(sensor / 2·focal)`. So: no orange mosaic grid on the map, no `scale_hint` for plate solving, no framing fit-check. Enter the focal length in the main camera props then **reload the page** (FOV is page-cached).

## Sensors & wheel

* Filter wheel: `FILTER_SLOT` (`L,R,G,B,Ha`) — sequence `L,R,G,B` in Capture / Sequencer.
* Top-bar LEDs: grey → `#44cc44` when connected, visible even in `graphite`/`sober` themes.

{: .warning }
> **Pitfall** — `● Offline` stuck: check `config.yaml` `indigo.host/port` or run the mock `tests/mock_indigo.py --port 17624`. On mobile, driver/serial fields are hidden but manageable here.

## 📷 Coming soon

* Photo `hardware-profil-apply.png` — APPLY click + green LEDs in top bar
* Photo `hardware-focale.png` — focal length field in camera props, lat/lon bar

Config refs: `profiles.yaml`, `indigo.host/port`, `site.*` — see [CONFIGURATION_EN](https://github.com/Patrick-81/noctua/blob/master/docs/CONFIGURATION_EN.md) §1/8.

> 🇫🇷 [Version française]({{ site.baseurl }}{% link panneaux/01-hardware.md %})
