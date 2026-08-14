// ═══════════════════════════════════════════════════════════════
// Noctua — API calls, log, toasts & helpers
// Extraits d'app.js (script classique, globals partagés).
// Dépendances globales : i18n/i18nFmt (utils.js), logEntries/MAX_LOG (state.js), hexToRgb (utils.js).
// ═══════════════════════════════════════════════════════════════

function setSwitchItem(device, prop, item, value) {
    apiPost('/api/property', { device, property: prop, items: [{ name: item, value: value }] });
}

function setNumberItem(input) {
    apiPost('/api/property', { device: input.dataset.device, property: input.dataset.prop, items: [{ name: input.dataset.item, value: parseFloat(input.value) }] });
}

function setTextItem(input) {
    apiPost('/api/property', { device: input.dataset.device, property: input.dataset.prop, items: [{ name: input.dataset.item, value: input.value }] });
}

function apiPost(url, body) {
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json()).then(data => {
        if (data.error) addLog('error', 'api', i18nFmt('log.ws.error', { err: data.error }));
    }).catch(e => addLog('error', 'api', i18nFmt('log.ws.error', { err: e.message })));
}

// ── Utilities ─────────────────────────────────────────────────

function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Log ───────────────────────────────────────────────────────

function addLog(level, logger, msg) {
    const el = document.getElementById('log-content');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.dataset.level = level || 'info';
    entry.dataset.logger = logger || '';
    entry.dataset.msg = msg || '';
    entry.innerHTML = `<span class="ts">${time}</span> <span class="logger">[${escapeHTML(logger || '')}]</span> <span class="msg">${escapeHTML(msg || '')}</span>`;
    el.appendChild(entry);
    logEntries.push(entry);
    while (logEntries.length > MAX_LOG) { const old = logEntries.shift(); old.remove(); }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) el.scrollTop = el.scrollHeight;
    applyLogFilters();
}

function showToast(message, opts = {}) {
    const color = opts.color || '#44cc44';
    const duration = opts.duration != null ? opts.duration : 6000;
    const actionLabel = opts.action;
    const onAction = opts.onAction;
    const toast = document.createElement('div');
    toast.style.cssText = [
        'position:fixed', 'bottom:20px', 'right:20px', 'maxWidth:360px',
        'display:flex', 'alignItems:center', 'gap:10px',
        'padding:10px 14px', 'borderRadius:6px',
        `background:rgba(${hexToRgb(color)},0.92)`, 'color:#fff',
        'font:600 13px/1.4 monospace', 'backdropFilter:blur(3px)',
        'boxShadow:0 4px 14px rgba(0,0,0,0.35)', 'zIndex:9999',
        'border:1px solid rgba(255,255,255,0.18)',
    ].join(';');
    toast.innerHTML = `<span>${escapeHTML(message)}</span>`;
    if (actionLabel) {
        const btn = document.createElement('button');
        btn.textContent = actionLabel;
        btn.style.cssText = 'marginLeft:auto; background:#fff2; color:#fff; border:1px solid #fff5; padding:4px 10px; border-radius:4px; font:600 12px monospace; cursor:pointer;';
        btn.onclick = () => { if (onAction) onAction(); remove(); };
        toast.appendChild(btn);
    }
    let timer = null;
    const remove = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    };
    if (duration > 0) timer = setTimeout(remove, duration);
    document.body.appendChild(toast);
    return remove;
}


function clearLog() {
    const el = document.getElementById('log-content');
    if (el) el.innerHTML = '';
    logEntries = [];
}

function copyLog() {
    const text = logEntries.map(e => `[${e.dataset.level}] [${e.dataset.logger}] ${e.dataset.msg}`).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
            () => addLog('info', 'log', i18n('log.log.copied')),
            () => copyLogFallback(text)
        );
    } else {
        copyLogFallback(text);
    }
}

function copyLogFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        addLog('info', 'log', i18n('log.log.copied'));
    } catch (e) {
        addLog('error', 'log', i18n('log.log.copy_failed'));
    }
    document.body.removeChild(ta);
}

function applyLogFilters() {
    const activeLevels = new Set();
    document.querySelectorAll('.log-filters input[type="checkbox"]').forEach(cb => {
        if (cb.checked) activeLevels.add(cb.dataset.level);
    });
    logEntries.forEach(entry => entry.classList.toggle('hidden', !activeLevels.has(entry.dataset.level)));
}
