'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron:electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'electron-actual', 'canonical-preview-settlement');
const API_PORT = Number(process.env.CRM_API_PORT || 4069);
const STATIC_PORT = Number(process.env.CRM_STATIC_PORT || 4068);
const QUIET_MS = Math.max(220, Number(process.env.CRM_SETTLEMENT_QUIET_MS || 280));
const QUIET_FRAMES = Math.max(12, Number(process.env.CRM_SETTLEMENT_QUIET_FRAMES || 16));

const HOME_ROOMS = [
  {
    module:'assignments',
    theater:'assignments',
    objects:'.tk-zone[data-stage],.tk-zcard[data-id]',
  },
  { module:'people', theater:'people', objects:'.tk-zone,.tk-card,.tk-zcard' },
  { module:'cases', theater:'tickets', objects:'.tk-zone,.tk-deck,.tk-card' },
  {
    module:'planner',
    theater:'planner',
    objects:'.crm-project-bucket,.crm-planner-bucket,.crm-planner-card',
  },
];

const WORKER_ASSIGNMENT_AUDIT_SOURCE = `(${async function assignmentWorkerAudit() {
  const deadline = performance.now() + 45_000;
  let theater = null;
  while (performance.now() < deadline) {
    theater = document.querySelector('[data-crm-theater="assignments"]:not([hidden])');
    if (document.body.dataset.crmModule === 'assignments'
      && theater
      && theater.matches('.crm-theater[data-crm-theater="assignments"]')
      && theater.querySelectorAll('.tk-zone[data-stage]').length > 0
      && window.crmAssignments) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!theater || document.body.dataset.crmModule !== 'assignments') {
    throw new Error('Assignment preview worker never exposed its canonical theater');
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const signature = (scope) => {
    const zones = [...scope.querySelectorAll('.tk-zone[data-stage]')]
      .filter((zone) => zone.closest('[data-crm-theater]') === scope)
      .map((zone) => ({
      id:zone.dataset.stage || '',
      sizeKey:zone.dataset.crmSizeKey || '',
      title:zone.querySelector('.tk-zone-hd .tk-zone-title,.tk-zone-hd span')
        ?.textContent?.trim() || '',
      cards:[...zone.querySelectorAll('.tk-zcard[data-id]')]
        .filter((card) => card.closest('.tk-zone[data-stage]') === zone)
        .map((card) => ({
        id:card.dataset.id || '',
        recordEntity:card.dataset.recordEntity || '',
        sizeKey:card.dataset.crmSizeKey || '',
        title:card.querySelector('.ticket-company')?.textContent?.trim()
          || card.getAttribute('aria-label') || '',
      })),
    }));
    return {
      zones,
      stageIds:zones.map((zone) => zone.id),
      cardIds:zones.flatMap((zone) => zone.cards.map((card) => card.id)),
    };
  };

  const canonical = signature(theater);
  const legacyNodes = [...document.querySelectorAll(
    '.crm-assignment-bucket,.crm-assignment-work-card',
  )];
  const factoryMiniScenes = [...document.querySelectorAll('.crm-factory-mini-scene')];
  const previewMimics = [...document.querySelectorAll('*')].filter((node) => {
    const classAndId = `${node.id || ''} ${String(node.className || '')}`;
    const attributeNames = [...node.attributes].map((attribute) => attribute.name);
    return /(?:assignment[-_\s]*(?:preview|mini(?:ature)?)|(?:preview|mini(?:ature)?)[-_\s]*assignment)/i.test(classAndId)
      || attributeNames.some((name) => (
        /assignment/i.test(name) && /preview/i.test(name)
      ));
  });
  const requiredFactoryMethods = [
    'setActive', 'reload', 'baseline', 'contract', 'homePreviewState',
    'applyHomePreviewState', 'performanceState', 'createCard', 'moveToStage',
    'setStageExpanded', 'expandedStages', 'zoneScrollState', 'scrollZonesBy',
  ];
  const factoryMethodsMissing = requiredFactoryMethods.filter(
    (method) => typeof window.crmAssignments?.[method] !== 'function',
  );
  const contract = window.crmAssignments.contract?.() || null;
  return {
    url:location.href,
    module:document.body.dataset.crmModule || '',
    canonicalTheater:theater.matches('section.crm-theater[data-crm-theater="assignments"]'),
    theaterCount:document.querySelectorAll('[data-crm-theater="assignments"]').length,
    visibleTheaterCount:document.querySelectorAll(
      '[data-crm-theater="assignments"]:not([hidden])',
    ).length,
    canonical,
    contract,
    factoryMethodsMissing,
    legacyNodes:legacyNodes.map((node) => ({
      tag:node.tagName,
      className:String(node.className || ''),
    })),
    factoryMiniScenes:factoryMiniScenes.map((node) => String(node.className || '')),
    previewMimics:previewMimics.map((node) => ({
      tag:node.tagName,
      id:node.id || '',
      className:String(node.className || ''),
      attributes:[...node.attributes].map((attribute) => attribute.name),
    })),
  };
}.toString()})()`;

