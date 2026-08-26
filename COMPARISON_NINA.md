# Comparaison fonctionnelle — indigo_devices vs NINA

Comparaison établie le 2026-08-25 à partir du code source des deux projets :
- `indigo_devices` : interface web (FastAPI + Vanilla JS) sur serveur INDIGO
- NINA (sources .NET sur orion : `/home/pat/Programmes/nina`)

## 1. Positionnement

| | **indigo_devices** | **NINA** |
|---|---|---|
| Nature | Web UI (FastAPI + JS vanilla) sur serveur INDIGO | Application desktop Windows (.NET/WPF) |
| Accès | Navigateur (mobile / remote-friendly) | Poste local ou RDP |
| Contrôle équipement | Mount, Camera, Focuser, FilterWheel via INDIGO TCP | ASCOM/INDIGO : Camera, Mount, Focuser, FilterWheel, Rotateur, Dôme, Switch, SafetyMonitor, Météo, FlatDevice |
| Guidage | **Natif complet** (calibration PHD2-style, graphe, SNR/RMS) | Externe (PHD2/MGEN/MetaGuide/SkyGuard/DirectGuider) |
| Mise en station | **Alignement polaire 3 points natif** | **Absent** (outils externes : SharpCap/PHD2) |
| Solveur | Seiza (hinté + blind) | ASTAP, Platesolve2/3, Astrometry.net, AllSky, PinPoint, TheSkyX |
| Séquencement | Séquenceur Nina-like multi-cibles | Advanced Sequencer (items, triggers, conditions, templates, containers) |
| Thème | Double thème : Noctua (cyan/teal) + Sobre (bleu-gris) | Thème sombre unique |
| Installation | Script multiplateforme (Linux/macOS/Windows) + pip | Installeur Windows (.msi) |
| Tests | Mock INDIGO + Playwright + pytest | NINA.Test (suite .NET) |

## 2. Comparaison par domaine

| Domaine | indigo_devices | NINA | Lacune |
|---|---|---|---|
| Monture | D-pad, goto, park, home, tracking, abort, recherche d'objets, site/heure | Tout + FindHome, coordinates instruction, AltAz | Mineure |
| Solveur / centrage | Solve hinté/blind, sync, centrage itératif automatique | Solve+sync, center, center&rotate | Multi-solveurs + rotateur |
| Polaire | **3 points natif** (fort) | — | **Avantage indigo_devices** |
| Guidage | Calibration native, étoile auto/manuelle, graphe 60s, RMS, SNR, tolérance, beep | Idem via PHD2 + **dither** | Dithering basique |
| Autofocus | V-curve HFR, scan complet | Plusieurs méthodes, temp-compensation, par filtre | Paramétrage avancé |
| Capture | Séquence d'expo, binning, gain/temp, sauvegarde, HFR overlay, histogramme | SmartExposure adaptatif, naming templates, image history, statistics, thumbnails | Session complète |
| Flats | Type de frame seulement | **FlatWizard automatisé** (SkyFlat, flat panel) | Critique imagerie |
| Filtres | FilterWheel INDIGO (détection + sélection) | Filter wheel + flats par filtre | Gestion avancée des offsets |
| Dither | Offset gaussien configurable | Oui (guider) + settle-check | Settle-check manquant |
| Meridian flip | Détection + exécution + session orchestrator | Trigger + containers dédiés | Pas intégré dans séquenceur |
| Darks/flats | Répertoires par frame type (lights/darks/flats/biases/) | FlatWizard + trained exposures | FlatWizard automatisé |
| Dôme/Rotateur/Switch/Météo/Safety | Non | Oui | Équipement manquant |
| Séquence/session | **Séquenceur multi-cibles** (ajouté) | **Séquenceur complet** (conditions altitude/lune/heure, triggers AF/flip/guider) | Triggers et conditions |
| Cibles/planning | Arbre catalogues dépliable (Messier, NGC, IC, Stars) | SkyAtlas, DSO containers, templates, target list | Planning avancé |
| Cadrage | Carte du ciel + FOV caméra | **Framing Assistant** (rectangles FOV, rotation) | Secondaire |
| Plugins | Non | Oui | Non pertinent |

## 3. Diagnostic — nécessité/importance des lacunes

Gradé selon deux usages : **A) contrôle web en direct** (portable/remote), **B) session autonome sans intervention**.

| Lacune | Importance A (live) | Importance B (autonome) | Verdict |
|---|---|---|---|
| **Triggers séquenceur** (AF auto, flip, conditions altitude/lune/heure) | Faible | **Critique** | Sans triggers, pas de nuit « hands-off ». |
| **Dither settle-check** | Faible | Importante | Indispensable au stacking propre. |
| **FlatWizard** (auto-exposition, sky flat) | Secondaire | Importante | Qualité d'image ; automatisable. |
| **Filtres avancés** (offsets par filtre, flat par filtre) | Importante | **Importante** | Un rig LRGB/NB sans gestion offsets = approximatif. |
| **Dôme / Météo / Safety** | Non | Non (obs permanente) | Hors cible portable. |
| **Rotateur + center&rotate** | Secondaire | Secondaire | Utile cadrage/rotation PA ; pas bloquant. |
| **Switch (chauffage anti-buée)** | Importante (hiver) | Importante | Petit ajout device, gros confort. |
| **Multi-solveurs (ASTAP…)** | Secondaire | Secondaire | Seiza suffit si fiable. |
| **Framing / templates / plugins / image history** | Secondaire | Secondaire | Nice-to-have, non critique. |

## 4. Feuille de route recommandée

- **P0** : ~~séquenceur minimal~~ **FAIT** (multi-cibles, étapes, filtres, dither, darks/flats par répertoire).
- **P1** : Triggers séquenceur (AF auto après N poses, flip auto, conditions altitude/lune), dither settle-check.
- **P1** : FlatWizard simple (auto-exposition par filtre).
- **P2** : Rotateur + solve&rotate, switchs, ASTAP en solveur secondaire.
- **P2** : Gestion avancée des filtres (offsets, flat par filtre, séquences de calibration).
- **Hors scope** : dôme/météo/safety/plugins.

## 5. Points forts à préserver

- **Alignement polaire 3 points natif** : absent de NINA.
- **Guidage/calibration autonomes** (PHD2-style intégré) : différenciation réelle.
- **Web** : accès distant sans installation, testable via mock (Playwright/pytest).
- **Multiplateforme** : Linux, macOS, Windows via scripts d'installation identiques.
- **Thème sobre** : interface professionnelle, sobre, accessible.

## 6. Évolution récente (août 2026)

| Ajout | Impact |
|---|---|
| Séquenceur Nina-like multi-cibles | Réduction majeure de l'écart sur le plan de session |
| Répertoires lights/darks/flats/biases | Organisation专业 des captures par type |
| Arbre catalogues dépliable | Navigation intuitive dans les catalogues (Messier, NGC, IC, Stars) |
| Double thème (Noctua + Sobre) | Confort visuel et accessibilité |
| Scripts d'installation multiplateforme | Facilite le déploiement from GitHub |
