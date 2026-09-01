# Noctua — Control your astro setup differently. Modern, aesthetic, performant — and lightweight.

> **A single web page, hosted on your remote PC (even a Raspberry Pi at the mount), accessible everywhere: phone, tablet or PC in the browser. No app, no store, no RDP/VNC.**

**Noctua covers all features of a modern, accomplished astro software**, but stands out where others stop: **native server mode** (vs N.I.N.A. Windows desktop) + **extreme lightness** — vanilla JS with no build, no framework, 41k-star sky map at 60 FPS on a plain canvas. Powerful like a pro, light like a web page.

**Universal: INDI, INDIGO and ASCOM via INDIGO.** Noctua speaks a single protocol `INDIGO/INDI (TCP 7624)` to `indigo_server`. The server loads your native **INDIGO**, **INDI** or **ASCOM** drivers (ZWO, QHY… on Windows) — Noctua sees them as INDIGO devices. One middleware, all setups.

> **Current status: alpha** — tested in simulation and on a tablet in the lab, **not yet in real field conditions at the mount**. Field feedback is exactly what will drive the beta.

---

## New — Alpha mobile / tablet (`portage-mobile` `v19`)

**Designed for the tablet at the mount, usable on the phone.**

- **Touch ergonomics**: full-width top bar, **icon column on the right** below the bar, **Modes/Workshops** at the bottom (7 icons), swipe between modes, stacked panels without overlap. Fixed sky map behind — drag, pinch, zoom even with panels open.
- **Night readability**: 5 palettes `Noctua / Sobre / Graphite / Twilight / Ember` + ultra-compact LEDs `T C A F W/R` **neutral grey → bright green `#44cc44`** (visible even in `Graphite`), showing at a glance which devices are connected.
- **Simplified Hardware**: the `Driver` line leaves the top bar — everything is done in the **Hardware** workshop. For the mount, choose **Serial `/dev/ttyUSB0`** or **Network `host:port`** (`192.168.1.10:7624`), **saved in the profile**. One profile = one setup, ready in one tap.

---

## Try the alpha

```bash
git fetch && git checkout portage-mobile
./start.sh 192.168.1.x:7624 --port 8080
# then http://<pc-ip>:8080 from any device on the network
```

**Without hardware (dry run):**
```bash
./start-mock-server.sh --port 17624   # terminal 1: simulated INDIGO
./start.sh 127.0.0.1:17624 --port 8080 # terminal 2: Noctua on mock
```

Branch pushed: `origin/portage-mobile`. Installable PWA, dark theme by default.

---

## Join the development — We need you

**Contribute to Noctua now, in alpha.** MIT, lightweight (vanilla JS, no build): every feedback and every PR matters.

**How to join:**
- **Test** your setup (mount Serial `/dev/ttyUSB0` or Network `host:port`) and open an **Issue** with a mobile screenshot + config
- **Code**: grab a `good first issue`, propose a touch fix, translation, LED/column improvement
- **Share**: an ergonomic idea is worth a PR

**Where:** GitHub `portage-mobile` → Discussions / Issues `alpha`, or reply to this post. Let's build the beta together — your field test makes the difference.

---

*Noctua — the joy of piloting, finally at hand.*