async function waitForPreviewIdle(page) {
  const result = await page.evaluate(() => window.crmHomePreviews?.waitForIdle?.());
  assert.equal(result?.ok, true, `Home preview worker did not become idle: ${JSON.stringify(result)}`);
}

async function waitForReadyHome(page) {
  await page.waitForFunction(() => (
    document.body.dataset.crmModule === 'home'
    && !window.crmDeskTransit?.isBusy?.()
    && window.crmHome?.handStatus?.().ready
    && window.crmHome?.motionStatus?.().ready
    && window.crmHome?.previewStatus?.().every((item) => item.state === 'ready')
  ), null, { timeout:60_000 });
  await waitForPreviewIdle(page);
}

async function armSettlementProbe(page, config) {
  await page.evaluate((probeConfig) => {
    window.__crmSettlementProbe?.cancel?.();

    const probe = {
      label:probeConfig.label,
      kind:probeConfig.kind,
      mode:probeConfig.mode || 'post-arrival',
      ownershipStart:null,
      ownershipEnd:null,
      release:null,
      baselineAt:null,
      finishedAt:null,
      root:null,
      frames:0,
      quietFrames:0,
      added:[],
      removed:[],
      lateVisible:[],
      attributeMutations:[],
      baselineObjectKeys:[],
      finalObjectKeys:[],
      error:null,
    };
    let done = false;
    let observer = null;
    let timeout = 0;
    let frameRequest = 0;
    let observationPending = false;
    let root = null;
    let baselineNodes = null;
    let baselineVisibility = null;
    const addedNodes = new WeakSet();
    const removedNodes = new WeakSet();
    const lateVisibleNodes = new WeakSet();
    let resolveDone;
    window.__crmSettlementProbeDone = new Promise((resolve) => { resolveDone = resolve; });

    const describe = (node) => ({
      tag:node?.tagName || '',
      id:String(node?.id || ''),
      className:String(node?.className || '').slice(0, 140),
      identity:node?.dataset?.stage
        || node?.dataset?.plannerCard
        || node?.dataset?.plannerBucket
        || node?.dataset?.plannerProject
        || node?.dataset?.id
        || node?.dataset?.date
        || node?.dataset?.module
        || node?.dataset?.viewportModule
        || '',
    });
    const objectKey = (node, index) => {
      const item = describe(node);
      return `${item.tag}:${item.identity || item.id || item.className}:${index}`;
    };
    const resolveRoot = () => {
      if (probeConfig.rootKind === 'home') {
        return window.crmHomeCamera?.layers?.()[0] || null;
      }
      if (probeConfig.rootKind === 'calendar-current') {
        const camera = window.fractalCalendarCamera;
        return camera?.layers?.()[camera.level?.()] || null;
      }
      return document.querySelector(
        `[data-crm-theater="${CSS.escape(probeConfig.theater || '')}"]:not([hidden])`,
      );
    };
    const styleState = (node, cache = new Map()) => {
      let cursor = node;
      let effectiveOpacity = 1;
      let display = '';
      let visibility = '';
      let blocker = null;
      while (cursor?.nodeType === Node.ELEMENT_NODE) {
        let style = cache.get(cursor);
        if (!style) {
          const computed = getComputedStyle(cursor);
          style = {
            display:computed.display,
            visibility:computed.visibility,
            opacity:Number.isFinite(Number(computed.opacity)) ? Number(computed.opacity) : 1,
          };
          cache.set(cursor, style);
        }
        if (cursor === node) {
          display = style.display;
          visibility = style.visibility;
        }
        effectiveOpacity *= style.opacity;
        if (!blocker && (style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
          || style.opacity <= .01)) blocker = cursor;
        if (cursor === document.documentElement) break;
        cursor = cursor.parentElement;
      }
      return {
        visible:!blocker && effectiveOpacity > .01,
        display,
        visibility,
        effectiveOpacity:Number(effectiveOpacity.toFixed(4)),
        blocker:blocker ? describe(blocker) : null,
      };
    };
    const recordAdded = (node, source) => {
      if (node?.nodeType !== Node.ELEMENT_NODE || addedNodes.has(node)) return;
      addedNodes.add(node);
      probe.added.push({ source, ...describe(node), descendants:node.querySelectorAll('*').length });
    };
    const recordRemoved = (node, source) => {
      if (node?.nodeType !== Node.ELEMENT_NODE || removedNodes.has(node)) return;
      removedNodes.add(node);
      probe.removed.push({ source, ...describe(node), descendants:node.querySelectorAll('*').length });
    };
    const removeListeners = () => {
      document.removeEventListener('crm:desk-ownership-fade', onTransitionEvent);
      document.removeEventListener('crm:desk-transit-settled', onTransitionEvent);
      document.removeEventListener('crm:camera-navigation', onTransitionEvent);
    };
    const complete = (error = null) => {
      if (done) return;
      done = true;
      if (error) probe.error = String(error);
      observer?.disconnect();
      clearTimeout(timeout);
      cancelAnimationFrame(frameRequest);
      removeListeners();
      if (root) {
        const finalObjects = [...root.querySelectorAll(probeConfig.objectSelector || '*')];
        probe.finalObjectKeys = finalObjects.map(objectKey);
      }
      probe.finishedAt = performance.now();
      resolveDone(probe);
    };
    const eventDetail = (event) => ({
        type:event.type,
        phase:event.detail?.phase || '',
        direction:event.detail?.direction || '',
        key:event.detail?.key || '',
        level:event.detail?.level ?? null,
        at:performance.now(),
    });
    const startObservation = (afterCurrentPaint = false) => {
      if (done || root || observationPending) return;
      observationPending = true;
      const start = () => {
        if (done) return;
        root = resolveRoot();
        if (!root) {
          complete(`No settled root found for ${probeConfig.rootKind}`);
          return;
        }
        probe.root = {
          ...describe(root),
          level:window.fractalCalendarCamera?.level?.() ?? null,
        };
        probe.baselineAt = performance.now();
        const nodes = [root, ...root.querySelectorAll('*')];
        baselineNodes = new Set(nodes);
        const cache = new Map();
        baselineVisibility = new Map(nodes.map((node) => [node, styleState(node, cache)]));
        const objects = [...root.querySelectorAll(probeConfig.objectSelector || '*')];
        probe.baselineObjectKeys = objects.map(objectKey);

        observer = new MutationObserver((records) => {
          records.forEach((record) => {
            if (record.type === 'childList') {
              record.addedNodes.forEach((node) => recordAdded(node, 'observer'));
              record.removedNodes.forEach((node) => recordRemoved(node, 'observer'));
              return;
            }
            if (probe.attributeMutations.length < 80) {
              probe.attributeMutations.push({
                attribute:record.attributeName || '',
                before:String(record.oldValue ?? '').slice(0, 160),
                after:String(record.target.getAttribute(record.attributeName) ?? '').slice(0, 160),
                target:describe(record.target),
              });
            }
          });
        });
        observer.observe(root, {
          childList:true,
          subtree:true,
          attributes:true,
          attributeOldValue:true,
          attributeFilter:['class', 'style', 'hidden'],
        });

        const observationStartedAt = performance.now();
        const tick = (now) => {
          if (done) return;
          probe.frames += 1;
          if (probe.release) probe.quietFrames += 1;
          const currentNodes = [root, ...root.querySelectorAll('*')];
          const currentSet = new Set(currentNodes);
          currentNodes.forEach((node) => {
            if (!baselineNodes.has(node)) recordAdded(node, 'snapshot');
          });
          baselineNodes.forEach((node) => {
            if (!node.isConnected || (node !== root && !currentSet.has(node))) {
              recordRemoved(node, 'snapshot');
            }
          });
          const styleCache = new Map();
          baselineVisibility.forEach((before, node) => {
            if (!node.isConnected || (node !== root && !currentSet.has(node))) return;
            const after = styleState(node, styleCache);
            if (!before.visible && after.visible && !lateVisibleNodes.has(node)) {
              lateVisibleNodes.add(node);
              probe.lateVisible.push({
                frame:probe.frames,
                elapsed:Number((now - observationStartedAt).toFixed(2)),
                target:describe(node),
                before,
                after,
              });
            }
          });
          if (probe.release
            && probe.quietFrames >= probeConfig.minFrames
            && now - probe.release.at >= probeConfig.quietMs) {
            complete();
            return;
          }
          frameRequest = requestAnimationFrame(tick);
        };
        frameRequest = requestAnimationFrame(tick);
      };
      if (afterCurrentPaint) frameRequest = requestAnimationFrame(start);
      else start();
    };
    const onTransitionEvent = (event) => {
      if (done) return;
      if (probeConfig.mode === 'ownership') {
        if (event.type === 'crm:desk-ownership-fade' && event.detail?.phase === 'start') {
          if (!probe.ownershipStart) probe.ownershipStart = eventDetail(event);
          // The exact cover is outside this destination root. Snapshot and
          // observe synchronously, before the fade animation can expose any
          // late factory/render continuation beneath it.
          startObservation(false);
          return;
        }
        if (event.type === 'crm:desk-ownership-fade' && event.detail?.phase === 'end') {
          if (!probe.ownershipEnd) probe.ownershipEnd = eventDetail(event);
          if (!probe.release) probe.release = { ...probe.ownershipEnd };
          startObservation(false);
          return;
        }
        if (event.type !== 'crm:desk-transit-settled' || probe.release) return;
        // Preserve diagnostics if the ownership event contract regresses;
        // assertQuietSettlement still requires both ownership boundaries.
        probe.release = eventDetail(event);
        startObservation(true);
      } else if (probeConfig.mode === 'home-return') {
        const cameraSettled = event.type === 'crm:camera-navigation'
          && event.detail?.apiName === 'crmHomeCamera'
          && event.detail?.phase === 'settled'
          && event.detail?.direction === 'back';
        const deskSettled = event.type === 'crm:desk-transit-settled'
          && event.detail?.key === 'home';
        if ((!cameraSettled && !deskSettled) || probe.release) return;
        probe.release = eventDetail(event);
        startObservation(false);
      } else {
        if (event.type !== 'crm:camera-navigation'
          || event.detail?.apiName !== 'fractalCalendarCamera'
          || event.detail?.phase !== 'settled'
          || event.detail?.direction !== probeConfig.direction) return;
        if (!probe.release) probe.release = eventDetail(event);
        startObservation(true);
      }
    };

    document.addEventListener('crm:desk-ownership-fade', onTransitionEvent);
    document.addEventListener('crm:desk-transit-settled', onTransitionEvent);
    document.addEventListener('crm:camera-navigation', onTransitionEvent);
    timeout = setTimeout(
      () => complete(`Release event timed out for ${probeConfig.label}`),
      35_000,
    );
    window.__crmSettlementProbe = { probe, cancel:() => complete('Probe cancelled') };
  }, {
    ...config,
    quietMs:QUIET_MS,
    minFrames:QUIET_FRAMES,
  });
}

