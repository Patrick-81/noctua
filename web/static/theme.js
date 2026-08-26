// ═══════════════════════════════════════════════════════════════
// Noctua — Thème (sélection et persistence)
// ═══════════════════════════════════════════════════════════════

const ThemeManager = {
    STORAGE_KEY: 'noctua-theme',
    DEFAULT: 'noctua',

    init() {
        const saved = localStorage.getItem(this.STORAGE_KEY) || this.DEFAULT;
        this.apply(saved);
        this.bindUI();
    },

    apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(this.STORAGE_KEY, theme);
    },

    bindUI() {
        const sel = document.getElementById('theme-select');
        if (!sel) return;
        sel.value = document.documentElement.getAttribute('data-theme') || this.DEFAULT;
        sel.addEventListener('change', (e) => {
            this.apply(e.target.value);
        });
    }
};

document.addEventListener('DOMContentLoaded', () => ThemeManager.init());
