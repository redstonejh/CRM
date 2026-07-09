// interaction-contract.js — semantic and interaction regression for the desk.
// Pixels prove appearance; this proves that each card surface still behaves
// according to its own metaphor and that Home contains real live miniatures.
'use strict';

const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromePath = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('No Chrome/Edge found; set PUPPETEER_EXECUTABLE_PATH');
  return found;
};

async function main() {
  const { staticUrl } = await start();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, { timeout: 30000 });

  let failures = 0;
  const check = async (name, fn, arg) => {
    let detail = '';
    let ok = false;
    try {
      const result = await page.evaluate(fn, arg);
      ok = result === true || result?.ok === true;
      detail = typeof result === 'object' && result?.detail ? ` — ${result.detail}` : '';
    } catch (error) { detail = ` — ${error.message}`; }
    console.log(`${ok ? ' ok ' : 'FAIL'} ${name}${detail}`);
    if (!ok) failures += 1;
  };
  const activate = async (key) => {
    await page.evaluate((moduleKey) => window.crmWorkspaces.setActive(moduleKey), key);
    await sleep(700);
  };

  await activate('home');
  await page.waitForFunction(() => window.crmHome?.previewStatus?.().every(({ state }) => state === 'ready'), { timeout: 15000 });
  await check('Home mounts six real module miniatures', () => {
    const previews = [...document.querySelectorAll('[data-crm-theater="home"] .crm-home-preview')];
    const real = previews.filter((preview) => preview.firstElementChild && !preview.querySelector('.crm-home-preview-state'));
    return { ok: previews.length === 6 && real.length === 6, detail: `${real.length}/6 ready` };
  });
  await check('Home contains no drawn stand-in cards or stages', () => !document.querySelector('.crm-home-mini-card, .crm-home-mini-stage, .crm-home-mini-day, .crm-home-mini-widget'));
  await check('No invented global quick-add control is mounted', () => !document.querySelector('.crm-quick-add'));

  const expected = {
    tickets: { api: 'ticketStacks', kind: 'progressive', flow: true, bars: true },
    pipeline: { api: 'dealPipeline', kind: 'progressive', flow: true, bars: true },
    money: { api: 'moneyPipeline', kind: 'lifecycle', flow: true, bars: true },
    people: { api: 'peopleCards', kind: 'grouped', flow: false, bars: false },
    today: { api: 'crmToday', kind: 'collection', flow: false, bars: false },
  };
  for (const [key, want] of Object.entries(expected)) {
    await activate(key);
    await check(`${key}: semantic contract and anatomy agree`, ({ key: moduleKey, want: contract }) => {
      const api = window[contract.api];
      const semantics = api?.contract?.();
      const root = document.querySelector(`[data-crm-theater="${moduleKey}"]`);
      const flowCount = root?.querySelectorAll('svg.tk-flow').length || 0;
      const barCount = root?.querySelectorAll('.tk-bars').length || 0;
      const ok = semantics?.workflowKind === contract.kind
        && semantics.showFlow === contract.flow
        && semantics.showProgressBars === contract.bars
        && (flowCount > 0) === contract.flow
        && (barCount > 0) === contract.bars;
      return { ok, detail: `${semantics?.workflowKind}; flow ${flowCount}; bars ${barCount}` };
    }, { key, want });
  }

  await activate('today');
  await page.evaluate(() => window.crmToday.fan('left', true));
  await sleep(520);
  await check('Fanning a hand establishes depth-of-field and keeps its deck sharp', () => {
    const theater = document.querySelector('[data-crm-theater="today"]');
    const scrim = theater?.querySelector('.tk-scrim');
    const deck = theater?.querySelector('.tk-deck-left');
    return {
      ok: deck?.classList.contains('is-fanned') && getComputedStyle(scrim).backdropFilter.includes('blur(4px)') && Number(getComputedStyle(deck).zIndex) >= 3,
      detail: `${getComputedStyle(scrim).backdropFilter}; deck z ${getComputedStyle(deck).zIndex}`,
    };
  });
  await check('Fanned pile reveals its domain label', () => {
    const label = document.querySelector('[data-crm-theater="today"] .tk-deck-left .tk-deck-label');
    return { ok: !!label && getComputedStyle(label).opacity === '1' && label.textContent.trim().length > 0, detail: label?.textContent || 'missing' };
  });
  await page.evaluate(() => window.crmToday.fan('left', false));
  await sleep(520);
  await check('Closing the fan releases depth-of-field', () => getComputedStyle(document.querySelector('[data-crm-theater="today"] .tk-scrim')).backdropFilter.includes('blur(0px)'));

  await activate('people');
  await check('People buckets are company groups, not progressive stages', () => {
    const labels = [...document.querySelectorAll('[data-crm-theater="people"] .tk-zone-hd > span:first-child')].map((node) => node.textContent.trim());
    return { ok: labels.length >= 3 && !labels.some((label) => ['Lead', 'Qualified', 'Proposal', 'Negotiation'].includes(label)), detail: labels.join(', ') };
  });

  if (pageErrors.length) {
    failures += 1;
    console.log(`FAIL page errors — ${pageErrors.join(' | ')}`);
  }
  await browser.close();
  console.log(failures ? `\nInteraction contract FAILED: ${failures} defect(s).` : '\nInteraction contract PASSED.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