async function takeSettlementProbe(page) {
  const probe = await page.evaluate(() => window.__crmSettlementProbeDone);
  await page.evaluate(() => {
    delete window.__crmSettlementProbe;
    delete window.__crmSettlementProbeDone;
  });
  return probe;
}

function assertQuietSettlement(probe) {
  assert.ok(probe, 'Settlement probe did not return evidence');
  assert.equal(probe.error, null, `${probe.label}: ${probe.error}`);
  assert.ok(probe.release, `${probe.label}: release was not observed`);
  if (probe.mode === 'ownership') {
    assert.ok(probe.ownershipStart, `${probe.label}: ownership-fade start was not observed`);
    assert.ok(probe.ownershipEnd, `${probe.label}: ownership-fade end was not observed`);
    assert.ok(
      probe.baselineAt >= probe.ownershipStart.at
        && probe.baselineAt - probe.ownershipStart.at < 16,
      `${probe.label}: destination observation did not begin with ownership-fade start`,
    );
  } else if (probe.mode === 'home-return') {
    assert.ok(
      probe.baselineAt >= probe.release.at && probe.baselineAt - probe.release.at < 16,
      `${probe.label}: Home observation did not begin with its post-arrival release`,
    );
  } else {
    assert.ok(
      probe.baselineAt >= probe.release.at,
      `${probe.label}: post-arrival observation began before its release event`,
    );
  }
  assert.ok(
    probe.quietFrames >= QUIET_FRAMES,
    `${probe.label}: sampled only ${probe.quietFrames} post-release frames`,
  );
  assert.deepEqual(
    probe.added,
    [],
    `${probe.label}: destination object tree gained nodes during/after ownership handoff`,
  );
  assert.deepEqual(
    probe.removed,
    [],
    `${probe.label}: destination object tree lost nodes during/after ownership handoff`,
  );
  assert.deepEqual(
    probe.attributeMutations,
    [],
    `${probe.label}: destination class/hidden/style identity changed during/after ownership handoff`,
  );
  assert.deepEqual(
    probe.lateVisible,
    [],
    `${probe.label}: opacity/display content instantiated during/after ownership handoff`,
  );
  assert.deepEqual(
    probe.finalObjectKeys,
    probe.baselineObjectKeys,
    `${probe.label}: canonical object identities changed after release`,
  );
}

