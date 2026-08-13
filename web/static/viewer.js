export class ChecklistPanel {
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

// ── Viewer Configurable ──────────────────────────────────────────
