// scenes.js — the blueprint's scene recorder (THE_DESK_BLUEPRINT A7).
// Drives the assembled desk through Scenes I–VIII on the pg-mem harness and
// archives each as a committed frame sequence under tools/visual/scenes/.
// Built on the motion-check.js primitives; scenes are declarative steps so a
// failed selector aborts THAT scene loudly instead of producing silent frames.
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

// ── step primitives ───────────────────────────────────────────────────────────
// Each runs with a ctx of { page, shoot(label, count, stepMs) }. Steps that
// start motion do NOT await its completion — the following frames() step is
// the recording of that motion.

const rectOf = async (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}, selector);

const steps = {
  // Ride the desk transit (fire and record — never await the dive).
  driveTo: (key) => async ({ page }) => {
    await page.evaluate((k) => { window.crmDeskTransit.driveTo(k); }, key);
  },
  // Await quiet: transit idle (used between chained checks).
  settle: (ms = 700) => async () => { await sleep(ms); },
  click: (selector) => async ({ page }) => {
    const at = await rectOf(page, selector);
    if (!at) throw new Error(`click: no element for ${selector}`);
    await page.mouse.click(at.x, at.y);
  },
  key: (k) => async ({ page }) => { await page.keyboard.press(k); },
  drag: (fromSelector, toSelector) => async ({ page }) => {
    const from = await rectOf(page, fromSelector);
    const to = await rectOf(page, toSelector);
    if (!from || !to) throw new Error(`drag: endpoints missing ${fromSelector} -> ${toSelector}`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * (i / 10), from.y + (to.y - from.y) * (i / 10));
      await sleep(30);
    }
    await page.mouse.up();
  },
  frames: (label, count, stepMs) => async ({ shoot }) => { await shoot(label, count, stepMs); },
  evaluate: (fn, ...args) => async ({ page }) => { await page.evaluate(fn, ...args); },
  assert: (fn, message) => async ({ page }) => {
    const ok = await page.evaluate(fn);
    if (!ok) throw new Error(`assert failed: ${message}`);
  },
};

// ── the scenes ────────────────────────────────────────────────────────────────
// Grown step-by-step with the assembly (A1 seeds Scene I's navigation spine;
// later steps add Scenes II–VIII).

