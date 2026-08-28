// Tests unitaires de hub.js (lancés directement : node tests/test_hub.js)
// Couvre : emit sur topic non déclaré, isolation des handlers en erreur,
// désabonnement, état partagé (setState/getState/watchState),
// requêtes/réponses async (request/respond).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'static', 'hub.js'), 'utf8');

const sandbox = { setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__Hub = Hub;', sandbox, { filename: 'hub.js' });
const Hub = sandbox.__Hub;
Hub.debug = true;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ok - ${msg}`); }
    else { failed++; console.error(`  FAIL - ${msg}`); }
}

// ── CAS : emit sur topic non déclaré (aucun abonné) ─────────────
console.log('topic non déclaré :');
let logLines = [];
sandbox.addLog = (level, logger, msg) => logLines.push({ level, logger, msg });

const env1 = Hub.emit('device:connected', { name: 'Main Camera', type: 'CCD' }, { source: 'hardware' });
assert(env1 !== null, 'emit retourne une enveloppe');
assert(env1.topic === 'device:connected', 'enveloppe porte le topic');
assert(env1.source === 'hardware', 'enveloppe porte la source');
assert(env1.payload.name === 'Main Camera', 'enveloppe porte le payload');
assert(Array.isArray(env1.targets) && env1.targets.length === 0, 'targets vide sans abonnés');
assert(env1.id >= 1 && typeof env1.ts === 'number', 'enveloppe porte id et ts');

const logLine = logLines.find(l => l.msg.includes('[Hub]'));
assert(!!logLine, 'une ligne [Hub] est émise dans le log');
assert(logLine && logLine.msg === '[Hub] hardware.emit(device:connected) → (aucun)',
    'format [Hub] source.emit(topic) → targets');
assert(logLine && logLine.logger === 'hub', 'logger = hub');

// ── CAS : handler qui lève ne bloque pas les autres abonnés ─────
console.log('isolation des erreurs :');
logLines = [];
let okCount = 0;
const unsubOk = Hub.subscribe('device:connected', 'guide', () => { okCount++; });
const unsubBad = Hub.subscribe('device:connected', 'bad-applet', () => { throw new Error('boom'); });
const unsub2 = Hub.subscribe('device:connected', 'stacking', () => { okCount++; });

Hub.emit('device:connected', { name: 'Guide Camera' }, { source: 'hardware' });
assert(okCount === 2, 'les 2 bons abonnés sont servis malgré le handler en erreur');
const errLine = logLines.find(l => l.msg.includes('boom'));
assert(!!errLine, "l'erreur du handler est tracée dans le log");
assert(errLine && errLine.level === 'error', "l'erreur est loggée au niveau error");

const env2 = Hub.emit('device:connected', {}, { source: 'hardware' });
assert(env2.targets.includes('guide') && env2.targets.includes('bad-applet') && env2.targets.includes('stacking'),
    'targets liste tous les abonnés, y compris celui en erreur');

// ── CAS : désabonnement ─────────────────────────────────────────
console.log('désabonnement :');
unsubOk();
const env3 = Hub.emit('device:connected', {}, { source: 'hardware' });
assert(env3.targets.includes('stacking') && !env3.targets.includes('guide'),
    'l\'abonné désabonné n\'est plus dans targets');
unsub2();
unsubBad();
assert(Hub.topics('device:connected') === false, 'topics false quand plus aucun abonné');

// ── CAS : subscribe sans fn (traçage seul) ──────────────────────
console.log('traçage sans handler :');
const unsub3 = Hub.subscribe('sequence:update', 'tracker');
assert(Hub.topics('sequence:update') === true, 'topic suivi après subscribe sans fn');
const env4 = Hub.emit('sequence:update', { done: 1, total: 2 }, { source: 'sequence' });
assert(env4.targets.includes('tracker'), 'le traqueur apparaît dans targets');
unsub3();
assert(Hub.topics('sequence:update') === false, 'topic retiré après dernier unsubscribe');

// ── CAS : subscribe sur topic invalide ──────────────────────────
console.log('entrées invalides :');
const noop = Hub.subscribe('', 'x');
assert(typeof noop === 'function', 'subscribe("") retourne un noop sans planter');
assert(Hub.emit('', {}) === null, 'emit("") retourne null');

// ── CAS : état partagé (setState / getState / watchState) ──────
console.log('état partagé :');
let stateNotifs = [];
const unwatch = Hub.watchState('mount', 'test', (state) => { stateNotifs.push(state); });
assert(Hub.getState('mount') === null, "getState inconnu → null");
Hub.setState('mount', { slewing: true });
assert(Hub.getState('mount') && Hub.getState('mount').slewing === true, 'setState/getState round-trip');
assert(stateNotifs.length === 1 && stateNotifs[0].slewing === true, 'watchState notifié à la première mise à jour');
Hub.setState('mount', { slewing: false });
assert(Hub.getState('mount').slewing === false, 'seconde mise à jour visible via getState');
assert(stateNotifs.length === 2, 'watchState notifié à chaque mise à jour');
const lateWatcher = Hub.watchState('mount', 'late', (s) => stateNotifs.push(['late', s]));
assert(stateNotifs.length === 3, 'un nouvel abonné reçoit l\'état courant immédiatement');
assert(stateNotifs[2][0] === 'late' && stateNotifs[2][1].slewing === false, "l'état courant est bien l'état le plus récent");
unwatch();
lateWatcher();
Hub.setState('mount', { slewing: true });
assert(stateNotifs.length === 3, 'après unwatch, plus aucune notification');
assert(Hub.getState('mount').slewing === true, 'mais l\'état reste stocké');
assert(Hub.getState('mount') !== Hub.getState('mount'), 'getState retourne une copie (pas la référence interne)');

// ── CAS : requête/réponse async (request / respond) ────────────
console.log('requête/réponse :');
(async () => {
    logLines = [];
    let reqEnvelope = null;
    const unsubReq = Hub.subscribe('device:info', 'hardware', (env) => {
        reqEnvelope = env;
        Hub.respond(env, { width_px: 1920, height_px: 1080 });
    });
    const p = Hub.request('device:info', { name: 'Main Camera' }, { source: 'guide', timeoutMs: 2000 });
    assert(typeof p.then === 'function', 'request retourne une promesse');
    const info = await p;
    assert(reqEnvelope !== null, 'le destinataire a reçu l\'enveloppe kind=request');
    assert(reqEnvelope.kind === 'request', 'enveloppe porte kind=request');
    assert(typeof reqEnvelope.reqId === 'string' && reqEnvelope.reqId.length > 0, 'enveloppe porte un reqId');
    assert(info && info.width_px === 1920 && info.height_px === 1080, 'la réponse du destinataire est résolue');
    const reqLog = logLines.find(l => l.msg.includes('request'));
    assert(!!reqLog, 'la requête est tracée dans le log');
    unsubReq();

    // timeout : personne ne répond
    const t0 = Date.now();
    const slow = await Hub.request('nobody:home', {}, { source: 'guide', timeoutMs: 50 }).catch(e => e);
    assert(!!slow && /timeout/i.test(slow.message), 'request sans réponse → promesse rejetée (timeout)');
    assert(Date.now() - t0 >= 40, 'le timeout est respecté');

    // réponse sans reqId : ignorée, pas de crash
    Hub.respond({ reqId: null }, { bogus: 1 });
    assert(true, 'respond sans reqId ne plante pas');

    console.log(`\n${passed} passés, ${failed} échoués`);
    process.exit(failed ? 1 : 0);
})();
