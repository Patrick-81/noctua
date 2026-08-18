// ═══════════════════════════════════════════════════════════════
// Noctua — capture.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Capture panel ─────────────────────────────────────────────

let _captureFrameType = 'LIGHT';
let _captureRunning = false;
let _captureQueue = 0;
let _captureTotal = 0;
let _exposureStartMs = 0;
let _exposureDurationMs = 0;
let _countdownRaf = 0;
let _captureFilter = '';            // current filter slot name
let _captureFilterSeq = [];         // ordered filter sequence for the loop
let _captureAborted = false;        // last capture run was aborted (not completed)

// Save
let _saveDir = '';

function initCapturePanel() {
    // Camera selector
    const camSelect = document.getElementById('cap-camera-select');
    if (camSelect) {
        camSelect.addEventListener('change', () => {
            selectedCamera = camSelect.value || null;
            renderCapturePanel();
        });
    }

    // Frame type buttons
    document.querySelectorAll('.cap-ft-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cap-ft-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _captureFrameType = btn.dataset.frame;
        });
    });

    // Gain slider ↔ number sync
    const gainSlider = document.getElementById('cap-gain-slider');
    const gainInput = document.getElementById('cap-gain');
    if (gainSlider && gainInput) {
        gainSlider.addEventListener('input', () => {
            gainInput.value = gainSlider.value;
            sendCapNumber('CCD_GAIN', 'GAIN', parseInt(gainSlider.value));
        });
        gainInput.addEventListener('change', () => {
            gainSlider.value = gainInput.value;
            sendCapNumber('CCD_GAIN', 'GAIN', parseInt(gainInput.value));
        });
    }

    // Offset slider ↔ number sync
    const offsetSlider = document.getElementById('cap-offset-slider');
    const offsetInput = document.getElementById('cap-offset');
    if (offsetSlider && offsetInput) {
        offsetSlider.addEventListener('input', () => {
            offsetInput.value = offsetSlider.value;
            sendCapNumber('CCD_OFFSET', 'OFFSET', parseInt(offsetSlider.value));
        });
        offsetInput.addEventListener('change', () => {
            offsetSlider.value = offsetInput.value;
            sendCapNumber('CCD_OFFSET', 'OFFSET', parseInt(offsetInput.value));
        });
    }

    // Binning
    const binningSelect = document.getElementById('cap-binning');
    if (binningSelect) {
        binningSelect.addEventListener('change', () => {
            const v = parseInt(binningSelect.value);
            if (!findCamera()) return;
            apiPost('/api/property', {
                device: findCamera().name,
                property: 'CCD_BINNING',
                items: [{ name: 'HOR_BIN', value: v }, { name: 'VER_BIN', value: v }]
            });
        });
    }

    // Filter wheel
    const filterSelect = document.getElementById('cap-filter-select');
    if (filterSelect) {
        filterSelect.addEventListener('change', async () => {
            _captureFilter = filterSelect.value;
            await setCaptureFilter(_captureFilter);
        });
    }
    const filterSeqInput = document.getElementById('cap-filter-seq');
    if (filterSeqInput) {
        filterSeqInput.addEventListener('change', () => {
            _captureFilterSeq = parseFilterSeq(filterSeqInput.value);
        });
    }

    // Temperature set button
    const setTempBtn = document.getElementById('cap-set-temp');
    if (setTempBtn) {
        setTempBtn.addEventListener('click', () => {
            const target = parseFloat(document.getElementById('cap-target-temp')?.value);
            if (!isNaN(target)) apiPost('/api/camera/temperature', { device: findCamera()?.name, target });
        });
    }

    // Expose button
    const exposeBtn = document.getElementById('cap-expose-btn');
    if (exposeBtn) {
        exposeBtn.addEventListener('click', () => {
            if (_captureRunning) return;
            const count = parseInt(document.getElementById('cap-count')?.value || '1');
            const delay = parseFloat(document.getElementById('cap-delay')?.value || '0');
            startSequence(count, delay);
        });
    }

    // Measure the sky → recommended exposure
    const measureBtn = document.getElementById('cap-measure-btn');
    if (measureBtn) {
        measureBtn.addEventListener('click', measureSkyExposure);
    }

    // Abort button
    const abortBtn = document.getElementById('cap-abort-btn');
    if (abortBtn) {
        abortBtn.addEventListener('click', () => {
            _captureQueue = 0;
            _captureRunning = false;
            _captureAborted = true;
            apiPost('/api/camera/abort', { device: findCamera()?.name });
            updateCaptureProgress();
        });
    }
}

