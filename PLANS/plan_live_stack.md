# Plan — Live stacking (moteur)

Intégrer un stacking temps réel dans Noctua, adossé au moteur **Seiza `LiveStacker`** (déjà une dépendance, v0.12).

## Objectif

Chaque frame LIGHT capturée (séquence ou capture manuelle) est poussée dans un `LiveStacker` :
- enregistrement (registration) automatique : alignement tolérant à la dérive entre frames,
- rejet des frames défaillantes (trop peu d'étoiles, dérive hors bornes) avec raison,
- cumul additif du stack (format float32 linéaire),
- aperçu live étiré (stretch) + sauvegarde d'un master final.

## Pipeline

```
frame FITS (séquence) ──▶ LiveStacker.push(frame)  ──▶ FrameDisposition (accept/reject)
                                          │
                                          └─▶ snapshot() ──▶ png (stretch) ──▶ WS "stacking"
```

## Calibration (masters)

- Masters bias/dark/flat construits via `Seiza.build_bias/dark/flat` à partir de dossiers de
  FITS (optionnel) ; appliqués avant `push`.
- Options du stacker : `normalization='global'`, `rejection='delta-sigma'` (défauts Seiza),
  `maximum_drift_fraction`, `maximum_drift_pixels`.

## Premier frame = référence

Le premier frame accepté devient la référence (`LiveStacker.from_array`) ; les suivants sont
enregistrés et alignés contre elle. Un reset repart de zéro.

## Intégration séquence

- Nouveau hook `stack(path)` injecté dans les hooks du `SequenceRunner` (parallèle à `save`),
  appelé après `save` quand le stacking est actif.
- L'exposition FITS fournie par la caméra (après BZERO/BSCALE) est déjà en mémoire Linéaire.

## API

- `GET  /api/stacking/status`  → états du pipeline (accepted, rejected, snapshot disponible)
- `POST /api/stacking/reset`    → repart à zéro (nouvelle référence)
- `POST /api/stacking/save`     → écrit le master FITS (ou PNG étiré) dans `save_dir`/stack
- `POST /api/stacking/configure` → met à jour les options (calibration dirs, seuils)

## UI (panneau « Stacking » / mode Capture)

- Aperçu live (image étirée) + compteurs `n = accepted/rejected`, dernière raison de rejet
- Boutons : reset, sauvegarde du master, activation du stacking dans la séquence

## Tests

- `tests/test_live_stack.py` : unitaires — ref≡ref acceptée, drift accepté, frame vide
  rejetée, calibration bias/dark/flat, options, snapshot.
- `tests/test_live_stack_flow.py` : mock INDIGO (mock_indigo) + séquence 3 frames →
  stack renvoyé au statut.
- `tests/live-stack-ui.spec.js` : Playwright — panneau, boutons, aperçu.

## Hors scope (v1)

- Composition LRGB/narrowband (`seiza.combine_lrgb` est disponible mais non requise pour la
  v1 mono-mono).
- Rejet de darks/flats en table (on gère surtout des LIGHT).
- Séparation automatique des sessions.