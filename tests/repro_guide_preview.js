const { chromium } = require('@playwright/test');
const BASE_URL = 'http://127.0.0.1:18091';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Connect guide camera + mount
  await page.evaluate(async () => {
    await fetch('/api/hardware/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'Guide Camera' }) });
    await fetch('/api/hardware/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'Mount' }) });
  });
  await page.waitForTimeout(1500);

  // Switch to guiding mode
  await page.click('button[data-mode="guiding"]');
  await page.waitForTimeout(800);

  // Select guide camera in the select
  await page.selectOption('#guide-camera-select', 'Guide Camera');
  await page.waitForTimeout(300);

  // Click capture
  await page.click('#guide-capture-btn');
  await page.waitForTimeout(3000);

  const panel = await page.locator('#applet-guide-preview').isVisible();
  const canvas = page.locator('#guide-preview-canvas');
  const canvasVisible = await canvas.isVisible();
  const cw = await canvas.evaluate(el => el.width);
  const ch = await canvas.evaluate(el => el.height);
  const cssW = await canvas.evaluate(el => el.style.width);
  // Check if canvas has any non-black pixels
  const nonBlack = await canvas.evaluate(el => {
    const ctx = el.getContext('2d');
    if (!el.width || !el.height) return null;
    const d = ctx.getImageData(0, 0, el.width, el.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 16) { if (d[i] > 20) bright++; }
    return { total: d.length / 16, bright };
  });
  const status = await page.locator('#guide-preview-status').textContent();
  const guidePreviewInfo = await page.locator('#applet-guide-preview').innerText();

  console.log('panel visible:', panel);
  console.log('canvas visible:', canvasVisible);
  console.log('canvas buffer:', cw + 'x' + ch, 'cssW:', cssW);
  console.log('nonBlack sample:', JSON.stringify(nonBlack));
  console.log('status:', status);
  console.log('--- guide preview panel text ---');
  console.log(guidePreviewInfo.slice(0, 500));

  const guideLogs = logs.filter(l => l.includes('WS image') || l.includes('handleGuideImage') || l.toLowerCase().includes('fits') || l.includes('error'));
  console.log('--- relevant console logs ---');
  guideLogs.forEach(l => console.log(l));

  await browser.close();
})();