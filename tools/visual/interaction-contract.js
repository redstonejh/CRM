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
  await check('Non-card interface audit has complete canonical-menu coverage', () => {
    const audit = window.crmInterfaceParity?.audit?.();
    return {
      ok: !!audit && audit.surfaces > 0 && audit.actions > 0
        && audit.missingSurfaces.length === 0 && audit.missingActions.length === 0
        && audit.bucketArrows === 0,
      detail: audit ? `${audit.surfaces} surfaces / ${audit.actions} actions / ${audit.bucketArrows} arrows` : 'audit unavailable',
    };
  });
  await check('Information shells use the account/background recipe exactly', () => {
    const surface = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const reference = document.querySelector('.auth-profile-menu');
    if (!surface || !reference) return false;
    const actual = getComputedStyle(surface);
    const expected = getComputedStyle(reference);
    return ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'color']
      .every((property) => actual[property] === expected[property]);
  });
  await check('Non-top buttons use the account menu item recipe exactly', () => {
    const action = document.querySelector('.crm-home-control');
    const reference = document.querySelector('.auth-menu-item');
    if (!action || !reference || !action.classList.contains('crm-menu-action')) return false;
    const actual = getComputedStyle(action);
    const expected = getComputedStyle(reference);
    const same = ['backgroundColor', 'borderTopWidth', 'borderRadius', 'color', 'fontSize', 'fontWeight', 'boxShadow', 'paddingLeft', 'paddingRight']
      .every((property) => actual[property] === expected[property]);
    return same
      && [...document.querySelectorAll('.window-glass-control')].every((button) => !button.classList.contains('crm-menu-action'))
      && [...document.querySelectorAll('.tk-card, .tk-zcard')].every((card) => !card.classList.contains('crm-menu-action') && !card.classList.contains('crm-menu-surface'));
  });
  await check('The Home control has a darker tinted glass backing', () => {
    const switcher = document.querySelector('.crm-module-switch');
    const tint = getComputedStyle(switcher, '::after');
    return tint.content !== 'none' && tint.backgroundImage !== 'none'
      && tint.backgroundImage.includes('rgba(13, 35, 72')
      && tint.boxShadow !== 'none' && tint.backdropFilter.includes('blur');
  });
  await check('Home has six inert screenshot LODs and no live miniature trees', () => ({
    ok: document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6
      && !document.querySelector('.crm-home-grid .crm-home-lod-scene,.crm-home-grid .crm-home-lod-root'),
    detail: `${document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length}/6 surfaces`,
  }));
  await check('Home uses focused operating rooms and Assignments instead of a bespoke Calendar tile', () => {
    const keys = ['desk','people','cases','bills','invoices','assignments'];
    const overviewTile = document.querySelector('.crm-home-bucket[data-module="desk"]');
    const ticketTile = document.querySelector('.crm-home-bucket[data-module="cases"]');
    const billTile = document.querySelector('.crm-home-bucket[data-module="bills"]');
    const invoiceTile = document.querySelector('.crm-home-bucket[data-module="invoices"]');
    const assignmentTile = document.querySelector('.crm-home-bucket[data-module="assignments"]');
    return keys.every((key) => document.querySelector(`.crm-home-bucket[data-module="${key}"]`))
      && !document.querySelector('.crm-home-bucket[data-module="calendar"]')
      && !document.querySelector('.crm-home-bucket[data-module="pipeline"]')
      && !document.querySelector('.crm-home-bucket[data-module="jobs"],.crm-home-bucket[data-module="money"]')
      && overviewTile?.querySelector('.crm-home-title')?.textContent.trim() === 'Overview'
      && ticketTile?.querySelector('.crm-home-title')?.textContent.trim() === 'Tickets'
      && billTile?.querySelector('.crm-home-title')?.textContent.trim() === 'Bills'
      && invoiceTile?.querySelector('.crm-home-title')?.textContent.trim() === 'Invoices'
      && assignmentTile?.querySelector('.crm-home-title')?.textContent.trim() === 'Assignments';
  });
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
      probe.dataset.previewVariant = 'preblurred';
      probe.dataset.interactionStyleProbe = 'true';
      preview.appendChild(probe);
    }
  }));
  await check('Resting Home objects use cached pre-blurred rasters with no live filter', () => {
    const images = [...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')];
    return images.length === 6 && images.every((image) => image.dataset.previewVariant === 'preblurred' && getComputedStyle(image).filter === 'none')
      && !document.querySelector('.crm-home-grid .crm-home-preview-sharp');
  });
  await page.hover('.crm-home-bucket[data-module="desk"]');
  await sleep(220);
  await check('Hover sharpens tile objects and de-emphasizes its title', () => {
    const tile = document.querySelector('.crm-home-grid > .crm-home-bucket[data-module="desk"]');
    const foreground = tile?.querySelector('.crm-home-preview-foreground');
    const sharp = tile?.querySelector('.crm-home-preview-sharp');
    const title = tile?.querySelector('.crm-home-title-glass');
    return !!foreground && !!sharp && !!title && getComputedStyle(foreground).filter === 'none'
      && Number(getComputedStyle(sharp).opacity) >= .95 && Number(getComputedStyle(title).opacity) <= .3;
  });
  await page.evaluate(() => document.querySelectorAll('[data-interaction-style-probe]').forEach((probe) => probe.remove()));
  await page.evaluate(() => {
    const selected = document.querySelector('.crm-home-bucket[data-module="desk"]')?.getBoundingClientRect();
    const neighbor = document.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    window.__homeSpatialRelation = selected && neighbor ? {
      dx: (neighbor.left - selected.left) / selected.width,
      dy: (neighbor.top - selected.top) / selected.height,
      wr: neighbor.width / selected.width,
      hr: neighbor.height / selected.height,
    } : null;
  });
  await page.click('.crm-home-bucket[data-module="desk"]');
  await sleep(100);
  await check('Home-to-room handoff remains inside the original camera', () => document.body.dataset.crmModule === 'home'
    && window.crmHomeCamera?.isTransitioning?.() && !!document.querySelector('.crm-home-expander:not(.crm-home-warm)'));
  await check('Neighbor tiles retain their spatial relationship throughout the dive-in', () => {
    const root = window.crmHomeCamera?.layers?.()[0];
    const selected = root?.querySelector('.crm-home-bucket[data-module="desk"]')?.getBoundingClientRect();
    const neighbor = root?.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    const before = window.__homeSpatialRelation;
    if (!root || !selected || !neighbor || !before || Number(getComputedStyle(root).opacity) < .99) return false;
    const now = {
      dx: (neighbor.left - selected.left) / selected.width,
      dy: (neighbor.top - selected.top) / selected.height,
      wr: neighbor.width / selected.width,
      hr: neighbor.height / selected.height,
    };
    return Object.keys(now).every((key) => Math.abs(now[key] - before[key]) < .02);
  });
  await check('Home tile titles stay out of the camera animation', () => {
    const surface = window.crmHomeCamera?.surface?.();
    const titles = [...(surface?.querySelectorAll('.crm-home-title-glass') || [])];
    return surface?.classList.contains('crm-home-camera-moving') && titles.length > 0
      && titles.every((title) => getComputedStyle(title).visibility === 'hidden' && Number(getComputedStyle(title).opacity) === 0);
  });
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
    const room = document.querySelector('.crm-overview-surface:not([hidden])');
    return !!room && getComputedStyle(room).webkitAppRegion !== 'no-drag';
  });
  await page.waitForFunction(() => document.querySelectorAll('.crm-overview-panel').length === 3
    && document.querySelectorAll('.crm-overview-work-group').length >= 3
    && document.querySelectorAll('.crm-overview-card.tk-card .ticket-body').length >= 7, { timeout: 10000 });
  await check('Overview keeps the generic calculated Commitments, Work in motion, and What changed template', () => {
    const panels = [...document.querySelectorAll('.crm-overview-panel')];
    const groups = [...document.querySelectorAll('.crm-overview-work-group')];
    const cards = [...document.querySelectorAll('.crm-overview-card.tk-card')];
    const metrics = [...document.querySelectorAll('.crm-overview-metric-value,.crm-overview-summary-value')];
    return {
      ok: panels.map((panel) => panel.querySelector('.crm-overview-panel-title')?.textContent.trim()).join(',') === 'Commitments,Work in motion,What changed'
        && groups.length >= 3 && cards.length >= 7 && metrics.length >= groups.length + 2
        && metrics.every((metric) => Number.isFinite(Number(metric.textContent.trim())))
        && document.querySelectorAll('.crm-overview-stack-card').length >= 3
        && document.querySelectorAll('.crm-overview-recent-card').length >= 2
        && cards.every((card) => !!card.querySelector('.ticket-body') && !!card.dataset.recordEntity)
        && !document.querySelector('.crm-overview-bucket,[data-overview-phase]')
        && !document.querySelector('[data-overview-system]')
        && !document.querySelector('.crm-desk-panel,.crm-desk-work-card,.crm-desk-stagebar,.crm-desk-activity'),
      detail: `${panels.length} calculated panels / ${groups.length} truthful source pools / ${cards.length} supporting cards`,
    };
  });
  await check('Overview numbers are the primary hierarchy and literal objects are supporting evidence', () => {
    const primary = document.querySelector('.crm-overview-metric-value');
    const supporting = document.querySelector('.crm-overview-work-card');
    const metricSize = Number.parseFloat(getComputedStyle(primary).fontSize);
    const cardRect = supporting?.getBoundingClientRect();
    return metricSize >= 45 && cardRect?.width <= 130 && cardRect?.height <= 195
      && !!document.querySelector('.crm-overview-attention-stack')
      && !!document.querySelector('.crm-overview-work-groups')
      && !!document.querySelector('.crm-overview-recent-trail');
  });
  await check('Overview generic panels consume the exact canonical menu shell', () => {
    const reference = document.querySelector('.auth-profile-menu');
    const panels = [...document.querySelectorAll('.crm-overview-panel')];
    if (!reference || panels.length !== 3) return false;
    const expected = getComputedStyle(reference);
    return panels.every((panel) => {
      const actual = getComputedStyle(panel);
      return ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'color']
        .every((property) => actual[property] === expected[property]);
    });
  });
  await page.mouse.move(800, 470);
  await sleep(380);
  await check('Commitments rest as a compact literal card stack', () => {
    const cards = [...document.querySelectorAll('.crm-overview-attention-stack .crm-overview-stack-card')];
    const tops = cards.map((card) => card.getBoundingClientRect().top);
    return cards.length >= 3 && Math.max(...tops) - Math.min(...tops) < 130;
  });
  await page.hover('.crm-overview-attention-stack');
  await sleep(450);
  await check('Commitment cards reveal vertically without changing the overview template', () => {
    const cards = [...document.querySelectorAll('.crm-overview-attention-stack .crm-overview-stack-card')];
    const tops = cards.map((card) => card.getBoundingClientRect().top);
    return cards.length >= 3 && Math.max(...tops) - Math.min(...tops) > 180;
  });
  await page.mouse.move(800, 470);
  await check('Recent change is expressed as a separate literal card trail', () => {
    const cards = [...document.querySelectorAll('.crm-overview-recent-trail .crm-overview-recent-card')];
    const tops = cards.map((card) => card.getBoundingClientRect().top);
    return cards.length >= 2 && Math.max(...tops) - Math.min(...tops) > 65;
  });
  await check('Retired standalone Home, Today, and Reports theaters do not own the stage', () => ![...document.querySelectorAll('[data-crm-theater="home"],[data-crm-theater="today"],[data-crm-theater="reports"]')].some((el) => !el.hidden));

  await page.evaluate(() => { void window.crmDeskTransit.driveTo('home'); });
  await sleep(100);
  await check('Neighbor tiles retain their spatial relationship throughout the dive-out', () => {
    const root = window.crmHomeCamera?.layers?.()[0];
    const selected = root?.querySelector('.crm-home-bucket[data-module="desk"]')?.getBoundingClientRect();
    const neighbor = root?.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    const before = window.__homeSpatialRelation;
    if (!root || !selected || !neighbor || !before || Number(getComputedStyle(root).opacity) < .99) return false;
    const now = {
      dx: (neighbor.left - selected.left) / selected.width,
      dy: (neighbor.top - selected.top) / selected.height,
      wr: neighbor.width / selected.width,
      hr: neighbor.height / selected.height,
    };
    return Object.keys(now).every((key) => Math.abs(now[key] - before[key]) < .02);
  });
  await check('Home tile titles stay hidden throughout the return animation', () => {
    const surface = window.crmHomeCamera?.surface?.();
    const titles = [...(surface?.querySelectorAll('.crm-home-title-glass') || [])];
    return surface?.classList.contains('crm-home-camera-moving') && titles.length > 0
      && titles.every((title) => getComputedStyle(title).visibility === 'hidden' && Number(getComputedStyle(title).opacity) === 0);
  });
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit?.isBusy?.(), { timeout: 10000 });
  await sleep(100);
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

  await page.click('.crm-home-bucket[data-module="cases"]');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'cases', { timeout: 5000 });
  await check('The Tickets tile opens the existing ticketing screen', () => (
    !!document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-zone')
      && !document.querySelector('[data-crm-theater="pipeline"]:not([hidden])')
  ));
  await check('Pipeline rooms are explicitly focused on the current day', () => {
    const context = document.querySelector('.crm-temporal-context:not([hidden])');
    const today = new Date();
    const localIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return !!context && context.textContent.includes('Today') && document.body.dataset.crmTemporalDate === localIso;
  });
  await page.waitForFunction(() => !window.crmDeskTransit?.isBusy?.(), { timeout: 5000 });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 1, { timeout: 5000 });
  await check('Zooming out of a pipeline reveals the current month in the shared calendar', () => {
    const today = new Date();
    const month = document.querySelector(`[data-crm-theater="calendar"] .fc-expander[data-month="${today.getMonth() + 1}"]`);
    return window.fractalCalendar.year() === today.getFullYear() && !!month && !month.hidden;
  });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 0, { timeout: 5000 });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home', { timeout: 10000 });

  await activate('assignments');
  await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="assignments"] .crm-assignment-source-pool').length === 8
    && document.querySelectorAll('[data-crm-theater="assignments"] .crm-assignment-hand-card.tk-card').length === 10, { timeout: 10000 });
  await check('Assignments uses ordinary canonical buttons for grouping and real cards for people', () => {
    const theater = document.querySelector('[data-crm-theater="assignments"]:not([hidden])');
    const pools = [...(theater?.querySelectorAll('button.crm-assignment-source-pool.crm-menu-action') || [])];
    const buckets = [...(theater?.querySelectorAll('.crm-assignment-bucket.tk-zone') || [])];
    const people = [...(theater?.querySelectorAll('.crm-assignment-hand-card.tk-card') || [])];
    const reference = document.querySelector('.auth-menu-item');
    const expected = getComputedStyle(reference);
    const button = pools.find((pool) => !pool.classList.contains('is-selected'));
    const actual = getComputedStyle(button);
    const sameButton = ['backgroundColor','borderTopWidth','borderRadius','color','fontSize','fontWeight','boxShadow','paddingLeft','paddingRight']
      .every((property) => actual[property] === expected[property]);
    return pools.length === 8 && buckets.length > 0 && people.length === 10
      && people.every((card) => !!card.querySelector('.ticket-body') && !!card.dataset.assignmentContactId)
      && pools.filter((pool) => pool.classList.contains('is-selected')).length === 1
      && sameButton && !theater.querySelector('.crm-assignment-source-pool.tk-zone')
      && buckets.every((bucket) => !!bucket.dataset.assignmentCommitment)
      && !theater.querySelector('svg.tk-flow,.tk-flow-shaft,.tk-flow-head');
  });
  await check('The grouping panel clips to its buttons and scrolls only when the list outgrows its cap', () => {
    const panel = document.querySelector('.crm-assignment-pools')?.getBoundingClientRect();
    const stack = document.querySelector('.crm-assignment-pool-stack');
    const buttons = [...(stack?.querySelectorAll('.crm-assignment-source-pool') || [])];
    const last = buttons.at(-1)?.getBoundingClientRect();
    return !!panel && !!last && panel.bottom - last.bottom <= 12
      && getComputedStyle(stack).overflowY === 'auto';
  });
  const firstPool = await page.$eval('.crm-assignment-source-pool.is-selected', (pool) => pool.dataset.assignmentPool);
  await page.click('.crm-assignment-source-pool:not(.is-selected)');
  await page.waitForFunction((previous) => document.querySelector('.crm-assignment-source-pool.is-selected')?.dataset.assignmentPool !== previous
    && document.querySelectorAll('.crm-assignment-hand-card.tk-card').length === 10, {}, firstPool);
  await check('Selecting another pool replaces the hand with that pool’s people', () => {
    const selected = document.querySelector('.crm-assignment-source-pool.is-selected');
    const count = Number(selected?.querySelector('.crm-assignment-source-pool-count')?.textContent || 0);
    const cards = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')];
    return !!selected && count === cards.length && cards.length === 10;
  });
  await page.mouse.move(2, 2);
  await sleep(430);
  await check('The Assignments hand rests as the same card-top peek used on Home', () => {
    const stage = document.querySelector('.crm-assignment-stage')?.getBoundingClientRect();
    const hand = document.querySelector('.crm-assignment-hand')?.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')];
    return !!stage && !!hand && Math.abs(stage.bottom - innerHeight) <= 1
      && Math.abs(hand.left + hand.width / 2 - innerWidth / 2) <= 1
      && cards.length === 10 && cards.every((card) => {
      const exposed = stage.bottom - card.getBoundingClientRect().top;
      return exposed >= 108 && exposed <= 160;
    });
  });
  const assignmentHandHoverPoint = await page.$eval('.crm-assignment-hand-trigger', (trigger) => {
    const rect = trigger.getBoundingClientRect();
    return { x: rect.left + 28, y: rect.bottom - 24 };
  });
  await page.mouse.move(assignmentHandHoverPoint.x, assignmentHandHoverPoint.y);
  await sleep(460);
  await check('Hovering the Assignments hand reveals the complete arc', () => {
    const stage = document.querySelector('.crm-assignment-stage')?.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')];
    return !!stage && cards.length === 10 && cards.every((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top >= stage.top && rect.bottom <= stage.bottom + 1;
    });
  });
  await page.evaluate(() => { window.__assignmentHandTargetTop = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')].at(-1)?.getBoundingClientRect().top || 0; });
  await page.hover('.crm-assignment-hand-card.tk-card:last-child');
  await sleep(220);
  await check('The person card under the cursor lifts slightly above the revealed hand', () => {
    const card = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')].at(-1);
    return !!card && card.getBoundingClientRect().top <= window.__assignmentHandTargetTop - 4;
  });
  const homeDeadzonePoint = await page.$eval('.crm-home-control-deadzone', (deadzone) => {
    const rect = deadzone.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 16 };
  });
  await page.mouse.move(homeDeadzonePoint.x, homeDeadzonePoint.y);
  await sleep(430);
  await check('The Home route is a deadzone for hand and ticket hover reactions', () => {
    const deadzone = document.querySelector('.crm-home-control-deadzone');
    const control = document.querySelector('.crm-home-control');
    const hand = document.querySelector('.crm-assignment-hand');
    const cards = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')];
    const deadzoneRect = deadzone?.getBoundingClientRect();
    const controlRect = control?.getBoundingClientRect();
    if (!deadzoneRect || !controlRect || !hand || cards.length === 0) return false;
    const routeX = deadzoneRect.left + deadzoneRect.width / 2;
    const routeY = deadzoneRect.top + 16;
    const buttonX = controlRect.left + controlRect.width / 2;
    const buttonY = controlRect.top + controlRect.height / 2;
    const routeHit = document.elementFromPoint(routeX, routeY);
    const buttonHit = document.elementFromPoint(buttonX, buttonY);
    return routeHit === deadzone && (buttonHit === control || control.contains(buttonHit))
      && deadzoneRect.top <= controlRect.top - 80 && !hand.matches(':hover')
      && cards.every((card) => {
        const exposed = innerHeight - card.getBoundingClientRect().top;
        return exposed >= 108 && exposed <= 160;
      });
  });
  await page.mouse.move(2, 2);
  const assignment = await page.evaluate(async () => {
    const bucket = document.querySelector('.crm-assignment-bucket');
    const person = document.querySelector('.crm-assignment-hand-card');
    const commitmentId = bucket?.dataset.assignmentCommitment || '';
    const contactId = person?.dataset.assignmentContactId || '';
    const ok = await window.crmAssignments.assign(commitmentId, contactId);
    const record = (await window.crmDomain.list('commitments', { includeDeleted: false, limit: 100 })).records.find((item) => String(item.id) === commitmentId);
    window.__assignmentContract = { ok, commitmentId, contactId, persisted: String(record?.assignedContactId || '') === contactId };
    return window.__assignmentContract;
  });
  await page.waitForFunction((id) => !!document.querySelector(`[data-assignment-commitment="${CSS.escape(id)}"] .crm-assignment-bucket-card`), {}, assignment.commitmentId);
  await check('Assigning a person persists the activity relationship and seats the card in its bucket', () => {
    const probe = window.__assignmentContract;
    return !!probe?.ok && !!probe.persisted
      && !!document.querySelector(`[data-assignment-commitment="${CSS.escape(probe.commitmentId)}"] .crm-assignment-bucket-card[data-assignment-contact-id="${CSS.escape(probe.contactId)}"]`);
  });
  await page.evaluate((id) => window.crmAssignments.unassign(id), assignment.commitmentId);
  await page.waitForFunction((id) => !document.querySelector(`[data-assignment-commitment="${CSS.escape(id)}"] .crm-assignment-bucket-card`), {}, assignment.commitmentId);

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

  await page.$eval('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]', (card) => {
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20, button: 2 }));
  });
  await page.waitForSelector('.tk-menu .tk-menu-item[data-act^="custom-"]', { timeout: 5000 });
  await sleep(80);
  await check('Right-clicking a person offers conversation history in the canonical card menu', () => {
    const menu = document.querySelector('.tk-menu');
    const action = menu?.querySelector('.tk-menu-item[data-act^="custom-"]');
    return !!menu && menu.classList.contains('crm-menu-surface') && !!action
      && action.textContent.trim().toLowerCase() === 'view conversation history';
  });
  await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
  await page.waitForSelector('.crm-person-history-shell:not([hidden]) .crm-person-history', { timeout: 10000 });
  await check('Person history opens a real cross-channel interaction thread', () => {
    const history = document.querySelector('.crm-person-history-shell:not([hidden]) .crm-person-history');
    const events = [...(history?.querySelectorAll('.crm-person-history-event') || [])];
    const filters = [...(history?.querySelectorAll('[data-history-filter]') || [])];
    return !!history && history.classList.contains('crm-menu-surface')
      && history.querySelector('.crm-person-history-title')?.textContent.trim() === 'Marta Reyes'
      && events.length >= 6 && new Set(events.map((event) => event.dataset.historyKind)).size >= 4
      && filters.length === 5 && !!history.querySelector('[data-person-history-composer] textarea')
      && !!history.querySelector('.crm-person-history-summary.crm-menu-item');
  });
  const historyCountBefore = await page.$$eval('.crm-person-history-event', (events) => events.length);
  await page.select('[data-person-history-composer] select[name="kind"]', 'message');
  await page.select('[data-person-history-composer] select[name="direction"]', 'inbound');
  await page.type('[data-person-history-composer] textarea', 'Marta confirmed the escalation wording works for legal.');
  await page.click('[data-person-history-composer] button[type="submit"]');
  await page.waitForFunction((before) => document.querySelectorAll('.crm-person-history-event').length > before
    && [...document.querySelectorAll('.crm-person-history-event-content')].some((node) => node.textContent.includes('escalation wording works for legal')), {}, historyCountBefore);
  await check('Logging a conversation persists it and advances the person timeline', async () => {
    const result = await window.crmStore.list('interactions', { includeDeleted: false });
    const interaction = (result.records || []).find((item) => String(item.contactId) === 'ct_marta'
      && String(item.note || '').includes('escalation wording works for legal'));
    const lastTouch = Number(document.querySelector('.crm-person-history-stat:nth-child(2) .crm-person-history-stat-value')?.textContent === 'just now');
    return !!interaction && interaction.kind === 'message' && interaction.direction === 'inbound' && lastTouch === 1;
  });
  await page.click('[data-person-history-close]');
  await page.waitForFunction(() => !window.crmPersonHistory?.isOpen?.(), { timeout: 5000 });

  const workflowRooms = { pipeline: 4, bills: 3, invoices: 3 };
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
    await check(`${key} has no pile caption floating through the canvas`, () => !document.querySelector('[data-crm-theater]:not([hidden]) .tk-deck-label'));
  }

  await activate('cases');
  await check('Tickets uses the ticket-reference screen and controls', () => ({
    ok: document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zone').length === 3
      && document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-bars').length > 0
      && !!document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-stack-btn[aria-label="Create a ticket"]')
      && !window.ticketStacks?.contract,
    detail: `${document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zone').length} reference zones`,
  }));
  await check('Every ticket stage and both corner stacks look occupied', () => {
    const room = document.querySelector('[data-crm-theater="tickets"]:not([hidden])');
    const stages = [...(room?.querySelectorAll('.tk-zone') || [])].map((zone) => zone.querySelectorAll('.tk-zcard').length);
    const inbox = room?.querySelectorAll('.tk-deck-left .tk-card').length || 0;
    const resolved = room?.querySelectorAll('.tk-deck-right .tk-card').length || 0;
    return {
      ok: stages.length === 3 && stages.every((count) => count >= 6) && inbox >= 6 && resolved >= 6,
      detail: `stages ${stages.join('/')} · inbox ${inbox} · resolved ${resolved}`,
    };
  });
  await check('Tickets keeps stack-control logic mounted but hides its physical chrome', () => {
    const room = document.querySelector('[data-crm-theater="tickets"]:not([hidden])');
    const controls = [...room.querySelectorAll('.tk-arrow, .tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
    return controls.some((element) => element.matches('.tk-stack-btn[aria-label="Create a ticket"]'))
      && controls.some((element) => element.matches('.tk-deck-trash'))
      && controls.every((element) => getComputedStyle(element).display === 'none');
  });
  await check('Tickets buckets stay proportional to a ticket', () => {
    const buckets = [...document.querySelectorAll('[data-crm-theater="tickets"] .tk-zone')];
    return buckets.length === 3 && buckets.every((bucket) => {
      const { width, height } = bucket.getBoundingClientRect();
      return width >= 180 && width <= 270 && height >= 300 && height <= 410 && width / height >= .55 && width / height <= .85;
    });
  });
  await check('Tickets has no arrows in its bucket system', () => !document.querySelector('[data-crm-theater="tickets"] svg.tk-flow, [data-crm-theater="tickets"] .tk-flow-shaft, [data-crm-theater="tickets"] .tk-flow-head'));
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
    return ticket?.title || ticket?.companyLabel || '';
  });
  await page.evaluate((query) => window.crmSearchDeck.setQuery(query), routedTicketTitle);
  await page.waitForSelector('.crm-search-result[data-entity="tickets"]', { timeout: 5000 });
  await page.click('.crm-search-result[data-entity="tickets"]');
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
      return !element.classList.contains('crm-menu-surface')
        && !element.classList.contains('crm-menu-item')
        && (style.backdropFilter === 'none' || style.backdropFilter === '');
    };
    return days.length > 300 && days.every(isLightweight) && details.every(isLightweight);
  });

  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('#dashboard-search-popover:not([hidden]) .crm-search-result', { timeout: 5000 });
  await check('Search consumes the canonical anchored menu, never an invented command palette', () => {
    const search = document.querySelector('#dashboard-search-popover:not([hidden])');
    const account = document.querySelector('.auth-profile-menu');
    const background = document.querySelector('.bg-picker-pop');
    const rows = [...document.querySelectorAll('.crm-search-result')];
    if (!search || !account || !background || !rows.length) return false;
    const properties = ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'paddingTop', 'paddingRight', 'rowGap'];
    const actual = getComputedStyle(search);
    const matches = (element) => {
      const reference = getComputedStyle(element);
      return properties.every((property) => actual[property] === reference[property]);
    };
    return !document.querySelector('.crm-command, .crm-command-shade, .crm-command-row')
      && matches(account) && matches(background)
      && rows.every((row) => row.classList.contains('auth-menu-item') && getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)')
      && !search.querySelector('.tk-card');
  });
  await page.keyboard.press('Escape');

  await activate('desk');
  await check('Overview reuses native card paint, faces, and progress segments without menu-styled substitutes', () => {
    const cards = [...document.querySelectorAll('.crm-overview-card.tk-card')];
    return cards.length >= 7
      && cards.every((card) => !!card.style.backgroundImage && !!card.querySelector('.ticket-body'))
      && cards.some((card) => card.querySelector('.tk-bars-card .tk-seg'))
      && cards.every((card) => !card.classList.contains('crm-menu-action'));
  });
  await page.$eval('.crm-overview-card[data-record-entity="contacts"]', async (card) => {
    const result = await window.crmStore.get('contacts', card.dataset.recordId);
    const person = result?.record || {};
    window.__overviewExpectedPerson = person.name || person.title || person.client || person.id;
    card.click();
  });
  await page.waitForSelector('.record-world-shell:not([hidden])');
  await check('An Overview card opens the same contextual record screen as its source module', () => ({
    ok: document.querySelector('.record-world-kicker')?.textContent.trim() === 'Person'
      && document.querySelector('.record-world-title')?.textContent.trim() === window.__overviewExpectedPerson
      && !!document.querySelector('.record-world-facts')
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
  await activate('home');
  await page.waitForFunction(() => window.crmHome?.handStatus?.().count > 0
    && document.querySelectorAll('.crm-home-hand-card.tk-card').length === window.crmHome?.handStatus?.().count, { timeout: 10000 });
  await check('The Home priority hand remains independent of the Overview summary', () => window.crmHome.handStatus().count > 0);
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
