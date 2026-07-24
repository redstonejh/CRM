'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'shots', 'cdms-integration');
const cdmsUrl = process.env.CRM_CDMS_URL || 'http://192.168.203.238:6030';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function forbiddenKeyPaths(value, prefix = 'root', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeyPaths(item, `${prefix}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    if (key !== 'mustChangePassword'
      && (/(password|passwd|passcode|secret|token|private[\s_-]*key|recovery[\s_-]*code|mfa|otp)/i.test(key)
        || /^notes?(?:\s*\d+)?$/i.test(key))) {
      output.push(`${prefix}.${key}`);
    }
    forbiddenKeyPaths(item, `${prefix}.${key}`, output);
  });
  return output;
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  const harness = await start({ apiPort: 3949, staticPort: 3948 });
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      CRM_API_URL: harness.apiUrl,
      CRM_CDMS_URL: cdmsUrl,
      CRM_CDMS_DISABLED: '0',
    },
    timeout: 30_000,
  });
  const errors = [];
  try {
    const page = await app.firstWindow({ timeout: 30_000 });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForLoadState('load');
    await page.waitForFunction(() => (
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && !!window.crmWorkspaces
      && !!window.crmCdms
    ), null, { timeout: 45_000 });

    await page.evaluate(async ({ apiUrl, sourceUrl }) => {
      await window.crmBackend.saveSettings({ apiUrl, cdmsUrl: sourceUrl });
      await window.crmCdms.refresh();
    }, { apiUrl: harness.apiUrl, sourceUrl: cdmsUrl });
    await page.waitForFunction(async () => {
      const status = await window.crmCdms.status();
      return status.connection === 'live' && status.companies > 0 && status.contacts > 0 && status.assets > 0;
    }, null, { timeout: 120_000 });

    const evidence = await page.evaluate(async () => {
      const [session, status, catalog, tickets, projects, workItems] = await Promise.all([
        window.auth.session(),
        window.crmCdms.status(),
        window.crmCdms.catalog(),
        window.tickets.list(),
        window.crmStore.list('projects', { includeDeleted: false }),
        window.crmStore.list('workItems', { includeDeleted: false }),
      ]);
      const demoTickets = (tickets.tickets || []).filter((record) => /^tkt_demo_/i.test(record.id || ''));
      const demoProjects = (projects.records || []).filter((record) => /^proj_/i.test(record.id || ''));
      const demoItems = (workItems.records || []).filter((record) => /^wi_/i.test(record.id || ''));
      return {
        session: {
          provider: session.provider,
          authDisabled: session.authDisabled,
          role: session.user?.role,
          signedIn: !!session.user,
        },
        counts: {
          companies: status.companies,
          contacts: status.contacts,
          assets: status.assets,
        },
        catalog,
        references: {
          tickets: demoTickets.length,
          ticketsWithCompany: demoTickets.filter((record) => /^cdms-company-/.test(record.companyId || '')).length,
          ticketsWithAsset: demoTickets.filter((record) => /^cdms-asset-/.test(record.cdmsAssetId || '')).length,
          ticketsWithIp: demoTickets.filter((record) => !!record.ipAddress).length,
          projects: demoProjects.length,
          projectsWithOwner: demoProjects.filter((record) => /^cdms-contact-/.test(record.ownerContactId || '')).length,
          workItems: demoItems.length,
          workItemsWithPerson: demoItems.filter((record) => /^cdms-contact-/.test(record.assignedContactId || '')).length,
        },
      };
    });
    assert.equal(evidence.session.provider, 'cdms');
    assert.equal(evidence.session.signedIn, true);
    assert.ok(evidence.counts.companies > 0);
    assert.ok(evidence.counts.contacts > 0);
    assert.ok(evidence.counts.assets > 0);
    assert.deepEqual(forbiddenKeyPaths(evidence.catalog), []);
    assert.ok(evidence.references.tickets > 0);
    assert.equal(evidence.references.ticketsWithCompany, evidence.references.tickets);
    assert.equal(evidence.references.ticketsWithAsset, evidence.references.tickets);
    assert.equal(evidence.references.ticketsWithIp, evidence.references.tickets);
    assert.ok(evidence.references.projects > 0);
    assert.equal(evidence.references.projectsWithOwner, evidence.references.projects);
    assert.ok(evidence.references.workItems > 0);
    assert.equal(evidence.references.workItemsWithPerson, evidence.references.workItems);

    await page.evaluate(() => window.crmWorkspaces.setActive('people'));
    await page.waitForFunction(() => (
      document.body.dataset.crmModule === 'people'
      && !window.crmDeskTransit?.isBusy?.()
      && document.querySelectorAll('[data-crm-theater="people"]:not([hidden]) .tk-zone').length > 20
      && document.querySelectorAll('[data-crm-theater="people"]:not([hidden]) .tk-zcard').length > 0
    ), null, { timeout: 45_000 });
    const peopleUi = await page.evaluate(() => {
      const theater = document.querySelector('[data-crm-theater="people"]:not([hidden])');
      const firstCard = theater?.querySelector('.tk-zcard');
      const cards = [...(theater?.querySelectorAll('.tk-zcard') || [])];
      return {
        buckets: theater?.querySelectorAll('.tk-zone').length || 0,
        visibleCards: cards.length,
        hasCdmsSourceCard: !!firstCard,
        hasLoginOrIp: cards.some((card) => /(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|Login|@)/i.test(card.innerText || '')),
      };
    });
    assert.ok(peopleUi.buckets >= evidence.counts.companies);
    assert.ok(peopleUi.visibleCards > 0);
    assert.equal(peopleUi.hasLoginOrIp, true);
    await page.screenshot({ path: path.join(outDir, '01-people-cdms.png') });

    await page.evaluate(async () => {
      const response = await window.companies.list({ includeDeleted: false });
      const company = (response.records || []).find((record) => record.source === 'cdms');
      if (!company) throw new Error('No CDMS company is available for the company world');
      await window.crmCompanyDive.openCompany(`id:${company.id}`);
    });
    await page.waitForSelector('.crm-company-world .crm-company-lane-title', { timeout: 30_000 });
    const companyWorld = await page.evaluate(() => ({
      lanes: [...document.querySelectorAll('.crm-company-world .crm-company-lane-title')].map((element) => element.textContent.trim()),
      assets: document.querySelectorAll('.crm-company-world [data-company-record^="assets:"]').length,
    }));
    assert.ok(companyWorld.lanes.includes('Infrastructure'));
    await page.screenshot({ path: path.join(outDir, '02-company-infrastructure.png') });

    await page.evaluate(() => window.crmCompanyDive.setActive(false));
    await page.evaluate(() => window.crmWorkspaces.setActive('cases'));
    await page.waitForFunction(() => (
      document.body.dataset.crmModule === 'cases'
      && !window.crmDeskTransit?.isBusy?.()
      && document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-card').length > 0
    ), null, { timeout: 30_000 });
    const ticketUi = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-card')];
      return {
        cards: cards.length,
        cardsWithIp: cards.filter((card) => /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(card.innerText || '')).length,
        samples: cards.slice(0, 3).map((card) => ({
          id: card.dataset.id,
          text: String(card.innerText || '').replace(/\s+/g, ' ').trim(),
        })),
      };
    });
    assert.ok(ticketUi.cards > 0);
    assert.ok(ticketUi.cardsWithIp > 0, `Ticket cards did not expose a linked CDMS IP: ${JSON.stringify(ticketUi.samples)}`);
    await page.screenshot({ path: path.join(outDir, '03-tickets-real-references.png') });

    await page.click('.auth-profile-button');
    await page.click('.auth-backend');
    await page.waitForSelector('.auth-backend-modal [data-backend-status="cdms"]', { timeout: 10_000 });
    await page.waitForFunction(() => /companies/.test(document.querySelector('[data-backend-status="cdms"]')?.innerText || ''), null, { timeout: 30_000 });
    await page.screenshot({ path: path.join(outDir, '04-backend-status.png') });

    const report = {
      ok: true,
      session: evidence.session,
      counts: evidence.counts,
      references: evidence.references,
      peopleUi,
      ticketUi,
      companyWorld,
      secretsExposed: 0,
      pageErrors: errors,
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, []);
    console.log('[cdms-electron-smoke]', report);
  } finally {
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.exit(0));
      return true;
    }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), sleep(3000)]);
    harness.stop();
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[cdms-electron-smoke]', error.stack || error.message || error);
    process.exit(1);
  });
