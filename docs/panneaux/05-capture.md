---
layout: default
title: 5 · Capture — poser
parent: Panneaux — mode d'emploi
nav_order: 5
---

# 5 · Capture — poser une image 📷
{: .fs-6 }

Panneaux : **Capture** (pose unitaire, mesure ciel, flat wizard, roue), **Aperçu** (FITS étiré), **SÉQUENCE** (plan simple) et **LIVE STACKING**.

![Capture](../screenshots/capture.png)

*Mode Capture : sélecteurs caméra/filtre/bining/type, EXPOSER, Mesurer le ciel, Flat Wizard, aperçu FITS et progression SÉQUENCE.*

## 5.1 Capture unitaire

* **Caméra / binning / gain / offset / température** (courante + consigne), **type** `LIGHT/DARK/FLAT/BIAS`, **roue** (`L,R,G,B,Ha`).
* `EXPOSER` : lance `count` poses avec `delay` inter-pose → chaque FITS s'affiche dans l'aperçu.
* **Mesurer le ciel** (`exposure.target_bg ~4000 ADU`, `shots 1|3`) : 1 ou 3 poses de test extrapolent la durée atteignant le fond cible (ADU/s), garde anti-saturation (`saturation_frac` 60 %) et SNR projeté.

{: .note }
> **Astro-technique — ADU, bias et ciel**
> L'image = `bias (BZERO) + ciel·t + étoiles`. En mode `1 shot`, le bias vient du FITS ; en `3 shots`, fit linéaire `ADU(t)=bias+m·t` (indépendant du bias, détecte la saturation). Viser `target_bg` ~4000 ADU au-dessus du bias ≈ 15–25 % du plein-échelle : ciel assez haut pour sortir du bruit de lecture, assez bas pour garder de la dynamique sur les étoiles.
> → [Fiche Exposition & ciel](../astrotech/exposition.md)

## 5.2 Flat wizard (dépliable)

Vise un **ADU cible** (~22 000) à **tolérance** % près : `Configurer` (ADU, `tol%`, durée départ/max) → `Étape` (pose + mesure + correction proportionnelle `suggest_duration`) → `AUTO` (boucle jusqu'à convergence) → `Reset`.

## 5.3 Aperçu

FITS avec **étirement auto** (histogramme) ou manuel (curseur `Noir`, `AUTO`), zoom/pan, `1:1`, `◻ adapter`, `⤢ plein-écran` (Échap), `⣿` redimensionner, `Enregistrer` (copie dans `<save_dir>`). En live stacking, l'aperçu montre la **vue empilée étirée** (push WS).

## 5.4 SÉQUENCE simple (un seul plan)

Plan éditable : `LIGHT/DARK…`, durée, filtre, `×`, gain/offset/binning, `delay`. `Démarrer / pause / reprendre / arrêt / reset`. Si **dithering** coché, le statut `dither` s'affiche ici.

## 5.5 Live stacking

Poses courtes en continu — la 1ʳᵉ sert de **référence** ; les suivantes sont **alignées** (appariement d'étoiles) et les trop décalées / pauvres sont **rejetées** (`rejected + raison`).

* **Durée** (s), **Poses à empiler** (`0 = continu`), **Filtre**, **Calibration** (dossiers dark/flat ou bibliothèque masters).
* `DÉMARRER / STOP / ⟲ Reset / Master / Master PNG`. En fin de session auto : master sauvegardé `masters/master_YYYYMMDD_HHMMSS.fits`.

{: .warning }
> **Pièges** — Aperçu noir après pose : histogramme saturé — passe en `AUTO` ou tire le curseur `Noir`. Stacking `0/0 rejected` : dérive trop grande ou pas assez d'étoiles → vérifie le guidage ou augmente la pose.

## 📷 À venir

* Photo `capture-flat-wizard-auto.png` — flat wizard `AUTO` à `ADU 22100 ±5%`
* Photo `capture-apercu-histo.png` — aperçu avec histogramme étiré et curseur Noir
* Photo `capture-livestack-rejected.png` — statut `12/20 · 3 rejetées (trop décalées)`

