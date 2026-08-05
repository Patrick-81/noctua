# Comparaison fonctionnelle — indigo_devices vs NINA

Comparaison établie le 2026-08-04 à partir du code source des deux projets :
- `indigo_devices` : interface web (FastAPI + Vanilla JS) sur serveur INDIGO
- NINA (sources .NET sur orion : `/home/pat/Programmes/nina`)

## 1. Positionnement

| | **indigo_devices** | **NINA** |
|---|---|---|
| Nature | Web UI (FastAPI + JS vanilla) sur serveur INDIGO | Application desktop Windows (.NET/WPF) |
| Accès | Navigateur (mobile / remote-friendly) | Poste local ou RDP |
| Contrôle équipement | Mount, Camera, Focuser via INDIGO TCP | ASCOM/INDIGO : Camera, Mount, Focuser, FilterWheel, Rotateur, Dôme, Switch, SafetyMonitor, Météo, FlatDevice |
| Guidage | **Natif complet** (calibration PHD2-style, graphe, SNR/RMS) | Externe (PHD2/MGEN/MetaGuide/SkyGuard/DirectGuider) |
| Mise en station | **Alignement polaire 3 points natif** | **Absent** (outils externes : SharpCap/PHD2) |
| Solveur | Seiza (hinté + blind) | ASTAP, Platesolve2/3, Astrometry.net, AllSky, PinPoint, TheSkyX |
| Séquencement | Aucun | Advanced Sequencer (items, triggers, conditions, templates, containers) |
| Tests | Mock INDIGO + Playwright + pytest | NINA.Test (suite .NET) |

## 2. Comparaison par domaine

| Domaine | indigo_devices | NINA | Lacune |
|---|---|---|---|
| Monture | D-pad, goto, park, home, tracking, abort, recherche d'objets, site/heure | Tout + FindHome, coordinates instruction, AltAz | Mineure |
| Solveur / centrage | Solve hinté/blind, sync, centrage itératif automatique | Solve+sync, center, center&rotate | Multi-solveurs + rotateur |
| Polaire | **3 points natif** (fort) | — | **Avantage indigo_devices** |
| Guidage | Calibration native, étoile auto/manuelle, graphe 60s, RMS, SNR, tolérance, beep | Idem via PHD2 + **dither** | Dithering |
| Autofocus | V-curve HFR, scan complet | Plusieurs méthodes, temp-compensation, par filtre | Paramétrage avancé |
| Capture | Séquence d'expo, binning, gain/temp, sauvegarde, HFR overlay, histogramme | SmartExposure adaptatif, naming templates, image history, statistics, thumbnails | Session complète |
| Flats | Type de frame seulement | **FlatWizard automatisé** (SkyFlat, flat panel) | Critique imagerie |
| Filtres | **Aucun** | Filter wheel + flats par filtre | Équipement manquant |
| Dither | Non | Oui (guider) | Oui |
| Meridian flip | Non | Trigger + containers dédiés | Oui |
| Dôme/Rotateur/Switch/Météo/Safety | Non | Oui | Équipement manquant |
| Séquence/session | Manuel (workflow à la main) | **Séquenceur complet** (conditions altitude/lune/heure, triggers AF/flip/guider) | **La plus grande** |
| Cibles/planning | Recherche DSO + goto | SkyAtlas, DSO containers, templates, target list | Planning |
| Cadrage | Carte du ciel + FOV caméra | **Framing Assistant** (rectangles FOV, rotation) | Secondaire |
| Plugins | Non | Oui | Non pertinent |

## 3. Diagnostic — nécessité/importance des lacunes

Gradé selon deux usages : **A) contrôle web en direct** (portable/remote), **B) session autonome sans intervention**.

| Lacune | Importance A (live) | Importance B (autonome) | Verdict |
|---|---|---|---|
| **Séquenceur** (cible→centre→AF→guide→capture en boucle) | Faible | **Critique** | Cœur de NINA. Sans lui, pas de nuit « hands-off ». Lacune structurante. |
| **Meridian flip** | Faible | **Critique** | Toute session > méridien casse sans flip automatique. |
| **Filtres + flats par filtre** | Importante (LRGB/NB) | **Critique** | Un rig d'imagerie sans roue à filtres est l'exception. |
| **Dither** | Faible | **Importante** | Indispensable au stacking (bruit de pattern), trivial une fois le guidage en place. |
| **Darks/flats automatisés (FlatWizard)** | Secondaire | Importante | Qualité d'image ; automatisable (SkyFlat/crépuscule). |
| **Dôme / Météo / Safety** | Non | Non (obs permanente) | Hors cible portable ; inutile ici. |
| **Rotateur + center&rotate** | Secondaire | Secondaire | Utile cadrage/rotation PA ; pas bloquant. |
| **Switch (chauffage anti-buée)** | Importante (hiver) | Importante | Petit ajout device, gros confort. |
| **Multi-solveurs (ASTAP…)** | Secondaire | Secondaire | Seiza suffit si fiable ; ASTAP = fallback vitesse. |
| **Framing / templates / plugins / image history** | Secondaire | Secondaire | Nice-to-have, non critique. |

## 4. Feuille de route recommandée

- **P0** : séquenceur minimal (file d'étapes : GOTO→solve/centre→AF→guidage→N captures→suivante) + **meridian flip**.
- **P1** : device **FilterWheel** (INDIGO la fournit), dithering, FlatWizard simple.
- **P2** : rotateur + solve&rotate, switchs, ASTAP en solveur secondaire.
- **Hors scope** : dôme/météo/safety/plugins.

## 5. Points forts à préserver

- **Alignement polaire 3 points natif** : absent de NINA.
- **Guidage/calibration autonomes** (PHD2-style intégré) : différenciation réelle.
- **Web** : accès distant sans installation, testable via mock (Playwright/pytest).
