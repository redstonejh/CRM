// Drives the actual Electron process. This is intentionally separate from the
// browser shim: screenshots and transition frames come from BrowserWindow.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const out = path.join(__dirname, 'electron-actual');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const { apiUrl } = await start();
  const app = await electron.launch({
    args: ['.'],
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, CRM_API_URL: apiUrl, CRM_API_PORT: '3899' },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('load');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout: 30000 });
  await page.evaluate(() => window.crmWorkspaces.setActive('home'));
  await page.waitForFunction(() => document.querySelectorAll('.crm-home-bucket').length === 6, null, { timeout: 15000 });
  await sleep(1200);
  await page.screenshot({ path: path.join(out, '01-home-settled.png') });
  const homePreviews = await page.evaluate(() => [...document.querySelectorAll('.crm-home-bucket')].map((bucket) => {
    const preview = bucket.querySelector('.crm-home-preview');
    const child = preview?.firstElementChild;
    const title = bucket.querySelector('.crm-home-title-glass');
    const rect = (node) => node ? Object.fromEntries(['x','y','width','height','left','top','right','bottom'].map((key) => [key, +node.getBoundingClientRect()[key].toFixed(2)])) : null;
    const style = child ? getComputedStyle(child) : null;
    const bucketRect = bucket.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    const titleStyle = title ? getComputedStyle(title) : null;
    return {
      module: bucket.dataset.module, preview: rect(preview), child: rect(child), childClass: child?.className || '', position: style?.position, transform: style?.transform,
      titleCenterDelta: titleRect ? {
        x: +((titleRect.left + titleRect.width / 2) - (bucketRect.left + bucketRect.width / 2)).toFixed(3),
        y: +((titleRect.top + titleRect.height / 2) - (bucketRect.top + bucketRect.height / 2)).toFixed(3),
      } : null,
      titleChrome: titleStyle ? { backgroundImage: titleStyle.backgroundImage, boxShadow: titleStyle.boxShadow, borderRadius: titleStyle.borderRadius, padding: titleStyle.padding } : null,
    };
  }));
  if (homePreviews.some((item) => Math.abs(item.titleCenterDelta?.x || 0) > .51 || Math.abs(item.titleCenterDelta?.y || 0) > .51)) {
    throw new Error('A Home title is not centered to the rendered half-pixel');
  }
  if (homePreviews.some((item) => item.titleChrome?.backgroundImage !== 'none' || item.titleChrome?.boxShadow !== 'none' || item.titleChrome?.borderRadius !== '0px')) {
    throw new Error('A Home title still has pill/container chrome');
  }
  const visibleEmptyCopy = await page.evaluate(() => [...document.querySelectorAll('.crm-home-lod-scene :is(.crm-home-empty,.crm-desk-empty,.crm-people-empty,.tk-zone-empty,.tk-empty,.tk-desk-clear)')]
    .filter((node) => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; })
    .map((node) => node.textContent.trim()).filter(Boolean));
  if (visibleEmptyCopy.length) throw new Error(`Home still renders empty-state copy: ${visibleEmptyCopy.join(' | ')}`);
  const box = await page.locator('.crm-home-bucket[data-module="desk"]').boundingBox();
  const transition = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const delays = [0, 70, 140, 230, 360, 520, 700];
    await win.webContents.executeJavaScript(`(() => {
      window.__crmHomeAlignment = null;
      clearInterval(window.__crmHomeAlignmentTimer);
      window.__crmHomeAlignmentTimer = setInterval(() => {
        const selectors = ['.crm-desk-frame','.crm-desk-head','.crm-desk-grid','.crm-desk-panel'];
        const veil = document.querySelector('.crm-transit-veil');
        const live = document.querySelector('[data-crm-theater="desk"]');
        if (!veil || !live || live.hidden) return;
        const deltas = [];
        selectors.forEach((selector) => {
          const a = [...veil.querySelectorAll(selector)], b = [...live.querySelectorAll(selector)];
          a.forEach((node, index) => {
            if (!b[index]) return;
            const x = node.getBoundingClientRect(), y = b[index].getBoundingClientRect();
            deltas.push({ selector, index, values: [x.left-y.left,x.top-y.top,x.right-y.right,x.bottom-y.bottom].map((value) => +value.toFixed(3)) });
          });
        });
        if (!deltas.length) return;
        window.__crmHomeAlignment = { worst: Math.max(...deltas.flatMap((item) => item.values).map(Math.abs)), deltas };
        clearInterval(window.__crmHomeAlignmentTimer);
      }, 8);
      return true;
    })()`);
    await win.webContents.executeJavaScript('document.querySelector(\'.crm-home-bucket[data-module="desk"]\')?.click()');
    const frames = [];
    let previous = 0;
    for (const delay of delays) {
      if (delay > previous) await new Promise((resolve) => setTimeout(resolve, delay - previous));
      frames.push({ delay, png: (await win.capturePage()).toPNG().toString('base64') });
      previous = delay;
    }
    const alignment = await win.webContents.executeJavaScript('window.__crmHomeAlignment');
    return { frames, alignment };
  });
  transition.frames.forEach(({ delay, png }, index) => fs.writeFileSync(path.join(out, `${String(index + 2).padStart(2, '0')}-transition-${String(delay).padStart(3, '0')}.png`), Buffer.from(png, 'base64')));
  if (transition.alignment?.worst == null || transition.alignment.worst > .51) throw new Error(`Home transition lands ${transition.alignment?.worst ?? 'without measurable'}px away from the live layout`);
  await page.screenshot({ path: path.join(out, '09-desk-settled.png') });
  await page.evaluate(() => window.crmWorkspaces.setActive('pipeline'));
  await sleep(800);
  await page.screenshot({ path: path.join(out, '10-pipeline-settled.png') });
  const card = page.locator('[data-crm-theater="pipeline"] .tk-card, [data-crm-theater="pipeline"] .tk-zcard').first();
  if (await card.count()) {
    await card.dispatchEvent('dblclick');
    await sleep(700);
    await page.screenshot({ path: path.join(out, '11-record-settled.png') });
  }
  const evidence = {
    window: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, module: document.body.dataset.crmModule })),
    homeDeskBox: box,
    homePreviews,
    visibleEmptyCopy,
    transitionAlignment: transition.alignment,
    errors,
  };
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('[electron-playwright]', evidence);
  await app.close();
  process.exit(0);
}
main().catch((error) => { console.error(error); process.exit(1); });
