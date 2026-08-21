// ═══════════════════════════════════════════════════════════════
// Noctua — hub.js : médiateur de communication inter-panneaux.
// Coexiste avec le bus legacy (events.js) : les flux anciens restent
// sur Bus, les nouveaux cas d'usage passent par Hub.
//
// Topics dynamiques (pas de déclaration préalable), enveloppe
// standardisée { id, ts, topic, source, targets, kind, payload },
// tracking des abonnés par topic, logs visibles dans le panneau Log,
// et un handler qui lève ne bloque jamais les autres abonnés.
// Script classique, sans dépendance de chargement (aucun import).
// ═══════════════════════════════════════════════════════════════

const Hub = (function () {
    const subs = {};
    let seq = 0;

    function log(level, msg) {
        try {
            if (typeof addLog === 'function') addLog(level, 'hub', msg);
        } catch (e) { /* DOM indisponible (tests node) */ }
    }

    function topicSubs(topic) {
        return subs[topic] || (subs[topic] = []);
    }

    // Enregistre un abonnement et retourne la fonction de désabonnement.
    // fn = undefined → simple traçage (topic suivi, aucun handler).
    function subscribe(topic, source, fn) {
        if (typeof topic !== 'string' || !topic) return function noop() {};
        const entry = { source: source || 'anonymous', fn };
        topicSubs(topic).push(entry);
        return function unsubscribe() {
            const arr = subs[topic];
            if (!arr) return;
            const i = arr.indexOf(entry);
            if (i >= 0) arr.splice(i, 1);
            if (!arr.length) delete subs[topic];
        };
    }

    // Publie un événement vers tous les abonnés du topic.
    // Un handler qui lève est isolé : les autres abonnés sont servis.
    function emit(topic, payload, opts) {
        if (typeof topic !== 'string' || !topic) return null;
        opts = opts || {};
        const source = opts.source || 'anonymous';
        const arr = subs[topic] || [];
        const targets = arr.map(e => e.source);
        const envelope = {
            id: ++seq,
            ts: Date.now(),
            topic,
            source,
            targets,
            kind: opts.kind || 'event',
            reqId: opts.reqId || null,
            payload: payload === undefined ? null : payload,
        };
        log('info', `[Hub] ${source}.emit(${topic}) → ${targets.length ? targets.join(', ') : '(aucun)'}`);
        if (arr.length) {
            arr.slice().forEach(e => {
                if (!e.fn) return;
                try {
                    e.fn(envelope);
                } catch (err) {
                    const detail = err && err.stack ? err.stack : String(err);
                    log('error', `[Hub] handler « ${e.source} » en erreur sur ${topic}: ${detail}`);
                }
            });
        }
        return envelope;
    }

    return {
        subscribe,
        emit,
        getState: (topic) => topic ? !!subs[topic] : Object.keys(subs),
    };
})();