function findCamera() {
    const cams = Object.entries(devices).filter(([, d]) => d.type === 'camera');
    if (cams.length === 0) { selectedCamera = null; return null; }

    // Check dropdown selection first (user choice)
    const sel = document.getElementById('cap-camera-select');
    if (sel && sel.value && devices[sel.value] && devices[sel.value].type === 'camera') {
        selectedCamera = sel.value;
        return { name: sel.value, dev: devices[sel.value] };
    }

    // Prefer previously selected camera if it still exists
    if (selectedCamera && devices[selectedCamera] && devices[selectedCamera].type === 'camera') {
        return { name: selectedCamera, dev: devices[selectedCamera] };
    }

    // Fallback: first camera found
    selectedCamera = cams[0][0];
    return { name: cams[0][0], dev: cams[0][1] };
}

// ── Measure the sky → recommended exposure ────────────────────

let _measureRunning = false;
let _lastExposureReco = null;

async function measureSkyExposure() {
    if (_measureRunning) return;
    const cam = findCamera();
    if (!cam) { addLog('error', 'capture', i18n('log.capture.no_camera')); return; }
    if (!cam.dev.is_ready) {
        addLog('error', 'capture', i18n('log.capture.not_ready'));
        return;
    }
    _measureRunning = true;
    const btn = document.getElementById('cap-measure-btn');
    const shotsSelect = document.getElementById('cap-measure-shots');
    const shots = shotsSelect ? parseInt(shotsSelect.value || '1', 10) : 1;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    setExposureReco({ loading: true, shots });
    try {
        const resp = await fetch('/api/camera/exposure/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: cam.name, shots }),
        });
        const res = await resp.json();
        if (res?.error) {
            addLog('error', 'capture', i18nFmt('log.capture.measure_error', { err: res.error }));
            setExposureReco({ error: res.error });
        } else if (res?.ok === false) {
            addLog('error', 'capture', i18nFmt('log.capture.measure_error', { err: res.error || '?' }));
            setExposureReco({ error: res.error || '?' });
        } else {
            _lastExposureReco = res;
            renderExposureReco(res);
            addLog('info', 'capture', i18nFmt('log.capture.measured', {
                exp: res.exposure_s != null ? res.exposure_s.toFixed(1) : '—',
                bg: res.mode === 'multi'
                    ? `${Math.round(res.bg_rate || 0)} ADU/s`
                    : (res.sky_adu != null ? Math.round(res.sky_adu) : '—'),
            }));
        }
    } catch (e) {
        setExposureReco({ error: e.message });
    } finally {
        _measureRunning = false;
        if (btn) { btn.disabled = false; btn.textContent = i18n('cap.measure'); }
    }
}

function setExposureReco(state) {
    const el = document.getElementById('cap-exp-reco');
    if (!el) return;
    if (state.loading) {
        el.style.display = '';
        el.className = 'cap-exp-reco';
        el.textContent = state.shots && state.shots > 1
            ? i18nFmt('cap.measuring_n', { n: state.shots })
            : i18n('cap.measuring');
        return;
    }
    if (state.error) {
        el.style.display = '';
        el.className = 'cap-exp-reco cap-reco-warn';
        el.textContent = i18nFmt('cap.measure_failed', { err: state.error });
        return;
    }
}

