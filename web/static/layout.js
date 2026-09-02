// ═══════════════════════════════════════════════════════════════
// Noctua — Layout / panneaux flottants + ChecklistPanel
// ═══════════════════════════════════════════════════════════════

class ChecklistPanel {
    constructor(containerId, items) {
        this.container = document.getElementById(containerId);
        this.items = items;
        this._els = [];
        if (this.container) this._build();
    }
    _build() {
        this.container.innerHTML = '';
        for (const item of this.items) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 0; cursor:pointer;';
            const cb = document.createElement('span');
            cb.style.cssText = 'width:16px; height:16px; border:1.5px solid #555; border-radius:3px; display:flex; align-items:center; justify-content:center; font-size:0.55rem; flex-shrink:0; transition:0.2s;';
            const label = document.createElement('span');
            label.style.cssText = 'font-size:0.6rem; color:#ccc;';
            label.textContent = item.label;
            row.appendChild(cb);
            row.appendChild(label);
            row.addEventListener('click', () => {
                if (!item.checked) item.action?.();
            });
            this.container.appendChild(row);
            this._els.push({ row, cb, label, item });
        }
    }
    update() {
        for (const el of this._els) {
            const checked = !!el.item.check();
            el.item.checked = checked;
            if (checked) {
                el.cb.textContent = '✓';
                el.cb.style.background = cssVar('--accent');
                el.cb.style.borderColor = cssVar('--accent');
                el.cb.style.color = '#000';
                el.label.style.color = '#888';
            } else {
                el.cb.textContent = '';
                el.cb.style.background = 'transparent';
                el.cb.style.borderColor = '#555';
                el.cb.style.color = '#ccc';
                el.label.style.color = cssVar('--status-warning');
            }
        }
    }
}

