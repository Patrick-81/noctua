---
layout: default
title: Flip méridien
parent: Astro-technique — fiches
nav_order: 4
---

# Flip méridien

Quand `HA = LST − RA` passe 0 h, la monture doit basculer (tube de l'autre côté du méridien) pour éviter de taper le trépied et de suivre au-delà du méridien.

* **Marge** `hour_angle_margin` (h) : flippé *avant* le méridien si tu veux finir une pose proprement (0.2 h ≈ 12 min).
* **Alt min** : empêche un flip en dessous de l'horizon / d'un obstacle.
* **Anti-re-flip** : après un flip, `HA` redevient négatif ; le détecteur inhibe le re-flip immédiat.
* En séquence : flip **entre** deux poses + si `recenter_after_flip` et focale → pose courte `recenter_duration` (2 s) + solve Seiza → recentrage.

📷 à venir : schéma HA/LST et position du tube avant/après flip.
