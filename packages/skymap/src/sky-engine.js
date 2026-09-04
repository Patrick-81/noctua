/**
 * sky-engine.js — Moteur cartographique céleste.
 *
 * Projection orthographique D3 v3 sur canvas HTML5.
 * Package standalone @noctua/skymap.
 *
 * Dépendances requises (global) :
 *   - D3 v3.5.17 (d3.geo.orthographic, d3.geo.path, d3.geo.graticule,
 *     d3.behavior.drag, d3.event, d3.select)
 *
 * API publique :
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
 *
 * @example
 *   import { SkyEngine } from '@noctua/skymap';
 *   const engine = new SkyEngine(document.getElementById('map'), {
 *     siteLat: 48.8, siteLng: 2.3, siteElev: 100,
 *     dataBaseUrl: '/celestial-data/',
 *     onGoto: (raH, decDeg) => fetch('/api/mount/slew', { ... }),
 *     onSetTarget: (raDeg, decDeg) => { ... },
 *     i18n: (key) => translations[key] ?? key,
 *   });
 *   engine.init();
 *   await engine.loadCatalogs();
 */

import {
    buildStarVectors,
    projectStars,
    projectPoint,
} from './sky-projection.js';

export class SkyEngine {
    constructor(container, options = {}) {
        this.container = container;
        this.siteLat = options.siteLat ?? 43.952;
        this.siteLng = options.siteLng ?? 1.568;
        this.siteElev = options.siteElev ?? 210;

        // ── Injection hooks (standalone mode) ──────────────────
        this._dataBaseUrl = options.dataBaseUrl ?? '/celestial-data/';
        this._onGoto = options.onGoto ?? null;
        this._onSetTarget = options.onSetTarget ?? null;
        this._i18n = options.i18n
            ?? (typeof i18n === 'function' ? i18n : (k) => ({ 'sky.define_target': 'Définir cible', 'sky.empty_sky': 'Ciel vide' }[k] ?? k));

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

        this._starsData = null;
        this._constellationsData = null;
        this._milkywayData = null;
        this._dsosData = null;
        this._planetsData = null;
        this._starVectors = null;      // vecteurs unitaires triés par magnitude
        this._starNames = null;        // Map<star id, label> for the optional name layer
        this._dsoCache = null;         // { key, items: [{x, y, name}] }
        this._MAX_DRAW_STARS = 20000;  // deeper catalogue (stars.14) → allow more on screen

        // Layer visibility
        this.layers = {
            milkyway: true,
            constellations: true,
            stars: true,
            starnames: false,
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

        // Create context menu element if not present in DOM
        this._menuEl = document.getElementById('obj-context-menu');
        if (!this._menuEl) {
            this._menuEl = document.createElement('div');
            this._menuEl.id = 'obj-context-menu';
            this._menuEl.className = 'obj-menu';
            document.body.appendChild(this._menuEl);
        }

        this._buildProjection();

        // Géométries fixes en coordonnées RA/Dec : calculées une seule fois,
        // la rotation LST est appliquée par la projection à chaque rendu.
        // Note : l'horizon dépend du LST et est donc recalculé dans render().
        // La grille équatoriale est reconstruite à chaque frame (_drawGrid),
        // adaptée au zoom — pas de graticule mise en cache.
        this._cachedEquator = this._getCelestialEquator();
        this._cachedEcliptic = this._getEcliptic();

        this._setupDrag();
        this._setupZoom();
        this._setupResize();
        this._startSiderealSync();
        this._initialized = true;

        // Horizon align buttons (console de pointage)
        document.querySelectorAll('.horizon-btn').forEach(btn=>{
            btn.addEventListener('click', ()=>{
                const v=btn.dataset.az;
                if(v==='zenith') this.alignToHorizon(0, 0);
                else this.alignToHorizon(parseInt(v,10), 0);
            });
        });

        window.addEventListener('resize', () => this._onResize());
    }

    // Mirror east<->west (planetarium view: the sky as seen from inside,
    // looking up) by reflecting the *raw* projection function before
    // d3.geo.projection wraps it. Because the reflection sits inside what
    // d3 streams, clipping / antimeridian cutting / resampling / winding
    // are all still handled natively by d3 — unlike a post-hoc wrapper
    // around the built projection (which breaks clipAngle and forces
    // manual per-point reprojection for anything drawn as a path).
    _buildProjection() {
        function mirrorRaw(lambda, phi) {
            const p = d3.geo.orthographic.raw(lambda, phi);
            return p ? [-p[0], p[1]] : p;
        }
        mirrorRaw.invert = function (x, y) { return d3.geo.orthographic.raw.invert(-x, y); };

        this._projection = d3.geo.projection(mirrorRaw)
            .scale(this._scale)
            .translate([this._width / 2, this._height / 2])
            .clipAngle(90)
            .rotate(this._currentRotation);
        this._pathGenerator = d3.geo.path().projection(this._projection).context(this._ctx);
    }

    async loadCatalogs() {
        const base = this._dataBaseUrl;
        const load = (path) => fetch(base + path).then(r => r.json()).catch(() => null);

        const [stars14, consts, mw, dsos, planets, starNames, messier] = await Promise.all([
            load('stars.14.json'),   // ~mag 14; falls back to stars.8 when not served
            load('constellations.lines.json'),
            load('mw.json'),
            load('dsos.6.bright.json'),
            load('planets.json'),
            load('starnames.json'),  // optional: { <id>: { name, bayer, c } }
            load('messier.json'),    // optional: full M1..M110
        ]);
        const stars = stars14 || await load('stars.8.json');

        this._starsData = stars;
        if (stars && stars.features) {
            this._starVectors = buildStarVectors(stars.features);
            const faint = this._starVectors.length
                ? this._starVectors[this._starVectors.length - 1].mag : null;
            console.log('[sky] star catalogue:', this._starVectors.length, 'stars, faintest mag',
                faint, stars14 ? '(stars.14)' : '(stars.8 fallback)');
        }
        if (starNames && typeof starNames === 'object') {
            this._starNames = new Map();
            for (const k of Object.keys(starNames)) {
                const v = starNames[k] || {};
                let label = v.name;
                if (!label && v.bayer) label = v.bayer + (v.c ? ' ' + v.c : '');
                if (label) this._starNames.set(Number(k), label);
            }
        }
        this._constellationsData = consts;
        this._milkywayData = mw;
        this._dsosData = this._mergeMessier(dsos, messier);
        this._planetsData = planets;
        this._mapReady = true;
        this.render();
    }

    // Merge the full M1..M110 list into the bright-DSO catalogue. messier.json
    // has { name:"M13", desig:"NGC 6205", ... }; label with the M number and
    // skip any Messier object already present in the bright set. No-op when
    // messier.json is absent.
    _mergeMessier(dsos, messier) {
        if (!messier || !Array.isArray(messier.features)) return dsos;
        const base = (dsos && dsos.features) ? dsos : { type: "FeatureCollection", features: [] };
        const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
        const have = new Set();
        for (const f of base.features) {
            have.add(norm((f.properties && f.properties.desig) || f.id));
        }
        for (const m of messier.features) {
            const mp = m.properties || {};
            const name = mp.name || m.id;
            if (!name || have.has(norm(name))) continue;
            base.features.push({
                type: "Feature",
                id: name,
                properties: { desig: name, type: mp.type, mag: mp.mag, dim: mp.dim, morph: mp.morph },
                geometry: m.geometry,
            });
            have.add(norm(name));
        }
        return base;
    }

    _isMessier(dso) {
        const desig = String((dso.properties && dso.properties.desig) || dso.id || '').toUpperCase();
        return /^M\s*\d/.test(desig);
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

    // Draw text at screen point (x,y), with a screen-space offset (dx,dy),
    // counter-rotating against the current parallactic-angle canvas
    // rotation so the glyphs stay upright — everything drawn between the
    // "Apply parallactic angle rotation" ctx.save()/ctx.restore() pairs in
    // render() is under that rotation, and text should not tilt with it.
    // Preserves the caller's current font / fillStyle / textAlign /
    // textBaseline (only translate/rotate are pushed and popped).
    _drawLabel(ctx, text, x, y, dx, dy) {
        const a = -(this._parallacticAngleDeg || 0) * Math.PI / 180;
        if (!a) { ctx.fillText(text, x + (dx || 0), y + (dy || 0)); return; }
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillText(text, dx || 0, dy || 0);
        ctx.restore();
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
        if (lstRad === undefined) lstRad = this._lstDegrees(this._getObsDate(), this.siteLng) * Math.PI / 180;
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

    // Zoom-adaptive equatorial grid: major/minor spacing narrows as the view
    // zooms in (30°/10° down to 2°/0.5°), each parallel/meridian drawn as a
    // full great circle so d3 clips it to the visible hemisphere, and the
    // major-line coordinate labels are pinned to wherever the line leaves
    // the visible area (screen edge or sphere limb) instead of a fixed spot.
    _drawGrid(ctx, w, h, cx, cy) {
        const minDim = Math.min(w, h);
        const z = this._scale / (minDim * 0.42);
        let maj, sub;
        if      (z < 1.6) { maj = 30; sub = 10;  }
        else if (z < 3.5) { maj = 15; sub = 5;   }
        else if (z < 7)   { maj = 10; sub = 2;   }
        else if (z < 14)  { maj = 5;  sub = 1;   }
        else              { maj = 2;  sub = 0.5; }

        const cinv = this._projection.invert([cx, cy]);
        if (!cinv || !isFinite(cinv[0]) || !isFinite(cinv[1])) return;
        const cra = cinv[0];
        const cdec = Math.max(-89, Math.min(89, cinv[1]));
        // angular radius to the screen *corner* (diagonal), not the short edge,
        // so the grid reaches the whole visible field
        const visRad = Math.asin(Math.min(1, (Math.hypot(w, h) / 2) / this._scale)) * 180 / Math.PI;
        const pad = 2 * maj + 5;

        const decLo = Math.max(-89.5, cdec - visRad - pad);
        const decHi = Math.min(89.5, cdec + visRad + pad);
        const fullRA = (Math.abs(cdec) + visRad + pad > 86) || (visRad + pad >= 80);
        let raLo, raHi;
        if (fullRA) {
            raLo = 0; raHi = 360;
        } else {
            const edgeLat = Math.min(84, Math.abs(cdec) + visRad + pad) * Math.PI / 180;
            const raHalf = Math.min(185, (visRad + pad) / Math.max(0.03, Math.cos(edgeLat)));
            raLo = cra - raHalf; raHi = cra + raHalf;
        }

        const isMult = (v, s) => { const m = Math.abs(v % s); return m < 1e-4 || m > s - 1e-4; };
        const build = (major) => {
            const st = major ? maj : sub;
            const merSt = (major || fullRA) ? maj : sub;
            const lines = [];
            for (let d = Math.ceil(decLo / st) * st; d <= decHi + 1e-6; d += st) {
                if (!major && isMult(d, maj)) continue;
                const ln = [];
                for (let r = 0; r <= 360 + 1e-6; r += 4) ln.push([r, d]);
                lines.push(ln);
            }
            for (let r = Math.ceil(raLo / merSt) * merSt; r <= raHi + 1e-6; r += merSt) {
                if (!major && isMult(r, maj)) continue;
                const ln = [];
                for (let d = decLo; d <= decHi + 1e-6; d += 3) ln.push([r, d]);
                lines.push(ln);
            }
            return { type: "Feature", geometry: { type: "MultiLineString", coordinates: lines } };
        };

        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        this._pathGenerator(build(false));
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.26)";
        ctx.beginPath();
        this._pathGenerator(build(true));
        ctx.stroke();

        // Coordinate labels, pinned to where each major line leaves the
        // visible area.
        {
            ctx.font = "11px monospace";
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            const mrg = 3;
            const inScreen = (p) => p && p[0] >= mrg && p[0] <= w - mrg && p[1] >= 22 && p[1] <= h - mrg;

            const raHM = (deg) => {
                let hh = deg / 15;
                let H = Math.floor(hh);
                let M = Math.round((hh - H) * 60);
                if (M === 60) { M = 0; H += 1; }
                H = ((H % 24) + 24) % 24;
                return String(H).padStart(2, '0') + ':' + String(M).padStart(2, '0');
            };

            // Only the arc within ~95° of the view centre genuinely faces us;
            // sampling wider picks up the antipodal (back-side) half of the
            // same great circle near the poles.
            const dLo = Math.max(decLo, cdec - visRad - pad);
            const dHi = Math.min(decHi, cdec + visRad + pad);

            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            for (let r = Math.ceil((cra - 95) / maj) * maj; r <= cra + 95; r += maj) {
                let best = null;
                for (let d = dLo; d <= Math.min(dHi, cdec + 4) + 1e-6; d += 3) {
                    const p = this._projection([r, d]);
                    if (inScreen(p) && (!best || p[1] > best[1])) best = p;
                }
                if (best) this._drawLabel(ctx, raHM(((r % 360) + 360) % 360), best[0], Math.min(best[1] - 4, h - 6), 0, 0);
            }

            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            for (let d = Math.ceil(dLo / maj) * maj; d <= dHi + 1e-6; d += maj) {
                if (Math.abs(d) > 89.5) continue;
                let best = null;
                for (let r = cra - 95; r <= cra + 95; r += 3) {
                    const p = this._projection([r, d]);
                    if (inScreen(p) && (!best || p[0] < best[0])) best = p;
                }
                if (best) {
                    const sign = d > 0 ? '+' : (d < 0 ? '−' : ' ');
                    this._drawLabel(ctx, sign + Math.abs(d) + '°', Math.max(best[0] + 4, mrg + 2), best[1], 0, 0);
                }
            }
        }
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

        // 2. Voie lactée. Now that _buildProjection lets d3 handle clipping /
        // winding natively, this goes back through _pathGenerator like any
        // other path — no more raw/unmirrored fallback needed.
        if (this.layers.milkyway && this._milkywayData) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
            ctx.beginPath();
            this._pathGenerator(this._milkywayData);
            ctx.fill();
        }

        // 3. Grille équatoriale, adaptée au zoom (voir _drawGrid).
        if (this.layers.grid) this._drawGrid(ctx, w, h, cx, cy);

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

        // 6. Méridien local (magenta) : plein de plein sud → zénith → pôle
        // céleste (az 180° puis az 0°), pointillé du pôle → nord. La ligne
        // verticale fixe précédente n'était pas un méridien : elle ne
        // passait ni par le sud, ni par le zénith, ni par le pôle dès que le
        // centre de vue s'écartait du cas particulier plein-sud/dec-0 (même
        // défaut que l'ancien horizon). Tracé en grand cercle réel, comme le
        // reste du ciel.
        if (this.layers.meridian) {
            const merLst = this._lstDegrees(this._getObsDate(), this.siteLng);
            const poleAlt = Math.max(0, this.siteLat);   // pôle nord sur le méridien, az 0°
            const line = (coords) => {
                ctx.beginPath();
                this._pathGenerator({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
                ctx.stroke();
            };

            const solid = [];
            for (let alt = 0; alt <= 90; alt += 1) {                 // S → zénith
                const p = this._altAzToRadec(alt, 180, merLst);
                solid.push([p.ra, p.dec]);
            }
            for (let alt = 89; alt > poleAlt; alt -= 1) {            // zénith → pôle
                const p = this._altAzToRadec(alt, 0, merLst);
                solid.push([p.ra, p.dec]);
            }
            const pole = this._altAzToRadec(poleAlt, 0, merLst);
            solid.push([pole.ra, pole.dec]);

            const dashed = [[pole.ra, pole.dec]];
            for (let alt = Math.floor(poleAlt); alt >= 0; alt -= 1) {  // pôle → N
                const p = this._altAzToRadec(alt, 0, merLst);
                dashed.push([p.ra, p.dec]);
            }

            ctx.strokeStyle = "rgba(255, 0, 255, 0.7)";
            ctx.lineWidth = 2;
            line(solid);
            ctx.setLineDash([6, 4]);
            line(dashed);
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

        // 8. Étoiles : projection rapide (vecteurs unitaires + produits
        // scalaires), plafonnée en nombre pour rester fluide au zoom dézoomé
        // même avec le catalogue magnitude 8 (~41 000 étoiles).
        if (this.layers.stars && this._starVectors && this._starVectors.length) {
            const scaleFactor = this._scale / (Math.min(w, h) * 0.45);
            const centerRA = -this._currentRotation[0];
            const centerDec = -this._currentRotation[1];
            const pts = [];
            const wantNames = this.layers.starnames && this._starNames && this._starNames.size;
            const nameOut = wantNames ? [] : null;
            projectStars(
                this._starVectors, centerRA, centerDec,
                this._scale, w / 2, h / 2,
                this._maxMagnitude, this._MAX_DRAW_STARS, pts,
                (mag) => Math.max(0.6, Math.min(5, (6.5 - mag) * scaleFactor * 0.5)),
                wantNames ? (s) => this._starNames.get(s.id) : null, nameOut, 160
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
            if (nameOut && nameOut.length) {
                ctx.fillStyle = "rgba(180, 210, 255, 0.75)";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "left";
                for (let i = 0; i < nameOut.length; i += 3) {
                    this._drawLabel(ctx, nameOut[i + 2], nameOut[i], nameOut[i + 1], 5, 3);
                }
            }
        }

        // 9. Labels méridiens
        const meridianLabels = this._getMeridianLabels();
        ctx.fillStyle = "rgba(0, 255, 255, 0.6)";
        ctx.font = "14px monospace";
        ctx.textAlign = "center";
        for (const label of meridianLabels) {
            if (!this._celestialClip([label.ra, 0])) continue;
            const pt = this._projection([label.ra, 0]);
            if (pt) this._drawLabel(ctx, label.text, pt[0], pt[1] - 6, 0, 0);
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
                    if (!isNaN(mag) && mag > this._maxMagnitude && !this._isMessier(dso)) continue;
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
                this._drawLabel(ctx, item.name, item.x, item.y, 7, 3);
            }
        }

        // 11. Planètes (à partir des éléments orbitaux) + Soleil/Lune
        if (this.layers.planets) { this._renderPlanets(ctx); this._renderSunMoon(ctx); }

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
            this._drawLabel(ctx, `ZENITH ${this.siteLat.toFixed(2)}°N`, pt[0], pt[1], 8, 3);
        }

        // 6b. Horizon local (orange, tirets). Verified numerically against a
        // reference projection: the old screen-ellipse formula (independent
        // of _projection) only matched the true horizon at the symmetric
        // due-south / dec-0 case — it diverges (not just in sign) as soon as
        // the view is dragged or tracks away from it, which is what the
        // "yoyo" was. Drawn as a real great circle through _projection,
        // inside the same parallactic-rotation block as the rest of the sky
        // so it stays aligned with it (and, since that rotation keeps
        // alt/az's "up" pointed at screen-up, still reads as roughly
        // horizontal — but now exactly, not by approximation).
        if (this.layers.horizon) {
            const currentLstDeg = this._lstDegrees(this._getObsDate(), this.siteLng);
            const horizon = this._getHorizon(currentLstDeg * Math.PI / 180);

            // ground shade: fill the horizon spherical polygon through the
            // projection, clipped to the visible disk. The ring is reversed
            // so the fill lands on the ground side, not the sky side.
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, rsky, 0, 2 * Math.PI);
            ctx.clip();
            ctx.beginPath();
            this._pathGenerator({
                type: "Polygon",
                coordinates: [horizon.geometry.coordinates.slice().reverse()],
            });
            ctx.fillStyle = "rgba(150, 160, 175, 0.10)";
            ctx.fill();
            ctx.restore();

            ctx.strokeStyle = "rgba(255, 160, 50, 0.8)";
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 4]);
            ctx.beginPath();
            this._pathGenerator(horizon);
            ctx.stroke();
            ctx.setLineDash([]);

            const azLabels = [
                { az: 0, name: 'N' }, { az: 30, name: '30°' }, { az: 60, name: '60°' },
                { az: 90, name: 'E' }, { az: 120, name: '120°' }, { az: 150, name: '150°' },
                { az: 180, name: 'S' }, { az: 210, name: '210°' }, { az: 240, name: '240°' },
                { az: 270, name: 'O' }, { az: 300, name: '300°' }, { az: 330, name: '330°' },
            ];
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            for (const lbl of azLabels) {
                const rd = this._altAzToRadec(0, lbl.az, currentLstDeg);
                if (!this._celestialClip([rd.ra, rd.dec])) continue;
                const pt = this._projection([rd.ra, rd.dec]);
                if (!pt) continue;
                const isCardinal = lbl.az % 90 === 0;
                ctx.font = isCardinal ? "bold 15px monospace" : "11px monospace";
                ctx.fillStyle = isCardinal ? "rgba(255, 160, 50, 1.0)" : "rgba(255, 160, 50, 0.6)";
                this._drawLabel(ctx, lbl.name, pt[0], pt[1], 0, 12);
            }
        }

        ctx.restore();

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
                    this._drawLabel(ctx, "TELESCOPE", pt[0], pt[1], 16, -4);
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

    _helioEcliptic(el, T) {
        const L = ((el.L + el.dL * T) % 360 + 360) % 360;
        const W = el.W + el.dW * T;
        const N = el.N + el.dN * T;
        const e = el.e + el.de * T;
        const a = el.a + el.da * T;
        const i = (el.i + el.di * T) * Math.PI / 180;
        const M = (L - W) * Math.PI / 180;
        let E = M;
        for (let iter = 0; iter < 10; iter++) E = M + e * Math.sin(E);
        const x = a * (Math.cos(E) - e);
        const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
        const r = Math.sqrt(x * x + y * y);
        const v = Math.atan2(y, x);
        const Nrad = N * Math.PI / 180;
        const wrad = (W - N) * Math.PI / 180;
        const xEcl = r * (Math.cos(Nrad) * Math.cos(v + wrad) - Math.sin(Nrad) * Math.sin(v + wrad) * Math.cos(i));
        const yEcl = r * (Math.sin(Nrad) * Math.cos(v + wrad) + Math.cos(Nrad) * Math.sin(v + wrad) * Math.cos(i));
        const zEcl = r * Math.sin(v + wrad) * Math.sin(i);
        return { x: xEcl, y: yEcl, z: zEcl, r };
    }

    _renderPlanets(ctx) {
        if (!this._planetsData) return;
        const now = this._getObsDate();
        const jd = this._julianDate(now);
        const T = (jd - 2451545.0) / 36525.0;

        // Position héliocentrique de la Terre pour correction géocentrique.
        const earthEl = this._planetsData['ter']?.elements?.[0];
        const earthPos = earthEl ? this._helioEcliptic(earthEl, T) : null;

        const epsilon = 23.4393 * Math.PI / 180;
        const cosEps = Math.cos(epsilon);
        const sinEps = Math.sin(epsilon);
        const centerRA = -this._currentRotation[0];
        const centerDec = -this._currentRotation[1];
        const pScale = this._scale, pTx = this._width / 2, pTy = this._height / 2;

        for (const [key, planet] of Object.entries(this._planetsData)) {
            if (key === 'ter') continue;
            if (!planet.elements || !planet.elements[0]) continue;
            const helio = this._helioEcliptic(planet.elements[0], T);
            // Passage héliocentrique -> géocentrique.
            let xEcl = helio.x, yEcl = helio.y, zEcl = helio.z, dist = helio.r;
            if (earthPos) {
                xEcl -= earthPos.x;
                yEcl -= earthPos.y;
                zEcl -= earthPos.z;
                dist = Math.sqrt(xEcl * xEcl + yEcl * yEcl + zEcl * zEcl);
                if (dist < 1e-9) continue;
            }
            const raRad = Math.atan2(yEcl * cosEps - zEcl * sinEps, xEcl);
            const decRad = Math.asin((zEcl * cosEps + yEcl * sinEps) / dist);

            let raDeg = raRad * 180 / Math.PI;
            const decDeg = decRad * 180 / Math.PI;
            if (raDeg < 0) raDeg += 360;

            // Projection manuelle (même que étoiles/constellations) pour
            // garantir l'alignement — projectPoint gère le clip à 90°.
            const pt = projectPoint(raDeg, decDeg, centerRA, centerDec, pScale, pTx, pTy);
            if (!pt) continue;

            ctx.fillStyle = "#ffcc00";
            ctx.beginPath();
            ctx.arc(pt[0], pt[1], 5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = "#ffcc00";
            ctx.font = "bold 15px monospace";
            ctx.textAlign = "left";
            this._drawLabel(ctx, planet.name.toUpperCase(), pt[0], pt[1], 8, 3);
        }
    }

    // ── Sun / Moon (Schlyter low-precision series, computed locally — the
    //    planets.json elements for 'sol'/'lun' are empty placeholders) ──

    _sunEcl(d) {
        const rad = Math.PI / 180, rev = (x) => ((x % 360) + 360) % 360;
        const w = 282.9404 + 4.70935e-5 * d;
        const e = 0.016709 - 1.151e-9 * d;
        const M = rev(356.0470 + 0.9856002585 * d);
        const E = M + e * (180 / Math.PI) * Math.sin(M * rad) * (1 + e * Math.cos(M * rad));
        const xv = Math.cos(E * rad) - e;
        const yv = Math.sqrt(1 - e * e) * Math.sin(E * rad);
        const r = Math.hypot(xv, yv);
        const lon = rev(Math.atan2(yv, xv) / rad + w);
        return { lon, lat: 0, r, M, w };
    }
    _eclToRaDec(lon, lat, d) {
        const rad = Math.PI / 180;
        const ecl = (23.4393 - 3.563e-7 * d) * rad;
        const xg = Math.cos(lon * rad) * Math.cos(lat * rad);
        const yg = Math.sin(lon * rad) * Math.cos(lat * rad);
        const zg = Math.sin(lat * rad);
        const xe = xg;
        const ye = yg * Math.cos(ecl) - zg * Math.sin(ecl);
        const ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
        let ra = Math.atan2(ye, xe) / rad;
        if (ra < 0) ra += 360;
        return [ra, Math.atan2(ze, Math.hypot(xe, ye)) / rad];
    }
    _moonRaDec(d) {
        const rad = Math.PI / 180, rev = (x) => ((x % 360) + 360) % 360;
        const s = this._sunEcl(d);
        const N = 125.1228 - 0.0529538083 * d;
        const i = 5.1454;
        const w = 318.0634 + 0.1643573223 * d;
        const e = 0.054900;
        const M = rev(115.3654 + 13.0649929509 * d);
        let E = M + e * (180 / Math.PI) * Math.sin(M * rad) * (1 + e * Math.cos(M * rad));
        E = E - (E - e * (180 / Math.PI) * Math.sin(E * rad) - M) / (1 - e * Math.cos(E * rad));
        const xv = Math.cos(E * rad) - e;
        const yv = Math.sqrt(1 - e * e) * Math.sin(E * rad);
        let r = Math.hypot(xv, yv) * 60.2666;   // Earth radii
        const v = Math.atan2(yv, xv) / rad;
        const xh = r * (Math.cos(N * rad) * Math.cos((v + w) * rad) - Math.sin(N * rad) * Math.sin((v + w) * rad) * Math.cos(i * rad));
        const yh = r * (Math.sin(N * rad) * Math.cos((v + w) * rad) + Math.cos(N * rad) * Math.sin((v + w) * rad) * Math.cos(i * rad));
        const zh = r * Math.sin((v + w) * rad) * Math.sin(i * rad);
        let lon = Math.atan2(yh, xh) / rad;
        let lat = Math.atan2(zh, Math.hypot(xh, yh)) / rad;

        const Ms = s.M, Ls = rev(s.w + s.M);
        const Lm = rev(N + w + M), Dm = rev(Lm - Ls), F = rev(Lm - N);
        const S = (deg) => Math.sin(deg * rad);
        lon += -1.274 * S(M - 2 * Dm) + 0.658 * S(2 * Dm) - 0.186 * S(Ms)
            - 0.059 * S(2 * M - 2 * Dm) - 0.057 * S(M - 2 * Dm + Ms) + 0.053 * S(M + 2 * Dm)
            + 0.046 * S(2 * Dm - Ms) + 0.041 * S(M - Ms) - 0.035 * S(Dm)
            - 0.031 * S(M + Ms) - 0.015 * S(2 * F - 2 * Dm) + 0.011 * S(M - 4 * Dm);
        lat += -0.173 * S(F - 2 * Dm) - 0.055 * S(M - F - 2 * Dm) - 0.046 * S(M + F - 2 * Dm)
            + 0.033 * S(F + 2 * Dm) + 0.017 * S(2 * M + F);
        r += -0.58 * Math.cos((M - 2 * Dm) * rad) - 0.46 * Math.cos(2 * Dm * rad);

        const [gra, gdec] = this._eclToRaDec(lon, lat, d);
        let ra = gra, dec = gdec;

        // topocentric parallax (Schlyter). Bail to geocentric if it produces
        // an implausible shift — parallax is at most ~1°.
        const lat0 = this.siteLat;
        if (isFinite(lat0) && isFinite(r) && r > 1) {
            const mpar = Math.asin(1 / r) / rad;
            const gclat = lat0 - 0.1924 * S(2 * lat0);
            const rho = 0.99833 + 0.00167 * Math.cos(2 * lat0 * rad);
            const lst = this._lstDegrees(this._getObsDate(), this.siteLng);
            const HA = rev(lst - gra);
            const g = Math.atan(Math.tan(gclat * rad) / Math.cos(HA * rad)) / rad;
            const tra = rev(gra - mpar * rho * Math.cos(gclat * rad) * Math.sin(HA * rad) / Math.cos(gdec * rad));
            let tdec = gdec;
            if (Math.abs(Math.sin(g * rad)) > 1e-4)
                tdec = gdec - mpar * rho * Math.sin(gclat * rad) * Math.sin((g - gdec) * rad) / Math.sin(g * rad);
            const dRa = Math.abs(((tra - gra + 540) % 360) - 180);
            if (isFinite(tra) && isFinite(tdec) && dRa < 2 && Math.abs(tdec - gdec) < 2) {
                ra = tra; dec = tdec;
            }
        }
        return [ra, dec];
    }

    _renderSunMoon(ctx) {
        const d = this._julianDate(this._getObsDate()) - 2451545.0;
        const draw = (raDeg, decDeg, color, radius, label) => {
            if (!this._celestialClip([raDeg, decDeg])) return;
            const pt = this._projection([raDeg, decDeg]);
            if (!pt) return;
            const grad = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], radius * 3);
            grad.addColorStop(0, color); grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(pt[0], pt[1], radius * 3, 0, 2 * Math.PI); ctx.fill();
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(pt[0], pt[1], radius, 0, 2 * Math.PI); ctx.fill();
            ctx.font = "bold 14px monospace";
            ctx.textAlign = "left";
            this._drawLabel(ctx, label, pt[0], pt[1], radius + 5, 4);
        };
        const sun = this._sunEcl(d);
        const [sra, sdec] = this._eclToRaDec(sun.lon, 0, d);
        draw(sra, sdec, "#ffd21e", 7, (this._planetsData && this._planetsData.sol && this._planetsData.sol.name || "Sun").toUpperCase());
        const [mra, mdec] = this._moonRaDec(d);
        draw(mra, mdec, "#dfe6ef", 6, (this._planetsData && this._planetsData.lun && this._planetsData.lun.name || "Moon").toUpperCase());
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
            const lst = this._lstDegrees(this._getObsDate(), this.siteLng);

            // Un-rotate screen drag by parallactic angle to get true horizontal/vertical
            const gamma = (this._parallacticAngleDeg || 0) * Math.PI / 180;
            const cosG = Math.cos(gamma);
            const sinG = Math.sin(gamma);
            const sdx = d3.event.dx;
            const sdy = d3.event.dy;
            // true horizontal (azimuth) — negated: the mirrored projection
            // flips screen x, so a rightward drag must turn the view the
            // opposite way to still track the cursor.
            const hDrag = -(sdx * cosG + sdy * sinG);
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
        const menu = this._menuEl;
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
            title.textContent = this._i18n('sky.empty_sky') || 'Ciel vide';
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
            if (this._onGoto) {
                this._onGoto(raH, decDeg, { id: hit.name || hit.id || '', name: hit.name || hit.id || '', ra: raDeg, dec: decDeg });
            }
            this._hideContextMenu();
        });
        menu.appendChild(gotoBtn);

        // "Set target" button for astrometry offset overlay
        const targetBtn = document.createElement('button');
        targetBtn.className = 'obj-menu-btn';
        targetBtn.textContent = this._i18n('sky.define_target');
        targetBtn.addEventListener('click', () => {
            if (this._onSetTarget) {
                this._onSetTarget(raDeg, decDeg);
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
        if (this._menuEl) this._menuEl.style.display = 'none';
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

    alignToHorizon(azDeg, altDeg = 5) {
        const lst = this._lstDegrees(this._getObsDate(), this.siteLng);
        const rc = this._altAzToRadec(altDeg, azDeg, lst);
        this._setCenter(rc.ra, rc.dec);
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
        lat = Number(lat);
        lng = Number(lng);
        // Ignore an unset / implausible fix (e.g. 0,0 on a demo server) so the
        // horizon doesn't collapse onto the pole.
        if (!isFinite(lat) || Math.abs(lat) > 90 || (lat === 0 && (!isFinite(lng) || lng === 0))) return;
        this.siteLat = lat;
        if (isFinite(lng) && Math.abs(lng) <= 180) this.siteLng = lng;
        this.siteElev = Number(elev) || 0;
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
