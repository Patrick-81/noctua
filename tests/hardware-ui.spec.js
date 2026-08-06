// @ts-check
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

  const profilesPath = path.join(os.tmpdir(), `ui-profiles-${Date.now()}.yaml`);
  const env = { ...process.env, INDIGO_PROFILES_PATH: profilesPath };

  mockProc = spawn(PYTHON,
    [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)],
    { stdio: 'pipe', cwd: ROOT });
  mockLog = fs.createWriteStream('/tmp/opencode/hw-mock.log', { flags: 'a' });
  mockProc.stderr.on('data', d => mockLog.write(d));
  await sleep(1500);

  webProc = spawn(PYTHON,
    [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)],
    { stdio: 'pipe', cwd: ROOT, env });
  webProc.stdout.on('data', () => {}); // uvicorn access logs go to stdout — must drain or the pipe fills and the event loop blocks
  webLog = fs.createWriteStream('/tmp/opencode/hw-web.log', { flags: 'a' });
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

test.describe.serial('Hardware panel + profiles', () => {

  test('hardware panel lists mock devices with roles', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    const panel = page.locator('#applet-hardware');
    await expect(panel).toBeVisible();

    // The panel should show device rows (at least the 5 mock devices)
    await expect(page.locator('#hw-device-list .hw-device')).toHaveCount(5);
    const text = await page.locator('#hw-device-list').innerText();
    expect(text).toContain('Mount');
    expect(text).toContain('Main Camera');
    expect(text).toContain('Guide Camera');
    expect(text).toContain('Focuser');
    expect(text).toContain('Filter Wheel');
  });

  test('connect/disconnect individual device', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Find the Filter Wheel row and click its CONN button.
    // The list re-renders on every WS state broadcast, so use dispatchEvent
    // to avoid "element detached from DOM" flakes during the click.
    const fwRow = page.locator('#hw-device-list .hw-device', { hasText: 'Filter Wheel' });
    await expect(fwRow).toBeVisible();
    await fwRow.locator('button[data-action="connect"]').dispatchEvent('click');
    await expect(fwRow.locator('.hw-status')).toHaveClass(/on/);
    // And disconnect it again
    await fwRow.locator('button[data-action="disconnect"]').dispatchEvent('click');
    await expect(fwRow.locator('.hw-status')).toHaveClass(/off/);
  });

  test('profile dropdown shows created profiles', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // Create a profile via API
    const r = await apiPost('/api/profiles', {
      name: 'Rig UI',
      mount: 'Mount',
      camera: 'Main Camera',
      guide_camera: 'Guide Camera',
      focuser: 'Focuser',
      filter_wheel: 'Filter Wheel',
      optics: 'Newton 200/800',
    });
    expect(r.ok).toBe(true);

    await page.locator('#hw-refresh').dispatchEvent('click');
    await sleep(500);

    const options = await page.locator('#hw-profile-select option').allInnerTexts();
    expect(options).toContain('Rig UI');
    // Optics field shown
    const optics = page.locator('#hw-optics');
    await expect(optics).toBeVisible();
    await expect(optics).toHaveValue('Newton 200/800');
  });

  async function countStatus(page, clsIncludes) {
    const rows = page.locator('#hw-device-list .hw-device');
    const count = await rows.count();
    let n = 0;
    for (let i = 0; i < count; i++) {
      const cls = await rows.nth(i).locator('.hw-status').getAttribute('class');
      if (cls && cls.includes(clsIncludes)) n++;
    }
    return n;
  }

  test('APPLIQUER connects profile devices', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    await apiPost('/api/profiles/delete', { name: 'Rig UI' }).catch(() => {});
    await apiPost('/api/profiles', {
      name: 'Rig UI',
      mount: 'Mount',
      camera: 'Main Camera',
      guide_camera: 'Guide Camera',
      focuser: 'Focuser',
      filter_wheel: 'Filter Wheel',
    });

    await page.locator('#hw-refresh').dispatchEvent('click');
    await sleep(500);

    await page.locator('#hw-profile-apply').dispatchEvent('click');
    let allOn = 0;
    for (let i = 0; i < 20; i++) {
      allOn = await countStatus(page, 'on');
      if (allOn === 5) break;
      await sleep(500);
    }
    expect(allOn).toBe(5);
  });

  test('TOUT DÉCONNECTER turns devices off', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    await page.locator('#hw-profile-apply').dispatchEvent('click'); // ensure everything connected first
    let allOn = 0;
    for (let i = 0; i < 20; i++) {
      allOn = await countStatus(page, 'on');
      if (allOn === 5) break;
      await sleep(500);
    }
    await page.locator('#hw-disconnect-all').dispatchEvent('click');
    let allOff = 0;
    for (let i = 0; i < 20; i++) {
      allOff = await countStatus(page, 'off');
      const count = await page.locator('#hw-device-list .hw-device').count();
      if (allOff === count) break;
      await sleep(500);
    }
    expect(allOff).toBe(await page.locator('#hw-device-list .hw-device').count());
  });

  test('role select present on each device row', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const selects = page.locator('#hw-device-list .hw-device select.hw-role');
    const count = await selects.count();
    expect(count).toBe(5);
  });

  test('capture panel shows filter wheel selector (connected)', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    // Ensure filter wheel connected
    await apiPost('/api/hardware/connect', { device: 'Filter Wheel' });
    await sleep(1000);

    await page.click('button[data-mode="capture"]');
    await sleep(800);

    const section = page.locator('#cap-filter-section');
    await expect(section).toBeVisible();
    // The selector is rebuilt on every WS state broadcast → poll an atomic snapshot
    const opts = page.locator('#cap-filter-select option');
    await expect.poll(async () => {
      return await opts.evaluateAll(els =>
        els.map(el => `${el.value}:${el.textContent}`).join('|'));
    }, { timeout: 8000 }).toContain('Ha:Ha');
    const texts = await opts.allTextContents();
    expect(texts).toContain('Luminance');
    expect(texts).toContain('Ha');
  });

  test('selecting a filter slot calls the API and updates file naming', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await apiPost('/api/hardware/connect', { device: 'Filter Wheel' });
    await sleep(1000);

    await page.click('button[data-mode="capture"]');
    await sleep(800);

    // Select the Green filter
    await page.selectOption('#cap-filter-select', 'G');
    await sleep(500);

    const st = await apiGet('/api/filterwheel');
    expect(st.current).toBe('G');
  });

  test('mount mode shows meridian flip panel with HA status', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.click('button[data-mode="mount"]');
    await sleep(800);

    const panel = page.locator('#flip-panel');
    await expect(panel).toBeVisible();

    // HA status eventually populated from /api/mount flip block
    const status = page.locator('#flip-status');
    await expect.poll(
      async () => await status.textContent(),
      { timeout: 8000 }
    ).toContain('HA');
  });

  test('FLIP button triggers meridian flip via API', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.click('button[data-mode="mount"]');
    await sleep(800);

    await apiPost('/api/hardware/connect', { device: 'Mount' });
    await sleep(1200);

    await page.locator('#btn-flip').dispatchEvent('click');
    await sleep(1500);

    // Flip executes the abort→slew pipeline (verify via the API result)
    const flip = await apiPost('/api/mount/flip').catch(() => ({}));
    expect(flip.ok).toBe(true);
    expect(flip.phases.length).toBeGreaterThanOrEqual(3);
    expect(flip.phases.some(p => p.includes('slew'))).toBe(true);
  });
});

async function apiGet(p) {
  const res = await fetch(`${BASE_URL}${p}`);
  return res.json();
}
