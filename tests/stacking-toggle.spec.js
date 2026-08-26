// @ts-check
// stacking-toggle.spec.js — Toggle LIVE STACKING en mode capture.
// Vérifie que l'état du toggle persiste à travers les changements de mode
// (switchMode force display='' sur #applet-stacking) et que l'indicateur
// .stacking-on reste cohérent.
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17637;
const WEB_PORT = 18097;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
let mockProc, webProc;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-toggle-'));
const SAVE_DIR = path.join(TMP, 'captures');
const CONFIG = path.join(TMP, 'config.yaml');

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

async function apiGet(p) {
  const res = await fetch(`${BASE_URL}${p}`);
  return res.json();
}

beforeAll(async () => {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, `
indigo:
  host: 127.0.0.1
  port: ${MOCK_PORT}
web:
  host: 127.0.0.1
  port: ${WEB_PORT}
site:
  name: Test
  latitude: 43.952
  longitude: 1.568
  elevation: 210
  timezone: Europe/Paris
sequence:
  save_dir: ${SAVE_DIR}
  dither:
    enabled: false
    amount: 0.0
  stack:
    enabled: false
    max_frames: 0
  frames:
    - duration: 0.5
      frame_type: LIGHT
      filter: ""
      count: 1
      delay: 0.1
`);

  for (const port of [MOCK_PORT, WEB_PORT]) {
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  }
  await sleep(500);

  mockProc = spawn(PYTHON,
    [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  mockProc.stderr.on('data', () => {});
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT),
     '--config', CONFIG],
    { stdio: 'pipe', cwd: ROOT });
  webProc.stdout.on('data', () => {});
  webProc.stderr.on('data', () => {});
  await waitForServer(`${BASE_URL}/api/connection`, 20000);

  for (let i = 0; i < 20; i++) {
    try {
      const data = await apiGet('/api/connection');
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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test.describe.serial('Toggle LIVE STACKING', () => {

  test('l\'état du toggle persiste après un changement de mode', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Mode capture → panneau masqué par défaut (hors applets auto-visibles),
    // toggle inactif
    await page.click('button[data-mode="capture"]');
    await sleep(800);
    await expect(page.locator('#applet-stacking')).not.toBeVisible();
    await expect(page.locator('#cap-stacking-toggle')).not.toHaveClass(/stacking-on/);

    // Afficher via le toggle
    await page.click('#cap-stacking-toggle');
    await sleep(300);
    await expect(page.locator('#applet-stacking')).toBeVisible();
    await expect(page.locator('#cap-stacking-toggle')).toHaveClass(/stacking-on/);

    // Quitter puis revenir en mode capture : le panneau DOIT rester affiché
    await page.click('button[data-mode="mount"]');
    await sleep(500);
    await page.click('button[data-mode="capture"]');
    await sleep(800);
    await expect(page.locator('#applet-stacking')).toBeVisible();
    await expect(page.locator('#cap-stacking-toggle')).toHaveClass(/stacking-on/);

    // Masquer via le toggle
    await page.click('#cap-stacking-toggle');
    await sleep(300);
    await expect(page.locator('#applet-stacking')).not.toBeVisible();
    await expect(page.locator('#cap-stacking-toggle')).not.toHaveClass(/stacking-on/);

    // Quitter puis revenir : le panneau DOIT rester masqué
    await page.click('button[data-mode="mount"]');
    await sleep(500);
    await page.click('button[data-mode="capture"]');
    await sleep(800);
    await expect(page.locator('#applet-stacking')).not.toBeVisible();
    await expect(page.locator('#cap-stacking-toggle')).not.toHaveClass(/stacking-on/);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
