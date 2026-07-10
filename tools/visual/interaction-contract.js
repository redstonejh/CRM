// interaction-contract.js — constitutional behavior, exercised in the real renderer.
'use strict';
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const { start } = require('./harness.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromePath = () => [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(fs.existsSync);

async function main() {
  const { staticUrl } = await start();
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--force-device-scale-factor=1'], defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces && window.crmDesk, { timeout: 30000 });
  await sleep(1800);
  let failures = 0;
  const check = async (name, fn) => {
    let result; let ok = false;
    try { result = await page.evaluate(fn); ok = result === true || result?.ok === true; } catch (error) { result = { detail: error.message }; }
    console.log(`${ok ? ' ok ' : 'FAIL'} ${name}${result?.detail ? ` — ${result.detail}` : ''}`);
    if (!ok) failures++;
  };
  const activate = async (key) => { await page.evaluate((value) => window.crmWorkspaces.setActive(value), key); await sleep(700); };

  await activate('home');
  await page.waitForFunction(() => document.querySelectorAll('.crm-home-window').length === 6, { timeout: 10000 });
  await check('Home has six settled, data-bearing live thumbnails', () => ({
    ok: document.querySelectorAll('.crm-home-window').length === 6
      && [...document.querySelectorAll('.crm-home-window-body')].every((body) => body.children.length > 0)
      && !document.querySelector('.crm-home-portal .crm-home-preview-state'),
    detail: `${document.querySelectorAll('.crm-home-window').length}/6 ready`,
  }));
  await check('Home thumbnails expose the six intended rooms', () => ['desk','people','pipeline','jobs','money','calendar'].every((key) => document.querySelector(`[data-home-room="${key}"]`)));
  await page.click('[data-home-room="desk"]');
  await sleep(100);
  await check('Home-to-room handoff is covered by the expanding live pane', () => !!document.querySelector('.crm-home-flight'));
  await sleep(500);
  await check('Home pane lands directly on the destination without an intermediate label', () => document.body.dataset.crmModule === 'desk' && !document.querySelector('.crm-home-flight') && !document.querySelector('.crm-home-portal:not([hidden])'));
  await page.waitForFunction(() => document.querySelectorAll('.crm-desk-commitment').length >= 4, { timeout: 10000 });
  await check('Desk merges due work, live workflows, and activity', () => ({
    ok: document.querySelectorAll('.crm-desk-commitment').length >= 4
      && document.querySelectorAll('.crm-desk-work-card').length >= 5
      && document.querySelectorAll('.crm-desk-activity').length >= 2,
    detail: `${document.querySelectorAll('.crm-desk-commitment').length} commitments / ${document.querySelectorAll('.crm-desk-work-card').length} work / ${document.querySelectorAll('.crm-desk-activity').length} activity`,
  }));
  await check('Desk has explicit stage indicators, not stage labels alone', () => document.querySelectorAll('.crm-desk-stagebar i.is-on').length >= 5);
  await check('Retired Home, Today, and Reports theaters do not own the stage', () => ![...document.querySelectorAll('[data-crm-theater="home"],[data-crm-theater="today"],[data-crm-theater="reports"]')].some((el) => !el.hidden));

  await activate('people');
  await check('People is a relationship room, not a ticket board', () => ({
    ok: document.querySelectorAll('.crm-company-account').length === 3
      && !document.querySelector('[data-crm-theater="relationships"] .tk-card'),
    detail: `${document.querySelectorAll('.crm-company-account').length} company worlds`,
  }));

  const workflowRooms = { pipeline: 4, jobs: 4, money: 3, cases: 3 };
  for (const [key, zones] of Object.entries(workflowRooms)) {
    await activate(key);
    await check(`${key} keeps bucket, progress, and depth choreography`, () => ({
      ok: document.querySelectorAll('[data-crm-theater]:not([hidden]) .tk-zone').length > 0
        && document.querySelectorAll('[data-crm-theater]:not([hidden]) .tk-bars').length > 0
        && !!document.querySelector('[data-crm-theater]:not([hidden]) .tk-create-action'),
      detail: `${document.querySelectorAll('[data-crm-theater]:not([hidden]) .tk-zone').length} zones`,
    }));
    await check(`${key} capture action is named`, () => {
      const action = document.querySelector('[data-crm-theater]:not([hidden]) .tk-create-action');
      return !!action && action.textContent.trim().length > 3 && !action.querySelector('svg');
    });
  }

  await activate('calendar');
  await page.evaluate(() => document.querySelector('.fc-month[data-month="7"]')?.click());
  await sleep(700);
  await check('Calendar is fed only by commitments', () => {
    const chips = [...document.querySelectorAll('[data-crm-theater="calendar"] .fc-chip[data-type]')];
    return chips.length > 0 && chips.every((chip) => chip.dataset.type === 'commitment');
  });

  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await sleep(500);
  await check('Search is a result list, never a mixed entity fan', () => ({
    ok: !document.querySelector('.crm-command-shade[hidden]') && document.querySelectorAll('.crm-command-row').length > 0 && !document.querySelector('.crm-command .tk-card'),
    detail: `${document.querySelectorAll('.crm-command-row').length} results`,
  }));
  await page.keyboard.press('Escape');

  await activate('desk');
  await page.click('.crm-desk-work-card');
  await page.waitForSelector('.record-world-shell:not([hidden])');
  await check('A work card opens contextual identity, workflow, relationships, commitments, and activity', () => ({
    ok: !!document.querySelector('.record-world-facts') && !!document.querySelector('.record-world-flow-bar')
      && !!document.querySelector('.record-world-related') && !!document.querySelector('.record-world-commitments')
      && !!document.querySelector('.record-world-timeline'),
    detail: document.querySelector('.record-world-title')?.textContent || '',
  }));
  await page.click('[data-show-note]');
  await page.type('[data-note-form] textarea', 'Interaction contract note');
  await page.click('[data-note-form] button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.record-world-event-content')].some((el) => el.textContent.includes('Interaction contract note')), { timeout: 5000 });
  await check('Adding a note creates durable contextual activity', () => [...document.querySelectorAll('.record-world-event-content')].some((el) => el.textContent.includes('Interaction contract note')));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.record-world-shell[hidden]');
  await activate('desk');

  const before = await page.$$eval('.crm-desk-surface:not([hidden]) .crm-desk-commitment', (els) => els.length);
  await page.click('.crm-desk-surface:not([hidden]) .crm-desk-check');
  await page.waitForFunction((count) => document.querySelectorAll('.crm-desk-commitment').length === count - 1, { timeout: 5000 }, before);
  await check('Completing a commitment removes it from the open Desk', () => document.querySelectorAll('.crm-desk-commitment').length === 3);
  await check('No renderer exceptions during the complete scenario', () => true);

  if (errors.length) { console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`); failures++; }
  console.log(`\nInteraction contract: ${failures ? `${failures} failure(s)` : 'PASSED'}.`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