const PANEL_ICONS = {
    'applet-status': '◈', 'applet-pilotage': '🔭', 'applet-hud': '🗺',
    'applet-focuser-control': '🔍', 'applet-focuser-position': '📈', 'applet-autofocus': '◎',
    'applet-guide-checklist': '☑', 'applet-guide-preview': '👁', 'applet-guiding-graph': '📉',
    'applet-guiding-settings': '⚙', 'applet-calibration': '🎯', 'applet-session': '📋',
    'applet-capture-settings': '📷', 'applet-capture-preview': '🖼', 'applet-sequence': '📋',
    'applet-sequencer': '📋', 'applet-stacking': '🥞', 'applet-solver': '⭐',
    'applet-target': '🎯', 'applet-framing': '🖼', 'applet-polar': '🧭',
    'applet-pointing': '📍', 'applet-hardware-mode': '🔧', 'applet-legend': '▦', 'applet-log': '≡'
};
const PANEL_TITLES = {
    'applet-status': 'Tableau de bord', 'applet-pilotage': 'Pilotage monture',
    'applet-hud': 'Console de pointage', 'applet-focuser-control': 'Focuser',
    'applet-focuser-position': 'Focus — HFR', 'applet-autofocus': 'Autofocus V-curve',
    'applet-guide-checklist': 'Guidage — Checklist', 'applet-guide-preview': 'Guidage — Aperçu',
    'applet-guiding-graph': 'Guidage — Dérive', 'applet-guiding-settings': 'Guidage — Paramètres',
    'applet-calibration': 'Calibration monture', 'applet-session': 'Session',
    'applet-capture-settings': 'Capture', 'applet-capture-preview': 'Aperçu',
    'applet-sequence': 'Séquence', 'applet-sequencer': 'Séquenceur',
    'applet-stacking': 'Live stacking', 'applet-solver': 'Plate solver',
    'applet-target': 'Cible — Centrage', 'applet-framing': 'Framing — Cadrage',
    'applet-polar': 'Mise en station polaire', 'applet-pointing': 'Pointing model',
    'applet-hardware-mode': 'Matériel', 'applet-legend': 'Légende', 'applet-log': 'Log'
};
function getPanelTitle(id) {
    const el = document.getElementById(id);
    if (!el) return PANEL_TITLES[id] || id;
    const t = el.querySelector('.hud-title');
    if (t && t.textContent.trim()) return t.textContent.trim().replace(/^[◈◎▣▦≡]+\s*/, '');
    return PANEL_TITLES[id] || id;
}
function updateMobileDock() {
    const dock = document.getElementById('mobile-dock');
    if (!dock) return;
    if (window.innerWidth >= 1100) { dock.innerHTML = ''; dock.style.display = 'none'; return; }
    dock.style.display = 'flex';
    const ids = (MODES[currentMode]?.applets || []).slice();
    // Inclure le dashboard s'il est visible dans ce mode (toujours visible sauf hardware)
    if (!ids.includes('applet-status') && document.getElementById('applet-status')?.style.display !== 'none') {
        ids.unshift('applet-status');
    }
    dock.innerHTML = '';
    ids.forEach(id => {
        const panel = document.getElementById(id);
        if (!panel) return;
        if (panel.style.display === 'none' && panel.classList.contains('mode-specific')) return;
        // Ne pas dupliquer les panneaux masqués par le mode (display none)
        if (getComputedStyle(panel).display === 'none' && !ids.includes(id)) return;
        const isVisible = !panel.classList.contains('collapsed') && getComputedStyle(panel).display !== 'none' && panel.offsetParent !== null;
        // Sur mobile, offsetParent null si display none, mais on veut quand même une icône pour les cachés
        const isHidden = panel.classList.contains('collapsed') || panel.style.display === 'none';
        const btn = document.createElement('button');
        btn.className = 'dock-btn' + (!isHidden ? ' active' : '');
        btn.dataset.panel = id;
        const icon = PANEL_ICONS[id] || '◈';
        btn.textContent = icon;
        const title = getPanelTitle(id);
        btn.title = title + (!isHidden ? ' — affiché' : ' — masqué');
        btn.setAttribute('aria-label', title);
        btn.addEventListener('click', () => {
            const p = document.getElementById(id);
            if (!p) return;
            const willShow = p.classList.contains('collapsed') || getComputedStyle(p).display === 'none';
            if (willShow) {
                p.classList.remove('collapsed');
                p.style.display = '';
                // Retire l'état collapsed persisté
                if (['applet-log','applet-legend'].includes(id)) {
                    if (uiConfig.fixedCollapsed) uiConfig.fixedCollapsed[id] = false;
                } else {
                    if (currentModeConfig().collapsed) currentModeConfig().collapsed[id] = false;
                }
                const minBtn = p.querySelector('.applet-minimize');
                if (minBtn) minBtn.classList.remove('collapsed-label');
                // Scroll doux vers le panneau sans déplacer la carte (stack scroll)
                requestAnimationFrame(() => {
                    const stack = document.getElementById('mobile-stack');
                    if (stack && p.closest('#mobile-stack')) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
            } else {
                p.classList.add('collapsed');
                const minBtn = p.querySelector('.applet-minimize');
                if (minBtn) minBtn.classList.add('collapsed-label');
                if (['applet-log','applet-legend'].includes(id)) {
                    uiConfig.fixedCollapsed = uiConfig.fixedCollapsed || {};
                    uiConfig.fixedCollapsed[id] = true;
                } else {
                    currentModeConfig().collapsed = currentModeConfig().collapsed || {};
                    currentModeConfig().collapsed[id] = true;
                }
            }
            saveUiConfig();
            updateMobileDock();
        });
        dock.appendChild(btn);
    });
}
// Compat : ancien nom appelé par app.js
function positionMobileDrawers() { updateMobileDock(); }
function toggleMinimize(panel) {
    const wasCollapsed = panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    const minBtn = panel.querySelector('.applet-minimize');
    if (minBtn) minBtn.classList.toggle('collapsed-label', !wasCollapsed);
    const isFixed = ['applet-log', 'applet-legend'].includes(panel.id);
    if (isFixed) {
        uiConfig.fixedCollapsed = uiConfig.fixedCollapsed || {};
        uiConfig.fixedCollapsed[panel.id] = !wasCollapsed;
    } else {
        currentModeConfig().collapsed = currentModeConfig().collapsed || {};
        currentModeConfig().collapsed[panel.id] = !wasCollapsed;
    }
    if (wasCollapsed) {
        // Expansion : retire le positionnement tiroir (important inclus)
        panel.style.removeProperty('top');
        panel.style.removeProperty('right');
        panel.style.removeProperty('left');
        panel.style.removeProperty('bottom');
        const di = panel.querySelector('.drag-icon');
        if (di) di.textContent = '⣿⣿';
    }
    saveUiConfig();
    positionMobileDrawers();
}

function applyCollapsedState() {
    const modeCfg = currentModeConfig();
    const collapsed = { ...modeCfg.collapsed, ...(uiConfig.fixedCollapsed || {}) };
    for (const [id, isCollapsed] of Object.entries(collapsed)) {
        if (!isCollapsed) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('collapsed');
        const btn = el.querySelector('.applet-minimize');
        if (btn) btn.classList.add('collapsed-label');
    }
    positionMobileDrawers();
}

function loadAppletPositions() {
    // Épure : grille desktop (≥1100px) — plus de positions absolute sauvegardées
    if (window.innerWidth >= 1100) { applyCollapsedState(); return; }
    // P0 responsive : en <1100px on laisse le flux CSS vertical, pas d'absolute
    if (window.innerWidth < 1100) { applyCollapsedState(); return; }
    const modeCfg = currentModeConfig();
    const positions = modeCfg.applets || {};
    const FIXED_PANELS = ['applet-log', 'applet-legend'];
    for (const [id, pos] of Object.entries(positions)) {
        if (FIXED_PANELS.includes(id)) continue;
        const el = document.getElementById(id);
        if (!el || id === 'applet-mode-bar') continue;
        if (pos.left != null) el.style.left = pos.left;
        else el.style.left = 'auto';
        if (pos.top != null) el.style.top = pos.top;
        else el.style.top = 'auto';
        if (pos.right != null) el.style.right = pos.right;
        else el.style.right = 'auto';
        if (pos.bottom != null) el.style.bottom = pos.bottom;
        else el.style.bottom = 'auto';
        if (pos.transform) el.style.transform = pos.transform;
        else el.style.transform = 'none';
    }
    applyCollapsedState();
    requestAnimationFrame(() => resolvePanelLayout());
}

// Clamp panels inside the viewport and clear of the mode/connection bars.
function resolvePanelLayout() {
    sanitizePanelLayout();
}

// Clamp every visible applet inside the viewport and clear of the
// mode bar / connection bar. Panels may freely overlap each other.
function sanitizePanelLayout() {
    // Épure : grille gère le placement, plus de clamp
    return;
    if (window.innerWidth < 1100) return;
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;

    // The connection bar is centered and must stay clear of the mode bar.
    const modeBar = document.getElementById('applet-mode-bar');
    const conn = document.getElementById('applet-connection');
    if (modeBar && conn && conn.offsetParent !== null) {
        const mb = modeBar.getBoundingClientRect();
        const cb = conn.getBoundingClientRect();
        if (cb.left < mb.right && cb.top < mb.bottom) {
            conn.style.top = (mb.bottom + margin) + 'px';
        }
    }

    const blockers = ['applet-mode-bar', 'applet-connection'].map(id => {
        const el = document.getElementById(id);
        return el ? el.getBoundingClientRect() : { right: 0, bottom: 0, left: 0, top: 0 };
    });
    const FIXED_PANELS = ['applet-log', 'applet-legend'];
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar' || el.id === 'applet-connection') return;
        if (FIXED_PANELS.includes(el.id)) return;
        if (el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        let left = rect.left, top = rect.top;
        left = Math.max(margin, Math.min(left, vw - rect.width - margin));
        top = Math.max(margin, Math.min(top, vh - rect.height - margin));
        for (const b of blockers) {
            if (left < b.right && top < b.bottom) {
                top = Math.max(top, b.bottom + margin);
            }
        }
        if (left !== rect.left || top !== rect.top) {
            el.style.left = left + 'px';
            el.style.top = top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';
        }
    });
}

function saveAppletPositions() {
    if (window.innerWidth < 1100) return;
    const modeCfg = currentModeConfig();
    const positions = {};
    const FIXED_PANELS = ['applet-log', 'applet-legend'];
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar') return;
        if (FIXED_PANELS.includes(el.id)) return;
        const s = el.style;
        const hasLeft = s.left && s.left !== 'auto';
        const hasTop = s.top && s.top !== 'auto';
        const hasRight = s.right && s.right !== 'auto';
        const hasBottom = s.bottom && s.bottom !== 'auto';
        const hasTransform = s.transform && s.transform !== 'none';
        if (hasLeft || hasTop || hasRight || hasBottom) {
            positions[el.id] = {
                left: hasLeft ? s.left : null,
                top: hasTop ? s.top : null,
                right: hasRight ? s.right : null,
                bottom: hasBottom ? s.bottom : null,
            };
            if (hasTransform) positions[el.id].transform = s.transform;
        }
    });
    modeCfg.applets = positions;
    saveUiConfig();
}

