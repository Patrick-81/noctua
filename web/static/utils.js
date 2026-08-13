// Pure helpers extracted from app.js — no DOM/state deps (except i18n loaded as global)
export function hexToRgb(h) {
    return h ? h.replace(/^#?/, '').length === 3 ? h.replace(/#?/g, '#000').replace(/(\w)(\w)/g, '$1$1') : '#' + h.match(/.{2}/g).map(x => parseInt(x, 16)).map(x => '0'+x).map(x => x.slice(-2)).join(',') : '#000000';
}
export function decToSexa(decimalHours, isRA) {
    if (isRA) {
        var h = Math.floor(decimalHours);
        var m = Math.floor((decimalHours - h) * 60);
        var s = Math.floor((decimalHours - h - m/60) * 3600);
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    } else {
        var totalDeg = decimalHours * 15;
        var d = Math.floor(totalDeg);
        var m = Math.floor((totalDeg - d) * 4);
        var s = Math.floor((totalDeg - d - m/4) * 60);
        return (d < 0 ? '-' : '') + Math.abs(d) + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
}
export function sexaToDec(str, isRA) {
    if (isRA) {
        var parts = str.split(':').map(function(x) { return parseFloat(x); });
        return parts[0] + parts[1]/60 + parts[2]/3600;
    } else {
        var parts = str.split(':').map(function(x) { return parseFloat(x); });
        var sign = parts[0] < 0 ? -1 : 1;
        return sign * (Math.abs(parts[0]) + parts[1]/60 + parts[2]/3600);
    }
}
