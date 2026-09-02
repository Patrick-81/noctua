---
layout: default
title: 6 · Séquenceur — nuit complète
parent: Panneaux — mode d'emploi
nav_order: 6
---

# 6 · Séquenceur — nuit complète 📋
{: .fs-6 }

Le planificateur principal (modèle NINA) : **N cibles** → chacune son **plan** → éventuellement sa **mosaïque** → options globales (**dither**, **refocus auto**) → **templates** → **reprise**.

![Séquenceur](../screenshots/sequencer.png)

*Mode Séquenceur : liste de cibles à gauche, plan et mosaïque à droite, options globales (dither, refocus, save_dir) et barre d'exécution.*

## Pas-à-pas

1. **Cibles** (colonne gauche) : `＋ ajouter`, `⧉ dupliquer`, `✕ supprimer`. Chaque cible = `nom` (dossier), **RA/Dec** (h/°) ou `🌌 catalogue` (M/NGC…), **rotation** (PA). Ordre = ordre d'exécution. Case = activée.
2. **Plan** (colonne droite) : lignes `LIGHT/DARK/FLAT/BIAS`, durée, filtre, `×`, gain/offset/binning, `delay`. Verrouillé pendant une session en cours.
3. **Mosaïque D1** : coche `Étendre en grille N×M`, saisis `W×H` (arcmin) + `recouvrement %` → `Planifier`. Serveur calcule `R×C = N tuiles` depuis le **FOV réel** (capteur + focale). Aperçu en **orange sur la carte** (tuile courante en gras). À l'exécution : slew → attente fin slew → **recentrage par solve** (Seiza, si focale) → poses. Keywords FITS `MOSN/MOSROW/MOSCOL`.
4. **Templates C3** : `＋💾` (sauver plan nommé), charger, supprimer, `⇪ exporter` (JSON presse-papiers) / `⇓ importer`. Fichier `sequence_templates.yaml`.
5. **Options globales** : `Dither` (px + settle), `Refocus auto` (minutes / Δ altitude), `Sauver dans` (`sequence.save_dir`).
6. **Exécution** : `▶ DÉMARRER` → progression `done/total`, pose courante, `last dither/refocus/save`, erreur. `⏸ Pauser / ▶ reprendre / ⏹ STOP / ⟲ Reset`. `↻ Reprendre` relance une session interrompue (`journal.json`) — seules les poses manquantes sont reprises, **index continus** `NNN`.

{: .note }
> **Astro-technique — mosaïque & FOV**
> Pas = `FOV·(1−recouvrement)`, nombre de tuiles `ceil(span/pas)` avec correction RA `cos(dec)` (les méridiens se resserrent au pôle). D'où l'importance de la focale (voir Matériel). Tuiles trop chevauchantes = temps perdu ; pas assez = trous.
> → [Fiche Mosaïque](../astrotech/mosaique.md) · [Fiche Masters & calibration](../astrotech/masters.md)

## Rangement

Avec cible nommée : `<save_dir>/<cible>/<YYYY-MM-DD>/<HHMMSS>/lights/…` (`frame_light_L_001_*.fits`) + `journal.json`. Sans cible : `capture_YYYYMMDD_HHMMSS/` (legacy). Les entêtes sont **normalisés C4** (OBJECT, IMAGETYP, FILTER, EXPTIME, CCD-TEMP, GAIN/OFFSET, BINNING, PIXSIZE, FOCALLEN, TELESCOP/SITELAT/SITELONG… — réécriture binaire sans astropy).

{: .warning }
> **Pièges** — `FOV caméra indisponible` → focale non renseignée, puis **recharger la page** (cache). `Planifier` affiche `0 tuile` → span < FOV ou focale incohérente.

## 📷 À venir

* Photo `sequencer-mosaic-grid.png` — grille 2×3 sur M31 avec tuile courante en gras
* Photo `sequencer-journal.png` — `journal.json` ouvert et `↻ Reprendre`

