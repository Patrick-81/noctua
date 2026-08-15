// Pure helpers extracted from app.js — no DOM/state deps (except i18n loaded as global)

// ── Traduction (délègue à I18N, global défini par i18n.js) ──
function i18n(key) {
    return (typeof I18N !== 'undefined' && typeof I18N.t === 'function') ? I18N.t(key) : key;
}

function i18nFmt(key, vars) {
    return (typeof I18N !== 'undefined' && typeof I18N.tfmt === 'function') ? I18N.tfmt(key, vars) : key;
}

function hexToRgb(h) {
    const m = String(h).match(/^#?([0-9a-f]{6})$/i);
    if (!m) return '68,204,68';
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function decToSexa(decimalHours, isRA) {
    if (!decimalHours && decimalHours !== 0) return '--:--:--';
    let total = isRA ? decimalHours * 15 : decimalHours;
    const sign = total < 0 ? '-' : (isRA ? '' : '+');
    total = Math.abs(total);
    const deg = Math.floor(total);
    const minFloat = (total - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(1);
    if (isRA) {
        return `${String(deg).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(4, '0')}`;
    }
    return `${sign}${String(deg).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(4, '0')}`;
}

function sexaToDec(str, isRA) {
    const parts = str.trim().split(':').map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return null;
    let sign = 1;
    if (!isRA && parts[0] < 0) { sign = -1; parts[0] = Math.abs(parts[0]); }
    const deg = parts[0] + parts[1] / 60 + parts[2] / 3600;
    return isRA ? deg / 15 : sign * deg;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
