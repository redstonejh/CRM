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

  if (process.env.CRM_INTERACTION_HISTORY_ONLY === '1') {
    await activate('people');
    await page.waitForSelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]', { timeout: 10000 });
    await page.evaluate(() => {
      const original = window.crmPersonHistory.open;
      window.__personHistoryProbe = [];
      window.crmPersonHistory.open = (...args) => {
        const entry = { invokedAt:performance.now(), id:String(args[0] || '') };
        window.__personHistoryProbe.push(entry);
        const result = original(...args);
        Promise.resolve(result).then(
          (value) => Object.assign(entry, { settledAt:performance.now(), value }),
          (error) => Object.assign(entry, { settledAt:performance.now(), error:String(error?.message || error) }),
        );
        return result;
      };
      const card = document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles:true,
        cancelable:true,
        clientX:rect.left + 20,
        clientY:rect.top + 20,
        button:2,
      }));
    });
    await page.waitForSelector('.tk-menu .tk-menu-item[data-act^="custom-"]', { timeout: 5000 });
    const actionHit = await page.evaluate(() => {
      const action = document.querySelector('.tk-menu .tk-menu-item[data-act^="custom-"]');
      const rect = action?.getBoundingClientRect();
      const point = rect ? [rect.left + rect.width / 2, rect.top + rect.height / 2] : [0, 0];
      return {
        rect:rect && [rect.left, rect.top, rect.right, rect.bottom],
        point,
        onclick:typeof action?.onclick,
        stack:document.elementsFromPoint(...point).slice(0, 10).map((node) => ({
          tag:node.tagName,
          className:typeof node.className === 'string' ? node.className : '',
          pointerEvents:getComputedStyle(node).pointerEvents,
          zIndex:getComputedStyle(node).zIndex,
        })),
      };
    });
    console.log(`History action hit test — ${JSON.stringify(actionHit)}`);
    await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
    await sleep(3000);
    const probe = await page.evaluate(() => {
      const shell = document.querySelector('.crm-person-history-shell');
      return {
        calls:window.__personHistoryProbe,
        shell:!!shell,
        hidden:shell?.hidden,
        children:shell?.childElementCount,
        current:window.crmPersonHistory?.current?.(),
        open:window.crmPersonHistory?.isOpen?.(),
      };
    });
    const ok = probe.calls.length === 1 && probe.calls[0].settledAt && probe.open
      && probe.shell && !probe.hidden && probe.children > 0;
    console.log(`${ok ? ' ok ' : 'FAIL'} Conversation history menu action probe — ${JSON.stringify(probe)}`);
    if (errors.length) console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`);
    await browser.close();
    process.exit(ok && errors.length === 0 ? 0 : 1);
  }

  if (process.env.CRM_INTERACTION_TICKETS_ONLY === '1') {
    // First take Tickets through the real Home camera so its canonical owners
    // are released/parked on return, then reproduce the long-journey topology:
    // retained horizontal rooms must not steal the hit plane and the revisited
    // Tickets room must be promoted from that parked state.
    await page.evaluate(() => window.crmDeskTransit.driveTo('cases'));
    await page.waitForFunction(() => document.body.dataset.crmModule === 'cases'
      && !window.crmDeskTransit?.isBusy?.(), { timeout: 15000 });
    await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
    await page.waitForFunction(() => document.body.dataset.crmModule === 'home'
      && !window.crmDeskTransit?.isBusy?.(), { timeout: 15000 });
    await activate('assignments');
    await page.waitForSelector('[data-crm-theater="assignments"]:not([hidden]) .tk-zone-htrack', { timeout: 10000 });
    await activate('people');
    await page.waitForSelector('[data-crm-theater="people"]:not([hidden]) .tk-zone-htrack', { timeout: 10000 });
    await activate('pipeline');
    await activate('cases');
    const fanSelector = '[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left > .tk-arrow';
    await page.waitForSelector(fanSelector, { timeout: 10000 });
    const hitState = async (selector) => page.$eval(selector, (node) => {
      const rect = node.getBoundingClientRect();
      const point = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      return {
        rect:[rect.left, rect.top, rect.right, rect.bottom],
        point,
        stack:document.elementsFromPoint(...point).slice(0, 10).map((item) => ({
          tag:item.tagName,
          className:typeof item.className === 'string' ? item.className : '',
          pointerEvents:getComputedStyle(item).pointerEvents,
          zIndex:getComputedStyle(item).zIndex,
        })),
      };
    });
    const fanBefore = await hitState(fanSelector);
    await page.click(fanSelector);
    await sleep(600);
    const fanAfter = await page.evaluate(() => {
      const deck = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left');
      const arrow = deck?.querySelector(':scope > .tk-arrow');
      const cards = [...(deck?.querySelectorAll('.tk-card') || [])];
      const rects = cards.map((card) => card.getBoundingClientRect());
      return {
        fanned:deck?.classList.contains('is-fanned'),
        expanded:arrow?.getAttribute('aria-expanded'),
        span:rects.length ? Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left)) : 0,
        cardWidth:rects[0]?.width || 0,
        transforms:cards.slice(0, 3).map((card) => getComputedStyle(card).transform),
      };
    });
    const cardSelector = '[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left .tk-card';
    const cardHit = await hitState(cardSelector);
    console.log(`Tickets fan hit test — ${JSON.stringify({ fanBefore, fanAfter, cardHit })}`);
    const inactiveRailHit = fanBefore.stack.some((item) =>
      item.className.includes('tk-zone-htrack') || item.className.includes('tk-zone-hclip'));
    const ok = fanBefore.stack[0]?.className.includes('tk-arrow') && !inactiveRailHit
      && fanAfter.fanned && fanAfter.expanded === 'true' && fanAfter.span > fanAfter.cardWidth * 3;
    if (errors.length) console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`);
    await browser.close();
    process.exit(ok && errors.length === 0 ? 0 : 1);
  }

  if (process.env.CRM_INTERACTION_CALENDAR_ONLY === '1') {
    await activate('calendar');
    await page.waitForFunction(() => window.fractalCalendar?.level?.() === 0, { timeout: 10000 });
    const materialState = () => page.evaluate(() => {
      const describe = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        return {
          node:`${node.tagName}.${typeof node.className === 'string' ? node.className : ''}`,
          style:(node.getAttribute('style') || '').slice(0, 180),
          filter:style.webkitBackdropFilter || style.backdropFilter || '',
          variable:style.getPropertyValue('--bucket-acrylic-filter').trim(),
          opacity:style.opacity,
          visibility:style.visibility,
          display:style.display,
          clipPath:String(style.clipPath || '').slice(0, 120),
          ready:node.dataset.crmTileMaterialReady,
          count:node.dataset.crmTileMaterialCount,
          parked:node.dataset.crmTileMaterialParked,
        };
      };
      const surface = document.querySelector('[data-crm-theater="calendar"]');
      const root = surface?.querySelector('.fc-level[data-kind="year"]');
      const month = root?.querySelector(':scope > .fc-grid > .fc-month');
      const activeMonth = surface?.querySelector('.fc-expander[data-kind="month"]:not(.fc-warm)');
      const live = activeMonth?.querySelector(':scope > .fc-expander-live');
      return {
        level:window.fractalCalendar?.level?.(),
        surface:describe(surface),
        root:describe(root),
        month:describe(month),
        yearMaterial:describe(surface?.querySelector(':scope > .fc-year-screen-material-owner > .fc-calendar-year-material')),
        activeMonth:describe(activeMonth),
        live:describe(live),
        liveMaterial:describe(live?.querySelector(':scope > .crm-tile-material-plane')),
        dayScreenMaterial:describe(surface?.querySelector(':scope > .fc-day-screen-material-owner > .fc-day-screen-material')),
        allMaterials:[...(surface?.querySelectorAll('.crm-tile-material-plane') || [])].map(describe),
      };
    });
    const yearState = await materialState();
    const month = new Date().getMonth() + 1;
    await page.click(`[data-crm-theater="calendar"] .fc-month[data-month="${month}"]`);
    await page.waitForFunction(() => window.fractalCalendar?.level?.() === 1
      && !window.fractalCalendarCamera?.isTransitioning?.(), { timeout: 10000 });
    await sleep(200);
    const monthState = await materialState();
    console.log(`Calendar material probe — ${JSON.stringify({ yearState, monthState })}`);
    const ok = yearState.month?.filter === 'none'
      && yearState.yearMaterial?.ready === 'true'
      && yearState.yearMaterial?.count === '12'
      && yearState.yearMaterial?.filter.includes('blur(26px)')
      && monthState.liveMaterial?.filter === 'none'
      && monthState.dayScreenMaterial?.ready === 'true'
      && Number(monthState.dayScreenMaterial?.count) >= 28
      && monthState.dayScreenMaterial?.filter.includes('blur(26px)');
    if (errors.length) console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`);
    await browser.close();
    process.exit(ok && errors.length === 0 ? 0 : 1);
  }

  if (process.env.CRM_INTERACTION_HOME_TICKET_ONLY === '1') {
    await activate('home');
    const linked = await page.evaluate(async () => {
      const ticket = (await window.crmStore.list('tickets', { includeDeleted:false }))
        .records?.find((record) => record.id === 'tkt_bluepeak_mail');
      if (!ticket) return null;
      const result = await window.crmDomain.create('commitments', {
        title:'Home ticket handoff probe',
        kind:'ticket-work',
        status:'open',
        priority:'urgent',
        dueAt:new Date().toISOString(),
        links:[{ entityType:'tickets', recordId:ticket.id, relation:'regarding' }],
      });
      await window.crmHome.ensureHandReady();
      return result?.record ? { commitmentId:result.record.id, ticketId:ticket.id } : null;
    });
    if (!linked) throw new Error('Could not seed Home ticket handoff probe');
    const cardSelector = `.crm-home-hand-card[data-commitment-id="${linked.commitmentId}"]`;
    await page.waitForSelector(cardSelector, { timeout:10000 });
    await page.hover('.crm-home-hand-trigger');
    await sleep(420);
    await page.click(cardSelector);
    await page.waitForFunction(() => document.body.dataset.crmModule === 'cases'
      && !window.crmDeskTransit?.isBusy?.()
      && !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail'), { timeout:15000 });
    const result = await page.evaluate((ticketId) => {
      const selector = `[data-id="${CSS.escape(ticketId)}"]`;
      const native = document.querySelector(
        `[data-crm-theater="tickets"]:not([hidden]) .tk-zcard${selector},`
          + `[data-crm-theater="tickets"]:not([hidden]) .tk-deck .tk-card${selector}`,
      );
      const describe = (node) => node ? {
        node:`${node.tagName}.${typeof node.className === 'string' ? node.className : ''}`,
        hidden:node.hidden,
        inlineVisibility:node.style.visibility,
        visibility:getComputedStyle(node).visibility,
        opacity:getComputedStyle(node).opacity,
        display:getComputedStyle(node).display,
      } : null;
      return {
        native:describe(native),
        overlays:[...document.querySelectorAll('.ticket-detail-overlay')].map(describe),
        recordWorld:[...document.querySelectorAll('.record-world-shell')].map(describe),
        externalSources:[...document.querySelectorAll('.tk-external-source')].map(describe),
        veils:[...document.querySelectorAll('.crm-transit-veil')].map(describe),
        expanders:[...document.querySelectorAll('.crm-home-expander:not(.crm-home-warm)')].map(describe),
      };
    }, linked.ticketId);
    console.log(`Home ticket handoff probe — ${JSON.stringify(result)}`);
    const parkedExpanders = result.expanders.every((node) =>
      node.node.includes('crm-home-recycled-expander')
        && Number(node.opacity) <= .001);
    const ok = result.native?.inlineVisibility === 'hidden'
      && result.overlays.filter((node) => !node.hidden).length === 1
      && result.recordWorld.every((node) => node.hidden)
      && result.externalSources.length === 0
      && result.veils.length === 0
      && parkedExpanders;
    if (errors.length) console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`);
    await browser.close();
    process.exit(ok && errors.length === 0 ? 0 : 1);
  }

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
    const shared = document.querySelector('.crm-home-peripheral-screen-acrylic');
    const reference = document.querySelector('.auth-profile-menu');
    if (!surface || !shared || !reference) return false;
    const actual = getComputedStyle(surface);
    const sharedStyle = getComputedStyle(shared);
    const expected = getComputedStyle(reference);
    return ['backgroundImage', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'color']
      .every((property) => actual[property] === expected[property])
      && actual.backdropFilter === 'none'
      && sharedStyle.backdropFilter === expected.backdropFilter
      && Number(sharedStyle.opacity) > .99
      && actual.boxShadow !== expected.boxShadow && !actual.boxShadow.includes('42px');
  });
  await check('Non-top physical controls inherit the top geometry with one neutral acrylic material', () => {
    const controls = [...document.querySelectorAll('.crm-module-switch .crm-secondary-control')];
    const top = document.querySelector('.window-glass-control');
    if (controls.length !== 3 || !top) return false;
    const topStyle = getComputedStyle(top);
    return controls.every((control) => {
      const style = getComputedStyle(control);
      return style.width === topStyle.width && style.height === topStyle.height
        && style.borderRadius === topStyle.borderRadius
        && style.backgroundImage !== 'none'
        && style.backdropFilter.includes('blur')
        && !!control.querySelector(':scope > svg');
    })
      && [...document.querySelectorAll('.window-glass-control')].every((button) => !button.classList.contains('crm-secondary-control'))
      && [...document.querySelectorAll('.tk-card, .tk-zcard')].every((card) => !card.classList.contains('crm-menu-action') && !card.classList.contains('crm-menu-surface'));
  });
  await check('Viewport navigation no longer invents a separate Home backing shape', () => {
    const switcher = document.querySelector('.crm-module-switch');
    const backing = getComputedStyle(switcher, '::after');
    const controls = [...switcher.querySelectorAll('.crm-secondary-control')];
    return backing.content === 'none' && controls.length === 3
      && new Set(controls.map((control) => getComputedStyle(control).backgroundImage)).size === 1
      && new Set(controls.map((control) => getComputedStyle(control).borderRadius)).size === 1;
  });
  await check('Home has six inert screenshot LODs and no live miniature trees', () => ({
    ok: document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6
      && !document.querySelector('.crm-home-grid .crm-home-lod-scene,.crm-home-grid .crm-home-lod-root'),
    detail: `${document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length}/6 surfaces`,
  }));
  await check('Calendar and Monitoring are canonical Home workspace tiles', () => {
    const keys = ['people','cases','planner','assignments','calendar','monitoring'];
    const title = (key) => document.querySelector(`.crm-home-title-layer > .crm-home-title-slot[data-module="${key}"] .crm-home-title`);
    return keys.every((key) => document.querySelector(`.crm-home-bucket[data-module="${key}"]`))
      && !document.querySelector('.crm-home-bucket[data-module="pipeline"]')
      && !document.querySelector('.crm-home-bucket[data-module="jobs"],.crm-home-bucket[data-module="bills"],.crm-home-bucket[data-module="invoices"],.crm-home-bucket[data-module="desk"],.crm-home-bucket[data-module="money"]')
      && title('cases')?.textContent.trim() === 'Tickets'
      && title('planner')?.textContent.trim() === 'Projects'
      && title('assignments')?.textContent.trim() === 'Assignments'
      && title('calendar')?.textContent.trim() === 'Calendar'
      && title('monitoring')?.textContent.trim() === 'Monitoring';
  });
  await check('Monitoring owns two empty canonical child tile objects', () => {
    const graph = window.crmMonitoring?._objectGraph?.();
    const tiles = [...document.querySelectorAll(
      '[data-crm-theater="monitoring"] .crm-monitoring-grid > .crm-monitoring-tile',
    )];
    return graph?.objectKind === 'crm-tile-object'
      && graph.children.length === 2
      && tiles.length === 2
      && graph.children.every((object, index) => (
        object.objectKind === 'crm-tile-object'
        && object.tile.kind === 'monitoring-tile'
        && object.data.empty === true
        && object.children.length === 0
        && tiles[index]?.dataset.crmTileInstance === 'viewport'
        && tiles[index]?.dataset.monitoringEmpty === 'true'
        && window.crmMonitoring._objectForElement(tiles[index]) === object
        && tiles[index].childElementCount === 0
      ));
  });
  await check('Home has no calendar control', () => {
    const control = document.querySelector('.crm-viewport-date');
    const style = control && getComputedStyle(control);
    return !!control && control.hidden && style.visibility === 'hidden'
      && Number(style.opacity) === 0 && style.pointerEvents === 'none';
  });
  await check('Legacy status company tabs never mount inside the CRM shell', () => (
    document.body.dataset.appShell === 'crm'
      && !document.querySelector('.company-tab-bar')
      && document.querySelector('.workspace-tab-bar')?.hidden === true
  ));
  await check('Every Home preview is a proportional viewport of its destination', () => {
    const expected = innerWidth / innerHeight;
    const tiles = [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')].map((tile) => {
      const rect = tile.getBoundingClientRect(); return { width:rect.width, height:rect.height, ratio:rect.width / rect.height };
    });
    const widths = tiles.map((tile) => tile.width); const heights = tiles.map((tile) => tile.height);
    return tiles.length === 6 && tiles.every((tile) => Math.abs(tile.ratio - expected) <= .01)
      && Math.max(...widths) - Math.min(...widths) < 1 && Math.max(...heights) - Math.min(...heights) < 1;
  });
  await check('Home tile titles use a sharp live type layer', () => {
    const titles = [...document.querySelectorAll('.crm-home-title-layer > .crm-home-title-slot .crm-home-title')];
    return titles.length === 6 && titles.every((title) => {
      const style = getComputedStyle(title);
      return style.fontSize === '16px' && style.fontWeight === '650'
        && style.fontFamily.includes('Segoe UI Variable Text') && !style.textShadow.includes('12px')
        && !title.closest('.crm-home-bucket');
    }) && getComputedStyle(document.querySelector('.crm-home-level')).willChange.includes('transform');
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
  await check('Home cannot create independent to-dos', () => !document.querySelector('.crm-home-todo-add,.crm-home-todo-toolbar')
    && typeof window.crmHome.createTodo === 'undefined');
  const linkedHomeTodo = await page.evaluate(async () => {
    const task = (await window.crmStore.list('tasks', { includeDeleted:false })).records?.[0];
    const ticket = (await window.crmStore.list('tickets', { includeDeleted:false })).records?.find((record) => record.id === 'tkt_bluepeak_mail');
    if (!task || !ticket) return null;
    const session = await window.auth?.session?.().catch?.(() => null);
    const linked = await window.crmDomain.create('commitments', { title:'Home linked assignment contract', kind:'assignment', assignmentStage:'active', assignee:session?.user?.username || 'rosa', status:'open', priority:'urgent', dueAt:new Date().toISOString(), links:[{ entityType:'tasks', recordId:task.id, relation:'assignment-context' }] });
    const ticketLinked = await window.crmDomain.create('commitments', { title:'Home linked ticket contract', kind:'ticket-work', status:'open', priority:'urgent', dueAt:new Date().toISOString(), links:[{ entityType:'tickets', recordId:ticket.id, relation:'regarding' }] });
    const orphan = await window.crmDomain.create('commitments', { title:'Orphan Home task contract', kind:'task', status:'open', priority:'urgent', dueAt:new Date().toISOString() });
    const future = new Date(); future.setDate(future.getDate() + 3);
    const futureLinked = await window.crmDomain.create('commitments', { title:'Future linked work contract', kind:'task', status:'open', priority:'urgent', dueAt:future.toISOString(), links:[{ entityType:'tasks', recordId:task.id, relation:'regarding' }] });
    const distant = new Date(); distant.setDate(distant.getDate() + 9);
    const distantLinked = await window.crmDomain.create('commitments', { title:'Distant linked work contract', kind:'task', status:'open', priority:'urgent', dueAt:distant.toISOString(), links:[{ entityType:'tasks', recordId:task.id, relation:'regarding' }] });
    await window.crmHome.ensureHandReady();
    return linked?.record && ticketLinked?.record && orphan?.record && futureLinked?.record && distantLinked?.record
      ? { id:linked.record.id, taskId:task.id, ticketId:ticket.id, ticketCommitmentId:ticketLinked.record.id, orphanId:orphan.record.id, futureId:futureLinked.record.id, distantId:distantLinked.record.id } : null;
  });
  if (!linkedHomeTodo) throw new Error('Could not create linked-work Home contract records');
  await page.waitForFunction((id) => !!document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(id)}"]`), { timeout:10000 }, linkedHomeTodo.id);
  await check('Home hand projects due linked assignments instead of creating an Assignments filter', (todo) => {
    const cards = [...document.querySelectorAll('.crm-home-hand-card')];
    const created = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.id)}"]`);
    const ticket = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.ticketCommitmentId)}"]`);
    const orphan = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.orphanId)}"]`);
    const future = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.futureId)}"]`);
    const distant = document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(todo.distantId)}"]`);
    const seededTicket = document.querySelector('.crm-home-hand-card[data-commitment-id="legacy_commitment_tasks_tk_clear_bluepeak_queue"]');
    const status = window.crmHome.handStatus();
    return !document.querySelector('.crm-home-todo-toolbar,.crm-home-todo-add') && !orphan && !!future && !distant
      && cards.length > 0 && cards.every((card) => card.dataset.commitmentId && card.dataset.recordEntity && card.dataset.recordId && !card.dataset.commitmentId.startsWith('signal:'))
      && status.targets.length === cards.length && status.targets.every((target) => target?.entityType && target?.recordId)
      && created?.dataset.recordEntity === 'tasks' && created?.dataset.recordId === todo.taskId
      && future?.dataset.recordEntity === 'tasks' && future?.dataset.recordId === todo.taskId
      && ticket?.dataset.recordEntity === 'tickets' && ticket?.dataset.recordId === todo.ticketId
      && seededTicket?.dataset.recordEntity === 'tickets' && seededTicket?.dataset.recordId === 'tkt_bluepeak_mail';
  }, linkedHomeTodo);
  await page.click(`.crm-home-hand-card[data-commitment-id="${linkedHomeTodo.id}"]`, { button:'right' });
  await page.waitForSelector('.crm-home-todo-menu [data-todo-action="edit"]', { timeout:10000 });
  await check('A linked to-do menu contains only direct task actions', () => !!document.querySelector('[data-todo-action="edit"]')
    && !!document.querySelector('[data-todo-action="open"]') && !!document.querySelector('[data-todo-action="complete"]')
    && !document.querySelector('[data-todo-action="assignments"]'));
  await page.click('.crm-home-todo-menu [data-todo-action="edit"]');
  await page.waitForSelector('.crm-home-todo-popover input[name="title"]', { timeout:10000 });
  await check('Home editing cannot alter the source relationship', () => {
    const form = document.querySelector('.crm-home-todo-popover');
    return form?.getAttribute('aria-label') === 'Edit linked task' && !form.elements.target
      && form.elements.title.value === 'Home linked assignment contract' && [...form.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'));
  });
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
    const hand = document.querySelector('.crm-home-priority-hand');
    const trigger = hand?.querySelector('.crm-home-hand-trigger');
    const cards = [...document.querySelectorAll('.crm-home-hand-card.tk-card')];
    const rects = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        top:rect.top,
        bottom:rect.bottom,
        height:rect.height,
        offsetHeight:card.offsetHeight,
        transform:style.transform,
        openY:style.getPropertyValue('--hand-open-y'),
        restY:style.getPropertyValue('--hand-rest-y'),
      };
    });
    const triggerRect = trigger?.getBoundingClientRect();
    const triggerCenter = triggerRect
      ? [triggerRect.left + triggerRect.width / 2, triggerRect.top + triggerRect.height / 2]
      : [0, 0];
    const hitStack = document.elementsFromPoint(...triggerCenter).slice(0, 8).map((node) => ({
      tag:node.tagName,
      className:typeof node.className === 'string' ? node.className : '',
      pointerEvents:getComputedStyle(node).pointerEvents,
      zIndex:getComputedStyle(node).zIndex,
    }));
    return { ok:cards.length > 0 && rects.every((rect) => rect.top > 0 && rect.bottom <= innerHeight + 1)
      && Math.min(...rects.map((rect) => rect.top)) < innerHeight - 150,
      detail:JSON.stringify({
        handHovered:hand?.matches(':hover'),
        triggerHovered:trigger?.matches(':hover'),
        triggerRect:triggerRect && [triggerRect.left, triggerRect.top, triggerRect.right, triggerRect.bottom],
        triggerCenter,
        hitStack,
        rects,
      }) };
  });
  if (process.env.CRM_INTERACTION_HOME_ONLY === '1') {
    if (errors.length) { console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`); failures++; }
    console.log(`\nHome interaction contract: ${failures ? `${failures} failure(s)` : 'PASSED'}.`);
    await browser.close();
    process.exit(failures ? 1 : 0);
  }
  await page.evaluate(() => { window.__homeHandTargetTop = document.querySelector('.crm-home-hand-card.tk-card')?.getBoundingClientRect().top || 0; });
  await page.hover('.crm-home-hand-card.tk-card');
  await sleep(360);
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
      return image.dataset.previewVariant === 'filtered' && filter.includes('blur(0.65px)')
        && filter.includes('saturate(0.95)') && filter.includes('brightness(0.88)');
    })
      && !document.querySelector('.crm-home-grid .crm-home-preview-sharp');
  });
  await page.hover('.crm-home-bucket[data-module="people"]');
  await sleep(220);
  await check('Hover arms the sharp preview state and de-emphasizes its title', () => {
    const tile = document.querySelector('.crm-home-grid > .crm-home-bucket[data-module="people"]');
    const foreground = tile?.querySelector('.crm-home-preview-foreground');
    const title = document.querySelector('.crm-home-title-layer > .crm-home-title-slot[data-module="people"] .crm-home-title-glass');
    const filter = foreground && getComputedStyle(foreground).filter;
    const titleStyle = title && getComputedStyle(title);
    const blur = Number(filter?.match(/blur\(([-+\deE.]+)px\)/)?.[1]);
    const saturation = Number(filter?.match(/saturate\(([-+\deE.]+)\)/)?.[1]);
    const stateArmed = tile?.classList.contains('is-preview-hovered')
      && title?.closest('.crm-home-title-slot')?.classList.contains('is-deemphasized');
    const filterIsValid = blur <= .12 && saturation >= .956;
    const opacityIsValid = (Number(titleStyle.opacity) >= .23 && Number(titleStyle.opacity) < .33)
      || Number(titleStyle.opacity) === .94;
    const ok = !!foreground && !!title && stateArmed && filterIsValid && opacityIsValid
      && !tile.querySelector('.crm-home-preview-sharp')
      && titleStyle.left === '17px' && titleStyle.bottom === '30px';
    return { ok, detail:JSON.stringify({ filter, blur, saturation, opacity:titleStyle?.opacity, left:titleStyle?.left, bottom:titleStyle?.bottom,
      hovered:tile?.matches(':hover'), previewHovered:tile?.classList.contains('is-preview-hovered'),
      titleDeemphasized:title?.closest('.crm-home-title-slot')?.classList.contains('is-deemphasized') }) };
  });
  await page.evaluate(() => document.querySelectorAll('[data-interaction-style-probe]').forEach((probe) => probe.remove()));
  await page.evaluate(() => {
    window.__deskTransitionErrors = [];
    document.addEventListener('crm:desk-transit-error', (event) => {
      window.__deskTransitionErrors.push(event.detail);
    });
    const selectedTile = document.querySelector('.crm-home-bucket[data-module="people"]');
    const selected = selectedTile?.getBoundingClientRect();
    const neighbor = document.querySelector('.crm-home-bucket[data-module="cases"]')?.getBoundingClientRect();
    const material = selectedTile && getComputedStyle(selectedTile);
    const sharedNode = document.querySelector('.crm-home-peripheral-screen-acrylic');
    const sharedMaterial = sharedNode ? getComputedStyle(sharedNode) : material;
    window.__homeAcrylicMaterial = material ? {
      backgroundColor:material.backgroundColor,
      backgroundImage:material.backgroundImage,
      backdropFilter:(material.webkitBackdropFilter || material.backdropFilter) !== 'none'
        ? (material.webkitBackdropFilter || material.backdropFilter)
        : (sharedMaterial.webkitBackdropFilter || sharedMaterial.backdropFilter),
      borderColor:material.borderColor,
      borderStyle:material.borderStyle,
      boxShadow:material.boxShadow,
    } : null;
    window.__homeSpatialRelation = selected && neighbor ? {
      dx: (neighbor.left - selected.left) / selected.width,
      dy: (neighbor.top - selected.top) / selected.height,
      wr: neighbor.width / selected.width,
      hr: neighbor.height / selected.height,
    } : null;
    window.__homeEndpointAcrylicGate = {};
    window.__crmDeskTransitProbe = {
      hold(phase, detail) {
        if (!['endpoint-material-blend-mid', 'covered'].includes(phase)) return undefined;
        return new Promise((resolve) => {
          window.__homeEndpointAcrylicGate = { phase, detail, resolve };
        });
      },
    };
  });
  await page.click('.crm-home-bucket[data-module="people"]');
  await sleep(100);
  await check('Home-to-room handoff remains inside the original camera', () => document.body.dataset.crmModule === 'home'
    && window.crmHomeCamera?.isTransitioning?.()
    && !window.crmHomeCamera?.surface?.()?.hidden
    && !document.documentElement.classList.contains('crm-transit-materializing')
    && !!document.querySelector('.crm-home-expander:not(.crm-home-warm)'));
  await check('The moving tile keeps one acrylic coat over the shared wallpaper', () => {
    const expander = document.querySelector('.crm-home-expander:not(.crm-home-warm)');
    const frame = expander?.querySelector(':scope > .crm-home-transition-acrylic');
    const acrylic = document.querySelector('.crm-home-surface .crm-home-screen-acrylic');
    const exact = expander?.querySelector('.crm-home-preview-exact');
    const style = acrylic && getComputedStyle(acrylic);
    const acrylicHost = acrylic?.parentElement?.classList.contains('crm-home-screen-acrylic-clip') ? acrylic.parentElement : acrylic;
    const hostStyle = acrylicHost && getComputedStyle(acrylicHost);
    const frameStyle = frame && getComputedStyle(frame);
    const exactStyle = exact && getComputedStyle(exact);
    const sharedAcrylic = document.querySelector('.crm-home-peripheral-screen-acrylic');
    const sharedStyle = sharedAcrylic && getComputedStyle(sharedAcrylic);
    const transform = hostStyle?.transform && hostStyle.transform !== 'none' ? new DOMMatrix(hostStyle.transform) : new DOMMatrix();
    const status = window.crmHome?.motionStatus?.();
    const source = window.__homeAcrylicMaterial;
    const selectedMaterial = style?.webkitBackdropFilter || style?.backdropFilter || '';
    const sharedMaterial = sharedStyle?.webkitBackdropFilter || sharedStyle?.backdropFilter || '';
    const delegatedMaterial = acrylic?.dataset?.crmAcrylicBackdropOwner === 'shared'
      && Number(sharedStyle?.opacity || 0) > .99
      && sharedMaterial === source?.backdropFilter;
    const exactMaterial = !!style && !!source
      && style.backgroundColor === source.backgroundColor && style.backgroundImage === source.backgroundImage
      && (selectedMaterial === source.backdropFilter || delegatedMaterial);
    const exactFrame = !!frameStyle && !!source
      && frameStyle.borderColor === source.borderColor && frameStyle.borderStyle === source.borderStyle
      && frameStyle.boxShadow === source.boxShadow;
    const state = { ready:status?.ready, materialMode:status?.materialMode, background:style?.backgroundImage,
      backdrop:style?.backdropFilter, opacity:Number(style?.opacity || 0), wallpapers:document.querySelectorAll('body > .workspace-photo-backdrop:not([hidden])').length,
      exact:!!exact, exactOpacity:exactStyle ? Number(exactStyle.opacity) : null, foregrounds:expander?.querySelectorAll('.crm-home-preview-foreground').length || 0,
      exactMaterial, delegatedMaterial, sharedMaterial, exactFrame, acrylicState:window.crmHome?.acrylicState?.(), source, clip:hostStyle?.clipPath, screenScale:[transform.a,transform.d],
      transformedFrame:{ background:frameStyle?.backgroundImage, backdrop:frameStyle?.backdropFilter } };
    return { ok:!!style && (!status?.ready || status.materialMode === 'live-peripheral-acrylic')
      && exactMaterial && exactFrame && Number(style.opacity) > .99
      && (selectedMaterial.includes('blur(') || delegatedMaterial)
      && (selectedMaterial.includes('saturate(') || delegatedMaterial)
      && window.crmHome?.acrylicState?.().phase === 'motion'
      && Number(frameStyle?.opacity) > .99
      && Number(getComputedStyle(expander).opacity) > .99 && !expander.style.transition.includes('opacity')
      && acrylicHost?.parentElement === window.crmHomeCamera?.surface?.() && Math.abs(transform.a-1)<.001 && Math.abs(transform.d-1)<.001
      && hostStyle?.clipPath.startsWith('inset(') && frameStyle?.backgroundImage === 'none' && frameStyle?.backdropFilter === 'none'
      && document.querySelectorAll('body > .workspace-photo-backdrop:not([hidden])').length === 1
      && !exact && (!status?.ready || expander.querySelectorAll('.crm-home-preview-foreground').length === 1)
      , detail:JSON.stringify(state) };
  });
  await check('Every non-focused Home tile keeps one real screen-space acrylic plane during zoom-in', () => {
    const surface = window.crmHomeCamera?.surface?.();
    const acrylic = surface?.querySelector('.crm-home-peripheral-screen-acrylic');
    const clipHost = acrylic?.parentElement;
    const style = acrylic && getComputedStyle(acrylic);
    const hostStyle = clipHost && getComputedStyle(clipHost);
    const matrix = style?.transform && style.transform !== 'none' ? new DOMMatrix(style.transform) : new DOMMatrix();
    const state = window.crmHome?.peripheralAcrylicState?.();
    const motion = window.crmHome?.motionStatus?.();
    const material = style?.webkitBackdropFilter || style?.backdropFilter || '';
    const liveNeighbors = [...(window.crmHomeCamera?.layers?.()[0]?.querySelectorAll('.crm-home-bucket:not(.is-camera-target)') || [])];
    const liveFallback = !motion?.ready && liveNeighbors.length === 5 && liveNeighbors.every((bucket) => {
      const bucketStyle = getComputedStyle(bucket);
      const bucketMaterial = bucketStyle.webkitBackdropFilter || bucketStyle.backdropFilter || '';
      return bucketStyle.visibility !== 'hidden' && bucketMaterial.includes('blur(') && bucketMaterial.includes('saturate(');
    });
    const clippedPlane = !!acrylic && clipHost?.parentElement === surface
      && surface.classList.contains('crm-home-peripheral-acrylic-active')
      && state?.active && state.phase === 'motion' && state.direction === 'expand' && state.neighborCount === 5
      && Number(style.opacity) > .99 && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none'
      && material.includes('blur(') && material.includes('saturate(')
      && hostStyle?.clipPath.startsWith('path(')
      && Math.abs(matrix.a - 1) < .001 && Math.abs(matrix.d - 1) < .001;
    return { ok:motion?.ready ? clippedPlane : liveFallback,
      detail:JSON.stringify({ motion, state, liveFallback, opacity:Number(style?.opacity || 0), material, clip:hostStyle?.clipPath,
        screenScale:[matrix.a,matrix.d], active:surface?.classList.contains('crm-home-peripheral-acrylic-active') }) };
  });
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
  await check('Tile transition preserves the unobstructed native title-bar drag region', () => {
    const strip = document.querySelector('.app-window-drag-region');
    const lid = document.querySelector('.crm-home-expander:not(.crm-home-warm)');
    const x = Math.round(innerWidth * .4), y = 20;
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
  try {
    await page.waitForFunction(() => {
      const bridge = document.querySelector('body > .crm-home-endpoint-bridge');
      const opacity = bridge ? Number(getComputedStyle(bridge).opacity) : 0;
      return window.__homeEndpointAcrylicGate?.phase === 'endpoint-material-blend-mid'
        && opacity > .08 && opacity < .98;
    }, { timeout:5000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const bridge = document.querySelector('body > .crm-home-endpoint-bridge');
      const animations = bridge?.getAnimations?.().map((animation) => ({
        currentTime:animation.currentTime,
        playState:animation.playState,
        timing:animation.effect?.getComputedTiming?.(),
      })) || [];
      return {
        gate:window.__homeEndpointAcrylicGate,
        cover:window.crmDeskTransit?.coverState?.(),
        opacity:bridge ? Number(getComputedStyle(bridge).opacity) : 0,
        bridge:bridge?.dataset,
        animations,
      };
    });
    throw new Error(`Endpoint material midpoint did not arrive: ${JSON.stringify(diagnostic)} (${error.message})`);
  }
  await check('Viewport navigation rises into place before the tile finishes landing', () => {
    const navigation = document.querySelector('.crm-module-switch');
    const style = navigation && getComputedStyle(navigation);
    const rect = navigation?.getBoundingClientRect();
    const animation = navigation?.getAnimations?.().find((candidate) =>
      (candidate.effect?.getKeyframes?.() || []).some((keyframe) => keyframe.transform));
    const keyframes = animation?.effect?.getKeyframes?.() || [];
    const duration = Number(animation?.effect?.getComputedTiming?.().duration);
    const cover = window.crmDeskTransit?.coverState?.();
    const startLead = Number(cover?.expectedMotionEndAt) - Number(cover?.navigationEntranceStartedAt);
    return {
      ok:navigation?.hidden === true
        && navigation.inert === true
        && navigation.hasAttribute('data-crm-transit-nav-entering')
        && style?.display === 'grid'
        && Number(style?.opacity) > .99
        && !!rect && rect.top < innerHeight && rect.bottom <= innerHeight + 1
        && duration === 210
        && keyframes.length >= 2
        && keyframes[0]?.transform !== keyframes.at(-1)?.transform
        && cover?.navigationEntranceLead === 260
        && startLead >= 0 && startLead <= 260,
      detail:JSON.stringify({
        hidden:navigation?.hidden,
        inert:navigation?.inert,
        entering:navigation?.hasAttribute('data-crm-transit-nav-entering'),
        rect:[rect?.x,rect?.y,rect?.width,rect?.height],
        opacity:Number(style?.opacity),
        duration,
        startLead,
        keyframes:keyframes.map((keyframe) => keyframe.transform),
      }),
    };
  });
  await check('The seated tile surface dissolves gradually into one complete destination acrylic composition', () => {
    const expanders = [...document.querySelectorAll(
      '.crm-home-surface > .crm-home-expander:not(.crm-home-warm):not(.crm-home-recycled-expander):not(.crm-home-prebuilt-expander)',
    )];
    const expander = expanders.at(-1);
    const frame = expander?.querySelector(':scope > .crm-home-transition-acrylic');
    const acrylic = document.querySelector('.crm-home-surface .crm-home-screen-acrylic');
    const surface = expander?.closest('.crm-home-surface');
    const sourceRasters = [...(expander?.querySelectorAll(
      '.crm-home-preview-exact, .crm-home-endpoint-fallback',
    ) || [])];
    const bridge = document.querySelector('body > .crm-home-endpoint-bridge');
    const rect = expander?.getBoundingClientRect();
    const acrylicStyle = acrylic && getComputedStyle(acrylic);
    const frameStyle = frame && getComputedStyle(frame);
    const bridgeStyle = bridge && getComputedStyle(bridge);
    const animation = bridge?.getAnimations?.().find((candidate) =>
      (candidate.effect?.getKeyframes?.() || []).some((keyframe) => keyframe.opacity != null));
    const keyframes = animation?.effect?.getKeyframes?.() || [];
    const duration = Number(animation?.effect?.getComputedTiming?.().duration);
    const bridgeOpacity = Number(bridgeStyle?.opacity);
    const bridgeZ = Number(bridgeStyle?.zIndex);
    const surfaceZ = Number(surface ? getComputedStyle(surface).zIndex : NaN);
    const cover = window.crmDeskTransit?.coverState?.();
    const blendLead = Number(cover?.expectedMotionEndAt) - Number(cover?.endpointBlendStartedAt);
    const configuredBlendLead = Number(cover?.endpointMaterialLead);
    const motion = window.crmDeskTransit?.motionState?.();
    const acrylicState = window.crmHome?.acrylicState?.();
    const material = acrylicStyle?.webkitBackdropFilter || acrylicStyle?.backdropFilter || '';
    const sourceRasterState = sourceRasters.map((raster) => {
      const style = getComputedStyle(raster);
      return {
        mode:raster.classList.contains('crm-home-preview-exact') ? 'exact' : 'fallback',
        display:style.display,
        visibility:style.visibility,
      };
    });
    const sourceRasterParked = sourceRasterState.every(({ mode, display, visibility }) =>
      mode === 'exact' ? display === 'none' : visibility === 'hidden');
    const endpointDelta = rect
      ? Math.max(
        Math.abs(rect.left),
        Math.abs(rect.top),
        Math.abs(rect.width - innerWidth),
        Math.abs(rect.height - innerHeight),
      )
      : Infinity;
    return {
      ok:!!rect
        // The destination bridge begins before the camera's last sub-pixel of
        // travel. At 1600px wide that overlap can leave ~1px of eased motion
        // while the bridge is deliberately sampled mid-fade.
        && endpointDelta <= 2
        && ((motion?.active === true && acrylicState?.phase === 'motion')
          || (motion?.active === false && acrylicState?.phase === 'endpoint-held'))
        && Number(acrylicStyle?.opacity) > .99 && Number(frameStyle?.opacity) > .99
        && material.includes('blur(') && material.includes('saturate(')
        && bridgeOpacity > .08 && bridgeOpacity < .98
        && bridgeZ > surfaceZ
        && duration === 180
        && Number(keyframes[0]?.opacity) <= .001
        && Number(keyframes.at(-1)?.opacity) === 1
        && configuredBlendLead === 220
        && Number(cover?.endpointBlendStartedAt) < Number(cover?.expectedMotionEndAt)
        && Math.abs(blendLead - configuredBlendLead) <= 25
        && sourceRasterParked,
      detail:JSON.stringify({
        rect:[rect?.x,rect?.y,rect?.width,rect?.height],
        endpointDelta,
        bridgeOpacity,
        zOrder:[surfaceZ,bridgeZ],
        duration,
        blendLead,
        keyframes:keyframes.map((keyframe) => ({ offset:keyframe.computedOffset, opacity:keyframe.opacity })),
        acrylicOpacity:Number(acrylicStyle?.opacity),
        frameOpacity:Number(frameStyle?.opacity),
        material,
        motion,
        acrylicState,
        sourceRasters:sourceRasterState,
      }),
    };
  });
  await page.evaluate(() => {
    const gate = window.__homeEndpointAcrylicGate;
    window.__homeEndpointAcrylicGate = {};
    gate?.resolve?.();
  });
  await page.waitForFunction(() => {
    const lens = document.querySelector('.crm-home-surface .crm-home-screen-acrylic');
    return window.__homeEndpointAcrylicGate?.phase === 'covered'
      && window.crmHome?.acrylicState?.().phase === 'endpoint-held'
      && lens && Number(getComputedStyle(lens).opacity) > .99;
  }, { timeout:5000 });
  await check('Acrylic remains fully composited after the tile seats until an opaque endpoint owns the viewport', () => {
    const expander = document.querySelector('.crm-home-expander:not(.crm-home-warm)');
    const frame = expander?.querySelector(':scope > .crm-home-transition-acrylic');
    const acrylic = document.querySelector('.crm-home-surface .crm-home-screen-acrylic');
    const bridge = document.querySelector('body > .crm-home-endpoint-bridge');
    const rect = expander?.getBoundingClientRect();
    const style = acrylic && getComputedStyle(acrylic);
    const frameStyle = frame && getComputedStyle(frame);
    const bridgeStyle = bridge && getComputedStyle(bridge);
    const opacity = Number(style?.opacity);
    const frameOpacity = Number(frameStyle?.opacity);
    const material = style?.webkitBackdropFilter || style?.backdropFilter || '';
    const motion = window.crmDeskTransit?.motionState?.();
    const acrylicState = window.crmHome?.acrylicState?.();
    return { ok:!!rect && Math.abs(rect.left) <= .5 && Math.abs(rect.top) <= .5
      && Math.abs(rect.width - innerWidth) <= .5 && Math.abs(rect.height - innerHeight) <= .5
      && motion?.active === false && acrylicState?.phase === 'endpoint-held'
      && opacity > .99 && frameOpacity > .99
      && Number(bridgeStyle?.opacity) === 1
      && material.includes('blur(') && material.includes('saturate('),
      detail:JSON.stringify({ rect:[rect?.x,rect?.y,rect?.width,rect?.height], opacity, frameOpacity,
        bridgeOpacity:Number(bridgeStyle?.opacity), material, motion, acrylicState }) };
  });
  await page.evaluate(() => {
    window.peopleCards.scrollZonesBy(-100000, true);
    window.__bufferedEntryWheel = { events:[], ready:null };
    window.addEventListener('wheel', (event) => queueMicrotask(() => {
      window.__bufferedEntryWheel.events.push({
        prevented:event.defaultPrevented,
        module:document.body.dataset.crmModule,
        x:window.peopleCards.zoneScrollState().x,
      });
    }), { once:true });
    document.addEventListener('crm:desk-interaction-ready', (event) => {
      window.__bufferedEntryWheel.ready = {
        key:event.detail?.key,
        x:window.peopleCards.zoneScrollState().x,
      };
      requestAnimationFrame(() => {
        window.__bufferedEntryWheel.ready.nextPaintX = window.peopleCards.zoneScrollState().x;
      });
    }, { once:true });
  });
  const bufferedEntryPoint = await page.evaluate(() => ({ x:innerWidth - 30, y:innerHeight - 10 }));
  await page.mouse.move(bufferedEntryPoint.x, bufferedEntryPoint.y);
  await page.mouse.wheel({ deltaY:100 });
  await sleep(30);
  await check('The lower gutter accepts and buffers horizontal input while the destination is still covered', () => {
    const state = window.peopleCards.zoneScrollState();
    const event = window.__bufferedEntryWheel?.events?.[0];
    return {
      ok:document.body.dataset.crmModule === 'home'
        && window.crmDeskTransit?.pendingDestination?.('people') === true
        && event?.prevented === true
        && Math.abs(state.x) < 1 && Math.abs(state.target) < 1,
      detail:JSON.stringify({ event, state, cover:window.crmDeskTransit?.coverState?.()?.phase }),
    };
  });
  await page.evaluate(() => {
    const gate = window.__homeEndpointAcrylicGate;
    delete window.__homeEndpointAcrylicGate;
    delete window.__crmDeskTransitProbe;
    gate?.resolve?.();
  });
  try {
    await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit?.isBusy?.(), { timeout:15000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      module:document.body.dataset.crmModule,
      busy:window.crmDeskTransit?.isBusy?.(),
      cover:window.crmDeskTransit?.coverState?.(),
      camera:{ level:window.crmHomeCamera?.level?.(), transitioning:window.crmHomeCamera?.isTransitioning?.() },
      people:window.peopleCards?.performanceState?.(),
      errors:window.__deskTransitionErrors || [],
      theater:document.querySelector('[data-crm-theater="people"]')?.outerHTML.slice(0,400),
    }));
    throw new Error(`People transition did not settle: ${JSON.stringify(state)} (${error.message})`);
  }
  await check('Home camera lands directly on the destination', () => document.body.dataset.crmModule === 'people' && !document.querySelector('.crm-transit-veil'));
  await check('Buffered entry input moves the rail on the first painted interaction-ready frame', () => {
    const state = window.peopleCards.zoneScrollState();
    const probe = window.__bufferedEntryWheel;
    const timing = window.crmDeskTransit?.performanceTimings?.().at(-1);
    return {
      ok:probe?.ready?.key === 'people'
        && probe.ready.nextPaintX < 0
        && state.x <= -90 && state.x >= -101
        && Math.abs(state.target + 100) < 1 && Math.abs(state.target - state.x) < 5
        && Number(timing?.interactionReadyAfterMotionMs) > 0
        && Number(timing?.interactionReadyAfterMotionMs) <= 600
        && (window.__deskTransitionErrors || []).length === 0,
      detail:JSON.stringify({ probe, state, timing:{
        interactionReadyAfterMotionMs:timing?.interactionReadyAfterMotionMs,
        totalMs:timing?.totalMs,
      }, errors:window.__deskTransitionErrors || [] }),
    };
  });
  await page.evaluate(() => window.peopleCards.scrollZonesBy(-100000, true));
  await check('Tile room does not exclude the title-bar drag region', () => {
    const room = document.querySelector('[data-crm-theater="people"]:not([hidden])');
    return !!room && getComputedStyle(room).webkitAppRegion !== 'no-drag';
  });
  await page.evaluate(async () => {
    window.__interactionProjectIds = [];
    for (const title of ['Project A', 'Project B', 'Project C']) {
      const project = await window.crmPlanner.createProject(title);
      if (project?.id) window.__interactionProjectIds.push(project.id);
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
  await check('The returning viewport carries real acrylic for the full zoom-out', () => {
    const expander = document.querySelector('.crm-home-expander:not(.crm-home-warm)');
    const frame = expander?.querySelector(':scope > .crm-home-transition-acrylic');
    const acrylic = document.querySelector('.crm-home-surface .crm-home-screen-acrylic');
    const style = acrylic && getComputedStyle(acrylic);
    const frameStyle = frame && getComputedStyle(frame);
    const material = style?.webkitBackdropFilter || style?.backdropFilter || '';
    const state = window.crmHome?.acrylicState?.();
    const ok = !!expander && state?.phase === 'motion'
      && window.crmHome?.acrylicState?.().direction === 'contract'
      && Number(style?.opacity) > .99 && Number(frameStyle?.opacity) > .99
      && material.includes('blur(') && material.includes('saturate(')
      && !expander.style.transition.includes('opacity');
    return {
      ok,
      detail:JSON.stringify({
        expander:!!expander,
        frame:!!frame,
        state,
        acrylicDisplay:style?.display,
        acrylicVisibility:style?.visibility,
        acrylicOpacity:Number(style?.opacity || 0),
        frameOpacity:Number(frameStyle?.opacity || 0),
        material,
        transition:expander?.style?.transition || '',
        surface:window.crmHomeCamera?.surface?.()?.getAttributeNames?.()
          .filter((name) => name.startsWith('data-crm-home')),
      }),
    };
  });
  await check('Every non-focused Home tile keeps one real screen-space acrylic plane during zoom-out', () => {
    const surface = window.crmHomeCamera?.surface?.();
    const acrylic = surface?.querySelector('.crm-home-peripheral-screen-acrylic');
    const clipHost = acrylic?.parentElement;
    const style = acrylic && getComputedStyle(acrylic);
    const hostStyle = clipHost && getComputedStyle(clipHost);
    const matrix = style?.transform && style.transform !== 'none' ? new DOMMatrix(style.transform) : new DOMMatrix();
    const state = window.crmHome?.peripheralAcrylicState?.();
    const motion = window.crmHome?.motionStatus?.();
    const material = style?.webkitBackdropFilter || style?.backdropFilter || '';
    const liveNeighbors = [...(window.crmHomeCamera?.layers?.()[0]?.querySelectorAll('.crm-home-bucket:not(.is-camera-target)') || [])];
    const liveFallback = !motion?.ready && liveNeighbors.length === 5 && liveNeighbors.every((bucket) => {
      const bucketStyle = getComputedStyle(bucket);
      const bucketMaterial = bucketStyle.webkitBackdropFilter || bucketStyle.backdropFilter || '';
      return bucketStyle.visibility !== 'hidden' && bucketMaterial.includes('blur(') && bucketMaterial.includes('saturate(');
    });
    const clippedPlane = !!acrylic && clipHost?.parentElement === surface
      && surface.classList.contains('crm-home-peripheral-acrylic-active')
      && state?.active && state.phase === 'motion' && state.direction === 'contract' && state.neighborCount === 5
      && Number(style.opacity) > .99 && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none'
      && material.includes('blur(') && material.includes('saturate(')
      && hostStyle?.clipPath.startsWith('path(')
      && Math.abs(matrix.a - 1) < .001 && Math.abs(matrix.d - 1) < .001;
    return { ok:motion?.ready ? clippedPlane : liveFallback,
      detail:JSON.stringify({ motion, state, liveFallback, opacity:Number(style?.opacity || 0), material, clip:hostStyle?.clipPath,
        screenScale:[matrix.a,matrix.d], active:surface?.classList.contains('crm-home-peripheral-acrylic-active') }) };
  });
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
  await check('Returning Home restores an unobstructed drag region', () => {
    const x = Math.round(innerWidth * .4), y = 20;
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
    const control = document.querySelector('.crm-viewport-date');
    const today = new Date();
    const localIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const ok = !!control && !control.hidden && control.querySelector('.crm-viewport-date-day')?.textContent === String(today.getDate())
      && /open calendar for/i.test(control.getAttribute('aria-label') || '')
      && !document.querySelector('.crm-temporal-context')
      && document.body.dataset.crmTemporalDate === localIso;
    const style = control && getComputedStyle(control);
    return {
      ok,
      detail:JSON.stringify({
        module:document.body.dataset.crmModule,
        workspace:window.crmWorkspaces?.active?.(),
        busy:window.crmDeskTransit?.isBusy?.(),
        hidden:control?.hidden,
        visibility:style?.visibility,
        opacity:style?.opacity,
        pointerEvents:style?.pointerEvents,
        day:control?.querySelector('.crm-viewport-date-day')?.textContent,
        ariaLabel:control?.getAttribute('aria-label'),
        temporalDate:document.body.dataset.crmTemporalDate,
        expected:localIso,
      }),
    };
  });
  if (process.env.CRM_INTERACTION_PIPELINE_ONLY === '1') {
    if (errors.length) { console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`); failures++; }
    console.log(`\nPipeline interaction contract: ${failures ? `${failures} failure(s)` : 'PASSED'}.`);
    await browser.close();
    process.exit(failures ? 1 : 0);
  }
  await page.waitForFunction(() => !window.crmDeskTransit?.isBusy?.(), { timeout: 15000 });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 1, { timeout: 5000 });
  await check('Zooming out of a pipeline reveals the current month in the shared calendar', () => {
    const today = new Date();
    const month = document.querySelector(`[data-crm-theater="calendar"] .fc-expander[data-month="${today.getMonth() + 1}"]`);
    return window.fractalCalendar.year() === today.getFullYear() && !!month && !month.hidden;
  });
  await page.click('[data-crm-history-back]');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'cases' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Back from Calendar restores the pipeline viewport that opened it', () => document.body.dataset.crmModule==='cases'&&window.crmDeskTransit.historyState().canForward);
  await page.click('[data-crm-history-forward]');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 1 && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Forward restores the same Calendar month viewport', () => {
    const today=new Date();return window.fractalCalendar.year()===today.getFullYear()&&!!document.querySelector(`[data-crm-theater="calendar"] .fc-expander[data-month="${today.getMonth()+1}"]`);
  });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 0, { timeout: 5000 });
  await page.keyboard.press('KeyB');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home', { timeout: 10000 });

  await page.setViewport({ width:1280, height:860, deviceScaleFactor:1 });
  await activate('assignments');
  const assignmentScope = '[data-crm-theater="assignments"]:not([hidden])';
  await page.waitForFunction(() => {
    const theater = document.querySelector('section.crm-theater[data-crm-theater="assignments"]:not([hidden])');
    const contract = window.crmAssignments?.contract?.();
    return !!theater && theater.querySelectorAll('.tk-zone[data-stage]').length === contract?.stages?.length
      && theater.querySelectorAll('.tk-zcard[data-id]').length > 0;
  }, { timeout: 10000 });
  await page.evaluate(() => window.crmAssignments.scrollZonesBy(-100000, true));
  await check('Assignments is the shared card-system commitment viewport', () => {
    const theater = document.querySelector('section.crm-theater[data-crm-theater="assignments"]:not([hidden])');
    const api = window.crmAssignments;
    const contract = api?.contract?.();
    const required = ['setActive','reload','baseline','contract','homePreviewState','applyHomePreviewState','performanceState','createCard','moveToStage','setStageExpanded','expandedStages','zoneScrollState','scrollZonesBy'];
    const missing = required.filter((method) => typeof api?.[method] !== 'function');
    const zones = [...(theater?.querySelectorAll('.tk-zone[data-stage]') || [])];
    const cards = [...(theater?.querySelectorAll('.tk-zcard[data-id]') || [])];
    const stages = zones.map((zone) => ({ key:zone.dataset.stage, label:zone.querySelector(':scope > .tk-zone-hd .tk-zone-title')?.textContent.trim() || '' }));
    const ids = cards.map((card) => card.dataset.id);
    const stageIds = new Set(stages.map((stage) => stage.key));
    const expectedStage = (record) => {
      if (['completed','complete','resolved','done','closed','archived','cancelled','canceled'].includes(String(record?.status || '').toLowerCase())) return 'done';
      const explicit = String(record?.assignmentStage || '').toLowerCase();
      if (stageIds.has(explicit)) return explicit;
      return record?.assignedContactId || String(record?.assignee || '').trim() ? 'assigned' : 'unassigned';
    };
    const actualStage = Object.fromEntries(cards.map((card) => [card.dataset.id, card.closest('.tk-zone[data-stage]')?.dataset.stage || '']));
    const placements = api.items().map((record) => ({ id:record.id, expected:expectedStage(record), actual:actualStage[record.id] || '', status:record.status || '' }));
    const furniture = theater?.querySelector(':scope > .tk-zones.is-horizontal .tk-zone-hrail > .tk-zone-hclip > .tk-zone-htrack');
    return {
      ok: !!theater && missing.length === 0 && contract?.workflowKind === 'lifecycle'
        && contract.horizontalZones === true && contract.horizontalZoneRows === 1 && contract.scrollZoneRows === false
        && contract.lazyZoneCards === false && contract.restoreZoneExpansion === false && contract.stageMovement === 'free'
        && contract.stageAuthority === 'source' && contract.deletionAuthority === 'source'
        && contract.atomicSourceMove === true
        && contract.deckScaffold === false && contract.leftDeckEnabled === false
        && contract.rightDeckEnabled === false && contract.trashEnabled === false
        && contract.showProgressBars === true && JSON.stringify(stages) === JSON.stringify(contract.stages)
        && zones.length === 5 && cards.length === api.items().length && new Set(ids).size === ids.length
        && placements.every((placement) => placement.actual === placement.expected)
        && placements.some((placement) => placement.expected === 'done')
        && zones.every((zone) => zone.dataset.crmSizeKey === `bucket:assignments:${zone.dataset.stage}`)
        && cards.every((card) => card.dataset.recordEntity === 'commitments'
          && card.dataset.crmSizeKey === `card:commitments:${card.dataset.id}`
          && card.getAttribute('role') === 'button' && card.tabIndex === 0
          && !!card.querySelector('.ticket-body .ticket-fields'))
        && !!furniture && !!furniture.parentElement?.querySelector(':scope > .tk-zone-hacrylic-clip > .tk-zone-hacrylic-lens')
        && !theater.querySelector('svg.tk-flow,.tk-flow-shaft,.tk-flow-head,.tk-zone-spread')
        && !theater.querySelector(':scope > .tk-stacks,:scope > .tk-scrim,.tk-deck')
        && document.querySelectorAll('.crm-assignment-bucket,.crm-assignment-work-card').length === 0
        && document.querySelectorAll('.crm-factory-mini-scene').length === 0,
      detail:JSON.stringify({ missing, contract, stages, cards:cards.length, unique:new Set(ids).size, placements }),
    };
  });
  const assignmentShadowProbe = await page.evaluate(async () => {
    const api = window.crmAssignments;
    const item = api.items().find((record) => !['completed','complete','resolved','done','closed','archived','cancelled','canceled'].includes(String(record.status || '').toLowerCase()));
    if (!item) return { ok:false, reason:'no open commitment' };
    const expected = String(item.assignmentStage || '').toLowerCase()
      || (item.assignedContactId || String(item.assignee || '').trim() ? 'assigned' : 'unassigned');
    const staleStage = expected === 'blocked' ? 'active' : 'blocked';
    localStorage.setItem('crm-assignment-stage', JSON.stringify({ [item.id]:staleStage }));
    localStorage.setItem('crm-assignment-stage-order', JSON.stringify({ [staleStage]:[item.id] }));
    localStorage.setItem('crm-assignment-deleted', JSON.stringify([item.id]));
    await api.reload();
    await api.waitForGeometrySettled();
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(item.id)}"]`)];
    const actual = cards[0]?.closest('.tk-zone[data-stage]')?.dataset.stage || '';
    ['crm-assignment-stage','crm-assignment-stage-order','crm-assignment-deleted'].forEach((key) => localStorage.removeItem(key));
    return { ok:cards.length === 1 && actual === expected, id:item.id, expected, actual, cards:cards.length };
  });
  await check('Assignment placement ignores every legacy local shadow map', (state) => ({
    ok:state.ok,
    detail:JSON.stringify(state),
  }), assignmentShadowProbe);
  const assignmentRail = await page.evaluate(() => {
    const theater = document.querySelector('section.crm-theater[data-crm-theater="assignments"]:not([hidden])');
    const api = window.crmAssignments;
    const clip = theater?.querySelector('.tk-zone-hclip');
    const track = theater?.querySelector('.tk-zone-htrack');
    const bar = theater?.querySelector('.tk-zone-hsb');
    const thumb = theater?.querySelector('.tk-zone-hth');
    api.scrollZonesBy(-100000, true);
    const start = api.zoneScrollState();
    const moved = api.scrollZonesBy(100000, true);
    const end = api.zoneScrollState();
    const barStyle = bar && getComputedStyle(bar); const thumbStyle = thumb && getComputedStyle(thumb);
    const result = {
      start, moved, end,
      overflow:track && clip ? Math.max(0, track.scrollWidth - clip.clientWidth) : -1,
      transform:track ? getComputedStyle(track).transform : '',
      barOn:bar?.classList.contains('is-on') || false,
      thumbWidth:thumb?.getBoundingClientRect().width || 0,
      trackWidth:bar?.getBoundingClientRect().width || 0,
      sharedStyle:!!document.getElementById('crm-horizontal-zone-styles') && bar?.matches('.tk-zone-hsb') && thumb?.matches('.tk-zone-hth')
        && !!barStyle?.backgroundColor && barStyle.borderRadius === '999px' && !!barStyle.boxShadow
        && !!thumbStyle?.backgroundColor && thumbStyle.borderRadius === '999px' && !!thumbStyle.boxShadow,
    };
    api.scrollZonesBy(-100000, true);
    return result;
  });
  await check('Assignment zone travel uses the shared factory rail and remains clamped', (state) => ({
    ok:state.overflow >= 0 && state.start.x === 0 && state.start.target === 0
      && state.end.x >= state.end.min - 1 && state.end.x <= 1 && Math.abs(state.end.x - state.end.min) <= 1
      && state.sharedStyle
      && (state.overflow <= 1
        ? state.moved === false && Math.abs(state.end.min) <= 1
        : state.moved === true && state.barOn && state.thumbWidth >= 28 && state.thumbWidth < state.trackWidth && state.transform !== 'none'),
    detail:JSON.stringify(state),
  }), assignmentRail);
  const assignmentExpansion = await page.evaluate(async () => {
    const theater = document.querySelector('section.crm-theater[data-crm-theater="assignments"]:not([hidden])');
    const api = window.crmAssignments;
    const zone = [...theater.querySelectorAll('.tk-zone[data-stage]')].find((candidate) => candidate.querySelector('.tk-zcard[data-id]'))
      || theater.querySelector('.tk-zone[data-stage]');
    const stage = zone?.dataset.stage || '';
    const signature = () => ({
      zones:[...theater.querySelectorAll('.tk-zone[data-stage]')].map((candidate) => candidate.dataset.stage),
      cards:[...theater.querySelectorAll('.tk-zone[data-stage] .tk-zcard[data-id]')].map((card) => `${card.closest('.tk-zone[data-stage]')?.dataset.stage}:${card.dataset.id}`),
    });
    const before = signature();
    const opened = api.setStageExpanded(stage, true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const expanded = signature();
    const expandedClass = zone?.classList.contains('is-stack-expanded') || false;
    const closed = api.setStageExpanded(stage, false);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { stage, opened, closed, expandedClass, collapsedClass:zone?.classList.contains('is-stack-expanded') || false, before, expanded, after:signature() };
  });
  await check('Assignment expansion preserves the canonical zone/card identity signature and returns to rest', (state) => ({
    ok:!!state.stage && state.opened === true && state.closed === false && state.expandedClass && !state.collapsedClass
      && JSON.stringify(state.before) === JSON.stringify(state.expanded) && JSON.stringify(state.before) === JSON.stringify(state.after)
      && window.crmAssignments.expandedStages().length === 0,
    detail:JSON.stringify(state),
  }), assignmentExpansion);

  const assignmentDrag = await page.evaluate(() => {
    const theater = document.querySelector('[data-crm-theater="assignments"]:not([hidden])');
    const visible = [...theater.querySelectorAll('.tk-zone[data-stage]')].filter((zone) => {
      const rect = zone.getBoundingClientRect();
      return rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
    });
    let originZone = null;
    let card = null;
    let fromPoint = null;
    for (const zone of visible.filter((candidate) => candidate.dataset.stage !== 'done')) {
      const body = zone.querySelector('.tk-zone-body');
      const rect = body?.getBoundingClientRect();
      if (!rect) continue;
      const x = Math.max(12, Math.min(innerWidth - 12, rect.left + rect.width / 2));
      const sampleYs = [rect.bottom - 28, rect.top + rect.height * .66, rect.top + rect.height * .33]
        .map((y) => Math.max(12, Math.min(innerHeight - 24, y)));
      for (const y of sampleYs) {
        const hit = document.elementsFromPoint(x, y)
          .map((node) => node.closest?.('.tk-zcard[data-id]'))
          .find((candidate) => candidate?.closest('.tk-zone[data-stage]') === zone);
        if (!hit) continue;
        originZone = zone;
        card = hit;
        fromPoint = { x, y };
        break;
      }
      if (card) break;
    }
    const targetZone = visible.find((zone) => zone !== originZone && zone.dataset.stage !== 'done');
    const to = targetZone?.querySelector('.tk-zone-body')?.getBoundingClientRect();
    return {
      id:card?.dataset.id || '',
      original:originZone?.dataset.stage || '',
      target:targetZone?.dataset.stage || '',
      from:fromPoint,
      to:to ? { x:to.left + to.width / 2, y:to.bottom - 36 } : null,
    };
  });
  if (assignmentDrag.from && assignmentDrag.to) {
    await page.mouse.move(assignmentDrag.from.x, assignmentDrag.from.y);
    await page.mouse.down();
    await page.mouse.move(assignmentDrag.to.x, assignmentDrag.to.y, { steps:14 });
    await page.mouse.up();
  }
  await page.waitForFunction(async ({ id, target }) => {
    if (!id || !target) return false;
    await window.crmAssignments.waitForGeometrySettled();
    const record = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((candidate) => candidate.id === id);
    return record?.assignmentStage === target;
  }, { timeout:15000 }, assignmentDrag);
  const assignmentMove = await page.evaluate(async (drag) => {
    const commitments = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records;
    const record = commitments.find((candidate) => candidate.id === drag.id);
    const flows = (await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 })).records;
    const touchedRanks = [drag.original, drag.target].map((stage) => ({
      stage,
      ranks:commitments.filter((item) => {
        const actual = ['completed','complete','resolved','done','closed','archived','cancelled','canceled'].includes(String(item.status || '').toLowerCase())
          ? 'done'
          : String(item.assignmentStage || '').toLowerCase() || (item.assignee ? 'assigned' : 'unassigned');
        return actual === stage;
      }).map((item) => Number(item.assignmentRank)).sort((a, b) => a - b),
    }));
    return {
      ...drag,
      recordStage:record?.assignmentStage,
      assignmentFlows:flows.length,
      touchedRanks,
    };
  }, assignmentDrag);
  await check('A real pointer drag uses one canonical atomic commitment move', (state) => {
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(state.id)}"]`)];
    const contiguous = state.touchedRanks.every(({ ranks }) => ranks.every((rank, index) => rank === index));
    return { ok:state.recordStage === state.target && state.assignmentFlows === 0 && contiguous && cards.length === 1
      && cards[0].closest('.tk-zone[data-stage]')?.dataset.stage === state.target, detail:JSON.stringify(state) };
  }, assignmentMove);

  const failedAssignmentMove = await page.evaluate(async (state) => {
    const originalBatch = window.crmDomain.batch;
    let calls = 0;
    window.crmDomain.batch = (...args) => {
      calls += 1;
      window.crmDomain.batch = originalBatch;
      return Promise.resolve({ ok:false, status:503, error:'forced atomic move failure', args });
    };
    const ok = await window.crmAssignments.move(state.id, state.original);
    const record = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((candidate) => candidate.id === state.id);
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(state.id)}"]`)];
    return { id:state.id, expected:state.target, ok, calls, persisted:record?.assignmentStage, rendered:cards[0]?.closest('.tk-zone[data-stage]')?.dataset.stage, cards:cards.length };
  }, assignmentMove);
  await check('A failed atomic Assignment move reconciles without partial rank or stage state', (state) => ({
    ok:state.ok === false && state.calls === 1 && state.persisted === state.expected
      && state.rendered === state.expected && state.cards === 1,
    detail:JSON.stringify(state),
  }), failedAssignmentMove);
  await page.evaluate((state) => window.crmAssignments.move(state.id, state.original), assignmentMove);

  const assignment = await page.evaluate(async () => {
    const item = window.crmAssignments.items().find((candidate) => !['completed','complete','resolved','done','closed','archived','cancelled','canceled'].includes(String(candidate.status || '').toLowerCase()));
    const contact = (await window.crmStore.list('contacts', { includeDeleted:false })).records[0]; const ok = await window.crmAssignments.assign(item.id, contact.id);
    const record = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((candidate) => candidate.id === item.id);
    const flows = (await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 })).records;
    return { id:item.id, contactId:contact.id, ok, assignedContactId:record?.assignedContactId, stage:record?.assignmentStage, assignmentFlows:flows.length };
  });
  await check('Assigning a person updates only the canonical commitment', (state) => {
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(state.id)}"]`)];
    return { ok:state.ok && state.assignedContactId === state.contactId && state.stage === 'assigned' && state.assignmentFlows === 0
      && cards.length === 1 && cards[0].closest('.tk-zone[data-stage]')?.dataset.stage === 'assigned', detail:JSON.stringify(state) };
  }, assignment);
  await page.evaluate((id) => window.crmAssignments.unassign(id), assignment.id);

  await check('Assignment zones keep the shared card stack compact and collapsed at rest', () => {
    const theater = document.querySelector('[data-crm-theater="assignments"]:not([hidden])');
    const bucket = theater?.querySelector('.tk-zone[data-stage]:has(.tk-zcard + .tk-zcard)');
    const cards = [...(bucket?.querySelectorAll('.tk-zcard[data-id]') || [])];
    const step = cards.length > 1 ? cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top : 0;
    return { ok:!!bucket && !bucket.classList.contains('is-stack-expanded') && !theater.querySelector('.tk-zone-spread') && step > 0 && step < 60,
      detail:`${Math.round(step)}px compact step · ${cards.length} cards` };
  });

  const assignmentCardSelector = `${assignmentScope} .tk-zone[data-stage]:has(.tk-zcard) .tk-zcard[data-id]:last-child`;
  await page.evaluate((selector) => { const card = document.querySelector(selector); const rect = card?.getBoundingClientRect(); if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.right - 8, clientY:rect.top + 12 })); }, assignmentCardSelector);
  await page.waitForSelector('body > .tk-menu.crm-menu-surface');
  await check('Assignment actions use the shared card-system menu surface', () => {
    const menu = document.querySelector('body > .tk-menu.crm-menu-surface'); const reference = document.querySelector('.auth-profile-menu'); if (!menu || !reference) return false;
    const actual = getComputedStyle(menu); const expected = getComputedStyle(reference); const rect = menu.getBoundingClientRect();
    return rect.width < 220 && rect.height < 300 && !!menu.querySelector('[data-act="edit"]') && !!menu.querySelector('[data-act="size"]')
      && ['backgroundImage','backdropFilter','borderTopColor','borderRadius','boxShadow'].every((property) => actual[property] === expected[property]);
  });
  await page.click('body > .tk-menu [data-act="edit"]');
  await page.waitForSelector('.ticket-detail-overlay[data-card-detail="assignmentDetail"]:not([hidden]) .ticket-detail');
  await sleep(760);
  await check('Assignment editing unfolds from its real card and fits every linked field without scrolling', () => {
    const overlay = document.querySelector('.ticket-detail-overlay[data-card-detail="assignmentDetail"]:not([hidden])'); const panel = overlay?.querySelector('.ticket-detail'); const flyer = overlay?.querySelector('.td-flyer');
    const panelRect = panel?.getBoundingClientRect(); const flyerRect = flyer?.getBoundingClientRect(); const style = panel && getComputedStyle(panel);
    return !!panelRect && !!flyerRect && panelRect.width > flyerRect.width + 100 && panelRect.height > flyerRect.height
      && panel.scrollHeight <= panel.clientHeight + 1 && !['auto','scroll'].includes(style.overflowY)
      && ['title','context','stage','dueAt','assignedTarget','linkedTarget'].every((key) => !!panel.querySelector(`[data-field="${key}"]`))
      && panel.querySelectorAll('.td-prio-opt').length === 3 && !document.querySelector('.crm-record-scrim:not([hidden])');
  });
  await page.click('.ticket-detail-overlay[data-card-detail="assignmentDetail"] .td-x');
  await page.waitForFunction(() => document.querySelector('.ticket-detail-overlay[data-card-detail="assignmentDetail"]')?.hidden === true);
  await check('Calendar navigation is one fixed top-center control, never card chrome', () => {
    const controls = [...document.querySelectorAll('.crm-viewport-date')]; const rect = controls[0]?.getBoundingClientRect(); const style = controls[0] && getComputedStyle(controls[0]);
    const topControl = document.querySelector('.window-control-cluster .window-glass-control'); const topStyle = topControl && getComputedStyle(topControl);
    return controls.length === 1 && !controls[0].hidden && controls[0].classList.contains('window-glass-control')
      && !document.querySelector('[data-crm-card-date],.crm-card-date') && style?.position === 'fixed'
      && Math.abs((rect.left + rect.width / 2) - innerWidth / 2) <= 1 && rect.top >= 11 && rect.top <= 13
      && Math.abs(rect.width - 46) <= .5 && Math.abs(rect.height - 46) <= .5 && parseFloat(style.borderRadius) >= 23
      && !!topStyle && ['backgroundImage','backdropFilter','borderTopColor','borderRadius','boxShadow']
        .every((property) => style[property] === topStyle[property]);
  });
  await page.click('.crm-viewport-date');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 1, { timeout:2500 });
  await check('The global calendar control opens the current month pane', () => {
    const date = new Date(); const month = date.getMonth() + 1;
    const pane = document.querySelector(`[data-crm-theater="calendar"] .fc-expander[data-month="${month}"]`);
    return { ok:document.body.dataset.crmModule === 'calendar' && window.fractalCalendar?.level?.() === 1 && pane?.hidden === false && window.fractalCalendar.year() === date.getFullYear(),
      detail:JSON.stringify({ module:document.body.dataset.crmModule, level:window.fractalCalendar?.level?.(), year:window.fractalCalendar?.year?.(), pane:!!pane, hidden:pane?.hidden }) };
  });
  await check('Calendar replaces the date face with one matching year face, without a foreign pill', () => {
    const control = document.querySelector('.crm-viewport-date');
    const strip = document.querySelector('body > .fc-year-strip:not([hidden])');
    const face = strip?.querySelector('.fc-year-face'); const faceRect = face?.getBoundingClientRect();
    const arrows = [...(strip?.querySelectorAll('.fc-year-btn') || [])];
    const controlStyle = control && getComputedStyle(control);
    const faceStyle = face && getComputedStyle(face);
    const matchingMaterial = !!controlStyle && !!faceStyle
      // Shadow/transform are interaction state; compare the underlying face
      // material so a hovered replacement is still the same control species.
      && ['backgroundImage','backdropFilter','borderTopColor','borderRadius']
        .every((property) => faceStyle[property] === controlStyle[property]);
    const ok = !!control && control.hidden && controlStyle?.visibility === 'hidden'
      && Number(controlStyle.opacity) === 0 && controlStyle.pointerEvents === 'none'
      && !!strip && !strip.classList.contains('crm-menu-surface') && getComputedStyle(strip).backgroundImage === 'none'
      // The pointer that opened Calendar remains over the replacement face,
      // so the canonical top-control hover press may reduce 46px to 45.31px.
      && !!faceRect && faceRect.width >= 45 && faceRect.width <= 46.5
      && faceRect.height >= 45 && faceRect.height <= 46.5
      && Math.abs((faceRect.left + faceRect.width / 2) - innerWidth / 2) <= 1
      && faceRect.top >= 11 && faceRect.top <= 14
      && face.classList.contains('window-glass-control') && matchingMaterial
      && arrows.length === 2 && arrows.every((arrow) => arrow.getClientRects().length > 0
        && arrow.classList.contains('window-glass-control') && !arrow.classList.contains('crm-secondary-control'));
    return {
      ok,
      detail:JSON.stringify({
        control:[control?.hidden, control && getComputedStyle(control).display],
        strip:[strip?.className, strip && getComputedStyle(strip).backgroundImage],
        face:[face?.className, faceRect && [faceRect.x, faceRect.y, faceRect.width, faceRect.height], faceStyle?.transform],
        viewport:[innerWidth,innerHeight],
        matchingMaterial,
        arrows:arrows.map((arrow) => [
          arrow.className,
          arrow.getClientRects().length,
          getComputedStyle(arrow).opacity,
        ]),
      }),
    };
  });
  await activate('assignments');

  await page.waitForSelector(assignmentCardSelector);
  await page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (card) window.crmObjectSizing.setSize(card, 'card', 'large');
  }, assignmentCardSelector);
  await sleep(240);
  const assignmentCardTier = await page.$eval(assignmentCardSelector, (card) => {
    const rect = card.getBoundingClientRect();
    window.__assignmentSizingCard = card;
    return {
      id:card.dataset.id,
      sizeKey:card.dataset.crmSizeKey,
      width:rect.width,
      height:rect.height,
      stage:card.closest('.tk-zone[data-stage]')?.dataset.stage,
      text:card.querySelector('.ticket-body')?.textContent.replace(/\s+/g, ' ').trim() || '',
      entries:card.querySelectorAll('.ticket-fields .ticket-field').length,
      mark:card.querySelector('.crm-card-semantic-mark')?.dataset.cardSemantic || '',
    };
  });
  await page.evaluate((selector) => { const card = document.querySelector(selector); const rect = card?.getBoundingClientRect(); if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.right - 8, clientY:rect.top + 12 })); }, assignmentCardSelector);
  await page.waitForSelector('body > .tk-menu [data-act="size"]');
  await page.click('body > .tk-menu [data-act="size"]');
  await page.waitForFunction((before) => {
    const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(before.id)}"]`);
    const rect = card?.getBoundingClientRect();
    return card?.classList.contains('crm-object-small') && Math.abs(rect.width / before.width - .8) < .02 && Math.abs(rect.height / before.height - .8) < .02;
  }, {}, assignmentCardTier);
  await sleep(220);
  await check('Assignment cards use the shared proportional sizing contract without replacing their face', (before) => {
    const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(before.id)}"]`);
    const rect = card?.getBoundingClientRect();
    const ok = !!card && card === window.__assignmentSizingCard && card.dataset.crmSizeKey === before.sizeKey
      && card.closest('.tk-zone[data-stage]')?.dataset.stage === before.stage
      && window.crmObjectSizing.sizeOf(card, 'card') === 'small' && Number.parseFloat(getComputedStyle(card).scale) === 1
      && Math.abs(rect.width / before.width - .8) < .015 && Math.abs(rect.height / before.height - .8) < .015
      && (card.querySelector('.ticket-body')?.textContent.replace(/\s+/g, ' ').trim() || '') === before.text
      && card.querySelectorAll('.ticket-fields .ticket-field').length === before.entries && !!before.mark
      && (card.querySelector('.crm-card-semantic-mark')?.dataset.cardSemantic || '') === before.mark;
    return { ok, detail:JSON.stringify({ sameNode:card === window.__assignmentSizingCard, stage:card?.closest('.tk-zone[data-stage]')?.dataset.stage, expectedStage:before.stage, size:card&&window.crmObjectSizing.sizeOf(card,'card'), rect:rect&&[rect.width,rect.height], ratio:rect&&[rect.width/before.width,rect.height/before.height] }) };
  }, assignmentCardTier);
  await page.evaluate((id) => {
    const card = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(id)}"]`);
    if (card) window.crmObjectSizing.setSize(card, 'card', 'large');
  }, assignmentCardTier.id);
  await page.waitForFunction((id) => !document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(id)}"]`)?.classList.contains('crm-object-small'), {}, assignmentCardTier.id);

  const assignmentZoneSelector = `${assignmentScope} .tk-zone[data-stage]`;
  await page.evaluate((selector) => {
    const zone = document.querySelector(selector);
    if (zone) window.crmObjectSizing.setSize(zone, 'bucket', 'large');
  }, assignmentZoneSelector);
  await sleep(240);
  const assignmentBucketTier = await page.$eval(assignmentZoneSelector, (bucket) => {
    const rect = bucket.getBoundingClientRect();
    window.__assignmentSizingZone = bucket;
    return { stage:bucket.dataset.stage, sizeKey:bucket.dataset.crmSizeKey, width:rect.width, height:rect.height, ids:[...bucket.querySelectorAll('.tk-zcard[data-id]')].map((item) => item.dataset.id) };
  });
  await page.evaluate((selector) => { const header = document.querySelector(`${selector} > .tk-zone-hd`); const rect = header?.getBoundingClientRect(); if (header && rect) header.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.left + 30, clientY:rect.top + 12 })); }, assignmentZoneSelector);
  await page.waitForSelector('.crm-size-menu'); await page.click('.crm-size-menu .crm-menu-action');
  await page.waitForFunction((before) => {
    const bucket = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zone[data-stage="${CSS.escape(before.stage)}"]`);
    const rect = bucket?.getBoundingClientRect();
    return bucket?.classList.contains('crm-object-small') && rect.width < before.width * .9 && rect.height < before.height * .9;
  }, {}, assignmentBucketTier);
  await check('Assignment zones use the shared bucket sizing contract without replacing commitments', (before) => {
    const bucket = document.querySelector(`[data-crm-theater="assignments"]:not([hidden]) .tk-zone[data-stage="${CSS.escape(before.stage)}"]`);
    const ids = [...(bucket?.querySelectorAll('.tk-zcard[data-id]') || [])].map((card) => card.dataset.id);
    const rect = bucket?.getBoundingClientRect();
    return !!bucket && bucket === window.__assignmentSizingZone && bucket.dataset.crmSizeKey === before.sizeKey
      && window.crmObjectSizing.sizeOf(bucket, 'bucket') === 'small' && Number.parseFloat(getComputedStyle(bucket).scale) === 1
      && rect.width < before.width * .9 && rect.height < before.height * .9 && JSON.stringify(ids) === JSON.stringify(before.ids);
  }, assignmentBucketTier);
  await page.evaluate((selector) => {
    const zone = document.querySelector(selector);
    if (zone) window.crmObjectSizing.setSize(zone, 'bucket', 'large');
  }, assignmentZoneSelector);

  const createdAssignmentTitle = `Interaction assignment ${Date.now()}`;
  await page.evaluate(() => window.crmAssignments.openCreate());
  await page.waitForSelector('.crm-assignment-editor');
  await page.type('.crm-assignment-editor [name="title"]', createdAssignmentTitle);
  await page.select('.crm-assignment-editor [name="stage"]', 'active');
  await page.click('.crm-assignment-editor button[type="submit"]');
  await page.waitForFunction((title) => window.crmAssignments.items().some((item) => item.title === title), {}, createdAssignmentTitle);
  await check('Creating an assignment produces one canonical commitment and no workflow shadow', async (title) => {
    const item = window.crmAssignments.items().find((candidate) => candidate.title === title); if (!item) return false;
    const flows = await window.crmDomain.list('workflow-entries', { includeDeleted:false, workflowKey:'assignments', limit:1000 });
    const cards = [...document.querySelectorAll(`[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id="${CSS.escape(item.id)}"]`)];
    return { ok:cards.length === 1 && cards[0].dataset.recordEntity === 'commitments' && cards[0].dataset.crmSizeKey === `card:commitments:${item.id}`
      && flows.records.length === 0 && item.assignmentStage === 'active'
      && cards[0].closest('.tk-zone[data-stage]')?.dataset.stage === 'active', detail:`${item.id} / ${flows.records.length} shadows` };
  }, createdAssignmentTitle);
  const deletedAssignment = await page.evaluate(async (title) => {
    const item = window.crmAssignments.items().find((candidate) => candidate.title === title);
    const deleted = item ? await window.crmAssignments.remove(item.id) : false;
    const commitments = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:5000 })).records;
    const ranks = commitments.filter((record) => {
      const closed = ['completed','complete','resolved','done','closed','archived','cancelled','canceled']
        .includes(String(record.status || '').toLowerCase());
      return !closed && String(record.assignmentStage || '').toLowerCase() === 'active';
    }).map((record) => Number(record.assignmentRank)).sort((a, b) => a - b);
    return {
      id:item?.id || '',
      deleted,
      remains:commitments.some((record) => record.id === item?.id),
      ranks,
    };
  }, createdAssignmentTitle);
  await check('Deleting an assignment atomically removes it and compacts its canonical bucket', (state) => ({
    ok:state.deleted && !state.remains && state.ranks.every((rank, index) => rank === index),
    detail:JSON.stringify(state),
  }), deletedAssignment);

  await page.setViewport({ width:1600, height:1000, deviceScaleFactor:1 });
  await sleep(220);
  await check('Assignment zones settle inside the shared factory rail when the viewport fits', () => {
    const theater=document.querySelector('[data-crm-theater="assignments"]:not([hidden])'); const clip=theater?.querySelector('.tk-zone-hclip'); const track=theater?.querySelector('.tk-zone-htrack'); const zones=[...(theater?.querySelectorAll('.tk-zone[data-stage]')||[])]; const state=window.crmAssignments.zoneScrollState(); const bounds=clip?.getBoundingClientRect();
    const overflow=track&&clip?Math.max(0,track.scrollWidth-clip.clientWidth):-1;
    return { ok:overflow<=1&&state.min===0&&state.x===0&&!!bounds&&zones.length===window.crmAssignments.contract().stages.length
      && zones.every((zone)=>{const rect=zone.getBoundingClientRect();return rect.left>=bounds.left-1&&rect.right<=bounds.right+1;})
      && track.classList.contains('has-shared-zone-acrylic')&&!!clip.querySelector(':scope > .tk-zone-hacrylic-clip > .tk-zone-hacrylic-lens'),
      detail:JSON.stringify({state,overflow,zones:zones.length}) };
  });
  await activate('people');
  await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="people"] .tk-zone[data-stage]').length === 17
    && document.querySelectorAll('[data-crm-theater="people"] .tk-zone .tk-zcard').length === 160, { timeout: 10000 });
  await check('People are shared card objects grouped inside company buckets, never a pipeline', () => {
    const theater = document.querySelector('[data-crm-theater="people"]:not([hidden])');
    const buckets = [...(theater?.querySelectorAll('.tk-zone[data-stage]') || [])];
    const cards = [...(theater?.querySelectorAll('.tk-zone .tk-zcard') || [])];
    return {
      ok: buckets.length === 17 && cards.length === 160 && window.peopleCards.contract().horizontalZones === true
        && window.peopleCards.contract().horizontalZoneRows === 2 && window.peopleCards.contract().scrollZoneRows === false
        && window.peopleCards.contract().lazyZoneCards === true && window.peopleCards.contract().restoreZoneExpansion === false
        && window.peopleCards.expandedStages().length === 0 && !theater.querySelector('.tk-zone.is-stack-expanded')
        && cards.every((card) => !!card.querySelector('.ticket-body') && !!card.dataset.id)
        && !theater.querySelector('svg.tk-flow, .tk-flow-shaft, .tk-flow-head, .tk-bars')
        && [...theater.querySelectorAll('.tk-deck-left, .tk-empty-left')].every((element) => getComputedStyle(element).display === 'none')
        && !document.querySelector('.crm-company-account, [data-crm-theater="relationships"]'),
      detail: `${cards.length} people cards / ${buckets.length} company buckets`,
    };
  });
  await check('People company buckets stay proportional to the shared card object', () => {
    const buckets = [...document.querySelectorAll('[data-crm-theater="people"] .tk-zone')];
    return buckets.length === 17 && buckets.every((bucket) => {
      const { width, height } = bucket.getBoundingClientRect();
      return width >= 180 && width <= 270 && height >= 300 && height <= 410 && width / height >= .55 && width / height <= .85;
    });
  });
  await check('The global calendar control clears the company rail', () => {
    const control = document.querySelector('.crm-viewport-date')?.getBoundingClientRect();
    const bucketTops = [...document.querySelectorAll('[data-crm-theater="people"] .tk-zone')]
      .map((bucket) => bucket.getBoundingClientRect().top);
    return !!control && bucketTops.length === 17 && control.bottom + 10 <= Math.min(...bucketTops);
  });
  await check('Companies form two aligned continuous rows with one equal horizontal gap', () => {
    const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const clip=theater?.querySelector('.tk-zone-hclip')?.getBoundingClientRect();
    const buckets=[...(theater?.querySelectorAll('.tk-zone')||[])]; const visible=buckets.filter((bucket)=>{const rect=bucket.getBoundingClientRect();return rect.right>clip.left&&rect.left<clip.right;}); const rows=new Map();
    buckets.forEach((bucket)=>{const rect=bucket.getBoundingClientRect();const top=Math.round(rect.top);if(!rows.has(top))rows.set(top,[]);rows.get(top).push({left:Math.round(rect.left),right:Math.round(rect.right)});});
    const values=[...rows.values()].map((row)=>row.sort((a,b)=>a.left-b.left)); const gaps=values.flatMap((row)=>row.slice(1).map((item,index)=>item.left-row[index].right)); const state=window.peopleCards.zoneScrollState(); const track=theater?.querySelector('.tk-zone-htrack');
    const rowLengths=values.map((row)=>row.length).sort((a,b)=>b-a); const alignedColumns=Math.min(...rowLengths);
    return { ok:buckets.length===17&&visible.length===10&&values.length===2&&rowLengths[0]===9&&rowLengths[1]===8&&values[0].slice(0,alignedColumns).every((item,index)=>Math.abs(item.left-values[1][index].left)<=1)
      && gaps.length===15&&Math.max(...gaps)-Math.min(...gaps)<=1&&Math.min(...gaps)>20
      && buckets.every((bucket)=>bucket.getBoundingClientRect().bottom<=clip.bottom+.5)
      && state.min < -(clip.width * .7) && track.scrollWidth >= clip.width * 1.7
      && !!theater.querySelector('.tk-zone-hrail,.tk-zone-hsb')&&!theater.querySelector('.tk-zone-vrail,.tk-zone-vsb'), detail:JSON.stringify({values,gaps,state,track:track?.scrollWidth,view:clip?.width,visible:visible.length}) };
  });
  await check('Every visible company centers its scrollbar inside the card-to-edge bezel', () => {
    const buckets=[...document.querySelectorAll('[data-crm-theater="people"]:not([hidden]) .tk-zone')];
    const geometry=buckets.map((bucket)=>{const br=bucket.getBoundingClientRect(),bar=bucket.querySelector('.tk-zsb')?.getBoundingClientRect(),card=bucket.querySelector('.tk-zcard')?.getBoundingClientRect();return{lod:bucket.dataset.zoneLod,on:bucket.querySelector('.tk-zsb')?.classList.contains('is-on'),hasCard:!!card,inset:bar?br.right-bar.right:null,gap:bar&&card?bar.left-card.right:null};});
    return { ok:geometry.length===17&&geometry.every((item)=>item.lod==='parked'||(!item.hasCard&&!item.on)||(item.inset>=9&&item.inset<=13&&Math.abs(item.inset-item.gap)<=1&&item.on)), detail:JSON.stringify(geometry) };
  });
  await check('People LOD paints only the continuous viewport and parks the rest', () => {
    const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const cards=[...theater.querySelectorAll('.tk-zcard')]; const deferred=cards.filter((card)=>card.classList.contains('is-lazy-shell')); const full=cards.filter((card)=>!card.classList.contains('is-lazy-shell'));
    const perf=window.peopleCards.performanceState(); const buckets=[...theater.querySelectorAll('.tk-zone')]; const nonEmpty=buckets.filter((bucket)=>bucket.querySelector('.tk-zcard')); const parked=buckets.filter((bucket)=>bucket.dataset.zoneLod==='parked'); const active=buckets.length-parked.length; const clip=theater.querySelector('.tk-zone-hclip'),track=theater.querySelector('.tk-zone-htrack'),acrylicClip=clip?.querySelector(':scope > .tk-zone-hacrylic-clip'),lens=acrylicClip?.querySelector(':scope > .tk-zone-hacrylic-lens'),clipRect=clip?.getBoundingClientRect(),lensStyle=lens&&getComputedStyle(lens),acrylicClipStyle=acrylicClip&&getComputedStyle(acrylicClip),trackMatrix=new DOMMatrix(getComputedStyle(track).transform),acrylicClipMatrix=new DOMMatrix(acrylicClipStyle?.transform||''),lensMatrix=new DOMMatrix(lensStyle?.transform||'');
    const readyTops=nonEmpty.filter((bucket)=>{const card=bucket.querySelector('.tk-zcard:last-child');return card&&!card.classList.contains('is-lazy-shell')&&!!card.querySelector('.ticket-fields');});
    return { ok:cards.length===160&&active===10&&full.length===nonEmpty.length&&readyTops.length===nonEmpty.length&&deferred.length===cards.length-nonEmpty.length&&perf.deferredFaces===deferred.length&&perf.parkedBuckets===7&&perf.theaterElements<1500
      && deferred.every((card)=>!card.querySelector('.ticket-fields,.ticket-host'))&&getComputedStyle(clip).overflowX==='hidden'&&getComputedStyle(track).willChange.includes('transform')&&track.classList.contains('has-shared-zone-acrylic')
      && lensStyle?.backdropFilter.includes('blur')&&acrylicClipStyle?.clipPath!=='none'&&acrylicClip?.parentElement===clip&&lens?.parentElement===acrylicClip&&Math.abs(trackMatrix.e-acrylicClipMatrix.e)<1&&Math.abs(acrylicClipMatrix.e+lensMatrix.e)<1&&buckets.every((bucket)=>getComputedStyle(bucket).backdropFilter==='none')
      && parked.every((bucket)=>{const style=getComputedStyle(bucket),rect=bucket.getBoundingClientRect();return style.visibility==='visible'&&style.contentVisibility==='visible'&&!!clipRect&&(rect.right<=clipRect.left||rect.left>=clipRect.right);}), detail:JSON.stringify({deferred:deferred.length,full:full.length,readyTops:readyTops.length,nonEmpty:nonEmpty.length,parked:perf.parkedBuckets,elements:perf.theaterElements}) };
  });
  const peopleShell = await page.$eval('[data-crm-theater="people"] .tk-zcard.is-lazy-shell', (card) => { card.dataset.hydrationProbe='same-node'; return card.dataset.id; });
  await page.focus(`[data-crm-theater="people"] .tk-zcard[data-id="${peopleShell}"]`);
  await check('A deferred person face hydrates in place without replacing its card', (id) => {
    const card=document.querySelector(`[data-crm-theater="people"] .tk-zcard[data-id="${CSS.escape(id)}"]`);
    return !!card&&!card.classList.contains('is-lazy-shell')&&card.dataset.hydrationProbe==='same-node'&&!!card.querySelector('.ticket-fields');
  }, peopleShell);
  const peopleStage = await page.$eval('[data-crm-theater="people"] .tk-zone[data-stage]', (bucket) => bucket.dataset.stage);
  await page.evaluate((stage) => window.peopleCards.setStageExpanded(stage, true), peopleStage);
  await check('Spreading a company stack hydrates every newly visible face', (stage) => {
    const bucket=document.querySelector(`[data-crm-theater="people"] .tk-zone[data-stage="${CSS.escape(stage)}"]`); const cards=[...(bucket?.querySelectorAll('.tk-zcard')||[])];
    return cards.length===10&&cards.every((card)=>!card.classList.contains('is-lazy-shell')&&!!card.querySelector('.ticket-fields'));
  }, peopleStage);
  await page.evaluate((stage) => window.peopleCards.setStageExpanded(stage, false), peopleStage);
  const peopleScrollBefore = await page.$eval('[data-crm-theater="people"] .tk-zone[data-stage]', (bucket) => ({transform:getComputedStyle(bucket.querySelector('.tk-zone-track')).transform,thumbTop:bucket.querySelector('.tk-zth').getBoundingClientRect().top}));
  await page.$eval('[data-crm-theater="people"] .tk-zone[data-stage] .tk-zone-body', (body) => body.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:320 })));
  await sleep(240);
  await check('Company bucket wheel motion moves its vertical thumb and adaptive card-edge shadow', (before) => {
    const bucket=document.querySelector('[data-crm-theater="people"] .tk-zone[data-stage]'); const track=bucket?.querySelector('.tk-zone-track'); const thumb=bucket?.querySelector('.tk-zth'); const activeShadow=[...(bucket?.querySelectorAll('.tk-edge-shade')||[])].some((shade)=>shade.getBoundingClientRect().width>0);
    const state={transform:getComputedStyle(track).transform,thumbTop:thumb.getBoundingClientRect().top};
    return { ok:state.transform!==before.transform&&state.thumbTop>before.thumbTop+2&&activeShadow, detail:JSON.stringify({before,state,activeShadow}) };
  }, peopleScrollBefore);
  await page.evaluate((stage) => new Promise((resolve) => {
    const track=document.querySelector(`[data-crm-theater="people"] .tk-zone[data-stage="${CSS.escape(stage)}"] .tk-zone-track`);
    let previous="",stable=0;const started=performance.now();
    const tick=()=>{const current=track?.style.transform||"";stable=current===previous?stable+1:0;previous=current;
      if(stable>=4||performance.now()-started>1500)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);
  }), peopleStage);
  await page.evaluate(() => window.crmHomePreviews?.waitForIdle?.());
  const companyLodMotion = await page.evaluate(() => new Promise((resolve) => {
    document.activeElement?.blur?.();
    const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const identity=theater.querySelector('.tk-zcard'); identity.dataset.companyLodIdentity='retained';
    const mutations=[]; const observer=new MutationObserver((records)=>mutations.push(...records)); observer.observe(theater,{subtree:true,childList:true,attributes:true,attributeFilter:['data-zone-lod','data-face-deferred','class']});
    const deltas=[]; const longTasks=[]; let previous=performance.now(),started=previous;
    const longObserver=new PerformanceObserver((list)=>list.getEntries().forEach((entry)=>longTasks.push(entry.duration))); try{longObserver.observe({entryTypes:['longtask']});}catch{}
    window.peopleCards.scrollZonesBy(9999);
    const tick=(now)=>{deltas.push(now-previous);previous=now;if(now-started<900){requestAnimationFrame(tick);return;}observer.disconnect();longObserver.disconnect();const sorted=[...deltas].sort((a,b)=>a-b);const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]||0;const parked=[...theater.querySelectorAll('.tk-zone[data-zone-lod="parked"]')],full=[...theater.querySelectorAll('.tk-zone[data-zone-lod="full"]')],buckets=[...theater.querySelectorAll('.tk-zone')],nonEmpty=buckets.filter((bucket)=>bucket.querySelector('.tk-zcard')),readyTops=nonEmpty.filter((bucket)=>{const card=bucket.querySelector('.tk-zcard:last-child');return card&&!card.classList.contains('is-lazy-shell')&&!!card.querySelector('.ticket-fields');}),clip=theater.querySelector('.tk-zone-hclip'),track=theater.querySelector('.tk-zone-htrack'),acrylicClip=clip?.querySelector(':scope > .tk-zone-hacrylic-clip'),lens=acrylicClip?.querySelector(':scope > .tk-zone-hacrylic-lens'),clipRect=clip?.getBoundingClientRect(),trackStyle=track&&getComputedStyle(track),lensStyle=lens&&getComputedStyle(lens),acrylicClipStyle=acrylicClip&&getComputedStyle(acrylicClip),trackMatrix=new DOMMatrix(trackStyle?.transform&&trackStyle.transform!=='none'?trackStyle.transform:undefined),acrylicClipMatrix=new DOMMatrix(acrylicClipStyle?.transform&&acrylicClipStyle.transform!=='none'?acrylicClipStyle.transform:undefined),lensMatrix=new DOMMatrix(lensStyle?.transform&&lensStyle.transform!=='none'?lensStyle.transform:undefined);const lodMutations=mutations.filter((record)=>record.type==='attributes'&&record.attributeName==='data-zone-lod').length;const faceMutations=mutations.filter((record)=>record.type==='childList'||(record.type==='attributes'&&record.target.closest?.('.tk-zcard'))).length;resolve({frames:deltas.length,fps:deltas.length*1000/(now-started),p95,max:Math.max(...deltas),over15:deltas.filter((value)=>value>15).length,longTasks,lodMutations,faceMutations,buckets:buckets.length,active:full.length,parked:parked.length,nonEmpty:nonEmpty.length,readyTops:readyTops.length,deferred:theater.querySelectorAll('.tk-zcard.is-lazy-shell').length,totalCards:theater.querySelectorAll('.tk-zcard').length,sharedLens:track.classList.contains('has-shared-zone-acrylic')&&lensStyle?.backdropFilter.includes('blur')&&acrylicClipStyle?.clipPath!=='none'&&acrylicClip?.parentElement===clip&&lens?.parentElement===acrylicClip&&Math.abs(trackMatrix.e-acrylicClipMatrix.e)<1&&Math.abs(acrylicClipMatrix.e+lensMatrix.e)<1&&buckets.every((bucket)=>getComputedStyle(bucket).backdropFilter==='none'),clipped:getComputedStyle(clip).overflowX==='hidden'&&trackStyle?.willChange.includes('transform')&&parked.every((bucket)=>{const style=getComputedStyle(bucket),rect=bucket.getBoundingClientRect();return style.visibility==='visible'&&style.contentVisibility==='visible'&&!!clipRect&&(rect.right<=clipRect.left||rect.left>=clipRect.right);}),identity:identity.isConnected&&identity.dataset.companyLodIdentity==='retained'});};requestAnimationFrame(tick);
  }));
  await check('Company LOD crosses the continuous rail at native 100 Hz without face churn', (motion) => ({ ok:motion.fps>=98.5&&motion.p95<=12.5&&motion.max<=22&&motion.over15<=2&&motion.longTasks.length===0&&motion.lodMutations>0&&motion.lodMutations<=28&&motion.faceMutations===0&&motion.buckets===17&&motion.active>=8&&motion.active<=10&&motion.parked===motion.buckets-motion.active&&motion.readyTops===motion.nonEmpty&&motion.deferred===motion.totalCards-motion.nonEmpty&&motion.sharedLens&&motion.clipped&&motion.identity, detail:JSON.stringify(motion) }), companyLodMotion);
  await page.evaluate(() => window.peopleCards.scrollZonesBy(-9999, true)); await sleep(100);
  const companyRailBefore = await page.evaluate(() => { const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const clip=theater?.querySelector('.tk-zone-hclip'); const thumb=theater?.querySelector('.tk-zone-hth'); return{state:window.peopleCards.zoneScrollState(),thumbLeft:thumb?.getBoundingClientRect().left||0,scrollWidth:clip?.scrollWidth||0,clientWidth:clip?.clientWidth||0}; });
  await page.evaluate(() => {
    const clip=document.querySelector('[data-crm-theater="people"]:not([hidden]) .tk-zone-hclip'); const rect=clip.getBoundingClientRect();
    clip.dispatchEvent(new WheelEvent('wheel',{deltaY:650,bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
  });
  await sleep(180);
  await check('The company world ignores page-scrolling wheel input above the lower gutter', (before) => {
    const state=window.peopleCards.zoneScrollState();
    return { ok:Math.abs(state.x-before.state.x)<1&&Math.abs(state.target-before.state.target)<1, detail:JSON.stringify({before:before.state,state}) };
  }, companyRailBefore);
  const companyGutterPoint = await page.evaluate(() => { const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const clip=theater?.querySelector('.tk-zone-hclip')?.getBoundingClientRect(); const bar=theater?.querySelector('.tk-zone-hsb')?.getBoundingClientRect(); return { x:Math.round((clip.left+clip.right)/2),y:Math.min(innerHeight-8,Math.ceil(bar.bottom+12)),barBottom:bar.bottom,clipBottom:clip.bottom }; });
  await page.mouse.move(companyGutterPoint.x, companyGutterPoint.y); await page.mouse.wheel({ deltaY:650 });
  await sleep(260);
  await check('The company world scrolls from below its scrollbar with its thumb and adaptive edge shadows', ({ before, point }) => {
    const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const rail=theater?.querySelector('.tk-zone-hrail'); const thumb=theater?.querySelector('.tk-zone-hth'); const state=window.peopleCards.zoneScrollState();
    const left=rail.querySelector('.tk-zone-hshade-left'),right=rail.querySelector('.tk-zone-hshade-right'); const leftShadow=Number(getComputedStyle(left).opacity); const rightShadow=Number(getComputedStyle(right).opacity); const shadeRects=[left,right].map((shade)=>shade.getBoundingClientRect());
    return { ok:point.y>point.barBottom&&point.y>point.clipBottom&&state.min<0&&state.x<before.state.x-600
      &&Math.abs(state.target-state.x)<1&&before.state.x-state.x<=700
      &&before.scrollWidth>before.clientWidth&&thumb.getBoundingClientRect().left>before.thumbLeft+2&&leftShadow>.2&&rightShadow>.2
      && shadeRects.every((rect)=>Math.abs(rect.top)<=.5&&Math.abs(rect.bottom-innerHeight)<=.5),
      detail:JSON.stringify({before,state,point,shadows:[leftShadow,rightShadow],shadeRects,thumb:thumb?.getBoundingClientRect().left}) };
  }, { before:companyRailBefore, point:companyGutterPoint });
  await page.evaluate(() => window.peopleCards.scrollZonesBy(9999, true));
  await sleep(160);
  await check('The horizontal company rail reaches its far edge and transfers LOD cleanly', () => {
    const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])'); const rail=theater?.querySelector('.tk-zone-hrail'); const buckets=[...(theater?.querySelectorAll('.tk-zone')||[])]; const state=window.peopleCards.zoneScrollState(); const first=buckets[0],last=buckets.at(-1); const lastHydratable=[...buckets].reverse().find((bucket)=>bucket.querySelector('.tk-zcard')); const lastTop=lastHydratable?.querySelector('.tk-zcard:last-child');
    const leftShadow=Number(getComputedStyle(rail.querySelector('.tk-zone-hshade-left')).opacity); const rightShadow=Number(getComputedStyle(rail.querySelector('.tk-zone-hshade-right')).opacity);
    return { ok:Math.abs(state.x-state.min)<1&&first?.dataset.zoneLod==='parked'&&last?.dataset.zoneLod==='full'&&lastHydratable?.dataset.zoneLod==='full'&&lastTop&&!lastTop.classList.contains('is-lazy-shell')&&leftShadow>.9&&rightShadow<.05,
      detail:JSON.stringify({state,shadows:[leftShadow,rightShadow],lod:[first?.dataset.zoneLod,last?.dataset.zoneLod,lastHydratable?.dataset.zoneLod]}) };
  });
  const companyHistoryViewport = await page.evaluate(() => window.peopleCards.zoneScrollState());
  await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Home remains visually free of viewport navigation even when Back history exists', () => {
    const cluster=document.querySelector('.crm-module-switch');const state=window.crmDeskTransit.historyState();
    return { ok:!!cluster&&cluster.hidden&&state.canBack&&!state.canForward,
      detail:JSON.stringify({state:{index:state.index,length:state.length,canBack:state.canBack,canForward:state.canForward},hidden:cluster?.hidden}) };
  });
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown',{ bubbles:true,cancelable:true,button:3 })));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Back restores the exact room viewport and reveals the symmetric room controls', (expected) => {
    const cluster=document.querySelector('.crm-module-switch');const back=cluster?.querySelector('[data-crm-history-back]');const home=cluster?.querySelector('.crm-home-control');const forward=cluster?.querySelector('[data-crm-history-forward]');
    const rects=[back,home,forward].map((button)=>button?.getBoundingClientRect());const state=window.crmDeskTransit.historyState();const viewport=window.peopleCards.zoneScrollState();
    return document.body.dataset.crmModule==='people'&&!cluster.hidden&&cluster.tagName==='NAV'&&state.canForward&&!forward.disabled&&Math.abs(viewport.x-expected.x)<1
      &&back?.ariaLabel==='Back'&&home?.ariaLabel==='Return Home'&&forward?.ariaLabel==='Forward'&&rects.every(Boolean)&&rects[0].right<rects[1].left&&rects[1].right<rects[2].left;
  }, companyHistoryViewport);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown',{ bubbles:true,cancelable:true,button:4 })));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Physical Mouse 5 follows Forward history without exposing controls at Home', () => document.body.dataset.crmModule==='home'&&document.querySelector('.crm-module-switch')?.hidden&&window.crmDeskTransit.historyState().canBack);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown',{ bubbles:true,cancelable:true,button:3 })));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Physical Mouse 4 follows the same Back viewport history', () => document.body.dataset.crmModule==='people'&&window.crmDeskTransit.historyState().canForward);
  await page.click('[data-crm-history-forward]');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Forward returns Home without leaving the room controls instantiated onscreen', () => document.body.dataset.crmModule==='home'&&document.querySelector('.crm-module-switch')?.hidden&&!window.crmDeskTransit.historyState().canForward);
  await page.evaluate(() => window.crmHomePreviews?.waitForIdle?.());
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown',{ bubbles:true,cancelable:true,button:3 })));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await page.evaluate(() => window.peopleCards.scrollZonesBy(-9999, true));
  await sleep(100);
  await page.evaluate(async () => { window.crmCompanyDive.setActive(true); await window.crmCompanyDive.refresh(); });
  await page.waitForFunction(() => document.querySelectorAll('.crm-company-bucket').length === 16, { timeout: 10000 });
  await check('Company-dive buckets keep their proportions and use native viewport LOD', () => {
    const buckets = [...document.querySelectorAll('.crm-company-bucket')];
    const grid=document.querySelector('.crm-company-grid');
    return buckets.length === 16 && grid.scrollHeight>grid.clientHeight && getComputedStyle(buckets.at(-1)).contentVisibility === 'auto' && buckets.every((bucket) => {
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
    const items = [...(menu?.querySelectorAll('.tk-menu-item') || [])];
    const labels = items.map((item) => item.textContent.trim().toLowerCase());
    return !!menu && menu.classList.contains('crm-menu-surface') && !!action
      && action.textContent.trim().toLowerCase() === 'conversation history'
      && items.length === 4 && labels.includes('edit') && labels.includes('move to trash')
      && labels.some((label) => ['make small','make large'].includes(label))
      && !labels.includes('activity') && !labels.includes('appearance');
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
    const kinds = new Set(events.map((event) => event.dataset.historyKind));
    const checks = {
      canonical: history.classList.contains('crm-menu-surface'),
      compact: rect.width <= 370 && rect.height <= 540,
      adjacent,
      clearHeading: history.querySelector('.crm-person-history-kicker')?.textContent.trim() === 'Conversation history',
      noRepeatedIdentity: !history.querySelector('.crm-person-history-title'),
      noSeedNoise: !events.some((event) => /^seed(?:ed|ing)?\b/i.test(event.querySelector('.crm-person-history-event-content')?.textContent.trim() || '')),
      completeThread: events.length >= 5 && kinds.size >= 3,
      transparentShell: shellStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', ''].includes(shellStyle.backdropFilter),
      composerTucked: !!history.querySelector('[data-person-history-composer][hidden]'),
      noExtraneousChrome: !history.querySelector('[data-history-filter],.crm-person-history-summary,.crm-person-history-sidebar,.crm-person-history-filters'),
      canonicalActions: [...history.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action')),
    };
    return { ok: Object.values(checks).every(Boolean), detail: JSON.stringify({ ...checks, events: events.length, kinds: [...kinds], rect: [rect.width, rect.height] }) };
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
  await page.$eval('[data-person-history-close]', (button) => button.click());
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
      if (!action) return false;
      const icon = action.querySelector(':scope > svg');
      const style = getComputedStyle(action);
      const accessibleName = action.getAttribute('aria-label') || action.getAttribute('title') || '';
      return action.classList.contains('crm-secondary-control')
        && accessibleName.trim().length > 3
        && !!icon && icon.getAttribute('viewBox') === '0 0 24 24'
        && style.width === '46px' && style.height === '46px'
        && (style.borderRadius === '50%' || parseFloat(style.borderRadius) >= 22);
    });
    await check(`${key} keeps dormant actions hidden, reserves fan tabs for corner decks, and keeps unstack controls out of buckets`, () => {
      const room = document.querySelector('[data-crm-theater]:not([hidden])');
      const fans = [...room.querySelectorAll('.tk-arrow')];
      const dormant = [...room.querySelectorAll('.tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
      const spreads = [...room.querySelectorAll('.tk-zone-spread')];
      return dormant.some((element) => element.matches('.tk-stack-btn'))
        && dormant.some((element) => element.matches('.tk-deck-trash'))
        && dormant.every((element) => getComputedStyle(element).display === 'none')
        && fans.length >= 2 && fans.every((element) => !element.closest('.tk-zone')
          && element.querySelectorAll('.tk-fan-card').length === 3 && !element.querySelector('.tk-fan-motion')
          && !element.classList.contains('crm-menu-action'))
        && spreads.length === 0;
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
  await check('Ticket bucket scrollbars are centered in their card-to-edge bezels', () => {
    const buckets=[...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zone')];
    const geometry=buckets.map((bucket)=>{const br=bucket.getBoundingClientRect(),bar=bucket.querySelector('.tk-zsb')?.getBoundingClientRect(),card=bucket.querySelector('.tk-zcard')?.getBoundingClientRect();return{on:bucket.querySelector('.tk-zsb')?.classList.contains('is-on'),outer:bar?br.right-bar.right:null,inner:bar&&card?bar.left-card.right:null};});
    return { ok:geometry.length===3&&geometry.every((item)=>!item.on||(item.outer>=9&&item.outer<=13&&Math.abs(item.outer-item.inner)<=1)), detail:JSON.stringify(geometry) };
  });
  await check('Tickets exposes sleek corner fan tabs while keeping dormant actions hidden', () => {
    const room = document.querySelector('[data-crm-theater="tickets"]:not([hidden])');
    const fans = [...room.querySelectorAll('.tk-deck-left > .tk-arrow, .tk-deck-right > .tk-arrow')];
    const dormant = [...room.querySelectorAll('.tk-stack-btn, .tk-deck-trash, .tk-empty-trash')];
    const spreads = [...room.querySelectorAll('.tk-zone-spread')];
    return dormant.some((element) => element.matches('.tk-stack-btn[aria-label="Create a ticket"]'))
      && dormant.some((element) => element.matches('.tk-deck-trash'))
      && dormant.every((element) => getComputedStyle(element).display === 'none')
      && fans.length === 2 && fans.every((element) => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        const glyph = getComputedStyle(element, '::before');
        return Math.abs(rect.width - 46) <= 1 && Math.abs(rect.height - 46) <= 1
          && (style.borderRadius === '50%' || parseFloat(style.borderRadius) >= 22)
          && element.classList.contains('crm-secondary-control')
          && style.display === 'flex' && style.alignItems === 'center' && style.justifyContent === 'center'
          && Math.abs(parseFloat(glyph.width) - 18) <= 1 && Math.abs(parseFloat(glyph.height) - 18) <= 1
          && glyph.maskImage !== 'none'
          && element.getAttribute('aria-expanded') === 'false'
          && element.querySelectorAll('.tk-fan-card').length === 3 && !element.querySelector('.tk-fan-motion')
          && !element.closest('.tk-zone') && !element.classList.contains('crm-menu-action');
      })
      && spreads.length === 0;
  });
  await page.click('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left > .tk-arrow');
  await sleep(520);
  await check('The left corner stack fans its original cards outward without replacement', () => {
    const deck = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left');
    const fan = deck?.querySelector(':scope > .tk-arrow'); const cards = [...(deck?.querySelectorAll('.tk-card') || [])];
    const rects = cards.map((card) => card.getBoundingClientRect()); const ids = cards.map((card) => card.dataset.id);
    const span = rects.length ? Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left)) : 0;
    return { ok:deck?.classList.contains('is-fanned') && fan?.getAttribute('aria-expanded') === 'true'
      && /^collapse /i.test(fan?.getAttribute('aria-label') || '') && new Set(ids).size === ids.length
      && span > (rects[0]?.width || 0) * 3, detail:`${cards.length} unchanged cards · ${Math.round(span)}px fan` };
  });
  const leftFanPoint = await page.$eval('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left', (deck) => { const bar=deck.querySelector('.tk-bar').getBoundingClientRect(); return { x:(bar.left+bar.right)/2, y:Math.min(innerHeight-2,bar.bottom+3), barBottom:bar.bottom }; });
  await page.mouse.move(leftFanPoint.x, leftFanPoint.y); await page.mouse.wheel({ deltaY:700 }); await sleep(420);
  await check('The fanned stack scrolls from below its scrollbar with adaptive edge shading', (point) => {
    const deck = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(deck.querySelector('.tk-track')).transform);
    const shades = [...deck.querySelectorAll('.tk-edge-shade')].map((shade) => parseFloat(shade.style.width || '0'));
    return { ok:point.y>point.barBottom&&matrix.m41 < -1 && deck.querySelector('.tk-bar')?.classList.contains('is-on') && shades.some((width) => width > 0), detail:`x ${Math.round(matrix.m41)} · shade ${Math.round(Math.max(0,...shades))}px` };
  }, leftFanPoint);
  await check('Open fans remain live interactions but are excluded from Home preview state', () => {
    const state = window.ticketStacks?.homePreviewState?.();
    const deck = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left');
    return deck?.classList.contains('is-fanned')
      && state?.fan?.left?.open === false && state.fan.left.scrollX === 0
      && state?.fan?.right?.open === false && state.fan.right.scrollX === 0;
  });
  await page.evaluate(async () => {
    const state = window.ticketStacks.homePreviewState();
    state.fan.left = { open:true, scrollX:-240 };
    await window.ticketStacks.applyHomePreviewState(state);
  });
  await sleep(240);
  await check('Applying a legacy open-fan handoff restores canonical collapsed buckets', () => {
    const state = window.ticketStacks?.homePreviewState?.();
    const decks = [...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left, [data-crm-theater="tickets"]:not([hidden]) .tk-deck-right')];
    return decks.length === 2
      && decks.every((deck) => !deck.classList.contains('is-fanned')
        && deck.querySelector(':scope > .tk-arrow')?.getAttribute('aria-expanded') === 'false')
      && Object.values(state?.fan || {}).every((fan) => fan.open === false && fan.scrollX === 0);
  });
  await page.click('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-right > .tk-arrow'); await sleep(520);
  await check('The right corner stack mirrors the same fan choreography', () => {
    const left = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left');
    const right = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-right');
    const fan = right?.querySelector(':scope > .tk-arrow'); const rects = [...(right?.querySelectorAll('.tk-card') || [])].map((card) => card.getBoundingClientRect());
    const span = rects.length ? Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left)) : 0;
    return { ok:!left?.classList.contains('is-fanned') && right?.classList.contains('is-fanned') && fan?.getAttribute('aria-expanded') === 'true'
      && span > (rects[0]?.width || 0) * 3, detail:`${rects.length} cards · ${Math.round(span)}px mirrored fan` };
  });
  await page.click('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-right > .tk-arrow'); await sleep(520);
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
  await sleep(760);
  await check('Left-click runs the ticket-reference card flight and current-stage work screen', () => (
    !!document.querySelector('.ticket-detail-overlay:not([hidden]) .td-card')
      && !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail')
      && document.querySelectorAll('.ticket-detail .td-field').length === 2
      && !!document.querySelector('.ticket-detail .td-prio')
      && !!document.querySelector('.ticket-detail [data-field="assignee"]')
      && !!document.querySelector('.ticket-detail .td-save')
      && !document.querySelector('.ticket-detail .td-acc, .ticket-detail .td-edit, .ticket-detail .td-meta, .ticket-detail .td-time, .ticket-detail .td-acts, .ticket-detail .td-log')
  ));
  await check('Ticket detail unfolds beyond its card, fits its work surface, and keeps the canonical glass', () => {
    const overlay = document.querySelector('.ticket-detail-overlay:not([hidden])');
    const panel = overlay?.querySelector('.ticket-detail');
    const scrim = overlay?.querySelector('.td-scrim');
    const reference = document.querySelector('.auth-profile-menu');
    if (!overlay || !panel || !reference) return false;
    const rect = panel.getBoundingClientRect(); const actual = getComputedStyle(panel); const expected = getComputedStyle(reference); const overlayStyle = getComputedStyle(overlay);
    const ok = panel.classList.contains('crm-menu-surface') && rect.width >= 340 && rect.width <= 440 && rect.height >= 160 && rect.height <= 240
      && panel.scrollHeight <= panel.clientHeight + 1 && !['auto','scroll'].includes(actual.overflowY)
      && overlayStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && ['none', ''].includes(overlayStyle.backdropFilter)
      && (!scrim || getComputedStyle(scrim).display === 'none')
      && [...panel.querySelectorAll('button')].every((button) => button.classList.contains('crm-menu-action'))
      && [...panel.querySelectorAll('input,textarea,select')].every((input) => input.classList.contains('crm-menu-input'))
      && ['backgroundImage', 'backdropFilter', 'borderTopColor', 'borderRadius', 'boxShadow'].every((property) => actual[property] === expected[property]);
    return { ok, detail:JSON.stringify({ rect:[rect.width,rect.height], scroll:[panel.scrollHeight,panel.clientHeight,actual.overflowY], overlay:[overlayStyle.backgroundColor,overlayStyle.backdropFilter], scrim:scrim&&getComputedStyle(scrim).display,
      buttons:[...panel.querySelectorAll('button')].filter((button)=>!button.classList.contains('crm-menu-action')).map((button)=>button.className), inputs:[...panel.querySelectorAll('input,textarea,select')].filter((input)=>!input.classList.contains('crm-menu-input')).map((input)=>input.className),
      parity:['backgroundImage','backdropFilter','borderTopColor','borderRadius','boxShadow'].filter((property)=>actual[property]!==expected[property]).map((property)=>[property,actual[property],expected[property]]) }) };
  });
  await page.keyboard.press('Escape');
  await sleep(520);
  await page.click(ticketCard, { button: 'right' });
  await page.waitForSelector('.tk-menu', { timeout: 5000 });
  await check('Right-click keeps the ticket command menu concise and state-aware', () => {
    const items = [...document.querySelectorAll('.tk-menu .tk-menu-item')];
    const actions = items.map((item) => item.dataset.act);
    return document.querySelector('.tk-menu')?.classList.contains('crm-menu-surface')
      && items.every((item) => item.classList.contains('crm-menu-action'))
      && items.length === 5 && ['edit', 'size', 'activity', 'trash'].every((action) => actions.includes(action))
      && ['claim', 'resolve', 'reopen'].filter((action) => actions.includes(action)).length === 1
      && !actions.includes('appearance');
  });
  await page.click('.tk-menu .tk-menu-item[data-act="activity"]');
  await page.waitForSelector('.tk-menu.tk-activity', { timeout: 5000 });
  await check('Ticket activity is a single-purpose submenu without repeated identity', () => {
    const menu = document.querySelector('.tk-menu.tk-activity');
    return menu?.querySelector('.tk-act-hd')?.textContent.trim() === 'Activity'
      && !!menu.querySelector('.tk-act-compose .crm-menu-input[placeholder="Add note"]')
      && !menu.querySelector('.tk-menu-item, .tk-swatches, .tk-menu-check');
  });
  await page.keyboard.press('Escape');
  await page.click(ticketCard, { button: 'right' });
  await page.waitForSelector('.tk-menu .tk-menu-item[data-act="edit"]', { timeout: 5000 });
  await page.click('.tk-menu .tk-menu-item[data-act="edit"]');
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail', { timeout: 5000 });
  await check('Right-click edit opens that same focused stage screen', () => (
    !!document.querySelector('.ticket-detail .td-field')
      && !!document.querySelector('.ticket-detail .td-save')
      && !document.querySelector('.ticket-detail .td-acc, .ticket-detail .td-act, .ticket-detail [data-meta="title"]')
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
  await check('Ticket buckets retain the same compact stack without a top-right unstack control', ({ selector, before }) => {
    const bucket = document.querySelector(selector); const cards = [...bucket.querySelectorAll('.tk-zcard')];
    const step = cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top;
    return { ok:!bucket.querySelector('.tk-zone-spread') && JSON.stringify(cards.map((card) => card.dataset.id)) === JSON.stringify(before.ids)
      && Math.abs(step-before.step)<1 && !bucket.classList.contains('is-stack-expanded'), detail:`${Math.round(step)}px · ${cards.length} same cards` };
  }, { selector:bucketSelector, before:collapsedStack });

  const routedTicketTitle = await page.evaluate(async () => {
    const result = await window.tickets?.list?.();
    const ticket = result?.tickets?.[0];
    return ticket?.title || ticket?.companyLabel || '';
  });
  await page.evaluate((query) => window.crmSearchDeck.setQuery(query), routedTicketTitle);
  await page.waitForSelector('.crm-search-result[data-entity="tickets"]', { timeout: 5000 });
  await page.click('.crm-search-result[data-entity="tickets"]');
  await page.waitForSelector('.ticket-detail-overlay:not([hidden]) .ticket-detail', { timeout: 5000 });
  await check('Ticket search results route to the reference stage screen, never the generic record panel', () => (
    !!document.querySelector('.ticket-detail-overlay:not([hidden]) .td-card .ticket-body')
      && !!document.querySelector('.ticket-detail .td-field')
      && !!document.querySelector('.ticket-detail .td-save')
      && !document.querySelector('.ticket-detail .td-acc, .ticket-detail .td-act')
      && !document.querySelector('.record-world-shell:not([hidden])')
  ));
  await page.keyboard.press('Escape');
  await sleep(520);

  const calendarProjectPreview = await page.evaluate(async () => {
    const projectId = window.__interactionProjectIds?.[0];
    const project = window.crmPlanner.projects().find((item) => item.id === projectId);
    const item = project?.buckets.flatMap((bucket) => bucket.cards || [])[0];
    const now = new Date(); const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const updated = item
      ? await window.crmPlanner.updateItem(item.id, { dueAt:new Date(`${date}T17:00:00`).toISOString() })
      : false;
    window.fractalCalendar.setYear(now.getFullYear()); await window.fractalCalendar.refresh();
    const commitment = (await window.crmDomain.list('commitments', { includeDeleted:false, limit:5000 })).records
      .find((record) => record.links?.some((link) => link.entityType === 'workItems' && String(link.recordId) === String(item?.id)));
    return {
      date,
      month:now.getMonth() + 1,
      itemId:item?.id || '',
      projectId:project?.id || '',
      commitmentId:commitment?.id || '',
      dueAt:commitment?.dueAt || '',
      updated,
      stages:project?.stages?.length || 0,
    };
  });
  await activate('calendar');
  await page.waitForFunction(() => window.fractalCalendar.level() === 0);
  await check('Calendar month tiles point at scheduled child data without mounting a second day tree', (probe) => {
    const month = document.querySelector(
      `[data-crm-theater="calendar"] .fc-level[data-kind="year"] .fc-month[data-month="${probe.month}"]`,
    );
    const object = window.fractalCalendar._objectForElement(month);
    const day = object?.children?.find(
      (child) => window.crmTileSystem.dataOf(child)?.date === probe.date,
    );
    const entries = window.crmTileSystem.dataOf(day)?.entries || [];
    const host = month?.querySelector(':scope > .fc-calendar-tile-preview');
    return {
      ok:!!month && !!host && !!day && entries.length > 0
        && window.crmTileSystem.isObject(object)
        && window.crmTileSystem.isObject(day)
        && !month.querySelector('.fc-day-preview-cell,.fc-day,.fc-chip'),
      detail:`${entries.length} scheduled object(s) on ${probe.date}`,
    };
  }, calendarProjectPreview);
  await check('Calendar year is twelve canonical tiles over one true-acrylic material plane', () => {
    const surface = document.querySelector(
      '[data-crm-theater="calendar"].fc-surface, [data-crm-theater="calendar"] .fc-surface',
    );
    const root = surface?.querySelector('.fc-level[data-kind="year"]');
    const grid = root?.querySelector(':scope > .fc-grid');
    const months = [...(grid?.querySelectorAll(':scope > .fc-month') || [])];
    const previews = [...(grid?.querySelectorAll(
      ':scope > .fc-month > .fc-calendar-tile-preview',
    ) || [])];
    const syntheticPreviews = [...(grid?.querySelectorAll('.fc-day-preview-cell') || [])];
    const realDays = [...(surface?.querySelectorAll(
      '.fc-level[data-kind="year"] .fc-day',
    ) || [])];
    const hiddenRealDays = [...(surface?.querySelectorAll(
      '.fc-expander.fc-warm[data-kind="month"] .fc-day',
    ) || [])];
    const materials = [...(grid?.querySelectorAll(':scope > .crm-tile-material-plane') || [])];
    const yearMaterialOwner = surface?.querySelector(':scope > .fc-year-screen-material-owner');
    const yearMaterial = yearMaterialOwner?.querySelector(':scope > .fc-calendar-year-material');
    const month = months[0];
    const preview = previews[0];
    const reference = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const monthStyle = month && getComputedStyle(month);
    const previewStyle = preview && getComputedStyle(preview);
    const referenceStyle = reference && getComputedStyle(reference);
    const referenceObject = window.crmTileSystem.objectFor(reference);
    const yearMaterialStyle = yearMaterial && getComputedStyle(yearMaterial);
    const yearMaterialOwnerStyle = yearMaterialOwner && getComputedStyle(yearMaterialOwner);
    const referenceBackdrop = referenceStyle?.webkitBackdropFilter
      || referenceStyle?.backdropFilter || '';
    const canonicalMonths = months.filter((entry, index) => {
      const style = getComputedStyle(entry);
      const backdrop = style.webkitBackdropFilter || style.backdropFilter || '';
      const expectedTarget = `${window.fractalCalendar.year()}-${String(index + 1).padStart(2, '0')}`;
      return entry.tagName === 'BUTTON'
        && entry.classList.contains('crm-tile')
        && entry.classList.contains('crm-home-bucket')
        && entry.dataset.tileKind === 'calendar-month'
        && entry.dataset.tileSchemaVersion === '1'
        && entry.dataset.tileTargetId === expectedTarget
        && window.crmTileSystem.isObject(window.fractalCalendar._objectForElement(entry))
        && window.fractalCalendar._objectForElement(entry).objectKind === referenceObject?.objectKind
        && ['none', ''].includes(backdrop)
        && style.backgroundImage === referenceStyle?.backgroundImage;
    });
    const inertPreviews = previews.filter((entry) => {
      const style = getComputedStyle(entry);
      const backdrop = style.webkitBackdropFilter || style.backdropFilter || '';
      return entry.tagName === 'DIV'
        && !entry.matches('button,[data-crm-tile],.crm-home-bucket')
        && ['none', ''].includes(backdrop)
        && style.pointerEvents === 'none';
    });
    const rootStyle = root && getComputedStyle(root);
    const gridStyle = grid && getComputedStyle(grid);
    return {
      ok:previews.length === 12
        && inertPreviews.length === previews.length
        && syntheticPreviews.length === 0
        && months.length === 12
        && canonicalMonths.length === months.length
        && realDays.length === 0
        && hiddenRealDays.length === 0
        && materials.length === 0
        && root?.dataset.crmTileSharedMaterial === 'true'
        && yearMaterial?.dataset.crmTileMaterialReady === 'true'
        && Number(yearMaterial?.dataset.crmTileMaterialCount) === months.length
        && yearMaterial?.dataset.crmTileMaterialParked === 'false'
        && Number(yearMaterialStyle?.opacity) > .998
        && yearMaterialStyle?.visibility === 'visible'
        && (yearMaterialStyle?.webkitBackdropFilter || yearMaterialStyle?.backdropFilter) === referenceBackdrop
        && !['none', ''].includes(yearMaterialStyle?.clipPath)
        && yearMaterialOwnerStyle?.display !== 'none'
        && window.crmTileSystem.isObject(referenceObject)
        && referenceBackdrop.includes('blur(')
        && !!monthStyle && !!previewStyle && !!referenceStyle
        && ['none', ''].includes(monthStyle.webkitBackdropFilter || monthStyle.backdropFilter)
        && monthStyle.backgroundImage === referenceStyle.backgroundImage
        && ['none', ''].includes(previewStyle.webkitBackdropFilter || previewStyle.backdropFilter)
        && ['none', ''].includes(rootStyle?.webkitBackdropFilter || rootStyle?.backdropFilter)
        && ['none', ''].includes(gridStyle?.webkitBackdropFilter || gridStyle?.backdropFilter),
      detail:JSON.stringify({
        monthBackdrop:monthStyle?.webkitBackdropFilter || monthStyle?.backdropFilter,
        yearMaterial:[
          yearMaterial?.dataset.crmTileMaterialReady,
          yearMaterial?.dataset.crmTileMaterialCount,
          yearMaterialStyle?.opacity,
          yearMaterialStyle?.visibility,
          yearMaterialStyle?.webkitBackdropFilter || yearMaterialStyle?.backdropFilter,
        ],
        canonicalMonths:canonicalMonths.length,
        previews:previews.length,
        syntheticPreviews:syntheticPreviews.length,
        inertPreviews:inertPreviews.length,
        realDays:realDays.length,
        hiddenRealDays:hiddenRealDays.length,
        rootMaterialPlanes:materials.length,
        tile:[month?.dataset?.crmTile, month?.dataset?.tileKind, month?.dataset?.tileTargetId],
        preview:[preview?.tagName, preview?.dataset?.previewState, previewStyle?.backdropFilter],
      }),
    };
  });
  await page.evaluate((month) => document.querySelector(`.fc-month[data-month="${month}"]`)?.click(), calendarProjectPreview.month);
  await page.waitForFunction(() => window.fractalCalendar.level() === 1
    && !window.fractalCalendarCamera?.isTransitioning?.(), { timeout:5000 });
  const dayTilePreviewResult = await page.evaluate(
    () => {
      const month = document.querySelector(
        '.fc-expander[data-kind="month"]:not(.fc-warm)',
      );
      const object = window.fractalCalendar._objectForElement(month);
      return window.fractalCalendar.waitForTilePreviews(object?.tile?.id);
    },
  );
  if (dayTilePreviewResult.supported
    && dayTilePreviewResult.ready !== dayTilePreviewResult.total) {
    throw new Error(`Calendar day tile previews did not settle: ${JSON.stringify(dayTilePreviewResult)}`);
  }
  await check('Calendar month and entered day tiles are one canonical tile hierarchy', (probe) => {
    const objectFor = window.fractalCalendar?._objectForElement;
    const graph = window.fractalCalendar?._objectGraph?.();
    const sharedObjectFor = window.crmTileSystem?.objectFor;
    const rootMonth = document.querySelector(
      `.fc-level[data-kind="year"] > .fc-grid > .fc-month[data-month="${probe.month}"]`,
    );
    const pane = document.querySelector(
      `.fc-expander[data-kind="month"][data-month="${probe.month}"]:not(.fc-warm)`,
    );
    const liveDay = pane?.querySelector(
      `:scope > .fc-expander-live .fc-day[data-date="${CSS.escape(probe.date)}"]`,
    );
    const rootMonthObject = objectFor?.(rootMonth);
    const paneObject = objectFor?.(pane);
    const liveObject = objectFor?.(liveDay);
    const graphObject = graph?.children
      ?.flatMap((month) => month.children || [])
      ?.find((day) => window.crmTileSystem.dataOf(day)?.date === probe.date);
    const homeTile = document.querySelector(
      '.crm-home-level > .crm-home-grid > .crm-home-bucket[data-crm-tile]',
    );
    const homeObject = sharedObjectFor?.(homeTile);
    const dayPreview = liveDay?.querySelector(':scope > .fc-calendar-tile-preview');
    const dayCollection = pane?.querySelector(
      ':scope > .fc-expander-live > .fc-day-stage > .fc-days',
    );
    const directChildren = [...(dayCollection?.children || [])];
    const shape = (value) => Object.keys(value || {}).sort().join('|');
    const componentChildren = (element) => [...(element?.children || [])].map(
      (child) => [
        child.tagName,
        child.classList.contains('crm-home-preview'),
      ].join(':'),
    ).join('|');
    const calendarIndex = window.fractalCalendar?._objectIndex?.();
    const homeIndex = window.crmHome?._objectIndex?.();
    const forbiddenDaySurface = [
      '.crm-tile-acrylic',
      '.fc-day-object-view',
      '.fc-day-tile-preview',
      '.fc-day-live-preview',
      '.fc-day-expander-tint',
      '.fc-day-detail-material',
    ].join(',');
    return {
      ok:!!rootMonthObject
        && rootMonthObject === paneObject
        && window.crmTileSystem.isObject(rootMonthObject)
        && window.crmTileSystem.isObject(liveObject)
        && rootMonthObject.children.includes(liveObject)
        && liveObject === graphObject
        && liveObject === sharedObjectFor?.(liveDay)
        && liveDay.dataset.tileObjectView === 'preview'
        && rootMonth.matches('button.crm-tile[data-crm-tile].crm-home-bucket')
        && liveDay.matches('button.crm-tile[data-crm-tile].crm-home-bucket')
        && rootMonth.dataset.crmTileInstance === 'viewport'
        && liveDay.dataset.crmTileInstance === 'viewport'
        && homeTile?.dataset.crmTileInstance === 'viewport'
        && shape(homeObject) === shape(rootMonthObject)
        && shape(rootMonthObject) === shape(liveObject)
        && Object.getPrototypeOf(homeObject) === Object.getPrototypeOf(rootMonthObject)
        && Object.getPrototypeOf(rootMonthObject) === Object.getPrototypeOf(liveObject)
        && calendarIndex?.objectForId(liveObject.tile.id) === liveObject
        && calendarIndex?.pathTo(liveObject).join('/') === [
          rootMonthObject.tile.id,
          liveObject.tile.id,
        ].join('/')
        && homeIndex?.objectForId(homeObject.tile.id) === homeObject
        && dayCollection?.dataset.crmTileCollection === rootMonthObject.tile.id
        && Number(dayCollection?.dataset.crmTileChildCount) === rootMonthObject.children.length
        && directChildren.length === rootMonthObject.children.length
        && directChildren.every((child, index) => (
          child.dataset.crmTileInstance === 'viewport'
            && objectFor(child) === rootMonthObject.children[index]
        ))
        && componentChildren(homeTile) === componentChildren(rootMonth)
        && componentChildren(rootMonth) === componentChildren(liveDay)
        && !liveDay.querySelector(forbiddenDaySurface)
        && !!rootMonth.querySelector(':scope > .fc-calendar-tile-preview')
        && (probe.captureSupported
          ? !!liveDay.querySelector(
            ':scope > .fc-calendar-tile-preview[data-preview-state="ready"] '
              + '> img.fc-calendar-tile-preview-render',
          )
            && dayPreview?.dataset.previewRenderer === 'calendar-day-full'
          : dayPreview?.dataset.previewState === 'waiting'
            && !!dayPreview.querySelector(':scope > .crm-home-preview-state'))
        && !rootMonth.querySelector('.fc-day-preview-cell,.fc-day'),
      detail:JSON.stringify({
        monthObject:rootMonthObject?.tile?.id,
        paneObject:paneObject?.tile?.id,
        liveObject:liveObject?.tile?.id,
        entries:window.crmTileSystem.dataOf(liveObject)?.entries?.length,
        objectShape:shape(liveObject),
        collection:[
          dayCollection?.dataset.crmTileCollection,
          dayCollection?.dataset.crmTileChildCount,
          directChildren.length,
        ],
        views:[rootMonth?.dataset?.tileObjectView, liveDay?.dataset?.tileObjectView],
        instances:[
          homeTile?.dataset.crmTileInstance,
          rootMonth?.dataset.crmTileInstance,
          liveDay?.dataset.crmTileInstance,
        ],
        componentChildren:componentChildren(liveDay),
        treePath:calendarIndex?.pathTo(liveObject),
      }),
    };
  }, {
    ...calendarProjectPreview,
    captureSupported:dayTilePreviewResult.supported,
  });
  await check('Calendar refresh mutates the shared objects without replacing either view', async (probe) => {
    const monthSelector = `.fc-level[data-kind="year"] .fc-month[data-month="${probe.month}"]`;
    const liveSelector = `.fc-expander[data-kind="month"]:not(.fc-warm) .fc-day[data-date="${CSS.escape(probe.date)}"]`;
    const objectFor = window.fractalCalendar._objectForElement;
    const month = document.querySelector(monthSelector);
    const preview = month?.querySelector(':scope > .fc-calendar-tile-preview');
    const live = document.querySelector(liveSelector);
    const dayPreview = live?.querySelector(':scope > .fc-calendar-tile-preview');
    const dayPreviewImage = dayPreview?.querySelector(':scope > .fc-calendar-tile-preview-render');
    const object = objectFor(live);
    const entries = window.crmTileSystem.dataOf(object)?.entries;
    await window.fractalCalendar.refresh();
    if (probe.captureSupported) {
      await window.fractalCalendar.waitForTilePreviews(objectFor(month)?.tile?.id);
    }
    const nextMonth = document.querySelector(monthSelector);
    const nextPreview = nextMonth?.querySelector(':scope > .fc-calendar-tile-preview');
    const nextLive = document.querySelector(liveSelector);
    const nextDayPreview = nextLive?.querySelector(':scope > .fc-calendar-tile-preview');
    const nextDayPreviewImage = nextDayPreview?.querySelector(':scope > .fc-calendar-tile-preview-render');
    return {
      ok:!!object
        && month === nextMonth
        && preview === nextPreview
        && live === nextLive
        && dayPreview === nextDayPreview
        && dayPreviewImage === nextDayPreviewImage
        && object === objectFor(nextLive)
        && objectFor(nextMonth)?.children?.includes(object)
        && entries === window.crmTileSystem.dataOf(object).entries
        && (probe.captureSupported
          ? nextDayPreview?.dataset.previewRenderer === 'calendar-day-full'
          : nextDayPreview?.dataset.previewState === 'waiting'
            && !!nextDayPreview.querySelector(':scope > .crm-home-preview-state'))
        && !nextMonth.querySelector('.fc-day-preview-cell,.fc-day'),
      detail:JSON.stringify({
        object:object?.tile?.id,
        samePreviewNode:preview === nextPreview,
        sameLiveNode:live === nextLive,
        sameDayPreviewNode:dayPreview === nextDayPreview,
        sameDayPreviewImage:dayPreviewImage === nextDayPreviewImage,
        sameEntries:entries === window.crmTileSystem.dataOf(object)?.entries,
        entries:window.crmTileSystem.dataOf(object)?.entries?.length,
      }),
    };
  }, {
    ...calendarProjectPreview,
    captureSupported:dayTilePreviewResult.supported,
  });
  await check('Calendar is fed only by commitments', () => {
    const graph = window.fractalCalendar?._objectGraph?.();
    const dayObjects = graph?.children?.flatMap((month) => month.children || []) || [];
    const entries = dayObjects.flatMap(
      (dayObject) => window.crmTileSystem.dataOf(dayObject)?.entries || [],
    );
    const renderedDays = [...document.querySelectorAll(
      '.fc-expander[data-kind="month"]:not(.fc-warm) .fc-day[data-crm-tile-instance="viewport"]',
    )];
    return entries.length > 0
      && entries.every((entry) => entry.type === 'commitment')
      && renderedDays.every((day) => !day.querySelector('.fc-chip,.fc-day-live-preview'))
      && !document.querySelector(
        '.fc-calendar-tile-preview .crm-planner-card,.fc-calendar-tile-preview .crm-planner-bucket',
      );
  });
  await page.mouse.move(1, 1);
  await sleep(60);
  await check('Expanded calendar keeps the same tiles on one true-acrylic screen plane', () => {
    const pane = document.querySelector(
      '[data-crm-theater="calendar"] .fc-expander[data-kind="month"]:not(.fc-warm)',
    );
    const live = pane?.querySelector(':scope > .fc-expander-live');
    const days = [...(live?.querySelectorAll('.fc-day') || [])];
    const details = [...(live?.querySelectorAll('.fc-chip, .fc-empty, .fc-day-detail') || [])];
    const localMaterial = live?.querySelector(':scope > .crm-tile-material-plane');
    const surface = pane?.closest('.fc-surface');
    const screenMaterialOwner = surface?.querySelector(':scope > .fc-day-screen-material-owner');
    const screenMaterial = screenMaterialOwner?.querySelector(':scope > .fc-day-screen-material');
    const reference = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const paneStyle = pane && getComputedStyle(pane);
    const referenceStyle = reference && getComputedStyle(reference);
    const localMaterialStyle = localMaterial && getComputedStyle(localMaterial);
    const screenMaterialStyle = screenMaterial && getComputedStyle(screenMaterial);
    const screenMaterialOwnerStyle = screenMaterialOwner && getComputedStyle(screenMaterialOwner);
    const referenceBackdrop = referenceStyle?.webkitBackdropFilter || referenceStyle?.backdropFilter || '';
    const isObjectsOnly = (element) => {
      const style = getComputedStyle(element);
      return !element.classList.contains('crm-menu-surface')
        && !element.classList.contains('crm-menu-item')
        && (style.backdropFilter === 'none' || style.backdropFilter === '');
    };
    const dayChecks = days.map((day) => {
      const tileStyle = getComputedStyle(day);
      const preview = day.querySelector(':scope > .crm-home-preview.fc-calendar-tile-preview');
      return {
        date:day.dataset.date,
        classes:day.className,
        children:day.children.length,
        preview:!!preview,
        previewState:preview?.dataset.previewState || '',
        background:tileStyle.backgroundImage,
        backdrop:tileStyle.webkitBackdropFilter || tileStyle.backdropFilter || '',
        forbidden:!!day.querySelector(
          '.crm-tile-acrylic,.fc-day-object-view,.fc-day-tile-preview,.fc-day-live-preview',
        ),
        ok:day.classList.contains('crm-home-bucket')
          && day.dataset.tileKind === 'calendar-day'
          && day.dataset.tileSchemaVersion === '1'
          && day.dataset.tileTargetId === day.dataset.date
          && day.children.length === 1
          && !!preview
          && !day.querySelector(
            '.crm-tile-acrylic,.fc-day-object-view,.fc-day-tile-preview,.fc-day-live-preview',
          )
          && tileStyle.backgroundImage === referenceStyle?.backgroundImage
          && ['none', ''].includes(
            tileStyle.webkitBackdropFilter || tileStyle.backdropFilter,
          ),
      };
    });
      const ok = days.length >= 28 && days.length <= 31
      && !!paneStyle && paneStyle.backgroundImage === 'none' && ['none', ''].includes(paneStyle.backdropFilter)
      && localMaterial?.dataset.crmTileMaterialReady === 'true'
      && Number(localMaterial.dataset.crmTileMaterialCount) === days.length
      && localMaterial.dataset.crmTileMaterialMuted === 'true'
      && ['none', ''].includes(localMaterialStyle?.webkitBackdropFilter || localMaterialStyle?.backdropFilter)
      && screenMaterial?.dataset.crmTileMaterialReady === 'true'
      && Number(screenMaterial.dataset.crmTileMaterialCount) === days.length
      && screenMaterial.dataset.crmTileMaterialParked === 'false'
      && Number(screenMaterialStyle?.opacity) > .998
      && screenMaterialStyle?.visibility === 'visible'
      && screenMaterialOwnerStyle?.display !== 'none'
      && !['none', ''].includes(screenMaterialOwnerStyle?.clipPath)
      && (screenMaterialStyle?.webkitBackdropFilter || screenMaterialStyle?.backdropFilter)
        ?.includes('blur(26px)')
      && !!referenceStyle && referenceBackdrop.includes('blur(26px)')
      && dayChecks.every((day) => day.ok)
      && details.every(isObjectsOnly);
    return {
      ok,
      detail:JSON.stringify({
        pane:pane?.className || '',
        days:days.length,
        paneMaterial:[
          paneStyle?.backgroundImage,
          paneStyle?.webkitBackdropFilter || paneStyle?.backdropFilter,
        ],
        sharedMaterial:[
          screenMaterial?.dataset.crmTileMaterialReady,
          screenMaterial?.dataset.crmTileMaterialCount,
          screenMaterialStyle?.opacity,
          screenMaterialStyle?.webkitBackdropFilter || screenMaterialStyle?.backdropFilter,
          screenMaterialOwnerStyle?.clipPath,
        ],
        localDelegate:[
          localMaterial?.dataset.crmTileMaterialReady,
          localMaterial?.dataset.crmTileMaterialCount,
          localMaterial?.dataset.crmTileMaterialMuted,
          localMaterialStyle?.webkitBackdropFilter || localMaterialStyle?.backdropFilter,
        ],
        reference:[
          referenceStyle?.backgroundImage,
          referenceBackdrop,
        ],
        failedDays:dayChecks.filter((day) => !day.ok).slice(0, 3),
        details:details.length,
      }),
    };
  });
  await check('Project work on a calendar day carries its automatic pipeline preview', (probe) => {
    const day = document.querySelector(
      `.fc-expander[data-kind="month"]:not(.fc-warm) `
        + `.fc-day[data-date="${CSS.escape(probe.date)}"]`,
    );
    const dayObject = window.fractalCalendar?._objectForElement?.(day);
    const entry = window.crmTileSystem.dataOf(dayObject)?.entries?.find(
      (candidate) => String(candidate.id) === String(probe.commitmentId),
    );
    const reached = entry?.projectStages?.findIndex(
      (stage) => String(stage.id) === String(entry.stageId),
    ) ?? -1;
    const preview = day?.querySelector(':scope > .fc-calendar-tile-preview');
    const previewImage = preview?.querySelector(':scope > .fc-calendar-tile-preview-render');
    return { ok:!!entry
      && entry.type === 'commitment'
      && entry.projectStages.length === probe.stages
      && reached >= 0
      && (probe.captureSupported
        ? preview?.dataset.previewState === 'ready' && !!previewImage
        : preview?.dataset.previewState === 'waiting'
          && !!preview.querySelector(':scope > .crm-home-preview-state'))
      && !day.querySelector('.crm-planner-card,.crm-planner-bucket'),
      detail:JSON.stringify({
        mappedStages:entry?.projectStages?.length || 0,
        reached,
        projectStages:probe.stages,
        projectId:probe.projectId,
        itemId:probe.itemId,
        commitmentId:probe.commitmentId,
        dueAt:probe.dueAt,
        updated:probe.updated,
        day:day?.dataset.date || '',
        dayClasses:day?.className || '',
        previewState:preview?.dataset.previewState || '',
        previewRenderer:preview?.dataset.previewRenderer || '',
        previewImage:!!previewImage,
      }) };
  }, {
    ...calendarProjectPreview,
    captureSupported:dayTilePreviewResult.supported,
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
  await check('Projects is a true tile-within-tile world using the Home tile primitive', () => {
    const theater = document.querySelector('[data-crm-theater="planner"]:not([hidden])');
    const projects = [...(theater?.querySelectorAll('.crm-project-bucket[data-planner-project]') || [])];
    const gallery = theater?.querySelector('.crm-project-tile-grid');
    const snapshots = window.crmPlanner.projects();
    const homeTile = document.querySelector('.crm-home-bucket[data-module="planner"]');
    const homeStyle = homeTile && getComputedStyle(homeTile); const firstStyle = projects[0] && getComputedStyle(projects[0]);
    return { ok:window.crmPlanner.level() === 0 && window.crmPlanner.view() === 'projects'
      && projects.length >= 3 && !theater.querySelector('.crm-planner-bucket,.crm-planner-card')
      && gallery?.getAttribute('aria-label') === 'Projects'
      && theater.querySelector('[data-project-title="create"] .crm-home-title')?.textContent.trim() === 'Create project'
      && projects.every((project) => {
        const snapshot = snapshots.find((item) => item.id === project.dataset.plannerProject);
        const title = theater.querySelector(`[data-project-title="${CSS.escape(project.dataset.plannerProject)}"] .crm-home-title`);
        const preview = project.querySelector(':scope > .crm-home-preview');
        return !!snapshot && project.tagName === 'BUTTON' && project.classList.contains('crm-home-bucket')
          && !project.classList.contains('crm-menu-action') && title?.textContent.trim() === snapshot.title
          && !!preview && !!preview.querySelector(':scope > .crm-home-preview-state[role="status"]')
          && !project.querySelector('.crm-project-preview,.crm-project-preview-stage,.tk-card,.crm-planner-card,.crm-planner-bucket');
      })
      && !theater.querySelector('.crm-project-create.crm-menu-action')
      && firstStyle?.backgroundImage === homeStyle?.backgroundImage
      && firstStyle?.borderRadius === homeStyle?.borderRadius
      && getComputedStyle(theater.querySelector('[data-project-title] .crm-home-title')).fontSize === getComputedStyle(document.querySelector('.crm-home-title-layer .crm-home-title')).fontSize,
      detail:`${projects.length} project tiles / ${snapshots.length} projects` };
  });
  const projectRail = await page.evaluate(() => {
    const shell=document.querySelector('.crm-project-gallery-shell');const scroller=shell?.querySelector('.crm-project-gallery-scroll');const grid=shell?.querySelector('.crm-project-tile-grid');const bar=shell?.querySelector('.crm-project-gallery-hsb');const thumb=bar?.querySelector('.crm-project-gallery-hth');
    const tiles=[...(grid?.querySelectorAll('.crm-project-bucket')||[])];const rects=tiles.slice(0,4).map((tile)=>{const rect=tile.getBoundingClientRect();return[Math.round(rect.left),Math.round(rect.top),Math.round(rect.width),Math.round(rect.height)]});const style=scroller&&getComputedStyle(scroller);
    const shadows=['::before','::after'].map((pseudo)=>{const value=getComputedStyle(shell,pseudo);return[value.position,value.top,value.bottom];});
    return{rows:Number(grid?.dataset.projectRows||0),overflow:[style?.overflowX,style?.overflowY],maximum:(scroller?.scrollWidth||0)-(scroller?.clientWidth||0),barOn:bar?.classList.contains('is-on'),thumb:thumb?.getBoundingClientRect().width||0,track:bar?.getBoundingClientRect().width||0,rects,shadows};
  });
  await check('Projects use the shared equal-fit tile grid and stay inside one viewport', (state) => ({
    ok:state.rows>=1&&state.overflow[0]==='auto'&&state.overflow[1]==='hidden'&&state.maximum<=1&&!state.barOn
      &&state.shadows.every(([position,top,bottom])=>position==='fixed'&&top==='0px'&&bottom==='0px')
      &&state.rects.length===4
      &&Math.max(...state.rects.map((rect)=>rect[2]))-Math.min(...state.rects.map((rect)=>rect[2]))<=1
      &&Math.max(...state.rects.map((rect)=>rect[3]))-Math.min(...state.rects.map((rect)=>rect[3]))<=1,
    detail:JSON.stringify(state),
  }), projectRail);
  const projectRailWheel = await page.evaluate(() => {
    const shell=document.querySelector('.crm-project-gallery-shell');const scroller=shell?.querySelector('.crm-project-gallery-scroll');const bar=shell?.querySelector('.crm-project-gallery-hsb');const thumb=bar?.querySelector('.crm-project-gallery-hth');scroller.scrollLeft=0;scroller.dispatchEvent(new Event('scroll'));
    const before={left:scroller.scrollLeft,thumbLeft:thumb.getBoundingClientRect().left};const barRect=bar.getBoundingClientRect(),scrollRect=scroller.getBoundingClientRect();bar.dispatchEvent(new WheelEvent('wheel',{deltaY:420,bubbles:true,cancelable:true,clientX:barRect.left+barRect.width/2,clientY:barRect.top+barRect.height/2}));
    return new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({before,after:scroller.scrollLeft,thumbLeft:thumb.getBoundingClientRect().left,point:[barRect.top,scrollRect.bottom],shadows:[Number(getComputedStyle(shell).getPropertyValue('--crm-project-shadow-left')),Number(getComputedStyle(shell).getPropertyValue('--crm-project-shadow-right'))]}))));
  });
  await check('The fitted project grid does not create a synthetic scroll destination', (state) => ({ ok:Math.abs(state.after)<=1&&Math.abs(state.thumbLeft-state.before.thumbLeft)<=1&&state.shadows[0]===0&&state.shadows[1]===0, detail:JSON.stringify(state) }), projectRailWheel);
  const projectRailRestore = await page.evaluate(async() => {
    const before=document.querySelector('.crm-project-gallery-scroll').scrollLeft;const state=window.crmPlanner.homePreviewState();document.querySelector('.crm-project-gallery-scroll').scrollLeft=0;await window.crmPlanner.applyHomePreviewState(state);const scroller=document.querySelector('.crm-project-gallery-scroll');const after=scroller.scrollLeft;const shadows=[Number(getComputedStyle(document.querySelector('.crm-project-gallery-shell')).getPropertyValue('--crm-project-shadow-left')),Number(getComputedStyle(document.querySelector('.crm-project-gallery-shell')).getPropertyValue('--crm-project-shadow-right'))];scroller.scrollLeft=0;scroller.dispatchEvent(new Event('scroll'));return{before,stored:state.galleryScrollLeft,after,shadows};
  });
  await check('Project gallery rebuild preserves the fitted zero-scroll state', (state) => ({ ok:Math.abs(state.before)<=1&&Math.abs(state.stored)<=1&&Math.abs(state.after)<=1&&state.shadows[0]===0&&state.shadows[1]===0, detail:JSON.stringify(state) }), projectRailRestore);
  const plannerTileStart = await page.$eval('.crm-project-bucket[data-planner-project]', (tile) => tile.dataset.plannerProject);
  await page.focus('.crm-project-bucket[data-planner-project]'); await page.keyboard.press('ArrowRight');
  await page.waitForFunction((start) => document.activeElement?.classList.contains('crm-project-bucket') && document.activeElement.dataset.plannerProject !== start, {}, plannerTileStart);
  await check('Project tiles support spatial keyboard navigation without moving an already-visible rail', () => document.activeElement?.tagName === 'BUTTON' && document.activeElement?.hasAttribute('data-planner-project') && document.querySelector('.crm-project-gallery-scroll')?.scrollLeft === 0);
  // The browser shim has no Electron project-preview capture API, so this
  // branch deliberately validates the live fallback after its normal pointer
  // prewarm. The native suite separately requires the decoded raster path.
  const plannerWarmPoint = await page.evaluate((projectId) => {
    const rect = document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`)?.getBoundingClientRect();
    return rect ? { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 } : null;
  }, plannerTileStart);
  if (plannerWarmPoint) await page.mouse.move(plannerWarmPoint.x, plannerWarmPoint.y);
  await page.waitForFunction((projectId) => !![...document.querySelectorAll('.crm-planner-warm')].find((layer) => layer.dataset.projectId === projectId)
    && !!document.querySelector('.crm-planner-surface .crm-project-screen-acrylic'), { timeout:5000 }, plannerTileStart);
  await sleep(120);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const plannerNestedDive = await page.evaluate((projectId) => new Promise((resolve) => {
    const tile = document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`); const source = tile?.getBoundingClientRect(); const samples = []; const acrylicOpacities = []; const motionAcrylic = []; const releaseAcrylic = []; let acrylicFrames = 0; let objectFrames = 0; let motionKeyframes = []; let releaseKeyframes = []; let screenSpaceFrames = 0;
    if (!tile || !source) { resolve(null); return; }
    const sourceStyle = getComputedStyle(tile);
    const sourceMaterial = {
      backgroundColor:sourceStyle.backgroundColor,
      backgroundImage:sourceStyle.backgroundImage,
      backdropFilter:sourceStyle.webkitBackdropFilter || sourceStyle.backdropFilter,
      borderColor:sourceStyle.borderColor,
      borderStyle:sourceStyle.borderStyle,
      boxShadow:sourceStyle.boxShadow,
    };
    tile.click();
    const tick = () => {
      const layer = window.crmProjectsCamera?.layers?.()[1] || document.querySelector('.crm-planner-project-world'); const rect = layer?.getBoundingClientRect();
      if (rect) samples.push([rect.x, rect.y, rect.width, rect.height]);
      const acrylic=document.querySelector('.crm-planner-surface .crm-project-screen-acrylic');const acrylicFrame=layer?.querySelector(':scope>.crm-project-transition-acrylic');const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const live=layer?.querySelector(':scope>.crm-planner-project-live');const moving=!!window.crmProjectsCamera?.isTransitioning?.();
      if(acrylic){const acrylicStyle=getComputedStyle(acrylic);const acrylicHost=acrylic.parentElement?.classList.contains('crm-project-screen-acrylic-clip')?acrylic.parentElement:acrylic;const hostStyle=getComputedStyle(acrylicHost);const layerStyle=getComputedStyle(layer);const frameStyle=acrylicFrame&&getComputedStyle(acrylicFrame);const opacity=Number(acrylicStyle.opacity);const phase=acrylic.dataset.fractalAcrylicPhase||'';acrylicOpacities.push(opacity);if(phase==='motion')motionAcrylic.push(opacity);if(phase==='release')releaseAcrylic.push(opacity);const animation=acrylic.getAnimations().find((candidate)=>(candidate.effect?.getKeyframes?.()||[]).some((keyframe)=>keyframe.opacity!=null));const keyframes=(animation?.effect?.getKeyframes?.()||[]).map((keyframe)=>({offset:keyframe.computedOffset,opacity:Number(keyframe.opacity)}));if(phase==='motion'&&!motionKeyframes.length)motionKeyframes=keyframes;if(phase==='release'&&!releaseKeyframes.length)releaseKeyframes=keyframes;const backdrop=acrylicStyle.webkitBackdropFilter||acrylicStyle.backdropFilter;const exactMaterial=acrylicStyle.backgroundColor===sourceMaterial.backgroundColor&&acrylicStyle.backgroundImage===sourceMaterial.backgroundImage&&backdrop===sourceMaterial.backdropFilter&&backdrop.includes('blur(')&&backdrop.includes('saturate(');const matrix=hostStyle.transform&&hostStyle.transform!=='none'?new DOMMatrix(hostStyle.transform):new DOMMatrix();if(Math.abs(matrix.a-1)<.001&&Math.abs(matrix.d-1)<.001&&acrylicHost.parentElement===window.crmProjectsCamera?.surface?.()&&hostStyle.clipPath.startsWith('inset('))screenSpaceFrames+=1;if(Number(layerStyle.opacity)>.99&&!layer.style.transition.includes('opacity')&&exactMaterial&&Number(frameStyle?.opacity)>.01&&frameStyle?.backgroundImage==='none'&&frameStyle?.backdropFilter==='none')acrylicFrames+=1;}
      else if(!moving&&acrylicOpacities.length&&acrylicOpacities.at(-1)>.05)acrylicOpacities.push(0);
      if((overlay&&Number(getComputedStyle(overlay).opacity)>.01)||(live&&Number(getComputedStyle(live).opacity)>.01))objectFrames+=1;
      if (moving) { requestAnimationFrame(tick); return; }
      const stable = []; let frame = 0;
      const seat = () => {
        stable.push(JSON.stringify([...document.querySelectorAll('.crm-planner-bucket')].map((bucket) => { const bounds=bucket.getBoundingClientRect(); return [bounds.x,bounds.y,bounds.width,bounds.height]; })));
        if (++frame < 10) requestAnimationFrame(seat);
        else resolve({ source:[source.x,source.y,source.width,source.height], sourceMaterial, motionKeyframes, releaseKeyframes, samples, unique:new Set(samples.map((sample) => sample.map((value) => value.toFixed(1)).join(','))).size,
          stable:new Set(stable).size, acrylicFrames, acrylicOpacities, motionAcrylic, releaseAcrylic, screenSpaceFrames, objectFrames, wallpapers:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length, level:window.crmPlanner.level(), layers:window.crmProjectsCamera?.layers?.().filter(Boolean).length || 0 });
      };
      requestAnimationFrame(seat);
    };
    requestAnimationFrame(tick);
  }), plannerTileStart);
  await check('A project dive animates continuously from its source tile and seats without a layout snap', (probe) => {
    const first = probe?.samples?.[0]; const last = probe?.samples?.at(-1); const acrylic = probe?.acrylicOpacities || []; const motion=probe?.motionAcrylic||[];const release=probe?.releaseAcrylic||[];const releaseSteps=release.slice(1).map((value,index)=>value-release[index]);const releaseIntermediate=release.filter((opacity)=>opacity>.05&&opacity<.95).length;const motionCurve=probe?.motionKeyframes||[];const releaseCurve=probe?.releaseKeyframes||[];const heldCurve=motionCurve.some((frame)=>Math.abs(frame.offset)<.001&&frame.opacity===1)&&motionCurve.some((frame)=>Math.abs(frame.offset-1)<.001&&frame.opacity===1);const endpointCurve=releaseCurve.some((frame)=>Math.abs(frame.offset)<.001&&frame.opacity===1)&&releaseCurve.some((frame)=>Math.abs(frame.offset-1)<.001&&frame.opacity===0);
    return { ok:!!probe && probe.level === 1 && probe.layers === 2 && probe.unique >= 7 && probe.stable === 1 && probe.acrylicFrames >= probe.samples.length-4 && probe.screenSpaceFrames >= probe.acrylicFrames && probe.screenSpaceFrames-probe.acrylicFrames <= 2 && probe.objectFrames >= probe.samples.length-1 && probe.wallpapers === 1
      && acrylic[0] >= .99 && acrylic.at(-1) <= .1 && motion.length >= 16 && motion.every((opacity)=>opacity>=.99) && heldCurve
      && release.length >= 5 && release[0] >= .8 && release.at(-1) <= .2 && releaseIntermediate >= 3 && releaseSteps.every((step)=>step<=.18) && endpointCurve
      && !!first && Math.abs(first[0]-probe.source[0]) <= 1 && Math.abs(first[1]-probe.source[1]) <= 1
      && Math.abs(first[2]-probe.source[2]) <= 1 && Math.abs(first[3]-probe.source[3]) <= 1
      && !!last && Math.abs(last[0]) <= 1 && Math.abs(last[1]) <= 1 && Math.abs(last[2]-innerWidth) <= 1 && Math.abs(last[3]-innerHeight) <= 1,
      detail:JSON.stringify({frames:probe?.samples?.length,unique:probe?.unique,stable:probe?.stable,acrylicFrames:probe?.acrylicFrames,screenSpaceFrames:probe?.screenSpaceFrames,acrylicFirst:acrylic[0],acrylicLast:acrylic.at(-1),motionFrames:motion.length,motionMin:Math.min(1,...motion),releaseFrames:release.length,releaseIntermediate,releaseMaxStep:Math.max(0,...releaseSteps.map(Math.abs)),motionKeyframes:motionCurve,releaseKeyframes:releaseCurve,objectFrames:probe?.objectFrames,wallpapers:probe?.wallpapers,source:probe?.source,last}) };
  }, plannerNestedDive);
  await check('A project tile zooms into its real aligned custom pipeline', (projectId) => {
    const project = window.crmPlanner.projects().find((item) => item.id === projectId); const buckets = [...document.querySelectorAll('.crm-planner-bucket')];
    const header = document.querySelector('.crm-planner-projects'); const first = buckets[0]?.getBoundingClientRect(); const head = header?.getBoundingClientRect();
    return { ok:window.crmPlanner.view() === 'project' && window.crmPlanner.selected() === projectId
      && document.querySelector('.crm-planner-heading')?.textContent.trim() === project?.title
      && document.querySelector('[data-planner-action="projects-back"]')?.classList.contains('crm-secondary-control')
      && document.querySelector('[data-planner-action="projects-back"]')?.getAttribute('aria-label') === 'Back to projects'
      && !!document.querySelector('[data-planner-action="projects-back"] > svg')
      && /Iris Chen/.test(document.querySelector('.crm-planner-project-context')?.textContent || '') && !!document.querySelector('.crm-planner-project-context time')
      && buckets.length === project?.buckets.length && buckets.every((bucket, index) => bucket.classList.contains('tk-zone')
        && bucket.querySelectorAll('.crm-planner-stage-progress .tk-seg').length === buckets.length
        && bucket.querySelectorAll('.crm-planner-stage-progress .tk-seg.g').length === index + 1)
      && !!first && !!head && first.top >= head.bottom + 8 && new Set(buckets.map((bucket) => Math.round(bucket.getBoundingClientRect().top))).size === 1,
      detail:`${project?.title} / ${buckets.length} stages` };
  }, plannerTileStart);
  await page.waitForFunction(()=>{const button=document.querySelector('[data-planner-action="project-menu"]');const rect=button?.getBoundingClientRect();return !!button&&rect.width>0&&rect.height>0&&getComputedStyle(button).visibility!=='hidden'});
  await page.evaluate(()=>document.querySelector('[data-planner-action="project-menu"]')?.click());
  await page.waitForSelector('.crm-planner-context');
  await check('Project options stay minimal and lifecycle-specific', () => [...document.querySelectorAll('.crm-planner-context .crm-menu-action')].map((button)=>button.textContent.trim()).join('|') === 'Project details|Delete project');
  await page.evaluate(() => [...document.querySelectorAll('.crm-planner-context .crm-menu-action')].find((button)=>button.textContent.trim()==='Project details')?.click());
  await page.waitForSelector('.crm-planner-project-editor');
  await check('Project details use one compact canonical surface with only essential fields', () => {
    const form=document.querySelector('.crm-planner-project-editor');const fields=[...form.querySelectorAll('input,textarea,select')].map((field)=>field.name);
    return form.classList.contains('crm-menu-surface')&&fields.join('|')==='title|note|ownerContactId|dueAt'&&form.getBoundingClientRect().width<=380&&getComputedStyle(form).overflowY!=='scroll';
  });
  await page.$eval('.crm-planner-project-editor textarea[name="note"]',(field)=>{field.value='Archive migration, validation, and recovery handoff.';field.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('.crm-planner-project-editor input[name="dueAt"]',(field)=>{field.value='2026-09-18';field.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('.crm-planner-project-editor select[name="ownerContactId"]',(field)=>{field.value='ct_iris';field.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.evaluate(() => document.querySelector('.crm-planner-project-editor')?.requestSubmit());
  await page.waitForFunction((projectId)=>{const project=window.crmPlanner.projects().find((item)=>item.id===projectId);const due=new Date(project?.dueAt||'');return project?.note==='Archive migration, validation, and recovery handoff.'&&project?.ownerContactId==='ct_iris'&&due.getFullYear()===2026&&due.getMonth()===8&&due.getDate()===18},{},plannerTileStart);
  await check('Project owner, target, and brief persist without adding tile chrome', (projectId) => {
    const project=window.crmPlanner.projects().find((item)=>item.id===projectId);const context=document.querySelector('.crm-planner-project-context');const tile=window.crmProjectsCamera.layers()[0]?.querySelector(`[data-planner-project="${CSS.escape(projectId)}"]`);
    const due=new Date(project?.dueAt||'');return project?.owner==='Iris Chen'&&due.getFullYear()===2026&&due.getMonth()===8&&due.getDate()===18&&/Iris Chen/.test(context?.textContent||'')&&/Sep 18/.test(context?.textContent||'')&&!tile?.querySelector('.crm-planner-project-context,.crm-project-meta');
  }, plannerTileStart);
  await page.waitForFunction(()=>{const button=document.querySelector('[data-planner-action="project-menu"]');const rect=button?.getBoundingClientRect();return !!button&&rect.width>0&&rect.height>0&&getComputedStyle(button).visibility!=='hidden'});
  await page.evaluate(()=>document.querySelector('[data-planner-action="project-menu"]')?.click());
  await page.evaluate(() => [...document.querySelectorAll('.crm-planner-context .crm-menu-action')].find((button)=>button.textContent.trim()==='Delete project')?.click());
  await page.waitForFunction(() => document.querySelector('.crm-planner-popover-title')?.textContent.trim() === 'Delete project?');
  await check('Deleting a project requires one compact confirmation and names the linked-card impact', () => /linked cards? will also be removed/i.test(document.querySelector('.crm-planner-popover-hint')?.textContent || '') && !!document.querySelector('[data-confirm-delete]') && !document.querySelector('.crm-planner-project-editor'));
  await page.click('.crm-planner-popover [data-cancel]');
  await page.click('[data-crm-history-back]');
  await page.waitForFunction(() => window.crmPlanner.level() === 0 && !window.crmDeskTransit.isBusy(), { timeout:10000 });
  await check('Global Back contracts a nested project to its prior Projects viewport', (projectId) => document.body.dataset.crmModule==='planner'&&window.crmPlanner.level()===0&&!!document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`)&&window.crmDeskTransit.historyState().canForward, plannerTileStart);
  await page.click('[data-crm-history-forward]');
  await page.waitForFunction((projectId) => window.crmPlanner.level() === 1 && window.crmPlanner.selected() === projectId && !window.crmDeskTransit.isBusy(), { timeout:10000 }, plannerTileStart);
  await check('Global Forward replays the existing project dive to the viewport Back left', (projectId) => document.body.dataset.crmModule==='planner'&&window.crmPlanner.level()===1&&window.crmPlanner.selected()===projectId&&!window.crmDeskTransit.historyState().canForward, plannerTileStart);
  const plannerTileBeforeBack = await page.$eval(`.crm-project-bucket[data-planner-project="${plannerTileStart}"]`, (tile) => { const rect=tile.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height]; });
  await page.click('[data-planner-action="projects-back"]');
  await page.waitForFunction(() => window.crmPlanner.level() === 0 && !document.querySelector('.crm-planner-bucket'));
  await check('Back from a project returns to the unchanged Projects gallery', ({ projectId, before }) => {
    const tile = document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`); const rect=tile?.getBoundingClientRect();
    return window.crmPlanner.view() === 'projects' && document.querySelectorAll('.crm-project-bucket[data-planner-project]').length >= 3
      && !!rect && [rect.x,rect.y,rect.width,rect.height].every((value,index) => Math.abs(value-before[index]) <= 1)
      && !document.querySelector('.crm-planner-contracting') && window.crmProjectsCamera.layers().filter(Boolean).length === 1;
  }, { projectId:plannerTileStart, before:plannerTileBeforeBack });
  await page.click('[data-planner-action="new-project"]');
  await page.waitForSelector('.crm-planner-project-creator input[name="title"]');
  await check('A new project offers restrained presets and an explicit custom structure', () => {
    const form = document.querySelector('.crm-planner-project-creator');
    return !!form && form.classList.contains('crm-menu-surface') && form.elements.title && form.elements.note && form.elements.ownerContactId && form.elements.dueAt
      && [...form.querySelectorAll('[data-planner-preset] .crm-planner-preset-name')].map((label) => label.textContent.trim()).join('|') === 'Simple|Review|Custom'
      && form.querySelector('[data-planner-preset="simple"]')?.getAttribute('aria-checked') === 'true'
      && form.querySelector('.crm-planner-custom-builder')?.hidden === true
      && form.querySelector('[type="submit"]')?.textContent.trim() === 'Create project' && form.getBoundingClientRect().width <= 380;
  });
  await page.type('.crm-planner-project-creator input[name="title"]', 'Interaction plan');
  await page.click('[data-planner-preset="custom"]');
  await check('Custom reveals a one-at-a-time stage builder', () => {
    const form = document.querySelector('.crm-planner-project-creator');
    return form?.querySelector('[data-planner-preset="custom"]')?.getAttribute('aria-checked') === 'true'
      && form.querySelector('.crm-planner-custom-builder')?.hidden === false
      && !!form.elements.stageName && !!form.querySelector('[data-add-stage]');
  });
  for (const stage of ['Backlog', 'In progress', 'Review', 'Done']) {
    await page.type('.crm-planner-project-creator input[name="stageName"]', stage);
    await page.click('.crm-planner-project-creator [data-add-stage]');
  }
  await page.type('.crm-planner-project-creator input[name="stageName"]', 'review');
  await page.click('.crm-planner-project-creator [data-add-stage]');
  await check('Custom stage names are unique before the project is created', () => {
    const form = document.querySelector('.crm-planner-project-creator');
    const names = [...(form?.querySelectorAll('.crm-planner-stage-pill > span') || [])].map((node) => node.textContent.trim());
    return names.join('|') === 'Backlog|In progress|Review|Done'
      && /unique/i.test(form?.querySelector('.crm-planner-creator-status')?.textContent || '');
  });
  await page.evaluate(() => document.querySelector('.crm-planner-popover')?.requestSubmit());
  await page.waitForFunction(() => window.crmPlanner.projects().some((project) => project.title === 'Interaction plan'));
  await page.waitForFunction(() => window.crmPlanner.level() === 1 && document.querySelectorAll('.crm-planner-bucket').length === 4);
  const plannerReviewStageId = await page.evaluate(() => window.crmPlanner.projects().find((item) => item.title === 'Interaction plan')?.buckets.find((bucket) => bucket.title === 'Review')?.id || '');
  await page.evaluate(() => { const project=window.crmPlanner.projects().find((item) => item.title === 'Interaction plan'); window.__interactionProjectTile=document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(project?.id || '')}"]`); window.__interactionProjectTileSignature=window.__interactionProjectTile?.dataset.previewSignature || ''; });
  await sleep(260);
  await page.evaluate((stageId) => document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] [data-planner-action="new-card"]`)?.click(), plannerReviewStageId);
  await page.type('.crm-planner-popover input[name="title"]', 'Ship the polished flow');
  await page.evaluate(() => document.querySelector('.crm-planner-popover')?.requestSubmit());
  await page.waitForFunction(() => [...document.querySelectorAll('.crm-planner-card-title')].some((node) => node.textContent.trim() === 'Ship the polished flow'), { timeout:10000 });
  await sleep(260);
  await page.evaluate(async () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    const review = project?.buckets.find((bucket) => bucket.title === 'Review');
    if (project && review) await window.crmPlanner.createCard(project.id, review.id, 'Review readiness');
  });
  await page.waitForFunction((stageId) => document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"]`)?.querySelectorAll('.crm-planner-card').length === 2, {}, plannerReviewStageId);
  const plannerRevealSource = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.crm-planner-card')].find((node) => node.querySelector('.crm-planner-card-title')?.textContent.trim() === 'Ship the polished flow');
    if (!card) return null; const rect = card.getBoundingClientRect(); const id = card.dataset.plannerCard; const progress = card.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length; card.click();
    const initial = document.querySelector('.ticket-detail-overlay[data-card-detail="plannerDetail"]:not([hidden]) .td-card')?.getBoundingClientRect();
    return { id, left:rect.left, right:rect.right, top:rect.top, width:rect.width, height:rect.height, progress,
      initial:initial && [initial.left, initial.top, initial.width, initial.height] };
  });
  await page.waitForSelector('.ticket-detail-overlay[data-card-detail="plannerDetail"]:not([hidden]) .ticket-detail', { timeout:10000 });
  await sleep(760);
  await check('Planner cards use the exact stack-aware ticket reveal and side configuration system', (source) => {
    const overlay = document.querySelector('.ticket-detail-overlay[data-card-detail="plannerDetail"]:not([hidden])');
    const card = document.querySelector(`.crm-planner-card[data-planner-card="${CSS.escape(source?.id || '')}"]`);
    const flyer = overlay?.querySelector('.td-card.td-flyer'); const panel = overlay?.querySelector('.ticket-detail.crm-menu-surface'); const wrap = overlay?.querySelector('.td-wrap');
    const flyerRect = flyer?.getBoundingClientRect(); const panelRect = panel?.getBoundingClientRect();
    const scrim = overlay?.querySelector('.td-scrim'); const scrimStyle = scrim ? getComputedStyle(scrim) : null; const frontStyle = overlay?.querySelector('.td-frontclone') ? getComputedStyle(overlay.querySelector('.td-frontclone')) : null;
    const depthOfField = scrim?.style.backdropFilter.includes('blur(4px)') || scrimStyle?.backdropFilter.includes('blur(4px)')
      || frontStyle?.filter.includes('blur(4px)') || (document.body.dataset.background === 'photo-water2' && scrimStyle?.backgroundColor !== 'rgba(0, 0, 0, 0)');
    return { ok:!!overlay && !!flyer && !!panel && !!wrap?.classList.contains('is-open') && !!wrap?.classList.contains('is-settled')
      && card?.style.visibility === 'hidden' && overlay.querySelectorAll('.td-frontclone').length === 1
      && source.initial && Math.abs(source.initial[0] - source.left) <= 1 && Math.abs(source.initial[1] - source.top) <= 1
      && Math.abs(source.initial[2] - source.width) <= 1 && Math.abs(source.initial[3] - source.height) <= 1
      && flyerRect.left >= source.right - 2 && Math.abs(flyerRect.height - 279) <= 1 && flyerRect.height > source.height * 2
      && panelRect.height > flyerRect.height && panelRect.width > source.width + 100
      && panel.scrollHeight <= panel.clientHeight + 1 && !['auto','scroll'].includes(getComputedStyle(panel).overflowY)
      && flyer.querySelectorAll('.crm-planner-card-progress .tk-seg').length === 4
      && flyer.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length === source.progress
      && depthOfField
      && !!panel.querySelector('[data-field="title"]') && !!panel.querySelector('[data-field="note"]')
      && !!panel.querySelector('[data-field="dueAt"]') && panel.querySelector('[data-field="assignedContactId"]')?.tagName === 'SELECT'
      && panel.querySelector('[data-field="linkedTarget"]')?.tagName === 'SELECT' && panel.querySelectorAll('.td-prio-opt').length === 3,
      detail:JSON.stringify({ source, flyer:flyerRect && [flyerRect.left,flyerRect.top,flyerRect.width,flyerRect.height], panel:panelRect && [panelRect.left,panelRect.top,panelRect.width,panelRect.height],
        open:wrap?.classList.contains('is-open'), settled:wrap?.classList.contains('is-settled'), hidden:card?.style.visibility, fronts:overlay?.querySelectorAll('.td-frontclone').length,
        segments:flyer?.querySelectorAll('.crm-planner-card-progress .tk-seg').length, green:flyer?.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length,
        depthOfField, fields:['title','note','dueAt','assignedContactId','linkedTarget'].map((key) => [key,panel?.querySelector(`[data-field="${key}"]`)?.tagName]), priorities:panel?.querySelectorAll('.td-prio-opt').length }) };
  }, plannerRevealSource);
  const plannerDetailEdit = await page.evaluate(() => {
    const panel = document.querySelector('.ticket-detail-overlay[data-card-detail="plannerDetail"]:not([hidden]) .ticket-detail');
    const note = panel?.querySelector('[data-field="note"]'); const due = panel?.querySelector('[data-field="dueAt"]');
    const owner = panel?.querySelector('[data-field="assignedContactId"]'); const linked = panel?.querySelector('[data-field="linkedTarget"]');
    if (note) { note.value = 'Ready for final stakeholder approval.'; note.dispatchEvent(new Event('input', { bubbles:true })); }
    if (due) { due.value = '2026-08-15'; due.dispatchEvent(new Event('input', { bubbles:true })); }
    if (owner && owner.options.length > 1) { owner.value = owner.options[1].value; owner.dispatchEvent(new Event('input', { bubbles:true })); }
    if (linked && linked.options.length > 1) { linked.value = linked.options[1].value; linked.dispatchEvent(new Event('input', { bubbles:true })); }
    [...(panel?.querySelectorAll('.td-prio-opt') || [])].find((button) => button.dataset.prio === 'high')?.click();
    return { owner:owner?.value || '', linked:linked?.value || '' };
  });
  await sleep(260);
  await page.click('.ticket-detail-overlay[data-card-detail="plannerDetail"] .td-x');
  await page.waitForFunction(() => document.querySelector('.ticket-detail-overlay[data-card-detail="plannerDetail"]')?.hidden === true);
  await sleep(320);
  const plannerDetailPersisted = await page.evaluate(async (probe) => {
    const item = (await window.crmStore.list('workItems', { includeDeleted:false })).records.find((record) => record.id === window.crmPlanner.items().find((record) => record.title === 'Ship the polished flow')?.id);
    const commitment = item && (await window.crmDomain.list('commitments', { includeDeleted:false, limit:1000 })).records.find((record) => record.id === item.commitmentId);
    const due = item?.dueAt ? new Date(item.dueAt) : null; const pad = (value) => String(value).padStart(2, '0');
    const dueLocal = due && !Number.isNaN(due.getTime()) ? `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}` : '';
    return { note:item?.note, dueAt:item?.dueAt, dueLocal, assignedContactId:item?.assignedContactId, priority:item?.priority,
      linked:`${item?.linkedEntityType || ''}:${item?.linkedRecordId || ''}`, commitmentAssignee:commitment?.assignee,
      commitmentPriority:commitment?.priority, support:commitment?.links?.some((link) => `${link.entityType}:${link.recordId}` === probe.linked) };
  }, plannerDetailEdit);
  await check('Planner side configuration persists owner, due date, priority, link, and card detail', (state) => ({
    ok:state.note === 'Ready for final stakeholder approval.' && state.dueLocal === '2026-08-15'
      && state.assignedContactId && state.priority === 'high' && state.linked && state.linked !== ':'
      && state.commitmentAssignee && state.commitmentPriority === 'high' && state.support === true,
    detail:JSON.stringify(state),
  }), plannerDetailPersisted);
  await check('Planner card reveal contracts into the unchanged source slot without a replacement jump', (source) => {
    const card = document.querySelector(`.crm-planner-card[data-planner-card="${CSS.escape(source?.id || '')}"]`); const rect = card?.getBoundingClientRect();
    return !!card && card.style.visibility === '' && Math.abs(rect.left - source.left) <= 1 && Math.abs(rect.top - source.top) <= 1
      && Math.abs(rect.width - source.width) <= 1 && Math.abs(rect.height - source.height) <= 1;
  }, plannerRevealSource);
  await check('Projects creates custom stages and real linked cards with automatic progress', () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    const review = project?.buckets.find((bucket) => bucket.title === 'Review');
    const item = review?.cards.find((card) => card.title === 'Ship the polished flow');
    const card = item && document.querySelector(`.crm-planner-card[data-planner-card="${CSS.escape(item.id)}"]`);
    const projectTile = project && document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(project.id)}"]`);
    const commitment = item && window.crmHome?.handStatus?.();
    return { ok:!!project && project.buckets.length === 4 && !!item && item.entityType === 'workItems'
      && !!item.commitmentId && !!item.workflowEntryId && !!commitment
      && projectTile === window.__interactionProjectTile && projectTile.dataset.previewSignature !== window.__interactionProjectTileSignature
      && !!projectTile.querySelector(':scope > .crm-home-preview') && !projectTile.querySelector('.crm-project-preview-card')
      && card?.getAttribute('data-record-entity') === 'workItems'
      && card.querySelectorAll('.crm-planner-card-progress .tk-seg').length === project.buckets.length
      && card.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length === review.rank + 1,
      detail:JSON.stringify({ project:!!project, stages:project?.buckets.length, item:item && { entityType:item.entityType, commitmentId:item.commitmentId, workflowEntryId:item.workflowEntryId }, progress:card?.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length }) };
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
    const completedCard = document.querySelector(`.crm-planner-card[data-planner-card="${CSS.escape(item.id)}"]`);
    const completed = { itemStage:movedItem.stageId, itemStatus:movedItem.status, commitmentStatus:commitment?.status, flowStage:flow?.stage,
      progress:completedCard?.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length, expectedProgress:project.buckets.findIndex((bucket) => bucket.id === done.id) + 1 };
    await window.crmPlanner.moveCard(item.id, review.id);
    const restoredCard = document.querySelector(`.crm-planner-card[data-planner-card="${CSS.escape(item.id)}"]`);
    return { ...completed, restored:window.crmPlanner.items().find((record) => record.id === item.id)?.stageId,
      restoredProgress:restoredCard?.querySelectorAll('.crm-planner-card-progress .tk-seg.g').length, expectedRestored:project.buckets.findIndex((bucket) => bucket.id === review.id) + 1 };
  });
  await check('Planner moves one real card through its custom workflow and updates progress automatically', (state) => ({
    ok:!!state && state.itemStatus === 'completed' && state.commitmentStatus === 'completed'
      && state.itemStage === state.flowStage && state.restored && state.restored !== state.itemStage
      && state.progress === state.expectedProgress && state.restoredProgress === state.expectedRestored,
    detail:JSON.stringify(state),
  }), plannerStageMove);
  const plannerGutterBefore = await page.evaluate(async () => {
    const project = window.crmPlanner.projects().find((item) => item.title === 'Interaction plan');
    await window.crmPlanner.createStage(project.id, 'Release'); await window.crmPlanner.createStage(project.id, 'Handoff'); await window.crmPlanner.createStage(project.id, 'Archive');
    const scroller = document.querySelector('.crm-planner-buckets'); scroller.scrollLeft = 0;
    return { left:scroller.scrollLeft, max:scroller.scrollWidth-scroller.clientWidth, stages:window.crmPlanner.projects().find((item) => item.id === project.id).buckets.length };
  });
  const plannerGutterPoint = await page.evaluate(() => { const rect=document.querySelector('.crm-planner-buckets').getBoundingClientRect(); return { x:Math.round(rect.left+rect.width*.25),y:Math.min(innerHeight-8,Math.ceil(rect.bottom+12)),scrollBottom:rect.bottom }; });
  await page.mouse.move(plannerGutterPoint.x,plannerGutterPoint.y); await page.mouse.wheel({ deltaY:420 }); await sleep(180);
  await check('Planner stages scroll from the blank area below their horizontal scrollbar', ({ before, point }) => {
    const scroller=document.querySelector('.crm-planner-buckets'); const stage=scroller?.closest('.crm-planner-stage'); const left=Number.parseFloat(stage?.style.getPropertyValue('--crm-scroll-shadow-left')||'0');
    const shade=getComputedStyle(stage,'::before');
    return { ok:before.stages===7&&before.max>100&&point.y>point.scrollBottom&&scroller.scrollLeft>before.left+100&&left>.5
      &&shade.position==='fixed'&&shade.top==='0px'&&shade.bottom==='0px',
      detail:JSON.stringify({before,point,left:scroller?.scrollLeft,shadow:left,geometry:[shade.position,shade.top,shade.bottom]}) };
  }, { before:plannerGutterBefore, point:plannerGutterPoint });
  const plannerStackBefore = await page.evaluate((stageId) => { const bucket = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"]`); return {
    project:window.crmPlanner.selected(), stage:bucket?.dataset.plannerBucket,
    ids:[...(bucket?.querySelectorAll('.crm-planner-card') || [])].map((card) => card.dataset.plannerCard),
  }; }, plannerReviewStageId);
  await check('Planner stage headers retain the exact work objects without an unstack control', (before) => {
    const bucket = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(before.stage)}"]`);
    const ids = [...(bucket?.querySelectorAll('.crm-planner-card') || [])].map((card) => card.dataset.plannerCard);
    return !!bucket && !document.querySelector('.crm-planner-stack-toggle,.tk-zone-spread') && JSON.stringify(ids) === JSON.stringify(before.ids);
  }, plannerStackBefore);
  await page.evaluate((stageId) => {
    const header = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .tk-zone-hd`);
    const rect = header?.getBoundingClientRect();
    if (header && rect) header.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.left + 12, clientY:rect.top + 12 }));
  }, plannerReviewStageId);
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
  const plannerBucketSizeAction = await page.evaluate(() => {
    const action = [...document.querySelectorAll('.crm-planner-context .crm-menu-action')].find((button) => button.textContent.trim() === 'Make small');
    action?.click(); return action?.textContent.trim() || '';
  });
  if (plannerBucketSizeAction !== 'Make small') throw new Error(`Planner bucket size action unavailable: ${plannerBucketSizeAction}`);
  await page.waitForFunction((stageId) => {
    const bucket = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"]`);
    return bucket?.classList.contains('crm-object-small') && bucket.getBoundingClientRect().width <= 205
      && Number.parseFloat(getComputedStyle(bucket).scale) === 1;
  }, {}, plannerReviewStageId);
  await page.evaluate((stageId) => {
    const card = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .crm-planner-card`);
    const rect = card?.getBoundingClientRect();
    if (card && rect) card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:rect.left + 12, clientY:rect.top + 12 }));
  }, plannerReviewStageId);
  await page.waitForSelector('.crm-planner-context');
  const plannerCardSizeAction = await page.evaluate(() => {
    const action = [...document.querySelectorAll('.crm-planner-context .crm-menu-action')].find((button) => button.textContent.trim() === 'Make small');
    action?.click(); return action?.textContent.trim() || '';
  });
  if (plannerCardSizeAction !== 'Make small') throw new Error(`Planner card size action unavailable: ${plannerCardSizeAction}`);
  await page.waitForFunction((stageId) => {
    const card = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .crm-planner-card`);
    return card?.classList.contains('crm-object-small') && card.getBoundingClientRect().width <= 145
      && Number.parseFloat(getComputedStyle(card).scale) === 1;
  }, {}, plannerReviewStageId);
  await page.waitForFunction((stageId) => {
    const card = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .crm-planner-card`);
    const body = card?.querySelector('[data-card-fit-body]');
    return !!body && !!card.dataset.cardContentFit && card.dataset.cardContentFit !== 'clipped'
      && body.scrollHeight <= body.clientHeight + 1;
  }, { timeout:2000 }, plannerReviewStageId);
  await check('A Small Planner card keeps every configured entry in the shared adaptive fit', (stageId) => {
    const card = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .crm-planner-card`);
    const body = card?.querySelector('[data-card-fit-body]');
    const entries = [...(body?.querySelectorAll('[data-card-fit-entry]') || [])]
      .filter((entry) => entry.textContent.trim());
    return {
      ok:!!card && entries.length >= 2 && card.dataset.cardContentFit !== 'clipped'
        && entries.every((entry) => getComputedStyle(entry).display !== 'none' && entry.getClientRects().length > 0)
        && body.scrollHeight <= body.clientHeight + 1,
      detail:JSON.stringify({
        fit:card?.dataset.cardContentFit || '',
        entries:entries.map((entry) => ({
          text:entry.textContent.trim(),
          display:getComputedStyle(entry).display,
          clamp:getComputedStyle(entry).webkitLineClamp,
        })),
        overflow:body ? body.scrollHeight - body.clientHeight : null,
      }),
    };
  }, plannerReviewStageId);
  await page.evaluate(() => {
    const current = window.crmPlanner.selected();
    const other = window.crmPlanner.projects().find((project) => project.id !== current)?.id;
    if (other) window.crmPlanner.selectProject(other);
    window.crmPlanner.selectProject(current);
  });
  await page.waitForFunction((stageId) => document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"]`)?.classList.contains('crm-object-small')
    && document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"] .crm-planner-card`)?.classList.contains('crm-object-small'), {}, plannerReviewStageId);
  await check('Planner bucket and item sizes persist when the project world is rebuilt', (stageId) => {
    const bucket = document.querySelector(`.crm-planner-bucket[data-planner-bucket="${CSS.escape(stageId)}"]`); const card = bucket?.querySelector('.crm-planner-card');
    const stored = JSON.parse(localStorage.getItem('crm-object-sizing-v1') || '{}');
    return !!bucket && !!card && stored.buckets?.[window.crmObjectSizing.keyOf(bucket, 'bucket')] === 'small'
      && stored.cards?.[window.crmObjectSizing.keyOf(card, 'card')] === 'small'
      && bucket.getBoundingClientRect().width <= 205 && card.getBoundingClientRect().width <= 145;
  }, plannerReviewStageId);
  await activate('home');
  await page.waitForFunction(() => window.crmHome?.handStatus?.().count > 0
    && document.querySelectorAll('.crm-home-hand-card.tk-card').length === window.crmHome?.handStatus?.().count, { timeout: 10000 });
  await check('The Home priority hand remains available beside the six worlds', () => window.crmHome.handStatus().count > 0);
  await page.hover('.crm-home-hand-trigger');
  await sleep(420);
  await page.click(`.crm-home-hand-card[data-commitment-id="${linkedHomeTodo.ticketCommitmentId}"]`);
  await sleep(80);
  await check('A Home ticket waits for the Tickets camera handoff before opening detail', () => document.body.dataset.crmModule === 'home'
    && window.crmDeskTransit?.isBusy?.() && window.crmHomeCamera?.isTransitioning?.()
    && !document.querySelector('.ticket-detail-overlay:not([hidden]), .record-world-shell:not([hidden])'));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'cases' && !window.crmDeskTransit?.isBusy?.()
    && !!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail'), { timeout: 10000 });
  await check('A Home ticket reveals from its native Tickets card with one detail system', (todo) => {
    const selector = `[data-id="${CSS.escape(todo.ticketId)}"]`;
    const native = document.querySelector(`[data-crm-theater="tickets"]:not([hidden]) .tk-zcard${selector}, [data-crm-theater="tickets"]:not([hidden]) .tk-deck .tk-card${selector}`);
    const expanders = [...document.querySelectorAll('.crm-home-expander:not(.crm-home-warm)')];
    const parkedExpanders = expanders.every((expander) => {
      const style = getComputedStyle(expander);
      return expander.classList.contains('crm-home-recycled-expander')
        && Number(style.opacity) <= .001 && style.pointerEvents === 'none';
    });
    return {
      ok:!!native && native.style.visibility === 'hidden'
      && document.querySelectorAll('.ticket-detail-overlay:not([hidden])').length === 1
      && !document.querySelector('.record-world-shell:not([hidden]), .tk-external-source, .crm-transit-veil')
      && parkedExpanders,
      detail:JSON.stringify({
        native:!!native,
        nativeVisibility:native?.style.visibility || '',
        overlays:document.querySelectorAll('.ticket-detail-overlay:not([hidden])').length,
        expanders:expanders.map((expander) => [
          expander.className,
          getComputedStyle(expander).opacity,
          getComputedStyle(expander).pointerEvents,
        ]),
      }),
    };
  }, linkedHomeTodo);
  await page.keyboard.press('Escape');
  await check('No renderer exceptions during the complete scenario', () => true);

  if (errors.length) { console.log(`FAIL renderer exceptions — ${errors.join(' | ')}`); failures++; }
  console.log(`\nInteraction contract: ${failures ? `${failures} failure(s)` : 'PASSED'}.`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
