// reference.js — render the ORIGINAL ticketing repo through the same harness.
//
// The original repo is the visual source of truth for card, deck and zone
// anatomy (REMEDIATION_PLAN.md, ground truth). Its ticket-stacks.js +
// ticket-detail.js are self-contained over window.tickets, so the CRM shim
// drives them unmodified. Output: tools/visual/reference/tickets*.png — the
// goldens the CRM Tickets surface is compared against.
//
// Usage: node tools/visual/reference.js [originalRepoRoot]
//   default originalRepoRoot: ../../../_src_ticketing (sibling checkout)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { start } = require('./harness.js');

const DAY = 86400000;
const iso = (daysAgo, hour = 10) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

// Ticket-only dataset shaped like the original app's data: a spread across
// severities and states so decks, zones and the resolved pile all render.
const TICKETS = [
  { id: 'ref_open_hi', companyLabel: 'Bluepeak Logistics', host: 'mail01.bluepeak.local', severity: 'high', priority: 'high', state: 'open', description: 'Outbound mail queue backing up since the weekend.', incidentDate: iso(1).slice(0, 10) },
  { id: 'ref_open_med', companyLabel: 'Harbor & Lane', host: 'fs02.harborlane.local', severity: 'medium', priority: 'medium', state: 'open', description: 'File server slow to enumerate shares.', incidentDate: iso(2).slice(0, 10) },
  { id: 'ref_triage', companyLabel: 'Foxglove Studio', host: 'nas.foxglove.local', severity: 'low', priority: 'low', state: 'open', assignee: 'rosa', description: 'NAS reports one degraded disk.', incidentDate: iso(3).slice(0, 10) },
  { id: 'ref_invest', companyLabel: 'Cedar Point Dental', host: 'dc1.cedarpoint.local', severity: 'critical', priority: 'critical', state: 'claimed', claimedBy: 'rosa', investigation: 'Failing UPS took the DC down overnight.', description: 'Domain logins failing at the front desk.', incidentDate: iso(1).slice(0, 10) },
  { id: 'ref_resolved', companyLabel: 'Willits Scaling', host: 'app.willits.local', severity: 'medium', priority: 'medium', state: 'resolved', resolvedBy: 'rosa', resolvedAt: iso(1, 16), resolution: 'Confirmed with the client after the patch.', description: 'App pool recycling loop after the update.', incidentDate: iso(4).slice(0, 10) },
];

// The original keeps stage assignment client-side (localStorage) — pre-seed it
// so the reference shot shows populated zones, not just decks.
const STAGE_MAP = { ref_triage: 'triage', ref_invest: 'investigation' };

async function seedTickets(apiUrl) {
  for (const fields of TICKETS) {
    const res = await fetch(`${apiUrl}/api/entities/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields, actor: 'rosa' }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Seeding ticket ${fields.id} failed: ${json.error}`);
  }
  return { tickets: TICKETS.length };
}

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

async function main() {
  const originalRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '_src_ticketing'));
  const dashboardRoot = path.join(originalRoot, 'dashboard');
  if (!fs.existsSync(path.join(dashboardRoot, 'index.html'))) {
    throw new Error(`Original ticketing dashboard not found at ${dashboardRoot}`);
  }
  const outDir = path.join(__dirname, 'reference');
  fs.mkdirSync(outDir, { recursive: true });

  const { staticUrl } = await start({
    dashboardRoot,
    apiPort: 3897,
    staticPort: 3896,
    seedFn: seedTickets,
  });

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[page error]', err.message));
  await page.evaluateOnNewDocument((stageMap) => {
    localStorage.setItem('tk-ticket-stage', JSON.stringify(stageMap));
    // FIDELITY_ORDER §0/§1: the binding look is the original at FULL fidelity — wallpaper
    // applied, glass live. Same wallpaper the CRM boots on (photo-water), so the
    // indistinguishability diff compares like with like.
    localStorage.setItem('dashboard-background', 'photo-water');
  }, STAGE_MAP);
  await page.goto(staticUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  await page.screenshot({ path: path.join(outDir, 'tickets.png') });
  console.log('[reference]', path.join('tools', 'visual', 'reference', 'tickets.png'));

  // A fanned deck too — the deck anatomy golden. The original exposes no fan() API;
  // click its left deck's fan arrow like a user would.
  await page.evaluate(() => document.querySelector('.tk-deck-left .tk-arrow')?.click());
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(outDir, 'tickets-fanned.png') });
  console.log('[reference]', path.join('tools', 'visual', 'reference', 'tickets-fanned.png'));

  await browser.close();
  process.exit(0);
}

module.exports = { TICKETS, STAGE_MAP, seedTickets, chromePath };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