async function transitionHomeToRoom(page, room) {
  await waitForReadyHome(page);
  const selector = `.crm-home-bucket[data-module="${room.module}"]`;
  const tile = page.locator(selector).first();
  await tile.waitFor({ state:'visible', timeout:10_000 });
  await tile.hover();
  await sleep(140);
  await armSettlementProbe(page, {
    label:`home-to-${room.module}`,
    kind:'home',
    mode:'ownership',
    rootKind:'theater',
    theater:room.theater,
    objectSelector:room.objects,
  });
  await tile.click();
  await page.waitForFunction((module) => (
    document.body.dataset.crmModule === module
    && !window.crmDeskTransit?.isBusy?.()
    && !window.crmHomeCamera?.isTransitioning?.()
  ), room.module, { timeout:30_000 });
  const probe = await takeSettlementProbe(page);
  assertQuietSettlement(probe);
  return probe;
}

async function transitionRoomToHome(page, room) {
  await waitForPreviewIdle(page);
  await armSettlementProbe(page, {
    label:`${room.module}-to-home`,
    kind:'home',
    mode:'home-return',
    rootKind:'home',
    objectSelector:'.crm-home-bucket,.crm-home-title-slot,.crm-home-preview-image',
  });
  await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
  await page.waitForFunction(() => (
    document.body.dataset.crmModule === 'home'
    && !window.crmDeskTransit?.isBusy?.()
    && !window.crmHomeCamera?.isTransitioning?.()
  ), null, { timeout:30_000 });
  const probe = await takeSettlementProbe(page);
  assertQuietSettlement(probe);
  await waitForReadyHome(page);
  return probe;
}

