/**
 * sky-canvas.js — Client-side stereographic sky chart.
 *
 * Pure JS, no dependencies. Loads catalogs once, renders on HTML5 Canvas.
 * Supports zoom (mousewheel), pan (drag), telescope crosshair overlay.
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

    // ── Stereographic projection ─────────────────────────────

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

        return {
            x: this.w / 2 + x * scale,
            y: this.h / 2 - y * scale,
        };
    }

    // Inverse stereographic: pixel → RA/Dec degrees
    unproject(px, py) {
        const halfFov = this.fov * DEG / 2;
        const scale = (this.w / 2) / Math.tan(halfFov);

        const xProj = (px - this.w / 2) / scale;
        const yProj = -(py - this.h / 2) / scale;

        const rho = Math.sqrt(xProj * xProj + yProj * yProj);
        if (rho < 1e-10) return { ra: this.centerRa, dec: this.centerDec };

        const c = 2 * Math.atan(rho / 2);
        const sinC = Math.sin(c);
        const cosC = Math.cos(c);

        const ra0 = this.centerRa * DEG;
        const dec0 = this.centerDec * DEG;

        const dec = Math.asin(
            cosC * Math.sin(dec0)
            + yProj * sinC * Math.cos(dec0) / rho
        );
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

        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, w, h);

        this._drawGrid();
        this._drawConstellations();
        this._drawStars();
        this._drawDSO(this.messier, '#55aaff');
        this._drawDSO(this.ngc, '#77cc77');
        this._drawCrosshair();
    }

    _drawGrid() {
        const { ctx } = this;

        // RA lines every 2h (30°) and Dec lines every 15°
        ctx.strokeStyle = 'rgba(60, 80, 120, 0.3)';
        ctx.lineWidth = 0.5;
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(80, 100, 140, 0.5)';

        // Dec lines
        for (let dec = -75; dec <= 75; dec += 15) {
            ctx.beginPath();
            let started = false;
            for (let ra = 0; ra <= 360; ra += 2) {
                const p = this._project(ra, dec);
                if (!p) { started = false; continue; }
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();

            // Label
            const labelP = this._project(this.centerRa + this.fov * 0.45, dec);
            if (labelP) {
                ctx.fillText(`${dec >= 0 ? '+' : ''}${dec}°`, labelP.x + 4, labelP.y - 3);
            }
        }

        // RA lines
        for (let ra = 0; ra < 360; ra += 30) {
            ctx.beginPath();
            let started = false;
            for (let dec = -89; dec <= 89; dec += 2) {
                const p = this._project(ra, dec);
                if (!p) { started = false; continue; }
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();

            // Label
            const labelP = this._project(ra, this.centerDec - this.fov * 0.4);
            if (labelP) {
                const h = Math.round(ra / 15);
                ctx.fillText(`${h}h`, labelP.x - 6, labelP.y + 14);
            }
        }
    }

    _drawConstellations() {
        const { ctx } = this;
        ctx.strokeStyle = 'rgba(60, 120, 200, 0.25)';
        ctx.lineWidth = 0.8;

        for (const seg of this.constellations) {
            const p1 = this._project(seg.ra1, seg.dec1);
            const p2 = this._project(seg.ra2, seg.dec2);
            if (!p1 || !p2) continue;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
    }

    _drawStars() {
        const { ctx } = this;

        for (const star of this.stars) {
            const p = this._project(star.ra, star.dec);
            if (!p) continue;

            // Magnitude → radius: mag 0 → 3px, mag 7 → 0.3px
            const r = Math.max(0.3, 3.0 - star.mag * 0.4);
            const brightness = Math.max(0.3, 1.0 - star.mag / 7.0);

            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(220, 230, 255, ${brightness})`;
            ctx.fill();
        }
    }

    _drawDSO(objects, color) {
        const { ctx } = this;

        for (const obj of objects) {
            const p = this._project(obj.ra, obj.dec);
            if (!p) continue;

            // Size in pixels (approximate)
            const halfFov = this.fov * DEG / 2;
            const scale = (this.w / 2) / Math.tan(halfFov);
            const radiusPx = Math.max(2, (obj.size / 60) * scale * DEG);

            // Draw symbol based on type
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;

            if (obj.type.includes('cluster') || obj.type.includes('nebula')) {
                // Circle for clusters/nebulae
                ctx.beginPath();
                ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2);
                ctx.stroke();
                // Cross for emission/dark nebulae
                if (obj.type.includes('nebula') && !obj.type.includes('planetary')) {
                    ctx.beginPath();
                    ctx.moveTo(p.x - radiusPx - 2, p.y);
                    ctx.lineTo(p.x + radiusPx + 2, p.y);
                    ctx.moveTo(p.x, p.y - radiusPx - 2);
                    ctx.lineTo(p.x, p.y + radiusPx + 2);
                    ctx.stroke();
                }
            } else if (obj.type.includes('galaxy')) {
                // Ellipse for galaxies
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, radiusPx, radiusPx * 0.6, 0, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                // Default: open circle
                ctx.beginPath();
                ctx.arc(p.x, p.y, Math.max(2, radiusPx), 0, Math.PI * 2);
                ctx.stroke();
            }

            // Label (only if FOV wide enough)
            if (this.fov < 60) {
                ctx.fillStyle = color;
                ctx.font = '10px monospace';
                ctx.fillText(obj.id, p.x + radiusPx + 3, p.y + 3);
            }
        }
    }

    _drawCrosshair() {
        if (this.telRa === null || this.telDec === null) return;
        const p = this._project(this.telRa, this.telDec);
        if (!p) return;

        const { ctx } = this;
        const size = 16;

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;

        // Circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.stroke();

        // Cross lines
        ctx.beginPath();
        ctx.moveTo(p.x - size - 6, p.y);
        ctx.lineTo(p.x - size + 2, p.y);
        ctx.moveTo(p.x + size - 2, p.y);
        ctx.lineTo(p.x + size + 6, p.y);
        ctx.moveTo(p.x, p.y - size - 6);
        ctx.lineTo(p.x, p.y - size + 2);
        ctx.moveTo(p.x, p.y + size - 2);
        ctx.lineTo(p.x, p.y + size + 6);
        ctx.stroke();
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

            // Convert pixel delta to RA/Dec delta
            const decDelta = (dy / scale) * RAD;
            const raDelta = (dx / scale) * RAD / Math.cos(this._centerDecStart * DEG);

            this.centerDec = Math.max(-89, Math.min(89, this._centerDecStart - decDelta));
            this.centerRa = this._centerRaStart + raDelta;

            this.render();
        });

        document.addEventListener('mouseup', () => {
            if (this._dragging) {
                this._dragging = false;
                el.style.cursor = '';
            }
        });
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
