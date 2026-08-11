// @ts-check
// Cover TODO_LIST items 5-10:
//   5.  CR "Étoile perdue" — calibration after hard refresh + focus-metric retry (3×)
//   6.  Courbe SNR jaune visible pendant un guidage
//   7.  Toast "Calibration terminée" + bouton "Démarrer guidage"
//   8.  Calibration : tracé correct + auto-population des gains RA/DEC
//   9.  Guidage : Capture → Auto → Lancer → graphe 120s
//   10. Zoom/Pan : molette, clic-glisser, double-clic reset, 1:1 / ◻
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17630;
const WEB_PORT = 18091;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, 'venv', 'bin', 'python');
let mockProc, webProc, mockLog, webLog;

function waitForServer(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => { res.resume(); resolve(true); })
        .on('error', () => {
          if (Date.now() - start > timeout) return reject(new Error('timeout'));
          setTimeout(check, 500);
        });
    };
    check();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function killProc(proc) {
  return new Promise(resolve => {
    if (!proc || proc.killed) return resolve();
    proc.on('close', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

beforeAll(async () => {
  for (const port of [MOCK_PORT, WEB_PORT]) {
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  }
  await sleep(500);

  const profilesPath = path.join(os.tmpdir(), `ui-profiles-${Date.now()}.yaml`);
  const env = { ...process.env, INDIGO_PROFILES_PATH: profilesPath };

  mockProc = spawn(PYTHON,
    [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  mockLog = fs.createWriteStream('/tmp/opencode/gv-mock.log', { flags: 'a' });
  mockProc.stderr.on('data', d => mockLog.write(d));
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: 'pipe', cwd: ROOT, env });
  webProc.stdout.on('data', () => {});
  webLog = fs.createWriteStream('/tmp/opencode/gv-web.log', { flags: 'a' });
  webProc.stderr.on('data', d => webLog.write(d));
  await waitForServer(`${BASE_URL}/api/connection`, 20000);

  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/connection`);
      const data = await res.json();
      if (data.connected) break;
    } catch {}
    await sleep(1000);
  }
});

afterAll(async () => {
  await killProc(webProc);
  await killProc(mockProc);
  for (const port of [WEB_PORT, MOCK_PORT]) {
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  }
});

async function uiClick(page, selector) {
  // The drift-graph panel overlaps the bottom of the preview panel and would
  // intercept pointer events in real clicks; dispatchEvent still runs the
  // addEventListener('click', ...) handlers.
  await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) throw new Error(`missing #${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, selector.replace(/^#/, ''));
}

async function enterGuiding(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await page.click('button[data-mode="guiding"]');
  await sleep(800);
  const select = page.locator('#guide-camera-select');
  await expect(select).toBeVisible();
  // Connect the guide camera + mount (mirrors the working repro script)
  await page.evaluate(async () => {
    await fetch('/api/hardware/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'Guide Camera' }) });
    await fetch('/api/hardware/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'Mount' }) });
  });
  await sleep(1000);
  // Pick the guide camera (mock exposes "Main Camera" + "Guide Camera")
  await page.selectOption('#guide-camera-select', { label: 'Guide Camera' });
  await sleep(300);
}

async function waitForCalibrationDone(page, timeout = 180000) {
  const phase = page.locator('#cal-phase');
  await phase.waitFor({ state: 'visible', timeout: 10000 });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const txt = (await phase.textContent()) || '';
    if (txt.includes('✅ Terminé')) return txt;
    if (txt.includes('❌')) return txt; // let the assertion fail with detail
    await sleep(2000);
  }
  return (await phase.textContent()) || '';
}

test.describe.serial('Calibration + guidage validation (items 5-10)', () => {

  // Items 5, 7, 8: calibration with transient focus-metric failures (retry 3×),
  // toast with "Démarrer guidage", auto-populated gains, drawn graph — then a hard
  // reload to re-verify calibration still completes (no stale app.js cache).
  test('calibration complète après refresh, retry focus-metric, gains auto, toast', async ({ page }) => {
    test.setTimeout(240000);

    // Simulate 2 transient focus-metric failures inside the calibration loop
    // (the pre-start preview call must still succeed).
    let metricCalls = 0;
    await page.route('**/api/focuser/focus-metric*', async (route) => {
      metricCalls += 1;
      if (metricCalls >= 2 && metricCalls <= 3) {
        await route.fulfill({ json: { ok: false, error: 'transient' } });
      } else {
        await route.continue();
      }
    });

    await enterGuiding(page);

    // Reduce per-pulse time to speed up the mock calibration.
    // Note: #cal-pulse-ms lives inside the hidden #cal-status-wrap, so set the
    // value directly (it is read by _calibrateStart) rather than via fill().
    await page.evaluate(() => { const el = document.getElementById('cal-pulse-ms'); if (el) el.value = '100'; });

    // Start calibration
    await page.click('#cal-start-btn');
    const firstResult = await waitForCalibrationDone(page);

    // Retry path must have absorbed the transient failures
    expect(firstResult).toContain('✅ Terminé');
    expect(firstResult).not.toContain('❌');

    // Log must show the retry warnings (tentative 1/3, 2/3)
    const calLog = await page.locator('#log-content').innerText();
    expect(calLog).toContain('Métrique étoile indisponible');

    // Item 8: results panel visible with rates/quality (real values, not dashes)
    const results = page.locator('#cal-results');
    await expect(results).toBeVisible();
    const rateText = await results.innerText();
    expect(rateText).toContain('px/ms');
    expect(rateText).not.toContain('<span id="cal-x-rate"');

    // Item 8: gains auto-populated from x_rate / y_rate
    const raGain = await page.inputValue('#guide-ra-gain');
    const decGain = await page.inputValue('#guide-dec-gain');
    expect(parseFloat(raGain)).toBeGreaterThan(0);
    expect(parseFloat(decGain)).toBeGreaterThan(0);
    expect(raGain).not.toBe('1.0');
    expect(decGain).not.toBe('1.0');

    // Item 8: calibration graph was drawn (non-empty canvas)
    const drawn = await page.evaluate(() => {
      const c = document.getElementById('cal-graph-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    });
    expect(drawn).toBe(true);

    // Item 7: toast present
    const toast = page.locator('body > div', { hasText: 'Calibration terminée' }).last();
    await toast.waitFor({ state: 'visible', timeout: 10000 });
    const startBtn = toast.locator('button', { hasText: 'Démarrer guidage' });
    await expect(startBtn).toBeVisible();

    // Item 5: hard reload (= Ctrl+Shift+R), calibration state resets and a fresh
    // calibration still runs to completion (stale app.js cache hypothesis refuted).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.click('button[data-mode="guiding"]');
    await sleep(800);
    await page.selectOption('#guide-camera-select', { label: 'Guide Camera' });
    await sleep(300);
    await page.evaluate(() => { const el = document.getElementById('cal-pulse-ms'); if (el) el.value = '100'; });
    await page.click('#cal-start-btn');
    const secondResult = await waitForCalibrationDone(page);
    expect(secondResult).toContain('✅ Terminé');

    // Toast reappears after reload
    const toast2 = page.locator('body > div', { hasText: 'Calibration terminée' }).last();
    await toast2.waitFor({ state: 'visible', timeout: 10000 });
    await expect(toast2.locator('button', { hasText: 'Démarrer guidage' })).toBeVisible();
  });

  // Item 9: workflow Capture → Auto → Lancer; Item 6: SNR curve; Item 10: zoom/pan.
  test('workflow guidage (Capture→Auto→Lancer), courbe SNR jaune, graphe, zoom/pan', async ({ page }) => {
    test.setTimeout(120000);
    await enterGuiding(page);

    // Item 9a: Capture
    await uiClick(page, '#guide-capture-btn');
    const status = page.locator('#guide-preview-status');
    await expect(status).toContainText('étoiles', { timeout: 15000 });

    // Item 9b: Auto (select best star)
    await uiClick(page, '#guide-autoselect-btn');
    await expect(status).toContainText('Prêt', { timeout: 15000 });

    // An image must be loaded in the guide viewer for fitZoom to work
    await page.waitForFunction(() => {
      const c = document.getElementById('guide-preview-canvas');
      return !!c && c.width > 0 && c.height > 0;
    }, { timeout: 15000 });

    // --- Item 10: zoom / pan on guide preview ---
    const vp = page.locator('#guide-preview-viewport');
    const box = await vp.boundingBox();
    expect(box).not.toBeNull();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    // Baseline zoom = fit (something < 1 for 640x480 image in ~350x... viewport)
    await page.mouse.move(cx, cy);
    const zoomBefore = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.zoom : 0);
    expect(zoomBefore).toBeGreaterThan(0);

    // Molette → zoom increases past 1 (guide pan requires zoom > 1)
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -1500);
    if (process.env.CI) await sleep(100);
    const zoomAfterWheel = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.zoom : 0);
    expect(zoomAfterWheel).toBeGreaterThan(zoomBefore);
    expect(zoomAfterWheel).toBeGreaterThan(1);
    const levelText = await page.locator('#guide-preview-zoom-level').textContent();
    expect(levelText.trim()).toMatch(/\d+%/);

    // Clic-glisser → pan changes
    const panBefore = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.panX : 0);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 8 });
    await page.mouse.up();
    const panAfter = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.panX : 0);
    expect(panAfter).not.toBe(panBefore);

    // Bouton 1:1 → reset zoom to 100%
    await uiClick(page, '#guide-preview-zoom-reset');
    const zoomReset = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.zoom : 0);
    expect(zoomReset).toBe(1);
    await expect(page.locator('#guide-preview-zoom-level')).toHaveText('100%');

    // Bouton ◻ → fit zoom (0 < fit < 1)
    await uiClick(page, '#guide-preview-zoom-fit');
    const zoomFit = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.zoom : 0);
    expect(zoomFit).toBeGreaterThan(0);
    expect(zoomFit).toBeLessThan(1);

    // Double-clic → reset zoom (spec item: double-clic reset)
    await page.mouse.move(cx, cy);
    await page.dblclick('#guide-preview-viewport', { position: { x: box.width / 2, y: box.height / 2 } });
    if (process.env.CI) await sleep(100);
    const zoomDbl = await page.evaluate(() => __viewer.guideViewer ? __viewer.guideViewer.zoom : 0);
    expect(zoomDbl).toBe(1);

    // --- Item 9c: Lancer → guidage runs, graph draws ---
    await uiClick(page, '#guide-start-btn');
    const frameCount = page.locator('#guide-frame-count');
    await expect.poll(async () => parseInt((await frameCount.textContent()) || '0', 10), {
      timeout: 30000,
    }).toBeGreaterThan(1);

    // Item 6: guide history carries SNR → yellow SNR curve drawn on drift canvas
    const gstatus = await (await fetch(`${BASE_URL}/api/guide/status`)).json();
    const hist = gstatus && gstatus.history ? gstatus.history : [];
    const snrOk = hist.length > 0 && hist.some(e => e.snr != null && e.snr > 0);
    expect(snrOk).toBe(true);

    // Drift canvas has non-blank pixels (graph + SNR curve)
    const driftDrawn = await page.evaluate(() => {
      const c = document.getElementById('guide-drift-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlank = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBlank++;
      return nonBlank > 10;
    });
    expect(driftDrawn).toBe(true);
  });
});