async function readCanonicalAssignmentSignature(page) {
  await page.waitForFunction(() => {
    const theater = document.querySelector(
      '[data-crm-theater="assignments"]:not([hidden])',
    );
    return !!theater
      && theater.matches('.crm-theater[data-crm-theater="assignments"]')
      && theater.querySelectorAll('.tk-zone[data-stage]').length > 0
      && !!window.crmAssignments;
  }, null, { timeout:30_000 });
  return page.evaluate(() => {
    const theater = document.querySelector(
      '[data-crm-theater="assignments"]:not([hidden])',
    );
    const zones = [...theater.querySelectorAll('.tk-zone[data-stage]')]
      .filter((zone) => zone.closest('[data-crm-theater]') === theater)
      .map((zone) => ({
      id:zone.dataset.stage || '',
      sizeKey:zone.dataset.crmSizeKey || '',
      title:zone.querySelector('.tk-zone-hd .tk-zone-title,.tk-zone-hd span')
        ?.textContent?.trim() || '',
      cards:[...zone.querySelectorAll('.tk-zcard[data-id]')]
        .filter((card) => card.closest('.tk-zone[data-stage]') === zone)
        .map((card) => ({
        id:card.dataset.id || '',
        recordEntity:card.dataset.recordEntity || '',
        sizeKey:card.dataset.crmSizeKey || '',
        title:card.querySelector('.ticket-company')?.textContent?.trim()
          || card.getAttribute('aria-label') || '',
      })),
    }));
    const requiredFactoryMethods = [
      'setActive', 'reload', 'baseline', 'contract', 'homePreviewState',
      'applyHomePreviewState', 'performanceState', 'createCard', 'moveToStage',
      'setStageExpanded', 'expandedStages', 'zoneScrollState', 'scrollZonesBy',
    ];
    const stageIds = new Set(zones.map((zone) => zone.id));
    const records = window.crmAssignments.items?.() || [];
    const expectedStage = (record) => {
      if (['completed', 'cancelled', 'canceled'].includes(String(record?.status || '').toLowerCase())) {
        return 'done';
      }
      const explicit = String(record?.assignmentStage || '').toLowerCase();
      if (stageIds.has(explicit)) return explicit;
      return record?.assignedContactId || String(record?.assignee || '').trim()
        ? 'assigned'
        : 'unassigned';
    };
    const actualStageById = Object.fromEntries(zones.flatMap((zone) => (
      zone.cards.map((card) => [card.id, zone.id])
    )));
    return {
      canonicalTheater:theater.matches(
        'section.crm-theater[data-crm-theater="assignments"]',
      ),
      theaterClassName:String(theater.className || ''),
      zones,
      stageIds:zones.map((zone) => zone.id),
      cardIds:zones.flatMap((zone) => zone.cards.map((card) => card.id)),
      placements:records.map((record) => ({
        id:String(record.id || ''),
        status:String(record.status || ''),
        expected:expectedStage(record),
        actual:actualStageById[String(record.id || '')] || '',
      })),
      doneCardIds:zones.find((zone) => zone.id === 'done')?.cards.map((card) => card.id) || [],
      deckScaffold:[...theater.querySelectorAll(':scope > .tk-stacks,:scope > .tk-scrim,.tk-deck')]
        .map((node) => String(node.className || node.tagName)),
      contract:window.crmAssignments.contract?.() || null,
      factoryMethodsMissing:requiredFactoryMethods.filter(
        (method) => typeof window.crmAssignments?.[method] !== 'function',
      ),
      legacyNodes:[...document.querySelectorAll(
        '.crm-assignment-bucket,.crm-assignment-work-card',
      )].map((node) => ({
        tag:node.tagName,
        className:String(node.className || ''),
      })),
      factoryMiniScenes:[...document.querySelectorAll('.crm-factory-mini-scene')]
        .map((node) => String(node.className || '')),
    };
  });
}

async function armAssignmentWorkerAudit(app) {
  await app.evaluate(({ app:electronApp, BrowserWindow }, auditSource) => {
    globalThis.__crmAssignmentPreviewAudits = [];
    const attach = (win) => {
      if (!win || win.isDestroyed() || win.__crmAssignmentAuditListener) return;
      win.__crmAssignmentAuditListener = true;
      const inspect = () => {
        if (win.isDestroyed()
          || !win.webContents.getURL().includes('crmPreviewWorker=1')
          || win.__crmAssignmentAuditStarted) return;
        win.__crmAssignmentAuditStarted = true;
        win.webContents.executeJavaScript(auditSource, true).then(
          (audit) => globalThis.__crmAssignmentPreviewAudits.push({ ok:true, audit }),
          (error) => globalThis.__crmAssignmentPreviewAudits.push({
            ok:false,
            error:String(error?.stack || error?.message || error),
          }),
        );
      };
      win.webContents.on('did-finish-load', inspect);
      win.webContents.on('did-stop-loading', inspect);
      setImmediate(inspect);
    };
    const listener = (_event, win) => attach(win);
    globalThis.__crmAssignmentPreviewWindowListener = listener;
    electronApp.on('browser-window-created', listener);
    BrowserWindow.getAllWindows().forEach(attach);
  }, WORKER_ASSIGNMENT_AUDIT_SOURCE);
}

