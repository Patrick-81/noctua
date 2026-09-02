---
layout: default
title: 2 · Monture — pointer
parent: Panneaux — mode d'emploi
nav_order: 2
---

# 2 · Monture — pointer et suivre 🔭
{: .fs-6 }

Panneaux : **Pilotage** (joystick, GOTO, park/home) + **Console de pointage** (carte du ciel D3) + **Flip méridien**.

![Monture — pilotage et console](../screenshots/mount.png)

*Mode Monture : joystick, vitesse, SYNC / centrage, LEDs PARK/HOME/TRACK/SLEW et carte plein-écran en arrière-plan.*

![Sky map](../screenshots/skymap.png)

*Sky map : Voie Lactée, équateur / écliptique / méridien, horizon, constellations, DSO, planètes, magnitude limite, verrouillage rotation (Zénith / E/O), heure LST.*

## Pas-à-pas

1. **Cherche une cible** : champ `Rechercher (M1, NGC 7000…)` ou bouton `🌌 OBJET` → catalogue (M/NGC/IC/Caldwell/Sh2/LDN…). Glisser / molette = pivoter / zoomer la carte ; les couches se filtrent dans `☰ AFFICHAGE`.
2. **GOTO** : `➤ GOTO` (ou clic RA/DEC → GOTO). Le slew s'affiche `Busy` puis `Ok` ; les coords réticule (RA/DEC) et `Station 43.95°N / 1.57°E` se mettent à jour.
3. **Joystick** : `▲▼◄►` (maintien = continu) + vitesse `Guide/Centering/Find/Max`. `● STOP` et `🛑 EMERGENCY` coupent le slew.
4. **SYNC / TÉL** : `⟳ SYNC` cale la monture sur la cible, `◎ TÉL` centre le télescope sur le réticule.
5. **PARK / HOME / TRACK** : toggle `⏸ PARK`, `🏠 HOME`, `🔭 TRACK`. Les LEDs en bas du pilotage reflètent l'état ; `SET PARK` / `SET HOME` mémorisent la position actuelle.
6. **Flip méridien** : case `auto`, `HA` et `marge` (h), `Alt min` (°). Déclenché entre deux poses en séquence ; si `recenter_after_flip` + focale connue → solve + recentrage auto.

{: .note }
> **Astro-technique — angle horaire & flip**
> Le flip intervient quand l'**angle horaire** `HA = LST − RA` passe le méridien. Marge `hour_angle_margin` (h) anticipe le passage ; `min_altitude` évite de flipper trop bas. L'anti-re-flip empêche de rebasculer immédiatement. Travaux pratiques : affiche `LST` dans la console de pointage et guette `HA --- (calcul en attente)` → valeur quand la monture est connectée.
> → [Fiche Flip méridien](../astrotech/flip.md)

## Console & temps

* **Magnitude limite** (0–8) : filtre les étoiles faibles (batch D3).
* **LST** temps sidéral local calculé depuis `site.longitude` + `jd` ; mode **Manuel** (date/heure) pour planifier.
* **Grilles** : équateur, écliptique (plan de l'orbite terrestre), méridien local, horizon, Voie Lactée.

{: .warning }
> **Pièges** — `HA ---` = monture hors ligne. `Rechercher` vide = catalogue DSO décoché (`M/NGC…`) ou magnitude trop basse. Après avoir renseigné la focale, **recharger la page** (FOV en cache).

## 📷 À venir

* Photo `mount-flip-ha.png` — panneau flip avec `HA 0.15h / marge 0.2h`
* Vidéo courte `skymap-goto.mp4` — GOTO M42 et traînée télescope orange

