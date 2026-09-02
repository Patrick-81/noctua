# Remarques — Noctua vs N.I.N.A.

*English version: [REMARKS_EN.md](docs/REMARKS_EN.md)*

Comparaison des fonctionnalités de Noctua (indigo_devices) avec N.I.N.A.
(nighttime-imaging), et évolutions envisagées.

> **Vérifié au 30/08/2026** contre le code (état `master` + working tree) :
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
   panneau capture — ADU cible, AUTO, filtre/binning). ✅ **Bibliothèque de
   masters faite (C1, 29/08)** : combine et associe bias/dark/flat par
   filtre/binning/température (voir Lot C1). Reste un raffinement : la
   **capture automatique de darks en fin de séquence** (item 16).

2. **Gestion météo (Weather)** — Aucun endpoint ni UI dédié. N.I.N.A. s'arrête /
   alerte sur capteurs (pluie, vent, nuages) pendant une séquence.

3. **Trigger Manager / actions conditionnelles** — ✅ **Fait (A2, 28/08)** :
   `indigo/devices/triggers.py` — événements de séquence (`frame_done`,
   `series_done`, `error`…) → actions configurables (log, script, mount_goto)
   avec conditions et templating. La séquence reste pilotée par
   `SequenceRunner` avec hooks conditionnels (voir Lot A2).

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

