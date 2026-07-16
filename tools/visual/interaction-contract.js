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
  const check = async (name, fn, arg) => {
    let result; let ok = false;
    try { result = await page.evaluate(fn, arg); ok = result === true || result?.ok === true; } catch (error) { result = { detail: error.message }; }
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
  await check('Home tiles use the canonical glass without the menu shadow rectangle', () => {
    const surface = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const reference = document.querySelector('.auth-profile-menu');
    if (!surface || !reference) return false;
    const actual = getComputedStyle(surface);
    const expected = getComputedStyle(reference);
    return ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'color']
      .every((property) => actual[property] === expected[property])
      && actual.boxShadow !== expected.boxShadow && !actual.boxShadow.includes('42px');
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
  await check('Home combines money and makes room for Planner', () => {
    const keys = ['desk','people','cases','money','planner','assignments'];
    const title = (key) => document.querySelector(`.crm-home-title-layer > .crm-home-title-slot[data-module="${key}"] .crm-home-title`);
    return keys.every((key) => document.querySelector(`.crm-home-bucket[data-module="${key}"]`))
      && !document.querySelector('.crm-home-bucket[data-module="calendar"]')
      && !document.querySelector('.crm-home-bucket[data-module="pipeline"]')
      && !document.querySelector('.crm-home-bucket[data-module="jobs"],.crm-home-bucket[data-module="bills"],.crm-home-bucket[data-module="invoices"]')
      && title('desk')?.textContent.trim() === 'Overview'
      && title('cases')?.textContent.trim() === 'Tickets'
      && title('money')?.textContent.trim() === 'Money'
      && title('planner')?.textContent.trim() === 'Planner'
      && title('assignments')?.textContent.trim() === 'Assignments';
  });
  await check('Home tile titles use a sharp live type layer', () => {
    const titles = [...document.querySelectorAll('.crm-home-title-layer > .crm-home-title-slot .crm-home-title')];
    return titles.length === 6 && titles.every((title) => {
      const style = getComputedStyle(title);
      return style.fontSize === '15px' && style.fontWeight === '600'
        && style.fontFamily.includes('Segoe UI Variable Text') && !style.textShadow.includes('12px')
        && !title.closest('.crm-home-bucket');
    }) && getComputedStyle(document.querySelector('.crm-home-level')).willChange === 'auto';
  });
  await check('Home has a visible progressive state while previews prepare', () => {
    const states = [...document.querySelectorAll('.crm-home-grid .crm-home-preview-state[role="status"]')];
    return states.length === 6 && states.every((state) => state.textContent.trim() === 'Preparing view'
      && getComputedStyle(state).visibility === 'visible' && Number(getComputedStyle(state).opacity) === 1);
  });
  await page.waitForFunction(() => window.crmHome?.handStatus?.().count > 0 && document.querySelectorAll('.crm-home-hand-card.tk-card').length > 0, { timeout: 10000 });
  await check('Home hand uses card-system card objects', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card')];
    return cards.length > 0 && cards.every((card) => card.matches('.tk-card.tk-card-today') && !!card.querySelector('.ticket-body'))
      && !document.querySelector('.crm-home-priority-card');
  });
  await page.click('.crm-home-todo-add');
  await page.waitForSelector('.crm-home-todo-popover.crm-menu-surface', { timeout:10000 });
  await check('Home exposes a compact linked to-do composer', () => {
    const form = document.querySelector('.crm-home-todo-popover.crm-menu-surface');
    return !!form && !!form.elements.title && !!form.elements.dueAt && !!form.elements.priority
      && !!form.querySelector('optgroup[label="Pipeline cards"]')
      && [...form.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'));
  });
  await page.click('[data-todo-cancel]');
  const linkedHomeTodo = await page.evaluate(async () => {
    const task = (await window.crmStore.list('tasks', { includeDeleted:false })).records?.[0];
    if (!task) return null;
    const record = await window.crmHome.createTodo({ title:'Home linked to-do contract', priority:'urgent', dueAt:new Date().toISOString(), link:{ entityType:'tasks', recordId:task.id } });
    return record ? { id:record.id, taskId:task.id } : null;
  });
  if (!linkedHomeTodo) throw new Error('Could not create linked Home to-do contract record');
  await page.waitForFunction((id) => !!document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(id)}"]`), { timeout:10000 }, linkedHomeTodo.id);
  await check('Home hand is the persistent linked to-do list', (todo) => {
    const toolbar = document.querySelector('.crm-home-todo-toolbar');
    const cards = [...document.querySelectorAll('.crm-home-hand-card')];
    const created = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.id)}"]`);
    return toolbar?.querySelector('.crm-home-todo-label')?.textContent.trim() === 'To do'
      && cards.length > 0 && cards.every((card) => card.dataset.commitmentId && !card.dataset.commitmentId.startsWith('signal:'))
      && created?.dataset.recordEntity === 'tasks' && created?.dataset.recordId === todo.taskId;
  }, linkedHomeTodo);
  await check('Home reserves room for a curved priority hand', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card.tk-card')];
    const grid = document.querySelector('.crm-home-grid')?.getBoundingClientRect();
    const rotations = new Set(cards.map((card) => card.style.getPropertyValue('--hand-rot')));
    const positions = new Set(cards.map((card) => card.style.getPropertyValue('--hand-x')));
    const visible = cards.map((card) => innerHeight - card.getBoundingClientRect().top);
    const peeking = visible.every((value) => value >= 110 && value <= 170);
    return { ok:cards.length > 0 && cards.length <= 7 && rotations.size > 1 && positions.size === cards.length && peeking && grid?.bottom < innerHeight - 145,
      detail:JSON.stringify({ count:cards.length, rotations:rotations.size, positions:positions.size, visible, gridBottom:grid?.bottom,
        gridInline:document.querySelector('.crm-home-grid')?.getAttribute('style'), viewport:[innerWidth,innerHeight], scrollY,
        level:window.crmHomeCamera?.level?.(), moving:window.crmHomeCamera?.isTransitioning?.(), rootTransform:getComputedStyle(window.crmHomeCamera?.layers?.()[0]).transform,
        surface:window.crmHomeCamera?.surface?.().className, active:document.activeElement?.className, popover:!!document.querySelector('.crm-home-todo-popover') }) };
  });
  await page.hover('.crm-home-hand-trigger');
  await sleep(460);
  await check('Hovering the hand reveals every priority card', () => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card.tk-card')];
    const rects = cards.map((card) => { const rect=card.getBoundingClientRect(); return { top:rect.top,bottom:rect.bottom }; });
    return { ok:cards.length > 0 && rects.every((rect) => rect.top > 0 && rect.bottom <= innerHeight + 1)
      && Math.min(...rects.map((rect) => rect.top)) < innerHeight - 150, detail:JSON.stringify(rects) };
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
    tile.dataset.previewReady = 'true';
    if (!preview.querySelector('.crm-home-preview-foreground')) {
      const probe = document.createElement('img');
      probe.className = 'crm-home-preview-image crm-home-preview-foreground';
      probe.dataset.previewVariant = 'filtered';
      probe.dataset.interactionStyleProbe = 'true';
      preview.appendChild(probe);
    }
  }));
  await check('Resting Home objects use one cached raster with the subtle blur', () => {
    const images = [...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')];
    return images.length === 6 && images.every((image) => {
      const filter = getComputedStyle(image).filter;
      return image.dataset.previewVariant === 'filtered' && filter.includes('blur(1.8px)')
        && filter.includes('saturate(0.9)') && filter.includes('brightness(0.82)');
    })
      && !document.querySelector('.crm-home-grid .crm-home-preview-sharp');
  });
  await page.hover('.crm-home-bucket[data-module="desk"]');
  await sleep(220);
  await check('Hover sharpens tile objects and de-emphasizes its title', () => {
    const tile = document.querySelector('.crm-home-grid > .crm-home-bucket[data-module="desk"]');
    const foreground = tile?.querySelector('.crm-home-preview-foreground');
    const title = document.querySelector('.crm-home-title-layer > .crm-home-title-slot[data-module="desk"] .crm-home-title-glass');
    const filter = foreground && getComputedStyle(foreground).filter;
    const titleStyle = title && getComputedStyle(title);
    return !!foreground && !!title && filter.includes('blur(0px)') && filter.includes('saturate(0.96)')
      && !tile.querySelector('.crm-home-preview-sharp') && Number(titleStyle.opacity) >= .23 && Number(titleStyle.opacity) < .33
      && titleStyle.left === '17px' && titleStyle.bottom === '16px';
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
  await page.evaluate(() => {
    ['Project A', 'Project B', 'Project C'].forEach((title) => {
      const project = window.crmPlanner.createProject(title);
      ['One', 'Two', 'Three'].forEach((bucketTitle, index) => {
        const bucket = window.crmPlanner.createBucket(project.id, bucketTitle);
        if (index < 2) window.crmPlanner.createCard(project.id, bucket.id, `${title} item ${index + 1}`);
      });
    });
  });
  await page.waitForFunction(() => document.querySelectorAll('.crm-overview-project').length >= 3
    && document.querySelectorAll('.crm-overview-mini-world').length >= 3
    && document.querySelectorAll('.crm-overview-ticket').length >= 4
    && document.querySelectorAll('.crm-overview-update').length >= 3, { timeout: 10000 });
  await check('Overview is a quiet index of real projects, tickets, and recent work', () => {
    const projects = [...document.querySelectorAll('.crm-overview-project')];
    const maps = [...document.querySelectorAll('.crm-overview-mini-world')];
    const tickets = [...document.querySelectorAll('.crm-overview-ticket')];
    const updates = [...document.querySelectorAll('.crm-overview-update')];
    const list = document.querySelector('.crm-overview-project-list');
    const bucket = document.querySelector('.crm-overview-bucket');
    const scroll = document.querySelector('.crm-overview-scroll');
    const type = {
      room: getComputedStyle(document.querySelector('.crm-overview-title')).fontSize,
      section: getComputedStyle(document.querySelector('.crm-overview-section-title')).fontSize,
      body: getComputedStyle(document.querySelector('.crm-overview-update-title')).fontSize,
    };
    return {
      ok: projects.length >= 3 && maps.length === projects.length && tickets.length >= 4 && updates.length >= 3
        && !!list && getComputedStyle(list).overflowX === 'auto' && getComputedStyle(list).overflowY === 'hidden'
        && !!bucket && getComputedStyle(bucket).backgroundColor === 'rgba(0, 0, 0, 0)'
        && !!scroll && getComputedStyle(scroll).overflowY === 'auto'
        && type.room === '17px' && type.section === '12px' && type.body === '12px'
        && !document.querySelector('.crm-overview-pocket,.crm-overview-worlds,.crm-overview-featured,.crm-overview-map')
        && !!document.querySelector('.crm-overview-ticket-section') && !!document.querySelector('.crm-overview-recent'),
      detail: `${projects.length} projects / ${tickets.length} tickets / ${updates.length} recent items`,
    };
  });
  await check('Project previews stay low-cost while tickets reuse native cards', () => {
    const maps = [...document.querySelectorAll('.crm-overview-mini-world')];
    const tickets = [...document.querySelectorAll('.crm-overview-ticket')];
    return maps.length >= 3 && tickets.length >= 4
      && maps.every((map) => !map.querySelector('.tk-card,.tk-zone,.ticket-body'))
      && tickets.every((ticket) => ticket.classList.contains('tk-card') && !!ticket.querySelector('.ticket-body'))
      && maps.every((map) => map.querySelectorAll('*').length <= 30);
  });
  await check('Overview avoids dashboard panels and invented context chrome', () => {
    const projects = [...document.querySelectorAll('.crm-overview-project')];
    const tickets = [...document.querySelectorAll('.crm-overview-ticket')];
    const sections = [...document.querySelectorAll('.crm-overview-ticket-section,.crm-overview-recent')];
    return projects.every((item) => !item.classList.contains('crm-menu-action'))
      && tickets.every((item) => !item.classList.contains('crm-menu-action') && item.classList.contains('tk-card'))
      && sections.every((item) => getComputedStyle(item).backgroundImage === 'none' && getComputedStyle(item).backgroundColor === 'rgba(0, 0, 0, 0)')
      && !document.querySelector('.crm-overview-pocket,.crm-overview-movement,.crm-overview-context,.crm-overview-brief');
  });
  const overviewProjectChoice = await page.evaluate(() => {
    const current = window.crmPlanner?.selected?.();
    return [...document.querySelectorAll('.crm-overview-project')].find((item) => item.dataset.overviewProject !== current)?.dataset.overviewProject || '';
  });
  if (overviewProjectChoice) {
    await page.evaluate((projectId) => { window.__overviewProjectChoice = projectId; }, overviewProjectChoice);
    await page.click(`.crm-overview-project[data-overview-project="${overviewProjectChoice}"]`);
    await page.waitForFunction((projectId) => document.body.dataset.crmModule === 'planner'
      && window.crmPlanner?.selected?.() === projectId && !window.crmDeskTransit?.isBusy?.(), { timeout: 10000 }, overviewProjectChoice);
  }
  await check('Selecting a project opens that exact project in Planner', () => document.body.dataset.crmModule === 'planner'
    && window.crmPlanner?.selected?.() === window.__overviewProjectChoice);
  await activate('desk');
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
  await check('Home tile titles return continuously during the zoom home', () => {
    const surface = window.crmHomeCamera?.surface?.();
    const titles = [...(surface?.querySelectorAll('.crm-home-title-glass') || [])];
    return surface?.classList.contains('crm-home-camera-contracting') && titles.length > 0
      && titles.every((title) => getComputedStyle(title).visibility === 'visible' && Number(getComputedStyle(title).opacity) > .9);
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
    const panelRect = theater?.querySelector('.crm-assignment-pools')?.getBoundingClientRect();
    const bucketRect = buckets[0]?.getBoundingClientRect();
    const sameButton = ['backgroundColor','borderTopWidth','borderRadius','color','fontSize','fontWeight','boxShadow','paddingLeft','paddingRight']
      .every((property) => actual[property] === expected[property]);
    const assignmentType = {
      title: getComputedStyle(theater.querySelector('.crm-assignment-title')).fontSize,
      buckets: [...new Set(buckets.map((bucket) => getComputedStyle(bucket.querySelector('.tk-zone-title')).fontSize))],
    };
    return { ok: pools.length === 8 && buckets.length > 0 && people.length === 10
      && people.every((card) => !!card.querySelector('.ticket-body') && !!card.dataset.assignmentContactId)
      && pools.filter((pool) => pool.classList.contains('is-selected')).length === 1
      && sameButton && !theater.querySelector('.crm-assignment-source-pool.tk-zone')
      && !!panelRect && !!bucketRect && Math.abs(panelRect.top - bucketRect.top) <= 1
      && assignmentType.title === '14px'
      && assignmentType.buckets.every((size) => size === '14px')
      && buckets.every((bucket) => !!bucket.dataset.assignmentCommitment)
      && !theater.querySelector('.crm-assignment-source-pool-count,.crm-assignment-count,.crm-assignment-hand-label')
      && !theater.querySelector('svg.tk-flow,.tk-flow-shaft,.tk-flow-head'),
      detail: JSON.stringify({ sameButton, panelTop: panelRect?.top, bucketTop: bucketRect?.top, assignmentType }) };
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
    const cards = [...document.querySelectorAll('.crm-assignment-hand-card.tk-card')];
    return !!selected && cards.length === 10 && !selected.querySelector('.crm-assignment-source-pool-count');
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
  await check('Conversation history is a compact anchored menu with a real cross-channel thread', () => {
    const history = document.querySelector('.crm-person-history-shell:not([hidden]) .crm-person-history');
    const shell = history?.closest('.crm-person-history-shell');
    const source = document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');
    const events = [...(history?.querySelectorAll('.crm-person-history-event') || [])];
    if (!history || !shell || !source) return false;
    const rect = history.getBoundingClientRect(); const sourceRect = source.getBoundingClientRect(); const shellStyle = getComputedStyle(shell);
    const adjacent = Math.abs(rect.left - sourceRect.right) <= 12 || Math.abs(sourceRect.left - rect.right) <= 12;
    return history.classList.contains('crm-menu-surface') && rect.width <= 370 && rect.height <= 540 && adjacent
      && history.querySelector('.crm-person-history-title')?.textContent.trim() === 'Marta Reyes'
      && events.length >= 6 && new Set(events.map((event) => event.dataset.historyKind)).size >= 4
      && shellStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', ''].includes(shellStyle.backdropFilter)
      && !!history.querySelector('[data-person-history-composer][hidden]')
      && !history.querySelector('[data-history-filter],.crm-person-history-summary,.crm-person-history-sidebar,.crm-person-history-filters')
      && [...history.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'));
  });
  const historyCountBefore = await page.$$eval('.crm-person-history-event', (events) => events.length);
  await page.click('[data-person-history-compose]');
  await page.waitForSelector('[data-person-history-composer]:not([hidden])');
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
    const newest = document.querySelector('.crm-person-history-event:first-child .crm-person-history-event-content')?.textContent || '';
    return !!interaction && interaction.kind === 'message' && interaction.direction === 'inbound'
      && newest.includes('escalation wording works for legal')
      && !!document.querySelector('[data-person-history-composer][hidden]');
  });
  await page.click('[data-person-history-close]');
  await page.waitForFunction(() => !window.crmPersonHistory?.isOpen?.(), { timeout: 5000 });

  await page.evaluate(() => window.crmRecordWorld.open('contacts', 'ct_marta', document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]')));
  await page.waitForSelector('.record-world-shell:not([hidden]) .record-world', { timeout: 5000 });
  await check('Every non-ticket record opens as a compact canonical menu, never a full-screen invented console', () => {
    const shell = document.querySelector('.record-world-shell:not([hidden])');
    const panel = shell?.querySelector('.record-world');
    const source = document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');
    const reference = document.querySelector('.auth-profile-menu');
    if (!shell || !panel || !source || !reference) return false;
    const rect = panel.getBoundingClientRect(); const sourceRect = source.getBoundingClientRect(); const actual = getComputedStyle(panel); const expected = getComputedStyle(reference); const shellStyle = getComputedStyle(shell);
    const adjacent = Math.abs(rect.left - sourceRect.right) <= 12 || Math.abs(sourceRect.left - rect.right) <= 12;
    return panel.classList.contains('crm-menu-surface') && rect.width <= 300 && rect.height <= 420 && adjacent
      && shellStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', ''].includes(shellStyle.backdropFilter)
      && panel.querySelectorAll('.record-world-fact').length > 0 && panel.querySelectorAll('.record-world-fact').length <= 4
      && panel.querySelectorAll('.record-world-actions > button').length === 3
      && panel.querySelectorAll('.record-world-editor:not([hidden])').length === 0
      && !panel.querySelector('details,.record-world-fold,.record-world-flow,.record-world-timeline,.record-world-section')
      && [...panel.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'))
      && ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderRadius', 'boxShadow'].every((property) => actual[property] === expected[property]);
  });
  await page.click('[data-record-compose="note"]');
  await check('A record action reveals one small inline editor inside the same menu', () => (
    document.querySelectorAll('.record-world-editor:not([hidden])').length === 1
      && !!document.querySelector('.record-world-editor:not([hidden]) textarea.crm-menu-input')
      && document.querySelector('.record-world').getBoundingClientRect().height <= 420
      && !document.querySelector('.record-world-shell details,.record-world-shell .record-world-flow')
  ));
  await page.type('[data-record-editor="note"] textarea', 'Compact record menu note');
  await page.click('[data-record-editor="note"] button[type="submit"]');
  await page.waitForSelector('.record-world-shell[hidden]');
  await check('The compact record menu still persists its real action', async () => {
    const result = await window.crmDomain.list('activities', { entityType: 'contacts', recordId: 'ct_marta', includeDeleted: false });
    return (result.records || []).some((item) => String(item.content || '').includes('Compact record menu note'));
  });

  await activate('money');
  await check('Money uses one vertical selector for Bills and Invoices', () => {
    const room = document.querySelector('[data-crm-theater="money-room"]');
    const selector = room?.querySelector('.crm-money-switcher')?.getBoundingClientRect();
    const zones = [...(room?.querySelectorAll('[data-crm-subtheater="money"]:not([hidden]) .tk-zone') || [])]
      .map((zone) => zone.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    const gaps = zones.slice(1).map((zone, index) => zone.left - zones[index].right);
    return !!room && room.querySelectorAll('.crm-money-view').length === 2
      && room.querySelectorAll('.crm-money-view.is-selected').length === 1
      && room.querySelectorAll('[data-crm-subtheater="money"]:not([hidden])').length === 1
      && !!selector && selector.width >= 145 && zones.length === 3
      && getComputedStyle(room.querySelector('.crm-money-view')).fontSize === '13px'
      && Math.abs(selector.top - zones[0].top) <= 1
      && zones[0].left - selector.right >= 12 && zones[0].left - selector.right <= 28
      && gaps.every((gap) => gap >= 16 && gap <= 28);
  });
  await page.click('.crm-money-view[data-money-view="bills"]');
  await page.waitForFunction(() => window.crmMoneyRoom?.selected?.() === 'bills');
  await check('Money selector swaps the live room without navigation chrome', () => document.querySelector('[data-crm-theater="bills"]:not([hidden])')
    && document.querySelector('[data-crm-theater="money"]')?.hidden);

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
      const buckets = [...document.querySelectorAll('[data-crm-theater]:not([hidden]) .tk-zone')].filter((bucket) => bucket.getBoundingClientRect().width > 0);
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
  await check('Ticket detail is a compact canonical config menu with no full-screen visual scrim', () => {
    const overlay = document.querySelector('.ticket-detail-overlay:not([hidden])');
    const panel = overlay?.querySelector('.ticket-detail');
    const scrim = overlay?.querySelector('.td-scrim');
    const reference = document.querySelector('.auth-profile-menu');
    if (!overlay || !panel || !reference) return false;
    const rect = panel.getBoundingClientRect(); const actual = getComputedStyle(panel); const expected = getComputedStyle(reference); const overlayStyle = getComputedStyle(overlay);
    return panel.classList.contains('crm-menu-surface') && rect.width <= 310 && rect.height <= 570
      && overlayStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', ''].includes(overlayStyle.backdropFilter)
      && (!scrim || getComputedStyle(scrim).display === 'none')
      && [...panel.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'))
      && [...panel.querySelectorAll('input,textarea,select')].every((input) => input.classList.contains('crm-menu-input'))
      && ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderRadius', 'boxShadow'].every((property) => actual[property] === expected[property]);
  });
  await page.keyboard.press('Escape');
  await sleep(520);
  await page.click(ticketCard, { button: 'right' });
  await page.waitForSelector('.tk-menu', { timeout: 5000 });
  await check('Right-click restores the complete ticket action menu', () => {
    const items = [...document.querySelectorAll('.tk-menu .tk-menu-item')];
    const actions = items.map((item) => item.textContent.trim().toLowerCase());
    return document.querySelector('.tk-menu')?.classList.contains('crm-menu-surface')
      && items.every((item) => item.classList.contains('crm-menu-action'))
      && ['edit', 'appearance', 'activity', 'move to trash'].every((label) => actions.includes(label));
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

  await page.click(ticketCard, { button: 'right' });
  await page.waitForSelector('.tk-menu [data-act="size"]');
  await page.click('.tk-menu [data-act="size"]');
  await page.waitForFunction((selector) => {
    const card = document.querySelector(selector);
    return card?.classList.contains('crm-object-small') && Number.parseFloat(getComputedStyle(card).scale) < .85;
  }, {}, ticketCard);
  await check('Right-click changes a ticket from Large to Small with a compositor-only scale', () => {
    const card = document.querySelector('[data-crm-theater="tickets"] .tk-card.crm-object-small');
    if (!card) return false;
    const rect = card.getBoundingClientRect(); const scale = Number.parseFloat(getComputedStyle(card).scale);
    const key = window.crmObjectSizing.keyOf(card, 'card'); const stored = JSON.parse(localStorage.getItem('crm-object-sizing-v1') || '{}');
    return card.dataset.crmObjectSize === 'small' && scale > .75 && scale < .85 && rect.width < card.offsetWidth
      && stored.cards?.[key] === 'small';
  });
  await page.click(ticketCard, { button: 'right' });
  await check('A Small ticket remains fully interactive and offers the inverse Large action', () => document.querySelector('.tk-menu [data-act="size"]')?.textContent.trim().toLowerCase() === 'make large');
  await page.keyboard.press('Escape');
  await page.click(ticketCard);
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail');
  await page.keyboard.press('Escape');
  await sleep(520);

  const bucketSelector = '[data-crm-theater="tickets"] .tk-zone:first-child';
  await page.click(`${bucketSelector} .tk-zone-hd`, { button: 'right' });
  await page.waitForSelector('.crm-size-menu');
  await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((selector) => {
    const bucket = document.querySelector(selector);
    return bucket?.classList.contains('crm-object-small') && Number.parseFloat(getComputedStyle(bucket).scale) < .83;
  }, {}, bucketSelector);
  await check('Right-click scales a bucket cell down without replacing its cards or behavior', () => {
    const bucket = document.querySelector('[data-crm-theater="tickets"] .tk-zone.crm-object-small');
    if (!bucket) return false;
    const scale = Number.parseFloat(getComputedStyle(bucket).scale); const cards = bucket.querySelectorAll('.tk-zcard').length;
    const key = window.crmObjectSizing.keyOf(bucket, 'bucket'); const stored = JSON.parse(localStorage.getItem('crm-object-sizing-v1') || '{}');
    return {
      ok: bucket.dataset.crmObjectSize === 'small' && scale > .78 && scale < .86 && cards >= 6 && stored.buckets?.[key] === 'small',
      detail: `${bucket.dataset.crmObjectSize} / scale ${scale} / ${cards} cards / ${key}=${stored.buckets?.[key]}`,
    };
  });
  await page.click(`${bucketSelector} .tk-zone-hd`, { button: 'right' });
  await page.waitForSelector('.crm-size-menu');
  await check('A Small bucket offers the inverse Large action in the same compact menu', () => document.querySelector('.crm-size-menu .crm-menu-action')?.textContent.trim().toLowerCase() === 'make large');
  await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('crm-object-small'), {}, bucketSelector);

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
  await check('Overview tickets are the same native objects used in the Tickets room', () => {
    const tickets = [...document.querySelectorAll('.crm-overview-ticket')];
    return tickets.length >= 4 && tickets.every((ticket) => ticket.classList.contains('tk-card') && !!ticket.querySelector('.ticket-body'))
      && tickets.some((ticket) => ticket.dataset.overviewTicket);
  });
  await page.click('.crm-overview-ticket[data-overview-ticket]:not([data-overview-ticket=""])');
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail', { timeout: 5000 });
  await check('An Overview ticket opens the same ticket detail as the Tickets room', () => !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail'));
  await page.keyboard.press('Escape');

  await activate('planner');
  await check('Planner uses one established selector and aligned custom buckets', () => {
    const projects = [...document.querySelectorAll('.crm-planner-project')];
    const buckets = [...document.querySelectorAll('.crm-planner-bucket')];
    const plannerType = {
      heading: getComputedStyle(document.querySelector('.crm-planner-heading')).fontSize,
      buckets: [...new Set(buckets.map((bucket) => getComputedStyle(bucket.querySelector('.tk-zone-title')).fontSize))],
    };
    return { ok: projects.length >= 3 && buckets.length === 3
      && !document.querySelector('.crm-project-minimap,.crm-planner-universe')
      && projects.every((project) => !project.querySelector('*'))
      && buckets.every((bucket) => bucket.classList.contains('tk-zone') && !!bucket.querySelector('.tk-zone-title'))
      && plannerType.heading === '17px'
      && plannerType.buckets.every((size) => size === '14px')
      && new Set(buckets.map((bucket) => Math.round(bucket.getBoundingClientRect().top))).size === 1,
      detail: JSON.stringify(plannerType) };
  });
  await page.click('[data-planner-action="new-project"]');
  await page.type('.crm-planner-popover input[name="value"]', 'Interaction plan');
  await page.click('.crm-planner-popover button[type="submit"]');
  await page.waitForFunction(() => window.crmPlanner.projects().some((project) => project.title === 'Interaction plan'));
  await page.click('[data-planner-action="new-bucket"]');
  await page.type('.crm-planner-popover input[name="value"]', 'Review');
  await page.click('.crm-planner-popover button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.crm-planner-bucket').length === 1);
  await page.click('.crm-planner-bucket:last-child [data-planner-action="new-card"]');
  await page.type('.crm-planner-popover input[name="value"]', 'Ship the polished flow');
  await page.click('.crm-planner-popover button[type="submit"]');
  await check('Planner creates projects, custom buckets, and fully functional items', () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    const review = project?.buckets.find((bucket) => bucket.title === 'Review');
    const stored = JSON.parse(localStorage.getItem('crm-planner-projects-v1') || '[]');
    return !!project && project.buckets.length === 1 && review?.cards.some((card) => card.title === 'Ship the polished flow')
      && stored.some((item) => item.id === project.id)
      && !!document.querySelector('.crm-planner-card');
  });
  await page.click('.crm-planner-bucket:last-child', { button: 'right' });
  await check('Planner edits use a compact canonical anchored menu', () => {
    const menu = document.querySelector('.crm-planner-context');
    const reference = document.querySelector('.auth-profile-menu');
    if (!menu || !reference) return false;
    const actual = getComputedStyle(menu); const expected = getComputedStyle(reference);
    const rect = menu.getBoundingClientRect();
    return menu.classList.contains('crm-menu-surface') && rect.width < 200 && rect.height < 130
      && ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderRadius', 'boxShadow'].every((property) => actual[property] === expected[property]);
  });
  await page.click('.crm-planner-context .crm-menu-action');
  await page.waitForFunction(() => {
    const bucket = document.querySelector('.crm-planner-bucket:last-child');
    return bucket?.classList.contains('crm-object-small') && bucket.getBoundingClientRect().width <= 205
      && Number.parseFloat(getComputedStyle(bucket).scale) === 1;
  });
  await page.click('.crm-planner-bucket:last-child .crm-planner-card', { button: 'right' });
  await page.waitForSelector('.crm-planner-context');
  await page.click('.crm-planner-context .crm-menu-action');
  await page.waitForFunction(() => {
    const card = document.querySelector('.crm-planner-bucket:last-child .crm-planner-card');
    return card?.classList.contains('crm-object-small') && card.getBoundingClientRect().width <= 145
      && Number.parseFloat(getComputedStyle(card).scale) === 1;
  });
  await page.evaluate(() => {
    const current = window.crmPlanner.selected();
    const other = window.crmPlanner.projects().find((project) => project.id !== current)?.id;
    if (other) window.crmPlanner.selectProject(other);
    window.crmPlanner.selectProject(current);
  });
  await page.waitForFunction(() => document.querySelector('.crm-planner-bucket:last-child')?.classList.contains('crm-object-small')
    && document.querySelector('.crm-planner-bucket:last-child .crm-planner-card')?.classList.contains('crm-object-small'));
  await check('Planner bucket and item sizes persist when the project world is rebuilt', () => {
    const bucket = document.querySelector('.crm-planner-bucket:last-child'); const card = bucket?.querySelector('.crm-planner-card');
    const stored = JSON.parse(localStorage.getItem('crm-object-sizing-v1') || '{}');
    return !!bucket && !!card && stored.buckets?.[window.crmObjectSizing.keyOf(bucket, 'bucket')] === 'small'
      && stored.cards?.[window.crmObjectSizing.keyOf(card, 'card')] === 'small'
      && bucket.getBoundingClientRect().width <= 205 && card.getBoundingClientRect().width <= 145;
  });
  await activate('desk');
  await page.waitForFunction(() => [...document.querySelectorAll('.crm-overview-project-name')].some((element) => element.textContent.trim() === 'Interaction plan'));
  await check('Overview immediately reflects Planner projects as low-cost mini layouts', () => {
    const row = [...document.querySelectorAll('.crm-overview-project')].find((element) => element.querySelector('.crm-overview-project-name')?.textContent.trim() === 'Interaction plan');
    return !!row && row.querySelectorAll('.crm-overview-mini-lane').length === 1 && !row.querySelector('.crm-planner-bucket,.tk-card');
  });
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