function renderExposureReco(r) {
    const el = document.getElementById('cap-exp-reco');
    if (!el) return;
    el.style.display = '';
    el.className = 'cap-exp-reco';
    if (r.exposure_s == null) {
        el.innerHTML = `<span class="cap-reco-meta">⚠ ${escapeHTML(r.warning || '')}</span>`;
        return;
    }
    const meta = [];
    if (r.mode === 'multi') {
        meta.push(i18nFmt('cap.reco_rate', { rate: r.bg_rate }));
        if (r.r2 != null) meta.push(i18nFmt('cap.reco_r2', { r2: r.r2 }));
        if (r.knee_detected) meta.push(i18n('cap.reco_knee'));
    } else {
        meta.push(i18nFmt('cap.reco_bg', { bg: Math.round(r.sky_adu || 0) }));
    }
    if (r.snr_at_target != null) meta.push(i18nFmt('cap.reco_snr', { snr: r.snr_at_target }));
    if (r.saturation_pct != null) meta.push(i18nFmt('cap.reco_sat', { sat: r.saturation_pct }));
    let capNote = '';
    if (r.capped_by === 'max_exposure') capNote = ' — ' + i18n('cap.reco_cap_max');
    else if (r.capped_by === 'saturation') capNote = ' — ' + i18n('cap.reco_cap_sat');
    el.innerHTML =
        `<div class="cap-reco-main">☾ ${i18nFmt('cap.reco_value', { exp: r.exposure_s.toFixed(1) })}${escapeHTML(capNote)}</div>` +
        `<div class="cap-reco-meta">${meta.join(' · ')}</div>` +
        `<button class="cap-reco-apply">${escapeHTML(i18n('cap.reco_apply'))}</button>`;
    const applyBtn = el.querySelector('.cap-reco-apply');
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const input = document.getElementById('cap-exposure');
            if (input) input.value = r.exposure_s;
            addLog('info', 'capture', i18nFmt('log.capture.reco_applied', { exp: r.exposure_s.toFixed(1) }));
            el.style.display = 'none';
        });
    }
}

function sendCapNumber(prop, item, value) {
    const cam = findCamera();
    if (!cam) return;
    apiPost('/api/property', { device: cam.name, property: prop, items: [{ name: item, value }] });
}

async function startSequence(count, delay) {
    const cam = findCamera();
    if (!cam) { addLog('error', 'capture', i18n('log.capture.no_camera')); return; }
    _captureTotal = count;
    _captureQueue = count;
    _captureRunning = true;
    _captureAborted = false;
    updateCaptureProgress();

    const filterSeqInput = document.getElementById('cap-filter-seq');
    if (filterSeqInput) _captureFilterSeq = parseFilterSeq(filterSeqInput.value);

    for (let i = 0; i < count; i++) {
        if (!_captureRunning) break;
        const exposure = parseFloat(document.getElementById('cap-exposure')?.value || '1');
        // Rotate through the filter sequence if set
        let filter = '';
        if (_captureFilterSeq.length > 0) {
            filter = _captureFilterSeq[i % _captureFilterSeq.length];
        } else if (_captureFilter) {
            filter = _captureFilter;
        }
        if (filter) {
            const fw = findFilterWheel();
            if (fw && fw.dev.connected) {
                await setCaptureFilter(filter);
                const label = _captureFilterSeq.length ? `${_captureFilterSeq[i % _captureFilterSeq.length]}` : filter;
                addLog('info', 'capture', i18nFmt('log.capture.filter_set', { label }));
            } else {
                addLog('info', 'capture', i18nFmt('log.capture.filter_ignored', { filter }));
            }
        }
        addLog('info', 'capture', i18nFmt('log.capture.pose', { i: i + 1, count, exposure, type: _captureFrameType, filter: filter ? ` [${filter}]` : '' }));
        apiPost('/api/camera/expose', { device: cam.name, duration: exposure, frame_type: _captureFrameType });
        _exposureDurationMs = exposure * 1000;
        _exposureStartMs = Date.now();
        startCountdown();
        await waitExposureDone(cam.name, exposure * 1000 + 5000);
        stopCountdown();
        if (!_captureRunning) break;
        _captureQueue--;
        updateCaptureProgress();
        if (i < count - 1 && delay > 0 && _captureRunning) {
            await sleep(delay * 1000);
        }
    }
    _captureRunning = false;
    _captureQueue = 0;
    updateCaptureProgress();
    addLog('info', 'capture', i18n('log.capture.seq_done'));
}