6. **Framing assistant complet** — ✅ **Fait (D3, 30/08)** : overlay FOV **rotatif**
   (rotation du senseur paramétrable, 0 = nord en haut), **bounding box de la
   cible** dessinée à sa taille angulaire réelle (`size_arcmin` du catalogue,
   orientée par l'angle de position + rotation), panneau **Framing** dédié en
   mode astrometry (FOV auto caméra/focale ou manuel, rotation 0–360° + boutons
   « Solve » (rotation du dernier plate solve) / « Nord ↑ », cible par nom/id ou
   RA/Dec avec boutons Définir/GOTO/✕, **fit-check** : la cible tient-elle dans
   le champ ?). Sélection depuis le panneau Target (catalogue) alimente
   automatiquement le cadrage.

7. **Planification cible/date** — ✅ **Fait (C2, 28/08)** : structure
   `<save_dir>/<cible>/<YYYY-MM-DD>/<HHMMSS>` (ou `capture_<TS>` sans cible),
   journal `journal.json` et reprise d'une séquence interrompue (voir Lot C2).

## Évolutions auxquelles tu n'aurais pas pensé

8. **Refocus automatique dépendant du temps/altitude** — ✅ **Fait (B3, 28/08)** :
   politique `sequence.refocus` (`interval_min`, `alt_trigger_deg`) avec V-curve
   HFR entièrement côté serveur (`refocus.py`, voir Lot B3).

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

11. **Sequence templates / presets réutilisables** — ✅ **Fait (C3, 28/08)** :
    plans nommés (L, RGB, Ha) partageables par export/import JSON (voir Lot C3).

12. **Mosaïque automatique** — ✅ **Fait (D1, 29/08)** : planification d'une
    grille N×M centrée sur la cible (`/api/mosaic/plan`, recouvrement 0–90 %,
    correction cos(dec)), extension du plan d'exposition à autant de tuiles
    (`MOSN`/`MOSROW`/`MOSCOL` dans l'entête FITS), déplacement automatique de
    la monture avec recentrage par solve entre les tuiles (`before_frame`) et
    aperçu de la grille sur la sky map.

13. **Vision / "Live view" avec stretch** — autostretch + histogramme déjà en
    place dans l'aperçu (curseur Noir, AUTO) ; **reste** : LUT narrowband
    (Ha/OIII/SII) et stretch sauvegardé par caméra. *Partiel — autostretch OK.*

14. **Journaling** — ✅ **Fait (C4, 29/08)** : métadonnées par pose écrites
    **dans l'entête FITS** des images (date/heure, cible, temps de pose, gain,
    offset, température senseur, binning, optique, site) — voir Lot C4.

15. **Alertes / notifications push** (webhook, Telegram, email) sur erreur /
    fin de nuit.

16. **Darks automatiques en fin de séquence** — ◐ **Partiel** : la bibliothèque
    de masters (C1, 29/08) permet de construire et réutiliser les darks ; la
    **capture automatique en fin de nuit** reste à faire.

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

> **Préalable** : les chantiers terminés (A1, A2, B3, C1–C4 dont le C3 du working
> tree) ont été committés le 29/08 (lots Lancés cochés ci-dessus).

### Lot A — Fiabiliser l'automatisation (fondations)

- [x] ~~**A1. Dithering piloté réellement par le guide**~~ — **FAIT (28/08)** :
  décalage serveur de la référence du guideur (`apply_dither`/`wait_settle`
  dans `guide.py`) + settle configurable (RMS ″ / timeout / stabilité),
  exposé dans l'UI séquenceur et les defaults de l'API. Reste un raffinement
  possible : dither via pulse monture direct (mode `pulse`) au lieu du seul
  shift de référence.
- [x] ~~**A2. Trigger Manager**~~ — **FAIT (28/08)** : `indigo/devices/triggers.py`
  (TriggerManager) émet des événements de séquence (`sequence_start`,
  `frame_start`, `frame_done`, `dither_done`, `error`, `series_done`, `stop`)
  vers des actions configurables — `log`, `script` (shell + timeout), et
  `mount_goto` (RA/DEC). Conditions optionnelles (p.ex. `frame_type`) et
  templating `{…}` des messages/commandes. Firing **non bloquant** (une action
  en échec ne casse jamais la séquence). UI/API : GET `/api/triggers/status` +
  POST `/api/triggers/test`. Hooké via `on_frame_start`/`on_error`/`on_end`
  dans `SequenceRunner`. **Socle des Lots B** (B2 branchera les alertes
  Telegram/webhook comme nouvelle action). Tests `tests/test_triggers.py` (12)
  + hooks dans `test_sequence.py` + couverture E2E dans `test_sequence_flow.py`
  → 219 pytest OK.

### Lot B — Supervision & sécurité

- [ ] **B1. Gestion météo** — **ÉCARTÉ** : le tour de contrôle Noctua n'a pas
  vocation à communiquer sur internet (décision au 28/08). Pas de drivers
  weather ni d'arrêt météo automatique.
- [ ] **B2. Alertes push** — **ÉCARTÉ** (idem B1 : rien ne sort vers internet —
  webhook/Telegram/email sans objet).
- [x] ~~**B3. Refocus auto**~~ — **FAIT (28/08)** : `indigo/devices/refocus.py`.
  Politique `RefocusPolicy` (`sequence.refocus` : `interval_min`,
  `alt_trigger_deg` — 0 = dimension désactivée) déclenchant aux poses LIGHT,
  entre deux poses, un refocus **entièrement côté serveur** : V-curve HFR via
  `run_autofocus()` (move focuser → pose courte → `focus_metrics` → `AutoFocus`
  machine → retour au meilleur point). La 1re pose enregistre la ligne de base
  (jamais de refocus surprise au départ) ; un échec (HFR non mesurable, timeout
  focuser) ne casse pas la séquence et retente après 5 min de cooldown. Brutal
  in-app : cases `seq-ref-*`, statut dans le panneau. Tests
  `tests/test_refocus.py` (11) → 230 pytest OK. **Suite → Lot C.**

### Lot C — Qualité & organisation

- [x] ~~**C1. Bibliothèque de masters**~~ — **FAIT (29/08)** :
  `indigo/devices/masters.py` (`MasterLibrary`) — combine les frames raw en
  masters de calibration (bias/dark/flat) catalogués par entête FITS normalisé
  : filtre, binning, température, exposition, NCOMBINE, provenance
  (instrument/téléviseur/site). Résolution : binning doit matcher, dark dans
  ±5 °C (jamais de master « chaud » hors tolérance) avec exposition préférée
  ≥ demandée, flat par filtre + binning. Endpoints `/api/masters`
  (GET status, POST build dir|files, resolve, delete, calibrate → injecte dans
  le livestack). Racine par défaut `sequence.save_dir`, surcharge
  `masters.dir`. Le Flat Wizard peut ainsi produire des flats automatiques
  réutilisables. Unitaires `tests/test_masters.py` (8) + smoke E2E HTTP.
- [x] ~~**C2. Planification cible/date + reprise**~~ — **FAIT (28/08)** : structure
  `<save_dir>/<slug-cible>/<YYYY-MM-DD>/<HHMMSS>` (sans cible → legacy
  `capture_<TS>`), journal `journal.json` (écriture atomique, `created_at`
  préservé) mis à jour à chaque pose ; bouton **Reprendre** (caché si session
  terminée) → `POST /api/sequence/resume-session` → le runner saute les poses
  faites (`start(frames, resume_from=done)`) et **continue les index de
  fichiers** (aucun écrasement), journal marqué `complete` à la fin. Helpers
  `slugify`/`build_session_dir`/`save_journal`/`load_journal` (unitaires) +
  flux cible/date et reprise → **237 pytest OK, flux séquence 55 OK**.
- [x] ~~**C3. Templates de séquence nommés**~~ — **FAIT (28/08)** :
  `indigo/devices/templates.py` (`SequenceTemplateStore`, YAML persistant,
  validation via `validate_frames`). Endpoints `/api/sequence/templates`
  (GET/list, POST upsert, delete, import, export) ; UI : rangée Templates
  (select + 💾 enregistrer / 🗑 / ⇪ export → presse-papiers / ⇓ import JSON
  collé). Plans réutilisables (L, RGB, Ha…) et partageables via
  `{version, exported_at, templates}`. Unitaires `tests/test_templates.py` +
  flux CRUD → **246 pytest OK, flux séquence 65 OK**.
- [x] ~~**C4. Journaling par cible**~~ — **FAIT (29/08)** : métadonnées **dans
  l'entête FITS des images** (`indigo/devices/fitsmeta.py`, réécriture binaire
  sans astropy, data conservée bit-identique). Mots-clés normalisés :
  IMAGETYP/DATE-OBS, cible (OBJECT, OBJTHOUR, OBJTDEC), pose (EXPTIME), capteur
  (INSTRUME, CCD-TEMP, SET-TEMP, PIXSIZE, GAIN, OFFSET, binning H/V), optique
  (FOCALLEN), télescope (TELESCOP), site (SITELAT/LONG/ELEV), provenance
  (SWCREATE). Injection branchée sur : sauvegarde séquence
  (`web/routers/sequence.py`), session livestack (`web/server.py`) et
  `/api/camera/save`. Valeurs manquantes (None/NaN/Inf) sautées, accents
  translittérés (ASCII FITS). Unitaires `tests/test_fitsmeta.py` (11) + checks
  entête dans le flux → **265 pytest OK, flux séquence 75 OK**.

