# Plan : D3-Celestial + États busy monture

## Problèmes

1. **Carte du ciel** : orientation Est/Ouest inversée, l'utilisateur veut passer à D3-celestial
2. **Monture busy** : pas d'indicateur d'occupation pendant park/home, les boutons restent actifs

---

## Phase 1 : Remplacer sky-canvas.js par D3-celestial

### Dépendances CDN (D3 v3 uniquement, PAS v4+)
```html
<script src="https://d3js.org/d3.v3.min.js"></script>
<script src="https://d3js.org/d3.geo.projection.v0.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/celestial.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/celestial.css">
```

### Données
Utiliser les fichiers du CDN comme `datapath` :
```
https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/
```
Ou les copier dans `public/catalogs/` pour un fonctionnement local.

### Fichiers à modifier

#### `web/static/index.html`
- Ajouter les 3 balises `<script>` CDN (D3 v3, d3.geo.projection, d3-celestial)
- Ajouter le `<link>` CSS d3-celestial
- Le `<div id="sky-chart">` existant servira de container

#### `web/static/sky-canvas.js` → `web/static/celestial-wrapper.js` (nouveau)
Wrapper qui encapsule D3-celestial avec l'API projet :
- `display(config)` — initialisation avec projection stéréographique, geopos, datapath
- `setTelPosition(raDeg, decDeg)` — dessine le réticule télescope via `Celestial.add()` + canvas
- `centerOnTel()` — recentre la carte sur le télescope
- `search(query)` — recherche d'objets (utilise les catalogues D3-celestial)
- `redraw()` — force le rafraîchissement
- Gestion du FOV caméra via `Celestial.add()`
- Gestion de l'horizon via config `horizon`

#### `web/static/app.js`
- Remplacer `import { SkyCanvas } from '/sky-canvas.js'` par `import { CelestialWrapper } from '/celestial-wrapper.js'`
- Adapter `initSkyCanvas()` pour utiliser la nouvelle API
- Adapter `updateCameraFov()` pour le nouveau wrapper
- Adapter le panneau de recherche d'objets
- Implémenter le clic GOTO sur la carte (via `Celestial.mapProjection.invert()`)
- Implémenter le menu contextuel GOTO

#### `web/static/style.css`
- Ajuster le conteneur #sky-chart pour D3-celestial
- Le CSS de d3-celestial sera chargé via CDN

### Configuration D3-celestial
```javascript
Celestial.display({
    container: "sky-chart",
    datapath: "/catalogs/",  // ou CDN
    projection: "stereographic",
    transform: "equatorial",
    center: [raDeg, decDeg, 0],  // [RA°, Dec°, orientation]
    orientationfixed: true,
    geopos: [latitude, longitude],
    follow: null,
    zoomlevel: null,
    zoomextend: 10,
    adaptable: true,
    interactive: true,
    controls: false,
    stars: { show: true, limit: 6, colors: true, size: 5 },
    dsos: { show: true, limit: 6 },
    constellations: { show: true, names: true },
    mw: { show: true },
    horizon: { show: true, stroke: "#cccccc", fill: "#000", opacity: 0.3 },
    lines: {
        graticule: { show: true },
        equatorial: { show: true },
        ecliptic: { show: false },
        galactic: { show: false }
    }
});
```

### Marqueur télescope (via Celestial.add)
```javascript
Celestial.add({
    type: "json",
    redraw: function() {
        if (Celestial.clip([telRaDeg, telDecDeg])) {
            var pt = Celestial.mapProjection([telRaDeg, telDecDeg]);
            var ctx = Celestial.context;
            // Croix verte
            ctx.strokeStyle = "#00ff00";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pt[0] - 12, pt[1]);
            ctx.lineTo(pt[0] + 12, pt[1]);
            ctx.moveTo(pt[0], pt[1] - 12);
            ctx.lineTo(pt[0], pt[1] + 12);
            ctx.stroke();
            // Cercle
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 8, 0, 2 * Math.PI);
            ctx.stroke();
        }
    }
});
```

### GOTO par clic
```javascript
var canvas = document.querySelector("#sky-chart canvas");
canvas.addEventListener("click", function(e) {
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var coords = Celestial.mapProjection.invert([x, y]);
    if (coords) {
        var ra_hours = coords[0] / 15;
        var dec_deg = coords[1];
        // Appeler l'API GOTO
        apiPost('/api/mount/slew', { ra_hours: ra_hours, dec_deg: dec_deg });
    }
});
```

### Suppression
- Supprimer `web/static/sky-canvas.js` (ou garder en backup)
- Les catalogues JSON dans `public/catalogs/` peuvent être gardés pour d'autres usages ou supprimés si D3-celestial gère tout

---

## Phase 2 : États busy monture (park/home)

### Fichiers à modifier

#### `indigo/devices/mount.py`
1. Ajouter champ `self.homing: bool = False`
2. Ajouter méthode `home()` :
   ```python
   async def home(self) -> None:
       home_prop = self._resolve_prop_name("MOUNT_HOME")
       if home_prop in self._properties:
           self.homing = True
           await self.send_switch(home_prop, [{"name": "GO", "value": True}])
   ```
3. Modifier `_parse_park()` pour lire `pv.state` :
   ```python
   def _parse_park(self, pv: PropertyVector) -> None:
       state = pv.state.lower() if pv.state else ""
       self.park_state = state  # "ok", "busy", "alert"
       for name in ("PARKED", "PARK"):
           item = pv.get_item(name)
           if item is not None:
               val = str(item.value).lower()
               self.parked = val in ("on", "true", "1", "enabled")
               return
   ```
4. Ajouter `_apply_def` handler pour `MOUNT_HOME` :
   ```python
   elif name in ("MOUNT_HOME", "TELESCOPE_HOME"):
       self.homing = pv.state.lower() == "busy" if pv.state else False
   ```
5. Modifier `state_dict()` pour inclure :
   ```python
   "park_state": self.park_state,
   "homing": self.homing,
   ```

#### `web/server.py`
1. Ajouter endpoint `/api/mount/home` :
   ```python
   @app.post("/api/mount/home")
   async def mount_home():
       m = self.registry.get_mount()
       if not m:
           return {"error": "no mount"}
       await m.home()
       return {"ok": True}
   ```

#### `web/static/app.js`
1. Modifier `mountHome()` pour appeler `/api/mount/home` au lieu du setter générique :
   ```javascript
   function mountHome() {
       apiPost('/api/mount/home');
   }
   ```
2. Modifier `renderMountPanel()` pour :
   - Afficher un badge "PARKING" (pulsant) quand `park_state === "busy"`
   - Afficher un badge "HOMING" (pulsant) quand `homing === true`
   - Désactiver les boutons Park/Unpark/Home quand la monture est busy

#### `web/static/index.html`
1. Ajouter badge PARKING/HOMING :
   ```html
   <span id="mount-park-busy" class="badge badge-busy" style="display:none">PARKING</span>
   <span id="mount-home-busy" class="badge badge-busy" style="display:none">HOMING</span>
   ```

---

## Ordre d'exécution
1. Phase 2 d'abord (plus simple, indépendant)
2. Phase 1 ensuite (changement majeur)

## Vérification
- Tester la carte avec D3-celestial (orientation correcte, objets affichés, clic GOTO)
- Tester park → badge PARKING visible → badge UNPARKED quand terminé
- Tester home → badge HOMING visible → badge disparait quand terminé
- Vérifier que les boutons sont désactivés pendant les opérations
