---
layout: default
title: Dithering & settle
parent: Astro-technique — fiches
nav_order: 3
---

# Dithering & settle

**Dithering** = décalage volontaire de la **référence de guidage** entre deux poses (`amount` px, gaussien) pour que les défauts du capteur (pixels chauds, trame) ne s'alignent pas à l'empilement. Sans dither, le stacking médian ne peut pas les rejeter.

**Settle** : après le dither, le guidage est perturbé. Noctua attend que `RMS < settle_rms` pendant `settle_stable` échantillons consécutifs, jusqu'à `settle_timeout`. Si timeout → la pose part quand même (log warning) — mieux vaut une pose légèrement bougée que bloquer la nuit.

Trade-off : `amount` 1–2 px discret, 3–5 px agressif (walking noise ↓ mais temps perdu ↑). `settle_rms` 0 = pas d'attente (dithering sans settle).

📷 à venir : graphe guidage avec pic de dither et convergence settle.
