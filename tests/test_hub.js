// Tests unitaires de hub.js (lancés directement : node tests/test_hub.js)
// Couvre : emit sur topic non déclaré, isolation des handlers en erreur,
// désabonnement, getState.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'static', 'hub.js'), 'utf8');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__Hub = Hub;', sandbox, { filename: 'hub.js' });
const Hub = sandbox.__Hub;

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
assert(Hub.getState('device:connected') === false, 'getState false quand plus aucun abonné');

// ── CAS : subscribe sans fn (traçage seul) ──────────────────────
console.log('traçage sans handler :');
const unsub3 = Hub.subscribe('sequence:update', 'tracker');
assert(Hub.getState('sequence:update') === true, 'topic suivi après subscribe sans fn');
const env4 = Hub.emit('sequence:update', { done: 1, total: 2 }, { source: 'sequence' });
assert(env4.targets.includes('tracker'), 'le traqueur apparaît dans targets');
unsub3();
assert(Hub.getState('sequence:update') === false, 'topic retiré après dernier unsubscribe');

// ── CAS : subscribe sur topic invalide ──────────────────────────
console.log('entrées invalides :');
const noop = Hub.subscribe('', 'x');
assert(typeof noop === 'function', 'subscribe("") retourne un noop sans planter');
assert(Hub.emit('', {}) === null, 'emit("") retourne null');

console.log(`\n${passed} passés, ${failed} échoués`);
process.exit(failed ? 1 : 0);
