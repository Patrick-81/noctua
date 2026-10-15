---
layout: default
title: 3 · Focuser — faire le point
parent: Panneaux — mode d'emploi
nav_order: 3
---

# 3 · Focuser — faire le point 🔍
{: .fs-6 }

Panneaux : **Focuser** (position / vitesse / déplacements) + **Focus — HFR** + **Autofocus V-curve**.

![Focuser](../screenshots/focuser.png)

*Mode Focuser : position courante/cible et barre, vitesse, déplacements relatifs/absolus, graphes HFR et V-curve en bas.*

## Pas-à-pas

1. Sélectionne la **caméra** (si plusieurs) en haut du panneau Focuser.
2. Ajuste la **vitesse** (`steps/s`, `OK`) puis bouge par paliers `−1000/−100/−10 / +10/+100/+1k` ou saisis une **position absolue** → `GO`. La barre cyan suit la cible ; `● MOVING` s'allume pendant le déplacement. `⏹ Arrêter` = `FOCUSER_ABORT_MOTION`.
3. **Focus — HFR** : chaque pose alimente le graphe `HFR vs position` (canvas 320×100) + historique (60 px). `Steps` et `Best` s'incrémentent ; `Reset` efface la série.
4. **Autofocus V-curve** : règle `Plage` (steps, ex. 2000) et `Points` (25) → `▶ Lancer`. La V-curve mesure le **HFR** à chaque pas, ajuste une parabole, revient au **Best** et vérifie. Barre `0/25`, `HFR: — / Pos: —` en temps réel.

{: .note }
> **Astro-technique — HFR et V-curve**
> Le **HFR** (half-flux radius) = rayon contenant la moitié du flux d'une étoile : minimum à la mise au point, linéaire de part et d'autre → forme en V. Un bon autofocus exige : étoile non saturée (pic < `saturation_frac` ~60 % du plein-échelle), pose courte (`exposure.target_bg` ~4000 ADU au-dessus du bias), turbulence (seeing) stable. Le scan rate 25 pts / 2000 steps donne ~80 steps/point : compromis temps/précision.
> → [Fiche HFR & V-curve](../astrotech/hfr.md)

## Refocus auto en séquence

En séquenceur : `Refocus auto` se déclenche entre deux poses si `interval_min` (minutes) **ou** `Δ altitude` (°) dépassé — jamais sur la 1ʳᵉ pose (ligne de base). La séquence ne s'arrête pas sur un refocus raté (warning).

## Mise au point manuelle (sans focuser motorisé)

Panneau **✋ Mise au point manuelle** (mode Focuser, en bas à gauche) : tourne la molette à la main, Noctua mesure.

1. `Pose` (s) → `📏 Mesurer` (HFR sur la dernière image) ou `🔁 Loop` (poses en boucle + mesure auto à chaque tour, `⏹ Stop` pour arrêter). La Loop mesure **dès le preview JPEG** (~4 s/tour, sans attendre le FITS complet) : tourne la molette entre deux tours. Aucun ordre n'est envoyé au focuser — ça marche sans focuser branché.
2. Chaque mesure alimente le graphe **HFR** (`Focus — HFR`) : fais descendre la courbe au minimum.
3. **Masque de Bahtinov** : `▦ Bahtinov : ON` puis clique une étoile brillante de l'aperçu → Noctua détecte les 3 aigrettes (Radon) et affiche `Δ ±N px → ⟩⟩/⟨⟨` + les segments sur l'overlay. Règle la molette pour ramener Δ à ~0 (`◎ Au foyer !` sous ±2 px, pastilles vertes dans l'historique). `⇄` inverse le sens indiqué si ton montage de masque l'exige (mémorisé). En `Loop`, la même étoile est ré-analysée à chaque pose.
4. **Vue linéaire** (`◐ Linéaire`, mémorisé) : l'autostretch ment sur les profils d'étoiles ; en MAP on affiche le FITS complet en linéaire pur (noir = fond de ciel, blanc = pixel max, dynamique complète), rapatrié en HTTP à chaque nouvelle image. Indispensable pour juger un foyer, une saturation ou une aigrette.

{: .note }
> **Astro-technique — lecture du Bahtinov**
> Au foyer, l'aigrette centrale coupe exactement le croisement des deux diagonales. Défocalisé, elle se décale latéralement — le signe (intra/extra-focal) dépend du sens du masque, d'où le bouton `⇄` : si l'indication semble inversée (Δ augmente quand tu suis la flèche), inverse une fois pour la session. Backend : `indigo/devices/bahtinov.py` (`GET /api/focuser/bahtinov`), endpoint testé sur étoiles synthétiques (offset ±8 px retrouvé à <1 px).

{: .warning }
> **Pièges** — HFR qui *monte* au lieu de descendre : focuser inversé (`IN/OUT`), étoile saturée ou double, vent. Vérifie l'aperçu 1:1. Si le focuser ne bouge plus : `ABORT` puis `GO` avec une vitesse plus basse.

## 📷 À venir

* Photo `focuser-vcurve-best.png` — V-curve terminée avec `Best: 12480 / HFR 1.42`
* Photo `focuser-hfr-history.png` — historique HFR sur 30 min de refocus périodique