### Lot D — Avancés (plus tard)

- [x] **D1.** Mosaïque automatique (découpe en tuiles enchaînées).
- [ ] **D2.** Dôme / abri roulant (rolloff roof).
- [x] **D3.** Framing assistant complet (orientation senseur, pivot, cadrage cible) — **FAIT (30/08)** : cf. manque 6. Panneau Framing dans le mode astrometry, overlay FOV rotatif + bounding box cible, fit-check, rotation auto depuis le solve.
- [ ] **D4. LUT narrowband** — **ÉCARTÉ (28/08)** : la composition couleur finale
  (palettes Ha/OIII/SII, étirements) relève du post-traitement (Siril
  ChannelCombination, PixInsight) sur les masters calibrés ; un aperçu
  false-color en direct ne compositerait qu'un seul filtre mono par pose.

### Ordre recommandé

A1 → A2 → B3 → ~~C2~~ → ~~C3~~ → ~~C4~~ → ~~C1~~ → Lot D.
(B1 météo et B2 alertes écartés — pas de communication internet.)
Dans le Lot D, **D1 (mosaïque)** fait au 29/08 et **D3 (framing assistant)** fait
au 30/08 ; D2 (dôme/roof) en retrait, D4 (LUT narrowband) écarté
(post-traitement).

---

*Revu le 30/08/2026.*