function parseFilterSeq(text) {
    return String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
}

async function setCaptureFilter(slot) {
    if (!slot) return;
    const fw = findFilterWheel();
    if (!fw) return;
    const res = await apiPost('/api/filterwheel/slot', { slot }).catch(() => null);
    if (res?.error) addLog('error', 'capture', i18nFmt('log.capture.filter_error', { err: res.error }));
    else _captureFilter = slot;
}

function waitExposureDone(camName, timeout) {
    return new Promise(resolve => {
        const start = Date.now();
        let started = false;
        const check = () => {
            if (!_captureRunning) { resolve(); return; }
            const cam = devices[camName];
            const elapsed = Date.now() - start;
            if (!cam || elapsed > timeout) { resolve(); return; }
            if (!started) {
                if (cam.exposure_time > 0) started = true;
                setTimeout(check, 100);
            } else {
                if (cam.exposure_time <= 0) { resolve(); return; }
                setTimeout(check, 200);
            }
        };
        setTimeout(check, 200);
    });
}
function startCountdown() {
    const row = document.getElementById('cap-countdown-row');
    if (row) row.style.display = '';
    _tickCountdown();
}

function stopCountdown() {
    const row = document.getElementById('cap-countdown-row');
    if (row) row.style.display = 'none';
    if (_countdownRaf) { cancelAnimationFrame(_countdownRaf); _countdownRaf = 0; }
}

function _tickCountdown() {
    if (!_captureRunning) { stopCountdown(); return; }
    const elapsed = Date.now() - _exposureStartMs;
    const remaining = Math.max(0, _exposureDurationMs - elapsed);
    const frac = _exposureDurationMs > 0 ? Math.min(1, elapsed / _exposureDurationMs) : 0;

    const totalSec = remaining / 1000;
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(totalSec % 60)).padStart(2, '0');
    const ds = String(Math.floor((totalSec % 1) * 10));

    const el = document.getElementById('cap-countdown');
    if (el) el.textContent = `${mm}:${ss}.${ds}`;

    const fill = document.getElementById('cap-exp-fill');
    if (fill) fill.style.width = (frac * 100) + '%';

    _countdownRaf = requestAnimationFrame(_tickCountdown);
}

