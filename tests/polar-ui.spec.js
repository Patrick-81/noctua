// @ts-check
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17626;
const WEB_PORT = 18091;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, 'venv', 'bin', 'python');
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
  mockProc.stderr?.on('data', d => process.stderr.write('[mock] ' + d));
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  webProc.stdout?.on('data', () => {}); // uvicorn access logs go to stdout — must drain or the pipe fills and the event loop blocks
  webProc.stderr?.on('data', d => process.stderr.write('[web] ' + d));
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
  try { execSync(`fuser -k ${WEB_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  try { execSync(`fuser -k ${MOCK_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
});

const MODE_ASTRO = 'button[data-mode="astrometry"]';
const MODE_MOUNT = 'button[data-mode="mount"]';

async function openPage(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
}

async function switchToAstrometry(page) {
  await page.click(MODE_ASTRO);
  await sleep(500);
}

test.describe.serial('Polar alignment panel', () => {

  test('panel appears in astrometry mode', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);
    await expect(page.locator('#applet-polar')).toBeVisible({ timeout: 5000 });
  });

  test('panel hidden in mount mode', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);
    await page.click(MODE_MOUNT);
    await sleep(500);
    await expect(page.locator('#applet-polar')).toBeHidden();
  });

  test('Auto mode: capture hidden, Démarrer visible', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    await expect(page.locator('.polar-mode-btn[data-polar-mode="auto"]')).toHaveClass(/active/);
    await expect(page.locator('.polar-manual-only').first()).toBeHidden();
    await expect(page.locator('#polar-start-btn')).toBeVisible();
    await expect(page.locator('#polar-stop-btn')).toBeHidden();
  });

  test('Manual mode: capture visible, Démarrer hidden', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    await page.click('.polar-mode-btn[data-polar-mode="manual"]');
    await sleep(300);

    await expect(page.locator('.polar-mode-btn[data-polar-mode="manual"]')).toHaveClass(/active/);
    await expect(page.locator('.polar-manual-only').first()).toBeVisible();
    await expect(page.locator('#polar-start-btn')).toBeHidden();
  });

  test('angle input updates step labels', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    const s2Label = page.locator('#polar-step2-label');
    await expect(s2Label).toContainText('30min');

    await page.fill('#polar-angle', '60');
    await page.locator('#polar-angle').dispatchEvent('change');
    await sleep(300);
    // >= 60min formats as hours
    await expect(s2Label).toContainText('1.0h');

    await page.fill('#polar-angle', '15');
    await page.locator('#polar-angle').dispatchEvent('change');
    await sleep(300);
    await expect(s2Label).toContainText('15min');
  });

  test('mount control buttons exist', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    await expect(page.locator('#polar-track-btn')).toHaveText('Tracking ON');
    await expect(page.locator('#polar-unpark-btn')).toBeVisible();
    await expect(page.locator('#polar-abort-btn')).toHaveText('Stop');
  });

  test('click Tracking ON sends API call', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    let trackingRequest = null;
    page.on('request', req => {
      if (req.url().includes('/api/mount/tracking')) trackingRequest = req;
    });

    await page.click('#polar-track-btn');
    await sleep(1000);

    expect(trackingRequest).not.toBeNull();
    const res = await page.evaluate(() => fetch('/api/mount').then(r => r.json()));
    expect(res.tracking).toBe(true);
  });

  test('click Unpark sends API call', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    let unparkRequest = null;
    page.on('request', req => {
      if (req.url().includes('/api/mount/unpark')) unparkRequest = req;
    });

    await page.click('#polar-unpark-btn');
    await sleep(1000);

    expect(unparkRequest).not.toBeNull();
    const res = await page.evaluate(() => fetch('/api/mount').then(r => r.json()));
    expect(res.parked).toBe(false);
  });

  test('Reset clears step statuses', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    await page.click('#polar-reset-btn');
    await sleep(300);

    await expect(page.locator('#polar-step1-status')).toContainText('◻');
    await expect(page.locator('#polar-step2-status')).toContainText('◻');
    await expect(page.locator('#polar-step3-status')).toContainText('◻');
    await expect(page.locator('#polar-results')).toBeHidden();
    await expect(page.locator('#polar-progress')).toBeHidden();
  });

  test('angle input min/max constraints', async ({ page }) => {
    await openPage(page);
    await switchToAstrometry(page);

    await expect(page.locator('#polar-angle')).toHaveAttribute('min', '5');
    await expect(page.locator('#polar-angle')).toHaveAttribute('max', '120');
    await expect(page.locator('#polar-angle')).toHaveValue('30');
  });
});
