// @ts-check
// framing-ui.spec.js — Framing assistant (Lot D3).
// Vérifie que le panneau Framing existe en mode astrometry, que le slider de
// rotation pilote l'overlay (skyEngine.cameraRotDeg), qu'une cible définie par
// id (M42) charge sa taille angulaire et produit un fit-check, sans erreur JS.
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17646;
const WEB_PORT = 18106;
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
  for (const port of [MOCK_PORT, WEB_PORT]) {
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  }
  await sleep(500);

  const profilesPath = path.join(os.tmpdir(), `ui-profiles-frame-${Date.now()}.yaml`);
  const env = { ...process.env, INDIGO_PROFILES_PATH: profilesPath };

  mockProc = spawn(PYTHON,
    [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT, env });
  await waitForServer(`${BASE_URL}/api/connection`, 20000);
});

afterAll(async () => {
  await killProc(webProc);
  await killProc(mockProc);
});

test('framing assistant: rotation + cible M42 + fit-check', async ({ page }) => {
  const errors = [];
  const bad404 = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) bad404.push(`${r.status()} ${r.url()}`); });

  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Basculer en mode astrometry
  const buttons = page.locator('[data-mode]');
  const n = await buttons.count();
  let clicked = false;
  for (let i = 0; i < n; i++) {
    const txt = (await buttons.nth(i).textContent()) || '';
    if (/astro|solve|astr/i.test(txt)) {
      await buttons.nth(i).click();
      clicked = true;
      break;
    }
  }
  expect(clicked, 'bouton mode astrometry').toBe(true);
  await page.waitForTimeout(1000);

  const framing = page.locator('#applet-framing');
  await framing.waitFor({ state: 'visible', timeout: 8000 });

  // FOV manuel (décoche l'auto) pour un fit-check déterministe
  await page.locator('#frame-use-camera').uncheck();
  await page.locator('#frame-fov-x').fill('1.0');
  await page.locator('#frame-fov-y').fill('1.0');

  // Slider de rotation → valeur affichée
  await page.locator('#frame-rot').fill('45');
  await page.waitForTimeout(250);
  expect(await page.locator('#frame-rot-val').textContent()).toBe('45°');

  // Rotation auto depuis le solve : le topic solver:result met à jour l'angle.
  await page.evaluate(() => {
    Hub.emit('solver:result', { result: { rotation: 123.4 } }, { source: 'test' });
  });
  await page.evaluate(() => document.getElementById('frame-rot-solve').click());
  await page.waitForTimeout(300);
  expect(await page.locator('#frame-rot-val').textContent()).toBe('123°');

  // Cible par id M42 → taille + fit-check
  await page.locator('#frame-target-id').fill('M42');
  await page.evaluate(() => document.getElementById('frame-set').click());
  await page.waitForTimeout(1500);

  const sizeTxt = await page.locator('#frame-size').textContent();
  expect(sizeTxt, 'taille M42').not.toBe('—');

  const fitVisible = await page.locator('#frame-fit').isVisible();
  expect(fitVisible).toBe(true);
  const fitText = await page.locator('#frame-fit-text').textContent();
  expect(fitText.length).toBeGreaterThan(0);

  // Autres erreurs que le 404 testharness pré-existant
  const known404 = bad404.filter(u => u.includes('testharness.js')).length;
  const otherErrs = errors.filter(e => !(e.includes('404') && known404 > 0));
  expect(otherErrs, 'aucune autre erreur JS').toEqual([]);
});