// @ts-check
// session-ui.spec.js — Orchestrateur de session (meridian flip frontend).
// Couvre : panneau visible en mode capture/guiding, séquence complète du
// flip manuel (pause séquence → flip → attente slew → reprise) avec une
// séquence en cours d'exécution.
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17636;
const WEB_PORT = 18096;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
let mockProc, webProc, webLog;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ui-'));
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
telescope:
  flip_enabled: true
  hour_angle_margin: 0.0
  min_altitude: 5.0
  flip_slew_rate: Centering
  recenter_after_flip: false
sequence:
  save_dir: ${SAVE_DIR}
  dither:
    enabled: false
    amount: 0.0
  stack:
    enabled: false
    max_frames: 0
  frames:
    - duration: 2.0
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
  webLog = fs.createWriteStream('/tmp/opencode/session-ui-web.log', { flags: 'a' });
  webProc.stderr.on('data', d => webLog.write(d));
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

test.describe.serial('Session meridian-flip (panneau SESSION)', () => {

  test('panel renders in capture and guiding modes with working toggles', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.click('button[data-mode="capture"]');
    await sleep(800);
    await expect(page.locator('#applet-session')).toBeVisible();

    // Activer la session → surveillance du méridien (log + statut)
    await page.evaluate(() => {
      const el = document.getElementById('session-active');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#log-content')).toContainText('Session active — surveillance du méridien', { timeout: 10000 });
    await expect(page.locator('#session-status')).toContainText('Surveillance du méridien');

    // Désactiver → pause
    await page.evaluate(() => {
      const el = document.getElementById('session-active');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#log-content')).toContainText('Session en pause', { timeout: 10000 });

    // Le panneau existe aussi en mode guiding
    await page.click('button[data-mode="guiding"]');
    await sleep(800);
    await expect(page.locator('#applet-session')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('manual flip pauses a running sequence, flips, then resumes it', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.click('button[data-mode="capture"]');
    await sleep(800);

    // Séquence longue : 4 × 3 s → la pause pendant le flip doit la suspendre
    await page.evaluate((saveDir) => {
      const set = (selector, v) => {
        const el = document.querySelector(selector);
        if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      set('#seq-frame-list .seq-frame-row input[data-field="duration"]', '3');
      set('#seq-frame-list .seq-frame-row input[data-field="count"]', '4');
      document.getElementById('seq-save-dir').value = saveDir;
    }, SAVE_DIR);

    await page.evaluate(() => document.getElementById('seq-start').click());
    await expect(page.locator('#seq-stop')).toBeEnabled({ timeout: 15000 });

    // Lancer le flip manuel
    await page.evaluate(() => document.getElementById('session-flip-btn').click());

    // La séquence est mise en pause par l'orchestrateur (transcript du panneau)
    await expect(page.locator('#log-content')).toContainText('Flip manuel demandé', { timeout: 15000 });
    await expect(page.locator('#session-phases')).toContainText('Séquence mise en pause', { timeout: 15000 });

    // Le flip se déroule jusqu'au bout (statut final + log)
    await expect(page.locator('#session-status')).toContainText('✓ Flip terminé', { timeout: 60000 });
    await expect(page.locator('#log-content')).toContainText('Session flip terminée', { timeout: 15000 });

    // La séquence a été reprise et va jusqu'à son terme
    await expect(page.locator('#seq-current')).toContainText('Séquence terminée', { timeout: 60000 });

    // La monture n'est plus en mouvement après le flip
    await expect.poll(async () => (await apiGet('/api/mount')).slewing, { timeout: 15000 }).toBe(false);

    expect(errors).toEqual([]);
  });
});
