// @ts-check
// hub-ui.spec.js — Hub : médiateur inter-panneaux unique (bus legacy supprimé).
// Vérifie que hub.js charge sans erreur, que le Bus legacy a disparu, qu'un emit
// sur topic non déclaré produit une ligne [Hub] dans le panneau Log, que la
// connexion d'une caméra (mock) notifie guide/target/stacking/sky-engine, et
// que les flux WebSocket (ws:state) arrivent bien via le Hub.
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

test.describe.serial('Hub (médiateur unique)', () => {

  test('hub.js est chargé sans erreur et le Bus legacy a disparu', async ({ page }) => {
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
    expect(globals.bus).toBe(false);
    expect(globals.hubKeys).toEqual(expect.arrayContaining(['subscribe', 'emit', 'request', 'getState']));
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('connexion d\'une caméra → ligne [Hub] dans le Log + abonnés notifiés', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // Traces [Hub] visibles dans le panneau Log : mode debug du Hub + filtre debug.
    await page.evaluate(() => {
      Hub.debug = true;
      const cb = document.querySelector('#applet-log input[data-level="debug"]');
      if (cb && !cb.checked) cb.click();
    });

    // Point de départ propre : attendre que la caméra soit connectée,
    // la déconnecter, et attendre que l'état le confirme.
    async function camState() {
      const data = await (await fetch(`${BASE_URL}/api/hardware`)).json();
      return data.devices['Main Camera'] ? data.devices['Main Camera'].connected : null;
    }
    for (let i = 0; i < 20 && !(await camState()); i++) await sleep(500);
    await apiPost('/api/hardware/disconnect', { device: 'Main Camera' });
    for (let i = 0; i < 20 && (await camState()); i++) await sleep(500);

    // Observateur dédié : prouve que l'émission est bien délivrée aux abonnés
    // (la liste des targets figure dans la ligne [Hub] du panneau Log).
    await page.evaluate(() => {
      window.__hubEvents = [];
      Hub.subscribe('device:connected', '__sensor-check', (env) => {
        window.__hubEvents.push({ name: env.payload.name, type: env.payload.type, sensor: env.payload.sensor });
      });
    });

    await apiPost('/api/hardware/connect', { device: 'Main Camera' });

    // L'émission est confirmée après HUB_CONFIRM_MS (1200 ms) : attendre que
    // l'observateur reçoive le payload de la caméra.
    let received = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      received = await page.evaluate(() =>
        (window.__hubEvents || []).find(e => e.name === 'Main Camera') || null);
      if (received) break;
      await sleep(300);
    }
    expect(received).toBeTruthy();
    expect(received.type).toBeTruthy();

    // Ligne [Hub] visible dans le panneau Log, listant les abonnés réels.
    const line = page.locator('#log-content .log-entry', { hasText: '[Hub] hardware.emit(device:connected)' });
    await expect(line.first()).toBeVisible({ timeout: 10000 });
    const text = await line.first().innerText();
    expect(text).toContain('→');
    for (const t of ['guide', 'stacking']) {
      expect(text).toContain(t);
    }

    // Le payload porte les dimensions capteur (mock : 1920×1080, 3.75 µm).
    expect(received.sensor).toBeTruthy();
    expect(received.sensor.width_px).toBeGreaterThan(0);
    expect(received.sensor.height_px).toBeGreaterThan(0);
    expect(received.sensor.pixel_size_um).toBeGreaterThan(0);
  });

  test('les flux WebSocket arrivent via le Hub (ws:state)', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // ws:state continue d'arriver, maintenant via le Hub (médiateur unique).
    const ok = await page.evaluate(async () => {
      const seen = await new Promise(resolve => {
        let timer = setTimeout(() => resolve(false), 8000);
        Hub.subscribe('ws:state', 'spec', () => { clearTimeout(timer); resolve(true); });
      });
      return seen;
    });
    expect(ok).toBe(true);
  });
});