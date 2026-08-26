// @ts-check
// hub-ui.spec.js — Coexistence bus legacy + Hub.
// Vérifie que hub.js charge sans erreur, qu'un emit sur topic non déclaré
// produit une ligne [Hub] visible dans le panneau Log, et que la connexion
// d'une caméra (mock) notifie guide/target/stacking/sky-engine via le Hub.
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17640;
const WEB_PORT = 18098;
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

async function apiPost(p, data) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  });
  return res.json();
}

beforeAll(async () => {
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
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  webProc.stdout.on('data', () => {});
  webProc.stderr.on('data', () => {});
  await waitForServer(`${BASE_URL}/api/connection`, 20000);

  for (let i = 0; i < 20; i++) {
    try {
      const data = await (await fetch(`${BASE_URL}/api/connection`)).json();
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

test.describe.serial('Hub (coexistence bus legacy + Hub)', () => {

  test('hub.js est chargé sans erreur et coexiste avec Bus', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    const globals = await page.evaluate(() => ({
      hub: typeof window.Hub !== 'undefined' || typeof Hub !== 'undefined',
      bus: typeof Bus !== 'undefined',
      hubKeys: typeof Hub !== 'undefined' ? Object.keys(Hub) : [],
    }));
    expect(globals.hub).toBe(true);
    expect(globals.bus).toBe(true);
    expect(globals.hubKeys).toEqual(expect.arrayContaining(['subscribe', 'emit', 'getState']));
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('connexion d\'une caméra → ligne [Hub] dans le Log + 4 panneaux notifiés', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // Point de départ propre : attendre que la caméra soit connectée,
    // la déconnecter, et attendre que l'état le confirme.
    async function camState() {
      const data = await (await fetch(`${BASE_URL}/api/hardware`)).json();
      return data.devices['Main Camera'] ? data.devices['Main Camera'].connected : null;
    }
    for (let i = 0; i < 20 && !(await camState()); i++) await sleep(500);
    await apiPost('/api/hardware/disconnect', { device: 'Main Camera' });
    for (let i = 0; i < 20 && (await camState()); i++) await sleep(500);

    const before = await page.evaluate(() => ({
      guide: window.__hubGuideNotified || 0,
      stacking: window.__hubStackingNotified || 0,
      target: window.__hubTargetNotified || 0,
      sky: window.__hubSkyNotified || 0,
      logCount: document.querySelectorAll('#log-content .log-entry').length,
    }));

    // Capte le dernier payload device:connected pour vérifier les dimensions capteur.
    await page.evaluate(() => {
      window.__lastHubEnv = null;
      window.__hubEvents = [];
      Hub.subscribe('device:connected', '__sensor-check', (env) => {
        window.__hubEvents.push({ name: env.payload.name, sensor: env.payload.sensor });
        window.__lastHubEnv = env;
      });
    });

    await apiPost('/api/hardware/connect', { device: 'Main Camera' });

    // L'émission est confirmée après HUB_CONFIRM_MS (1200 ms) : on attend
    // que les 4 panneaux soient effectivement notifiés.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const after = await page.evaluate(() => ({
        guide: window.__hubGuideNotified || 0,
        stacking: window.__hubStackingNotified || 0,
        target: window.__hubTargetNotified || 0,
        sky: window.__hubSkyNotified || 0,
      }));
      if (after.guide > before.guide && after.stacking > before.stacking &&
          after.target > before.target && after.sky > before.sky) break;
      await sleep(300);
    }
    const after = await page.evaluate(() => ({
      guide: window.__hubGuideNotified || 0,
      stacking: window.__hubStackingNotified || 0,
      target: window.__hubTargetNotified || 0,
      sky: window.__hubSkyNotified || 0,
    }));
    expect(after.guide).toBeGreaterThan(before.guide);
    expect(after.stacking).toBeGreaterThan(before.stacking);
    expect(after.target).toBeGreaterThan(before.target);
    expect(after.sky).toBeGreaterThan(before.sky);

    // Ligne [Hub] visible dans le panneau Log (niveau info → filtre actif)
    const line = page.locator('#log-content .log-entry', { hasText: '[Hub] hardware.emit(device:connected)' });
    await expect(line.first()).toBeVisible({ timeout: 10000 });
    const text = await line.first().innerText();
    expect(text).toContain('→');
    for (const t of ['guide', 'stacking', 'target', 'sky-engine']) {
      expect(text).toContain(t);
    }

    // Le payload porte les dimensions capteur (mock : 1920×1080, 3.75 µm).
    const sensor = await page.evaluate(() => {
      const ev = (window.__hubEvents || []).find(e => e.name === 'Main Camera');
      return ev ? ev.sensor : null;
    });
    expect(sensor).toBeTruthy();
    expect(sensor.width_px).toBeGreaterThan(0);
    expect(sensor.height_px).toBeGreaterThan(0);
    expect(sensor.pixel_size_um).toBeGreaterThan(0);
  });

  test('le bus legacy reste seul propriétaire des flux anciens', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // ws:state continue d'arriver sur le Bus legacy (panneau hardware rendu)
    const ok = await page.evaluate(async () => {
      const seen = await new Promise(resolve => {
        let timer = setTimeout(() => resolve(false), 8000);
        Bus.on('ws:state', () => { clearTimeout(timer); resolve(true); });
      });
      return seen;
    });
    expect(ok).toBe(true);
  });
});
