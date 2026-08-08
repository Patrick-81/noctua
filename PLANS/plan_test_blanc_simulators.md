# Chantier Test à blanc sur `indigo_server` + drivers simulateurs

## Objectif

Remplacer le **mock INDIGO maison** par l'écosystème réel **INDIGO 2.x** tourné
localement avec les **drivers simulateurs**, puis valider de bout en bout :
connexion, hardware, capture (BLOB → FITS), roue à filtres, séquence, monture.
C'est l'antichambre du ciel réel : le client garde le même protocole, seuls les
devices changent.

## Constats de préparation (session 2026-08-08)

- `indigo_server` **v2.0-374** installé (`/usr/bin/indigo_server`) ; les drivers
  simulateurs sont présents dans `/usr/bin` (le serveur les charge par nom au
  lancement) : `indigo_mount_simulator`, `indigo_ccd_simulator`,
  `indigo_rotator_simulator`, `indigo_dome_simulator`, `indigo_gps_simulator`.
- **Protocole vérifié** : le client XML brut sur TCP (`getProperties` au format
  AIN legacy) **répond correctement sur `indigo_server` 2.x**. Probe réelle sur
  port dédié : `defTextVector` / `defSwitchVector`… reçues (43 Ko de XML).
- Utiliser un **port dédié** pour les simulateurs afin de ne pas entrer en
  conflit avec un éventuel `indigo_server` réel tournant sur 7624.

## Démarrage du serveur simulateurs (validé)

```bash
indigo_server --port 17650 -v \
    indigo_mount_simulator indigo_ccd_simulator \
    indigo_rotator_simulator indigo_dome_simulator indigo_gps_simulator
```

Devices observés (noms réels) :
- `Mount Simulator`
- `CCD Imager Simulator` (caméra principale), `CCD Imager Simulator (wheel)`
  (roue du simulateur), `CCD Imager Simulator (focuser)`, `CCD Guider
  Simulator (…)`, `CCD Bahtinov Mask Simulator`, `DSLR Simulator`,
  `CCD File Simulator`
- `Field Rotator Simulator`, `Dome Simulator`, `GPS Simulator`

## Lancement de la pile web

```bash
python run.py 127.0.0.1:17650 --port 8080     # pointe l'app sur le serveur sim
# ou : config.yaml → indigo: {host: 127.0.0.1, port: 17650}
```

## Checklist à valider (prochaine session)

1. **Connexion** : le panneau Hardware liste les devices du serveur simulateurs.
2. **Profil** : créer un profil mappant les rôles sur les devices simulateurs
   (`profiles.yaml`), l'activer → toutes les devices passent en `CONNECTED`.
3. **Monture** : update/park, positions RA/Dec, goto simulé.
4. **Capture** : expose 1–3 s → BLOB reçu → FITS sauvegardé dans
   `~/asteo/captures/` (`save_dir`) avec nommage `capture_{filtre}_{ts}`.
5. **Filtres** : `CCD Imager Simulator (wheel)` fournit `FILTER_SLOT` ; le
   sélecteur « Filtre » s'alimente, et le changement de slot s'applique.
6. **Focuser** : `CCD Imager Simulator (focuser)` — déplacement absolu + mesure.
7. **Séquence** : run à blanc de 2 poses → progression, pause/resume, stop,
   reset ; gestion du dither selon le point ci-dessous.
8. **Guide** : pas de driver guide simulateur → vérifier que le mode Guide se
   comporte proprement (device absent / inactif).

## Points de vigilance à trancher

- **Mapping rôles → devices** : `wheel` et `focuser` sont des devices à part
  entière issus du même `indigo_ccd_simulator`. Vérifier que `registry.py`
  les sélectionne indépendamment de la caméra (pattern « matches_name »).
- **Dither sans guideur** : décider le comportement lorsque le guide est
  absent/inactif — dither bloquant (erreur) vs désactivé avec warning. Le
  config `sequence.dither.enabled` doit piloter ça.
- **secure WS push** : la bascule du poll 1 s `/api/sequence/status` vers une
  poussée WS reste ouverte ; le test à blanc est l'occasion d'en décider.
- **Port/Host** : confirmer le défaut d'écoute de `run.py` (localhost) pour ne
  pas exposer l'interface.

## Sortie attendue

- `run.py` connecté au serveur simulateurs : hardware listé, image capturée
  et sauvegardée, filtre switché, séquence courte exécutée de bout en bout.
- Rapport des écarts/bugs détectés → TODO backlog.
- Décision sur l'automatisation : script de test dédié
  (`tests/test_blanc_indigo.py`) et/ou flux Playwright contre le stack sim.