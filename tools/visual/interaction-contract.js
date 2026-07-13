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
  await page.waitForFunction(() => document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6, { timeout: 10000 });
  await check('Non-card interface audit has complete config-menu coverage', () => {
    const audit = window.crmInterfaceParity?.audit?.();
    return {
      ok: !!audit && audit.surfaces > 0 && audit.actions > 0
        && audit.missingSurfaces.length === 0 && audit.missingActions.length === 0
        && audit.bucketArrows === 0,
      detail: audit ? `${audit.surfaces} surfaces / ${audit.actions} actions / ${audit.bucketArrows} arrows` : 'audit unavailable',
    };
  });
  await check('Information shells use the config menu recipe exactly', () => {
    const surface = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const reference = document.querySelector('.dashboard-search-popover');
    if (!surface || !reference) return false;
    const actual = getComputedStyle(surface);
    const expected = getComputedStyle(reference);
    return ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'color']
      .every((property) => actual[property] === expected[property]);
  });
  await check('Non-top buttons use the config menu item recipe exactly', () => {
    const action = document.querySelector('.crm-home-control');
    const reference = document.querySelector('.auth-menu-item');
    if (!action || !reference || !action.classList.contains('crm-config-action')) return false;
    const actual = getComputedStyle(action);
    const expected = getComputedStyle(reference);
    const same = ['backgroundColor', 'borderTopWidth', 'borderRadius', 'color', 'fontSize', 'fontWeight', 'boxShadow', 'paddingLeft', 'paddingRight']
      .every((property) => actual[property] === expected[property]);
    return same
      && [...document.querySelectorAll('.window-glass-control')].every((button) => !button.classList.contains('crm-config-action'))
      && [...document.querySelectorAll('.tk-card, .tk-zcard')].every((card) => !card.classList.contains('crm-config-action') && !card.classList.contains('crm-config-surface'));
  });
  await check('Home has six inert screenshot LODs and no live miniature trees', () => ({
    ok: document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6
      && !document.querySelector('.crm-home-grid .crm-home-lod-scene,.crm-home-grid .crm-home-lod-root'),
    detail: `${document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length}/6 surfaces`,
  }));
  await check('Home thumbnails expose the six intended rooms', () => ['desk','people','pipeline','jobs','money','calendar'].every((key) => document.querySelector(`.crm-home-bucket[data-module="${key}"]`)));
  await page.waitForFunction(() => window.crmHome?.handStatus?.().count > 0 && document.querySelectorAll('.crm-home-hand-card.tk-card').length > 0, { timeout: 10000 });
  await check('Home hand uses card-system card objects', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card')];
    return cards.length > 0 && cards.every((card) => card.matches('.tk-card.tk-card-today') && !!card.querySelector('.ticket-body'))
      && !document.querySelector('.crm-home-priority-card');
  });
  await check('Home reserves room for a curved priority hand', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card.tk-card')];
    const grid = document.querySelector('.crm-home-grid')?.getBoundingClientRect();
    const rotations = new Set(cards.map((card) => card.style.getPropertyValue('--hand-rot')));
    const positions = new Set(cards.map((card) => card.style.getPropertyValue('--hand-x')));
    const peeking = cards.every((card) => { const visible = innerHeight - card.getBoundingClientRect().top; return visible >= 110 && visible <= 170; });
    return cards.length > 0 && cards.length <= 7 && rotations.size > 1 && positions.size === cards.length && peeking && grid?.bottom < innerHeight - 145;
  });
  await page.hover('.crm-home-hand-trigger');
  await sleep(460);
  await check('Hovering the hand reveals every priority card', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card.tk-card')];
    return cards.length > 0 && cards.every((card) => { const rect = card.getBoundingClientRect(); return rect.top > 0 && rect.bottom <= innerHeight + 1; })
      && Math.min(...cards.map((card) => card.getBoundingClientRect().top)) < innerHeight - 150;
  });
  await page.evaluate(() => { window.__homeHandTargetTop = document.querySelector('.crm-home-hand-card.tk-card')?.getBoundingClientRect().top || 0; });
  await page.hover('.crm-home-hand-card.tk-card');
  await sleep(220);
  await check('The priority card under the cursor lifts above the hand', () => {
    const card = document.querySelector('.crm-home-hand-card.tk-card');
    return !!card && card.getBoundingClientRect().top <= window.__homeHandTargetTop - 6;
  });
  await page.mouse.move(1, 1);
  await sleep(430);
  await page.evaluate(() => document.querySelectorAll('.crm-home-grid > .crm-home-bucket').forEach((tile) => {
    const preview = tile.querySelector('.crm-home-preview');
    if (!preview.querySelector('.crm-home-preview-foreground')) {
      const probe = document.createElement('img');
      probe.className = 'crm-home-preview-image crm-home-preview-foreground';
      probe.dataset.interactionStyleProbe = 'true';
      preview.appendChild(probe);
    }
  }));
  await check('Resting Home objects use the lightweight raster blur', () => {
    const images = [...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')];
    return images.length === 6 && images.every((image) => getComputedStyle(image).filter === 'blur(1.25px)');
  });
  await page.hover('.crm-home-bucket[data-module="desk"]');
  await sleep(220);
  await check('Hover sharpens tile objects and de-emphasizes its title', () => {
    const tile = document.querySelector('.crm-home-grid > .crm-home-bucket[data-module="desk"]');
    const foreground = tile?.querySelector('.crm-home-preview-foreground');
    const title = tile?.querySelector('.crm-home-title-glass');
    return !!foreground && !!title && getComputedStyle(foreground).filter === 'none' && Number(getComputedStyle(title).opacity) <= .3;
  });
  await page.evaluate(() => document.querySelectorAll('[data-interaction-style-probe]').forEach((probe) => probe.remove()));
  await page.click('.crm-home-bucket[data-module="desk"]');
  await sleep(100);
  await check('Home-to-room handoff remains inside the original camera', () => document.body.dataset.crmModule === 'home'
    && window.crmHomeCamera?.isTransitioning?.() && !!document.querySelector('.crm-home-expander:not(.crm-home-warm)'));
  await check('Tile transition preserves the native title-bar drag region', () => {
    const strip = document.querySelector('.app-window-drag-region');
    const lid = document.querySelector('.crm-home-expander:not(.crm-home-warm)');
    const x = Math.round(innerWidth * .5), y = 20;
    const exclusions = [...document.querySelectorAll('*')].filter((node) => {
      const style = getComputedStyle(node);
      if (style.webkitAppRegion !== 'no-drag' || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    return getComputedStyle(strip).webkitAppRegion === 'drag'
      && getComputedStyle(lid).webkitAppRegion !== 'no-drag'
      && exclusions.length === 0;
  });
  await sleep(650);
  await check('Home camera lands directly on the destination', () => document.body.dataset.crmModule === 'desk' && !document.querySelector('.crm-transit-veil'));
  await check('Tile room does not exclude the title-bar drag region', () => {
    const room = document.querySelector('.crm-desk-surface:not([hidden])');
    return !!room && getComputedStyle(room).webkitAppRegion !== 'no-drag';
  });
  await page.waitForFunction(() => document.querySelectorAll('.crm-desk-commitment').length >= 4, { timeout: 10000 });
  await check('Desk merges due work, live workflows, and activity', () => ({
    ok: document.querySelectorAll('.crm-desk-commitment').length >= 4
      && document.querySelectorAll('.crm-desk-work-card').length >= 5
      && document.querySelectorAll('.crm-desk-activity').length >= 2,
    detail: `${document.querySelectorAll('.crm-desk-commitment').length} commitments / ${document.querySelectorAll('.crm-desk-work-card').length} work / ${document.querySelectorAll('.crm-desk-activity').length} activity`,
  }));
  await check('Desk has explicit stage indicators, not stage labels alone', () => document.querySelectorAll('.crm-desk-stagebar i.is-on').length >= 5);
  await check('Retired Home, Today, and Reports theaters do not own the stage', () => ![...document.querySelectorAll('[data-crm-theater="home"],[data-crm-theater="today"],[data-crm-theater="reports"]')].some((el) => !el.hidden));

  await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
  await sleep(650);
  await check('Returning Home restores an uncontested title-bar drag region', () => {
    const x = Math.round(innerWidth * .5), y = 20;
    const strip = document.querySelector('.app-window-drag-region');
    const exclusions = [...document.querySelectorAll('*')].filter((node) => {
      const style = getComputedStyle(node);
      if (style.webkitAppRegion !== 'no-drag' || style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    return document.body.dataset.crmModule === 'home'
      && getComputedStyle(strip).webkitAppRegion === 'drag'
      && exclusions.length === 0;
  });

  await activate('people');
  await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="people"] .tk-zone[data-stage]').length === 8
    && document.querySelectorAll('[data-crm-theater="people"] .tk-zone .tk-zcard').length === 80, { timeout: 10000 });
  await check('People are shared card objects grouped inside company buckets, never a pipeline', () => {
    const theater = document.querySelector('[data-crm-theater="people"]:not([hidden])');
    const buckets = [...(theater?.querySelectorAll('.tk-zone[data-stage]') || [])];
    const cards = [...(theater?.querySelectorAll('.tk-zone .tk-zcard') || [])];
    return {
      ok: buckets.length === 8 && cards.length === 80
        && cards.every((card) => !!card.querySelector('.ticket-body') && !!card.dataset.id)
        && !theater.querySelector('svg.tk-flow, .tk-flow-shaft, .tk-flow-head, .tk-bars')
        && [...theater.querySelectorAll('.tk-deck-left, .tk-empty-left')].every((element) => getComputedStyle(element).display === 'none')
        && !document.querySelector('.crm-company-account, [data-crm-theater="relationships"]'),
      detail: `${cards.length} people cards / ${buckets.length} company buckets`,
    };
  });
  await check('People company buckets stay proportional to the shared card object', () => {
    const buckets = [...document.querySelectorAll('[data-crm-theater="people"] .tk-zone')];
    return buckets.length === 8 && buckets.every((bucket) => {
      const { width, height } = bucket.getBoundingClientRect();
      return width >= 180 && width <= 270 && height >= 300 && height <= 410 && width / height >= .55 && width / height <= .85;
    });
  });
  await page.evaluate(async () => { window.crmCompanyDive.setActive(true); await window.crmCompanyDive.refresh(); });
  await page.waitForFunction(() => document.querySelectorAll('.crm-company-bucket').length === 8, { timeout: 10000 });
  await check('Company-dive buckets use the same ticket-like proportions', () => {
    const buckets = [...document.querySelectorAll('.crm-company-bucket')];
    return buckets.length === 8 && buckets.every((bucket) => {
      const { width, height } = bucket.getBoundingClientRect();
      return width >= 180 && width <= 270 && height >= 280 && height <= 410 && width / height >= .55 && width / height <= .85;
    });
  });
  await page.evaluate(() => window.crmCompanyDive.setActive(false));

  const workflowRooms = { pipeline: 4, jobs: 4, money: 3 };
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
    await check(`${key} keeps stack-control logic mounted but hides its physical chrome`, () => {
      const room = document.querySelector('[data-crm-theater]:not([hidden])');
      const controls = [...room.querySelectorAll('.tk-arrow, .tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
      return controls.some((element) => element.matches('.tk-stack-btn'))
        && controls.some((element) => element.matches('.tk-deck-trash'))
        && controls.every((element) => getComputedStyle(element).display === 'none');
    });
    await check(`${key} buckets stay proportional to a ticket`, () => {
      const buckets = [...document.querySelectorAll('[data-crm-theater]:not([hidden]) .tk-zone')];
      return buckets.length > 0 && buckets.every((bucket) => {
        const { width, height } = bucket.getBoundingClientRect();
        return width >= 180 && width <= 270 && height >= 300 && height <= 410 && width / height >= .55 && width / height <= .85;
      });
    });
    await check(`${key} has no arrows in its bucket system`, () => !document.querySelector('[data-crm-theater]:not([hidden]) svg.tk-flow, [data-crm-theater]:not([hidden]) .tk-flow-shaft, [data-crm-theater]:not([hidden]) .tk-flow-head'));
  }

  await activate('cases');
  await check('Cases uses the ticket-reference screen and controls', () => ({
    ok: document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zone').length === 3
      && document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-bars').length > 0
      && !!document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-stack-btn[aria-label="Create a ticket"]')
      && !window.ticketStacks?.contract,
    detail: `${document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zone').length} reference zones`,
  }));
  await check('Cases keeps stack-control logic mounted but hides its physical chrome', () => {
    const room = document.querySelector('[data-crm-theater="tickets"]:not([hidden])');
    const controls = [...room.querySelectorAll('.tk-arrow, .tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
    return controls.some((element) => element.matches('.tk-stack-btn[aria-label="Create a ticket"]'))
      && controls.some((element) => element.matches('.tk-deck-trash'))
      && controls.every((element) => getComputedStyle(element).display === 'none');
  });
  await check('Cases buckets stay proportional to a ticket', () => {
    const buckets = [...document.querySelectorAll('[data-crm-theater="tickets"] .tk-zone')];
    return buckets.length === 3 && buckets.every((bucket) => {
      const { width, height } = bucket.getBoundingClientRect();
      return width >= 180 && width <= 270 && height >= 300 && height <= 410 && width / height >= .55 && width / height <= .85;
    });
  });
  await check('Cases has no arrows in its bucket system', () => !document.querySelector('[data-crm-theater="tickets"] svg.tk-flow, [data-crm-theater="tickets"] .tk-flow-shaft, [data-crm-theater="tickets"] .tk-flow-head'));
  const ticketCard = '[data-crm-theater="tickets"]:not([hidden]) .tk-card';
  await page.waitForSelector(ticketCard, { timeout: 10000 });
  await page.click(ticketCard);
  await page.waitForSelector('.ticket-detail', { timeout: 5000 });
  await check('Left-click runs the ticket-reference card flight and guided work screen', () => (
    !!document.querySelector('.ticket-detail-overlay:not([hidden]) .td-card')
      && !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail')
      && ['priority','assignee','description','note','activity'].every((key) => document.querySelector(`.ticket-detail .td-acc[data-sec="${key}"]`))
      && !!document.querySelector('.ticket-detail .td-edit[data-meta="title"]')
      && !!document.querySelector('.ticket-detail .td-acts .td-act[data-act="delete"]')
      && !document.querySelector('.ticket-detail .td-field, .ticket-detail .td-save')
  ));
  await page.keyboard.press('Escape');
  await sleep(520);
  await page.click(ticketCard, { button: 'right' });
  await page.waitForSelector('.tk-menu', { timeout: 5000 });
  await check('Right-click restores the complete ticket action menu', () => {
    const actions = [...document.querySelectorAll('.tk-menu .tk-menu-item')].map((item) => item.textContent.trim().toLowerCase());
    return ['edit', 'appearance', 'activity', 'move to trash'].every((label) => actions.includes(label));
  });
  await page.click('.tk-menu .tk-menu-item[data-act="edit"]');
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail', { timeout: 5000 });
  await check('Right-click edit opens that same guided ticket screen', () => (
    !!document.querySelector('.ticket-detail .td-acc[data-sec="activity"]')
      && !!document.querySelector('.ticket-detail .td-act[data-act="delete"]')
      && !document.querySelector('.ticket-detail .td-field, .ticket-detail .td-save')
  ));
  await page.keyboard.press('Escape');
  await sleep(520);

  const routedTicketTitle = await page.evaluate(async () => {
    const result = await window.tickets?.list?.();
    const ticket = result?.tickets?.[0];
    return ticket?.companyLabel || ticket?.title || '';
  });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.crm-command-shade:not([hidden]) .crm-command-input', { timeout: 5000 });
  await page.type('.crm-command-input', routedTicketTitle);
  await page.waitForSelector('.crm-command-row[data-entity="tickets"]', { timeout: 5000 });
  await page.click('.crm-command-row[data-entity="tickets"]');
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail', { timeout: 5000 });
  await check('Ticket search results route to the reference guided screen, never the generic record panel', () => (
    !!document.querySelector('.ticket-detail-overlay:not([hidden]) .td-card .ticket-body')
      && !!document.querySelector('.ticket-detail .td-acc[data-sec="activity"]')
      && !document.querySelector('.record-world-shell:not([hidden])')
  ));
  await page.keyboard.press('Escape');
  await sleep(520);

  await activate('calendar');
  await page.evaluate(() => document.querySelector('.fc-month[data-month="7"]')?.click());
  await sleep(700);
  await check('Calendar is fed only by commitments', () => {
    const chips = [...document.querySelectorAll('[data-crm-theater="calendar"] .fc-chip[data-type]')];
    return chips.length > 0 && chips.every((chip) => chip.dataset.type === 'commitment');
  });
  await check('Calendar day cells and chips retain their lightweight native renderer', () => {
    const days = [...document.querySelectorAll('[data-crm-theater="calendar"] .fc-day')];
    const details = [...document.querySelectorAll('[data-crm-theater="calendar"] .fc-chip, [data-crm-theater="calendar"] .fc-empty, [data-crm-theater="calendar"] .fc-day-detail')];
    const isLightweight = (element) => {
      const style = getComputedStyle(element);
      return !element.classList.contains('crm-config-surface')
        && !element.classList.contains('crm-config-item')
        && (style.backdropFilter === 'none' || style.backdropFilter === '');
    };
    return days.length > 300 && days.every(isLightweight) && details.every(isLightweight);
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
  const completedId = await page.$eval('.crm-desk-surface:not([hidden]) .crm-desk-commitment', (el) => el.dataset.commitmentId);
  await page.evaluate((id) => { window.__completedCommitmentId = id; }, completedId);
  await page.click('.crm-desk-surface:not([hidden]) .crm-desk-check');
  await page.waitForFunction((count) => document.querySelectorAll('.crm-desk-commitment').length === count - 1, { timeout: 5000 }, before);
  await check('Completing a commitment removes it from the open Desk', () => document.querySelectorAll('.crm-desk-commitment').length === 3);
  await activate('home');
  await page.waitForFunction((id) => !window.crmHome?.handStatus?.().ids.includes(id)
    && document.querySelectorAll('.crm-home-hand-card.tk-card').length === window.crmHome?.handStatus?.().count, { timeout: 10000 }, completedId);
  await check('The Home hand tracks live priority changes', () => !window.crmHome.handStatus().ids.includes(window.__completedCommitmentId));
  await page.hover('.crm-home-hand-trigger');
  await sleep(420);
  await page.evaluate(() => {
    const card = document.querySelector('.crm-home-hand-card.tk-card');
    window.__priorityEntity = String(card?.dataset.recordEntity || '').toLowerCase();
  });
  await page.click('.crm-home-hand-card.tk-card');
  await page.waitForFunction(() => !!document.querySelector('.record-world-shell:not([hidden]), .ticket-detail-overlay:not([hidden]) .ticket-detail'), { timeout: 5000 });
  await check('A priority card opens its entity-native record screen', () => {
    const ticket = ['ticket', 'tickets', 'case', 'cases'].includes(window.__priorityEntity);
    return ticket
      ? !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail') && !document.querySelector('.record-world-shell:not([hidden])')
      : !!document.querySelector('.record-world-shell:not([hidden]) .record-world-title');
  });
  await page.keyboard.press('Escape');
  await check('No renderer exceptions during the complete scenario', () => true);

  if (errors.length) { console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`); failures++; }
  console.log(`\nInteraction contract: ${failures ? `${failures} failure(s)` : 'PASSED'}.`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
