function toggleMinimize(panel) {
    const wasCollapsed = panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    const minBtn = panel.querySelector('.applet-minimize');
    if (minBtn) minBtn.classList.toggle('collapsed-label', !wasCollapsed);
    currentModeConfig().collapsed = currentModeConfig().collapsed || {};
    currentModeConfig().collapsed[panel.id] = !wasCollapsed;
    saveUiConfig();
}

function applyCollapsedState() {
    const modeCfg = currentModeConfig();
    const collapsed = modeCfg.collapsed || {};
    for (const [id, isCollapsed] of Object.entries(collapsed)) {
        if (!isCollapsed) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('collapsed');
        const btn = el.querySelector('.applet-minimize');
        if (btn) btn.classList.add('collapsed-label');
    }
}

function checkOverlap() {
    const panels = [];
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar' || el.id === 'applet-connection') return;
        if (el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        panels.push({ el, rect });
    });

    for (let i = 0; i < panels.length; i++) {
        for (let j = i + 1; j < panels.length; j++) {
            const a = panels[i].rect;
            const b = panels[j].rect;
            const overlap = !(a.right <= b.left || b.right <= a.left ||
                              a.bottom <= b.top || b.bottom <= a.top);
            if (overlap) {
                const el = panels[j].el;
                // Push the second panel below the first; if it would fall off
                // the bottom, slide it to the right instead. Either way, clamp
                // it back into the viewport so it never ends up off-screen.
                const vw = window.innerWidth, vh = window.innerHeight;
                const margin = 8;
                let left = el.getBoundingClientRect().left;
                let top = a.bottom + margin;
                if (top + b.height > vh - margin) {
                    top = Math.min(b.top, a.top);
                    left = a.right + margin;
                }
                left = Math.max(margin, Math.min(left, vw - b.width - margin));
                top = Math.max(margin, Math.min(top, vh - b.height - margin));
                el.style.left = left + 'px';
                el.style.top = top + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                el.style.transform = 'none';
                panels[j].rect = el.getBoundingClientRect();
            }
        }
    }
}

function getBlockingRects(excludeEl) {
    const rects = [];
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el === excludeEl) return;
        if (el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        rects.push(r);
    });
    return rects;
}

function loadAppletPositions() {
    const modeCfg = currentModeConfig();
    const positions = modeCfg.applets || {};
    for (const [id, pos] of Object.entries(positions)) {
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

// Run the two layout passes and re-clamp afterwards, so panels always end up
// inside the viewport after overlap resolution.
function resolvePanelLayout() {
    sanitizePanelLayout();
    checkOverlap();
    sanitizePanelLayout();
}

// Enforce the "no overlapping panels" rule: clamp every visible applet back
// into the viewport and keep it clear of the mode bar / connection bar.
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
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar' || el.id === 'applet-connection') return;
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
    document.querySelectorAll('.glass-panel.applet').forEach(el => {
        if (el.id === 'applet-mode-bar') return;
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

