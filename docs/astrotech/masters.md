---
layout: default
title: Masters & calibration
parent: Astro-technique — fiches
nav_order: 6
---

# Masters & calibration

**Bias / dark / flat** = signatures instrumentales à soustraire/diviser :

* **Bias** : offset électronique (pose 0 s, obtu fermé).
* **Dark** : bias + courant d'obscurité (température + temps dépendant).
* **Flat** : vignettage + poussières (ADU cible ~22 k, flat wizard).

Noctua combine des séries de raws → **master médian** (`MasterLibrary`, `<masters.dir>/masters/<type>/…`) avec entête normalisé C4 (FILTER, BINNING, CCD-TEMP, EXPTIME). À l'acquisition, le **résolveur** cherche le meilleur master pour le contexte (filtre/binning/température, exposition pour dark) — match exact d'abord, puis dégradations.

Le **live stacking** peut s'appuyer sur ces masters (bias/dark/flat) pour calibrer chaque pose avant alignement ; sans master, alignement pur.

📷 à venir : master dark vs light brut, flat et poussières corrigées.
