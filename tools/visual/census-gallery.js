// census-gallery.js — adversarial evidence for DEFECT_CENSUS class E.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { start } = require('./harness.js');
const { chromePath } = require('./reference.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const outDir = path.join(__dirname, 'census');
  fs.mkdirSync(outDir, { recursive: true });
  const { staticUrl } = await start();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[page error]', error.message));
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.crmWorkspaces && !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await wait(2600);

  const shot = async (name, settle = 350) => {
    await wait(settle);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log('[census]', path.relative(process.cwd(), file));
  };
  const workspace = async (key) => {
    await page.evaluate((value) => window.crmWorkspaces.setActive(value), key);
    await wait(900);
  };

  // E8: both boundary widths. E7: dark and bright bundled wallpapers.
  await page.setViewport({ width: 1280, height: 800 });
  await workspace('pipeline');
  await shot('01-pipeline-1280-dark');
  await page.evaluate(() => {
    localStorage.setItem('dashboard-background', 'photo-water2');
    location.reload();
  });
  await page.waitForFunction(() => window.crmWorkspaces && !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await wait(2200);
  await page.setViewport({ width: 2560, height: 1440 });
  await workspace('pipeline');
  await shot('02-pipeline-2560-light');

  await page.setViewport({ width: 1600, height: 1000 });
  await workspace('pipeline');

  // E1/E2: visible hover/focus treatments.
  await page.evaluate(() => document.querySelector('[data-crm-theater="pipeline"] .tk-zcard')?.focus());
  await shot('03-keyboard-focus');

  // E10: open panel, then the close interceptor's next-touch chips.
  await page.evaluate(async () => {
    const result = await window.deals?.list?.({ includeDeleted: false });
    const records = result?.records || result || [];
    const record = records.find((item) => item.id === 'dl_bluepeak_onboarding') || records[0];
    const card = document.querySelector(`[data-crm-theater="pipeline"] .tk-zcard[data-id="${record?.id}"]`);
    if (record && card) window.dealDetail?.open?.(record, card);
  });
  await page.waitForSelector('.ticket-detail-overlay:not([hidden])', { timeout: 5000 });
  await shot('04-open-panel', 1000);
  await page.evaluate(() => document.querySelector('.ticket-detail .td-x')?.click());
  await page.waitForSelector('.td-next-touch', { timeout: 5000 });
  await shot('05-next-touch-chips', 450);
  await page.keyboard.press('Escape');

  // E10: quick-add and search-as-deck.
  await page.evaluate(() => window.crmQuickAdd?.open?.());
  await shot('06-quick-add');
  await page.evaluate(() => { window.crmQuickAdd?.close?.(); window.crmSearchDeck?.setQuery?.('Bluepeak'); });
  await shot('07-search-deck', 900);
  await page.evaluate(() => window.crmSearchDeck?.close?.());

  // E10: company camera interior.
  await page.evaluate(() => window.crmCompanyDive?.openCompany?.('id:co_bluepeak'));
  await shot('08-company-dive', 1100);
  await page.evaluate(() => window.crmCompanyDive?.setActive?.(false));

  // E4/E5: designed load and offline surfaces (the normal API is left intact).
  await workspace('pipeline');
  await page.evaluate(() => window.dealPipeline?.previewState?.('loading'));
  await shot('09-loading-skeleton');
  await page.evaluate(() => window.dealPipeline?.previewState?.('error'));
  await shot('10-offline-state');
  await page.evaluate(() => window.dealPipeline?.previewState?.(null));

  // E9: 200-card LOD stress on Pipeline, using real API records.
  await page.evaluate(async () => {
    const api = window.__CRM_API_URL__ || 'http://127.0.0.1:3899';
    const rows = Array.from({ length: 197 }, (_, index) => ({
      id: `stress_deal_${index}`,
      title: `Stress opportunity ${String(index + 1).padStart(3, '0')}`,
      client: index % 2 ? 'Bluepeak Logistics' : 'Harbor & Lane',
      companyId: index % 2 ? 'co_bluepeak' : 'co_harborlane',
      state: 'open', stage: ['lead', 'qualified', 'proposal', 'negotiation'][index % 4],
      priority: ['cold', 'warm', 'hot', 'commit'][index % 4], amount: 1000 + index * 25,
      description: 'LOD stress record',
    }));
    for (let start = 0; start < rows.length; start += 20) {
      await Promise.all(rows.slice(start, start + 20).map((fields) => fetch(`${api}/api/entities/deals`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields, actor: 'census' }),
      })));
    }
    await window.dealPipeline?.reload?.();
  });
  await shot('11-pipeline-200-card-stress', 1400);

  // E10: the two-faced flip in motion. State is created first by crmFlip.
  await page.evaluate(() => {
    const card = document.querySelector('[data-crm-theater="pipeline"] .tk-card[data-id="dl_foxglove_rebrand"]');
    const recordPromise = window.deals?.list?.({ includeDeleted: false });
    Promise.resolve(recordPromise).then((result) => {
      const records = result?.records || result || [];
      const record = records.find((item) => item.id === 'dl_foxglove_rebrand');
      const rect = card?.getBoundingClientRect?.() || { left: 20, top: 700, width: 185, height: 280 };
      window.crmFlip?.play?.({
        record,
        fromRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        target: {
          module: 'money',
          build: (deal) => ({
            title: `Draft — ${deal.title || deal.client}`, client: `Draft — ${deal.title || deal.client}`,
            number: 'Draft', amount: deal.amount || '', companyId: deal.companyId || '', dealId: deal.id,
            state: 'draft', stage: 'draft', priority: 'draft', description: `Drafted from ${deal.title || deal.client}`,
          }),
        },
      });
    });
  });
  await shot('12-flip-in-flight', 1250);

  await browser.close();
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
