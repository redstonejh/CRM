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
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces && window.crmPlanner && window.crmAssignments, { timeout: 30000 });
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
  await page.waitForFunction(() => document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 4, { timeout: 10000 });
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
  await check('Home has four inert screenshot LODs and no live miniature trees', () => ({
    ok: document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 4
      && !document.querySelector('.crm-home-grid .crm-home-lod-scene,.crm-home-grid .crm-home-lod-root'),
    detail: `${document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length}/4 surfaces`,
  }));
  await check('Home is only People, Tickets, Planner, and Assignments', () => {
    const keys = ['people','cases','planner','assignments'];
    const title = (key) => document.querySelector(`.crm-home-title-layer > .crm-home-title-slot[data-module="${key}"] .crm-home-title`);
    return keys.every((key) => document.querySelector(`.crm-home-bucket[data-module="${key}"]`))
      && !document.querySelector('.crm-home-bucket[data-module="calendar"]')
      && !document.querySelector('.crm-home-bucket[data-module="pipeline"]')
      && !document.querySelector('.crm-home-bucket[data-module="jobs"],.crm-home-bucket[data-module="bills"],.crm-home-bucket[data-module="invoices"],.crm-home-bucket[data-module="desk"],.crm-home-bucket[data-module="money"]')
      && title('cases')?.textContent.trim() === 'Tickets'
      && title('planner')?.textContent.trim() === 'Planner'
      && title('assignments')?.textContent.trim() === 'Assignments';
  });
  await check('Every Home preview is a proportional viewport of its destination', () => {
    const expected = innerWidth / innerHeight;
    const tiles = [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')].map((tile) => {
      const rect = tile.getBoundingClientRect(); return { width:rect.width, height:rect.height, ratio:rect.width / rect.height };
    });
    const widths = tiles.map((tile) => tile.width); const heights = tiles.map((tile) => tile.height);
    return tiles.length === 4 && tiles.every((tile) => Math.abs(tile.ratio - expected) <= .01)
      && Math.max(...widths) - Math.min(...widths) < 1 && Math.max(...heights) - Math.min(...heights) < 1;
  });
  await check('Home tile titles use a sharp live type layer', () => {
    const titles = [...document.querySelectorAll('.crm-home-title-layer > .crm-home-title-slot .crm-home-title')];
    return titles.length === 4 && titles.every((title) => {
      const style = getComputedStyle(title);
      return style.fontSize === '15px' && style.fontWeight === '600'
        && style.fontFamily.includes('Segoe UI Variable Text') && !style.textShadow.includes('12px')
        && !title.closest('.crm-home-bucket');
    }) && getComputedStyle(document.querySelector('.crm-home-level')).willChange === 'auto';
  });
  await check('Home has a visible progressive state while previews prepare', () => {
    const states = [...document.querySelectorAll('.crm-home-grid .crm-home-preview-state[role="status"]')];
    return states.length === 4 && states.every((state) => state.textContent.trim() === 'Preparing view'
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
  await page.click(`.crm-home-hand-card[data-commitment-id="${linkedHomeTodo.id}"]`, { button:'right' });
  await page.waitForSelector('.crm-home-todo-menu [data-todo-action="edit"]', { timeout:10000 });
  await check('A linked to-do remains editable and can enter the Assignment pipeline', () => !!document.querySelector('[data-todo-action="edit"]')
    && !!document.querySelector('[data-todo-action="assignments"]') && !!document.querySelector('[data-todo-action="open"]'));
  await page.click('.crm-home-todo-menu [data-todo-action="edit"]');
  await page.waitForSelector('.crm-home-todo-popover input[name="title"]', { timeout:10000 });
  await check('To-do editing keeps its exact linked record selected', (todo) => {
    const form = document.querySelector('.crm-home-todo-popover');
    return form?.querySelector('.crm-home-todo-popover-title')?.textContent.trim() === 'Edit to do'
      && form.elements.target.value === `tasks:${todo.taskId}` && form.elements.title.value === 'Home linked to-do contract';
  }, linkedHomeTodo);
  await page.$eval('.crm-home-todo-popover input[name="title"]', (input) => { input.value = 'Edited linked to-do'; input.dispatchEvent(new Event('input', { bubbles:true })); });
  await page.click('.crm-home-todo-popover button[type="submit"]');
  await page.waitForFunction(async (id) => (await window.crmDomain.list('commitments', { includeDeleted:false, limit:300 })).records?.find((item) => item.id === id)?.title === 'Edited linked to-do', { timeout:10000 }, linkedHomeTodo.id);
  await check('Editing a to-do persists without severing its task link', async (todo) => {
    const item = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:300 })).records?.find((record) => record.id === todo.id);
    return item?.title === 'Edited linked to-do' && item.links?.some((link) => link.entityType === 'tasks' && link.recordId === todo.taskId);
  }, linkedHomeTodo);
  await page.mouse.move(1, 1); await sleep(430);
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
    return images.length === 4 && images.every((image) => {
      const filter = getComputedStyle(image).filter;
      return image.dataset.previewVariant === 'filtered' && filter.includes('blur(1.8px)')
        && filter.includes('saturate(0.9)') && filter.includes('brightness(0.82)');
    })
      && !document.querySelector('.crm-home-grid .crm-home-preview-sharp');
  });
  await page.hover('.crm-home-bucket[data-module="people"]');
  await sleep(220);
  await check('Hover sharpens tile objects and de-emphasizes its title', () => {
    const tile = document.querySelector('.crm-home-grid > .crm-home-bucket[data-module="people"]');
    const foreground = tile?.querySelector('.crm-home-preview-foreground');
    const title = document.querySelector('.crm-home-title-layer > .crm-home-title-slot[data-module="people"] .crm-home-title-glass');
    const filter = foreground && getComputedStyle(foreground).filter;
    const titleStyle = title && getComputedStyle(title);
    return !!foreground && !!title && filter.includes('blur(0px)') && filter.includes('saturate(0.96)')
      && !tile.querySelector('.crm-home-preview-sharp') && Number(titleStyle.opacity) >= .23 && Number(titleStyle.opacity) < .33
      && titleStyle.left === '17px' && titleStyle.bottom === '16px';
  });
  await page.evaluate(() => document.querySelectorAll('[data-interaction-style-probe]').forEach((probe) => probe.remove()));
  await page.evaluate(() => {
    const selected = document.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    const neighbor = document.querySelector('.crm-home-bucket[data-module="cases"]')?.getBoundingClientRect();
    window.__homeSpatialRelation = selected && neighbor ? {
      dx: (neighbor.left - selected.left) / selected.width,
      dy: (neighbor.top - selected.top) / selected.height,
      wr: neighbor.width / selected.width,
      hr: neighbor.height / selected.height,
    } : null;
  });
  await page.click('.crm-home-bucket[data-module="people"]');
  await sleep(100);
  await check('Home-to-room handoff remains inside the original camera', () => document.body.dataset.crmModule === 'home'
    && window.crmHomeCamera?.isTransitioning?.() && !!document.querySelector('.crm-home-expander:not(.crm-home-warm)'));
  await check('Neighbor tiles retain their spatial relationship throughout the dive-in', () => {
    const root = window.crmHomeCamera?.layers?.()[0];
    const selected = root?.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    const neighbor = root?.querySelector('.crm-home-bucket[data-module="cases"]')?.getBoundingClientRect();
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
  await check('Home camera lands directly on the destination', () => document.body.dataset.crmModule === 'people' && !document.querySelector('.crm-transit-veil'));
  await check('Tile room does not exclude the title-bar drag region', () => {
    const room = document.querySelector('[data-crm-theater="people"]:not([hidden])');
    return !!room && getComputedStyle(room).webkitAppRegion !== 'no-drag';
  });
  await page.evaluate(async () => {
    for (const title of ['Project A', 'Project B', 'Project C']) {
      const project = await window.crmPlanner.createProject(title);
      for (const [index, stage] of project.stages.entries()) {
        if (index < 2) await window.crmPlanner.createCard(project.id, stage.id, `${title} item ${index + 1}`);
      }
    }
  });
  await check('Overview and Money are fully absent from routes, theaters, and renderer APIs', () => {
    const keys = window.crmWorkspaces.modules().map((module) => module.key);
    return !keys.includes('desk') && !keys.includes('money') && !keys.includes('bills') && !keys.includes('invoices')
      && !window.crmDesk && !window.crmMoneyRoom && !window.billPipeline && !window.moneyPipeline
      && !document.querySelector('[data-crm-theater="desk"],[data-crm-theater="money-room"],[data-crm-theater="bills"],[data-crm-theater="money"]')
      && !document.querySelector('.crm-overview-surface,.crm-money-room,.crm-money-switcher');
  });

  await page.evaluate(() => { void window.crmDeskTransit.driveTo('home'); });
  await sleep(100);
  await check('Neighbor tiles retain their spatial relationship throughout the dive-out', () => {
    const root = window.crmHomeCamera?.layers?.()[0];
    const selected = root?.querySelector('.crm-home-bucket[data-module="people"]')?.getBoundingClientRect();
    const neighbor = root?.querySelector('.crm-home-bucket[data-module="cases"]')?.getBoundingClientRect();
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
  const assignmentScope = '[data-crm-theater="assignments"]:not([hidden])';
  await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="assignments"] .crm-assignment-bucket').length === 5
    && document.querySelectorAll('[data-crm-theater="assignments"] .crm-assignment-work-card').length > 0, { timeout: 10000 });
  await check('Assignments is one real commitment pipeline, not a hand of copied people cards', () => {
    const theater = document.querySelector('[data-crm-theater="assignments"]:not([hidden])');
    const filters = [...(theater?.querySelectorAll('button.crm-assignment-filter.crm-menu-action') || [])];
    const buckets = [...(theater?.querySelectorAll('.crm-assignment-bucket') || [])];
    const cards = [...(theater?.querySelectorAll('.crm-assignment-work-card') || [])];
    const reference = document.querySelector('.auth-menu-item');
    const expected = getComputedStyle(reference); const actual = getComputedStyle(filters.find((filter) => !filter.classList.contains('is-selected')));
    const panelRect = theater?.querySelector('.crm-assignment-rail')?.getBoundingClientRect();
    const bucketRect = buckets[0]?.getBoundingClientRect();
    const pipeline = theater?.querySelector('.crm-assignment-pipeline'); const clip = theater?.querySelector('.crm-assignment-board-clip');
    const scrollbar = theater?.querySelector('.crm-assignment-hsb'); const thumb = theater?.querySelector('.crm-assignment-hth');
    const firstCard = cards[0]; const firstCardRect = firstCard?.getBoundingClientRect(); const firstFaceRect = firstCard?.querySelector('.crm-assignment-card-face')?.getBoundingClientRect();
    const sameButton = ['backgroundColor','borderTopWidth','borderRadius','color','fontSize','fontWeight','boxShadow','paddingLeft','paddingRight']
      .every((property) => actual[property] === expected[property]);
    const ids = cards.map((card) => card.dataset.assignmentCard);
    return { ok: filters.length === 4 && buckets.length === 5 && cards.length === window.crmAssignments.items().length
      && cards.every((card) => card.dataset.recordEntity === 'commitments' && card.dataset.recordId === card.dataset.assignmentCard)
      && new Set(ids).size === ids.length && filters.filter((filter) => filter.classList.contains('is-selected')).length === 1
      && sameButton && !theater.querySelector('.crm-assignment-hand,.crm-assignment-hand-card,.crm-assignment-source-pool')
      && !!panelRect && !!bucketRect && Math.abs(panelRect.top - bucketRect.top) <= 1
      && getComputedStyle(theater.querySelector('.crm-assignment-title')).fontSize === '14px'
      && buckets.every((bucket) => !!bucket.dataset.assignmentStage && getComputedStyle(bucket.querySelector('.tk-zone-title')).fontSize === '14px')
      && theater.querySelectorAll('.crm-assignment-stack-toggle').length === 5
      && !!pipeline && !!clip && pipeline.scrollWidth > clip.clientWidth + 100 && scrollbar?.classList.contains('is-on') && thumb?.getBoundingClientRect().width > 28
      && buckets.every((bucket) => Math.abs(bucket.getBoundingClientRect().width - 268) < 1 && Math.abs(bucket.getBoundingClientRect().height - clip.clientHeight) < 1)
      && !!firstCardRect && !!firstFaceRect && Math.abs(firstCardRect.width - 185) < 1 && Math.abs(firstCardRect.height - 279) < 1
      && Math.abs(firstFaceRect.width - firstCardRect.width) < 1 && Math.abs(firstFaceRect.height - firstCardRect.height) < 1
      && !theater.querySelector('svg.tk-flow,.tk-flow-shaft,.tk-flow-head'),
      detail: JSON.stringify({ sameButton, panelTop: panelRect?.top, bucketTop: bucketRect?.top, cards:cards.length, unique:new Set(ids).size, overflow:(pipeline?.scrollWidth || 0) - (clip?.clientWidth || 0), card:firstCardRect && [firstCardRect.width, firstCardRect.height] }) };
  });
  const assignmentScrollBefore = await page.evaluate(() => window.crmAssignments.scrollState());
  await page.$eval('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-board-clip', (clip) => clip.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:320 })));
  await sleep(240);
  await check('Assignment buckets use the bucket scrollbar language horizontally, including wheel motion and thumb travel', (before) => {
    const theater=document.querySelector('[data-crm-theater="assignments"]:not([hidden])'); const state = window.crmAssignments.scrollState(); const track = theater?.querySelector('.crm-assignment-pipeline'); const bar = theater?.querySelector('.crm-assignment-hsb'); const thumb = theater?.querySelector('.crm-assignment-hth');
    const referenceBar = document.querySelector('[data-crm-theater="tickets"] .tk-zsb'); const referenceThumb = document.querySelector('[data-crm-theater="tickets"] .tk-zth');
    const barStyle = getComputedStyle(bar); const thumbStyle = getComputedStyle(thumb); const referenceBarStyle = referenceBar && getComputedStyle(referenceBar); const referenceThumbStyle = referenceThumb && getComputedStyle(referenceThumb);
    return { ok:state.min < -100 && state.x < before.x - 30 && /matrix\(1, 0, 0, 1, -/.test(getComputedStyle(track).transform)
      && thumb.getBoundingClientRect().left > bar.getBoundingClientRect().left + 5
      && !!referenceBarStyle && !!referenceThumbStyle && barStyle.backgroundColor === referenceBarStyle.backgroundColor && barStyle.borderRadius === referenceBarStyle.borderRadius
      && barStyle.boxShadow === referenceBarStyle.boxShadow && thumbStyle.backgroundColor === referenceThumbStyle.backgroundColor && thumbStyle.borderRadius === referenceThumbStyle.borderRadius && thumbStyle.boxShadow === referenceThumbStyle.boxShadow,
      detail:JSON.stringify({ before, state, thumbLeft:thumb.getBoundingClientRect().left - bar.getBoundingClientRect().left }) };
  }, assignmentScrollBefore);
  await page.evaluate(() => window.crmAssignments.scrollBy(-100000, true));
  await page.waitForFunction(() => document.querySelector('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-hth')?.getBoundingClientRect().width > 28);
  await page.$eval('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-hth', (thumb) => { const rect=thumb.getBoundingClientRect(),travel=thumb.parentElement.getBoundingClientRect().width-rect.width,start=rect.left+rect.width/2,end=start+Math.min(90,travel*.65),init={bubbles:true,cancelable:true,pointerId:73,pointerType:'mouse',isPrimary:true,clientY:rect.top+rect.height/2}; thumb.dispatchEvent(new PointerEvent('pointerdown',{...init,button:0,buttons:1,clientX:start})); window.dispatchEvent(new PointerEvent('pointermove',{...init,button:-1,buttons:1,clientX:end})); window.dispatchEvent(new PointerEvent('pointerup',{...init,button:0,buttons:0,clientX:end})); });
  await sleep(180);
  await check('The horizontal bucket thumb can be dragged and recoils inside the viewport bounds', () => {
    const theater=document.querySelector('[data-crm-theater="assignments"]:not([hidden])'); const state=window.crmAssignments.scrollState(); const bar=theater?.querySelector('.crm-assignment-hsb')?.getBoundingClientRect(); const thumb=theater?.querySelector('.crm-assignment-hth')?.getBoundingClientRect();
    return { ok:state.x < -30 && state.x >= state.min - 1 && !!bar && !!thumb && thumb.left > bar.left + 20 && thumb.right <= bar.right + 1, detail:JSON.stringify({ state, thumbLeft:thumb && bar ? thumb.left-bar.left : null }) };
  });
  await page.evaluate(() => window.crmAssignments.scrollBy(-100000, true));
  await page.click(`${assignmentScope} .crm-assignment-filter[data-assignment-filter="unassigned"]`);
  await check('Assignment filters change scope without manufacturing another card collection', () => {
    const theater=document.querySelector('[data-crm-theater="assignments"]:not([hidden])'); const cards = [...(theater?.querySelectorAll('.crm-assignment-work-card') || [])];
    return theater?.querySelector('.crm-assignment-filter.is-selected')?.dataset.assignmentFilter === 'unassigned'
      && cards.every((card) => card.closest('[data-assignment-stage]')?.dataset.assignmentStage === 'unassigned')
      && new Set(cards.map((card) => card.dataset.assignmentCard)).size === cards.length;
  });
  await page.click(`${assignmentScope} .crm-assignment-filter[data-assignment-filter="all"]`);

  const assignmentMove = await page.evaluate(async () => {
    const item = window.crmAssignments.items().find((candidate) => !['completed','cancelled','canceled'].includes(String(candidate.status || '').toLowerCase()));
    const original = item.assignmentStage || (item.assignee ? 'assigned' : 'unassigned'); const target = original === 'blocked' ? 'active' : 'blocked';
    const ok = await window.crmAssignments.move(item.id, target);
    const record = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((candidate) => candidate.id === item.id);
    const flow = (await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 })).records.find((candidate) => candidate.recordId === item.id && candidate.workflowKey === 'assignments');
    return { id:item.id, original, target, ok, recordStage:record?.assignmentStage, flowStage:flow?.stage };
  });
  await check('Dragging logic moves one commitment through a persisted assignment workflow', (state) => {
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(state.id)}"]`)];
    return { ok:state.ok && state.recordStage === state.target && state.flowStage === state.target && cards.length === 1
      && cards[0].closest('[data-assignment-stage]')?.dataset.assignmentStage === state.target, detail:JSON.stringify(state) };
  }, assignmentMove);
  await page.evaluate((state) => window.crmAssignments.move(state.id, state.original), assignmentMove);

  const assignment = await page.evaluate(async () => {
    const item = window.crmAssignments.items().find((candidate) => !['completed','cancelled','canceled'].includes(String(candidate.status || '').toLowerCase()));
    const contact = (await window.crmStore.list('contacts', { includeDeleted:false })).records[0]; const ok = await window.crmAssignments.assign(item.id, contact.id);
    const record = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((candidate) => candidate.id === item.id);
    const flow = (await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 })).records.find((candidate) => candidate.recordId === item.id && candidate.workflowKey === 'assignments');
    return { id:item.id, contactId:contact.id, ok, assignedContactId:record?.assignedContactId, stage:record?.assignmentStage, flowStage:flow?.stage };
  });
  await check('Assigning a person updates that commitment and its workflow membership', (state) => {
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(state.id)}"]`)];
    return { ok:state.ok && state.assignedContactId === state.contactId && state.stage === 'assigned' && state.flowStage === 'assigned'
      && cards.length === 1 && cards[0].closest('[data-assignment-stage]')?.dataset.assignmentStage === 'assigned', detail:JSON.stringify(state) };
  }, assignment);
  await page.evaluate((id) => window.crmAssignments.unassign(id), assignment.id);

  const assignmentStageSelector = await page.$eval(`${assignmentScope} .crm-assignment-bucket:has(.crm-assignment-work-card + .crm-assignment-work-card)`, (bucket) => `[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-bucket[data-assignment-stage="${bucket.dataset.assignmentStage}"]`);
  const assignmentStackBefore = await page.$eval(`${assignmentStageSelector}`, (bucket) => { const cards = [...bucket.querySelectorAll('.crm-assignment-work-card')]; return { ids:cards.map((card) => card.dataset.assignmentCard), step:cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top }; });
  await page.evaluate((selector) => document.querySelector(`${selector} .crm-assignment-stack-toggle`)?.click(), assignmentStageSelector);
  await sleep(260);
  await check('Assignments can spread the exact same commitment stack outward', ({ selector, before }) => {
    const bucket = document.querySelector(selector); const cards = [...bucket.querySelectorAll('.crm-assignment-work-card')]; const step = cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top;
    return { ok:bucket.querySelector('.crm-assignment-stack-toggle')?.getAttribute('aria-expanded') === 'true' && JSON.stringify(cards.map((card) => card.dataset.assignmentCard)) === JSON.stringify(before.ids) && step > before.step + 45, detail:`${Math.round(before.step)}→${Math.round(step)}px` };
  }, { selector:assignmentStageSelector, before:assignmentStackBefore });
  await page.evaluate((selector) => document.querySelector(`${selector} .crm-assignment-stack-toggle`)?.click(), assignmentStageSelector);
  await sleep(260);

  const assignmentCardSelector = `${assignmentScope} .crm-assignment-bucket:has(.crm-assignment-work-card) .crm-assignment-work-card:last-child`;
  await page.evaluate((selector) => { const card = document.querySelector(selector); const rect = card?.getBoundingClientRect(); if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.right - 8, clientY:rect.top + 12 })); }, assignmentCardSelector);
  await page.waitForSelector('.crm-assignment-menu');
  await check('Assignment actions use the canonical compact menu, never a full-screen console', () => {
    const menu = document.querySelector('.crm-assignment-menu'); const reference = document.querySelector('.auth-profile-menu'); if (!menu || !reference) return false;
    const actual = getComputedStyle(menu); const expected = getComputedStyle(reference); const rect = menu.getBoundingClientRect();
    return rect.width < 200 && rect.height < 260 && menu.classList.contains('crm-menu-surface')
      && ['backgroundImage','backdropFilter','borderTopColor','borderRadius','boxShadow'].every((property) => actual[property] === expected[property]);
  });
  await page.click('.crm-assignment-menu .crm-menu-action');
  await page.waitForSelector('.crm-assignment-editor');
  await check('Assignment editing stays anchored, compact, and fully linked', () => {
    const editor = document.querySelector('.crm-assignment-editor'); const rect = editor?.getBoundingClientRect();
    return !!rect && rect.width <= 390 && rect.height < 430 && !!editor.querySelector('[name="assignee"]') && !!editor.querySelector('[name="target"]')
      && !!editor.querySelector('[name="stage"]') && !document.querySelector('.crm-record-scrim:not([hidden])');
  });
  await page.click('.crm-assignment-editor [data-cancel]');

  const assignmentCardTier = await page.$eval(assignmentCardSelector, (card) => { const rect=card.getBoundingClientRect(),face=card.querySelector('.crm-assignment-card-face')?.getBoundingClientRect(); return { id:card.dataset.assignmentCard, width:rect.width, height:rect.height, faceWidth:face?.width, faceHeight:face?.height, stage:card.closest('[data-assignment-stage]')?.dataset.assignmentStage, details:card.querySelectorAll('.crm-assignment-card-meta').length, note:card.querySelector('.crm-assignment-card-note')?.textContent || '' }; });
  await page.evaluate((selector) => { const card = document.querySelector(selector); const rect = card?.getBoundingClientRect(); if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.right - 8, clientY:rect.top + 12 })); }, assignmentCardSelector);
  await page.waitForSelector('.crm-assignment-menu');
  await page.evaluate(() => [...document.querySelectorAll('.crm-assignment-menu .crm-menu-action')].find((button) => button.textContent.trim().toLowerCase() === 'make small')?.click());
  await page.waitForFunction((before) => { const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(before.id)}"]`); const rect=card?.getBoundingClientRect(),face=card?.querySelector('.crm-assignment-card-face')?.getBoundingClientRect(); return card?.classList.contains('crm-object-small') && Math.abs(rect.width / before.width - .8) < .02 && Math.abs(rect.height / before.height - .8) < .02 && Math.abs(face.width / before.faceWidth - .8) < .02 && Math.abs(face.height / before.faceHeight - .8) < .02; }, {}, assignmentCardTier);
  await check('Assignment cards have a literal proportional Small tier with the complete face intact', (before) => {
    const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(before.id)}"]`); const rect = card?.getBoundingClientRect(); const face=card?.querySelector('.crm-assignment-card-face')?.getBoundingClientRect();
    return !!card && card.dataset.recordId === before.id && card.closest('[data-assignment-stage]')?.dataset.assignmentStage === before.stage
      && Number.parseFloat(getComputedStyle(card).scale) === 1 && card.offsetWidth === Math.round(rect.width)
      && Math.abs(rect.width / before.width - .8) < .015 && Math.abs(rect.height / before.height - .8) < .015
      && !!face && Math.abs(face.width / before.faceWidth - .8) < .015 && Math.abs(face.height / before.faceHeight - .8) < .015
      && card.querySelectorAll('.crm-assignment-card-meta').length === before.details && (card.querySelector('.crm-assignment-card-note')?.textContent || '') === before.note;
  }, assignmentCardTier);
  await page.evaluate((id) => { const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(id)}"]`); const rect = card?.getBoundingClientRect(); if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.right - 6, clientY:rect.top + 10 })); }, assignmentCardTier.id);
  await page.waitForSelector('.crm-assignment-menu');
  await page.evaluate(() => [...document.querySelectorAll('.crm-assignment-menu .crm-menu-action')].find((button) => button.textContent.trim().toLowerCase() === 'make large')?.click());
  await page.waitForFunction((id) => !document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(id)}"]`)?.classList.contains('crm-object-small'), {}, assignmentCardTier.id);

  const assignmentBucketTier = await page.$eval(`${assignmentScope} .crm-assignment-bucket:first-child`, (bucket) => { const rect=bucket.getBoundingClientRect(),shell=bucket.querySelector('.crm-assignment-bucket-shell')?.getBoundingClientRect(),card=bucket.querySelector('.crm-assignment-work-card')?.getBoundingClientRect(); return { width:rect.width, height:rect.height, shellWidth:shell?.width, shellHeight:shell?.height, cardWidth:card?.width, cardHeight:card?.height, ids:[...bucket.querySelectorAll('.crm-assignment-work-card')].map((item) => item.dataset.assignmentCard) }; });
  await page.evaluate(() => { const header = document.querySelector('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-bucket:first-child .tk-zone-hd'); const rect = header?.getBoundingClientRect(); if (header && rect) header.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.left + 30, clientY:rect.top + 12 })); });
  await page.waitForSelector('.crm-size-menu'); await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((before) => { const bucket = document.querySelector('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-bucket:first-child'); const rect=bucket?.getBoundingClientRect(),shell=bucket?.querySelector('.crm-assignment-bucket-shell')?.getBoundingClientRect(),card=bucket?.querySelector('.crm-assignment-work-card')?.getBoundingClientRect(); return bucket?.classList.contains('crm-object-small') && Math.abs(rect.width / before.width - .76) < .012 && Math.abs(rect.height / before.height - .76) < .012 && Math.abs(shell.width / before.shellWidth - .76) < .012 && Math.abs(shell.height / before.shellHeight - .76) < .012 && (!before.cardWidth || (Math.abs(card.width / before.cardWidth - .76) < .012 && Math.abs(card.height / before.cardHeight - .76) < .012)); }, {}, assignmentBucketTier);
  await check('Assignment buckets have the matching proportional Small cell without replacing commitments', (before) => {
    const bucket = document.querySelector('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-bucket:first-child'); const ids = [...bucket.querySelectorAll('.crm-assignment-work-card')].map((card) => card.dataset.assignmentCard); const rect=bucket?.getBoundingClientRect(),shell=bucket?.querySelector('.crm-assignment-bucket-shell')?.getBoundingClientRect(),card=bucket?.querySelector('.crm-assignment-work-card')?.getBoundingClientRect();
    return !!bucket && Number.parseFloat(getComputedStyle(bucket).scale) === 1 && JSON.stringify(ids) === JSON.stringify(before.ids)
      && Math.abs(rect.width / before.width - .76) < .015 && Math.abs(rect.height / before.height - .76) < .015
      && !!shell && Math.abs(shell.width / before.shellWidth - .76) < .015 && Math.abs(shell.height / before.shellHeight - .76) < .015
      && (!before.cardWidth || (!!card && Math.abs(card.width / before.cardWidth - .76) < .015 && Math.abs(card.height / before.cardHeight - .76) < .015));
  }, assignmentBucketTier);
  await page.evaluate(() => { const header = document.querySelector('[data-crm-theater="assignments"]:not([hidden]) .crm-assignment-bucket:first-child .tk-zone-hd'); const rect = header?.getBoundingClientRect(); if (header && rect) header.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.left + 30, clientY:rect.top + 12 })); });
  await page.waitForSelector('.crm-size-menu'); await page.click('.crm-size-menu .crm-menu-action');

  const createdAssignmentTitle = `Interaction assignment ${Date.now()}`;
  await page.click(`${assignmentScope} .crm-assignment-new`);
  await page.type('.crm-assignment-editor [name="title"]', createdAssignmentTitle);
  await page.select('.crm-assignment-editor [name="stage"]', 'active');
  await page.click('.crm-assignment-editor button[type="submit"]');
  await page.waitForFunction((title) => window.crmAssignments.items().some((item) => item.title === title), {}, createdAssignmentTitle);
  await check('Creating an assignment produces one commitment plus one workflow entry', async (title) => {
    const item = window.crmAssignments.items().find((candidate) => candidate.title === title); if (!item) return false;
    const flows = await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 });
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) [data-assignment-card="${CSS.escape(item.id)}"]`)]; const flow = flows.records.find((candidate) => candidate.recordId === item.id && candidate.workflowKey === 'assignments');
    return { ok:cards.length === 1 && flow?.stage === 'active' && cards[0].closest('[data-assignment-stage]')?.dataset.assignmentStage === 'active', detail:`${item.id} / ${flow?.id}` };
  }, createdAssignmentTitle);

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

  const workflowRooms = { pipeline: 4 };
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
    await check(`${key} keeps dormant corner controls hidden and exposes one quiet spread control per stage`, () => {
      const room = document.querySelector('[data-crm-theater]:not([hidden])');
      const controls = [...room.querySelectorAll('.tk-arrow, .tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
      const spreads = [...room.querySelectorAll('.tk-zone-spread')];
      return controls.some((element) => element.matches('.tk-stack-btn'))
        && controls.some((element) => element.matches('.tk-deck-trash'))
        && controls.every((element) => getComputedStyle(element).display === 'none')
        && spreads.length === room.querySelectorAll('.tk-zone').length
        && spreads.every((element) => getComputedStyle(element).display !== 'none' && element.getAttribute('aria-expanded') === 'false');
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
  await check('Tickets hides dormant corner controls and exposes stage stack expansion', () => {
    const room = document.querySelector('[data-crm-theater="tickets"]:not([hidden])');
    const controls = [...room.querySelectorAll('.tk-arrow, .tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
    const spreads = [...room.querySelectorAll('.tk-zone-spread')];
    return controls.some((element) => element.matches('.tk-stack-btn[aria-label="Create a ticket"]'))
      && controls.some((element) => element.matches('.tk-deck-trash'))
      && controls.every((element) => getComputedStyle(element).display === 'none')
      && spreads.length === 3 && spreads.every((element) => getComputedStyle(element).display !== 'none');
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
  const bucketBefore = await page.$eval(bucketSelector, (bucket) => ({
    width:bucket.getBoundingClientRect().width,
    ids:[...bucket.querySelectorAll('.tk-zcard')].map((card) => card.dataset.id),
  }));
  await page.click(`${bucketSelector} .tk-zone-hd`, { button: 'right' });
  await page.waitForSelector('.crm-size-menu');
  await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((selector, largeWidth) => {
    const bucket = document.querySelector(selector);
    return bucket?.classList.contains('crm-object-small') && bucket.getBoundingClientRect().width < largeWidth * .82
      && Number.parseFloat(getComputedStyle(bucket).scale) === 1;
  }, {}, bucketSelector, bucketBefore.width);
  await check('Right-click makes a genuinely smaller bucket cell without replacing its cards', ({ before }) => {
    const bucket = document.querySelector('[data-crm-theater="tickets"] .tk-zone.crm-object-small');
    if (!bucket) return false;
    const scale = Number.parseFloat(getComputedStyle(bucket).scale); const ids = [...bucket.querySelectorAll('.tk-zcard')].map((card) => card.dataset.id);
    const key = window.crmObjectSizing.keyOf(bucket, 'bucket'); const stored = JSON.parse(localStorage.getItem('crm-object-sizing-v1') || '{}');
    return {
      ok: bucket.dataset.crmObjectSize === 'small' && scale === 1 && bucket.offsetWidth === Math.round(bucket.getBoundingClientRect().width)
        && bucket.getBoundingClientRect().width < before.width * .82 && JSON.stringify(ids) === JSON.stringify(before.ids) && stored.buckets?.[key] === 'small',
      detail: `${bucket.dataset.crmObjectSize} / ${Math.round(before.width)}→${Math.round(bucket.getBoundingClientRect().width)}px / ${ids.length} cards / ${key}=${stored.buckets?.[key]}`,
    };
  }, { before:bucketBefore });
  await page.click(`${bucketSelector} .tk-zone-hd`, { button: 'right' });
  await page.waitForSelector('.crm-size-menu');
  await check('A Small bucket offers the inverse Large action in the same compact menu', () => document.querySelector('.crm-size-menu .crm-menu-action')?.textContent.trim().toLowerCase() === 'make large');
  await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('crm-object-small'), {}, bucketSelector);

  const zoneCardSelector = `${bucketSelector} .tk-zcard:last-child`;
  const zoneCardBefore = await page.$eval(zoneCardSelector, (card) => ({ id:card.dataset.id, width:card.getBoundingClientRect().width, stage:card.closest('.tk-zone')?.dataset.stage }));
  await page.click(zoneCardSelector, { button:'right' });
  await page.waitForSelector('.tk-menu [data-act="size"]');
  await page.click('.tk-menu [data-act="size"]');
  await page.waitForFunction((selector, largeWidth) => {
    const card = document.querySelector(selector); return card?.classList.contains('crm-object-small') && card.getBoundingClientRect().width < largeWidth * .82;
  }, {}, zoneCardSelector, zoneCardBefore.width);
  await check('Small cards reflow inside their existing stage instead of shrinking a compositor copy', ({ before }) => {
    const card = document.querySelector('[data-crm-theater="tickets"] .tk-zone .tk-zcard.crm-object-small');
    if (!card) return false; const rect = card.getBoundingClientRect(); const scale = getComputedStyle(card).scale;
    return { ok:card.dataset.id === before.id && card.closest('.tk-zone')?.dataset.stage === before.stage
      && card.offsetWidth === Math.round(rect.width) && rect.width < before.width * .85,
      detail:`${card.dataset.id} · ${Math.round(before.width)}→${Math.round(rect.width)}px · scale ${scale}` };
  }, { before:zoneCardBefore });
  await page.click(zoneCardSelector, { button:'right' });
  await page.waitForSelector('.tk-menu [data-act="size"]');
  await page.click('.tk-menu [data-act="size"]');
  await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('crm-object-small'), {}, zoneCardSelector);

  const collapsedStack = await page.$eval(bucketSelector, (bucket) => {
    const cards = [...bucket.querySelectorAll('.tk-zcard')];
    return { ids:cards.map((card) => card.dataset.id), step:cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top };
  });
  await page.click(`${bucketSelector} .tk-zone-spread`);
  await page.waitForFunction((selector) => document.querySelector(`${selector} .tk-zone-spread`)?.getAttribute('aria-expanded') === 'true', {}, bucketSelector);
  await check('The stage spread button expands the same stack outward without copying its objects', ({ selector, before }) => {
    const bucket = document.querySelector(selector); const cards = [...bucket.querySelectorAll('.tk-zcard')];
    const step = cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top;
    return { ok:JSON.stringify(cards.map((card) => card.dataset.id)) === JSON.stringify(before.ids) && step > before.step + 100
      && bucket.classList.contains('is-stack-expanded'), detail:`${Math.round(before.step)}→${Math.round(step)}px · ${cards.length} same cards` };
  }, { selector:bucketSelector, before:collapsedStack });
  await page.click(`${bucketSelector} .tk-zone-spread`);
  await page.waitForFunction((selector) => document.querySelector(`${selector} .tk-zone-spread`)?.getAttribute('aria-expanded') === 'false', {}, bucketSelector);

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

  await activate('planner');
  await check('Planner uses one established selector and aligned custom buckets', () => {
    const projects = [...document.querySelectorAll('.crm-planner-project')];
    const buckets = [...document.querySelectorAll('.crm-planner-bucket')];
    const plannerType = {
      heading: getComputedStyle(document.querySelector('.crm-planner-heading')).fontSize,
      buckets: [...new Set(buckets.map((bucket) => getComputedStyle(bucket.querySelector('.tk-zone-title')).fontSize))],
    };
    const snapshots = window.crmPlanner.projects();
    return { ok: projects.length >= 3 && buckets.length === 3
      && !document.querySelector('.crm-project-minimap,.crm-planner-universe')
      && projects.every((project) => {
        const snapshot = snapshots.find((item) => item.id === project.dataset.plannerProject);
        return !!project.querySelector('.crm-planner-project-name')
          && project.querySelectorAll('.crm-planner-project-segment').length === snapshot?.buckets.length
          && !project.querySelector('.tk-card,.crm-planner-card,.crm-planner-bucket');
      })
      && buckets.every((bucket) => bucket.classList.contains('tk-zone') && !!bucket.querySelector('.tk-zone-title'))
      && plannerType.heading === '17px'
      && plannerType.buckets.every((size) => size === '14px')
      && new Set(buckets.map((bucket) => Math.round(bucket.getBoundingClientRect().top))).size === 1,
      detail: JSON.stringify(plannerType) };
  });
  await page.click('[data-planner-action="new-project"]');
  await page.waitForSelector('.crm-planner-project-creator input[name="stages"]');
  await check('A new Planner project defines its initial pipeline in one compact action', () => {
    const form = document.querySelector('.crm-planner-project-creator');
    return !!form && form.classList.contains('crm-menu-surface') && form.elements.title
      && form.elements.stages.value === 'Backlog, In progress, Done' && form.getBoundingClientRect().width <= 300;
  });
  await page.type('.crm-planner-project-creator input[name="title"]', 'Interaction plan');
  await page.click('.crm-planner-popover button[type="submit"]');
  await page.waitForFunction(() => window.crmPlanner.projects().some((project) => project.title === 'Interaction plan'));
  await page.click('[data-planner-action="new-stage"]');
  await page.type('.crm-planner-popover input[name="value"]', 'Review');
  await page.click('.crm-planner-popover button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.crm-planner-bucket').length === 4);
  await page.click('.crm-planner-bucket:last-child [data-planner-action="new-card"]');
  await page.type('.crm-planner-popover input[name="value"]', 'Ship the polished flow');
  await page.click('.crm-planner-popover button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.crm-planner-card-title')].some((node) => node.textContent.trim() === 'Ship the polished flow'), { timeout:10000 });
  await page.click('.crm-planner-card');
  await page.waitForSelector('.crm-planner-item-editor select[name="stage"]', { timeout:10000 });
  await check('A Planner item can change stage, owner, priority, due date, and linked record in one compact editor', () => {
    const form = document.querySelector('.crm-planner-item-editor');
    return !!form && form.elements.stage.options.length === 4 && form.elements.assignee
      && form.elements.priority && form.elements.dueAt && form.elements.target && form.getBoundingClientRect().width < 400;
  });
  await page.click('.crm-planner-item-editor [data-cancel]');
  await check('Planner creates projects, custom buckets, and fully functional items', () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    const review = project?.buckets.find((bucket) => bucket.title === 'Review');
    const item = review?.cards.find((card) => card.title === 'Ship the polished flow');
    const commitment = item && window.crmHome?.handStatus?.();
    return { ok:!!project && project.buckets.length === 4 && !!item && item.entityType === 'workItems'
      && !!item.commitmentId && !!item.workflowEntryId && !!commitment
      && document.querySelectorAll(`.crm-planner-project[data-planner-project="${CSS.escape(project.id)}"] .crm-planner-project-segment[data-occupied="true"]`).length >= 1
      && !!document.querySelector('.crm-planner-card[data-record-entity="workItems"]'),
      detail:JSON.stringify({ project:!!project, buckets:project?.buckets.length, item:item && { entityType:item.entityType, commitmentId:item.commitmentId, workflowEntryId:item.workflowEntryId }, card:!!document.querySelector('.crm-planner-card[data-record-entity="workItems"]') }) };
  });
  const plannerStageMove = await page.evaluate(async () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    const review = project?.buckets.find((bucket) => bucket.title === 'Review');
    const done = project?.buckets.find((bucket) => bucket.kind === 'done');
    const item = review?.cards.find((card) => card.title === 'Ship the polished flow');
    if (!project || !review || !done || !item) return null;
    await window.crmPlanner.moveCard(item.id, done.id);
    const movedItem = (await window.crmStore.list('workItems', { includeDeleted:false })).records.find((record) => record.id === item.id);
    const commitment = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((record) => record.id === movedItem.commitmentId);
    const flow = (await window.crmDomain.list('workflow-entries', { includeDeleted:false, limit:1000 })).records.find((record) => record.recordId === item.id && record.workflowKey === `project:${project.id}`);
    const completed = { itemStage:movedItem.stageId, itemStatus:movedItem.status, commitmentStatus:commitment?.status, flowStage:flow?.stage };
    await window.crmPlanner.moveCard(item.id, review.id);
    return { ...completed, restored:window.crmPlanner.items().find((record) => record.id === item.id)?.stageId };
  });
  await check('Planner moves one real work object through its custom workflow and to-do', (state) => ({
    ok:!!state && state.itemStatus === 'completed' && state.commitmentStatus === 'completed'
      && state.itemStage === state.flowStage && state.restored && state.restored !== state.itemStage,
    detail:JSON.stringify(state),
  }), plannerStageMove);
  const plannerStackBefore = await page.$eval('.crm-planner-bucket:last-child', (bucket) => ({
    project:window.crmPlanner.selected(), stage:bucket.dataset.plannerBucket,
    ids:[...bucket.querySelectorAll('.crm-planner-card')].map((card) => card.dataset.plannerCard),
  }));
  await page.evaluate(() => document.querySelector('.crm-planner-bucket:last-child .crm-planner-stack-toggle')?.click());
  await page.waitForFunction(() => document.querySelector('.crm-planner-bucket:last-child .crm-planner-stack-toggle')?.getAttribute('aria-expanded') === 'true');
  await page.evaluate(() => {
    const current = window.crmPlanner.selected(); const other = window.crmPlanner.projects().find((project) => project.id !== current)?.id;
    if (other) window.crmPlanner.selectProject(other); window.crmPlanner.selectProject(current);
  });
  await check('Planner stage expansion persists with the project and retains the exact work objects', (before) => {
    const bucket = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(before.stage)}"]`);
    const ids = [...(bucket?.querySelectorAll('.crm-planner-card') || [])].map((card) => card.dataset.plannerCard);
    return !!bucket && bucket.querySelector('.crm-planner-stack-toggle')?.getAttribute('aria-expanded') === 'true'
      && window.crmPlanner.expandedStages().includes(`${before.project}:${before.stage}`) && JSON.stringify(ids) === JSON.stringify(before.ids);
  }, plannerStackBefore);
  await page.evaluate(() => document.querySelector('.crm-planner-bucket:last-child .crm-planner-stack-toggle')?.click());
  await page.waitForFunction(() => document.querySelector('.crm-planner-bucket:last-child .crm-planner-stack-toggle')?.getAttribute('aria-expanded') === 'false');
  await page.click('.crm-planner-bucket:last-child .tk-zone-hd', { button: 'right' });
  await page.waitForSelector('.crm-planner-context', { timeout:10000 });
  await check('Planner edits use a compact canonical anchored menu', () => {
    const menu = document.querySelector('.crm-planner-context');
    const reference = document.querySelector('.auth-profile-menu');
    if (!menu || !reference) return false;
    const actual = getComputedStyle(menu); const expected = getComputedStyle(reference);
    const rect = menu.getBoundingClientRect();
    return menu.classList.contains('crm-menu-surface') && rect.width < 200 && rect.height < 260
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
  await activate('home');
  await page.waitForFunction(() => window.crmHome?.handStatus?.().count > 0
    && document.querySelectorAll('.crm-home-hand-card.tk-card').length === window.crmHome?.handStatus?.().count, { timeout: 10000 });
  await check('The Home priority hand remains available beside the four worlds', () => window.crmHome.handStatus().count > 0);
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