async function takeAssignmentWorkerAudit(app) {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const result = await app.evaluate(() => (
      globalThis.__crmAssignmentPreviewAudits?.find((entry) => entry.ok)
      || globalThis.__crmAssignmentPreviewAudits?.find((entry) => !entry.ok)
      || null
    ));
    if (result) return result;
    await sleep(25);
  }
  return null;
}

async function disarmAssignmentWorkerAudit(app) {
  await app.evaluate(({ app:electronApp }) => {
    const listener = globalThis.__crmAssignmentPreviewWindowListener;
    if (listener) electronApp.removeListener('browser-window-created', listener);
    delete globalThis.__crmAssignmentPreviewWindowListener;
    delete globalThis.__crmAssignmentPreviewAudits;
  });
}

async function verifyAssignmentPreview(page, app, canonical) {
  const homeDom = await page.evaluate(() => {
    const tile = document.querySelector('.crm-home-bucket[data-module="assignments"]');
    const preview = tile?.querySelector(':scope > .crm-home-preview');
    return {
      tileCount:document.querySelectorAll(
        '.crm-home-bucket[data-viewport-module="assignments"]',
      ).length,
      previewImages:preview?.querySelectorAll(':scope > .crm-home-preview-image').length || 0,
      livePreviewObjects:preview?.querySelectorAll(
        '.crm-theater,.tk-zone,.tk-zcard,.tk-card',
      ).length || 0,
      liveTrees:document.querySelectorAll(
        '.crm-home-grid .crm-theater,.crm-home-grid .tk-zone,'
          + '.crm-home-grid .tk-zcard,.crm-home-grid .tk-card',
      ).length,
      legacyNodes:[...document.querySelectorAll(
        '.crm-assignment-bucket,.crm-assignment-work-card',
      )].map((node) => String(node.className || '')),
      factoryMiniScenes:[...document.querySelectorAll('.crm-factory-mini-scene')]
        .map((node) => String(node.className || '')),
    };
  });
  assert.ok(homeDom.tileCount >= 1, 'Home has no Assignment viewport tile');
  assert.ok(homeDom.previewImages >= 1, 'Assignment Home preview is not an inert image');
  assert.equal(homeDom.livePreviewObjects, 0, 'Assignment Home preview contains a mimic object tree');
  assert.equal(homeDom.liveTrees, 0, 'Assignment Home grid contains a live miniature tree');
  assert.deepEqual(homeDom.legacyNodes, [], 'Legacy Assignment nodes remain in the Home document');
  assert.deepEqual(
    homeDom.factoryMiniScenes,
    [],
    'A detached factory miniature was mounted instead of the canonical capture',
  );

  await waitForPreviewIdle(page);
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  ));
  assert.equal(windowsBefore, 1, 'A stale preview worker existed before the focused capture');
  await armAssignmentWorkerAudit(app);
  let capture;
  let workerResult;
  try {
    capture = await page.evaluate(async () => {
      const viewState = window.crmAssignments.homePreviewState?.() || null;
      return window.crmHomePreviews.capture('assignments', viewState);
    });
    workerResult = await takeAssignmentWorkerAudit(app);
  } finally {
    await disarmAssignmentWorkerAudit(app);
  }
  assert.equal(capture?.ok, true, `Assignment preview capture failed: ${JSON.stringify(capture)}`);
  assert.ok(capture.preview?.foregroundSrc?.startsWith('data:image/png'));
  assert.ok(capture.preview?.exactSrc?.startsWith('data:image/png'));
  assert.ok(workerResult, 'Assignment preview worker audit did not run');
  assert.equal(workerResult.ok, true, workerResult?.error || 'Assignment preview worker audit failed');

  const worker = workerResult.audit;
  assert.equal(worker.module, 'assignments');
  assert.equal(worker.canonicalTheater, true, 'Preview worker did not use the shared factory theater');
  assert.equal(worker.theaterCount, 1, 'Preview worker mounted duplicate Assignment theaters');
  assert.equal(worker.visibleTheaterCount, 1, 'Preview worker did not capture one visible theater');
  assert.deepEqual(worker.legacyNodes, [], 'Preview worker mounted legacy Assignment object classes');
  assert.deepEqual(worker.factoryMiniScenes, [], 'Preview worker mounted a factory miniature');
  assert.deepEqual(worker.previewMimics, [], 'Assignment-specific preview mimic structure exists');
  assert.deepEqual(worker.factoryMethodsMissing, [], 'Preview worker lacks shared factory methods');
  assert.deepEqual(worker.contract, canonical.contract, 'Live/worker factory contracts diverged');
  assert.deepEqual(worker.canonical.zones, canonical.zones);
  assert.deepEqual(
    worker.canonical.stageIds,
    canonical.contract.stages.map((stage) => String(stage.key || '')),
  );

  const captureObjectIds = (capture.preview.layoutSignature?.objects || [])
    .map((object) => String(object[0] || '')).sort();
  const canonicalObjectIds = [
    ...canonical.stageIds,
    ...canonical.cardIds,
  ].map(String).sort();
  assert.deepEqual(
    captureObjectIds,
    canonicalObjectIds,
    'Published Assignment preview identities differ from its canonical theater',
  );
  await waitForPreviewIdle(page);
  const windowsAfter = await app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  ));
  assert.equal(windowsAfter, 1, 'Assignment preview worker leaked after capture');
  return {
    homeDom,
    stageIds:canonical.stageIds,
    cardIds:canonical.cardIds,
    captureObjectIds,
    workerUrl:worker.url,
    factoryContract:canonical.contract,
  };
}

