/* ═══════════════════════════════════════════════════════════════════
   Noctua — Internationalisation (FR / EN)
   Chargé APRÈS i18n.fr.js et i18n.en.js (qui peuplent global.I18N_DICTS).
   Expose global.NoctuaI18n (alias I18N).
   Principes :
     - éléments statiques : data-i18n="clé" (texte), data-i18n-title="clé",
                            data-i18n-placeholder="clé"
     - chaînes dynamiques JS : I18N.t('clé') ou I18N.tfmt('clé', {var})
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'noctua_lang';
    const SUPPORTED = ['fr', 'en'];

    // Dictionnaires fournis par i18n.fr.js / i18n.en.js
    const dict = global.I18N_DICTS || {};

    let lang = 'fr';
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && SUPPORTED.includes(saved)) {
            lang = saved;
        } else {
            const nav = (navigator.language || 'fr').toLowerCase().slice(0, 2);
            if (SUPPORTED.includes(nav)) lang = nav;
        }
    } catch (e) { /* localStorage indisponible */ }

    function t(key) {
        const cur = dict[lang] || {};
        const fallback = dict.fr || {};
        return (key in cur) ? cur[key] : ((key in fallback) ? fallback[key] : key);
    }

    function tfmt(key, vars) {
        let out = t(key);
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                out = out.replaceAll('{' + k + '}', String(v));
            }
        }
        return out;
    }

    function apply(root) {
        if (!root) root = document;
        root.querySelectorAll('[data-i18n]').forEach(el => {
            el.textContent = t(el.dataset.i18n);
        });
        root.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.setAttribute('title', t(el.dataset.i18nTitle));
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
        });
    }

    function setLang(next) {
        if (!SUPPORTED.includes(next)) return;
        lang = next;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
        document.documentElement.lang = lang;
        apply();
        document.dispatchEvent(new CustomEvent('i18n:change'));
    }

    function getLang() { return lang; }

    const api = {
        t, tfmt, apply, setLang, getLang, SUPPORTED,
        get current() { return lang; },
    };
    global.NoctuaI18n = api;
    global.I18N = api;

    // Application initiale dès que le DOM est prêt
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.lang = lang;
            api.apply();
        });
    } else {
        document.documentElement.lang = lang;
        api.apply();
    }
})(window);
