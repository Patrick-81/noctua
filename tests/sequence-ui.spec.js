// @ts-check
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17634;
const WEB_PORT = 18094;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
let mockProc, webProc, webLog;
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-ui-'));

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
  webLog = fs.createWriteStream('/tmp/opencode/seq-ui-web.log', { flags: 'a' });
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
  try { fs.rmSync(SAVE_DIR, { recursive: true, force: true }); } catch {}
});

test.describe.serial('Séquence panel (capture mode)', () => {

  test('panel renders defaults and supports adding poses', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.click('button[data-mode="capture"]');
    await sleep(1000);

    await expect(page.locator('#applet-sequence')).toBeVisible();
    // Default frame(s) come from config.yaml
    const rows = page.locator('#seq-frame-list .seq-frame-row');
    await expect(rows.first()).toBeVisible();
    const rowCount0 = await rows.count();
    expect(rowCount0).toBeGreaterThan(0);

    // Adding a pose appends a row
    await page.evaluate(() => document.getElementById('seq-add-row').click());
    await expect(rows).toHaveCount(rowCount0 + 1);

    // Control buttons present; start is enabled, stop disabled when idle
    await expect(page.locator('#seq-start')).toBeEnabled();
    await expect(page.locator('#seq-stop')).toBeDisabled();
  });

  test('runs a 2-pose sequence to completion with progress + save', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.click('button[data-mode="capture"]');
    await sleep(600);

    // Configure the single default pose: 2 × 0.2 s, save into a temp dir
    await page.evaluate((saveDir) => {
      const set = (selector, v) => {
        const el = document.querySelector(selector);
        if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      set('#seq-frame-list .seq-frame-row input[data-field="duration"]', '0.2');
      set('#seq-frame-list .seq-frame-row input[data-field="count"]', '2');
      set('#seq-frame-list .seq-frame-row input[data-field="delay"]', '0.1');
      document.getElementById('seq-save-dir').value = saveDir;
    }, SAVE_DIR);

    // Console errors are a failure
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.evaluate(() => document.getElementById('seq-start').click());

    // Buttons flip while running
    await expect(page.locator('#seq-start')).toBeDisabled();
    await expect(page.locator('#seq-stop')).toBeEnabled();

    // Progress advances to completion
    await expect(page.locator('#seq-progress-text')).toHaveText('2 / 2', { timeout: 90000 });
    await expect(page.locator('#seq-current')).toContainText('Séquence terminée');

    // A FITS file path is displayed
    await expect(page.locator('#seq-last-saved')).toBeVisible();
    const saved = await page.locator('#seq-last-saved').textContent();
    expect(saved).toContain('.fits');

    // Log records the run
    await expect(page.locator('#log-content')).toContainText('Séquence terminée', { timeout: 15000 });

    expect(errors).toEqual([]);
  });

  test('stop interrupts a long run', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.click('button[data-mode="capture"]');
    await sleep(600);

    await page.evaluate((saveDir) => {
      const set = (selector, v) => {
        const el = document.querySelector(selector);
        if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      set('#seq-frame-list .seq-frame-row input[data-field="duration"]', '2');
      set('#seq-frame-list .seq-frame-row input[data-field="count"]', '20');
      document.getElementById('seq-save-dir').value = saveDir;
    }, SAVE_DIR);

    await page.evaluate(() => document.getElementById('seq-start').click());
    await expect(page.locator('#seq-stop')).toBeEnabled();
    await sleep(2000);
    await page.evaluate(() => document.getElementById('seq-stop').click());

    // Runner eventually reports idle with a total of 0 after reset, or running stops
    await expect(page.locator('#seq-start')).toBeEnabled({ timeout: 30000 });
    const st = await page.evaluate(async () => await (await fetch('/api/sequence/status')).json());
    expect(st.running).toBe(false);
    expect(st.done).toBeLessThan(50);
  });

});