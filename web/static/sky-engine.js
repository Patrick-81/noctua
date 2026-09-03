/**
 * sky-engine.js — Moteur cartographique céleste.
 *
 * Projection orthographique D3 v3 sur canvas HTML5.
 * Couche de rendu pour indigo_devices.
 *
 * API publique (compatible CelestialWrapper) :
 *   init()
 *   loadCatalogs()
 *   setTelPosition(raDeg, decDeg)
 *   centerOnTel()
 *   centerOnObject(raDeg, decDeg)
 *   highlightObject(raDeg, decDeg, id)
 *   clearHighlight()
 *   search(query)
 *   updateSite(lat, lng, elev)
 *   setMagnitudeLimit(val)
 *   setManualTime(date)
 *   setRealTime()
 *   render()
 *   destroy()
 */

import {
    buildStarVectors,
    projectStars,
} from '/sky-projection.js';

export class SkyEngine {
    constructor(container, options = {}) {
        this.container = container;
        this.siteLat = options.siteLat ?? 43.952;
        this.siteLng = options.siteLng ?? 1.568;
        this.siteElev = options.siteElev ?? 210;

        this.followMode = false;
        this.slewing = false;
        this.cameraFovX = 0;
        this.cameraFovY = 0;
        this.cameraRotDeg = 0;           // rotation du senseur (0 = nord en haut)
        this.cameraTarget = null;        // { ra, dec, size_arcmin:[maj,min], pa, name }
        this.mosaicTiles = null;
        this.hideNorth = false;
        this.hideSouth = false;

        this._objects = [];
        this._telRaDeg = null;
        this._telDecDeg = null;
        this._highlight = null;
        this._initialized = false;
        this._mapReady = false;

        this._maxMagnitude = 6.0;
        this._currentRotation = [0, 0, 0];
        this._manualOffsetRA = 0;
        this._decOffset = 0;
        this._lockRA = false;
        this._lockDEC = false;
        this._parallacticAngleDeg = 0;
        this._timeMode = 'realtime';
        this._manualDate = new Date();
        this._realtimer = null;
        this._renderRequested = false;

        this._canvas = null;
        this._ctx = null;
        this._projection = null;
        this._pathGenerator = null;
        this._graticule = null;

        this._starsData = null;
        this._constellationsData = null;
        this._milkywayData = null;
        this._dsosData = null;
        this._planetsData = null;
        this._starVectors = null;      // vecteurs unitaires triés par magnitude
        this._dsoCache = null;         // { key, items: [{x, y, name}] }
        this._MAX_DRAW_STARS = 7000;

        // Layer visibility
        this.layers = {
            milkyway: true,
            constellations: true,
            stars: true,
            dsos: true,
            planets: true,
            grid: true,
            equator: true,
            ecliptic: true,
            meridian: true,
            horizon: true,
        };

        // DSO catalog visibility
        this.catalogs = {
            messier: true,
            ngc: true,
            ic: true,
            caldwell: true,
            sh2: true,
            ldn: true,
            ced: true,
            vdb: true,
            lbn: true,
            rcw: true,
            snr: true,
            cr: true,
            other: true,
        };

        this._width = 0;
        this._height = 0;
        this._scale = 0;
    }

    // ═══════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════

    init() {
        this._width = window.innerWidth;
        this._height = window.innerHeight;
        this._scale = Math.min(this._width, this._height) * 0.42;

        this._canvas = d3.select(this.container).append("canvas")
            .attr("width", this._width)
            .attr("height", this._height);
        this._ctx = this._canvas.node().getContext("2d");

        this._projection = d3.geo.orthographic()
            .scale(this._scale)
            .translate([this._width / 2, this._height / 2])
            .clipAngle(90)
            .rotate(this._currentRotation);

        this._projection = this._wrapMirrored(this._projection);

        this._pathGenerator = d3.geo.path().projection(this._projection).context(this._ctx);
        this._graticule = d3.geo.graticule().step([15, 10]);

        // Géométries fixes en coordonnées RA/Dec : calculées une seule fois,
        // la rotation LST est appliquée par la projection à chaque rendu.
        // Note : l'horizon dépend du LST et est donc recalculé dans render().
        this._cachedGraticule = this._graticule();
        this._cachedEquator = this._getCelestialEquator();
        this._cachedEcliptic = this._getEcliptic();

        this._setupDrag();
        this._setupZoom();
        this._setupResize();
        this._startSiderealSync();
        this._initialized = true;

        window.addEventListener('resize', () => this._onResize());
    }

    _wrapMirrored(raw) {
        const self = this;
        const mirrored = function(coords) {
            const pt = raw(coords);
            if (pt) pt[0] = self._width - pt[0];
            return pt;
        };
        mirrored.stream = function(listener) {
            const s = raw.stream(listener);
            return {
                point: function(x, y) { s.point(self._width - x, y); },
                lineStart: function() { s.lineStart(); },
                lineEnd: function() { s.lineEnd(); },
                polygonStart: function() { s.polygonStart(); },
                polygonEnd: function() { s.polygonEnd(); },
                sphere: function() { s.sphere(); }
            };
        };
        mirrored.invert = function(pt) {
            if (!pt) return null;
            return raw.invert([self._width - pt[0], pt[1]]);
        };
        // déléguer les setters/getters D3
        ['rotate','scale','translate','clipAngle','precision','clipExtent'].forEach(k=>{
            if (typeof raw[k] === 'function') {
                mirrored[k] = function(v) {
                    if (!arguments.length) return raw[k]();
                    raw[k](v);
                    return mirrored;
                };
            }
        });
        return mirrored;
    }

    async loadCatalogs() {
        const load = (url) => fetch(url).then(r => r.json()).catch(() => null);

        const [stars, consts, mw, dsos, planets] = await Promise.all([
            load('/celestial-data/stars.8.json'),
            load('/celestial-data/constellations.lines.json'),
            load('/celestial-data/mw.json'),
            load('/celestial-data/dsos.6.bright.json'),
            load('/celestial-data/planets.json'),
        ]);

        this._starsData = stars;
        if (stars && stars.features) {
            this._starVectors = buildStarVectors(stars.features);
        }
        this._constellationsData = consts;
        this._milkywayData = this._decimateMilkyway(mw);
        this._dsosData = dsos;
        this._planetsData = planets;
        this._mapReady = true;
        this.render();
    }

