// @ts-check
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17624;
const WEB_PORT = 18090;
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
const MODE_CAPTURE = 'button[data-mode="capture"]';
const MODE_FOCUSER = 'button[data-mode="focuser"]';
const MODE_GUIDING = 'button[data-mode="guiding"]';

async function openPage(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
}

test.describe.serial('Viewer multi-modes', () => {

  test('viewer hidden in mount mode', async ({ page }) => {
    await openPage(page);
    // Explicitly switch to mount mode (saved config may be astrometry from previous test)
    await page.click(MODE_MOUNT);
    await sleep(500);
    await expect(page.locator('#applet-capture-preview')).toBeHidden();
  });

  test('viewer visible in capture mode', async ({ page }) => {
    await openPage(page);
    await page.click(MODE_CAPTURE);
    await sleep(500);
    await expect(page.locator('#applet-capture-preview')).toBeVisible();
  });

  test('viewer visible in astrometry mode', async ({ page }) => {
    await openPage(page);
    await page.click(MODE_ASTRO);
    await sleep(500);
    await expect(page.locator('#applet-capture-preview')).toBeVisible();
  });

  test('viewer visible in focuser mode', async ({ page }) => {
    await openPage(page);
    await page.click(MODE_FOCUSER);
    await sleep(500);
    await expect(page.locator('#applet-capture-preview')).toBeVisible();
  });

  test('viewer visible in guiding mode', async ({ page }) => {
    await openPage(page);
    await page.click(MODE_GUIDING);
    await sleep(500);
    await expect(page.locator('#applet-guide-preview')).toBeVisible();
    await expect(page.locator('#applet-capture-preview')).toBeHidden();
  });

  test('viewer title changes per mode', async ({ page }) => {
    await openPage(page);
    const title = page.locator('#viewer-title');

    await page.click(MODE_CAPTURE);
    await sleep(300);
    await expect(title).toContainText('CAPTURE');

    await page.click(MODE_ASTRO);
    await sleep(300);
    await expect(title).toContainText('ASTROMÉTRIE');

    await page.click(MODE_FOCUSER);
    await sleep(300);
    await expect(title).toContainText('FOCUSER');

    await page.click(MODE_GUIDING);
    await sleep(300);
    await expect(title).toContainText('GUIDAGE');
  });

  test('save button only visible in capture mode', async ({ page }) => {
    await openPage(page);

    // Capture: save visible
    await page.click(MODE_CAPTURE);
    await sleep(300);
    const saveSection = page.locator('#cap-save-dir').locator('..');
    await expect(saveSection).toBeVisible();

    // Astrometry: save hidden
    await page.click(MODE_ASTRO);
    await sleep(300);
    await expect(saveSection).toBeHidden();
  });

  test('histogram visible in capture and focuser modes', async ({ page }) => {
    await openPage(page);

    // In capture mode, histogram canvas own display should not be 'none'
    await page.click(MODE_CAPTURE);
    await sleep(300);
    const histoDisplay1 = await page.locator('#cap-histo-canvas').evaluate(el => el.style.display);
    expect(histoDisplay1).not.toBe('none');

    // In focuser mode, same
    await page.click(MODE_FOCUSER);
    await sleep(300);
    const histoDisplay2 = await page.locator('#cap-histo-canvas').evaluate(el => el.style.display);
    expect(histoDisplay2).not.toBe('none');
  });

  test('histogram hidden in guiding mode', async ({ page }) => {
    await openPage(page);

    await page.click(MODE_GUIDING);
    await sleep(300);
    const histoDisplay = await page.locator('#cap-histo-canvas').evaluate(el => el.style.display);
    expect(histoDisplay).toBe('none');
  });
});