async function verifyCalendarDaySettlement(page) {
  await page.evaluate(() => window.crmWorkspaces.setActive('calendar'));
  await page.waitForFunction(() => (
    document.body.dataset.crmModule === 'calendar'
    && window.fractalCalendarCamera?.level?.() === 0
    && !window.fractalCalendarCamera?.isTransitioning?.()
    && window.fractalCalendar?.geometryReady?.()
    && !!document.querySelector('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)')
  ), null, { timeout:45_000 });
  await waitForPreviewIdle(page);

  const month = page.locator(
    '.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)',
  ).first();
  await month.hover();
  await sleep(260);
  await month.click();
  await page.waitForFunction(() => (
    window.fractalCalendarCamera?.level?.() === 1
    && !window.fractalCalendarCamera?.isTransitioning?.()
    && !!document.querySelector(
      '.fc-expander[data-kind="month"] > .fc-expander-live '
        + '.fc-day[data-date]:has(.fc-chip)',
    )
  ), null, { timeout:30_000 });
  await page.evaluate(() => new Promise(
    (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)),
  ));

  const day = page.locator(
    '.fc-expander[data-kind="month"] > .fc-expander-live '
      + '.fc-day[data-date]:has(.fc-chip)',
  ).first();
  await day.hover();
  await sleep(260);
  await armSettlementProbe(page, {
    label:'calendar-day-entry',
    kind:'calendar',
    mode:'post-arrival',
    direction:'forward',
    rootKind:'calendar-current',
    objectSelector:'.fc-day-card,.fc-chip,[data-calendar-item],[data-record-id]',
  });
  await day.click();
  await page.waitForFunction(() => (
    window.fractalCalendarCamera?.level?.() === 2
    && !window.fractalCalendarCamera?.isTransitioning?.()
  ), null, { timeout:30_000 });
  const entry = await takeSettlementProbe(page);
  assertQuietSettlement(entry);
  assert.equal(entry.root.level, 2, 'Calendar day entry settled on the wrong level');

  await armSettlementProbe(page, {
    label:'calendar-day-exit',
    kind:'calendar',
    mode:'post-arrival',
    direction:'back',
    rootKind:'calendar-current',
    objectSelector:'.fc-day,.fc-chip,[data-calendar-item],[data-record-id]',
  });
  await page.evaluate(() => window.fractalCalendar.back());
  await page.waitForFunction(() => (
    window.fractalCalendarCamera?.level?.() === 1
    && !window.fractalCalendarCamera?.isTransitioning?.()
  ), null, { timeout:30_000 });
  const exit = await takeSettlementProbe(page);
  assertQuietSettlement(exit);
  assert.equal(exit.root.level, 1, 'Calendar day exit settled on the wrong level');
  return { entry, exit };
}

