// ═══════════════════════════════════════════════════════════════
// Noctua — Contrôles monture (D-pad, boutons d'action, joystick)
// Extraits d'app.js (script classique, globals partagés).
// Dépendances globales : mount.js (commandes), api.js (log/toast), state.js, utils.js.
// ═══════════════════════════════════════════════════════════════

// ── D-pad ─────────────────────────────────────────────────────

function initDpad() {
    const dpad = document.querySelector('.dpad');
    if (!dpad) return;

    let activeDir = null;
    let activeBtn = null;

    function startMove(dir, btn) {
        if (dir === 'stop') { stopMove(); mountAbort(); return; }
        if (activeDir === dir) return;
        if (activeDir) stopMove();
        activeDir = dir;
        activeBtn = btn;
        if (btn) btn.classList.add('active');
        mountMove(dir);
    }

    function stopMove() {
        if (!activeDir) return;
        if (activeBtn) activeBtn.classList.remove('active');
        activeDir = null;
        activeBtn = null;
        mountHaltMove();
    }

    dpad.querySelectorAll('[data-dir]').forEach(btn => {
        const dir = btn.dataset.dir;
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.setPointerCapture(e.pointerId);
            startMove(dir, btn);
        });
        btn.addEventListener('pointerup', (e) => {
            e.preventDefault();
            stopMove();
        });
        btn.addEventListener('pointercancel', () => stopMove());
    });

    document.addEventListener('pointerup', () => stopMove());

    const stopBtn = document.getElementById('btn-dpad-stop') || document.querySelector('.dpad-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => { stopMove(); mountAbort(); });
}

// ── Action buttons ────────────────────────────────────────────

function initButtons() {
    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    };

    bind('btn-goto', mountGoto);
    bind('btn-tracking', mountToggleTracking);
    bind('btn-park-toggle', () => {
        const m = findMount();
        if (!m) return;
        if (m.dev.parked) mountUnpark(); else mountPark();
    });
    bind('btn-home', mountHome);
    bind('btn-set-park', () => { addLog('info','mount','SET PARK demandé'); apiPost('/api/mount/park/set'); });
    bind('btn-set-home', () => { addLog('info','mount','SET HOME demandé'); apiPost('/api/mount/home/set'); });
    bind('btn-flip', mountFlip);
    bind('flip-enabled', () => { saveFlipConfig(); });
    bind('flip-margin', () => { saveFlipConfig(); });
    bind('flip-min-alt', () => { saveFlipConfig(); });
    bind('btn-emergency', () => {
        mountAbort();
        mountToggleTracking();
        addLog('warning', 'mount', i18n('log.mount.emergency'));
    });
    bind('btn-center-tel', () => { if (skyEngine) skyEngine.centerOnTel(); });
    bind('btn-sync', () => {
        if (!skyEngine) return;
        let ra = -skyEngine._currentRotation[0];
        let dec = -skyEngine._currentRotation[1];
        if (ra < 0) ra += 360;
        if (ra >= 360) ra -= 360;
        apiPost('/api/mount/slew', { ra_hours: ra / 15, dec_deg: dec });
    });

    bind('log-clear', clearLog);
    bind('log-copy', copyLog);

    document.querySelectorAll('.log-filters input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            applyLogFilters();
            if (!uiConfig.log_levels) uiConfig.log_levels = {};
            uiConfig.log_levels[cb.dataset.level] = cb.checked;
            saveUiConfig();
        });
    });
}

// ── Joystick (slew continu) ──────────────────────────────────

function initJoystick() {
    let slewInterval = null;
    let currentDir = null;

    function startSlew(dir) {
        const m = findMount();
        if (!m) { addLog('warning', 'mount', 'Pas de monture detectee'); return; }
        if (m.dev.parked) { addLog('warning', 'mount', 'Monture parquée — déparquez d\'abord (UNPARK)'); return; }
        if (currentDir === dir) return;
        stopSlew();
        currentDir = dir;
        mountMove(dir);
        slewInterval = setInterval(() => {
            renderMountPanel();
        }, 500);
    }

    function stopSlew() {
        if (slewInterval) { clearInterval(slewInterval); slewInterval = null; }
        if (currentDir) {
            mountHaltMove();
            currentDir = null;
        }
    }

    document.querySelectorAll('.joy-btn[data-dir]').forEach(btn => {
        const dir = btn.dataset.dir;
        if (dir === 'stop') {
            btn.addEventListener('click', stopSlew);
            btn.addEventListener('pointerdown', (e) => { e.preventDefault(); stopSlew(); mountAbort(); });
            return;
        }
        // Pointer events couvrent souris + tactile + stylet (robuste)
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
            startSlew(dir);
        });
        btn.addEventListener('pointerup', (e) => {
            e.preventDefault();
            if (currentDir === dir) stopSlew();
        });
        btn.addEventListener('pointercancel', () => { if (currentDir === dir) stopSlew(); });
        // Fallbacks legacy (si pointer events non supportés)
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); startSlew(dir); });
        btn.addEventListener('mouseup', (e) => { e.preventDefault(); if (currentDir === dir) stopSlew(); });
        btn.addEventListener('mouseleave', () => { if (currentDir === dir) stopSlew(); });
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); startSlew(dir); }, { passive: false });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); if (currentDir === dir) stopSlew(); }, { passive: false });
        btn.addEventListener('touchcancel', () => { if (currentDir === dir) stopSlew(); });
    });

    // Relâchement global (pointer relâché hors bouton)
    document.addEventListener('pointerup', () => { if (currentDir) stopSlew(); });
}
