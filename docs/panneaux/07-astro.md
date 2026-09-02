---
layout: default
title: 7 · Astro — résoudre & cadrer
parent: Panneaux — mode d'emploi
nav_order: 7
---

# 7 · Astro — résoudre, centrer, polaire ⭐
{: .fs-6 }

Panneaux : **Plate solver** (Seiza), **Cible / Framing**, **Polaire**, **Modèle de pointage**.

![Polaire — mise en station](../screenshots/polar.png)

*Mise en station polaire : assistant 3 étapes (captures manuelles/auto) à partir du LST et de la position du pôle.*

## 7.1 Plate solver

* **Indice** (rapide, RA/DEC monture + échelle) vs **Blind** (sans indice, lent). Indice auto (monture + caméra) ou manuel.
* Statut dans le panneau ; un solve **Indice** alimente aussi `record-solve` du **modèle de pointage**.

{: .note }
> **Astro-technique — astrométrie**
> Index Seiza (~26 Mo dans `data/catalogs/`) = triangulation d'étoiles. Sans `scale_hint` (focale), le solve tombe en *blind* et la mosaïque/polaire perd le recentrage. Toujours saisir focale + taille pixels.
> → [Fiche Plate solving](../astrotech/platesolve.md)

## 7.2 Cible & Framing

* **Cible** : saisie RA/DEC, goto, vignette d'offset.
* **Framing** (D3) : FOV réglable (auto caméra/focale ou manuel), **rotation 0–360°** (`Solve` = angle du dernier solve, `Nord ↑` = 0°), cible par `id catalogue` (`M42`) ou RA/DEC. `Définir` superpose le rectangle à l'**échelle angulaire réelle** sur la carte, `GOTO` centre, `✕` efface, **fit-check** (majeur/mineur + PA tient dans le champ ?).

![Capture exemple](../screenshots/capture.png)

*📷 à venir : `framing-m42-rotation.png` — rectangle M42 à 23° qui dépasse du FOV (fit-check rouge) vs à 0° (vert).*

## 7.3 Polaire

Assistant **3 poses** (60° d'écart en AD) → calcul du pôle vrai vs pôle instrumental → flèches de correction. Captures manuelles ou auto. Maths testées par `tests/test_polar_math.js`.

## 7.4 Modèle de pointage

Collection d'**échantillons** (ajout manuel ou auto `record-solve`, tolérance de centrage) → **fit paramétrique** + **IDW** (interpolation des résidus). Après ajustement, les `GOTO (correct)` reçoivent la correction. Panneau = statut des échantillons.

{: .warning }
> **Pièges** — Solve `KO` systématique : échelle fausse d'un facteur 2 (binning oublié), image trop courte (pas d'étoiles) ou trop saturée. Modèle qui *dégrade* le pointage : < 5 échantillons ou répartis sur 10° → échantillonne large (E/O, haute/basse).

## 📷 À venir

* Photo `astro-solve-indice.png` — solve `Indice OK 1.2″/px`
* Photo `polar-step2.png` — étape 2/3 avec flèche de correction

