// ═══════════════════════════════════════════════════════════════
// Noctua — testharness.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Test harness (dev / no-camera testing) ───────────────────

let _testImages = [];

async function loadTestImageList() {
    try {
        const resp = await fetch('/api/test/fits-list');
        const data = await resp.json();
        _testImages = data.images || [];
        return _testImages;
    } catch (e) {
        console.warn('Test image list failed:', e);
        return [];
    }
}

async function loadTestFITS(filename) {
    try {
        const resp = await fetch(`/api/test/fits/${filename}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error);
        clearOffsetOverlay();
        handleCameraImage(data.data, 'image/fits');

        fetch('/api/test/fits-store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: data.data, format: 'image/fits' }),
        });

        addLog('info', 'test', i18nFmt('log.test.image_loaded', { name: filename, size: data.size }));
        return true;
    } catch (e) {
        addLog('error', 'test', i18nFmt('log.test.load_failed', { err: e.message }));
        return false;
    }
}

function mockSolveResult(ra, dec, scale, rotation, opts = {}) {
    const result = {
        ok: true,
        ra: ra,
        dec: dec,
        rotation: rotation || 0,
        flipped: false,
        scale: scale || 2.5,
        matches: opts.matches || 12,
        rms: opts.rms || 1.5,
        width: _histWidth || 1920,
        height: _histHeight || 1080,
        stars_detected: opts.stars || 80,
        mode: 'hinted',
        elapsed_ms: opts.elapsed_ms || 42.0,
    };
    _lastSolverResult = result;
    renderSolverResult(result);
    setOffsetSolved(ra, dec, scale, rotation);
    addLog('info', 'test', i18nFmt('log.test.mock_solve', { ra: ra.toFixed(4), dec: dec.toFixed(4), scale: scale, rot: rotation }));
    return result;
}

function mockSetTarget(ra, dec) {
    setOffsetTarget(ra, dec);
    addLog('info', 'test', i18nFmt('log.test.target_set', { ra: ra.toFixed(4), dec: dec.toFixed(4) }));
}

function mockClearTarget() {
    _offsetTargetRA = null;
    _offsetTargetDEC = null;
    clearOffsetOverlay();
    addLog('info', 'test', i18n('log.test.target_cleared'));
}

function testOverlayScenario(scenario) {
    const scenarios = {
        'north': {
            desc: 'Décalage 30\' vers le Nord',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.0, dec: 45.5 },
        },
        'east': {
            desc: 'Décalage 15\' vers l\'Est',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.25, dec: 45.0 },
        },
        'southeast': {
            desc: 'Décalage diagonal Sud-Est',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.3, dec: 44.5 },
        },
        'rotated': {
            desc: 'Même offset mais image rotée 45°',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 45 },
            target: { ra: 100.0, dec: 45.5 },
        },
        'small': {
            desc: 'Petit décalage 3\' (proche centrage)',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 100.0, dec: 45.05 },
        },
        'large': {
            desc: 'Grand décalage 2°',
            solved: { ra: 100.0, dec: 45.0, scale: 2.5, rot: 0 },
            target: { ra: 102.0, dec: 45.0 },
        },
    };

    const s = scenarios[scenario] || scenarios['north'];
    mockSolveResult(s.solved.ra, s.solved.dec, s.solved.scale, s.solved.rot);
    mockSetTarget(s.target.ra, s.target.dec);
    addLog('info', 'test', i18nFmt('log.test.scenario', { scenario, desc: s.desc }));
    return s;
}

window._testHarness = {
    loadTestImageList,
    loadTestFITS,
    mockSolveResult,
    mockSetTarget,
    mockClearTarget,
    testOverlayScenario,
    listImages: () => { loadTestImageList().then(imgs => console.table(imgs)); },
    help: () => {
        console.log(`
═══ Test Harness — Overlay & Solver ═══

  _testHarness.listImages()                  — Lister les images FITS disponibles
  _testHarness.loadTestFITS('test_orion.fits') — Charger une image dans le viewer
  _testHarness.mockSolveResult(ra, dec, scale, rotation) — Simuler un résultat solver
  _testHarness.mockSetTarget(ra, dec)         — Définir la cible
  _testHarness.mockClearTarget()              — Effacer cible et overlay
  _testHarness.testOverlayScenario('north')   — Scénario de test prédéfini

  Scénarios: north, east, southeast, rotated, small, large

  Exemple complet:
    await _testHarness.loadTestFITS('test_orion.fits')
    _testHarness.testOverlayScenario('southeast')
        `);
    },
};
