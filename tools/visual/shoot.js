// shoot.js — headless Chromium screenshots of every CRM workspace.
//
// Boots the harness (real API on pg-mem + static dashboard + Rosa seed),
// drives the workspace switch through window.crmWorkspaces, and writes one
// 1600x1000 PNG per surface plus one with an open card-detail panel.
//
// Usage:
//   node tools/visual/shoot.js [outDir]      # forward cycle (default tools/visual/shots)
//   node tools/visual/shoot.js --reverse     # also re-shoot the cycle in reverse
// Uses the local Chrome/Edge install (or PUPPETEER_EXECUTABLE_PATH).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { start } = require('./harness.js');

const WORKSPACES = ['home', 'today', 'tickets', 'people', 'pipeline', 'money', 'calendar', 'reports'];

function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found; set PUPPETEER_EXECUTABLE_PATH');
  return found;
}

async function waitForBoot(page) {
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute('data-dashboard-booting')
      && typeof window.crmWorkspaces === 'object',
    { timeout: 30000 },
  );
  // Let the change feed land the first full store broadcast + card renders.
  await page.waitForFunction(
    () => window.tickets && document.querySelectorAll('.tk-card, .tk-zone, .tk-deck').length >= 0,
    { timeout: 10000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}

async function shootWorkspace(page, key, outDir, prefix, index) {
  await page.evaluate((k) => window.crmWorkspaces.setActive(k), key);
  await new Promise((r) => setTimeout(r, 1200));
  const file = path.join(outDir, `${prefix}${String(index + 1).padStart(2, '0')}-${key}.png`);
  await page.screenshot({ path: file });
  console.log('[shoot]', path.relative(process.cwd(), file));
  return file;
}

async function shootDetail(page, outDir) {
  // Open the detail panel for the first visible ticket card on the Tickets surface.
  await page.evaluate(() => window.crmWorkspaces.setActive('tickets'));
  await new Promise((r) => setTimeout(r, 800));
  const opened = await page.evaluate(() => {
    const card = document.querySelector('.tk-zcard, .tk-card');
    if (!card) return false;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const file = path.join(outDir, '09-detail.png');
  await page.screenshot({ path: file });
  console.log('[shoot]', path.relative(process.cwd(), file), opened ? '' : '(no card found — panel not opened)');
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--reverse');
  const reverse = process.argv.includes('--reverse');
  const outDir = path.resolve(args[0] || path.join(__dirname, 'shots'));
  fs.mkdirSync(outDir, { recursive: true });

  const { staticUrl } = await start();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[page error]', err.message));
  await page.goto(staticUrl, { waitUntil: 'load' });
  await waitForBoot(page);

  for (let i = 0; i < WORKSPACES.length; i++) await shootWorkspace(page, WORKSPACES[i], outDir, '', i);
  if (reverse) {
    const back = [...WORKSPACES].reverse();
    for (let i = 0; i < back.length; i++) await shootWorkspace(page, back[i], outDir, 'r', i);
  }
  await shootDetail(page, outDir);

  await browser.close();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
