# @noctua/skymap

Moteur cartographique céleste **indépendant**, extrait de [Noctua](https://github.com/.../indigo_devices).
Projection orthographique **D3 v3** sur canvas HTML5, avec vue intérieure miroir est-gauche.

Package standalone, sans backend. Idéal pour réutilisation ou partage avec un autre projet.

## Démo rapide

```bash
cd packages/skymap
python3 -m http.server 18090
# → http://localhost:18090/index.html
```

## Installation

```bash
npm install @noctua/skymap
```

Le package n'a **aucune dépendance npm**. Il a besoin que **D3 v3.5.17** soit chargé
en global (fichier fourni dans `public/lib/d3.min.js`).

## Utilisation

```html
<script src="lib/d3.min.js"></script>            <!-- D3 v3 global -->
<script type="module">
    import { SkyEngine } from '@noctua/skymap';

    const engine = new SkyEngine(document.getElementById('map'), {
        siteLat: 48.85,
        siteLng: 2.35,
        siteElev: 35,
        dataBaseUrl: 'celestial-data/',            // base des JSON de catalogue
        onGoto:    (raH, decDeg, obj) => { /* pointer la monture */ },
        onSetTarget: (raDeg, decDeg) => { /* overlay astrométrie */ },
        i18n:      (key) => translations[key] ?? key,
    });

    engine.init();
    engine.setupContextMenu();            // menu clic droit (facultatif)
    await engine.loadCatalogs();
</script>
```

## API publique

| Méthode | Description |
|---------|-------------|
| `init()` | Crée le canvas, la projection, les gestes (drag/zoom). |
| `loadCatalogs()` | Charge les 5 catalogues depuis `dataBaseUrl`, puis rend. |
| `setTelPosition(raDeg, decDeg)` | Position télécopique courante (marqueur). |
| `centerOnTel()` / `centerOnObject(raDeg, decDeg)` | Centre la vue. |
| `highlightObject()` / `clearHighlight()` | Met en évidence / efface. |
| `setMosaicTiles(plan)` / `setMosaicCurrent(index)` | Grille de tuiles de mosaïque. |
| `search(query)` | Recherche dans les objets. |
| `updateSite(lat, lng, elev)` | Définit la station. |
| `setMagnitudeLimit(val)` / `setManualTime(date)` / `setRealTime()` | Limites / temps. |
| `setLayerVisibility(layer, visible)` | Active/désactive une couche. |
| `setCatalogVisibility(catalog, visible)` | Active/désactive un catalogue DSO. |
| `render()` | Redessine. |
| `destroy()` | Libère les timers. |

## Options du constructeur

| Option | Défaut | Description |
|--------|--------|-------------|
| `siteLat` / `siteLng` / `siteElev` | 43.95 / 1.56 / 210 | Position de la station. |
| `dataBaseUrl` | `/celestial-data/` | Préfixe des catalogues JSON. |
| `onGoto(raH, decDeg, obj)` | `null` | Handler du bouton GOTO du menu contextuel. |
| `onSetTarget(raDeg, decDeg)` | `null` | Handler du bouton « Définir cible ». |
| `i18n(key)` | identité | Traduction des libellés du menu. |

Sans `onGoto`/`onSetTarget`, les boutons correspondants sont inoffensifs (no-op).

## Couches

`milkyway`, `constellations`, `stars`, `dsos`, `planets`, `grid`, `equator`,
`ecliptic`, `meridian`, `horizon`.

## Données

Les catalogues (générés depuis les dumps stellaires) sont fournis dans
`public/celestial-data/` :

- `stars.8.json` — étoiles jusqu'à mag ~8
- `constellations.lines.json` — figures de constellations
- `mw.json` — bande de la Voie lactée (MultiPolygon)
- `dsos.6.bright.json` — objets du ciel profond brillants
- `planets.json` — éléments orbitaux planétaires

## Structure

```
src/sky-engine.js      Moteur (export: SkyEngine)
src/sky-projection.js  Maths de projection pures, zéro dépendance
src/skymap.css         Styles minimaux du moteur
public/lib/d3.min.js   D3 v3.5.17 (global)
public/celestial-data/ Catalogues JSON
index.html             Démo standalone
```
