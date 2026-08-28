# Remarques — Noctua vs N.I.N.A.

Comparaison des fonctionnalités de Noctua (indigo_devices) avec N.I.N.A.
(nighttime-imaging), et évolutions envisagées.

> **Vérifié au 28/08/2026** contre le code (état `master` + working tree) :
> les statuts ci-dessous (fait / pas commencé) sont à jour. Les manques restants
> le sont réellement (cf. section « Prochaine suite » pour l'ordre proposé).

## Ce que Noctua couvre déjà bien

- **Séquence de captures** : multi-frames LIGHT, poses par filtre, dithering
  (hook `dither()` dans `SequenceRunner`), délais entre frames, stacking live en
  parallèle, planification. C'est le cœur qui rivalise correctement avec N.I.N.A.
- **Autofocus** : autofocus HFR parabolique (fit + V-curve), pas d'autofocus,
  plage de recherche.
- **Autoguidage** : calibration 4 phases (EW/NS avec retour), métriques de qualité
  (orthogonalité, angle caméra), guiding en boucle.
- **Mise en station polaire** (polar.js), **plate solve** (astrométrie),
  **sky map D3 interactif**.
- **Stacking live** temps réel (Seiza), contrôle hardware, profils.

## Manques majeurs vs N.I.N.A. (à implémenter)

1. **Flat Wizard & bibliothèque de darks/flats/biases** — ✅ **Flat Wizard fait**
   (machine à états `flat_wizard.py`, endpoints `camera.py`, UI repliable dans le
   panneau capture — ADU cible, AUTO, filtre/binning). Point restant : la
   **bibliothèque de masters** (association auto dark/flat par filtre/binning/
   température) n'est pas faite.

2. **Gestion météo (Weather)** — Aucun endpoint ni UI dédié. N.I.N.A. s'arrête /
   alerte sur capteurs (pluie, vent, nuages) pendant une séquence.

3. **Trigger Manager / actions conditionnelles** — Aucun système
   "sur événement de séquence" (fin de pose, erreur) → action (script,
   notification, changement de cible). La séquence est linéaire
   (`sequence.py:76`) sans hooks conditionnels.

4. **Meridian flip automatique dans la séquence** — ✅ **Fait** : hook
   `before_frame` dans `SequenceRunner._run_one`, flip auto (marge post-méridien
   via `hour_angle_margin`), anti-re-flip, et **récentrage par solve itératif**
   (`_recenter_by_solve`) avec reprise bloquante. Voir « Chantiers en cours ».

5. **Pointing model / modèle d'erreur de pointage** — Un modèle correcteur
   **local** (IDW) existe déjà (`indigo/devices/pointing.py`) : échantillons
   `(ra, dec, delta_ra, delta_dec)` collectés automatiquement à chaque recentrage
   par solve (frontend `target.js` + serveur post-flip), correction interpolée
   appliquée aux GOTO. Le gap face à N.I.N.A. est le **modèle paramétrique
   multi-termes** (voir analyse détaillée ci-dessous).

   ### Analyse détaillée — modèle d'erreur de pointage

   **Ce qui existe (collecte + application OK)**
   - `PointingModel.correct()` (IDW, `pointing.py:62`) : moyenne pondérée par
     distance sur les échantillons voisins. Correct pour lisser le bruit **près**
     d'un échantillon.
   - Alimentation automatique : `_recordPointingSample()` (`target.js:97`) à
     chaque recentrage, et `_recenter_by_solve` (serveur) après flip.
   - Application : `_applyPointingCorrection()` (`target.js:116`) sur chaque
     GOTO si la case « appliquer aux GOTO » est coché. Points forts conservés.

   **Le vrai gap (ce que N.I.N.A. fait en plus)**
   L'IDW est **purement local** : il ne généralise pas au-delà du voisinage des
   échantillons, ne sépare pas les erreurs **systématiques** (reproductibles, à
   corriger) des erreurs **aléatoires** (seeing, à ne pas mémoriser), et chaque
   nouvel échantillon ne « propage » rien ailleurs. N.I.N.A. ajuste un modèle
   global qui décrit l'erreur systématique en fonction de la position.

   **Résultat — modèle paramétrique réalisé ✓**
   - `pointing.py` : fit moindres carrés (numpy) des termes systématiques,
     `_predict()`, et `correct()` = **modèle + IDW(résidus)** (généralise hors du
     nuage, précis à proximité). Fallback IDW pur si < 6 échantillons.
   - `status()` expose `model_fit` (actif, nb d'étoiles, RMS, coefs, labels).
   - Endpoint `POST /api/pointing/fit` + bouton UI « ⌘ Ajuster le modèle »
     (affichage coefs/RMS/nb étoiles) ; `_applyPointingCorrection` applique la
     correction combinée via `/correct`.
   - Tests : reconstitution des coefs sur échantillons synthétiques,
     généralisation hors-nuage, RMS, fallback, endpoint, clear (7 tests).

   **Min viable à garder** : collecte auto + IDW restent le fallback sûr ; le
   modèle paramétrique n'active la correction `model + résidu` que lorsqu'on a
   assez d'échantillons (ex. ≥ 6) pour un fit significatif.

## Manques intermédiaires

6. **Framing assistant complet** — L'overlay FOV existe (`_renderCameraFov`),
   mais pas l'assistant de cadrage (adapter le champ à la cible, pivot par angle,
   rotation du senseur). *Pas commencé.*

7. **Planification cible/date** — `build_path` range par type + timestamp
   (`_20260827_...`), mais sans structure `target/date/`. Pas de reprise d'une
   séquence interrompue. *Pas commencé.*

## Évolutions auxquelles tu n'aurais pas pensé

8. **Refocus automatique dépendant du temps/altitude** — politique
   "refocus après X min / X° d'altitude" (N.I.N.A. refocalise selon température
   / élévation).

9. ~~**Dithering piloté réellement par le guide**~~ — **FAIT (A1, 28/08)** :
   `apply_dither()` dans `guide.py` décale la référence du guideur (= pulse de
   la monture via ses corrections) puis attend le **settle** (`wait_settle()`,
   résidu RMS < `settle_rms` sur N échantillons, timeout) avant la pose
   suivante. Config `sequence.dither` : `amount` (px), `settle_rms` (″),
   `settle_timeout` (s), `settle_stable`. UI dans le séquenceur (inputs Settle)
   + statut `last_dither.settle` affiché après chaque pose. Tests
   `tests/test_dither.py` (11), 205 pytest OK.

10. **Dôme / abri roulant (rolloff roof) automation** — contrôle des toits
    automatiques pour installation non supervisée.

11. **Sequence templates / presets réutilisables** — plans nommés (L, RGB, Ha)
    partageables.

12. **Mosaïque automatique** — découpe de cibles trop larges en tuiles enchaînées.

13. **Vision / "Live view" avec stretch** — autostretch + histogramme déjà en
    place dans l'aperçu (curseur Noir, AUTO) ; **reste** : LUT narrowband
    (Ha/OIII/SII) et stretch sauvegardé par caméra. *Partiel — autostretch OK.*

14. **Journaling** — log des poses par cible avec métadonnées (settle, seeing,
    température du senseur) pour analyse qualité.

15. **Alertes / notifications push** (webhook, Telegram, email) sur erreur /
    fin de nuit.

16. **Darks automatiques en fin de séquence** — capture + réutilisation des
    darks nécessaires.

---

## Chantiers en cours

- **Flat Wizard** — ✅ **Terminé** : machine à états `flat_wizard.py`, endpoints
  `camera.py`, UI repliable dans le panneau capture (ADU cible, AUTO, filtre/binning).
- **Meridian flip automatique** — ✅ **Terminé** : hook `before_frame` dans la
  séquence + flip auto + réarmement anti-re-flip. **Récentrage par solve itératif**
  intégré (`_recenter_by_solve`, serveur, ≤ 3 passes) avec **reprise bloquante** :
  `_do_meridian_flip` renvoie `flipped` et attend la fin flip+récentrage avant la
  pose suivante.
- **Pointing model** — ✅ **Renforcé** : modèle **paramétrique global** (fit
  moindres carrés : index, cone `sin(dec)`, ortho/flexure `sin/cos(ra)·cos(dec)`)
  combiné au **résidu IDW** dans `correct()`. Endpoint `/api/pointing/fit` +
  bouton UI « Ajuster le modèle » (coefs/RMS/étoiles). Alimentation auto par
  recentrages (frontend + post-flip). Fallback IDW pur (< 6 échantillons).

## Évolutions ajoutées cette session

- **Visibilité 24h à la sélection de cible** : popup ouvert sur `setTargetObject`
  avec `GET /api/visibility` → courbe d'altitude 24h (SVG), lever/transit/coucher,
  fenêtre d'observabilité ; enrichissement catalogue (Messier/NGC/Bright Star/
  Sharpless) : mag, **magnitude surfacique calculée** (mag + taille), taille, type,
  constellation. 14 tests.

