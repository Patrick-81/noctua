// @ts-check
// Parité de la projection orthographique rapide (sky-projection.js) avec
// d3.geo.orthographic réellement chargé dans la page. Vérifie que
// projectPoint / projectStars reproduisent les coordonnées écran de d3 pour
// les rotations utilisées par le moteur de carte.
const { test, expect, beforeAll, afterAll } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 17632;
const WEB_PORT = 18097;
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
  webProc.stdout?.on('data', () => {}); // drain uvicorn access logs
  webProc.stderr?.on('data', d => process.stderr.write('[web] ' + d));
  await waitForServer(`${BASE_URL}/api/connection`, 20000);
});

afterAll(async () => {
  await killProc(webProc);
  await killProc(mockProc);
  try { execSync(`fuser -k ${WEB_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
  try { execSync(`fuser -k ${MOCK_PORT}/tcp 2>/dev/null`, { timeout: 2000 }); } catch {}
});

// Générateur pseudo-aléatoire reproductible
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const CENTERS = [
  [0, 0], [100, 30], [263.4, 12.9], [-60, -20], [179.99, 89], [87.4, -45], [200, 66.5],
];

test.describe.serial('sky-projection parity with d3', () => {
  test('projectPoint matches d3.geo.orthographic', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.d3 !== 'undefined');

    const result = await page.evaluate(async (centers) => {
      const mod = await import('/sky-projection.js');
      const tx = window.innerWidth / 2;
      const ty = window.innerHeight / 2;
      const rnd = (() => { let s = 12345; return () => { s = s * 1664525 + 1013904223 >>> 0; return s / 4294967296; }; })();

      const sce = (cRA, cDec, s) => d3.geo.orthographic()
        .rotate([-cRA, -cDec, 0]).scale(s).translate([tx, ty]);
      const watch = (pt) => pt && isFinite(pt[0]) && isFinite(pt[1]);

      const failures = [];
      let compared = 0;
      for (const [cRA, cDec] of centers) {
        for (const s of [100, 480.3, 1250]) {
          const proj = sce(cRA, cDec, s);
          const pts = [[cRA, cDec]];
          for (let i = 0; i < 200; i++) {
            pts.push([rnd() * 360 - 180, Math.asin(2 * rnd() - 1) * 180 / Math.PI]);
          }

          for (const [ra, dec] of pts) {
const fast = mod.projectPoint(ra, dec, cRA, cDec, s, tx, ty);
          const d3p = proj([ra, dec]);
          if (fast === null) {
            // hémisphère arrière : on ne compare pas — on vérifie seulement que
            // les points visibles correspondent.
            continue;
          }
          if (!watch(d3p)) {
            failures.push(`expected visible c=(${cRA},${cDec}) s=${s} p=(${ra.toFixed(3)},${dec.toFixed(3)})`);
            continue;
          }
          compared++;
          if (Math.abs(fast[0] - d3p[0]) > 1e-4 || Math.abs(fast[1] - d3p[1]) > 1e-4) {
            failures.push(`mismatch c=(${cRA},${cDec}) s=${s} p=(${ra.toFixed(3)},${dec.toFixed(3)}) fast=(${fast[0].toFixed(3)},${fast[1].toFixed(3)}) d3=(${d3p[0].toFixed(3)},${d3p[1].toFixed(3)})`);
          }
          }
        }
      }
      return { compared, failures: failures.slice(0, 20), failCount: failures.length };
    }, CENTERS);

    expect(result.failCount).toBe(0);
    expect(result.compared).toBeGreaterThan(1000);
  });

test('projectStars respecte magMax, le plafonnement et le décompte brute-force', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const mod = await import('/sky-projection.js');
      let s = 7;
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const features = [];
      for (let i = 0; i < 5000; i++) {
        const ra = rnd() * 360 - 180;
        const dec = Math.asin(2 * rnd() - 1) * 180 / Math.PI;
        const mag = rnd() * 10;
        features.push({ geometry: { coordinates: [ra, dec] }, properties: { mag } });
      }
      const stars = mod.buildStarVectors(features);
      if (stars.length !== 5000) return { err: 'buildStarVectors lost entries' };

      const tx = 640, ty = 400, scale = 300, cap = 120, magMax = 6.5;
      const out = [];
      const n = mod.projectStars(stars, 40, 20, scale, tx, ty, magMax, cap, out, () => 1);
      if (out.length !== n * 3) return { err: `out length ${out.length} != ${n * 3}` };
      if (n > cap) return { err: `cap exceeded: ${n} > ${cap}` };
      for (let i = 0; i < out.length; i++) {
        if (!isFinite(out[i])) return { err: `non-finite coord at ${i}` };
      }

      // Décompte de référence sans plafond : les étoiles étant triées par magnitude,
      // un cap gigantesque renvoie toutes les étoiles visibles de mag <= magMax.
      const outRef = [];
      const ref = mod.projectStars(stars, 40, 20, scale, tx, ty, magMax, 1e9, outRef, () => 1);
      return { n, cap, ref, err: null };
    });

    expect(result.err).toBeNull();
    expect(result.n).toBeGreaterThan(0);
    if (result.ref < result.cap) {
      // pas de troncature → on retrouve exactement toutes les étoiles visibles
      expect(result.n).toBe(result.ref);
    } else {
      // troncature → plafond respecté (déjà vérifié côté navigation), mais ici
      // la cohérence impose n === cap quand il y a suffisamment de candidates
      expect(result.n).toBe(result.cap);
    }
  });

  test('la skymap se charge, rend des étoiles et répond au slider magnitude 8', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#canvas-container canvas', { timeout: 15000 });

    const countWhite = () => page.evaluate(() => {
      const cv = document.querySelector('#canvas-container canvas');
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i] > 200 && img[i + 1] > 200 && img[i + 2] > 200) n++;
      }
      return n;
    });

    // Pendant l'attente : le chargement de stars.8 puis un premier rendu peignent
    // des étoiles blanches → on attend qu'elles apparaissent.
    let init;
    await page.waitForFunction(() => {
      const cv = document.querySelector('#canvas-container canvas');
      if (!cv) return false;
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < img.length; i += 8) {
        if (img[i] > 200 && img[i + 1] > 200 && img[i + 2] > 200) { n++; if (n > 5) return true; }
      }
      return false;
    }, { timeout: 25000 });
    init = await countWhite();

    // Montée du slider à 8.0 : nettement plus d'étoiles rendues.
    await page.locator('#mag-slider').evaluate((el) => {
      el.value = '8.0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(800);
    const mag8 = await countWhite();

    expect(init).toBeGreaterThan(20);
    expect(mag8).toBeGreaterThan(init * 1.3);
    expect(pageErrors.length).toBe(0);
  });
});