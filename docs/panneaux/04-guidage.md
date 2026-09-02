---
layout: default
title: 4 · Autoguidage — figer le suivi
parent: Panneaux — mode d'emploi
nav_order: 4
---

# 4 · Autoguidage — figer le suivi 🎯
{: .fs-6 }

Panneaux : **Checklist** (3 étapes) → **Aperçu guide** → **Dérive** (graphe + RMS) → **Paramètres** + **Calibration**.

![Guidage](../screenshots/guiding.png)

*Mode Guidage : checklist, aperçu caméra guide avec étoile sélectionnée, graphe de dérive RA/DEC et paramètres (pose, agressivité, gains).*

## Checklist — les 3 feux verts

1. **Caméra sélectionnée** — sélecteur caméra guide (ex. `Guider Simulator` / ASI120).
2. **Monture en ligne** — sinon `Monture hors ligne`.
3. **Calibration faite** — lance `Calibration` (poses courtes, détection de l'étoile la plus brillante). **Étoile perdue** → relance auto jusqu'à 3× sinon `Recommencer`.

Puis :

* **Aperçu** : `📷 Capture` ou `⭐ Auto` (auto-sélection = étoile la plus brillante, qualité gaussienne : SNR, HFR, saturation). Zoom/pan (molette, glisser, double-clic, `1:1` / `◻`), `⤢` agrandit. Clic = choix manuel de l'étoile guide.
* **▶ Lancer** : pose courte en boucle, centroïde → impulsions `RA/DEC` (ms) via `MOUNT_MOTION_NS/WE` à la vitesse `Guide`. Le simulateur de dérive du mock (`drift_vel 3.0/1.5 px/frame`, correction 8 px/pulse) montre l'effet en boucle fermée.
* **Graphe** : dérive `RA (arcsec)`, `DEC (arcsec)` sur 120 s, **RMS AD / DEC / total**, `Tolérance` (rouge) et `SNR` (orange), `Trames`, `Corr. RA/DEC ms` et vignette étoile 140×140.

{: .note }
> **Astro-technique — RMS, agressivité et seeing**
> **RMS** = écart-type de la dérive : < 0.8″ = bon, > 1.5″ = vent / seeing. **Agressivité** (0–1) = fraction de l'erreur corrigée à chaque pulse : 0.8 = 80 % → stable ; 1.0 oscille. **Gain RA/DEC** (px→ms) convertit l'erreur pixels → durée d'impulsion (monture). **Binning** 2×2 double le SNR mais divise la résolution par 2.
> → [Fiche Dithering & settle](../astrotech/dithering.md)

## Paramètres

* **Exposition** (0.1–30 s) : 1 s par défaut ; plus long = SNR ↑ mais latence ↑.
* **Binning** 1×1 / 2×2 / 4×4.
* **Agressivité** 0.8, **Gains RA/DEC** 1.0, **Pulse max** 2000 ms, **Tolérance** 10″ (± alerte sonore).

## Dithering (depuis le Séquenceur)

Entre deux poses, Noctua **décale la référence de guidage** d'un vecteur gaussien (`dither.amount` px) puis **settle** : attend `settle_rms` (″) pendant `settle_stable` échantillons, jusqu'à `settle_timeout` (s) max. Le statut `seq-dither-status` et le journal reflètent l'attente.

{: .warning }
> **Pièges** — Checklist bloquée sur calibration : étoile saturée ou trop faible → baisse/hausse la pose guide, évite les bords. RMS qui explose après GOTO : refais la calibration (flexion).

## 📷 À venir

* Photo `guide-checklist-3verts.png` — les 3 coches vertes
* Photo `guide-drift-rms.png` — graphe avec `RMS Total 0.62″` et tolérance à 1.0″
* Vidéo `guide-dither-settle.mp4` — dither + attente settle entre deux poses