const SCENES = [
  {
    name: 'scene-1-camera-spine',
    // Blueprint A1 proof: Home→Pipeline→B→Home→Calendar→month→day→B→B→B —
    // every move a camera dive, the B chain unbroken, no cut anywhere.
    steps: [
      steps.frames('home-rest', 1, 200),
      steps.click('.crm-module-switch button[data-crm-module="pipeline"]'),
      steps.frames('dive-pipeline', 6, 150),
      steps.settle(500),
      steps.assert(() => document.body.dataset.crmModule === 'pipeline', 'landed on pipeline'),
      steps.key('b'),
      steps.frames('back-home', 6, 150),
      steps.settle(500),
      steps.assert(() => document.body.dataset.crmModule === 'home', 'B backed out to home'),
      steps.click('.crm-module-switch button[data-crm-module="calendar"]'),
      steps.frames('dive-calendar', 6, 150),
      steps.settle(500),
      steps.assert(() => document.body.dataset.crmModule === 'calendar', 'landed on calendar'),
      steps.click('[data-crm-theater="calendar"] .fc-month'),
      steps.frames('dive-month', 5, 130),
      steps.settle(400),
      steps.click('[data-crm-theater="calendar"] .fc-expander[data-kind="month"] .fc-day[data-date$="-15"]'),
      steps.frames('dive-day', 5, 130),
      steps.settle(400),
      steps.assert(() => window.fractalCalendarCamera.level() === 2, 'camera at day level'),
      steps.key('b'),
      steps.frames('b-to-month', 5, 130),
      steps.settle(400),
      steps.key('b'),
      steps.frames('b-to-year', 5, 130),
      steps.settle(400),
      steps.assert(() => window.fractalCalendarCamera.level() === 0, 'camera back at year'),
      steps.key('b'),
      steps.frames('b-to-home', 6, 150),
      steps.settle(500),
      steps.assert(() => document.body.dataset.crmModule === 'home', 'B chained calendar→home'),
    ],
  },
  {
    name: 'scene-2-dealt-hand',
    // Blueprint A3 proof: first entry deals the hand into an arc (65ms
    // stagger); dragging a card out re-closes the gap; acting on a card via
    // the next-touch chips flies it off; an emptied hand says "Desk clear."
    steps: [
      steps.evaluate(() => localStorage.removeItem('crm-today-last-dealt')),
      steps.driveTo('today'),
      steps.settle(700),               // ride the dive; the deal starts on landing
      steps.frames('deal', 10, 130),
      steps.settle(600),
      steps.assert(() => document.querySelectorAll('[data-crm-theater="today"] .tk-card').length >= 4, 'hand dealt'),
      // Drag a middle card up out of the hand and hold — the arc re-spaces
      // beneath it — then release away from any target so it returns.
      async ({ page, shoot }) => {
        const at = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('[data-crm-theater="today"] .tk-card')];
          const card = cards[Math.floor(cards.length / 2)];
          const r = card.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) { await page.mouse.move(at.x, at.y - i * 30); await sleep(25); }
        await shoot('gap-reclose', 4, 140);
        await page.mouse.up();
        await shoot('gap-reopen', 3, 140);
      },
      steps.settle(500),
      // Open the cold-front card (no future touch), close → the chip row
      // blooms; +2d schedules the touch, the interaction re-warms the card,
      // and it departs the hand (its cold-front reason is gone).
      steps.click('[data-crm-theater="today"] .tk-card[data-id="contacts:ct_devon"]'),
      steps.frames('open', 3, 160),
      steps.settle(500),
      steps.key('Escape'),
      steps.settle(450),
      steps.frames('chip-bloom', 2, 150),
      steps.assert(() => !!document.querySelector('.td-next-touch [data-next-touch-days="2"]'), 'chip row bloomed'),
      steps.click('.td-next-touch [data-next-touch-days="2"]'),
      steps.frames('depart', 5, 150),
      steps.settle(800),
      steps.assert(() => !document.querySelector('[data-crm-theater="today"] .tk-card[data-id="contacts:ct_devon"]'), 'card departed the hand'),
      // Empty the whole hand through the real bridges → "Desk clear."
      steps.evaluate(async () => {
        const far = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        const now = new Date().toISOString();
        const each = async (bridge, patch) => {
          const payload = await bridge.list({ includeDeleted: false });
          for (const r of (payload.records || [])) { try { await bridge.update(r.id, typeof patch === 'function' ? patch(r) : patch); } catch {} }
        };
        await each(window.tasks, { scheduledDate: far, dueDate: far });
        await each(window.deals, { nextTouchAt: far, lastTouchAt: now });
        await each(window.contacts, { nextTouchAt: far, lastTouchAt: now });
        await each(window.invoices, (r) => (String(r.state).toLowerCase() === 'paid' ? { lastTouchAt: now } : { dueDate: far, state: 'draft', stage: 'draft', priority: 'draft', lastTouchAt: now }));
        const items = (await window.crmStore.list('calendarItems')).records || [];
        for (const it of items) { try { await window.crmStore.update('calendarItems', it.id, { date: far, scheduledDate: far }); } catch {} }
        await window.crmToday.reload();
      }),
      steps.settle(1200),
      steps.frames('desk-clear', 3, 200),
      steps.assert(() => !!document.querySelector('.tk-desk-clear'), 'Desk clear shown'),
    ],
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

async function runScene(page, scene, baseDir) {
  const outDir = path.join(baseDir, scene.name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let frameSeq = 0;
  const shoot = async (label, count, stepMs) => {
    for (let i = 1; i <= count; i++) {
      await sleep(stepMs);
      frameSeq += 1;
      await page.screenshot({ path: path.join(outDir, `${String(frameSeq).padStart(3, '0')}-${label}-${i}.png`) });
    }
  };
  // Every scene starts from a settled Home with a fresh module memory.
  await page.evaluate(() => {
    localStorage.removeItem('crm-today-last-dealt');
    window.crmDeskTransit.driveTo('home');
  });
  await sleep(1400);
  for (const step of scene.steps) await step({ page, shoot });
  console.log(`[scenes] ${scene.name}: ok (${frameSeq} frames)`);
}

async function main() {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const baseDir = path.join(__dirname, 'scenes');
  fs.mkdirSync(baseDir, { recursive: true });
  const { staticUrl } = await start();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[scenes] pageerror:', err.message));
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await sleep(2500);

  let failed = 0;
  for (const scene of SCENES) {
    if (only.length && !only.some((name) => scene.name.includes(name))) continue;
    try {
      await runScene(page, scene, baseDir);
    } catch (err) {
      failed += 1;
      console.error(`[scenes] ${scene.name}: FAILED — ${err.message}`);
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
