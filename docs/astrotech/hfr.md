---
layout: default
title: HFR & V-curve
parent: Astro-technique — fiches
nav_order: 2
---

# HFR & V-curve

**HFR** (half-flux radius) = rayon contenant 50 % du flux d'une étoile. Minimum à la mise au point, linéaire de part et d'autre → **V**.

* Mesure : ajustement gaussien (SNR, FWHM, saturation) dans `focus_metrics.py`.
* **V-curve** : `points` mesures sur `±range/2` steps → fit parabole → `Best`. Une étoile saturée ou double casse le V (HFR artificiellement bas).
* Pas typique : `range 2000 / points 25` → ~80 steps/point. Plus de points = robuste mais lent.
* **Refocus auto** (séquenceur) : relance la V-curve si `interval_min` ou `Δ altitude` dépassé — seeing thermiquement dépendant.

📷 à venir : V-curve parfaite vs V-curve bruitée (vent).
