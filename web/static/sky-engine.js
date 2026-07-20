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
        this._timeMode = 'realtime';
        this._manualDate = new Date();
        this._realtimer = null;
        this._renderRequested = false;
        this._lastRenderTime = 0;
        this._MIN_RENDER_INTERVAL = 80;

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

        this._pathGenerator = d3.geo.path().projection(this._projection).context(this._ctx);
        this._graticule = d3.geo.graticule().step([15, 10]);

        this._setupDrag();
        this._setupZoom();
        this._setupResize();
        this._startSiderealSync();
        this._initialized = true;

        window.addEventListener('resize', () => this._onResize());
    }

    async loadCatalogs() {
        const load = (url) => fetch(url).then(r => r.json()).catch(() => null);

        const [stars, consts, mw, dsos, planets] = await Promise.all([
            load('/celestial-data/stars.6.json'),
            load('/celestial-data/constellations.lines.json'),
            load('/celestial-data/mw.json'),
            load('/celestial-data/dsos.6.bright.json'),
            load('/celestial-data/planets.json'),
        ]);

        this._starsData = stars;
        this._constellationsData = consts;
        this._milkywayData = mw;
        this._dsosData = dsos;
        this._planetsData = planets;
        this._mapReady = true;
        this.render();
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
        const coords = [];
        for (let ra = 0; ra <= 360; ra += 1) {
            const raRad = ra * Math.PI / 180;
            const dec = Math.asin(Math.sin(epsilon) * Math.sin(raRad)) * 180 / Math.PI;
            coords.push([ra, dec]);
        }
        return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
    }

    _getHorizon() {
        const lat = this.siteLat * Math.PI / 180;
        const lst = this._lstDegrees(new Date(), this.siteLng) * Math.PI / 180;
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
            let ra = (lst - ha) * 180 / Math.PI;
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

        const now = Date.now();
        if (now - this._lastRenderTime < this._MIN_RENDER_INTERVAL) return;
        this._lastRenderTime = now;

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

        // 2. Voie lactée
        if (this.layers.milkyway && this._milkywayData) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
            ctx.beginPath();
            this._pathGenerator(this._milkywayData);
            ctx.fill();
        }

        // 3. Grille gratiulaire
        if (this.layers.grid) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            this._pathGenerator(this._graticule());
            ctx.stroke();
        }

        // 4. Équateur céleste (cyan)
        if (this.layers.equator) {
            ctx.strokeStyle = "rgba(0, 255, 255, 0.75)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            this._pathGenerator(this._getCelestialEquator());
            ctx.stroke();
        }

        // 5. Écliptique (jaune, tirets)
        if (this.layers.ecliptic) {
            ctx.strokeStyle = "rgba(255, 255, 0, 0.85)";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            this._pathGenerator(this._getEcliptic());
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

        // 6b. Horizon local (orange, tirets)
        if (this.layers.horizon) {
            ctx.strokeStyle = "rgba(255, 160, 50, 0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 4]);
            ctx.beginPath();
            this._pathGenerator(this._getHorizon());
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 7. Constellations
        if (this.layers.constellations && this._constellationsData) {
            ctx.strokeStyle = "rgba(0, 255, 204, 0.2)";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            this._pathGenerator(this._constellationsData);
            ctx.stroke();
        }

        // 8. Étoiles
        if (this.layers.stars && this._starsData && this._starsData.features) {
            const scaleFactor = this._scale / (Math.min(w, h) * 0.45);
            for (const star of this._starsData.features) {
                const mag = star.properties.mag;
                if (mag > this._maxMagnitude) continue;
                const coords = star.geometry.coordinates;
                if (!this._celestialClip(coords)) continue;
                const pt = this._projection(coords);
                if (!pt) continue;
                const size = Math.max(0.6, Math.min(5, (6.5 - mag) * scaleFactor * 0.5));
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(pt[0], pt[1], size, 0, 2 * Math.PI);
                ctx.fill();
            }
        }

        // 9. Labels méridiens
        const meridianLabels = this._getMeridianLabels();
        ctx.fillStyle = "rgba(0, 255, 255, 0.6)";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        for (const label of meridianLabels) {
            if (!this._celestialClip([label.ra, 0])) continue;
            const pt = this._projection([label.ra, 0]);
            if (pt) ctx.fillText(label.text, pt[0], pt[1] - 6);
        }

        // 10. DSOs
        if (this.layers.dsos && this._dsosData && this._dsosData.features) {
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
                ctx.strokeStyle = "rgba(255, 0, 150, 0.6)";
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(pt[0], pt[1], 4, 0, 2 * Math.PI);
                ctx.stroke();
                let name = props.desig || props.id || "";
                if (!name && dso.id) name = dso.id;
                if (!name) name = "DSO-" + dsocounter;
                ctx.fillStyle = "rgba(255, 0, 150, 0.85)";
                ctx.font = "9px monospace";
                ctx.textAlign = "left";
                ctx.fillText(name, pt[0] + 7, pt[1] + 3);
            }
        }

        // 11. Planètes (à partir des éléments orbitaux)
        if (this.layers.planets) this._renderPlanets(ctx);

        // 12. Zenith marker
        const stationCoords = [this.siteLng, this.siteLat];
        if (this._celestialClip(stationCoords)) {
            const pt = this._projection(stationCoords);
            ctx.fillStyle = "#00ff00";
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 4, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = "rgba(0, 255, 0, 0.8)";
            ctx.font = "10px monospace";
            ctx.textAlign = "left";
            ctx.fillText(`ZENITH ${this.siteLat.toFixed(2)}°N`, pt[0] + 8, pt[1] + 3);
        }

        // 13. Labels cardinaux (N/S/E/O)
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 13px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N", cx, cy - rsky + 15);
        ctx.fillText("S", cx, cy + rsky - 15);
        ctx.fillText("E", cx + rsky - 15, cy);
        ctx.fillText("O", cx - rsky + 15, cy);

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
                    ctx.font = "bold 9px monospace";
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

            const M = (L - w - N) * Math.PI / 180;
            let E = M;
            for (let iter = 0; iter < 10; iter++) {
                E = M + e * Math.sin(E);
            }

            const x = a * (Math.cos(E) - e);
            const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
            const r = Math.sqrt(x * x + y * y);
            const v = Math.atan2(y, x);

            const Nrad = N * Math.PI / 180;
            const wrad = w * Math.PI / 180;

            const xEcl = r * (Math.cos(Nrad) * Math.cos(v + wrad) - Math.sin(Nrad) * Math.sin(v + wrad) * Math.cos(i));
            const yEcl = r * (Math.sin(Nrad) * Math.cos(v + wrad) + Math.cos(Nrad) * Math.sin(v + wrad) * Math.cos(i));
            const zEcl = r * Math.sin(v + wrad) * Math.sin(i);

            const epsilon = 23.4393 * Math.PI / 180;
            const raRad = Math.atan2(yEcl * Math.cos(epsilon) - zEcl * Math.sin(epsilon),
                                     xEcl);
            const decRad = Math.asin(zEcl * Math.cos(epsilon) + yEcl * Math.sin(epsilon));

            let raDeg = raRad * 180 / Math.PI;
            const decDeg = decRad * 180 / Math.PI;
            if (raDeg < 0) raDeg += 360;

            if (!this._celestialClip([raDeg, decDeg])) continue;
            const pt = this._projection([raDeg, decDeg]);
            if (!pt) continue;

            ctx.fillStyle = "#ffcc00";
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = "#ffcc00";
            ctx.font = "bold 10px monospace";
            ctx.textAlign = "left";
            ctx.fillText(planet.name.toUpperCase(), pt[0] + 8, pt[1] + 3);
        }
    }

    _renderCameraFov(ctx) {
        const halfX = this.cameraFovX / 2;
        const halfY = this.cameraFovY / 2;
        const corners = [
            [this._telRaDeg - halfX * 15, this._telDecDeg - halfY],
            [this._telRaDeg + halfX * 15, this._telDecDeg - halfY],
            [this._telRaDeg + halfX * 15, this._telDecDeg + halfY],
            [this._telRaDeg - halfX * 15, this._telDecDeg + halfY],
        ];

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

    _setupDrag() {
        const drag = d3.behavior.drag().on("drag", () => {
            const sensitivity = 0.25 * ((Math.min(this._width, this._height) * 0.42) / this._scale);
            this._manualOffsetRA += d3.event.dx * sensitivity;
            this._decOffset -= d3.event.dy * sensitivity;
            this._decOffset = Math.max(-90, Math.min(90, this._decOffset));
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
            try { coords = this._projection.invert([px, py]); } catch(e) {}
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
            fetch('/api/mount/slew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ra_hours: raH, dec_deg: decDeg }),
            });
            this._hideContextMenu();
        });
        menu.appendChild(gotoBtn);

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

    centerOnTel() {
        if (this._telRaDeg !== null && this._telDecDeg !== null) {
            this._setCenter(this._telRaDeg, this._telDecDeg);
        }
    }

    centerOnObject(raDeg, decDeg) {
        this._setCenter(raDeg, decDeg);
    }

    _setCenter(raDeg, decDeg) {
        this._manualOffsetRA = 0;
        this._decOffset = 0;
        const lst = this._lstDegrees(this._getObsDate(), this.siteLng);
        this._currentRotation = [-lst - raDeg, -decDeg, 0];
        this._projection.rotate(this._currentRotation);
        this.render();
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
