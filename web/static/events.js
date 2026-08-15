// ═══════════════════════════════════════════════════════════════
// Noctua — events.js : bus de messages entre modules (pub/sub)
// Script classique (bindings lexicaux globaux), chargé AVANT les
// modules qui émettent/écoutent (ws.js, app.js…). Le bus n'est pas
// obligatoire : les fonctions restent appelables directement.
//
// Enveloppe d'événement : { id, ts, topic, source, targets, kind,
//   reqId, payload } — payload = données pures (jamais de callbacks).
// ═══════════════════════════════════════════════════════════════

const Bus = (function () {
    // Registre des topics : producteur (source) + consommateurs
    // (targets). Documente l'intention et sert à la validation dev.
    const REGISTRY = {
        'ws:state':           { source: 'ws',          targets: ['mount', 'capture', 'focuser', 'solver', 'guide', 'hardware'] },
        'ws:image':           { source: 'ws',          targets: ['preview'] },
        'ws:log':             { source: 'ws',          targets: ['api'] },
        'solver:result':      { source: 'solver',      targets: ['target', 'preview'] },
        'mode:changed':       { source: 'app',         targets: ['solver', 'hardware'] },
        'calibration:done':   { source: 'calibration', targets: ['app', 'guide'] },
        'capture:progress':   { source: 'capture',     targets: ['sequence', 'stacking', 'app'] },
        'guide:starSelected': { source: 'preview',     targets: ['guide'] },
        'mount:slewed':       { source: 'mount',       targets: ['target'] },
    };

    const listeners = {};
    let seq = 0;

    function normalize(t) {
        return typeof t === 'string' && t.includes(':') ? t : 'app:' + t;
    }

    function emit(topicName, payload, opts) {
        topicName = normalize(topicName);
        opts = opts || {};
        const meta = REGISTRY[topicName];
        if (!meta) {
            console.error('Bus: émission sur topic inconnu « ' + topicName + ' »');
            return;
        }
        if (opts.source && opts.source !== meta.source) {
            console.warn('Bus: source « ' + opts.source + ' » émet sur ' + topicName
                + ' (attendu « ' + meta.source + ' »)');
        }
        const envelope = {
            id: ++seq,
            ts: Date.now(),
            topic: topicName,
            source: meta.source,
            targets: meta.targets,
            kind: opts.kind || 'event',
            reqId: opts.reqId || null,
            payload,
        };
        const subs = listeners[topicName];
        if (subs) subs.forEach(fn => { try { fn(envelope); } catch (e) { console.error('Bus: handler ' + topicName + ':', e); } });
    }

    function on(topicName, fn) {
        topicName = normalize(topicName);
        if (!REGISTRY[topicName]) {
            console.warn('Bus: abonnement à un topic inconnu « ' + topicName + ' »');
            return function noop() {};
        }
        if (typeof fn !== 'function') return function noop() {};
        (listeners[topicName] || (listeners[topicName] = [])).push(fn);
        return () => off(topicName, fn);
    }

    function off(topicName, fn) {
        topicName = normalize(topicName);
        const arr = listeners[topicName];
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    }

    function once(topicName, fn) {
        const wrap = (env) => { off(topicName, wrap); fn(env); };
        return on(topicName, wrap);
    }

    return {
        topics: REGISTRY,
        emit,
        on,
        off,
        once,
    };
})();
