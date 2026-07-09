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
    name: 'scene-3-gravity-and-won',
    // Blueprint A2/Scene III proof: stacks seat at the bucket floor; a deal is
    // lift-carried between buckets; a stage-complete deal dropped on Won plays
    // the flight + single pulse.
    steps: [
      steps.driveTo('pipeline'),
      steps.settle(900),
      steps.frames('seated', 2, 200),
      steps.assert(() => {
        const card = document.querySelector('[data-crm-theater="pipeline"] .tk-zcard[data-id="dl_bluepeak_onboarding"]');
        const zone = card?.closest('.tk-zone');
        if (!card || !zone) return false;
        return Math.abs(zone.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom) < 48;
      }, 'the Lead card rests on the bucket floor'),
      // Lift-carry-drop Bluepeak from Lead into Qualified.
      async ({ page, shoot }) => {
        const drag = await page.evaluate(() => {
          const card = document.querySelector('[data-crm-theater="pipeline"] .tk-zcard[data-id="dl_bluepeak_onboarding"]');
          const zones = [...document.querySelectorAll('[data-crm-theater="pipeline"] .tk-zone')];
          const dest = zones[1];
          if (!card || !dest) return null;
          const a = card.getBoundingClientRect(); const b = dest.getBoundingClientRect();
          return { fx: a.left + a.width / 2, fy: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 };
        });
        if (!drag) throw new Error('bucket drag endpoints missing');
        await page.mouse.move(drag.fx, drag.fy);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) {
          await page.mouse.move(drag.fx + (drag.tx - drag.fx) * (i / 8), drag.fy + (drag.ty - drag.fy) * (i / 8));
          await sleep(30);
        }
        await shoot('lift-carry', 2, 120);
        await page.mouse.up();
        await shoot('drop-settle', 3, 140);
      },
      steps.settle(600),
      steps.assert(() => window.dealPipeline.stageOf('dl_bluepeak_onboarding') === 'qualified', 'the deal moved buckets'),
      // The Won ritual: the stage-complete Proposal deal onto the Won pile.
      async ({ page, shoot }) => {
        const drag = await page.evaluate(() => {
          const card = document.querySelector('[data-crm-theater="pipeline"] .tk-zcard[data-id="dl_harborlane_retainer"]');
          const pile = document.querySelector('[data-crm-theater="pipeline"] .tk-deck-right .tk-card');
          if (!card || !pile) return null;
          const a = card.getBoundingClientRect(); const b = pile.getBoundingClientRect();
          return { fx: a.left + a.width / 2, fy: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 };
        });
        if (!drag) throw new Error('won drag endpoints missing');
        await page.mouse.move(drag.fx, drag.fy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
          await page.mouse.move(drag.fx + (drag.tx - drag.fx) * (i / 10), drag.fy + (drag.ty - drag.fy) * (i / 10));
          await sleep(30);
        }
        await page.mouse.up();
        await shoot('won-pulse', 6, 140);
      },
      steps.settle(600),
      steps.assert(async () => {
        const payload = await window.deals.list({ includeDeleted: false });
        return (payload.records || []).some((deal) => deal.id === 'dl_harborlane_retainer' && String(deal.state).toLowerCase() === 'won');
      }, 'the deal resolved into the Won pile'),
    ],
  },
  {
    name: 'scene-8-reports',
    // Blueprint Scene VIII: the ledger drawer — dive in from anywhere like any
    // bucket; inside, the widget grid does the arithmetic.
    steps: [
      steps.driveTo('reports'),
      steps.settle(1000),
      steps.frames('reports', 3, 200),
      steps.assert(() => document.querySelectorAll('.crm-report-widget:not([hidden])').length >= 5, 'the report widgets are on the grid'),
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
  {
    name: 'scene-4-the-flip',
    // Blueprint A5 proof: a won deal dragged from Pipeline's Won pile onto the
    // Money pill glides to Money, turns over mid-flight, and lands in Draft as
    // an invoice pre-filled from the deal.
    steps: [
      steps.driveTo('pipeline'),
      steps.settle(900),
      steps.frames('pipeline', 1, 200),
      async ({ page, shoot }) => {
        const drag = await page.evaluate(() => {
          // The pile's TOP card (highest z) is what a real grab picks up.
          const cards = [...document.querySelectorAll('[data-crm-theater="pipeline"] .tk-deck-right .tk-card')];
          if (!cards.length) return null;
          const card = cards.reduce((a, b) => (Number(getComputedStyle(b).zIndex || 0) > Number(getComputedStyle(a).zIndex || 0) ? b : a));
          window.__FLIP_DEAL__ = card.dataset.id;
          const pill = document.querySelector('.crm-module-switch button[data-crm-module="money"]');
          if (!pill) return null;
          const a = card.getBoundingClientRect(); const b = pill.getBoundingClientRect();
          return { fx: a.left + a.width / 2, fy: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 };
        });
        if (!drag) throw new Error('flip drag endpoints missing');
        await page.mouse.move(drag.fx, drag.fy);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) {
          await page.mouse.move(drag.fx + (drag.tx - drag.fx) * (i / 12), drag.fy + (drag.ty - drag.fy) * (i / 12));
          await sleep(30);
        }
        await shoot('pill-lit', 1, 120);
        await page.mouse.up();
        await shoot('flip-flight', 10, 140);
      },
      steps.settle(900),
      steps.assert(() => document.body.dataset.crmModule === 'money', 'the desk glided to Money'),
      steps.assert(async () => {
        const payload = await window.invoices.list({ includeDeleted: false });
        return (payload.records || []).some((inv) => inv.dealId === window.__FLIP_DEAL__ && String(inv.state).toLowerCase() === 'draft');
      }, 'a Draft invoice pre-filled from the won deal exists'),
      steps.frames('landed', 2, 200),
      // Open the landed invoice — the detail shows the pre-filled face.
      async ({ page }) => {
        const at = await page.evaluate(async () => {
          const payload = await window.invoices.list({ includeDeleted: false });
          const inv = (payload.records || []).find((r) => r.dealId === window.__FLIP_DEAL__);
          const card = inv && document.querySelector(`[data-crm-theater="money"] .tk-zcard[data-id="${inv.id}"]`);
          if (!card) return null;
          const r = card.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (at) await page.mouse.click(at.x, at.y);
      },
      steps.frames('invoice-open', 4, 160),
      steps.key('Escape'),
      steps.settle(500),
      steps.evaluate(() => { document.querySelector('.td-next-touch [data-next-touch-let-go]')?.click(); }),
      steps.settle(600),
    ],
  },
  {
    name: 'scene-5-cold-front',
    // Blueprint A6 proof: the 24-day contact is UNMISTAKABLY pale next to the
    // fresh ones; the company dive is a little world (faces + merged thread)
    // whose interior carries the cold front too; B backs out to People.
    steps: [
      steps.driveTo('people'),
      steps.settle(900),
      steps.frames('cold-pair', 2, 250),
      steps.assert(() => {
        const devon = document.querySelector('[data-crm-theater="people"] .tk-card[data-id="ct_devon"], [data-crm-theater="people"] .tk-zcard[data-id="ct_devon"]');
        const style = devon?.style.getPropertyValue('--crm-staleness');
        return Number(style) >= 0.9;
      }, 'Devon Park carries full staleness'),
      steps.assert(() => {
        const marta = document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');
        const value = Number(marta?.style.getPropertyValue('--crm-staleness') || 0);
        return !!marta && value < 0.15;   // fresh — the pale/warm CONTRAST is the acceptance
      }, 'Marta Reyes reads warm'),
      // The company dive: buckets → dive into Bluepeak → the world.
      steps.evaluate(async () => { window.crmCompanyDive.setActive(true); await window.crmCompanyDive.refresh(); }),
      steps.settle(700),
      steps.frames('company-buckets', 2, 200),
      steps.click('.crm-company-bucket[data-company-key="id:co_bluepeak"]'),
      steps.frames('company-dive', 5, 140),
      steps.settle(500),
      steps.assert(() => document.querySelectorAll('.crm-company-world .crm-company-thread-row').length > 0, 'merged thread renders'),
      steps.assert(() => {
        const face = document.querySelector('.crm-company-world .crm-company-face[data-company-record="contacts:ct_devon"]');
        return Number(face?.style.getPropertyValue('--crm-staleness')) >= 0.9;
      }, 'the dive interior carries the cold front'),
      steps.key('b'),
      steps.frames('b-out', 3, 150),
      steps.settle(500),
      steps.key('Escape'),
      steps.settle(400),
      steps.assert(() => !window.crmCompanyDive.isActive() && document.body.dataset.crmModule === 'people', 'B/Esc chained back to People'),
    ],
  },
  {
    name: 'scene-6-calendar',
    // Blueprint A4 proof: month cells hold title-peek bands + the today glow;
    // a hand card dragged onto a day FLIES in and seats; the day dive is a
    // bucket of openable cards; B chains day→month→year.
    steps: [
      steps.driveTo('calendar'),
      steps.settle(900),
      steps.frames('year', 2, 200),
      // Dive into the current month.
      async ({ page }) => {
        const at = await page.evaluate(() => {
          const month = new Date().getMonth() + 1;
          const el = document.querySelector(`[data-crm-theater="calendar"] .fc-month[data-month="${month}"]`);
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
      },
      steps.frames('month-dive', 5, 140),
      steps.settle(400),
      steps.assert(() => !!document.querySelector('.fc-expander[data-kind="month"] .fc-day.fc-today'), 'today cell glows'),
      steps.assert(() => !!document.querySelector('.fc-expander[data-kind="month"] .fc-chip'), 'peek bands render in day cells'),
      // Fan the riding-along hand and fly the overdue invoice onto a day.
      steps.evaluate(() => window.crmToday.fan('left', true)),
      steps.settle(800),
      async ({ page, shoot }) => {
        const drag = await page.evaluate(() => {
          const card = document.querySelector('[data-crm-theater="today"] .tk-card[data-id="invoices:inv_1038"]');
          const day = [...document.querySelectorAll('.fc-expander[data-kind="month"] .fc-day[data-date]')]
            .find((el) => el.dataset.date.endsWith('-20'));
          if (!card || !day) return null;
          const a = card.getBoundingClientRect(); const b = day.getBoundingClientRect();
          return { fx: a.left + a.width / 2, fy: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height / 2 };
        });
        if (!drag) throw new Error('drag-to-day endpoints missing');
        await page.mouse.move(drag.fx, drag.fy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
          await page.mouse.move(drag.fx + (drag.tx - drag.fx) * (i / 10), drag.fy + (drag.ty - drag.fy) * (i / 10));
          await sleep(28);
        }
        await page.mouse.up();
        await shoot('drop-flight', 5, 130);
      },
      steps.settle(900),
      steps.assert(() => {
        const day = [...document.querySelectorAll('.fc-expander[data-kind="month"] .fc-day[data-date]')]
          .find((el) => el.dataset.date.endsWith('-20'));
        return !!day?.querySelector('.fc-chip[data-id="inv_1038"]');
      }, 'dropped card seated as a peek band'),
      // Day dive: the day is a bucket of openable cards.
      async ({ page }) => {
        const at = await page.evaluate(() => {
          const day = [...document.querySelectorAll('.fc-expander[data-kind="month"] .fc-day[data-date]')]
            .find((el) => el.dataset.date.endsWith('-20'));
          const r = day.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
      },
      steps.frames('day-dive', 4, 140),
      steps.settle(400),
      steps.click('.fc-day-detail .fc-chip[data-id="inv_1038"]'),
      steps.frames('open-from-day', 4, 150),
      steps.settle(400),
      steps.assert(() => !!document.querySelector('.ticket-detail-overlay:not([hidden])'), 'record opened from the day bucket'),
      steps.key('Escape'),
      steps.settle(500),
      // The overdue invoice blooms the next-touch chips — let it go closes out.
      steps.evaluate(() => { document.querySelector('.td-next-touch [data-next-touch-let-go]')?.click(); }),
      steps.settle(700),
      steps.key('b'),
      steps.frames('b-to-month', 3, 140),
      steps.settle(400),
      steps.key('b'),
      steps.frames('b-to-year', 3, 140),
      steps.settle(400),
      steps.assert(() => window.fractalCalendarCamera.level() === 0, 'B chained back to the year'),
    ],
  },
];

// One pg-mem world serves the whole run, so scenes that MUTATE state run
// after the scenes that depend on it: scene-3 wins the Harbor deal, scene-6
// schedules/waives the overdue invoice, scene-4 drafts the flip invoice,
// scene-5 needs Devon still cold, and scene-2 finally empties the hand.
const RUN_ORDER = [
  'scene-1-camera-spine',
  'scene-3-gravity-and-won',
  'scene-8-reports',
  'scene-6-calendar',
  'scene-4-the-flip',
  'scene-5-cold-front',
  'scene-2-dealt-hand',
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
  const ordered = RUN_ORDER.map((name) => SCENES.find((scene) => scene.name === name)).filter(Boolean);
  for (const scene of ordered) {
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