function updateCaptureProgress() {
    const section = document.getElementById('cap-progress-section');
    const fill = document.getElementById('cap-progress-fill');
    const text = document.getElementById('cap-progress-text');
    const exposeBtn = document.getElementById('cap-expose-btn');
    if (!section) return;

    const done = _captureTotal - _captureQueue;
    if (_captureTotal > 0 && _captureRunning) {
        section.style.display = '';
        const pct = _captureTotal > 0 ? (done / _captureTotal * 100) : 0;
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${done} / ${_captureTotal}`;
        if (exposeBtn) exposeBtn.disabled = true;
    } else {
        section.style.display = 'none';
        stopCountdown();
        if (exposeBtn) exposeBtn.disabled = false;
    }
    // Publie la progression de la capture rapide (séquence/stacking/app s'en
    // servent : exclusion caméra + affichage en direct sans poll).
    Bus.emit('capture:progress', {
        running: _captureRunning,
        done,
        total: _captureTotal,
        last: _captureFilter || null,
        aborted: _captureAborted,
    }, { source: 'capture' });
}

function renderCapturePanel() {
    const container = document.getElementById('applet-capture-settings');
    if (!container) return;

    const cam = findCamera();
    const statusBar = document.getElementById('cam-status-bar');
    const statusLed = document.getElementById('cam-status-led');
    const statusLabel = document.getElementById('cam-status-label');

    // Determine state
    let state, label;
    if (!cam) {
        state = 'none';
        label = i18n('cap.no_camera');
    } else if (!cam.dev.is_ready) {
        state = 'attaching';
        label = i18nFmt('cap.attaching', { name: cam.name });
    } else if (!cam.dev.connected) {
        state = 'disconnected';
        label = i18nFmt('cap.disconnected', { name: cam.name });
    } else {
        state = 'ready';
        label = cam.name;
    }

    if (statusBar) statusBar.dataset.state = state;
    if (statusLabel) statusLabel.textContent = label;

    // Show connect button when camera is discovered but not connected/ready
    const btnCamConnect = document.getElementById('btn-cam-connect');
    if (btnCamConnect) {
        const showConnect = cam && !cam.dev.connected && !cam.dev.is_ready;
        btnCamConnect.style.display = showConnect ? '' : 'none';
        btnCamConnect.onclick = async () => {
            if (!cam) return;
            addLog('info', 'ws', i18nFmt('log.ws.conn_manual', { name: cam.name }));
            try {
                const res = await fetch('/api/device/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device: cam.name }),
                });
                const data = await res.json();
                if (data.ok) addLog('info', 'ws', i18nFmt('log.ws.conn_sent', { name: cam.name }));
                else addLog('error', 'ws', i18nFmt('log.ws.error', { err: JSON.stringify(data) }));
            } catch (e) {
                addLog('error', 'ws', i18nFmt('log.ws.error', { err: e.message }));
            }
        };
    }

    // Populate camera selector (only shown when >1 camera)
    const camSelect = document.getElementById('cap-camera-select');
    const camSection = document.getElementById('cap-camera-section');
    const cameras = Object.entries(devices).filter(([, d]) => d.type === 'camera');
    if (camSelect && camSection) {
        if (cameras.length > 1) {
            camSection.style.display = '';
            const prevVal = camSelect.value || selectedCamera;
            camSelect.innerHTML = '';
            cameras.forEach(([name]) => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                camSelect.appendChild(opt);
            });
            if (prevVal && cameras.some(([n]) => n === prevVal)) {
                camSelect.value = prevVal;
            } else if (cameras.length > 0) {
                camSelect.value = cameras[0][0];
            }
        } else {
            camSection.style.display = 'none';
        }
    }

    if (!cam) {
        container.querySelectorAll('input, select, button:not(.applet-minimize)').forEach(el => {
            el.disabled = true;
        });
        return;
    }

    container.querySelectorAll('input, select, button:not(.applet-minimize)').forEach(el => {
        el.disabled = false;
    });

    const d = cam.dev;

    // Sensor info
    const sensorInfo = document.getElementById('cap-sensor-info');
    if (sensorInfo && d.width_px && d.height_px) {
        sensorInfo.textContent = `${d.width_px}×${d.height_px} — ${d.pixel_size_um}µm`;
    }

    // Binning
    const binSel = document.getElementById('cap-binning');
    if (binSel && d.binning_x != null) {
        binSel.value = d.binning_x;
    }

    // Gain
    const gainInput = document.getElementById('cap-gain');
    const gainSlider = document.getElementById('cap-gain-slider');
    if (gainInput && d.gain != null && document.activeElement !== gainInput) {
        gainInput.value = d.gain;
        if (gainSlider) gainSlider.value = d.gain;
    }

    // Offset
    const offsetInput = document.getElementById('cap-offset');
    const offsetSlider = document.getElementById('cap-offset-slider');
    if (offsetInput && d.offset != null && document.activeElement !== offsetInput) {
        offsetInput.value = d.offset;
        if (offsetSlider) offsetSlider.value = d.offset;
    }

    // Temperature
    const tempEl = document.getElementById('cap-temp-current');
    if (tempEl) {
        tempEl.textContent = d.temperature != null ? `${d.temperature.toFixed(1)} °C` : '--- °C';
    }
    const targetTempInput = document.getElementById('cap-target-temp');
    if (targetTempInput && d.target_temp != null && document.activeElement !== targetTempInput) {
        targetTempInput.value = d.target_temp;
    }

    // Frame type
    if (d.frame_type) {
        _captureFrameType = d.frame_type;
        document.querySelectorAll('.cap-ft-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.frame === d.frame_type);
        });
    }

    renderCaptureFilter();
}

function findFilterWheel() {
    const fws = Object.entries(devices).filter(([, d]) => d.type === 'filterwheel');
    return fws.length ? { name: fws[0][0], dev: fws[0][1] } : null;
}

function renderCaptureFilter() {
    const section = document.getElementById('cap-filter-section');
    if (!section) return;
    const fw = findFilterWheel();
    const sel = document.getElementById('cap-filter-select');
    const info = document.getElementById('cap-filter-wheel-info');
    if (!fw) {
        section.style.display = 'none';
        _captureFilter = '';
        return;
    }
    section.style.display = '';
    const connected = !!(fw.dev.connected);
    if (info) {
        info.textContent = connected
            ? `${fw.name} — ${_captureFilter || '—'}`
            : `${fw.name} (déconnectée)`;
    }
    if (!sel) return;
    // Support both conventions: FILTER_SLOT (switch, mock) and
    // WHEEL_SLOT (number) + WHEEL_SLOT_NAME (text, native INDIGO 2.x).
    const switchPv = (fw.dev.props || []).find(p => p.name === 'FILTER_SLOT') || null;
    const wheelNames = (fw.dev.props || []).find(p => p.name === 'WHEEL_SLOT_NAME') || null;
    const wheelPv = (fw.dev.props || []).find(p => p.name === 'WHEEL_SLOT') || null;
    let opts = '';
    let current = null;
    if (switchPv) {
        opts = switchPv.items.map(i =>
            `<option value="${escapeAttr(i.name)}">${escapeHTML(i.label || i.name)}</option>`).join('');
        const selItem = switchPv.items.find(i => i.value === true);
        current = selItem ? selItem.name : null;
    } else if (wheelNames) {
        opts = wheelNames.items.map(i => {
            const m = i.name.match(/_(\d+)$/);
            const value = (i.value || i.label || i.name);
            return `<option value="${escapeAttr(value)}">${escapeHTML(value)}</option>`;
        }).join('');
        // Current slot from WHEEL_SLOT number (1-based index)
        if (wheelPv && wheelPv.items && wheelPv.items[0]) {
            const idx = Math.round(Number(wheelPv.items[0].value));
            const curItem = wheelNames.items.find(i => {
                const m = i.name.match(/_(\d+)$/);
                return m && parseInt(m.group(1), 10) === idx;
            });
            current = curItem ? (curItem.value || curItem.label || curItem.name) : null;
        }
    }
    const selected = _captureFilter || (current || '');
    const html = '<option value="">— Aucun —</option>' + opts;
    // renderCaptureFilter runs on every WS state broadcast. Only touch the DOM
    // when the option set changed, to avoid tearing while the page re-renders.
    if (sel.dataset.filterHtml !== html) {
        sel.dataset.filterHtml = html;
        sel.innerHTML = html;
    }
    if (selected && opts.includes(`value="${escapeAttr(selected)}"`)) sel.value = selected;
    sel.disabled = !connected;
}

// ── Bus : consommateur ws:state ───────────────────────────────

Bus.on('ws:state', () => renderCapturePanel());