    _decimateMilkyway(data) {
        if (!data || !Array.isArray(data.features)) return data;
        const cap = 40;
        const decimate = (ring) => {
            const n = ring.length;
            if (n <= cap) return ring;
            const stride = (n - 1) / (cap - 1);
            const out = [];
            for (let i = 0; i < cap - 1; i++) out.push(ring[Math.round(i * stride)]);
            out.push(ring[n - 1]);
            return out;
        };
        for (const feature of data.features) {
            const polys = feature.geometry && feature.geometry.coordinates;
            if (!polys) continue;
            for (const poly of polys) {
                for (let i = 0; i < poly.length; i++) poly[i] = decimate(poly[i]);
            }
        }
        return data;
    }

    setLayerVisibility(layer, visible) {
        if (layer in this.layers) {
            this.layers[layer] = visible;
            this.render();
        }
    }

    setCatalogVisibility(catalog, visible) {
        if (catalog in this.catalogs) {
            this.catalogs[catalog] = visible;
            this.render();
        }
    }

    setRotationLock(axis, locked) {
        if (axis === 'ra') this._lockRA = locked;
        if (axis === 'dec') this._lockDEC = locked;
    }

    _dsoHasCatalog(dso) {
        const desig = (dso.properties?.desig || dso.id || '').toUpperCase();
        if (desig.startsWith('M ') || desig === 'M') return this.catalogs.messier;
        if (desig.startsWith('NGC')) return this.catalogs.ngc;
        if (desig.startsWith('IC')) return this.catalogs.ic;
        if (desig.startsWith('SH2') || desig.startsWith('SH 2') || desig.startsWith('SH-')) return this.catalogs.sh2;
        if (desig.startsWith('LDN')) return this.catalogs.ldn;
        if (desig.startsWith('CED')) return this.catalogs.ced;
        if (desig.startsWith('VDB')) return this.catalogs.vdb;
        if (desig.startsWith('LBN')) return this.catalogs.lbn;
        if (desig.startsWith('RCW')) return this.catalogs.rcw;
        if (desig.startsWith('SNR')) return this.catalogs.snr;
        if (desig.startsWith('CR ')) return this.catalogs.cr;
        if (desig.startsWith('PK')) return this.catalogs.other;
        if (desig.startsWith('PN')) return this.catalogs.other;
        if (desig.startsWith('B ')) return this.catalogs.other;
        if (desig.startsWith('ESO')) return this.catalogs.other;
        if (desig.startsWith('PGC')) return this.catalogs.other;
        if (desig.startsWith('LMC') || desig.startsWith('SMC')) return this.catalogs.other;
        return this.catalogs.other;
    }

    // ═══════════════════════════════════════════════════════════
    //  SIDEREAL TIME
    // ═══════════════════════════════════════════════════════════

    _julianDate(date) {
        return date.getTime() / 86400000 + 2440587.5;
    }

    _lstDegrees(date, lon) {
        const jd = this._julianDate(date);
        const t = (jd - 2451545.0) / 36525.0;
        let gmst = 280.46061837
            + 360.98564736629 * (jd - 2451545.0)
            + 0.000387933 * t * t
            - (t * t * t) / 38710000.0;
        gmst = ((gmst % 360) + 360) % 360;
        let lst = (gmst + lon) % 360;
        if (lst < 0) lst += 360;
        return lst;
    }

    _formatTime(hoursDecimal) {
        let h = Math.floor(hoursDecimal);
        let m = Math.floor((hoursDecimal - h) * 60);
        let s = Math.floor((((hoursDecimal - h) * 60) - m) * 60);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }

    _getObsDate() {
        return this._timeMode === 'manual' ? this._manualDate : new Date();
    }

    _startSiderealSync() {
        this._stopSiderealSync();
        this._updateSiderealRotation();
        this._realtimer = setInterval(() => this._updateSiderealRotation(), 1000);
    }

    _stopSiderealSync() {
        if (this._realtimer) {
            clearInterval(this._realtimer);
            this._realtimer = null;
        }
    }