---

## Prochaine suite (planifiée le 28/08/2026)

> **Préalable** : committer les chantiers terminés encore dans le working tree
> (meridian flip + recentrage, pointing model, Flat Wizard, visibilité 24h) avant
> d'entamer la suite.

### Lot A — Fiabiliser l'automatisation (fondations)

- ~~**A1. Dithering piloté réellement par le guide**~~ — **FAIT (28/08)** :
  décalage serveur de la référence du guideur (`apply_dither`/`wait_settle`
  dans `guide.py`) + settle configurable (RMS ″ / timeout / stabilité),
  exposé dans l'UI séquenceur et les defaults de l'API. Reste un raffinement
  possible : dither via pulse monture direct (mode `pulse`) au lieu du seul
  shift de référence.
- **A2. Trigger Manager** — hooks d'événements de séquence (fin de pose,
  fin de série, erreur) → actions configurables (script, pointage, notification).
  **C'est le socle des Lots B.**

### Lot B — Supervision & sécurité

- **B1. Gestion météo** — drivers INDIGO weather (pluie, vent, nuages), seuils,
  arrêt propre de la séquence + alerte.
- **B2. Alertes push** — webhook / Telegram / email sur erreur et fin de nuit
  (branché sur le Trigger Manager).
- **B3. Refocus auto** — politique temps / variation d'altitude (réutilise
  l'autofocus HFR existant, hook dans la séquence).

### Lot C — Qualité & organisation

- **C1. Bibliothèque de masters** — association auto dark/flat par
  filtre/binning/température (complète le Flat Wizard ; le master livestack
  existe déjà).
- **C2. Planification cible/date + reprise** — structure `target/date/`,
  journal de progression, reprise d'une séquence interrompue.
- **C3. Templates de séquence nommés** — plans réutilisables (L, RGB, Ha) et
  partageables.
- **C4. Journaling par cible** — métadonnées par pose (settle, seeing/HFR,
  température senseur) pour analyse qualité.

### Lot D — Avancés (plus tard)

- **D1.** Mosaïque automatique (découpe en tuiles enchaînées).
- **D2.** Dôme / abri roulant (rolloff roof).
- **D3.** Framing assistant complet (orientation senseur, pivot, cadrage cible).
- **D4.** LUT narrowband (Ha/OIII/SII).

### Ordre recommandé

A1 → A2 → B2 (peut se faire tôt grâce à A2) → B1 → B3 → C1 → C2 → C3 → C4 → Lot D.

---

*Revu le 28/08/2026.*
