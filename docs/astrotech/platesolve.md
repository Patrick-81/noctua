---
layout: default
title: Plate solving
parent: Astro-technique — fiches
nav_order: 7
---

# Plate solving (Seiza)

**Astrométrie** = retrouver RA/DEC + rotation + échelle d'une image en triangulant les étoiles contre un index (~26 Mo).

* **Indice** : on donne une estimation (RA/DEC monture + échelle `≈ 206.265·pixel/focale`) → rapide (< 2 s).
* **Blind** : sans indice → lent (balaye tout le ciel) — secours seulement.
* Échec typique : échelle fausse ×2 (binning oublié), pose trop courte (3 étoiles) ou saturée.

Usage Noctua : recentrage mosaïque/flip, `record-solve` du modèle de pointage, angle du framing.

📷 à venir : image avant/après solve avec WCS et cercles d'étoiles appariées.
