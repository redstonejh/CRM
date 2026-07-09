// gravity-proof.js — BLUEPRINT A2 proof: bucket stacks SEAT at the bottom with
// title-peek anatomy at 1, 3, and 8 cards. Shoots Pipeline (Lead bucket grown
// via the real deals bridge), then Money and People at their seeded counts.
// Writes tools/visual/shots/gravity/*.png.
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

async function main() {
  const outDir = path.join(__dirname, 'shots', 'gravity');
  fs.rmSync(outDir, { recursive: true, force: true });
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

  const shoot = async (name) => {
    await sleep(900);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`[gravity] ${name}`);
  };
  const addLeads = async (n, offset) => page.evaluate(async (count, base) => {
    for (let i = 0; i < count; i++) {
      await window.deals.create({
        title: `Seeded lead ${base + i}`, client: `Gravity Co ${base + i}`,
        stage: 'lead', state: 'open', priority: 'warm', amount: 1000 + (base + i) * 100,
        description: 'A2 gravity proof card.',
      });
    }
  }, n, offset);

  await page.evaluate(() => window.crmWorkspaces.setActive('pipeline'));
  await shoot('pipeline-1-card');
  await addLeads(2, 1);
  await shoot('pipeline-3-cards');
  await addLeads(5, 3);
  await shoot('pipeline-8-cards');
  await page.evaluate(() => window.crmWorkspaces.setActive('money'));
  await shoot('money-seeded');
  await page.evaluate(() => window.crmWorkspaces.setActive('people'));
  await shoot('people-seeded');

  await browser.close();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
