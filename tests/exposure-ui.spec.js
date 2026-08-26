// @ts-check
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17628;
const WEB_PORT = 18094;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
let mockProc, webProc;

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
  try { execSync(`fuser -k ${MOCK_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  try { execSync(`fuser -k ${WEB_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  await sleep(500);

  mockProc = spawn(PYTHON,
    [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  webProc.stdout?.on('data', () => {});
  await waitForServer(`${BASE_URL}/api/connection`, 20000);

  for (let i = 0; i < 30; i++) {
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
  try { execSync(`fuser -k ${WEB_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  try { execSync(`fuser -k ${MOCK_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
});

test.describe('Sky exposure measurement', () => {
  test('measure button recommends an exposure and applies it', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.click('button[data-mode="capture"]');
    await sleep(800);

    const measureBtn = page.locator('#cap-measure-btn');
    await expect(measureBtn).toBeVisible();

    await measureBtn.click({ force: true });

    // La reco apparaît sous le champ d'exposition. On attend le bouton
    // « Appliquer » (présent uniquement après succès) : le texte de chargement
    // « Mesure du ciel en cours… » contient déjà un « s ».
    const reco = page.locator('#cap-exp-reco');
    await expect(reco.locator('.cap-reco-apply')).toBeVisible({ timeout: 30000 });

    // Le bouton « Appliquer » remplit le champ d'exposition.
    const expInput = page.locator('#cap-exposure');
    const before = parseFloat(await expInput.inputValue());
    await reco.locator('.cap-reco-apply').click();
    const after = parseFloat(await expInput.inputValue());
    expect(after).toBeGreaterThan(0);
    expect(after).not.toBe(before);

    expect(errors).toEqual([]);
  });

  test('GET recommend reuses the last image', async ({ page }) => {
    // Self-sufficient: run a single-shot estimate first so the server holds
    // frames (do not depend on the order/result of the previous test).
    const est = await fetch(`${BASE_URL}/api/camera/exposure/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'Main Camera', shots: 1 }),
    });
    const estData = await est.json();
    expect(estData.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(estData, 'exposure_s')).toBe(true);

    const res = await fetch(`${BASE_URL}/api/camera/exposure/recommend`);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(data, 'exposure_s')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(data, 'sky_adu')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(data, 'capped_by')).toBe(true);
  });

  test('3-shot  measures sky and shows multi mode reco (knee-aware)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.click('button[data-mode="capture"]');
    await sleep(800);

    // Select the 3-shot mode on the measure row.
    await page.selectOption('#cap-measure-shots', '3');

    await page.click('#cap-measure-btn', { force: true });

    // Wait for a successful recommendation (the Apply button only appears on
    // success; the loading text itself already contains an 's').
    const reco = page.locator('#cap-exp-reco');
    await expect(reco.locator('.cap-reco-apply')).toBeVisible({ timeout: 40000 });
    await expect(reco).toContainText('s');

    // The multi result carries the fitted slope and bias-independence fields.
    const res = await (await fetch(`${BASE_URL}/api/camera/exposure/recommend`)).json();
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('multi');
    expect(res.bg_rate).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(res, 'knee_detected')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res, 'bias')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res, 'r2')).toBe(true);
    expect(res.test_durations).toHaveLength(3);

    expect(errors).toEqual([]);
  });
});