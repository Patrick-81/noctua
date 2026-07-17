/**
 * sky-canvas.js — Client-side stereographic sky chart.
 *
 * Pure JS, no dependencies. Loads catalogs once, renders on HTML5 Canvas.
 * Supports zoom (mousewheel), pan (drag), telescope crosshair overlay,
 * horizon line with cardinal directions, and compass bar.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export class SkyCanvas {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // View state
        this.centerRa = options.centerRa ?? 0;      // degrees
        this.centerDec = options.centerDec ?? 20;    // degrees
        this.fov = options.fov ?? 42;                // degrees
        this.minFov = 2;
        this.maxFov = 120;

        // Telescope crosshair (set externally)
        this.telRa = null;   // degrees
        this.telDec = null;  // degrees

        // Follow mode: auto-pan during slews only
        this.followMode = true;
        this.slewing = false;

        // Observer site (for horizon computation)
        this.siteLat = options.siteLat ?? 48.8566;   // degrees N
        this.siteLng = options.siteLng ?? 2.3522;    // degrees E
        this.siteElev = options.siteElev ?? 0;        // meters ASL

        // Catalog data (loaded async)
        this.stars = [];
        this.constellations = [];
        this.messier = [];
        this.ngc = [];

        // Pan state
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._centerRaStart = 0;
        this._centerDecStart = 0;

        // Compass bar height
        this._compassH = 22;

        // Bind events
        this._bindEvents();

        // Resize observer
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas.parentElement);
        this._resize();
    }

    // ── Catalog loading ──────────────────────────────────────

    async loadCatalogs() {
        const [bsc5, constLines, mess, ngc] = await Promise.all([
            fetch('/catalogs/bsc5.json').then(r => r.json()),
            fetch('/catalogs/constellations.lines.json').then(r => r.json()),
            fetch('/catalogs/messier.json').then(r => r.json()),
            fetch('/catalogs/ngc_ic.json').then(r => r.json()),
        ]);

        this.stars = bsc5.objects.map(s => ({
            ra: s.ra_deg, dec: s.dec_deg, mag: s.mag, id: s.id,
        }));

        this.constellations = constLines.segments;

        this.messier = mess.objects.map(o => ({
            id: o.id, ra: o.ra_deg, dec: o.dec_deg,
            mag: o.mag, size: o.size_arcmin?.[0] ?? 0,
            name: o.names?.[0] ?? o.id,
            type: o.type,
        }));

        this.ngc = ngc.objects.map(o => ({
            id: o.id, ra: o.ra_deg, dec: o.dec_deg,
            mag: o.mag, size: o.size_arcmin?.[0] ?? 0,
            name: o.names?.[0] ?? o.id,
            type: o.type,
        }));

        console.log(`SkyCanvas: ${this.stars.length} stars, ${this.constellations.length} constellation lines, ${this.messier.length} Messier, ${this.ngc.length} NGC`);
        this.render();
    }

    // ── Horizon / compass helpers ────────────────────────────

    _localSiderealTime() {
        const now = new Date();
        const jd = now.getTime() / 86400000 + 2440587.5;
        const T = (jd - 2451545.0) / 36525.0;
        // Greenwich Mean Sidereal Time in degrees
        let gmst = 280.46061837
                 + 360.98564736629 * (jd - 2451545.0)
                 + 0.000387933 * T * T
                 - T * T * T / 38710000.0;
        gmst = ((gmst % 360) + 360) % 360;
        return (gmst + this.siteLng) % 360; // LST in degrees
    }

    _altAzToRaDec(azDeg, altDeg) {
        const lat = this.siteLat * DEG;
        const az = azDeg * DEG;
        const alt = altDeg * DEG;
        const lst = this._localSiderealTime() * DEG;

        const sinDec = Math.sin(lat) * Math.sin(alt)
                     + Math.cos(lat) * Math.cos(alt) * Math.cos(az);
        const dec = Math.asin(sinDec);

        const ha = Math.atan2(
            -Math.cos(alt) * Math.sin(az),
            Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az)
        );

        let ra = (lst - ha) * RAD;
        ra = ((ra % 360) + 360) % 360;

        return { ra, dec: dec * RAD };
    }

    _raDecToAltAz(raDeg, decDeg) {
        const lat = this.siteLat * DEG;
        const ra = raDeg * DEG;
        const dec = decDeg * DEG;
        const lst = this._localSiderealTime() * DEG;
        const ha = lst - ra;

        const sinAlt = Math.sin(lat) * Math.sin(dec)
                     + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
        const alt = Math.asin(sinAlt);

        const az = Math.atan2(
            -Math.cos(dec) * Math.sin(ha),
            Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha)
        );

        return { az: ((az * RAD) % 360 + 360) % 360, alt: alt * RAD };
    }

    // ── Stereographic projection ─────────────────────────────

    get _chartH() { return this.h - this._compassH; }

    _project(raDeg, decDeg) {
        const ra = raDeg * DEG;
        const dec = decDeg * DEG;
        const ra0 = this.centerRa * DEG;
        const dec0 = this.centerDec * DEG;

        const cosC = Math.sin(dec0) * Math.sin(dec)
                    + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
        if (cosC <= 0) return null; // behind the projection

        const x = Math.cos(dec) * Math.sin(ra - ra0) / cosC;
        const y = (Math.cos(dec0) * Math.sin(dec)
                 - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosC;

        const halfFov = this.fov * DEG / 2;
        const scale = (this.w / 2) / Math.tan(halfFov);
        const chartH = this._chartH;

        return {
            x: this.w / 2 + x * scale,
            y: chartH / 2 - y * scale,
        };
    }

    // Inverse stereographic: pixel → RA/Dec degrees
    unproject(px, py) {
        const halfFov = this.fov * DEG / 2;
        const scale = (this.w / 2) / Math.tan(halfFov);
        const chartH = this._chartH;

        const xProj = (px - this.w / 2) / scale;
        const yProj = -(py - chartH / 2) / scale;

        const rho = Math.sqrt(xProj * xProj + yProj * yProj);
        if (rho < 1e-10) return { ra: this.centerRa, dec: this.centerDec };

        const c = 2 * Math.atan(rho / 2);
        const sinC = Math.sin(c);
        const cosC = Math.cos(c);

        const ra0 = this.centerRa * DEG;
        const dec0 = this.centerDec * DEG;

        const sinArg = cosC * Math.sin(dec0)
                     + yProj * sinC * Math.cos(dec0) / rho;
        const dec = Math.asin(Math.max(-1, Math.min(1, sinArg)));
        const ra = ra0 + Math.atan2(
            xProj * sinC,
            rho * Math.cos(dec0) * cosC - yProj * sinC * Math.sin(dec0),
        );

        return { ra: ra * RAD, dec: dec * RAD };
    }

    // ── Rendering ────────────────────────────────────────────

    render() {
        const { ctx, w, h } = this;
        if (!w || !h) return;

        const chartH = this._chartH;

        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, chartH);
        ctx.clip();

        try {
            this._drawGrid(chartH);
            this._drawHorizonVeil(chartH);
            this._drawHorizon(chartH);
            this._drawConstellations(chartH);
            this._drawStars(chartH);
            this._drawDSO(this.messier, '#55aaff', chartH);
            this._drawDSO(this.ngc, '#77cc77', chartH);
            this._drawCrosshair(chartH);
        } catch (e) {
            console.error('sky render error:', e);
        } finally {
            ctx.restore();
        }

        try {
            this._drawCompassBar(chartH);
        } catch (e) {
            console.error('sky compass error:', e);
        }
    }

    _drawGrid(chartH) {
        const { ctx } = this;

        ctx.strokeStyle = 'rgba(60, 80, 120, 0.3)';
        ctx.lineWidth = 0.5;

        // Dec lines
        for (let dec = -75; dec <= 75; dec += 15) {
            ctx.beginPath();
            let started = false;
            for (let ra = 0; ra <= 360; ra += 2) {
                const p = this._project(ra, dec);
                if (!p || p.y > chartH) { started = false; continue; }
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }

        // RA lines
        for (let ra = 0; ra < 360; ra += 30) {
            ctx.beginPath();
            let started = false;
            for (let dec = -89; dec <= 89; dec += 2) {
                const p = this._project(ra, dec);
                if (!p || p.y > chartH) { started = false; continue; }
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        }
    }

    _drawHorizonVeil(chartH) {
        const { ctx, w } = this;

        const pts = [];
        for (let az = 0; az < 360; az += 2) {
            const rd = this._altAzToRaDec(az, 0);
            const p = this._project(rd.ra, rd.dec);
            if (p && p.y < chartH) pts.push({ x: p.x, y: p.y });
        }
        if (pts.length < 3) return;

        pts.sort((a, b) => a.x - b.x);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, chartH);
        for (const pt of pts) ctx.lineTo(pt.x, pt.y);
        ctx.lineTo(pts[pts.length - 1].x, chartH);
        ctx.closePath();
        ctx.fillStyle = 'rgba(5, 5, 15, 0.7)';
        ctx.fill();
        ctx.restore();
    }

    _drawHorizon(chartH) {
        const { ctx } = this;
        const lst = this._localSiderealTime();
        const lat = this.siteLat;

        // Horizon is at alt=0; for each azimuth, compute RA/Dec and project
        const points = [];
        for (let az = 0; az < 360; az += 1) {
            const rd = this._altAzToRaDec(az, 0);
            const p = this._project(rd.ra, rd.dec);
            if (p && p.y < chartH) points.push({ az, x: p.x, y: p.y });
        }

        if (points.length < 3) return;

        // Draw horizon line
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 180, 100, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Label "HORIZON"
        if (points.length > 10) {
            const mid = points[Math.floor(points.length / 2)];
            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(100, 180, 100, 0.5)';
            ctx.fillText('--- horizon ---', mid.x - 40, mid.y - 5);
        }

        // Cardinal + intercardinal direction labels on the horizon
        const directions = [
            { az: 0, label: 'N', color: '#ff6666', bold: true },
            { az: 45, label: 'NE', color: '#cc9966', bold: false },
            { az: 90, label: 'E', color: '#ff6666', bold: true },
            { az: 135, label: 'SE', color: '#cc9966', bold: false },
            { az: 180, label: 'S', color: '#6666ff', bold: true },
            { az: 225, label: 'SW', color: '#cc9966', bold: false },
            { az: 270, label: 'W', color: '#6666ff', bold: true },
            { az: 315, label: 'NW', color: '#cc9966', bold: false },
        ];

        for (const dir of directions) {
            const rd = this._altAzToRaDec(dir.az, 0);
            const p = this._project(rd.ra, rd.dec);
            if (!p || p.y > chartH) continue;

            ctx.font = dir.bold ? 'bold 13px monospace' : '10px monospace';
            const tw = ctx.measureText(dir.label).width;
            const lx = p.x - tw / 2;
            const ly = p.y - 8;

            // Background pill
            ctx.fillStyle = 'rgba(10, 10, 26, 0.85)';
            const pad = 3;
            ctx.beginPath();
            const rx = lx - pad, ry = ly - 12, rw = tw + pad * 2, rh = 16, rr = 4;
            ctx.moveTo(rx + rr, ry);
            ctx.lineTo(rx + rw - rr, ry);
            ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + rr);
            ctx.lineTo(rx + rw, ry + rh - rr);
            ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
            ctx.lineTo(rx + rr, ry + rh);
            ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - rr);
            ctx.lineTo(rx, ry + rr);
            ctx.quadraticCurveTo(rx, ry, rx + rr, ry);
            ctx.fill();

            ctx.fillStyle = dir.color;
            ctx.fillText(dir.label, lx, ly);
        }
    }

    _drawConstellations(chartH) {
        const { ctx } = this;
        ctx.strokeStyle = 'rgba(60, 120, 200, 0.25)';
        ctx.lineWidth = 0.8;

        for (const seg of this.constellations) {
            const p1 = this._project(seg.ra1, seg.dec1);
            const p2 = this._project(seg.ra2, seg.dec2);
            if (!p1 || !p2 || p1.y > chartH || p2.y > chartH) continue;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
    }

    _drawStars(chartH) {
        const { ctx } = this;

        for (const star of this.stars) {
            const p = this._project(star.ra, star.dec);
            if (!p || p.y > chartH) continue;

            const r = Math.max(0.3, 3.0 - star.mag * 0.4);
            const brightness = Math.max(0.3, 1.0 - star.mag / 7.0);

            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(220, 230, 255, ${brightness})`;
            ctx.fill();
        }
    }

    _drawDSO(objects, color, chartH) {
        const { ctx } = this;

        for (const obj of objects) {
            const p = this._project(obj.ra, obj.dec);
            if (!p || p.y > chartH) continue;

            const halfFov = this.fov * DEG / 2;
            const scale = (this.w / 2) / Math.tan(halfFov);
            const radiusPx = Math.max(2, (obj.size / 60) * scale * DEG);

            ctx.strokeStyle = color;
            ctx.lineWidth = 1;

            if (obj.type.includes('cluster') || obj.type.includes('nebula')) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
                ctx.stroke();
                if (obj.type.includes('nebula') && !obj.type.includes('planetary')) {
                    ctx.beginPath();
                    ctx.moveTo(p.x - radiusPx - 2, p.y);
                    ctx.lineTo(p.x + radiusPx + 2, p.y);
                    ctx.moveTo(p.x, p.y - radiusPx - 2);
                    ctx.lineTo(p.x, p.y + radiusPx + 2);
                    ctx.stroke();
                }
            } else if (obj.type.includes('galaxy')) {
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, radiusPx, radiusPx * 0.6, 0, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(2, radiusPx), 0, Math.PI * 2);
                ctx.stroke();
            }

            if (this.fov < 60) {
                ctx.fillStyle = color;
                ctx.font = '10px monospace';
                ctx.fillText(obj.id, p.x + radiusPx + 3, p.y + 3);
            }
        }
    }

    _drawCrosshair(chartH) {
        if (this.telRa === null || this.telDec === null) return;
        const p = this._project(this.telRa, this.telDec);
        if (!p || p.y > chartH) return;

        const { ctx } = this;
        const r = 10;

        ctx.save();
        ctx.shadowColor = '#ff4444';
        ctx.shadowBlur = 12;

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();

        const gap = 3, ext = 10;
        ctx.beginPath();
        ctx.moveTo(p.x - r - ext, p.y); ctx.lineTo(p.x - gap, p.y);
        ctx.moveTo(p.x + gap, p.y);     ctx.lineTo(p.x + r + ext, p.y);
        ctx.moveTo(p.x, p.y - r - ext); ctx.lineTo(p.x, p.y - gap);
        ctx.moveTo(p.x, p.y + gap);     ctx.lineTo(p.x, p.y + r + ext);
        ctx.stroke();

        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // RA/Dec label
        const raH = this.telRa / 15;
        const raStr = `${String(Math.floor(raH)).padStart(2, '0')}h${String(Math.floor((raH % 1) * 60)).padStart(2, '0')}m`;
        const decSign = this.telDec >= 0 ? '+' : '-';
        const decAbs = Math.abs(this.telDec);
        const decStr = `${decSign}${String(Math.floor(decAbs)).padStart(2, '0')}\u00B0${String(Math.floor((decAbs % 1) * 60)).padStart(2, '0')}'`;
        const label = `${raStr} ${decStr}`;

        ctx.font = 'bold 11px monospace';
        const tw = ctx.measureText(label).width;
        const lx = p.x + r + 14;
        const ly = p.y - 6;

        ctx.fillStyle = 'rgba(10, 10, 26, 0.85)';
        ctx.fillRect(lx - 3, ly - 11, tw + 6, 15);

        ctx.fillStyle = '#ff6666';
        ctx.fillText(label, lx, ly);
    }

    // ── Compass bar ──────────────────────────────────────────

    _drawCompassBar(chartH) {
        const { ctx, w } = this;
        const barY = chartH;
        const barH = this._compassH;

        // Background
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, barY, w, barH);

        // Top border
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, barY);
        ctx.lineTo(w, barY);
        ctx.stroke();

        const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
        const step = this.fov < 20 ? 5 : this.fov < 60 ? 10 : 15;

        // Project each azimuth at the horizon to get its actual screen x
        const ticks = [];
        for (let az = 0; az < 360; az += step) {
            const rd = this._altAzToRaDec(az, 0);
            const p = this._project(rd.ra, rd.dec);
            if (!p || p.y > chartH) continue;

            ticks.push({
                az,
                x: p.x,
                isCard: az % 90 === 0,
                isInt: az % 45 === 0 && az % 90 !== 0,
            });
        }

        // Draw ticks
        for (const t of ticks) {
            if (t.x < -20 || t.x > w + 20) continue;

            const tickH = t.isCard ? 12 : t.isInt ? 8 : 4;

            ctx.strokeStyle = t.isCard ? '#888' : '#444';
            ctx.lineWidth = t.isCard ? 1.5 : 0.5;
            ctx.beginPath();
            ctx.moveTo(t.x, barY);
            ctx.lineTo(t.x, barY + tickH);
            ctx.stroke();

            const label = labels[t.az];
            if (label && (t.isCard || t.isInt)) {
                ctx.font = t.isCard ? 'bold 11px monospace' : '9px monospace';
                ctx.fillStyle = t.isCard ? '#e0e0e0' : '#888';
                const tw = ctx.measureText(label).width;
                ctx.fillText(label, t.x - tw / 2, barY + tickH + 11);
            }
        }

        // Center marker
        const cx = w / 2;
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, barY);
        ctx.lineTo(cx, barY + 6);
        ctx.stroke();
    }

    // ── Public API ───────────────────────────────────────────

    setTelPosition(raDeg, decDeg) {
        if (raDeg === null || decDeg === null) return;

        this.telRa = raDeg;
        this.telDec = decDeg;

        if (this.followMode && this.slewing && !this._dragging) {
            this.centerRa = raDeg;
            this.centerDec = decDeg;
        }

        this.render();
    }

    centerOnTel() {
        if (this.telRa !== null && this.telDec !== null) {
            this.centerRa = this.telRa;
            this.centerDec = this.telDec;
            this.render();
        }
    }

    // ── Events ───────────────────────────────────────────────

    _bindEvents() {
        const el = this.canvas;

        // Zoom
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
            this.fov = Math.max(this.minFov, Math.min(this.maxFov, this.fov * factor));
            this.render();
        }, { passive: false });

        // Pan
        el.addEventListener('mousedown', (e) => {
            this._dragging = true;
            this._dragStartX = e.clientX;
            this._dragStartY = e.clientY;
            this._centerRaStart = this.centerRa;
            this._centerDecStart = this.centerDec;
            el.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!this._dragging) return;
            const dx = e.clientX - this._dragStartX;
            const dy = e.clientY - this._dragStartY;
            const halfFov = this.fov * DEG / 2;
            const scale = (this.w / 2) / Math.tan(halfFov);

            const decDelta = (dy / scale) * RAD;
            const raDelta = (dx / scale) * RAD / Math.cos(this._centerDecStart * DEG);

            this.centerDec = Math.max(-89, Math.min(89, this._centerDecStart - decDelta));
            this.centerRa = ((this._centerRaStart + raDelta) % 360 + 360) % 360;

            this.render();
        });

        document.addEventListener('mouseup', () => {
            if (this._dragging) {
                this._dragging = false;
                el.style.cursor = '';
            }
        });

        // Right-click context menu on objects
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            const hit = this._hitTest(px, py);
            if (hit) {
                this._showObjectMenu(e.clientX, e.clientY, hit);
            } else {
                this._hideObjectMenu();
            }
        });

        // Hide context menu on left-click anywhere
        el.addEventListener('mousedown', (e) => {
            if (e.button === 0) this._hideObjectMenu();
        });
    }

    _hitTest(px, py) {
        const chartH = this._chartH;
        if (py > chartH) return null;

        const halfFov = this.fov * DEG / 2;
        const scale = (this.w / 2) / Math.tan(halfFov);
        const hitRadius = 12;

        let best = null, bestDist = hitRadius;

        const check = (objects, type) => {
            for (const obj of objects) {
                const p = this._project(obj.ra, obj.dec);
                if (!p || p.y > chartH) continue;
                const dx = px - p.x;
                const dy = py - p.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { ...obj, objectType: type, screenX: p.x, screenY: p.y };
                }
            }
        };

        check(this.messier, 'messier');
        check(this.ngc, 'ngc');

        // Check stars
        for (const star of this.stars) {
            const p = this._project(star.ra, star.dec);
            if (!p || p.y > chartH) continue;
            const dx = px - p.x;
            const dy = py - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = { id: star.id, ra: star.ra, dec: star.dec, mag: star.mag, objectType: 'star', screenX: p.x, screenY: p.y };
            }
        }

        return best;
    }

    _showObjectMenu(clientX, clientY, obj) {
        this._hideObjectMenu();

        const raH = obj.ra / 15;
        const raStr = `${String(Math.floor(raH)).padStart(2, '0')}h${String(Math.floor((raH % 1) * 60)).padStart(2, '0')}m${String(Math.floor(((raH * 60) % 1) * 60)).padStart(2, '0')}s`;
        const decSign = obj.dec >= 0 ? '+' : '-';
        const absDec = Math.abs(obj.dec);
        const decStr = `${decSign}${String(Math.floor(absDec)).padStart(2, '0')}°${String(Math.floor((absDec % 1) * 60)).padStart(2, '0')}'${String(Math.floor(((absDec * 60) % 1) * 60)).padStart(2, '0')}"`;

        const altAz = this._raDecToAltAz(obj.ra, obj.dec);
        const azStr = altAz.az.toFixed(1) + '°';
        const altStr = altAz.alt.toFixed(1) + '°';

        const menu = document.getElementById('obj-context-menu');
        menu.innerHTML = '';

        // Title
        const title = document.createElement('div');
        title.className = 'obj-menu-title';
        title.textContent = obj.id;
        menu.appendChild(title);

        // Object type + magnitude
        const typeLine = document.createElement('div');
        typeLine.className = 'obj-menu-sub';
        const typeLabel = { star: 'Etoile', messier: 'Messier', ngc: 'NGC' }[obj.objectType] || obj.objectType;
        typeLine.textContent = obj.mag != null ? `${typeLabel} (mag ${obj.mag.toFixed(1)})` : typeLabel;
        menu.appendChild(typeLine);

        // Coordinates
        const coords = document.createElement('div');
        coords.className = 'obj-menu-coords';
        coords.innerHTML = `RA: ${raStr} (${raH.toFixed(4)}h)<br>Dec: ${decStr} (${obj.dec.toFixed(4)}°)<br>Az: ${azStr}  Alt: ${altStr}`;
        menu.appendChild(coords);

        // GOTO button
        const gotoBtn = document.createElement('button');
        gotoBtn.className = 'obj-menu-btn';
        gotoBtn.textContent = 'GOTO';
        gotoBtn.addEventListener('click', () => {
            const raH = obj.ra / 15;
            fetch('/api/mount/slew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ra_hours: raH, dec_deg: obj.dec }),
            });
            this._hideObjectMenu();
        });
        menu.appendChild(gotoBtn);

        menu.style.display = 'block';
        menu.style.left = clientX + 'px';
        menu.style.top = clientY + 'px';

        // Ensure menu stays within viewport
        requestAnimationFrame(() => {
            const mr = menu.getBoundingClientRect();
            if (mr.right > window.innerWidth) menu.style.left = (clientX - mr.width) + 'px';
            if (mr.bottom > window.innerHeight) menu.style.top = (clientY - mr.height) + 'px';
        });
    }

    _hideObjectMenu() {
        const menu = document.getElementById('obj-context-menu');
        if (menu) menu.style.display = 'none';
    }

    _resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        this.w = rect.width;
        this.h = rect.height;
        this.canvas.width = this.w;
        this.canvas.height = this.h;
        this.render();
    }

    destroy() {
        this._ro?.disconnect();
    }
}