    _updateSiderealRotation() {
        const date = this._getObsDate();
        const lst = this._lstDegrees(date, this.siteLng);

        const centerRA = lst - this._manualOffsetRA;
        const centerDEC = -this._decOffset;
        const ha = this._manualOffsetRA;
        const gamma = -this._parallacticAngle(ha, centerDEC) * 180 / Math.PI;

        this._parallacticAngleDeg = gamma;
        this._currentRotation = [-lst + this._manualOffsetRA, this._decOffset, 0];
        this._projection.rotate(this._currentRotation);

        const lstEl = document.getElementById('lst-display');
        if (lstEl) lstEl.textContent = this._formatTime(lst / 15);

        const clockEl = document.getElementById('clock-display');
        if (clockEl) {
            clockEl.textContent = date.toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        }

        if (!this._renderRequested) {
            this._renderRequested = true;
            requestAnimationFrame(() => {
                this._renderRequested = false;
                this.render();
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  CLIPPING
    // ═══════════════════════════════════════════════════════════

    _celestialClip(coords) {
        const r = this._projection.rotate();
        const d2r = Math.PI / 180;
        const phi = coords[1] * d2r;
        const lambda = (coords[0] + r[0]) * d2r;
        const phi0 = -r[1] * d2r;
        return (Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda)) > 0;
    }

    // ═══════════════════════════════════════════════════════════
    //  STATIC CELESTIAL OBJECTS
    // ═══════════════════════════════════════════════════════════

    _getCelestialEquator() {
        const coords = [];
        for (let ra = 0; ra <= 360; ra += 1) coords.push([ra, 0]);
        return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    }

    _getEcliptic() {
        const epsilon = 23.4393 * Math.PI / 180;
        const cosEps = Math.cos(epsilon);
        const sinEps = Math.sin(epsilon);
        const coords = [];
        for (let lambda = 0; lambda <= 360; lambda += 1) {
            const lamRad = lambda * Math.PI / 180;
            const sinLam = Math.sin(lamRad);
            const cosLam = Math.cos(lamRad);
            const dec = Math.asin(sinEps * sinLam) * 180 / Math.PI;
            let ra = Math.atan2(cosEps * sinLam, cosLam) * 180 / Math.PI;
            ra = ((ra % 360) + 360) % 360;
            coords.push([ra, dec]);
        }
        return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    }

    _getHorizon(lstRad) {
        const lat = this.siteLat * Math.PI / 180;
        if (lstRad === undefined) lstRad = this._lstDegrees(new Date(), this.siteLng) * Math.PI / 180;
        const cosLat = Math.cos(lat);
        const tanLat = Math.tan(lat);
        const coords = [];
        for (let az = 0; az <= 360; az += 1) {
            const azRad = az * Math.PI / 180;
            const dec = Math.asin(cosLat * Math.cos(azRad));
            const cosDec = Math.cos(dec);
            const sinHA = -Math.sin(azRad) / cosDec;
            const cosHA = -Math.sin(dec) * tanLat / cosDec;
            const ha = Math.atan2(sinHA, cosHA);
            let ra = (lstRad - ha) * 180 / Math.PI;
            ra = ((ra % 360) + 360) % 360;
            coords.push([ra, dec * 180 / Math.PI]);
        }
        return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    }

    _getMeridianLabels() {
        const labels = [];
        for (let ra = 0; ra < 360; ra += 15) {
            labels.push({ ra, text: ra + "°" });
        }
        return labels;
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER
    // ═══════════════════════════════════════════════════════════

    render() {
        if (!this._ctx || !this._projection) return;

        const ctx = this._ctx;
        const w = this._width;
        const h = this._height;
        const cx = w / 2;
        const cy = h / 2;
        const rsky = this._projection.scale();

        ctx.clearRect(0, 0, w, h);

        // 1. Fond noir + cercle ciel
        ctx.fillStyle = "#020208";
        ctx.beginPath();
        ctx.arc(cx, cy, rsky, 0, 2 * Math.PI);
        ctx.fill();

        // Apply parallactic angle rotation for sky objects
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((this._parallacticAngleDeg || 0) * Math.PI / 180);
        ctx.translate(-cx, -cy);

        // 2. Voie lactée
        if (this.layers.milkyway && this._milkywayData) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
            ctx.beginPath();
            this._pathGenerator(this._milkywayData);
            ctx.fill();
        }

        // 3. Grille gratiulaire
        if (this.layers.grid) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            this._pathGenerator(this._cachedGraticule);
            ctx.stroke();
        }

        // 4. Équateur céleste (cyan)
        if (this.layers.equator) {
            ctx.strokeStyle = "rgba(0, 255, 255, 0.85)";
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            this._pathGenerator(this._cachedEquator);
            ctx.stroke();
        }

        // 5. Écliptique (jaune, tirets)
        if (this.layers.ecliptic) {
            ctx.strokeStyle = "rgba(255, 255, 0, 0.85)";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            this._pathGenerator(this._cachedEcliptic);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 6. Méridien local (magenta)
        if (this.layers.meridian) {
            const localRA = -this._currentRotation[0];
            const meridianCoords = [];
            for (let dec = -90; dec <= 90; dec += 1) {
                meridianCoords.push([localRA, dec]);
            }
            const meridian = { type: "Feature", geometry: { type: "LineString", coordinates: meridianCoords } };
            ctx.strokeStyle = "rgba(255, 0, 255, 0.7)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            this._pathGenerator(meridian);
            ctx.stroke();
        }

        // 7. Constellations
        if (this.layers.constellations && this._constellationsData) {
            ctx.strokeStyle = "rgba(0, 255, 204, 0.2)";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            this._pathGenerator(this._constellationsData);
            ctx.stroke();
        }

        // 8. Étoiles : projection rapide (vecteurs unitaires + produits
        // scalaires), plafonnée en nombre pour rester fluide au zoom dézoomé
        // même avec le catalogue magnitude 8 (~41 000 étoiles).
        if (this.layers.stars && this._starVectors && this._starVectors.length) {
            const scaleFactor = this._scale / (Math.min(w, h) * 0.45);
            const centerRA = -this._currentRotation[0];
            const centerDec = -this._currentRotation[1];
            const pts = [];
            projectStars(
                this._starVectors, centerRA, centerDec,
                this._scale, w / 2, h / 2,
                this._maxMagnitude, this._MAX_DRAW_STARS, pts,
                (mag) => Math.max(0.6, Math.min(5, (6.5 - mag) * scaleFactor * 0.5))
            );
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            for (let i = 0; i < pts.length; i += 3) {
                const sx = pts[i], sy = pts[i + 1], size = pts[i + 2];
                if (size < 1.5) {
                    // Chemin rapide : le remplissage fill > tolère des carrés
                    // sub-pixel sans perte visuelle notable.
                    ctx.fillRect(sx - size, sy - size, size * 2, size * 2);
                } else {
                    ctx.moveTo(sx + size, sy);
                    ctx.arc(sx, sy, size, 0, 2 * Math.PI);
                }
            }
            ctx.fill();
        }

        // 9. Labels méridiens
        const meridianLabels = this._getMeridianLabels();
        ctx.fillStyle = "rgba(0, 255, 255, 0.6)";
        ctx.font = "14px monospace";
        ctx.textAlign = "center";
        for (const label of meridianLabels) {
            if (!this._celestialClip([label.ra, 0])) continue;
            const pt = this._projection([label.ra, 0]);
            if (pt) ctx.fillText(label.text, pt[0], pt[1] - 6);
        }

        // 10. DSOs : positions projetées en cache (clé = rotation + mag + échelle +
        // catalogues) pour éviter re-projections + re-clip à chaque frame.
        if (this.layers.dsos && this._dsosData && this._dsosData.features) {
            const rot = this._currentRotation;
            const cacheKey = rot[0].toFixed(5) + '|' + rot[1].toFixed(5) + '|'
                + this._maxMagnitude + '|' + this._scale.toFixed(2) + '|'
                + Object.values(this.catalogs).join('');
            if (!this._dsoCache || this._dsoCache.key !== cacheKey) {
                const items = [];
                let dsocounter = 0;
                for (const dso of this._dsosData.features) {
                    if (!this._dsoHasCatalog(dso)) continue;
                    const props = dso.properties || {};
                    const mag = parseFloat(props.mag);
                    if (!isNaN(mag) && mag > this._maxMagnitude) continue;
                    const coords = dso.geometry.coordinates;
                    if (!this._celestialClip(coords)) continue;
                    const pt = this._projection(coords);
                    if (!pt) continue;
                    dsocounter++;
                    let name = props.desig || props.id || "";
                    if (!name && dso.id) name = dso.id;
                    if (!name) name = "DSO-" + dsocounter;
                    items.push({ x: pt[0], y: pt[1], name });
                }
                this._dsoCache = { key: cacheKey, items };
            }
            for (const item of this._dsoCache.items) {
                ctx.strokeStyle = "rgba(255, 0, 150, 0.6)";
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(item.x, item.y, 4, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.fillStyle = "rgba(255, 0, 150, 0.85)";
                ctx.font = "14px monospace";
                ctx.textAlign = "left";
                ctx.fillText(item.name, item.x + 7, item.y + 3);
            }
        }

        // 11. Planètes (à partir des éléments orbitaux)
        if (this.layers.planets) this._renderPlanets(ctx);

        // 12. Zenith marker — RA = LST, Dec = latitude du site
        const zenithRa = this._lstDegrees(this._getObsDate(), this.siteLng);
        const stationCoords = [zenithRa, this.siteLat];
        if (this._celestialClip(stationCoords)) {
            const pt = this._projection(stationCoords);
            ctx.fillStyle = "#00ff00";
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 4, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = "rgba(0, 255, 0, 0.8)";
            ctx.font = "15px monospace";
            ctx.textAlign = "left";
            ctx.fillText(`ZENITH ${this.siteLat.toFixed(2)}°N`, pt[0] + 8, pt[1] + 3);
        }

        ctx.restore();

        // 6b. Horizon local (orange, tirets) — calculé directement en alt/az
        //     → canvas (sans projection D3) pour rester TOUJOURS horizontal
        //     à l'écran, indépendamment du drag et de la projection.
        if (this.layers.horizon) {
            const currentLstDeg = this._lstDegrees(this._getObsDate(), this.siteLng);

            // Centre de projection RA/Dec → alt/az
            const raC = ((currentLstDeg - this._manualOffsetRA) % 360 + 360) % 360;
            const decC = -this._decOffset;
            const cAltAz = this._radecToAltAz(raC, decC, currentLstDeg);
            const altCRad = cAltAz.alt * Math.PI / 180;
            const azCRad = cAltAz.az * Math.PI / 180;
            const sinAltC = Math.sin(altCRad);
            const scale = this._scale;

            // Arc visible : |az - az_c| < 90° (face avant de la sphère)
            const azCenterDeg = cAltAz.az;
            const azStartDeg = (azCenterDeg - 90 + 360) % 360;
            const azEndDeg   = (azCenterDeg + 90 + 360) % 360;

            // Ellipse horizontale : x = scale·sin(θ), y = scale·sin(alt_c)·cos(θ)
            // avec θ = az - az_c, centrée à l'écran (cx, cy)
            ctx.strokeStyle = "rgba(255, 160, 50, 0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 4]);
            ctx.beginPath();
            let first = true;
            const drawHzPt = (azDeg) => {
                const theta = azDeg * Math.PI / 180 - azCRad;
                const sx = cx + scale * Math.sin(theta);
                const sy = cy + scale * sinAltC * Math.cos(theta);
                if (first) { ctx.moveTo(sx, sy); first = false; }
                else ctx.lineTo(sx, sy);
            };
            if (azStartDeg < azEndDeg) {
                for (let az = azStartDeg; az <= azEndDeg; az++) drawHzPt(az);
            } else {
                for (let az = azStartDeg; az <= 360; az++) drawHzPt(az);
                for (let az = 0; az <= azEndDeg; az++) drawHzPt(az);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // Graduations azimutales
            const azLabels = [
                { az: 0, name: 'N' }, { az: 30, name: '30°' }, { az: 60, name: '60°' },
                { az: 90, name: 'E' }, { az: 120, name: '120°' }, { az: 150, name: '150°' },
                { az: 180, name: 'S' }, { az: 210, name: '210°' }, { az: 240, name: '240°' },
                { az: 270, name: 'O' }, { az: 300, name: '300°' }, { az: 330, name: '330°' },
            ];

            ctx.fillStyle = "rgba(255, 160, 50, 0.9)";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            for (const lbl of azLabels) {
                let relAz = lbl.az - azCenterDeg;
                if (relAz < -180) relAz += 360;
                if (relAz > 180) relAz -= 360;
                if (Math.abs(relAz) > 90) continue;

                const theta = lbl.az * Math.PI / 180 - azCRad;
                const sx = cx + scale * Math.sin(theta);
                const sy = cy + scale * sinAltC * Math.cos(theta);

                const isCardinal = lbl.az % 90 === 0;
                ctx.font = isCardinal ? "bold 15px monospace" : "11px monospace";
                ctx.fillStyle = isCardinal ? "rgba(255, 160, 50, 1.0)" : "rgba(255, 160, 50, 0.6)";
                ctx.fillText(lbl.name, sx, sy + 12);
            }
        }

        // 13. Labels cardinaux (N/S/E/O) — E à gauche, O à droite (ciel vu de l'intérieur)
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 20px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N", cx, cy - rsky + 15);
        ctx.fillText("S", cx, cy + rsky - 15);
        ctx.fillText("E", cx - rsky + 15, cy);
        ctx.fillText("O", cx + rsky - 15, cy);

        // 14. Réticule centre (rouge)
        ctx.strokeStyle = "#ff0055";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, 2 * Math.PI);
        ctx.moveTo(cx - 24, cy);
        ctx.lineTo(cx - 6, cy);
        ctx.moveTo(cx + 6, cy);
        ctx.lineTo(cx + 24, cy);
        ctx.moveTo(cx, cy - 24);
        ctx.lineTo(cx, cy - 6);
        ctx.moveTo(cx, cy + 6);
        ctx.lineTo(cx, cy + 24);
        ctx.stroke();

        // Apply parallactic angle rotation for sky indicators
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((this._parallacticAngleDeg || 0) * Math.PI / 180);
        ctx.translate(-cx, -cy);

        // 15. Indicateur télescope (orange + glow)
        if (this._telRaDeg !== null && this._telDecDeg !== null) {
            const telCoords = [this._telRaDeg, this._telDecDeg];
            if (this._celestialClip(telCoords)) {
                const pt = this._projection(telCoords);
                if (pt) {
                    const grad = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], 18);
                    grad.addColorStop(0, 'rgba(255, 136, 0, 0.3)');
                    grad.addColorStop(1, 'rgba(255, 136, 0, 0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], 18, 0, 2 * Math.PI);
                    ctx.fill();

                    ctx.strokeStyle = this.slewing ? "#ffcc00" : "#ff8800";
                    ctx.lineWidth = 2.5;
                    ctx.shadowColor = this.slewing ? "#ffcc00" : "#ff8800";
                    ctx.shadowBlur = 12;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], 10, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.shadowBlur = 0;

                    ctx.moveTo(pt[0] - 14, pt[1]);
                    ctx.lineTo(pt[0] + 14, pt[1]);
                    ctx.moveTo(pt[0], pt[1] - 14);
                    ctx.lineTo(pt[0], pt[1] + 14);
                    ctx.stroke();

                    ctx.fillStyle = this.slewing ? "#ffcc00" : "#ff8800";
                    ctx.font = "bold 14px monospace";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "bottom";
                    ctx.fillText("TELESCOPE", pt[0] + 16, pt[1] - 4);
                }
            }
        }

        // 16. Highlight objet
        if (this._highlight) {
            if (this._celestialClip([this._highlight.ra, this._highlight.dec])) {
                const pt = this._projection([this._highlight.ra, this._highlight.dec]);
                if (pt) {
                    ctx.save();
                    ctx.strokeStyle = "#ffeb3b";
                    ctx.lineWidth = 2;
                    ctx.shadowColor = "#ffeb3b";
                    ctx.shadowBlur = 6;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], 10, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }

        // 17. FOV caméra (dashed vert)
        if (this._telRaDeg !== null && this._telDecDeg !== null &&
            this.cameraFovX > 0 && this.cameraFovY > 0) {
            this._renderCameraFov(ctx);
        }

        // 17b. Tuiles mosaïque (Lot D1) — planifiées depuis le panneau séquence.
        this._renderMosaicTiles(ctx);

        ctx.restore();

        // Update HUD
        this._updateHud();
    }

    _renderPlanets(ctx) {
        if (!this._planetsData) return;
        const now = new Date();
        const jd = this._julianDate(now);
        const T = (jd - 2451545.0) / 36525.0;

        for (const [key, planet] of Object.entries(this._planetsData)) {
            if (key === 'ter') continue;
            if (!planet.elements || !planet.elements[0]) continue;
            const el = planet.elements[0];
            const L = (el.L + el.dL * T) % 360;
            const w = el.W + el.dW * T;
            const N = el.N + el.dN * T;
            const e = el.e + el.de * T;
            const a = el.a + el.da * T;
            const i = (el.i + el.di * T) * Math.PI / 180;

            const M = (L - w) * Math.PI / 180;
            let E = M;
            for (let iter = 0; iter < 10; iter++) {
                E = M + e * Math.sin(E);
            }

            const x = a * (Math.cos(E) - e);
            const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
            const r = Math.sqrt(x * x + y * y);
            const v = Math.atan2(y, x);

            const Nrad = N * Math.PI / 180;
            const wrad = (w - N) * Math.PI / 180;

            const xEcl = r * (Math.cos(Nrad) * Math.cos(v + wrad) - Math.sin(Nrad) * Math.sin(v + wrad) * Math.cos(i));
            const yEcl = r * (Math.sin(Nrad) * Math.cos(v + wrad) + Math.cos(Nrad) * Math.sin(v + wrad) * Math.cos(i));
            const zEcl = r * Math.sin(v + wrad) * Math.sin(i);

            const epsilon = 23.4393 * Math.PI / 180;
            const cosEps = Math.cos(epsilon);
            const sinEps = Math.sin(epsilon);
            const raRad = Math.atan2(yEcl * cosEps - zEcl * sinEps, xEcl);
            const decRad = Math.asin((zEcl * cosEps + yEcl * sinEps) / r);

            let raDeg = raRad * 180 / Math.PI;
            const decDeg = decRad * 180 / Math.PI;
            if (raDeg < 0) raDeg += 360;

            // Position absolue RA/Dec — la projection D3 gère la rotation
            if (!this._celestialClip([raDeg, decDeg])) continue;
            const pt = this._projection([raDeg, decDeg]);
            if (!pt) continue;

            ctx.fillStyle = "#ffcc00";
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = "#ffcc00";
            ctx.font = "bold 15px monospace";
            ctx.textAlign = "left";
            ctx.fillText(planet.name.toUpperCase(), pt[0] + 8, pt[1] + 3);
        }
    }

    _renderCameraFov(ctx) {
        const halfX = this.cameraFovX / 2;
        const halfY = this.cameraFovY / 2;
        const corners = this._fovCorners(
            this._telRaDeg, this._telDecDeg, halfX, halfY, this.cameraRotDeg);

        const pts = [];
        for (const c of corners) {
            if (!this._celestialClip(c)) return;
            const pt = this._projection(c);
            if (pt) pts.push(pt);
        }
        if (pts.length < 3) return;

        ctx.save();
        ctx.strokeStyle = "rgba(0, 255, 100, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        // Bounding box / taille de la cible dans le champ (Framing assistant).
        this._renderTargetBox(ctx);
    }

    // Calcule les 4 coins RA/Dec d'un rectangle de demi-champ (halfX/halfY en
    // degrés, dans le plan tangent) centré en (ra, dec) et tourné d'un angle de
    // senseur rotDeg (0 = nord en haut, positif = sens horaire vu du ciel).
    _fovCorners(raDeg, decDeg, halfX, halfY, rotDeg) {
        const cosDec = Math.max(Math.cos(decDeg * Math.PI / 180), 0.15);
        const a = (rotDeg || 0) * Math.PI / 180;
        const c = Math.cos(a), s = Math.sin(a);
        const around = [];
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            // Offsets dans le plan tangent : x = est (RA), y = nord (DEC).
            const xr = sx * halfX * c - sy * halfY * s;
            const yr = sx * halfX * s + sy * halfY * c;
            const ra = (((raDeg + xr / cosDec) % 360) + 360) % 360;
            const dec = decDeg + yr;
            around.push([ra, dec]);
        }
        return around;
    }

    // Dessine le rectangle de taille angulaire de la cible (si connue) centré
    // sur le FOV, orienté par l'angle de position de la cible + rotation senseur.
    _renderTargetBox(ctx) {
        const t = this.cameraTarget;
        if (!t || !t.size_arcmin) return;
        const maj = Number(t.size_arcmin[0]);
        const min = Number(t.size_arcmin[1] ?? t.size_arcmin[0]);
        if (!maj || maj <= 0) return;

        const ra = (t.ra ?? this._telRaDeg);
        const dec = (t.dec ?? this._telDecDeg);
        if (ra == null || dec == null) return;
        const targRa = Number(ra);
        const targDec = Number(dec);

        const cosDec = Math.max(Math.cos(targDec * Math.PI / 180), 0.15);
        const halfX = maj / 2 / 60;
        const halfY = min / 2 / 60;
        // Angle de position de la cible + rotation du senseur.
        const targPa = Number(t.pa ?? t.position_angle_deg ?? 0);
        const a = (targPa + (this.cameraRotDeg || 0)) * Math.PI / 180;
        const c = Math.cos(a), s = Math.sin(a);

        const pts = [];
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const xr = sx * halfX * c - sy * halfY * s;
            const yr = sx * halfX * s + sy * halfY * c;
            const cra = (((targRa + xr / cosDec) % 360) + 360) % 360;
            const cdec = targDec + yr;
            if (this._celestialClip([cra, cdec])) {
                const pt = this._projection([cra, cdec]);
                if (pt) pts.push(pt);
            }
        }
        if (pts.length < 3) return;

        ctx.save();
        ctx.strokeStyle = "rgba(255, 215, 0, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.stroke();

        // Marqueur au centre de la cible.
        ctx.strokeStyle = "rgba(255, 215, 0, 0.6)";
        ctx.lineWidth = 1;
        const cp = this._projection([targRa, targDec]);
        if (cp) {
            ctx.beginPath();
            ctx.moveTo(cp[0] - 6, cp[1]);
            ctx.lineTo(cp[0] + 6, cp[1]);
            ctx.moveTo(cp[0], cp[1] - 6);
            ctx.lineTo(cp[0], cp[1] + 6);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Grille de tuiles d'une mosaïque (Lot D1) : rectangles alignés RA/Dec.
    _renderMosaicTiles(ctx) {
        const { tiles, fov } = this.mosaicTiles || {};
        if (!tiles || !tiles.length || !fov) return;
        const current = this.mosaicTiles.current;
        const halfY = fov.y_deg / 2;
        ctx.save();
        for (const tile of tiles) {
            const cosDec = Math.max(Math.cos(tile.dec_deg * Math.PI / 180), 0.15);
            const halfX = (fov.x_deg / 2) / cosDec;
            const w = tile.ra_deg - halfX;
            const e = tile.ra_deg + halfX;
            if (e - w > 180) continue; // tuile chevauchant l'AD 0h — non dessinée
            const corners = [
                [w, tile.dec_deg - halfY], [e, tile.dec_deg - halfY],
                [e, tile.dec_deg + halfY], [w, tile.dec_deg + halfY],
            ].map(c => [((c[0] % 360) + 360) % 360, c[1]]);
            const pts = [];
            for (const c of corners) {
                if (!this._celestialClip(c)) { pts.length = 0; break; }
                const pt = this._projection(c);
                if (pt) pts.push(pt);
            }
            if (pts.length < 3) continue;
            const active = current != null && current === tile.index;
            ctx.strokeStyle = active ? "rgba(255, 170, 0, 0.95)"
                                     : "rgba(255, 170, 0, 0.45)";
            ctx.lineWidth = active ? 2 : 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    _updateHud() {
        let targetRA = -this._currentRotation[0];
        let targetDEC = -this._currentRotation[1];
        if (targetRA < 0) targetRA += 360;
        if (targetRA >= 360) targetRA -= 360;

        const coordsEl = document.getElementById('tele-coords');
        if (coordsEl) {
            coordsEl.textContent = `${targetRA.toFixed(2)}° , ${targetDEC >= 0 ? '+' : ''}${targetDEC.toFixed(2)}°`;
        }

        const realEl = document.getElementById('tele-real-coords');
        if (realEl) {
            if (this._telRaDeg !== null && this._telDecDeg !== null) {
                realEl.textContent = `RA ${this._telRaDeg.toFixed(2)}° DEC ${this._telDecDeg >= 0 ? '+' : ''}${this._telDecDeg.toFixed(2)}°`;
            } else {
                realEl.textContent = '--- Hors ligne ---';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERACTIONS
    // ═══════════════════════════════════════════════════════════

    _parallacticAngle(haDeg, decDeg) {
        const ha = haDeg * Math.PI / 180;
        const dec = decDeg * Math.PI / 180;
        const lat = this.siteLat * Math.PI / 180;
        return Math.atan2(
            Math.sin(ha),
            Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha)
        );
    }

    _radecToAltAz(raDeg, decDeg, lstDeg) {
        const lat = this.siteLat * Math.PI / 180;
        const lst = lstDeg * Math.PI / 180;
        const ra = raDeg * Math.PI / 180;
        const dec = decDeg * Math.PI / 180;
        const ha = lst - ra;

        const sinAlt = Math.sin(dec) * Math.sin(lat) +
                        Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
        const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

        const cosAlt = Math.cos(alt);
        let az = 0;
        if (Math.abs(cosAlt) > 1e-10) {
            const cosAz = (Math.sin(dec) * Math.cos(lat) -
                           Math.cos(dec) * Math.sin(lat) * Math.cos(ha)) / cosAlt;
            const sinAz = (-Math.cos(dec) * Math.sin(ha)) / cosAlt;
            az = Math.atan2(sinAz, cosAz);
        }

        return {
            alt: alt * 180 / Math.PI,
            az: ((az * 180 / Math.PI) + 360) % 360
        };
    }

    _altAzToRadec(altDeg, azDeg, lstDeg) {
        const lat = this.siteLat * Math.PI / 180;
        const lst = lstDeg * Math.PI / 180;
        const alt = altDeg * Math.PI / 180;
        const az = azDeg * Math.PI / 180;

        const sinDec = Math.sin(alt) * Math.sin(lat) +
                       Math.cos(alt) * Math.cos(lat) * Math.cos(az);
        const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));

        const cosDec = Math.cos(dec);
        let ha = 0;
        if (Math.abs(cosDec) > 1e-10) {
            const sinHa = -Math.cos(alt) * Math.sin(az) / cosDec;
            const cosHa = (Math.sin(alt) * Math.cos(lat) -
                           Math.cos(alt) * Math.sin(lat) * Math.cos(az)) / cosDec;
            ha = Math.atan2(sinHa, cosHa);
        }

        let ra = ((lst - ha) * 180 / Math.PI);
        ra = ((ra % 360) + 360) % 360;

        return { ra, dec: dec * 180 / Math.PI };
    }

    _setupDrag() {
        const drag = d3.behavior.drag().on("drag", () => {
            const sensitivity = 0.25 * ((Math.min(this._width, this._height) * 0.42) / this._scale);
            const lst = this._lstDegrees(new Date(), this.siteLng);

            // Un-rotate screen drag by parallactic angle to get true horizontal/vertical
            const gamma = (this._parallacticAngleDeg || 0) * Math.PI / 180;
            const cosG = Math.cos(gamma);
            const sinG = Math.sin(gamma);
            const sdx = d3.event.dx;
            const sdy = d3.event.dy;
            const hDrag = sdx * cosG + sdy * sinG;   // true horizontal (azimuth)
            const vDrag = -sdx * sinG + sdy * cosG;   // true vertical   (altitude)

            // Current center in alt/az
            const centerRA = lst - this._manualOffsetRA;
            const centerDEC = -this._decOffset;
            const current = this._radecToAltAz(centerRA, centerDEC, lst);

            let newAz = current.az;
            let newAlt = current.alt;

            if (this._lockRA) {
                // Zenith lock: only altitude (vertical)
                if (!this._lockDEC) newAlt += vDrag * sensitivity;
            } else if (this._lockDEC) {
                // E/O lock: only azimuth (horizontal)
                newAz += hDrag * sensitivity;
            } else {
                newAz += hDrag * sensitivity;
                newAlt += vDrag * sensitivity;
            }

            newAlt = Math.max(-90, Math.min(90, newAlt));
            newAz = ((newAz % 360) + 360) % 360;

            // Convert back to RA/DEC and update offsets
            const newCenter = this._altAzToRadec(newAlt, newAz, lst);
            this._manualOffsetRA = lst - newCenter.ra;
            this._decOffset = -newCenter.dec;

            this._updateSiderealRotation();
        });
        d3.select(this.container).call(drag);
    }

    _setupZoom() {
        d3.select(this.container).on("wheel", () => {
            if (d3.event) d3.event.preventDefault();
            const delta = d3.event.deltaY;
            if (delta < 0) this._scale *= 1.1;
            else this._scale /= 1.1;
            this._scale = Math.max(
                Math.min(this._width, this._height) * 0.15,
                Math.min(Math.min(this._width, this._height) * 8, this._scale)
            );
            this._projection.scale(this._scale);
            this.render();
        });
    }

    _setupResize() {
        // Handled by _onResize via window listener
    }

    _onResize() {
        this._width = window.innerWidth;
        this._height = window.innerHeight;
        this._canvas.attr("width", this._width).attr("height", this._height);
        this._projection.translate([this._width / 2, this._height / 2]);
        this._scale = Math.min(this._width, this._height) * 0.42;
        this._projection.scale(this._scale);
        this.render();
    }

    // ═══════════════════════════════════════════════════════════
    //  CONTEXT MENU + HIT TEST
    // ═══════════════════════════════════════════════════════════

    setupContextMenu() {
        this.container.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const rect = this._canvas.node().getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            this._showContextMenu(e.clientX, e.clientY, px, py);
        });

        this.container.addEventListener("mousedown", (e) => {
            if (e.button === 0) {
                this._hideContextMenu();
                this.clearHighlight();
            }
        });
    }

    _showContextMenu(clientX, clientY, px, py) {
        const hit = this._hitTest(px, py);
        const menu = document.getElementById('obj-context-menu');
        if (!menu) return;
        menu.innerHTML = '';

        let raDeg, decDeg;

        if (hit) {
            raDeg = hit.ra;
            decDeg = hit.dec;

            const title = document.createElement('div');
            title.className = 'obj-menu-title';
            title.textContent = hit.name || hit.id;
            menu.appendChild(title);

            if (hit.catalog || hit.type) {
                const sub = document.createElement('div');
                sub.className = 'obj-menu-sub';
                sub.textContent = [hit.catalog, hit.type].filter(Boolean).join(' — ');
                menu.appendChild(sub);
            }

            if (hit.mag != null) {
                const mag = document.createElement('div');
                mag.className = 'obj-menu-sub';
                mag.textContent = `Magnitude: ${hit.mag.toFixed(1)}`;
                menu.appendChild(mag);
            }
        } else {
            let coords = null;
            try {
                const ugamma = (this._parallacticAngleDeg || 0) * Math.PI / 180;
                const ucG = Math.cos(ugamma);
                const usG = Math.sin(ugamma);
                const udx = px - this._width / 2;
                const udy = py - this._height / 2;
                coords = this._projection.invert([
                    this._width / 2 + udx * ucG + udy * usG,
                    this._height / 2 - udx * usG + udy * ucG
                ]);
            } catch(e) {}
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) return;
            raDeg = coords[0];
            decDeg = coords[1];

            const title = document.createElement('div');
            title.className = 'obj-menu-title';
            title.textContent = 'Ciel vide';
            menu.appendChild(title);
        }

        const raH = ((raDeg % 360) + 360) % 360 / 15;
        const decSign = decDeg >= 0 ? '+' : '-';
        const absDec = Math.abs(decDeg);
        const decStr = `${decSign}${String(Math.floor(absDec)).padStart(2, '0')}°${String(Math.floor((absDec % 1) * 60)).padStart(2, '0')}'`;

        const coordsEl = document.createElement('div');
        coordsEl.className = 'obj-menu-coords';
        coordsEl.innerHTML = `RA: ${raH.toFixed(4)}h<br>Dec: ${decStr} (${decDeg.toFixed(4)}°)`;
        menu.appendChild(coordsEl);

        const gotoBtn = document.createElement('button');
        gotoBtn.className = 'obj-menu-btn';
        gotoBtn.textContent = 'GOTO';
        gotoBtn.addEventListener('click', () => {
            if (typeof setTargetObject === 'function') {
                setTargetObject({ id: hit.name || hit.id || '', name: hit.name || hit.id || '', ra: raDeg, dec: decDeg });
            }
            fetch('/api/mount/slew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ra_hours: raH, dec_deg: decDeg }),
            });
            this._hideContextMenu();
        });
        menu.appendChild(gotoBtn);

        // "Set target" button for astrometry offset overlay
        const targetBtn = document.createElement('button');
        targetBtn.className = 'obj-menu-btn';
        targetBtn.textContent = i18n('sky.define_target');
        targetBtn.addEventListener('click', () => {
            if (typeof window.setOffsetTarget === 'function') {
                window.setOffsetTarget(raDeg, decDeg);
            }
            this._hideContextMenu();
        });
        menu.appendChild(targetBtn);

        menu.style.display = 'block';
        menu.style.left = clientX + 'px';
        menu.style.top = clientY + 'px';

        requestAnimationFrame(() => {
            const mr = menu.getBoundingClientRect();
            if (mr.right > window.innerWidth) menu.style.left = (clientX - mr.width) + 'px';
            if (mr.bottom > window.innerHeight) menu.style.top = (clientY - mr.height) + 'px';
        });
    }

    _hideContextMenu() {
        const menu = document.getElementById('obj-context-menu');
        if (menu) menu.style.display = 'none';
    }

    _hitTest(px, py) {
        // Un-rotate mouse coordinates by parallactic angle
        const gamma = (this._parallacticAngleDeg || 0) * Math.PI / 180;
        const cosG = Math.cos(gamma);
        const sinG = Math.sin(gamma);
        const hdx = px - this._width / 2;
        const hdy = py - this._height / 2;
        px = this._width / 2 + hdx * cosG + hdy * sinG;
        py = this._height / 2 - hdx * sinG + hdy * cosG;

        const hitRadius = 20;
        let best = null, bestDist = hitRadius;

        for (const obj of this._objects) {
            const coords = [obj.ra, obj.dec];
            let pt;
            try { pt = this._projection(coords); } catch(e) { continue; }
            if (!pt || isNaN(pt[0]) || isNaN(pt[1])) continue;
            const dx = px - pt[0];
            const dy = py - pt[1];
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = obj;
            }
        }
        return best;
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════

    setTelPosition(raDeg, decDeg) {
        this._telRaDeg = raDeg;
        this._telDecDeg = decDeg;
        if (this._initialized && this._mapReady) {
            if (!this._rafPending) {
                this._rafPending = true;
                requestAnimationFrame(() => {
                    this.render();
                    this._rafPending = false;
                });
            }
        }
    }

    // Lot D1 : affiche la grille de tuiles planifiée (ou l'efface si null).
    setMosaicTiles(plan) {
        this.mosaicTiles = plan || null;
        if (this._initialized && this._mapReady) {
            if (!this._rafPending) {
                this._rafPending = true;
                requestAnimationFrame(() => {
                    this.render();
                    this._rafPending = false;
                });
            }
        }
    }

    // Met en évidence la tuile en cours d'acquisition (index du plan).
    setMosaicCurrent(index) {
        if (this.mosaicTiles) {
            this.mosaicTiles.current = index;
            this.setMosaicTiles(this.mosaicTiles);
        }
    }

    // Lot D3 (Framing assistant) : rotation du senseur (0 = nord en haut).
    setCameraRotation(deg) {
        this.cameraRotDeg = Number(deg) || 0;
        this._scheduleRender();
    }

    // Lot D3 (Framing assistant) : cible à cadrer (taille angulaire en arcmin).
    // obj = { ra, dec, size_arcmin:[maj,min], pa, name } | null pour effacer.
    setCameraTarget(obj) {
        this.cameraTarget = obj || null;
        this._scheduleRender();
    }

    _scheduleRender() {
        if (!this._initialized || !this._mapReady) return;
        if (!this._rafPending) {
            this._rafPending = true;
            requestAnimationFrame(() => {
                this.render();
                this._rafPending = false;
            });
        }
    }

    centerOnTel() {
        if (this._telRaDeg !== null && this._telDecDeg !== null) {
            this._setCenter(this._telRaDeg, this._telDecDeg);
        }
    }

    centerOnObject(raDeg, decDeg) {
        this._setCenter(raDeg, decDeg);
    }

    _setCenter(raDeg, decDeg) {
        const lst = this._lstDegrees(this._getObsDate(), this.siteLng);
        this._manualOffsetRA = lst - raDeg;
        this._decOffset = -decDeg;
        this._updateSiderealRotation();
    }

    highlightObject(raDeg, decDeg, id) {
        this._highlight = { ra: raDeg, dec: decDeg, id };
        this.render();
    }

    clearHighlight() {
        this._highlight = null;
        if (this._initialized) this.render();
    }

    search(query) {
        const q = query.toLowerCase();
        return this._objects.filter(obj => {
            if (obj.id && obj.id.toLowerCase().includes(q)) return true;
            if (obj.name && obj.name.toLowerCase().includes(q)) return true;
            if (obj.catalog && obj.catalog.toLowerCase().includes(q)) return true;
            if (obj._aliases) {
                for (const a of obj._aliases) {
                    if (a && a.toLowerCase().includes(q)) return true;
                }
            }
            return false;
        });
    }

    updateSite(lat, lng, elev) {
        this.siteLat = lat;
        this.siteLng = lng;
        this.siteElev = elev;
        this._updateSiderealRotation();
    }

    setMagnitudeLimit(val) {
        this._maxMagnitude = val;
        this.render();
    }

    setManualTime(date) {
        this._timeMode = 'manual';
        this._manualDate = date;
        this._stopSiderealSync();
        this._updateSiderealRotation();
    }

    setRealTime() {
        this._timeMode = 'realtime';
        this._manualOffsetRA = 0;
        this._decOffset = 0;
        this._startSiderealSync();
    }

    destroy() {
        this._stopSiderealSync();
        this._initialized = false;
    }
}
