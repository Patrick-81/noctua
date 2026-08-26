// @ts-check
// Screenshot rapide du sky-map pour inspection visuelle.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = '/home/pat/Programmes/indigo_devices';
const MOCK_PORT = 17655;
const WEB_PORT = 18155;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = path.join(ROOT, 'venv', 'bin', 'python');

function waitForServer(url, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => { res.resume(); resolve(true); })
        .on('error', () => {
          if (Date.now() - start > timeout) return reject(new Error('timeout ' + url));
          setTimeout(check, 500);
        });
    };
    check();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { execSync } = require('child_process');
  for (const p of [MOCK_PORT, WEB_PORT]) {
    try { execSync(`fuser -k ${p}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  }
  await sleep(400);

  const mock = spawn(PYTHON, [path.join(ROOT, 'tests', 'mock_indigo.py'), '--port', String(MOCK_PORT)], { stdio: 'pipe', cwd: ROOT });
  mock.stderr.on('data', d => process.stderr.write('[mock] ' + d));
  await sleep(1500);
  const web = spawn(PYTHON, [path.join(ROOT, 'run.py'), `127.0.0.1:${MOCK_PORT}`, '--port', String(WEB_PORT)], { stdio: 'pipe', cwd: ROOT });
  web.stdout.on('data', () => {});
  web.stderr.on('data', d => process.stderr.write('[web] ' + d));
  await waitForServer(`${BASE_URL}/api/connection`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => console.error('PAGE ERROR:', String(e)));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const cv = document.querySelector('#canvas-container canvas');
    if (!cv) return false;
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 8) {
      if (img[i] > 200 && img[i+1] > 200 && img[i+2] > 200) { n++; if (n > 5) return true; }
    }
    return false;
  }, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/sky_before.png' });
  console.log('screenshot -> /tmp/sky_before.png');

  // Info de diagnostic : rotation courante, parallactique, position zénith
  const diag = await page.evaluate(() => {
    const e = window.skyEngine;
    if (!e) return { err: 'no skyEngine' };
    return {
      rotation: e._currentRotation,
      parallacticDeg: e._parallacticAngleDeg,
      siteLat: e.siteLat, siteLng: e.siteLng,
      lst: e._lstDegrees(new Date(), e.siteLng),
      zenithRA: null,
    };
  });
  console.log('DIAG:', JSON.stringify(diag, null, 2));

  await browser.close();
  web.kill('SIGTERM'); mock.kill('SIGTERM');
  await sleep(500);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
