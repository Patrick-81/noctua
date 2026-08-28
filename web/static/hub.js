// ═══════════════════════════════════════════════════════════════
// Noctua — hub.js : médiateur de communication inter-panneaux.
// coexiste avec le bus legacy supprimé (events.js) : tous les flux
// passent maintenant par Hub.
//
// Topics dynamiques (pas de déclaration préalable), enveloppe
// standardisée { id, ts, topic, source, targets, kind, payload },
// tracking des abonnés par topic, logs visibles dans le panneau Log,
// et un handler qui lève ne bloque jamais les autres abonnés.
// Script classique, sans dépendance de chargement (aucun import).
// ═══════════════════════════════════════════════════════════════

const Hub = (function () {
    const subs = {};
    const states = {};
    const watchers = {};
    const pending = {};
    let seq = 0;
    let reqSeq = 0;
    let _debug = false;

    function log(level, msg) {
        try {
            if (typeof addLog === 'function') addLog(level, 'hub', msg);
        } catch (e) { /* DOM indisponible (tests node) */ }
    }

    function debugLog(msg) {
        if (_debug) log('debug', msg);
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

    // Met à jour l'état partagé d'une clé et notifie les watchState.
    function setState(key, value) {
        if (typeof key !== 'string' || !key) return;
        states[key] = value;
        const arr = watchers[key];
        if (arr && arr.length) {
            arr.slice().forEach(e => {
                try {
                    e.fn(value);
                } catch (err) {
                    const detail = err && err.stack ? err.stack : String(err);
                    log('error', `[Hub] watcher « ${e.source} » en erreur sur ${key}: ${detail}`);
                }
            });
        }
        debugLog(`[Hub] hub.setState(${key}) → ${arr ? arr.length : 0} watcher(s)`);
    }

    // Topics suivis (au moins un abonné ou traqueur). topic donné → booléen.
    function topics(topic) {
        if (typeof topic === 'string' && topic) return !!subs[topic];
        return Object.keys(subs);
    }

    // Retourne une copie de l'état courant de la clé (null si inconnue).
    // Copie profonde si sérialisable (protège l'état interne des mutations).
    function getState(key) {
        if (typeof key !== 'string' || !key) return null;
        if (!(key in states)) return null;
        const v = states[key];
        try {
            return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
        } catch (e) {
            return v;
        }
    }

    // S'abonne aux mises à jour d'une clé d'état ; reçoit l'état courant
    // immédiatement s'il existe. Retourne la fonction de désabonnement.
    function watchState(key, source, fn) {
        if (typeof key !== 'string' || !key || typeof fn !== 'function') {
            return function noop() {};
        }
        const entry = { source: source || 'anonymous', fn };
        (watchers[key] || (watchers[key] = [])).push(entry);
        if (key in states) {
            try {
                fn(states[key]);
            } catch (err) {
                log('error', `[Hub] watcher « ${entry.source} » en erreur sur ${key}: ${err}`);
            }
        }
        return function unwatch() {
            const arr = watchers[key];
            if (!arr) return;
            const i = arr.indexOf(entry);
            if (i >= 0) arr.splice(i, 1);
            if (!arr.length) delete watchers[key];
        };
    }

    // Requête/réponse : émet kind='request' et résout la promesse à la
    // première réponse portant le même reqId (rejet si timeoutMs).
    function request(topic, payload, opts) {
        if (typeof topic !== 'string' || !topic) return Promise.reject(new Error('topic invalide'));
        opts = opts || {};
        const reqId = `req-${++reqSeq}`;
        const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000;
        let timer = null;
        const p = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                delete pending[reqId];
                reject(new Error(`Hub.request(${topic}) timeout après ${timeoutMs} ms`));
            }, timeoutMs);
            pending[reqId] = {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            };
        });
        emit(topic, payload, { source: opts.source || 'anonymous', kind: 'request', reqId });
        return p;
    }

    // Répond à une requête (env.reqId) ; renvoie false si reqId inconnu.
    function respond(env, value) {
        const reqId = env && env.reqId;
        const entry = reqId ? pending[reqId] : null;
        if (!entry) return false;
        delete pending[reqId];
        entry.resolve(value);
        return true;
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
        const kindTag = envelope.kind === 'request' ? ` [request ${envelope.reqId}]` : '';
        debugLog(`[Hub] ${source}.emit(${topic})${kindTag} → ${targets.length ? targets.join(', ') : '(aucun)'}`);
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
        setState,
        getState,
        watchState,
        request,
        respond,
        topics,
        set debug(v) { _debug = !!v; },
        get debug() { return _debug; },
    };
})();
