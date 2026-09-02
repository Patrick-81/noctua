---
layout: default
title: Exposition & fond de ciel
parent: Astro-technique — fiches
nav_order: 1
---

# Exposition & fond de ciel

**But** : viser un **fond de ciel** assez haut pour sortir du bruit de lecture, assez bas pour garder de la dynamique sur les étoiles (~15–25 % du plein-échelle).

* **ADU** = niveaux numérisques après `bias (BZERO)`. Image ≈ `bias + ciel·t + étoiles`.
* **Mesurer le ciel** Noctua : 1 pose → `bias = BZERO`, `ciel = (ADU−bias)/t` ; 3 poses → fit linéaire `ADU(t)=bias+m·t` (indépendant du bias, détecte la saturation). Extrapolation → `t* = (target_bg − bias)/m`, clampée `[min_exposure, max_exposure]` et sous `saturation_frac` (~60 %).
* `target_bg` 4000 ADU au-dessus du bias ≈ bon compromis en ciel péri-urbain ; à ajuster selon filtre (Ha narrowband = ciel très faible → poses plus longues).

📷 à venir : histogramme d'une pose à `target_bg` bien exposée vs surex / sous-ex.
