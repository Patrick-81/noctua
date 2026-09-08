// flatpanel frontend — panneau applet minimal (P2.2)
// S'abonne au Hub pour l'état du panel ; expose les contrôles brightness/light.

(function() {
    const PANEL_ID = 'applet-flatpanel';

    function ensurePanel() {
        if (document.getElementById(PANEL_ID)) return;
        const layer = document.getElementById('applets-layer') || document.body;
        const el = document.createElement('div');
        el.id = PANEL_ID;
        el.className = 'glass-panel applet mode-specific';
        el.dataset.modes = 'capture';
        el.style.cssText = 'display:none; top:16px; right:16px; width:260px;';
        el.innerHTML = `
            <div class="applet-drag"><span class="drag-icon">⣿⣿</span><span class="hud-title" style="margin:0;border:none;padding:0;font-size:0.7rem;">▣ FLAT PANEL</span><button class="applet-minimize"></button></div>
            <div style="padding:6px 8px;">
                <div class="solver-row" style="justify-content:space-between;">
                    <span style="font-size:0.6rem;color:#aaa;">État</span>
                    <span id="flatpanel-state" style="font-size:0.6rem;color:#888;">—</span>
                </div>
                <div class="solver-row" style="gap:6px; margin-top:6px;">
                    <button id="flatpanel-light-on" class="btn-glass success" style="flex:1;font-size:0.6rem;">💡 ON</button>
                    <button id="flatpanel-light-off" class="btn-glass" style="flex:1;font-size:0.6rem;">○ OFF</button>
                </div>
                <div class="solver-row" style="gap:6px; margin-top:6px;">
                    <span style="font-size:0.6rem;color:#aaa;">Luminosité</span>
                    <input id="flatpanel-bright" type="range" min="0" max="255" value="0" style="flex:1;">
                    <span id="flatpanel-bright-val" style="font-size:0.6rem; width:28px; text-align:right;">0</span>
                </div>
                <div id="flatpanel-log" style="font-size:0.55rem;color:#666;margin-top:6px;"></div>
            </div>`;
        layer.appendChild(el);
        // wiring
        document.getElementById('flatpanel-light-on')?.addEventListener('click', () => flatSetLight(true));
        document.getElementById('flatpanel-light-off')?.addEventListener('click', () => flatSetLight(false));
        const br = document.getElementById('flatpanel-bright');
        const bv = document.getElementById('flatpanel-bright-val');
        if (br) br.addEventListener('input', (e) => {
            if (bv) bv.textContent = e.target.value;
        });
        if (br) br.addEventListener('change', (e) => flatSetBrightness(parseInt(e.target.value,10)));
        // Hub
        if (window.Hub) {
            Hub.subscribe('ws:state', 'flatpanel', () => refresh());
        }
        refresh();
    }

    async function refresh() {
        try {
            const r = await fetch('/api/flatpanel/status').then(x=>x.json());
            const st = document.getElementById('flatpanel-state');
            const bv = document.getElementById('flatpanel-bright-val');
            const br = document.getElementById('flatpanel-bright');
            if (!r.ok) { if(st) st.textContent = r.error || '—'; return; }
            const p = r.panel;
            if(st) st.textContent = (p.light_on ? '💡 ON' : '○ OFF') + ` ${p.brightness}/255` + (p.connected ? ' ●' : ' ○');
            if(br) br.value = p.brightness;
            if(bv) bv.textContent = p.brightness;
        } catch(e) {}
    }
    async function flatSetLight(on) {
        try {
            const r = await fetch('/api/flatpanel/light', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({on})}).then(x=>x.json());
            if(!r.ok) addLog('error','flatpanel', r.error || 'light failed');
            else addLog('info','flatpanel', on ? 'Flat light ON' : 'Flat light OFF');
            refresh();
        } catch(e) { addLog('error','flatpanel', e.message); }
    }
    async function flatSetBrightness(v) {
        try {
            const r = await fetch('/api/flatpanel/brightness', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({brightness: v})}).then(x=>x.json());
            if(!r.ok) addLog('error','flatpanel', r.error || 'brightness failed');
            refresh();
        } catch(e) { addLog('error','flatpanel', e.message); }
    }

    // expose
    window.FlatPanel = { ensurePanel, refresh };
    // auto-create when DOM ready
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensurePanel);
    else ensurePanel();
})();
