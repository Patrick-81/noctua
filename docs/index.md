---
layout: default
title: Accueil — Noctua
nav_order: 1
description: Interface web INDIGO pour monture, caméras, focuser, guidage et séquences — guide utilisateur par panneaux.
permalink: /
---

# Noctua — Doc utilisateur

{: .fs-6 .fw-300 }

Interface web (FastAPI + Vanilla JS, sans build step) pour piloter des équipements astronomiques via un serveur [INDIGO](https://www.indigo-astronomy.org/) — monture, caméras, focuser, roue à filtres, autoguidage, séquences et live stacking.

[![Python 3.10+](https://img.shields.io/badge/python-3.10-blue)](#) [![285 tests](https://img.shields.io/badge/tests-285%20pytest-green)](#) [![INDIGO](https://img.shields.io/badge/INDIGO-7624-lightgrey)](#)

---

## Par où commencer ?

| Si tu veux… | Va directement à… |
|---|---|
| Brancher ton matériel et te connecter | [1 · Démarrage & connexion]({{ site.baseurl }}{% link panneaux/01-hardware.md %}) |
| Pointer / suivre une cible | [2 · Monture & carte du ciel]({{ site.baseurl }}{% link panneaux/02-monture.md %}) |
| Faire la mise au point | [3 · Focuser & Autofocus]({{ site.baseurl }}{% link panneaux/03-focuser.md %}) |
| Guider et ne pas avoir d'étoiles filantes | [4 · Autoguidage]({{ site.baseurl }}{% link panneaux/04-guidage.md %}) |
| Poser une image (unitaire / flat / bias) | [5 · Capture & Flat Wizard]({{ site.baseurl }}{% link panneaux/05-capture.md %}) |
| Enchaîner une nuit complète multi-cibles | [6 · Séquenceur]({{ site.baseurl }}{% link panneaux/06-sequenceur.md %}) |
| Résoudre / centrer / faire ta polaire | [7 · Astrométrie]({{ site.baseurl }}{% link panneaux/07-astro.md %}) |
| Comprendre pourquoi ton étoile est floue | [Astro-technique]({{ site.baseurl }}{% link astrotech/index.md %}) |

{: .note }
> **Embryon** : cette doc est la nouvelle doc utilisateur du site GitHub Pages (menu à gauche, texte à droite, photos par panneau). Les screenshots existants (`docs/screenshots/*.png`) sont intégrés ; les encadrés bleus ci-dessous sont les fiches **astro-techniques** qui expliquent *pourquoi* chaque réglage existe. Photos complémentaires à venir = placeholder `📷 à venir`.

---

## Vue d'ensemble de l'interface

Noctua affiche **7 modes** commutables par la barre du haut (🔧 Matériel → 🔭 Monture → 🔍 Focuser → 🎯 Guidage → 📷 Capture → 📋 Séquenceur → ⭐ Astro). Chaque mode ne montre que les panneaux qui le concernent ; la **carte du ciel D3** et la console de pointage restent accessibles depuis Monture. La position / réduction / épinglage de chaque panneau est mémorisée par mode (`ui.yaml`).

![Sky Map](screenshots/skymap.png)

*Carte du ciel plein-écran — étoiles, Voie Lactée, équateur / écliptique / méridien / horizon, catalogues DSO filtrables (M, NGC, IC, Caldwell, Sh2…), magnitude limite, LST en temps réel ou manuel.*

### Cartographie rapide

```
[INDIGO server : indigo_server (port 7624)]  ←TCP/XML—  [Noctua: indigo/client.py + DeviceRegistry + web/server.py (FastAPI/WS)]  —HTTP/WS→  [Navigateur: hub.js + panneaux]
```

Un seul binaire à lancer :

```bash
cp config.example.yaml config.yaml   # une fois
./start-mock-server.sh   # terminal 1 — sans matériel (port 17624)
./start.sh 127.0.0.1:17624 --port 8080  # terminal 2 — IHM sur http://localhost:8080
# ou Windows : windows\install.bat → windows\launch-Noctua.bat / windows\start-mock-server.bat
```

> **LAN uniquement** — `0.0.0.0:8080` sans authentification. Ne pas exposer sur Internet.

---

## Les 7 panneaux en 30 s

| Mode | Panneaux | Usage nuit |
|---|---|---|
| **Matériel** 🔧 | Devices, profils, rôles, connexion monture (série / réseau), propriétés INDIGO | Tu déclares *qui est quoi* |
| **Monture** 🔭 | Pilotage (GOTO, joystick, slew, SYNC, PARK/HOME), flip méridien, carte du ciel, horloge LST | Tu pointes |
| **Focuser** 🔍 | Position, V-curve HFR, graphes HFR / historique | Tu fais le point |
| **Guidage** 🎯 | Checklist, aperçu guide, graphe de dérive RA/DEC, paramètres, calibration | Tu figes le suivi |
| **Capture** 📷 | Capture unitaire, flat wizard, aperçu FITS, SÉQUENCE simple, live stacking | Tu poses une image |
| **Séquenceur** 📋 | Cibles multi-plans, templates, mosaïque, dithering, refocus auto, journal | Tu enchaînes la nuit |
| **Astro** ⭐ | Plate solve (Seiza), cible, polaire, modèle de pointage, framing | Tu corriges et cadres |

Chaque rubrique à gauche détaille : **à quoi sert le panneau → pas-à-pas → capture d'écran → encadré astro → pièges**.

---

## Conventions

* **📷 à venir** = photo prévue (maquette plein-écran / détail). Garde le même cadre `screenshots/*.png` (1920×1080, thème Noctua sombre).
* Encadrés `{: .note }` / `{: .warning }` = fiche astro courte. Les pages [Astro-technique]({{ site.baseurl }}{% link astrotech/index.md %}) développent.
* Tous les mots de l'IHM sont `FR / EN` (`web/static/i18n.*.js`, sélecteur FR/EN dans le bandeau).

---

## Références existantes

* Guide complet historique : [UTILISATION.md](https://github.com/Patrick-81/noctua/blob/master/docs/UTILISATION.md)
* Config exhaustive : [CONFIGURATION.md](https://github.com/Patrick-81/noctua/blob/master/docs/CONFIGURATION.md) (`config.example.yaml` commenté)
* Vue dev : [ARCHITECTURE.md](https://github.com/Patrick-81/noctua/blob/master/docs/ARCHITECTURE.md)

Prochaine étape : ouvre [1 · Matériel — brancher et se connecter →]({{ site.baseurl }}{% link panneaux/01-hardware.md %})

