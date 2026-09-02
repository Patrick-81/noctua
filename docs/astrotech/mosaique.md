---
layout: default
title: Mosaïque & FOV
parent: Astro-technique — fiches
nav_order: 5
---

# Mosaïque & FOV

**FOV** (champ) = `2·arctan(largeur_capteur / 2·focale)`. Noctua le calcule depuis `CCD_INFO` (taille pixels × nombre de pixels) et la focale saisie dans les props caméra.

**Grille** : `pas = FOV·(1−recouvrement)`, tuiles `ceil(span/pas)` avec correction RA `cos(dec)` (les écarts en RA → heures se resserrent vers le pôle : `ΔRA = Δ°/15/cos(dec)`). Aperçu orange sur la carte.

À l'exécution : pour chaque tuile → slew → attente `slew.state Ok` → solve `recenter_duration` → GOTO corrigé → poses (`MOSN/MOSROW/MOSCOL` dans le FITS). Les poses suivantes de la même tuile ne re-slew pas.

📷 à venir : M31 2×3 avec chevauchement 10 % vs 20 % (trous visibles).
