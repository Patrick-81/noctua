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
                el.cb.style.background = '#00cc88';
                el.cb.style.borderColor = '#00cc88';
                el.cb.style.color = '#000';
                el.label.style.color = '#888';
            } else {
                el.cb.textContent = '';
                el.cb.style.background = 'transparent';
                el.cb.style.borderColor = '#555';
                el.cb.style.color = '#ccc';
                el.label.style.color = '#ff6644';
            }
        }
    }
}

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
    saveUiConfig();
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
}

function loadAppletPositions() {
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

