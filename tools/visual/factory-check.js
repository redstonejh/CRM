// factory-check.js — structural regression: original ticketing vs CRM Tickets.
//
// Boots BOTH apps through the harness (original repo on 3896/3897, CRM on
// 3898/3899), navigates the CRM to its Tickets surface, and compares the
// computed anatomy of the ticket/card faces shared with the reference. The
// surrounding interface intentionally follows the CRM config-menu contract,
// and bucket-to-bucket arrows are forbidden. Exits non-zero on any mismatch.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { start } = require('./harness.js');
const { STAGE_MAP, seedTickets } = require('./reference.js');
const { seed } = require('./seed.js');

const seedFactoryDataset = async (apiUrl) => {
  const crmCounts = await seed(apiUrl);
  const referenceCounts = await seedTickets(apiUrl);
  return { ...crmCounts, referenceTickets: referenceCounts.tickets };
};

// Anatomy probes: selector → the computed properties that define the recipe.
const PROBES = [
  { name: 'deck card', selector: '.tk-card', props: ['borderRadius', 'paddingTop', 'paddingLeft', 'color'] },
  { name: 'zone card', selector: '.tk-zcard', props: ['borderRadius', 'paddingTop', 'paddingLeft', 'color'] },
  { name: 'card title', selector: '.tk-card .ticket-company, .tk-zcard .ticket-company', props: ['fontSize', 'fontWeight', 'lineHeight'] },
  { name: 'card subtitle', selector: '.tk-card .ticket-host, .tk-zcard .ticket-host', props: ['fontSize', 'color'] },
];

// Structural counts. Arrows are explicitly zero for every bucket system; the
// remaining reference mechanics and card inventory stay intact.
const STRUCTURE = [
  { name: 'stage zones', selector: '.tk-zone', min: 3, max: 3 },
  { name: 'corner decks', selector: '.tk-deck-left, .tk-deck-right', min: 2, max: 2 },
  { name: 'bucket-to-bucket arrows', selector: 'svg.tk-flow, .tk-flow-shaft, .tk-flow-head', min: 0, max: 0 },
  { name: 'dashed placeholders (restored per FIDELITY_ORDER)', selector: '.tk-empty', min: 3, max: 3 },
  { name: 'create button', selector: '.tk-stack-btn', min: 2, max: 2 },
];

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

async function sample(page, rootSelector = '') {
  return page.evaluate(({ probes, structure, rootSelector: selector }) => {
    const root = selector ? document.querySelector(selector) : document;
    if (!root) throw new Error(`Factory sample root missing: ${selector}`);
    const styles = {};
    for (const probe of probes) {
      const el = root.querySelector(probe.selector);
      if (!el) { styles[probe.name] = null; continue; }
      const cs = getComputedStyle(el);
      styles[probe.name] = Object.fromEntries(probe.props.map((p) => [p, cs[p]]));
    }
    const counts = {};
    for (const item of structure) counts[item.name] = root.querySelectorAll(item.selector).length;
    return { styles, counts };
  }, { probes: PROBES, structure: STRUCTURE, rootSelector });
}

async function bootPage(browser, url, activate) {
  console.log(`[factory] booting ${url}`);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((stageMap) => {
    localStorage.setItem('dashboard-background', 'photo-water');
    localStorage.setItem('tk-ticket-stage', JSON.stringify(stageMap));
  }, STAGE_MAP);
  await page.goto(url, { waitUntil: 'load' });
  console.log(`[factory] loaded ${url}`);
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  if (activate) await page.evaluate(activate);
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[factory] settled ${url}`);
  return page;
}

async function main() {
  const originalRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '_src_ticketing'));
  const originalDash = path.join(originalRoot, 'dashboard');
  if (!fs.existsSync(path.join(originalDash, 'index.html'))) {
    throw new Error(`Original ticketing dashboard not found at ${originalDash}`);
  }

  // One API (Rosa dataset incl. the ticket) serves BOTH dashboards — the
  // original only reads window.tickets, so extra entities are invisible to it.
  console.log('[factory] starting shared reference dataset');
  const crm = await start({ seedFn: seedFactoryDataset });
  const orig = await start({ dashboardRoot: originalDash, staticPort: 3896, apiUrl: crm.apiUrl });

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });

  const origPage = await bootPage(browser, orig.staticUrl);
  const crmPage = await bootPage(browser, crm.staticUrl, () => window.crmWorkspaces.setActive('cases'));

  const expected = await sample(origPage);
  const actual = await sample(crmPage, '[data-crm-theater="tickets"]');

  let failures = 0;
  const report = (level, msg) => { console.log(`${level} ${msg}`); if (level === 'FAIL') failures++; };

  for (const item of STRUCTURE) {
    const got = actual.counts[item.name];
    const ok = got >= item.min && got <= item.max;
    report(ok ? ' ok ' : 'FAIL', `structure: ${item.name} — expected ${item.min === item.max ? item.min : `${item.min}..${item.max}`}, got ${got}`);
  }
  for (const probe of PROBES) {
    const want = expected.styles[probe.name];
    const got = actual.styles[probe.name];
    if (!want) { report(' ok ', `style: ${probe.name} — absent in original (skipped)`); continue; }
    if (!got) { report('FAIL', `style: ${probe.name} — present in original, MISSING in CRM`); continue; }
    for (const prop of probe.props) {
      if (want[prop] === got[prop]) continue;
      report('FAIL', `style: ${probe.name}.${prop} — original "${want[prop]}" vs CRM "${got[prop]}"`);
    }
  }
  const anyStyleOk = PROBES.every((p) => !expected.styles[p.name] || actual.styles[p.name]);
  if (anyStyleOk && !failures) console.log('\nFactory check PASSED: ticket/card faces match the reference and bucket arrows are absent.');
  else console.log(`\nFactory check: ${failures} mismatch(es).`);

  await browser.close();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
