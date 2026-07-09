// motion-check.js — frame-sequence proof of the three vision choreographies
// (FIX_PASS_2 F6): the Today hand DEALS on first entry, a card click plays the
// detail FLYOUT, and a stage-complete deal dropped on the Won pile plays the
// pile FLIGHT + single pulse. Writes tools/visual/shots/motion/*.png.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { start } = require('./harness.js');

function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found; set PUPPETEER_EXECUTABLE_PATH');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function frames(page, outDir, name, count, stepMs) {
  for (let i = 1; i <= count; i++) {
    await sleep(stepMs);
    await page.screenshot({ path: path.join(outDir, `${name}-${i}.png`) });
  }
  console.log(`[motion] ${name}: ${count} frames`);
}

async function main() {
  const outDir = path.join(__dirname, 'shots', 'motion');
  fs.mkdirSync(outDir, { recursive: true });
  const { staticUrl } = await start();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await sleep(2500);

  // 1 — the morning deal: land on Today for the first time; the hand fans out.
  const dealPromise = page.evaluate(() => window.crmWorkspaces.setActive('today'));
  await frames(page, outDir, 'deal', 4, 140);
  await dealPromise;
  await sleep(1200);

  // 2 — the detail flyout: click the deal card in the hand (an entity with a
  // detail config — calendar rows have none and would no-op).
  const cardBox = await page.evaluate(() => {
    const card = document.querySelector('[data-crm-theater="today"] .tk-card[data-id="deals:dl_harborlane_retainer"]')
      || document.querySelector('[data-crm-theater="today"] .tk-card[data-id^="invoices:"]')
      || document.querySelector('[data-crm-theater="today"] .tk-card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (cardBox) {
    await page.mouse.click(cardBox.x, cardBox.y);
    await frames(page, outDir, 'flyout', 4, 120);
    await page.keyboard.press('Escape');
    await sleep(800);
  } else {
    console.error('[motion] flyout: no Today card found');
  }

  // 3 — the Won drop: drag the stage-complete Proposal deal onto the Won pile.
  await page.evaluate(() => window.crmWorkspaces.setActive('pipeline'));
  await sleep(1500);
  const dragFrom = await page.evaluate(() => {
    const card = document.querySelector('[data-crm-theater="pipeline"] .tk-zcard[data-id="dl_harborlane_retainer"]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const dragTo = await page.evaluate(() => {
    const pile = document.querySelector('[data-crm-theater="pipeline"] .tk-deck-right .tk-card');
    if (!pile) return null;
    const r = pile.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (dragFrom && dragTo) {
    await page.mouse.move(dragFrom.x, dragFrom.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        dragFrom.x + (dragTo.x - dragFrom.x) * (i / 10),
        dragFrom.y + (dragTo.y - dragFrom.y) * (i / 10),
      );
      await sleep(30);
    }
    await page.mouse.up();
    await frames(page, outDir, 'won', 5, 160);
  } else {
    console.error('[motion] won: drag endpoints not found', { dragFrom, dragTo });
  }

  await browser.close();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
