// ═══════════════════════════════════════════════════════════════
// Noctua — État global partagé
// Charge les variables d'état de l'app en bindings lexicaux globaux
// (script classique chargé avant app.js) pour que les modules
// feature (viewer.js, layout.js, app.js…) puissent les partager.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────

let ws = null;
let devices = {};
let selectedDevice = null;
let selectedCamera = null;
let _targetObject = null;
let _hwModeDevice = null;

// Viewer instances (initialized later)
let captureViewer = null;
let guideViewer = null;

// ── Modes ─────────────────────────────────────────────────────

const MODES = {
    mount: {
        applets: ['applet-status', 'applet-pilotage',
                  'applet-hud'],
        driverType: 'mount'
    },
    focuser: {
        applets: ['applet-focuser-control', 'applet-focuser-position', 'applet-capture-preview'],
        driverType: 'focuser'
    },
    guiding: {
        applets: ['applet-guide-checklist', 'applet-guide-preview', 'applet-guiding-graph', 'applet-guiding-settings', 'applet-calibration', 'applet-session'],
        driverType: 'ccd'
    },
    capture: {
        applets: ['applet-capture-settings', 'applet-capture-preview', 'applet-sequence', 'applet-session'],
        driverType: 'ccd'
    },
    sequencer: {
        applets: ['applet-sequencer'],
        driverType: 'ccd'
    },
    astrometry: {
        applets: ['applet-solver', 'applet-target', 'applet-polar', 'applet-pointing', 'applet-capture-preview'],
        driverType: 'ccd'
    },
    hardware: {
        applets: ['applet-hardware-mode'],
        driverType: null
    }
};
const MAX_LOG = 500;
let logEntries = [];
let skyEngine = null;
let currentMode = 'mount';
let uiConfig = {};
let _initDone = false;

// ── Séquenceur (modèle Nina-like) ─────────────────────────────

let seqData = {
    targets: [],
    dither: { enabled: false, amount: 2.0, settle_rms: 1.0, settle_timeout: 20.0, settle_stable: 3 },
    save_dir: '',
    stacking: { enabled: false },
};
let seqTargetIdCounter = 0;
let seqSelectedTargetId = null;
let seqStatus = { running: false, paused: false, done: 0, total: 0, current: null };
let seqQuickCapture = null;

async function loadUiConfig() {
    try {
        const cfg = await fetch('/api/ui').then(r => r.json());
        if (cfg && typeof cfg === 'object') uiConfig = cfg;
    } catch (e) {
        console.warn('UI config load failed:', e);
    }
}

function saveUiConfig() {
    if (!_initDone) return;
    fetch('/api/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uiConfig)
    }).catch(e => console.warn('UI config save failed:', e));
}

function currentModeConfig() {
    if (!uiConfig.modes) uiConfig.modes = {};
    if (!uiConfig.modes[currentMode]) uiConfig.modes[currentMode] = {};
    return uiConfig.modes[currentMode];
}

// ── Histogram / preview ───────────────────────────────────────

let _histPixels = null;     // Float64Array of raw pixel data
let _histWidth = 0;
let _histHeight = 0;
let _histMin = 0;
let _histMax = 0;
let _histDataMin = 0;
let _histDataMax = 0;

// ── Zoom / pan ────────────────────────────────────────────────

let _previewZoom = 1;
let _previewPanX = 0;
let _previewPanY = 0;

// ── Guide preview zoom/pan ────────────────────────────────────

let _guidePreviewZoom = 1;
let _guidePreviewPanX = 0, _guidePreviewPanY = 0;