async function main() {
  fs.mkdirSync(outDir, { recursive:true });
  const harness = await start({ apiPort:API_PORT, staticPort:STATIC_PORT });
  const app = await electron.launch({
    args:['.'],
    cwd:projectRoot,
    env:{ ...process.env, CRM_API_URL:harness.apiUrl, CRM_CDMS_DISABLED:'1' },
    timeout:30_000,
  });
  let page;
  try {
    page = await app.firstWindow({ timeout:30_000 });
    await page.waitForLoadState('load');
    await page.waitForFunction(() => (
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && !!window.crmWorkspaces
      && !!window.crmDeskTransit
    ), null, { timeout:45_000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await waitForReadyHome(page);

    const evidence = {
      ports:{ api:API_PORT, static:STATIC_PORT },
      assignmentPreview:null,
      homeTransitions:{},
      calendar:null,
    };

    const assignmentRoom = HOME_ROOMS[0];
    evidence.homeTransitions.assignments = {
      entry:await transitionHomeToRoom(page, assignmentRoom),
    };
    const canonicalAssignment = await readCanonicalAssignmentSignature(page);
    assert.equal(
      canonicalAssignment.canonicalTheater,
      true,
      `Assignment live root is not the shared factory theater: ${canonicalAssignment.theaterClassName}`,
    );
    assert.ok(canonicalAssignment.contract, 'Assignment does not expose the shared factory contract');
    assert.equal(canonicalAssignment.contract.workflowKind, 'lifecycle');
    assert.equal(canonicalAssignment.contract.horizontalZones, true);
    assert.equal(canonicalAssignment.contract.horizontalZoneRows, 1);
    assert.equal(canonicalAssignment.contract.scrollZoneRows, false);
    assert.equal(canonicalAssignment.contract.lazyZoneCards, false);
    assert.equal(canonicalAssignment.contract.restoreZoneExpansion, false);
    assert.equal(canonicalAssignment.contract.stageAuthority, 'source');
    assert.equal(canonicalAssignment.contract.deletionAuthority, 'source');
    assert.equal(canonicalAssignment.contract.atomicSourceMove, true);
    assert.equal(canonicalAssignment.contract.deckScaffold, false);
    assert.equal(canonicalAssignment.contract.leftDeckEnabled, false);
    assert.equal(canonicalAssignment.contract.rightDeckEnabled, false);
    assert.equal(canonicalAssignment.contract.trashEnabled, false);
    assert.equal(canonicalAssignment.contract.stageMovement, 'free');
    assert.equal(canonicalAssignment.contract.showProgressBars, true);
    assert.deepEqual(
      canonicalAssignment.factoryMethodsMissing,
      [],
      'Assignment does not expose the shared createCrmCardSystem API',
    );
    assert.deepEqual(
      canonicalAssignment.legacyNodes,
      [],
      'Legacy Assignment buckets/cards remain in the live or hidden document',
    );
    assert.deepEqual(
      canonicalAssignment.factoryMiniScenes,
      [],
      'Assignment mounted a factory miniature instead of its canonical theater',
    );
    assert.deepEqual(
      canonicalAssignment.stageIds,
      canonicalAssignment.contract.stages.map((stage) => String(stage.key || '')),
      'Assignment zones differ from its shared factory contract',
    );
    assert.ok(canonicalAssignment.cardIds.length > 0, 'Canonical Assignment theater has no cards');
    assert.ok(canonicalAssignment.doneCardIds.length > 0, 'Canonical Assignment Done zone has no seeded closed commitment');
    assert.deepEqual(
      canonicalAssignment.placements.filter((placement) => placement.actual !== placement.expected),
      [],
      'Assignment commitments are not rendered in their canonical domain stage',
    );
    assert.deepEqual(
      canonicalAssignment.deckScaffold,
      [],
      'Zone-only Assignment mounted a phantom stack/scrim scaffold',
    );
    assert.equal(
      new Set(canonicalAssignment.cardIds).size,
      canonicalAssignment.cardIds.length,
      'Canonical Assignment theater duplicated a commitment card',
    );
    canonicalAssignment.zones.forEach((zone) => {
      assert.equal(zone.sizeKey, `bucket:assignments:${zone.id}`);
      zone.cards.forEach((card) => {
        assert.equal(card.recordEntity, 'commitments');
        assert.equal(card.sizeKey, `card:commitments:${card.id}`);
      });
    });
    evidence.homeTransitions.assignments.exit = await transitionRoomToHome(
      page,
      assignmentRoom,
    );
    evidence.assignmentPreview = await verifyAssignmentPreview(
      page,
      app,
      canonicalAssignment,
    );

    for (const room of HOME_ROOMS.slice(1)) {
      evidence.homeTransitions[room.module] = {
        entry:await transitionHomeToRoom(page, room),
        exit:await transitionRoomToHome(page, room),
      };
    }
    evidence.calendar = await verifyCalendarDaySettlement(page);

    const compact = {
      ports:evidence.ports,
      assignmentPreview:{
        stages:evidence.assignmentPreview.stageIds.length,
        cards:evidence.assignmentPreview.cardIds.length,
        captureIdentities:evidence.assignmentPreview.captureObjectIds.length,
        homeImages:evidence.assignmentPreview.homeDom.previewImages,
        homeMimicObjects:evidence.assignmentPreview.homeDom.livePreviewObjects,
      },
      homeTransitions:Object.fromEntries(
        Object.entries(evidence.homeTransitions).map(([module, transitions]) => [
          module,
          Object.fromEntries(Object.entries(transitions).map(([direction, probe]) => [
            direction,
            {
              mode:probe.mode,
              ownershipStart:probe.ownershipStart?.phase || null,
              ownershipEnd:probe.ownershipEnd?.phase || null,
              release:probe.release?.type,
              frames:probe.frames,
              added:probe.added.length,
              removed:probe.removed.length,
              attributeMutations:probe.attributeMutations.length,
              lateVisible:probe.lateVisible.length,
            },
          ])),
        ]),
      ),
      calendar:{
        entry:{
          frames:evidence.calendar.entry.frames,
          added:evidence.calendar.entry.added.length,
          removed:evidence.calendar.entry.removed.length,
          attributeMutations:evidence.calendar.entry.attributeMutations.length,
          lateVisible:evidence.calendar.entry.lateVisible.length,
        },
        exit:{
          frames:evidence.calendar.exit.frames,
          added:evidence.calendar.exit.added.length,
          removed:evidence.calendar.exit.removed.length,
          attributeMutations:evidence.calendar.exit.attributeMutations.length,
          lateVisible:evidence.calendar.exit.lateVisible.length,
        },
      },
    };
    fs.writeFileSync(
      path.join(outDir, 'evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify(compact, null, 2));
  } catch (error) {
    if (page) {
      await page.screenshot({ path:path.join(outDir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await app.evaluate(({ app:electronApp }) => {
      setImmediate(() => electronApp.exit(0));
      return true;
    }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), sleep(3000)]);
    harness.stop();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
