'use strict';

// Focused regression coverage for the secondary-control, contextual-add,
// adaptive-tile, and semantic-card refinements. This intentionally runs
// against the real pg-mem visual harness so create/remove operations are
// isolated from a user's CRM data.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./harness.js');

const OUT_DIR = path.join(__dirname, 'shots', 'ui-refinement-smoke');
const VIEWPORT = { width: 1600, height: 1000 };
const API_PORT = Number(process.env.CRM_REFINEMENT_API_PORT || 3919);
const STATIC_PORT = Number(process.env.CRM_REFINEMENT_STATIC_PORT || 3918);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browserExecutable = () => [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const dimensionsAreEqual = (tiles, tolerance = 1.25) => {
  if (!tiles.length) return false;
  const widths = tiles.map(({ width }) => width);
  const heights = tiles.map(({ height }) => height);
  return Math.max(...widths) - Math.min(...widths) <= tolerance
    && Math.max(...heights) - Math.min(...heights) <= tolerance;
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const harness = await start({
    apiPort: API_PORT,
    staticPort: STATIC_PORT,
  });
  const executablePath = browserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    localStorage.removeItem('crm-active-module-v3');
    localStorage.removeItem('crm-home-tiles-v1');
    localStorage.removeItem('crm-planner-selected-v2');
    localStorage.setItem('dashboard-background', 'photo-water');
  });

  const results = [];
  const check = async (name, operation) => {
    try {
      const detail = await operation();
      const suffix = detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
      console.log(` ok  ${name}${suffix}`);
      results.push({ name, ok: true, detail: detail || null });
      return detail;
    } catch (error) {
      console.error(`FAIL ${name} — ${error.message}`);
      results.push({ name, ok: false, detail: error.message });
      return null;
    }
  };
  const screenshot = async (name) => {
    const file = path.join(OUT_DIR, name);
    await page.screenshot({ path: file, animations: 'disabled' });
    console.log(`[shot] ${path.relative(process.cwd(), file)}`);
    return file;
  };
  const closeAddMenu = async () => {
    if (await page.locator('.window-add-control').getAttribute('aria-expanded') === 'true') {
      await page.keyboard.press('Escape');
      await page.locator('#context-add-menu').waitFor({ state: 'hidden' });
    }
  };
  const activate = async (key) => {
    await closeAddMenu();
    await page.evaluate(async (moduleKey) => {
      if (window.crmWorkspaces.active() === moduleKey) return;
      if (typeof window.crmDeskTransit?.driveTo === 'function') {
        await window.crmDeskTransit.driveTo(moduleKey, { history: false });
      } else {
        window.crmWorkspaces.setActive(moduleKey);
      }
    }, key);
    await page.waitForFunction(
      (moduleKey) => document.body.dataset.crmModule === moduleKey
        && window.crmWorkspaces.active() === moduleKey,
      key,
      { timeout: 20000 },
    );
    await sleep(150);
  };
  const openAddMenu = async () => {
    await closeAddMenu();
    await page.locator('.window-add-control').click();
    await page.locator('#context-add-menu').waitFor({ state: 'visible' });
    await page.waitForFunction(() => (
      document.querySelectorAll('#context-add-menu [data-context-add-action]').length > 0
      || !!document.querySelector('#context-add-menu .context-add-empty')
    ));
    return page.evaluate(() => ({
      heading: document.querySelector('#context-add-menu .context-add-menu-heading')?.textContent.trim() || '',
      actions: [...document.querySelectorAll('#context-add-menu [data-context-add-action]')].map((button) => ({
        id: button.dataset.contextAddAction,
        label: button.querySelector('.context-add-action-label')?.textContent.trim() || button.textContent.trim(),
        description: button.querySelector('.context-add-action-description')?.textContent.trim() || '',
        disabled: button.disabled,
      })),
    }));
  };
  const tileGeometry = async (gridSelector) => page.evaluate((selector) => {
    const activePlannerGrid = selector === '.crm-project-tile-grid'
      ? window.crmProjectsCamera?.layers?.()[0]?.querySelector?.(selector)
      : null;
    const grid = activePlannerGrid || [...document.querySelectorAll(selector)]
      .sort((left, right) => {
        const childDifference = right.querySelectorAll(':scope > [data-crm-tile]').length
          - left.querySelectorAll(':scope > [data-crm-tile]').length;
        if (childDifference) return childDifference;
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      })[0];
    if (!grid) return null;
    const tiles = [...grid.querySelectorAll(':scope > [data-crm-tile]')].map((tile) => {
      const rect = tile.getBoundingClientRect();
      return {
        id: tile.dataset.crmTile || '',
        kind: tile.dataset.tileKind || '',
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      };
    });
    const style = getComputedStyle(grid);
    const gridRect = grid.getBoundingClientRect();
    const scrollerRect = grid.closest('.crm-project-gallery-scroll')?.getBoundingClientRect();
    return {
      tiles,
      count: Number(grid.dataset.crmTileCount || 0),
      columns: Number(grid.dataset.crmTileColumns || 0),
      rows: Number(grid.dataset.crmTileRows || 0),
      adaptiveWidth: style.getPropertyValue('--crm-adaptive-tile-width').trim(),
      adaptiveHeight: style.getPropertyValue('--crm-adaptive-tile-height').trim(),
      bounds: {
        grid: [gridRect.width, gridRect.height],
        scroller: scrollerRect ? [scrollerRect.width, scrollerRect.height] : null,
      },
    };
  }, gridSelector);
  const secondaryControlAudit = async () => page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (element.hidden || rect.width <= 0 || rect.height <= 0
        || rect.right <= 0 || rect.bottom <= 0
        || rect.left >= innerWidth || rect.top >= innerHeight
        || style.display === 'none' || style.visibility === 'hidden'
        || Number(style.opacity) <= .04) return false;
      const hit = document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      );
      return hit === element || element.contains(hit);
    };
    return [...document.querySelectorAll('.crm-secondary-control')].filter(visible).map((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const pseudo = getComputedStyle(button, '::before');
      const pseudoMask = pseudo.maskImage || pseudo.webkitMaskImage || '';
      return {
        label: button.getAttribute('aria-label') || button.title || button.className,
        classes: button.className,
        width: rect.width,
        height: rect.height,
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        icon: pseudoMask && pseudoMask !== 'none' ? {
          width: parseFloat(pseudo.width) || 0,
          height: parseFloat(pseudo.height) || 0,
          mask: pseudoMask,
          transform: pseudo.transform,
          centered: style.display.includes('flex')
            && style.alignItems === 'center'
            && style.justifyContent === 'center'
            && (parseFloat(pseudo.marginLeft) || 0) === 0
            && (parseFloat(pseudo.marginTop) || 0) === 0,
        } : null,
      };
    });
  });
  const bucketAcrylicAudit = async () => page.evaluate(() => {
    const bucket = [...document.querySelectorAll('.tk-zone')].find((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && Number(style.opacity) > .04;
    });
    if (!bucket) return null;
    const style = getComputedStyle(bucket);
    return {
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    };
  });
  const assertSecondaryControlContract = (controls, bucketAcrylic, minimum = 1) => {
    invariant(controls.length >= minimum, `expected at least ${minimum} visible secondary controls, got ${controls.length}`);
    invariant(bucketAcrylic, 'Could not resolve the canonical bucket acrylic');
    controls.forEach((control) => {
      invariant(Math.abs(control.width - 46) <= .6 && Math.abs(control.height - 46) <= .6, `${control.label} is ${control.width.toFixed(2)}×${control.height.toFixed(2)}`);
      invariant(control.radius >= 22.5, `${control.label} is not circular`);
      invariant(control.icon, `${control.label} has no measurable symbol`);
      invariant(Math.abs(control.icon.width - 18) <= .1 && Math.abs(control.icon.height - 18) <= .1, `${control.label} symbol is ${control.icon.width.toFixed(2)}×${control.icon.height.toFixed(2)}`);
      invariant(control.icon.centered, `${control.label} symbol is not centered by the shared flex contract`);
      invariant(control.background === bucketAcrylic.background, `${control.label} background color differs from its bucket`);
      invariant(
        control.backgroundImage === bucketAcrylic.backgroundImage,
        `${control.label} acrylic tint differs from its bucket (${control.backgroundImage} !== ${bucketAcrylic.backgroundImage})`,
      );
      invariant(control.backdrop === bucketAcrylic.backdrop, `${control.label} acrylic filter differs from its bucket`);
      invariant(control.borderColor === bucketAcrylic.borderColor, `${control.label} acrylic border differs from its bucket`);
      invariant(control.boxShadow === bucketAcrylic.boxShadow, `${control.label} acrylic shadow differs from its bucket`);
    });
    return {
      controls: controls.length,
      labels: controls.map(({ label }) => label),
      iconSize: '18px',
    };
  };
  const semanticCardAudit = async (selector) => page.evaluate((cardSelector) => {
    const scope = cardSelector === '@planner-live'
      ? window.crmProjectsCamera?.layers?.()[1]
      : document;
    const resolvedSelector = cardSelector === '@planner-live' ? '.crm-planner-card' : cardSelector;
    const cards = [...(scope?.querySelectorAll(resolvedSelector) || [])].filter((card) => {
      const rect = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return cards.map((card) => {
      const body = card.querySelector('[data-card-fit-body], .ticket-body');
      const entries = [...(body?.querySelectorAll('[data-card-fit-entry], .ticket-company, .ticket-host, .ticket-field') || [])];
      const mark = card.querySelector('.crm-card-semantic-mark');
      const markStyle = mark ? getComputedStyle(mark) : null;
      const markRect = mark?.getBoundingClientRect();
      const title = card.querySelector('[data-card-fit-entry], .ticket-company');
      const titleStyle = title ? getComputedStyle(title) : null;
      return {
        id: card.dataset.plannerCard || card.dataset.id || '',
        kind: card.dataset.cardKind || '',
        fit: card.dataset.cardContentFit || '',
        bodyPresent: !!body,
        bodyAttribute: !!body?.hasAttribute('data-card-fit-body'),
        entries: entries.length,
        entryDetails: entries.map((entry) => {
          const style = getComputedStyle(entry);
          const rect = entry.getBoundingClientRect();
          return {
            text: entry.textContent.trim(),
            clamp: style.webkitLineClamp,
            marked: entry.dataset.cardEntryClamped === 'true',
            height: rect.height,
            lineHeight: parseFloat(style.lineHeight) || 0,
            scrollHeight: entry.scrollHeight,
          };
        }),
        clamped: entries.filter((entry) => entry.dataset.cardEntryClamped === 'true').length,
        overflow: body ? Math.max(0, body.scrollHeight - body.clientHeight) : null,
        mark: mark ? {
          type: mark.dataset.cardSemantic || '',
          width: markRect?.width || 0,
          opacity: Number(markStyle.opacity),
          color: markStyle.color,
          filter: markStyle.filter,
          blend: markStyle.mixBlendMode,
          svg: !!mark.querySelector('svg'),
        } : null,
        title: title ? {
          text: title.textContent.trim(),
          whiteSpace: titleStyle.whiteSpace,
          lineClamp: titleStyle.webkitLineClamp,
          height: title.getBoundingClientRect().height,
          lineHeight: parseFloat(titleStyle.lineHeight) || 0,
          width: title.getBoundingClientRect().width,
          clientWidth: title.clientWidth,
          scrollWidth: title.scrollWidth,
          clientHeight: title.clientHeight,
          scrollHeight: title.scrollHeight,
          textOverflow: titleStyle.textOverflow,
        } : null,
      };
    });
  }, selector);

  try {
    await page.goto(harness.staticUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => (
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && !!window.crmWorkspaces
      && !!window.crmContextAddRegistry
      && !!window.crmHome
      && !!window.crmPlanner
      && !!window.crmAssignments
    ), null, { timeout: 30000 });
    await sleep(1600);

    await activate('home');
    await page.waitForFunction(() => document.querySelectorAll('.crm-home-surface .crm-home-grid > [data-crm-tile]').length === 4);
    const homeMenu = await openAddMenu();
    await check('Home + contains viewport tiles only', () => {
      invariant(homeMenu.heading === 'Add to Home', `unexpected heading "${homeMenu.heading}"`);
      invariant(homeMenu.actions.length === 4, `expected four tile choices, got ${homeMenu.actions.length}`);
      invariant(homeMenu.actions.every((action) => action.id.startsWith('home-tile-') && / tile$/i.test(action.label)), 'Home exposed a non-tile action');
      invariant(!homeMenu.actions.some((action) => /^Ticket$|^Card$/i.test(action.label)), 'Home exposed an independent ticket/card action');
      return homeMenu.actions.map(({ id }) => id);
    });
    await screenshot('01-home-add-menu.png');
    await closeAddMenu();
    const homeHandCards = await semanticCardAudit('.crm-home-priority-hand .crm-home-hand-card');
    await check('Home hand cards retain adaptive titles and transferable semantic marks', () => {
      invariant(homeHandCards.length >= 2, `expected Home hand cards, got ${homeHandCards.length}`);
      invariant(homeHandCards.every((card) => card.fit && card.fit !== 'clipped' && card.overflow <= 1), 'A Home hand card still clips its content');
      invariant(homeHandCards.every((card) => card.mark?.svg && card.mark.width >= 70), 'A Home hand card is missing the shared embossed mark');
      invariant(
        homeHandCards.some((card) => card.title?.lineHeight > 0 && card.title.height >= card.title.lineHeight * 1.75),
        'Home hand titles are still forced into a single line',
      );
      return { cards: homeHandCards.length, semanticTypes: [...new Set(homeHandCards.map((card) => card.mark.type))] };
    });

    const homeGridSelector = '.crm-home-surface:not([hidden]) .crm-home-grid';
    const initialHomeGeometry = await tileGeometry(homeGridSelector);
    await check('Home tiles share equal adaptive cells and canonical tile records', async () => {
      invariant(initialHomeGeometry?.tiles.length === 4, 'Home grid did not expose four tiles');
      invariant(dimensionsAreEqual(initialHomeGeometry.tiles), 'Home tile dimensions are not equal');
      invariant(initialHomeGeometry.count === 4 && initialHomeGeometry.columns > 0 && initialHomeGeometry.rows > 0, 'Home adaptive grid metadata is incomplete');
      invariant(initialHomeGeometry.tiles.every((tile) => tile.id && tile.kind === 'home-viewport'), 'Home tiles are missing canonical tile identity/kind');
      const schemas = await page.evaluate(() => window.crmHome.tiles().map(({ tile }) => tile));
      invariant(schemas.every((tile) => tile.schemaVersion === 1 && tile.target?.type === 'workspace' && tile.id && tile.key), 'Home tile schema is not normalized');
      return { columns: initialHomeGeometry.columns, rows: initialHomeGeometry.rows, cell: [initialHomeGeometry.adaptiveWidth, initialHomeGeometry.adaptiveHeight] };
    });

    const temporaryHomeTile = await page.evaluate(() => window.crmHome.createTile('people', {
      id: 'ui-refinement-smoke-home-tile',
      label: 'People alternate view',
    }));
    invariant(temporaryHomeTile?.tile?.id, 'Could not create the temporary Home tile');
    await page.waitForFunction(() => document.querySelectorAll('.crm-home-surface .crm-home-grid > [data-crm-tile]').length === 5);
    await sleep(100);
    const expandedHomeGeometry = await tileGeometry(homeGridSelector);
    await check('Home tile add reflows every tile evenly', () => {
      invariant(expandedHomeGeometry?.tiles.length === 5, 'Home tile count did not grow to five');
      invariant(expandedHomeGeometry.count === 5, 'Home adaptive metadata did not update after add');
      invariant(dimensionsAreEqual(expandedHomeGeometry.tiles), 'Home tiles are uneven after add');
      invariant(
        expandedHomeGeometry.adaptiveWidth !== initialHomeGeometry.adaptiveWidth
          || expandedHomeGeometry.adaptiveHeight !== initialHomeGeometry.adaptiveHeight
          || expandedHomeGeometry.columns !== initialHomeGeometry.columns
          || expandedHomeGeometry.rows !== initialHomeGeometry.rows,
        'Home grid geometry did not adapt to the new count',
      );
      return { columns: expandedHomeGeometry.columns, rows: expandedHomeGeometry.rows };
    });
    await page.evaluate((id) => window.crmHome.removeTile(id), temporaryHomeTile.tile.id);
    await page.waitForFunction(() => document.querySelectorAll('.crm-home-surface .crm-home-grid > [data-crm-tile]').length === 4);
    await sleep(100);
    const restoredHomeGeometry = await tileGeometry(homeGridSelector);
    await check('Home tile removal restores an even grid', () => {
      invariant(restoredHomeGeometry?.count === 4 && dimensionsAreEqual(restoredHomeGeometry.tiles), 'Home grid is uneven after removal');
      return { columns: restoredHomeGeometry.columns, rows: restoredHomeGeometry.rows };
    });

    await activate('people');
    const peopleMenu = await openAddMenu();
    await check('People + exposes only Person', () => {
      invariant(peopleMenu.heading === 'Add to People', `unexpected heading "${peopleMenu.heading}"`);
      invariant(peopleMenu.actions.length === 1 && peopleMenu.actions[0].id === 'person' && peopleMenu.actions[0].label === 'Person', 'People add choices are not scoped to Person');
      return peopleMenu.actions[0];
    });
    await screenshot('02-people-add-menu.png');
    const contactsBeforeCreate = await page.evaluate(async () => (
      (await window.crmStore.list('contacts', { includeDeleted: false })).records || []
    ).map(({ id }) => id));
    await page.locator('#context-add-menu [data-context-add-action="person"]').click();
    const contactCreatorOpened = await page.locator('.ticket-detail-overlay:not([hidden]), .record-world-shell:not([hidden])')
      .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    const contactCreateDiagnostics = await page.evaluate(async (knownIds) => {
      const records = (await window.crmStore.list('contacts', { includeDeleted: false })).records || [];
      const created = records.filter((record) => !knownIds.includes(record.id));
      return {
        created: created.map(({ id, companyId, companyLabel, state }) => ({ id, companyId, companyLabel, state })),
        cards: created.map((record) => {
          const card = document.querySelector(`.tk-zcard[data-id="${CSS.escape(record.id)}"], .tk-card[data-id="${CSS.escape(record.id)}"]`);
          const rect = card?.getBoundingClientRect();
          return { id: record.id, found: !!card, rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null };
        }),
        overlays: [...document.querySelectorAll('.ticket-detail-overlay')].map((overlay) => ({
          api: overlay.dataset.cardDetail || '',
          hidden: overlay.hidden,
          classes: overlay.className,
        })),
        recordWorld: {
          mounted: !!document.querySelector('.record-world-shell'),
          hidden: document.querySelector('.record-world-shell')?.hidden ?? true,
        },
        detailOpen: !!window.contactDetail?.isOpen?.(),
        performance: window.peopleCards?.performanceState?.() || null,
      };
    }, contactsBeforeCreate);
    await check('People Person action opens the existing contact creator', async () => {
      const creator = await page.evaluate(() => {
        const overlay = document.querySelector('.ticket-detail-overlay:not([hidden]), .record-world-shell:not([hidden])');
        return {
          api: overlay?.dataset.cardDetail || (overlay?.classList.contains('record-world-shell') ? 'recordWorld' : ''),
          title: overlay?.querySelector('.td-title, [data-detail-title], .record-world-title')?.textContent.trim() || '',
          inputs: overlay?.querySelectorAll('input, textarea, select').length || 0,
        };
      });
      invariant(contactCreatorOpened, `Person action did not open the existing contact detail creator: ${JSON.stringify(contactCreateDiagnostics)}`);
      invariant(['contactDetail', 'recordWorld'].includes(creator.api), `Person action opened "${creator.api || 'nothing'}"`);
      invariant(creator.inputs > 0, 'Contact creator did not expose its existing detail fields');
      return creator;
    });
    if (contactCreatorOpened) {
      await page.keyboard.press('Escape');
      await page.locator('.ticket-detail-overlay:not([hidden]), .record-world-shell:not([hidden])').waitFor({ state: 'hidden', timeout: 12000 });
    }
    await page.evaluate(async (knownIds) => {
      const records = (await window.crmStore.list('contacts', { includeDeleted: false })).records || [];
      for (const record of records) {
        if (!knownIds.includes(record.id)) await window.crmStore.remove('contacts', record.id, { hard: true });
      }
    }, contactsBeforeCreate);
    const peopleControls = await secondaryControlAudit();
    const bucketAcrylic = await bucketAcrylicAudit();
    await check('Visible secondary controls are 46px circular acrylic with centered symbols', () => {
      const summary = assertSecondaryControlContract(peopleControls, bucketAcrylic, 2);
      return { ...summary, bucketMaterial: bucketAcrylic };
    });

    await activate('planner');
    await page.waitForFunction(() => window.crmPlanner.view() === 'projects' && [...document.querySelectorAll('.crm-project-tile-grid')]
      .some((grid) => grid.querySelectorAll(':scope > [data-crm-tile]').length >= 4));
    const plannerRootMenu = await openAddMenu();
    await check('Planner root + exposes only Project', () => {
      invariant(plannerRootMenu.heading === 'Add to Projects', `unexpected heading "${plannerRootMenu.heading}"`);
      invariant(plannerRootMenu.actions.length === 1 && plannerRootMenu.actions[0].id === 'planner-project', 'Planner root exposed something other than Project');
      return plannerRootMenu.actions[0];
    });
    await screenshot('03-planner-root-add-menu.png');
    await closeAddMenu();
    await sleep(500);
    const plannerViewportAfterMenu = await page.evaluate(() => ({
      module: document.body.dataset.crmModule || '',
      active: window.crmWorkspaces.active(),
    }));
    await check('Closing the contextual + menu stays in the current viewport', () => {
      invariant(
        plannerViewportAfterMenu.module === 'planner' && plannerViewportAfterMenu.active === 'planner',
        `Escape navigated to ${plannerViewportAfterMenu.module || 'an unknown viewport'}`,
      );
      return 'planner';
    });

    const plannerGridSelector = '.crm-project-tile-grid';
    const initialPlannerGeometry = await tileGeometry(plannerGridSelector);
    const initialProjectCount = await page.evaluate(() => window.crmPlanner.projects().length);
    await check('Project gallery uses equal adaptive canonical tiles', async () => {
      invariant(
        initialPlannerGeometry?.tiles.length === initialProjectCount + 1,
        `Project grid should include ${initialProjectCount} projects plus the create tile; found ${initialPlannerGeometry?.tiles.length || 0}`,
      );
      invariant(dimensionsAreEqual(initialPlannerGeometry.tiles), 'Project gallery tile dimensions are not equal');
      invariant(initialPlannerGeometry.count === initialPlannerGeometry.tiles.length, 'Project adaptive metadata does not match its children');
      const schemas = await page.evaluate(() => ({
        home: window.crmHome.tiles().map(({ tile }) => Object.keys(tile).sort()),
        projects: window.crmPlanner.projects().map(({ tile }) => Object.keys(tile).sort()),
        projectTiles: window.crmPlanner.projects().map(({ tile }) => tile),
      }));
      invariant(schemas.projectTiles.every((tile) => tile.schemaVersion === 1 && tile.kind === 'project' && tile.target?.type === 'project'), 'Project records do not use the canonical tile schema');
      invariant(schemas.home[0].join('|') === schemas.projects[0].join('|'), 'Home and Project tiles have different schema shapes');
      return { projects: initialProjectCount, columns: initialPlannerGeometry.columns, rows: initialPlannerGeometry.rows };
    });

    const temporaryProject = await page.evaluate(() => window.crmPlanner.createProject(
      'Adaptive geometry smoke project with a deliberately descriptive title',
      'Temporary pg-mem-only project used by the focused UI regression.',
      ['Queue', 'Review', 'Done'],
    ));
    invariant(temporaryProject?.id, 'Could not create the temporary project');
    await page.waitForFunction(
      ({ projectId, expectedProjects }) => window.crmPlanner.projects().length === expectedProjects
        && window.crmPlanner.projects().some((project) => project.id === projectId),
      { projectId: temporaryProject.id, expectedProjects: initialProjectCount + 1 },
    );
    await page.waitForFunction(
      (expectedTiles) => [...document.querySelectorAll('.crm-project-tile-grid')]
        .some((grid) => grid.querySelectorAll(':scope > [data-crm-tile]').length === expectedTiles),
      initialProjectCount + 2,
    );
    await sleep(100);
    const expandedPlannerGeometry = await tileGeometry(plannerGridSelector);
    await check('Project add reflows every project tile evenly', () => {
      invariant(expandedPlannerGeometry?.tiles.length === initialProjectCount + 2, 'Project tile count did not grow');
      invariant(dimensionsAreEqual(expandedPlannerGeometry.tiles), 'Project tiles are uneven after add');
      invariant(expandedPlannerGeometry.bounds?.scroller?.every((value) => value > 100), 'Project gallery was laid out while hidden');
      invariant(
        expandedPlannerGeometry.adaptiveWidth !== initialPlannerGeometry.adaptiveWidth
          || expandedPlannerGeometry.adaptiveHeight !== initialPlannerGeometry.adaptiveHeight
          || expandedPlannerGeometry.columns !== initialPlannerGeometry.columns
          || expandedPlannerGeometry.rows !== initialPlannerGeometry.rows,
        'Project grid geometry did not adapt to the new count',
      );
      return { columns: expandedPlannerGeometry.columns, rows: expandedPlannerGeometry.rows, bounds: expandedPlannerGeometry.bounds };
    });
    await page.evaluate(async (projectId) => {
      await window.crmStore.remove('projects', projectId);
      await window.crmPlanner.refresh(true);
    }, temporaryProject.id);
    await page.waitForFunction((expectedProjects) => window.crmPlanner.projects().length === expectedProjects, initialProjectCount);
    await page.waitForFunction(
      (expectedTiles) => [...document.querySelectorAll('.crm-project-tile-grid')]
        .some((grid) => grid.querySelectorAll(':scope > [data-crm-tile]').length === expectedTiles),
      initialProjectCount + 1,
    );
    await sleep(100);
    const restoredPlannerGeometry = await tileGeometry(plannerGridSelector);
    await check('Project removal restores an even gallery', () => {
      invariant(restoredPlannerGeometry?.tiles.length === initialProjectCount + 1, 'Project tile count did not restore');
      invariant(dimensionsAreEqual(restoredPlannerGeometry.tiles), 'Project tiles are uneven after removal');
      invariant(restoredPlannerGeometry.bounds?.scroller?.every((value) => value > 100), 'Restored project gallery is not visible');
      return { columns: restoredPlannerGeometry.columns, rows: restoredPlannerGeometry.rows, bounds: restoredPlannerGeometry.bounds };
    });
    await activate('planner');

    const projectContext = await page.evaluate(() => {
      const project = window.crmPlanner.projects()[0];
      const firstStage = project?.stages?.[0] || project?.buckets?.[0];
      return project ? { id: project.id, stageId: firstStage?.id || '' } : null;
    });
    invariant(projectContext?.id && projectContext.stageId, 'Could not resolve a seeded project');
    const projectRestored = await page.evaluate(async (projectId) => {
      await window.crmPlanner.applyHomePreviewState({
        view: 'project',
        selectedId: projectId,
        expandedStages: [],
        scrollPositions: {},
      });
      return {
        restored: window.crmPlanner.view() === 'project',
        view: window.crmPlanner.view(),
        level: window.crmPlanner.level(),
        active: window.crmPlanner.isActive(),
        bodyModule: document.body.dataset.crmModule,
        rootTiles: window.crmProjectsCamera?.layers?.()[0]?.querySelectorAll?.('.crm-project-bucket[data-planner-project]')?.length || 0,
      };
    }, projectContext.id);
    invariant(projectRestored.restored, `Could not restore the seeded project world: ${JSON.stringify(projectRestored)}`);
    await page.waitForFunction(() => window.crmPlanner.view() === 'project' && document.querySelectorAll('.crm-planner-card').length > 0);
    const plannerLayerDiagnostics = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && Number(style.opacity) > .01;
      };
      const preparing = [...document.querySelectorAll('.crm-project-gallery-level .crm-home-preview-state')].filter(visible);
      return {
        level: window.crmPlanner.level(),
        preparing: preparing.length,
      };
    });
    await check('Nested Project hides its underlying gallery preview layers', () => {
      invariant(plannerLayerDiagnostics.level === 1, 'Planner did not reach its nested project level');
      invariant(plannerLayerDiagnostics.preparing === 0, `${plannerLayerDiagnostics.preparing} gallery preview layers leaked through the project viewport`);
      return plannerLayerDiagnostics;
    });
    const plannerProjectMenu = await openAddMenu();
    await check('Project + exposes Stage and typed Cards only', () => {
      const ids = plannerProjectMenu.actions.map(({ id }) => id);
      invariant(ids.includes('planner-stage'), 'Project add menu is missing Stage');
      ['generic', 'person', 'money', 'ticket', 'task'].forEach((kind) => {
        invariant(ids.includes(`planner-card-${kind}`), `Project add menu is missing ${kind} card`);
      });
      invariant(!ids.includes('planner-project') && ids.every((id) => id === 'planner-stage' || id.startsWith('planner-card-')), 'Project menu leaked a root action');
      return ids;
    });
    await screenshot('04-planner-project-add-menu.png');
    await page.locator('#context-add-menu [data-context-add-action="planner-card-person"]').click();
    await page.locator('.crm-planner-popover select[name="cardKind"]').waitFor({ state: 'visible' });
    await check('Typed Project card action opens the existing typed-card creator', async () => {
      const creator = await page.evaluate(() => {
        const form = document.querySelector('.crm-planner-popover');
        return {
          title: form?.querySelector('.crm-planner-popover-title')?.textContent.trim() || '',
          cardKind: form?.elements?.cardKind?.value || '',
          stageId: form?.elements?.stageId?.value || '',
        };
      });
      invariant(creator.title === 'New card', `unexpected creator title "${creator.title}"`);
      invariant(creator.cardKind === 'person', `expected Person card type, got "${creator.cardKind}"`);
      invariant(creator.stageId === projectContext.stageId, 'Typed-card creator did not target the current project stage');
      return creator;
    });
    await page.locator('.crm-planner-popover [data-cancel]').click();
    await page.locator('.crm-planner-popover').waitFor({ state: 'detached' });

    const longPersonCard = await page.evaluate(async ({ projectId, stageId }) => window.crmPlanner.createCard(
      projectId,
      stageId,
      'Person onboarding plan',
      'Coordinate the owner, timeline, account access, review checkpoints, documentation, and handoff details. '.repeat(7),
      {
        cardKind: 'person',
        priority: 'high',
        assignee: 'Rosa',
        linkedEntityType: 'contacts',
        linkedRecordId: 'ct_marta',
        linkedLabel: 'Marta Ortiz',
      },
    ), { projectId: projectContext.id, stageId: projectContext.stageId });
    invariant(longPersonCard?.id, 'Could not create the semantic fit probe card');
    const linkedSignatureAudit = await page.evaluate(async ({ projectId, itemId }) => {
      const before = window.crmPlanner.projectPreviewSignature(projectId);
      const updated = await window.crmPlanner.updateItem(itemId, { linkedLabel:'Marta Ortiz · verified link' }, 'linked-signature-probe');
      const after = window.crmPlanner.projectPreviewSignature(projectId);
      return { updated, changed:before !== after };
    }, { projectId:projectContext.id, itemId:longPersonCard.id });
    await check('Planner linked-record edits invalidate the project preview texture', () => {
      invariant(linkedSignatureAudit.updated && linkedSignatureAudit.changed, 'Linked-record fields were omitted from the preview signature');
      return linkedSignatureAudit;
    });
    await page.waitForFunction(
      (id) => {
        const card = document.querySelector(`[data-planner-card="${CSS.escape(id)}"]`);
        return !!card?.querySelector('[data-card-semantic="person"]') && !!card.dataset.cardContentFit;
      },
      longPersonCard.id,
    );
    await page.waitForFunction(() => {
      const cards = [...(window.crmProjectsCamera?.layers?.()[1]?.querySelectorAll?.('.crm-planner-card') || [])];
      const ready = cards.length > 0 && cards.every((card) => !!card.dataset.cardContentFit);
      if (!ready) {
        window.__crmPlannerFitStableAt = 0;
        return false;
      }
      window.__crmPlannerFitStableAt ||= performance.now();
      return performance.now() - window.__crmPlannerFitStableAt >= 350;
    });
    const plannerCards = await semanticCardAudit('@planner-live');
    await check('Planner cards use embossed semantic marks and adaptive content fitting', () => {
      invariant(plannerCards.length > 0, 'No Planner cards were available');
      plannerCards.forEach((card) => {
        invariant(card.mark?.svg, `${card.id} has no semantic SVG`);
        invariant(card.mark.width >= 60 && card.mark.opacity > .1 && card.mark.opacity <= .35, `${card.id} semantic mark is not visibly embossed`);
        invariant(card.mark.color === 'rgb(98, 112, 134)', `${card.id} semantic mark does not inherit the Planner card accent`);
        invariant(card.mark.filter !== 'none' && card.mark.blend === 'multiply', `${card.id} semantic mark lacks embossed shading`);
        invariant(card.bodyAttribute && card.entries >= 2, `${card.id} does not use the shared fit attributes`);
        invariant(['full', 'adaptive'].includes(card.fit), `${card.id} fit ended as "${card.fit}"`);
        invariant(card.overflow <= 1, `${card.id} body overflows by ${card.overflow}px`);
        invariant(card.title?.whiteSpace !== 'nowrap', `${card.id} title still uses immediate one-line truncation`);
      });
      const probe = plannerCards.find((card) => card.id === longPersonCard.id);
      invariant(probe?.mark.type === 'person', 'Typed Person card did not receive the Person icon');
      invariant(probe.fit === 'adaptive' && probe.clamped > 0, 'Long content did not engage adaptive fitting');
      invariant(probe.title.height >= probe.title.lineHeight * 1.75, 'The probe title was immediately reduced to one line');
      const seededTitles = new Set([
        'Select archive set',
        'Move active media library',
        'Verify workstation mounts',
        'Record recovery test',
      ]);
      const seeded = plannerCards.filter((card) => seededTitles.has(card.title?.text));
      invariant(seeded.length === seededTitles.size, `Expected ${seededTitles.size} seeded Planner titles, found ${seeded.length}`);
      seeded.forEach((card) => {
        invariant(
          card.title.height >= card.title.lineHeight * 1.75,
          `"${card.title.text}" was reduced to one line before longer details`,
        );
      });
      return {
        cards: plannerCards.length,
        probe: { fit: probe.fit, clamped: probe.clamped, titleLines: probe.title.height / probe.title.lineHeight },
        seededTitles: seeded.map(({ title }) => ({
          text: title.text,
          lines: title.height / title.lineHeight,
          clamp: title.lineClamp,
        })),
      };
    });
    await screenshot('05-planner-semantic-fit.png');
    const plannerControls = await secondaryControlAudit();
    await check('Planner controls inherit the complete secondary-control contract', () => {
      const summary = assertSecondaryControlContract(plannerControls, bucketAcrylic, 2);
      invariant(plannerControls.some(({ label }) => label === 'Back to projects'), 'Planner project Back control was not found');
      return summary;
    });

    await activate('cases');
    await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-card, [data-crm-theater="tickets"]:not([hidden]) .tk-zcard').length > 0);
    await sleep(300);
    const ticketChromeDiagnostics = await page.evaluate(() => {
      const cluster = [...document.querySelectorAll('.window-control-cluster')]
        .find((element) => !element.classList.contains('window-control-cluster-left'));
      const rect = cluster?.getBoundingClientRect();
      const style = cluster && getComputedStyle(cluster);
      const point = rect && [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const hit = point && document.elementFromPoint(...point);
      return {
        hidden: cluster?.hidden,
        rect: rect && [rect.x, rect.y, rect.width, rect.height],
        controls: cluster?.querySelectorAll('.window-glass-control').length || 0,
        display: style?.display,
        visibility: style?.visibility,
        opacity: style?.opacity,
        z: style?.zIndex,
        hit: hit?.className || hit?.tagName || '',
        ancestors: hit ? [...document.elementsFromPoint(...point)].slice(0, 8).map((element) => element.className || element.tagName) : [],
      };
    });
    await check('Tickets retains the global top-right three-button scheme', () => {
      invariant(!ticketChromeDiagnostics.hidden && ticketChromeDiagnostics.display !== 'none' && ticketChromeDiagnostics.visibility !== 'hidden', 'Top-right controls are hidden in Tickets');
      invariant(ticketChromeDiagnostics.controls === 3, `Tickets exposes ${ticketChromeDiagnostics.controls} top-right controls`);
      invariant(ticketChromeDiagnostics.rect?.[0] >= VIEWPORT.width - 180, 'Top-right controls moved away from the window corner');
      invariant(/\bwindow-(add|refresh|close)-control\b|\bwindow-control-cluster\b/.test(ticketChromeDiagnostics.hit), `Top-right controls are covered by "${ticketChromeDiagnostics.hit}"`);
      return { rect: ticketChromeDiagnostics.rect, controls: ticketChromeDiagnostics.controls, hit: ticketChromeDiagnostics.hit };
    });
    const ticketCards = await semanticCardAudit('[data-crm-theater="tickets"]:not([hidden]) .tk-card, [data-crm-theater="tickets"]:not([hidden]) .tk-zcard');
    await check('Ticket cards inherit semantic marks and the shared fit result', () => {
      invariant(ticketCards.length > 0, 'No Ticket cards were available');
      ticketCards.slice(0, 24).forEach((card) => {
        invariant(card.mark?.type === 'ticket' && card.mark.svg, `${card.id} is missing Ticket iconography`);
        invariant(['full', 'adaptive'].includes(card.fit), `${card.id} fit ended as "${card.fit}"`);
        invariant(card.overflow <= 1, `${card.id} body overflows by ${card.overflow}px`);
        invariant(card.title?.whiteSpace !== 'nowrap', `${card.id} title is still one-line only`);
      });
      return { sampled: Math.min(24, ticketCards.length), total: ticketCards.length };
    });
    const ticketControls = await secondaryControlAudit();
    await check('Ticket stack controls keep the same centered 46px recipe', () => {
      const stackControls = ticketControls.filter(({ classes }) => /\btk-(arrow|stack-btn)\b/.test(classes));
      return assertSecondaryControlContract(stackControls, bucketAcrylic, 2);
    });
    await screenshot('06-tickets-controls-and-icons.png');
    const staleFanReset = await page.evaluate(async () => {
      const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const arrow = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-deck-left .tk-arrow:not(.is-hidden)');
      arrow?.click();
      await paint();
      const opened = arrow?.getAttribute('aria-expanded') === 'true'
        && !!arrow?.closest('.tk-deck')?.classList.contains('is-fanned');
      const staleState = window.ticketStacks.homePreviewState();
      const stage = document.querySelector('[data-crm-theater="tickets"]:not([hidden]) .tk-zone')?.dataset.stage || '';
      staleState.expandedStages = stage ? [stage] : ['legacy-expanded-stage'];
      staleState.fan ||= {};
      staleState.fan.left = { open:true, scrollX:-240 };
      staleState.fan.trash = { open:true, scrollX:-120 };
      await window.ticketStacks.applyHomePreviewState(staleState);
      await paint();
      return {
        opened,
        serialized:window.ticketStacks.homePreviewState().fan,
        serializedExpanded:window.ticketStacks.homePreviewState().expandedStages,
        expandedBuckets:document.querySelectorAll('[data-crm-theater="tickets"] .tk-zone.is-stack-expanded').length,
        expanded:[...document.querySelectorAll('[data-crm-theater="tickets"] .tk-deck-left .tk-arrow, [data-crm-theater="tickets"] .tk-deck-right .tk-arrow')]
          .map((control) => control.getAttribute('aria-expanded')),
        fanned:document.querySelectorAll('[data-crm-theater="tickets"] .tk-deck.is-fanned').length,
      };
    });
    await check('Ticket previews ignore stale fan state and restore collapsed buckets', () => {
      invariant(staleFanReset.opened, 'Fan control no longer opens intentionally');
      invariant(Object.values(staleFanReset.serialized || {}).every((state) => state.open === false && state.scrollX === 0), 'Preview state still serializes an open fan');
      invariant(staleFanReset.serializedExpanded.length === 0 && staleFanReset.expandedBuckets === 0, 'Preview state restored a stale expanded bucket');
      invariant(staleFanReset.expanded.every((value) => value === 'false'), `A fan control remained expanded: ${staleFanReset.expanded.join(',')}`);
      invariant(staleFanReset.fanned === 0, `${staleFanReset.fanned} ticket deck(s) remained fanned`);
      return staleFanReset;
    });

    await activate('assignments');
    await page.waitForFunction(() => document.querySelectorAll('[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id]').length > 0);
    await sleep(300);
    const assignmentCards = await semanticCardAudit('[data-crm-theater="assignments"]:not([hidden]) .tk-zcard[data-id]');
    const assignmentArchitecture = await page.evaluate(() => ({
      legacyFurniture: document.querySelectorAll('.crm-assignment-bucket,.crm-assignment-work-card').length,
      phantomScaffolds: document.querySelectorAll(
        '[data-crm-theater="assignments"] > .tk-stacks,'
        + '[data-crm-theater="assignments"] > .tk-scrim,'
        + '[data-crm-theater="assignments"] .tk-deck',
      ).length,
      contract: window.crmAssignments.contract?.() || null,
    }));
    await check('Assignment cards consume transferable semantic/fit architecture', () => {
      invariant(assignmentCards.length > 0, 'No Assignment cards were available');
      invariant(assignmentArchitecture.legacyFurniture === 0, 'Legacy Assignment furniture is still mounted');
      invariant(assignmentArchitecture.phantomScaffolds === 0, 'Zone-only Assignment mounted a phantom stack/scrim scaffold');
      invariant(assignmentArchitecture.contract?.workflowKind === 'lifecycle', 'Assignment does not use the canonical lifecycle workflow');
      invariant(
        assignmentArchitecture.contract?.horizontalZones === true
          && assignmentArchitecture.contract?.horizontalZoneRows === 1,
        'Assignment buckets do not use the canonical horizontal-zone contract',
      );
      invariant(assignmentArchitecture.contract?.stageAuthority === 'source', 'Assignment placement is not source-authoritative');
      invariant(assignmentArchitecture.contract?.atomicSourceMove === true, 'Assignment movement bypasses the canonical atomic source seam');
      invariant(assignmentArchitecture.contract?.deckScaffold === false, 'Assignment mounted a second deck renderer');
      assignmentCards.forEach((card) => {
        invariant(card.mark?.svg, `${card.id} has no semantic mark`);
        invariant(card.bodyPresent && card.entries >= 3, `${card.id} does not expose adaptive fit entries`);
        invariant(['full', 'adaptive'].includes(card.fit), `${card.id} fit ended as "${card.fit}"`);
        invariant(card.overflow <= 1, `${card.id} body overflows by ${card.overflow}px`);
        invariant(card.title?.whiteSpace !== 'nowrap', `${card.id} title still truncates immediately`);
      });
      return { cards: assignmentCards.length, semanticTypes: [...new Set(assignmentCards.map((card) => card.mark.type))] };
    });
    const assignmentControls = await secondaryControlAudit();
    const assignmentAddMenu = await openAddMenu();
    await closeAddMenu();
    await check('Assignment controls inherit the complete secondary-control contract', () => {
      const summary = assertSecondaryControlContract(assignmentControls, bucketAcrylic, 2);
      invariant(
        assignmentAddMenu.actions.length === 1
          && assignmentAddMenu.actions[0].id === 'assignment'
          && assignmentAddMenu.actions[0].label === 'Assignment',
        `Assignment + exposed the wrong actions: ${assignmentAddMenu.actions.map(({ id }) => id).join(',')}`,
      );
      return { ...summary, addActions: assignmentAddMenu.actions.map(({ id }) => id) };
    });
    await screenshot('07-assignments-semantic-fit.png');

    await activate('calendar');
    await page.waitForFunction(() => document.querySelectorAll('.fc-year-btn').length === 2);
    await sleep(200);
    const calendarControls = await secondaryControlAudit();
    await check('Calendar year controls inherit the complete secondary-control contract', () => {
      const summary = assertSecondaryControlContract(calendarControls, bucketAcrylic, 3);
      invariant(calendarControls.some(({ label }) => label === 'Previous year'), 'Calendar Previous year control was not found');
      invariant(calendarControls.some(({ label }) => label === 'Next year'), 'Calendar Next year control was not found');
      return summary;
    });
    await check('Calendar year navigation has no overlapping global date tile or legacy company strip', async () => {
      const state = await page.evaluate(() => {
        const date = document.querySelector('.crm-viewport-date');
        const strip = document.querySelector('[data-crm-theater="calendar"]:not([hidden]) .fc-year-strip');
        return {
          dateHidden: !!date?.hidden && getComputedStyle(date).display === 'none',
          stripVisible: !!strip && strip.getClientRects().length > 0,
          companyTabs: document.querySelectorAll('.company-tab-bar').length,
        };
      });
      invariant(state.dateHidden, 'Global date tile remained visible inside Calendar');
      invariant(state.stripVisible, 'Calendar year selector is not visible');
      invariant(state.companyTabs === 0, `Legacy company strip mounted ${state.companyTabs} time(s)`);
      return state;
    });
    await screenshot('08-calendar-controls.png');

    await check('Renderer completed without uncaught page errors', () => {
      invariant(pageErrors.length === 0, pageErrors.join(' | '));
      return consoleErrors.length ? { consoleErrors } : 'clean renderer';
    });
  } finally {
    const report = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      passed: results.filter(({ ok }) => ok).length,
      failed: results.filter(({ ok }) => !ok).length,
      pageErrors,
      consoleErrors,
      results,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    harness.stop();
  }

  const failures = results.filter(({ ok }) => !ok);
  console.log(`\nUI refinement smoke: ${results.length - failures.length}/${results.length} checks passed.`);
  console.log(`[report] ${path.relative(process.cwd(), path.join(OUT_DIR, 'report.json'))}`);
  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
