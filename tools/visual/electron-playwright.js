'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOTION_TARGET = { minFps: 95, maxP95Ms: 18, maxFrameMs: 50, maxOver34Ms: 1 };
const HOME_PREVIEW_VERSION = 'filtered-home-v32';
const HOME_PREVIEW_REST_FILTER = 'blur(1.8px)';
const readyHome = () => document.body.dataset.crmModule === 'home'
  && !document.querySelector('.crm-home-surface')?.hidden
  && document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 6
  && window.crmHome?.motionStatus?.().ready
  && [...document.querySelectorAll('.crm-home-grid .crm-home-preview')].every((host) => {
    const image = host.querySelector(':scope > .crm-home-preview-foreground');
    return host.children.length === 1 && image?.complete && image.naturalWidth > 0;
  });

async function frameRate(page, duration = 1200) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const started = performance.now(); let frames = 0;
    const tick = (now) => { frames += 1; if (now - started >= ms) resolve(frames * 1000 / (now - started)); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), duration);
}

async function startMotionProbe(page, label, duration = 560) {
  await page.evaluate(({ probeLabel, durationMs }) => {
    window.__crmMotionProbes ||= {};
    const probe = { label: probeLabel, durationMs, startedAt: performance.now(), deltas: [], motionDeltas: [], done: false };
    probe.promise = new Promise((resolve) => {
      let previous = probe.startedAt; let previousMoving = false;
      const tick = (now) => {
        const delta = now - previous;
        const moving = !!window.crmHomeCamera?.isTransitioning?.();
        probe.deltas.push(delta);
        // A destination may do first-use work behind the already-stationary,
        // opaque endpoint lid. Measure camera cadence only between frames in
        // which the camera is actually moving; reveal stability is audited
        // separately after the coordinator completes.
        if (moving && previousMoving) probe.motionDeltas.push(delta);
        previousMoving = moving;
        previous = now;
        if (now - probe.startedAt < durationMs) requestAnimationFrame(tick);
        else {
          const measured = probe.motionDeltas.length > 10 ? probe.motionDeltas : probe.deltas;
          const sorted = [...measured].sort((a, b) => a - b);
          const measuredMs = measured.reduce((sum, value) => sum + value, 0);
          const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] || 0;
          probe.result = {
            label: probeLabel,
            durationMs: now - probe.startedAt,
            frames: measured.length,
            fps: measuredMs ? measured.length * 1000 / measuredMs : 0,
            p95Ms: percentile(.95),
            p99Ms: percentile(.99),
            maxMs: sorted.at(-1) || 0,
            over25Ms: measured.filter((value) => value > 25).length,
            over34Ms: measured.filter((value) => value > 34).length,
          };
          probe.done = true;
          resolve(probe.result);
        }
      };
      requestAnimationFrame(tick);
    });
    window.__crmMotionProbes[probeLabel] = probe;
  }, { probeLabel: label, durationMs: duration });
}

async function finishMotionProbe(page, label) {
  return page.evaluate((probeLabel) => window.__crmMotionProbes?.[probeLabel]?.promise, label);
}

async function startEndpointProbe(page, label, room, direction) {
  await page.evaluate(({ probeLabel, config, motionDirection }) => {
    window.__crmEndpointProbes ||= {};
    const probe = { label: probeLabel, direction: motionDirection, samples: [], settled: false, tailFrames: 3 };
    probe.promise = new Promise((resolve) => {
      const theaterName = config.theater;
      const objectSelector = [
        '.crm-overview-project', '.crm-overview-ticket', '.crm-overview-update',
        '.crm-planner-bucket', '.crm-planner-card', '.crm-assignment-bucket',
        '.tk-zone', '.tk-card', '.tk-zcard', '.tk-deck',
      ].join(',');
      const rect = (node) => {
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return [value.x, value.y, value.width, value.height].map((number) => Number(number.toFixed(3)));
      };
      const signature = (nodes) => JSON.stringify(nodes.slice(0, 80).map((node) => [
        node.dataset.id || node.dataset.recordId || node.dataset.stage || node.dataset.assignmentCommitment || node.className,
        rect(node), getComputedStyle(node).transform, getComputedStyle(node).opacity,
      ]));
      const onSettled = (event) => {
        if ((event.detail?.key || '') !== (motionDirection === 'in' ? config.key : 'home')) return;
        probe.settled = true;
        document.removeEventListener('crm:desk-transit-settled', onSettled);
      };
      document.addEventListener('crm:desk-transit-settled', onSettled);
      const startedAt = performance.now();
      const capture = () => {
        const surface = window.crmHomeCamera?.surface?.();
        const root = window.crmHomeCamera?.layers?.()[0];
        const moving = !!window.crmHomeCamera?.isTransitioning?.();
        const materializing = document.documentElement.classList.contains('crm-transit-materializing');
        const homeHandoff = !!surface?.classList.contains('crm-home-camera-handoff');
        const sampleAlignment = moving && probe.samples.length % 2 === 0;
        const target = sampleAlignment ? root?.querySelector?.(`.crm-home-bucket[data-module="${config.key}"]`) : null;
        const expander = sampleAlignment ? surface?.querySelector?.('.crm-home-expander:not(.crm-home-warm)') : null;
        const targetRect = sampleAlignment ? rect(target) : null; const expanderRect = sampleAlignment ? rect(expander) : null;
        const theater = materializing && document.body.dataset.crmModule === config.key
          ? [...document.querySelectorAll(`[data-crm-theater="${theaterName}"]`)].find((node) => !node.hidden) : null;
        const objects = theater ? [theater, ...theater.querySelectorAll(objectSelector)].filter((node) => {
          const bounds = node.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0;
        }) : [];
        const homeNodes = homeHandoff && root ? [root.querySelector('.crm-home-grid'), ...root.querySelectorAll('.crm-home-grid > .crm-home-bucket, .crm-home-priority-hand, .crm-home-hand-card')].filter(Boolean) : [];
        const snapshot = root?.querySelector?.(':scope > .crm-home-motion-snapshot');
        const homeBucket = homeHandoff ? root?.querySelector?.('.crm-home-grid > .crm-home-bucket') : null;
        const veil = document.querySelector('.crm-transit-veil');
        const alignment = targetRect && expanderRect ? Math.max(...targetRect.map((value, index) => Math.abs(value - expanderRect[index]))) : null;
        probe.samples.push({
          at: performance.now() - startedAt,
          module: document.body.dataset.crmModule || '', busy: !!window.crmDeskTransit?.isBusy?.(),
          moving, alignment, materializing,
          veil: !!veil, veilReleasing: !!veil?.classList.contains('is-releasing'), veilOpacity: veil ? Number(getComputedStyle(veil).opacity) : null,
          homeHandoff,
          homeReleasing: !!surface?.classList.contains('crm-home-camera-releasing'),
          snapshotDisplay: snapshot ? getComputedStyle(snapshot).display : '', snapshotOpacity: snapshot ? Number(getComputedStyle(snapshot).opacity) : null,
          roomSignature: objects.length ? signature(objects) : '', roomObjects: objects.length,
          homeSignature: homeNodes.length ? signature(homeNodes) : '',
          homeShadow: homeBucket ? getComputedStyle(homeBucket).boxShadow : '',
        });
        if (probe.settled) probe.tailFrames -= 1;
        if ((probe.settled && probe.tailFrames <= 0) || performance.now() - startedAt > 1800) {
          document.removeEventListener('crm:desk-transit-settled', onSettled);
          const endpoint = motionDirection === 'in'
            ? probe.samples.filter((sample) => sample.veilReleasing && sample.module === config.key && sample.roomSignature)
            : probe.samples.filter((sample) => sample.homeHandoff && sample.homeSignature);
          const aligned = probe.samples.filter((sample) => sample.moving && Number.isFinite(sample.alignment)).map((sample) => sample.alignment);
          const result = {
            label: probeLabel,
            sawVeilRelease: probe.samples.some((sample) => sample.veilReleasing && sample.veilOpacity < .999 && sample.veilOpacity > 0),
            sawHomeRelease: probe.samples.some((sample) => sample.homeReleasing && sample.snapshotDisplay !== 'none' && sample.snapshotOpacity < .999 && sample.snapshotOpacity > 0),
            endpointFrames: endpoint.length,
            endpointSignatures: new Set(endpoint.map((sample) => motionDirection === 'in' ? sample.roomSignature : sample.homeSignature)).size,
            endpointShadowsReady: motionDirection === 'in' || endpoint.every((sample) => sample.homeShadow && sample.homeShadow !== 'none'),
            endpointShadowSignatures: motionDirection === 'in' ? 0 : new Set(endpoint.map((sample) => sample.homeShadow)).size,
            minAlignmentError: aligned.length ? Math.min(...aligned) : Infinity,
            final: probe.samples.at(-1),
          };
          resolve(result);
          return;
        }
        requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    });
    window.__crmEndpointProbes[probeLabel] = probe;
  }, { probeLabel: label, config: room, motionDirection: direction });
}

async function finishEndpointProbe(page, label) {
  return page.evaluate((probeLabel) => window.__crmEndpointProbes?.[probeLabel]?.promise, label);
}

async function sampleLayoutStability(page, rootSelector, frames = 12) {
  return page.evaluate(({ selector, frameCount }) => new Promise((resolve) => {
    const signatures = [];
    const changedFrames = [];
    const nodeSelector = [
      '.crm-overview-project', '.crm-overview-ticket', '.crm-overview-update', '.crm-planner-bucket', '.crm-planner-card',
      '.tk-zone', '.tk-card', '.tk-zcard', '.tk-deck', '.crm-assignment-bucket', '.crm-home-grid', '.crm-home-bucket',
      '.crm-home-priority-hand', '.crm-home-hand-card',
    ].join(',');
    const capture = () => {
      const root = document.querySelector(selector);
      const nodes = root ? [root, ...root.querySelectorAll(nodeSelector)].slice(0, 120) : [];
      const geometry = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return [
          node.getAttribute('data-id') || node.getAttribute('data-priority-id')
            || node.getAttribute('data-module') || node.getAttribute('data-stage') || node.className,
          rect.x.toFixed(2), rect.y.toFixed(2), rect.width.toFixed(2), rect.height.toFixed(2),
          style.transform, style.opacity,
        ];
      });
      const signature = JSON.stringify({
        module: document.body.dataset.crmModule || '',
        nodes: nodes.length,
        scroll: root ? [root.scrollWidth, root.scrollHeight, root.scrollTop, root.scrollLeft] : [],
        geometry,
        previews: window.crmHome?.previewStatus?.().map(({ key, capturedAt }) => [key, capturedAt]) || [],
      });
      const index = signatures.length;
      if (index && signature !== signatures[index - 1]) changedFrames.push(index);
      signatures.push(signature);
      if (signatures.length >= frameCount) {
        resolve({ frames: signatures.length, uniqueSignatures: new Set(signatures).size, changedFrames });
      } else requestAnimationFrame(capture);
    };
    // Discard two boundary frames after the coordinator reports done. The
    // following twelve frames must be bit-for-bit identical in geometry.
    requestAnimationFrame(() => requestAnimationFrame(capture));
  }), { selector: rootSelector, frameCount: frames });
}

function assertMotion(label, probe) {
  if (!probe || probe.fps < MOTION_TARGET.minFps || probe.p95Ms > MOTION_TARGET.maxP95Ms
    || probe.maxMs > MOTION_TARGET.maxFrameMs || probe.over34Ms > MOTION_TARGET.maxOver34Ms) {
    throw new Error(`${label} missed motion budget ${JSON.stringify({ target: MOTION_TARGET, probe })}`);
  }
}

function imageDifference(exactBuffer, liveBuffer, region) {
  const exact = PNG.sync.read(exactBuffer); const live = PNG.sync.read(liveBuffer);
  if (exact.width !== live.width || exact.height !== live.height) return Infinity;
  let sum = 0, count = 0;
  for (let y = region.top; y < region.bottom; y += 2) for (let x = region.left; x < region.right; x += 2) {
    const index = (y * exact.width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) { sum += Math.abs(exact.data[index + channel] - live.data[index + channel]); count += 1; }
  }
  return count ? sum / count : Infinity;
}

async function main() {
  const out = path.join(__dirname, 'electron-actual');
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const { apiUrl } = await start();
  const app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..', '..'), env: { ...process.env, CRM_API_URL: apiUrl, CRM_API_PORT: '3899' }, timeout: 30000 });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('load');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout: 30000 });
  await page.evaluate(() => window.crmWorkspaces.setActive('home'));
  try { await page.waitForFunction(readyHome, null, { timeout: 60000 }); }
  catch (error) {
    const bootState = await page.evaluate(async () => ({
      module: document.body.dataset.crmModule,
      hidden: document.querySelector('.crm-home-surface')?.hidden,
      buckets: document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length,
      hosts: [...document.querySelectorAll('.crm-home-grid .crm-home-preview')].map((host) => ({
        key: host.dataset.previewKey, children: host.children.length, state: host.dataset.previewState,
        images: [...host.querySelectorAll('img')].map((image) => ({ complete: image.complete, width: image.naturalWidth, src: image.src.slice(0, 40) })),
      })),
      previewStatus: window.crmHome?.previewStatus?.().map(({ key, state, version }) => ({ key, state, version })),
      motionStatus: window.crmHome?.motionStatus?.(),
      currentMotionSignature: window.crmHome?.motionLayoutSignature?.(),
      motionIpc: ((value) => value ? { ok:value.ok, error:value.error, snapshot:value.snapshot&&{ version:value.snapshot.version, capturedAt:value.snapshot.capturedAt, layoutSignature:value.snapshot.layoutSignature } } : null)(await window.crmHomePreviews?.motionSnapshot?.()),
    }));
    throw new Error(`Home readiness timed out: ${JSON.stringify({ bootState, errors, cause: error.message })}`);
  }
  await sleep(150);

  const startup = await page.evaluate(() => ({
    buckets: [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')].map((bucket) => {
      const host = bucket.querySelector('.crm-home-preview'); const image = host.querySelector(':scope > img');
      const style = getComputedStyle(bucket);
      return { key: bucket.dataset.module, version: host.dataset.previewVersion, children: host.children.length, tag: image?.tagName, width: image?.naturalWidth, height: image?.naturalHeight,
        variant: image?.dataset.previewVariant, previewFilter: getComputedStyle(image).filter, titleOpacity: Number(getComputedStyle(bucket.querySelector('.crm-home-title-glass')).opacity),
        titleSize: getComputedStyle(bucket.querySelector('.crm-home-title')).fontSize,
        shift: getComputedStyle(host).getPropertyValue('--far-shift-y').trim(), liveTrees: host.querySelectorAll('.crm-home-lod-scene,.crm-home-lod-root,[data-crm-theater]').length,
        glass: { backdrop: style.webkitBackdropFilter || style.backdropFilter, background: style.backgroundImage } };
    }),
    controls: document.querySelectorAll('.window-control-cluster .window-glass-control').length,
    homeLayers: {
      levels: document.querySelectorAll('.crm-home-surface > .crm-home-level').length,
      hands: document.querySelectorAll('.crm-home-level > .crm-home-priority-hand').length,
      cards: document.querySelectorAll('.crm-home-level > .crm-home-priority-hand > .crm-home-hand-card').length,
      uniqueCards: new Set([...document.querySelectorAll('.crm-home-level > .crm-home-priority-hand > .crm-home-hand-card')].map((card) => card.dataset.priorityId)).size,
      snapshots: document.querySelectorAll('.crm-home-level > .crm-home-motion-snapshot').length,
      snapshotDisplay: getComputedStyle(document.querySelector('.crm-home-level > .crm-home-motion-snapshot')).display,
    },
    drag: (() => { const node = document.querySelector('.app-window-drag-region'); const style = getComputedStyle(node); return { region: style.webkitAppRegion, top: document.elementsFromPoint(520,20)[0] === node }; })(),
  }));
  if (startup.buckets.length !== 6 || startup.buckets.some((item) => item.version !== HOME_PREVIEW_VERSION || item.children !== 1 || item.tag !== 'IMG' || item.width < 880 || item.height < 600 || item.liveTrees)) {
    throw new Error(`Home is not six inert native captures: ${JSON.stringify(startup)}`);
  }
  if (startup.buckets.some((item) => item.variant !== 'filtered' || !item.previewFilter.includes(HOME_PREVIEW_REST_FILTER) || item.titleOpacity < .9 || item.titleSize !== '15px')) {
    throw new Error(`Home tiles do not rest with filtered previews and emphasized titles: ${JSON.stringify(startup.buckets)}`);
  }
  if (startup.homeLayers.levels !== 1 || startup.homeLayers.hands !== 1
    || startup.homeLayers.cards !== startup.homeLayers.uniqueCards || startup.homeLayers.snapshots !== 1 || startup.homeLayers.snapshotDisplay !== 'none') {
    throw new Error(`Home resting layers duplicate or occlude live content: ${JSON.stringify(startup.homeLayers)}`);
  }
  if (startup.buckets.some((item) => !item.glass.backdrop.includes('blur(26px)')
    || !item.glass.background.includes('rgba(22, 26, 36, 0.62)')
    || !item.glass.background.includes('rgba(12, 16, 24, 0.55)'))) {
    throw new Error(`Home tiles do not use the exact account/background menu glass: ${JSON.stringify(startup.buckets)}`);
  }
  if (startup.controls < 3 || startup.drag.region !== 'drag' || !startup.drag.top) throw new Error(`Original window chrome contract changed: ${JSON.stringify(startup)}`);
  const hoverTile = page.locator('.crm-home-grid > .crm-home-bucket').first();
  await hoverTile.hover();
  await page.waitForFunction(() => {
    const bucket = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const image = bucket?.querySelector('.crm-home-preview-foreground');
    const title = bucket?.querySelector('.crm-home-title-glass');
    const titleOpacity = Number(getComputedStyle(title).opacity);
    return image?.complete && getComputedStyle(image).filter.includes('blur(0px)')
      && titleOpacity >= .23 && titleOpacity < .33;
  });
  const hoveredTileState = await hoverTile.evaluate((bucket) => ({
    images: bucket.querySelectorAll('.crm-home-preview > img').length,
    titleOpacity: Number(getComputedStyle(bucket.querySelector('.crm-home-title-glass')).opacity),
    previewFilter: getComputedStyle(bucket.querySelector('.crm-home-preview-foreground')).filter,
  }));
  if (hoveredTileState.images !== 1 || !hoveredTileState.previewFilter.includes('blur(0px)') || hoveredTileState.titleOpacity < .23 || hoveredTileState.titleOpacity >= .33) {
    throw new Error(`Home tile hover reveal is broken: ${JSON.stringify(hoveredTileState)}`);
  }
  await page.mouse.move(2, 2);
  await page.waitForFunction((restFilter) => {
    const bucket = document.querySelector('.crm-home-grid > .crm-home-bucket');
    return bucket?.querySelectorAll('.crm-home-preview > img').length === 1
      && getComputedStyle(bucket.querySelector('.crm-home-preview-foreground')).filter.includes(restFilter)
      && Number(getComputedStyle(bucket.querySelector('.crm-home-title-glass')).opacity) > .9;
  }, HOME_PREVIEW_REST_FILTER);
  let nativeDrag;
  if (process.env.CRM_ALLOW_SYNTHETIC_DRAG_MISS === '1') {
    nativeDrag = { dx: 0, dy: 0, syntheticMissAllowed: true, skipped: true };
  } else {
    const dragStart = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.getPosition());
    await page.mouse.move(520, 20); await page.mouse.down(); await page.mouse.move(640, 90, { steps: 12 }); await page.mouse.up(); await sleep(200);
    const dragEnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.getPosition());
    nativeDrag = { dx: dragEnd[0] - dragStart[0], dy: dragEnd[1] - dragStart[1] };
    if (Math.abs(nativeDrag.dx) < 60 || Math.abs(nativeDrag.dy) < 30) throw new Error(`Native window drag did not move BrowserWindow: ${JSON.stringify({ dragStart, dragEnd, nativeDrag })}`);
    nativeDrag.syntheticMissAllowed = false;
    await app.evaluate(({ BrowserWindow }, position) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.setPosition(position[0], position[1]), dragStart);
  }
  const sameNodes = await page.evaluate(() => { const selector='.crm-home-grid > .crm-home-bucket .crm-home-preview > .crm-home-preview-foreground'; const before=[...document.querySelectorAll(selector)]; for(let i=0;i<20;i+=1)window.crmHome.refresh(); const after=[...document.querySelectorAll(selector)]; return before.length===6&&after.length===6&&before.every((node,index)=>node===after[index]); });
  if (!sameNodes) throw new Error('Home refresh recreated screenshot objects');
  const homeComposition = await page.evaluate(() => {
    const grid = document.querySelector('.crm-home-grid');
    const bucket = grid?.querySelector(':scope > .crm-home-bucket');
    return { gridContain: getComputedStyle(grid).contain, bucketShadow: getComputedStyle(bucket).boxShadow };
  });
  if (homeComposition.gridContain.includes('paint') || /42px/.test(homeComposition.bucketShadow)) {
    throw new Error(`Home shadows are still clipped or merged by the floating-menu shadow: ${JSON.stringify(homeComposition)}`);
  }
  await page.evaluate(() => {
    const style = document.createElement('style'); style.id = 'crm-home-continuity-probe';
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}.window-control-cluster,.auth-profile-cluster,.workspace-menu-overlay-layer,.dashboard-search-popover,.crm-module-switch,.db-loading,.crm-home-title-glass{display:none!important}';
    document.head.appendChild(style);
  });
  await sleep(40);
  const liveHomeComposite = await page.screenshot();
  const motionSnapshotResult = await page.evaluate(() => window.crmHomePreviews?.motionSnapshot?.());
  await page.evaluate(() => document.getElementById('crm-home-continuity-probe')?.remove());
  const motionSnapshotBuffer = Buffer.from(motionSnapshotResult?.snapshot?.src?.split(',')[1] || '', 'base64');
  const homeCompositeMae = imageDifference(motionSnapshotBuffer, liveHomeComposite, { left:0, right:1280, top:0, bottom:860 });
  if (!Number.isFinite(homeCompositeMae) || homeCompositeMae > 3) {
    throw new Error(`Home transition raster diverges from the resting shadow/blur composition: ${homeCompositeMae}`);
  }
  const homeFps = await frameRate(page); if (homeFps < 45) throw new Error(`Home FPS ${homeFps}`);
  await page.screenshot({ path: path.join(out, '01-home.png') });

  const instantControls = await page.evaluate(() => {
    const measure = (activate, reacted) => {
      const started = performance.now(); activate();
      return { elapsedMs: performance.now() - started, reacted: !!reacted() };
    };
    const background = document.querySelector('.background-tone-menu');
    background.open = false;
    const backgroundMenu = measure(() => background.querySelector('summary').click(), () => background.open);
    background.open = false;
    const profile = document.querySelector('.auth-profile-cluster');
    profile?.classList.remove('open');
    const accountMenu = measure(() => profile?.querySelector('.auth-profile-button')?.click(), () => profile?.classList.contains('open'));
    profile?.classList.remove('open');
    window.crmSearchDeck?.close?.();
    const search = measure(() => document.querySelector('.control-bar-search')?.click(), () => window.crmSearchDeck?.isOpen?.());
    window.crmSearchDeck?.close?.();
    return { backgroundMenu, accountMenu, search };
  });
  if (Object.values(instantControls).some((control) => !control.reacted || control.elapsedMs > 32)) {
    throw new Error(`A top-level control did not react in the originating frame: ${JSON.stringify(instantControls)}`);
  }

  const domainProbe = await page.evaluate(async () => { try { await window.crmDomain.list('commitments', { limit:1 }); return true; } catch { return false; } });
  if (!domainProbe) throw new Error('domain:list is not handled');

  for (let index=0; index<2; index+=1) {
    await page.reload({ waitUntil:'load' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction(readyHome, null, { timeout:30000 });
    const chrome = await page.evaluate(() => { const drag=document.querySelector('.app-window-drag-region'); return { drag:getComputedStyle(drag).webkitAppRegion, top:document.elementsFromPoint(520,20)[0]===drag, controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length }; });
    if (chrome.drag !== 'drag' || !chrome.top || chrome.controls < 3) throw new Error(`Chrome stale after reload ${index+1}: ${JSON.stringify(chrome)}`);
  }

  const rooms = [
    {key:'desk',theater:'desk',content:'.crm-overview-project',expected:0}, {key:'people',theater:'people',content:'.tk-zone',expected:8},
    {key:'cases',theater:'tickets',content:'.tk-zone',expected:3}, {key:'money',theater:'money-room',content:'[data-crm-subtheater="money"]:not([hidden]) .tk-zone',expected:3},
    {key:'planner',theater:'planner',content:'.crm-planner-bucket',expected:0}, {key:'assignments',theater:'assignments',content:'.crm-assignment-bucket',expected:4},
  ];
  const transitions=[];
  for (const room of rooms) {
    const before = await page.evaluate((key)=>window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0,room.key);
    const selector=`.crm-home-grid > .crm-home-bucket[data-module="${room.key}"]`;
    await page.hover(selector); await sleep(160);
    await page.evaluate(() => { const p=window.__fps={start:performance.now(),frames:0,fps:0}; const tick=(now)=>{p.frames+=1;if(now-p.start<1100)requestAnimationFrame(tick);else p.fps=p.frames*1000/(now-p.start)};requestAnimationFrame(tick); });
    await startMotionProbe(page, `in-${room.key}`);
    await startEndpointProbe(page, `in-${room.key}`, room, 'in');
    const inboundReaction=await page.$eval(selector,(bucket)=>new Promise((resolve)=>{const source=bucket.getBoundingClientRect();const started=performance.now();bucket.click();const immediate={elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),transitioning:window.crmHomeCamera?.isTransitioning?.()};const samples=[];const tick=()=>{const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const rect=expander?.getBoundingClientRect();samples.push({width:rect?.width||0,height:rect?.height||0,duration:expander?getComputedStyle(expander).transitionDuration:''});if(samples.length<7&&window.crmHomeCamera?.isTransitioning?.())requestAnimationFrame(tick);else resolve({...immediate,sourceWidth:source.width,sourceHeight:source.height,samples})};requestAnimationFrame(tick)}));
    const animatedSamples=inboundReaction.samples.filter((sample)=>sample.width>0);
    const uniqueWidths=new Set(animatedSamples.map((sample)=>sample.width.toFixed(1))).size;
    if(!inboundReaction.busy||!inboundReaction.transitioning||inboundReaction.elapsedMs>50||animatedSamples.length<3||uniqueWidths<3||animatedSamples.at(-1).width<=inboundReaction.sourceWidth+20||!animatedSamples.some((sample)=>sample.duration.includes('0.46s')))throw new Error(`${room.key} click did not visibly animate from its tile: ${JSON.stringify(inboundReaction)}`);
    await sleep(30);
    const mid=await page.evaluate(()=>{const e=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const r=e?.getBoundingClientRect();const root=window.crmHomeCamera?.layers?.()[0];const surface=window.crmHomeCamera?.surface?.();const drag=document.querySelector('.app-window-drag-region');const titles=[...(root?.querySelectorAll('.crm-home-title-glass')||[])];const grid=root?.querySelector(':scope>.crm-home-grid');const hand=root?.querySelector(':scope>.crm-home-priority-hand');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const status=window.crmHome?.motionStatus?.();return{module:document.body.dataset.crmModule,transitioning:window.crmHomeCamera?.isTransitioning?.(),images:e?.querySelectorAll('img').length||0,rect:r?{width:r.width,height:r.height}:null,neighborOpacity:root?Number(getComputedStyle(root).opacity):0,titlesHidden:surface?.classList.contains('crm-home-camera-expanding')&&titles.length>0&&titles.every((title)=>getComputedStyle(title).visibility==='hidden'),motionComposite:!!snapshot&&getComputedStyle(snapshot).display!=='none'&&getComputedStyle(grid).visibility==='visible'&&getComputedStyle(grid.querySelector('.crm-home-preview')).visibility==='hidden'&&getComputedStyle(hand).visibility==='hidden',signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),rootComposited:root?getComputedStyle(root).willChange.includes('transform'):false,dragTop:document.elementsFromPoint(520,20)[0]===drag,controlsTop:[...document.querySelectorAll('.window-control-cluster .window-glass-control')].every((n)=>{const b=n.getBoundingClientRect(),h=document.elementsFromPoint(b.left+b.width/2,b.top+b.height/2)[0];return h===n||n.contains(h)})}});
    const inFlight=mid.module==='home'&&mid.transitioning&&mid.images===1&&mid.rect&&mid.rect.width>=300;
    const alreadyLanded=mid.module===room.key&&!mid.transitioning;
    if((!inFlight&&!alreadyLanded)||(inFlight&&(mid.neighborOpacity<.99||!mid.titlesHidden||!mid.motionComposite||!mid.signatureMatches||!mid.rootComposited))||!mid.dragTop||!mid.controlsTop)throw new Error(`${room.key} camera mid-state broken: ${JSON.stringify(mid)}`);
    await page.screenshot({path:path.join(out,`transition-${room.key}.png`)});
    await page.waitForFunction((key)=>document.body.dataset.crmModule===key&&!window.crmDeskTransit?.isBusy?.()&&!document.querySelector('.crm-transit-veil'),room.key,{timeout:15000});
    const inboundEndpoint=await finishEndpointProbe(page,`in-${room.key}`);
    if(!inboundEndpoint.sawVeilRelease||inboundEndpoint.endpointFrames<3||inboundEndpoint.endpointSignatures!==1||inboundEndpoint.minAlignmentError>1.25||inboundEndpoint.final.materializing||inboundEndpoint.final.veil)throw new Error(`${room.key} inbound endpoint handoff is discontinuous: ${JSON.stringify(inboundEndpoint)}`);
    await page.mouse.move(1,1); await sleep(80);
    const inboundStability=await sampleLayoutStability(page,`[data-crm-theater="${room.theater}"]:not([hidden])`);
    if(inboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after inbound transition: ${JSON.stringify(inboundStability)}`);
    const state=await page.evaluate(async(config)=>{
      const theater=document.querySelector(`[data-crm-theater="${config.theater}"]`);
      const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===config.key);
      const signature={module:document.body.dataset.crmModule||'',text:String(theater?.innerText||'').replace(/\s+/g,' ').trim(),elements:theater?.querySelectorAll('*').length||0,calendarYear:window.fractalCalendar?.year?.()||null};
      const bucketGeometry=[...(theater?.querySelectorAll('.tk-zone')||[])].map((bucket)=>{const rect=bucket.getBoundingClientRect();return{width:rect.width,height:rect.height,ratio:rect.height?rect.width/rect.height:0}}).filter((bucket)=>bucket.width>0&&bucket.height>0);
      const bucketHeaders=[...(theater?.querySelectorAll('.tk-zone')||[])].filter((bucket)=>bucket.getBoundingClientRect().width>0).map((bucket)=>{const title=bucket.querySelector('.tk-zone-title');const bars=bucket.querySelector('.tk-zone-hd-r');const bucketRect=bucket.getBoundingClientRect();const barsRect=bars?.getBoundingClientRect();return{title:title?.textContent.trim()||'',whiteSpace:title?getComputedStyle(title).whiteSpace:'',singleLine:!!title&&title.scrollHeight<=title.clientHeight+1,count:bucket.querySelectorAll('.tk-zone-count').length,barsPosition:bars?getComputedStyle(bars).position:'',barsRight:barsRect?Math.round(bucketRect.right-barsRect.right):null}});
      return{visible:!!theater&&!theater.hidden,count:theater?.querySelectorAll(config.content).length||0,arrows:theater?.querySelectorAll('svg.tk-flow,.tk-flow-shaft,.tk-flow-head').length||0,bucketGeometry,bucketHeaders,signature,previewSignature:preview?.layoutSignature||null,exactSrc:preview?.exactSrc||'',veil:document.querySelectorAll('.crm-transit-veil').length,invalid:[...(theater?.querySelectorAll('*')||[])].filter((n)=>/NaN|Infinity/.test(getComputedStyle(n).transform)).length};
    },room);
    const liveBuffer=await page.screenshot({path:path.join(out,`room-${room.key}.png`)});
    const exactBuffer=Buffer.from(state.exactSrc.split(',')[1]||'','base64');
    const pixelMae=imageDifference(exactBuffer,liveBuffer,{left:50,right:1230,top:105,bottom:755});
    const probe={settled:await page.evaluate(()=>window.__fps),transition:await finishMotionProbe(page,`in-${room.key}`)};
    assertMotion(`${room.key} inbound`,probe.transition);
    const badBucket=room.key!=='planner'&&state.bucketGeometry.some((bucket)=>bucket.width<180||bucket.width>270||bucket.height<300||bucket.height>410||bucket.ratio<.55||bucket.ratio>.85);
    const badHeader=state.bucketHeaders.some((header)=>!header.title||header.whiteSpace!=='nowrap'||!header.singleLine||header.count||header.barsPosition!=='absolute'||header.barsRight<8||header.barsRight>60);
    if(!state.visible||state.count!==room.expected||state.arrows||badBucket||badHeader||state.veil||state.invalid||JSON.stringify(state.signature)!==JSON.stringify(state.previewSignature)||pixelMae>12||probe.settled.fps<40||probe.transition.fps<45)throw new Error(`${room.key} capture/live mismatch: ${JSON.stringify({state:{...state,exactSrc:undefined},pixelMae,probe})}`);
    await startMotionProbe(page,`out-${room.key}`);
    await startEndpointProbe(page,`out-${room.key}`,room,'out');
    const outboundReaction=await page.evaluate(()=>{const started=performance.now();window.__homeDrive=window.crmDeskTransit.driveTo('home');return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),level:window.crmHomeCamera?.level?.(),module:document.body.dataset.crmModule}});
    if(!outboundReaction.busy||outboundReaction.level!==1||outboundReaction.module!=='home'||outboundReaction.elapsedMs>50)throw new Error(`${room.key} Home click did not start its camera move immediately: ${JSON.stringify(outboundReaction)}`);
    await sleep(100);
    const outboundMid=await page.evaluate(()=>{const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const grid=root?.querySelector(':scope>.crm-home-grid');const hand=root?.querySelector(':scope>.crm-home-priority-hand');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const status=window.crmHome?.motionStatus?.();return{moving:window.crmHomeCamera?.isTransitioning?.(),motionComposite:!!snapshot&&getComputedStyle(snapshot).display!=='none'&&getComputedStyle(grid).visibility==='visible'&&getComputedStyle(grid.querySelector('.crm-home-preview')).visibility==='hidden'&&getComputedStyle(hand).visibility==='hidden',signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),expanderAbove:!!expander&&!!root&&Number(getComputedStyle(expander).zIndex)>Number(getComputedStyle(root).zIndex),titlesVisible:[...(root?.querySelectorAll('.crm-home-title-glass')||[])].every((title)=>getComputedStyle(title).visibility==='visible'),contracting:surface?.classList.contains('crm-home-camera-contracting')}});
    if(!outboundMid.moving||!outboundMid.motionComposite||!outboundMid.signatureMatches||!outboundMid.expanderAbove||!outboundMid.titlesVisible||!outboundMid.contracting)throw new Error(`${room.key} return composition diverged from resting Home: ${JSON.stringify(outboundMid)}`);
    await page.evaluate(()=>window.__homeDrive); await page.waitForFunction(readyHome,null,{timeout:15000});
    const outboundEndpoint=await finishEndpointProbe(page,`out-${room.key}`);
    if(!outboundEndpoint.sawHomeRelease||outboundEndpoint.endpointFrames<3||outboundEndpoint.endpointSignatures!==1||!outboundEndpoint.endpointShadowsReady||outboundEndpoint.endpointShadowSignatures!==1||outboundEndpoint.minAlignmentError>1.25||outboundEndpoint.final.homeHandoff||outboundEndpoint.final.homeReleasing||outboundEndpoint.final.snapshotDisplay!=='none')throw new Error(`${room.key} Home endpoint handoff is discontinuous: ${JSON.stringify(outboundEndpoint)}`);
    const outbound=await finishMotionProbe(page,`out-${room.key}`);
    assertMotion(`${room.key} outbound`,outbound);
    const outboundStability=await sampleLayoutStability(page,'.crm-home-surface:not([hidden])');
    const after=await page.evaluate((key)=>window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0,room.key);
    if(outboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after returning Home: ${JSON.stringify(outboundStability)}`);
    if(after!==before)throw new Error(`${room.key} preview was replaced after returning Home: ${JSON.stringify({before,after})}`);
    transitions.push({key:room.key,mid,outboundMid,pixelMae,fps:probe.settled.fps,inbound:probe.transition,outbound,inboundEndpoint,outboundEndpoint,inboundStability,outboundStability,inboundReaction,outboundReaction,signatureMatches:true,previewPreserved:after===before});
  }
  const transitTimings=await page.evaluate(()=>window.crmDeskTransit?.performanceTimings?.()||[]);
  const unsettled=transitTimings.filter((item)=>item.settled===false);
  if(unsettled.length)throw new Error(`Destinations were revealed before stable geometry: ${JSON.stringify(unsettled)}`);
  await page.evaluate(()=>window.crmWorkspaces.setActive('money'));
  await page.waitForFunction(()=>document.querySelectorAll('[data-crm-theater="money-room"] .crm-money-view').length===2&&document.querySelectorAll('[data-crm-theater="money-room"] [data-crm-subtheater="money"]:not([hidden]) .tk-zone').length===3);
  const moneySelector=await page.evaluate(()=>{const root=document.querySelector('[data-crm-theater="money-room"]');const before=window.crmMoneyRoom?.selected?.();const buttons=[...root.querySelectorAll('.crm-money-view')];buttons.find((button)=>button.dataset.moneyView!==before)?.click();const after=window.crmMoneyRoom?.selected?.();const visible=[...root.querySelectorAll('[data-crm-subtheater="money"]')].filter((node)=>!node.hidden);return{buttons:buttons.length,before,after,selected:root.querySelectorAll('.crm-money-view.is-selected').length,visible:visible.map((node)=>node.dataset.crmTheater)}});
  if(moneySelector.buttons!==2||moneySelector.before===moneySelector.after||moneySelector.selected!==1||moneySelector.visible.length!==1)throw new Error(`Money selector is not a single compact Bills/Invoices switch: ${JSON.stringify(moneySelector)}`);
  await page.evaluate(()=>window.crmWorkspaces.setActive('people'));
  await page.waitForFunction(()=>!!document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]'),null,{timeout:10000});
  await page.$eval('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]',(card)=>{const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20,button:2}))});
  await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
  await page.waitForSelector('.crm-person-history-shell:not([hidden]) .crm-person-history',{timeout:10000});await sleep(250);
  const personHistory=await page.evaluate(()=>{const shell=document.querySelector('.crm-person-history-shell:not([hidden])');const panel=shell?.querySelector('.crm-person-history');const thread=panel?.querySelector('.crm-person-history-thread');const composer=panel?.querySelector('.crm-person-history-composer');const source=document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');const rect=panel?.getBoundingClientRect();const sourceRect=source?.getBoundingClientRect();const shellStyle=shell&&getComputedStyle(shell);const tint=getComputedStyle(document.querySelector('.crm-module-switch'),'::after');return{title:panel?.querySelector('.crm-person-history-title')?.textContent.trim(),events:panel?.querySelectorAll('.crm-person-history-event').length||0,filters:panel?.querySelectorAll('[data-history-filter]').length||0,composerHidden:composer?.hidden===true,canonical:panel?.classList.contains('crm-menu-surface')||false,compact:!!rect&&rect.width<=370&&rect.height<=540,inBounds:!!rect&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,adjacent:!!rect&&!!sourceRect&&(Math.abs(rect.left-sourceRect.right)<=12||Math.abs(sourceRect.left-rect.right)<=12),transparent:!!shellStyle&&shellStyle.backgroundColor==='rgba(0, 0, 0, 0)'&&['none',''].includes(shellStyle.backdropFilter),noLegacyChrome:!panel?.querySelector('.crm-person-history-body,.crm-person-history-sidebar,.crm-person-history-summary,.crm-person-history-filters'),noHorizontalOverflow:!!panel&&!!thread&&panel.scrollWidth<=panel.clientWidth+1&&thread.scrollWidth<=thread.clientWidth+1,canonicalActions:[...(panel?.querySelectorAll('button')||[])].every((button)=>button.classList.contains('crm-menu-action')),tinted:tint.backgroundImage.includes('rgba(13, 35, 72')&&tint.boxShadow!=='none'}});
  if(personHistory.title!=='Marta Reyes'||personHistory.events<6||personHistory.filters!==0||!personHistory.composerHidden||!personHistory.canonical||!personHistory.compact||!personHistory.inBounds||!personHistory.adjacent||!personHistory.transparent||!personHistory.noLegacyChrome||!personHistory.noHorizontalOverflow||!personHistory.canonicalActions||!personHistory.tinted)throw new Error(`Person history native layout broken: ${JSON.stringify(personHistory)}`);
  await page.screenshot({path:path.join(out,'person-history.png')});
  await page.click('[data-person-history-close]');
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:15000});
  const settledFps=await frameRate(page); if(settledFps<45)throw new Error(`Settled Home FPS ${settledFps}`);
  await sleep(100); const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter((win)=>!win.isDestroyed()).length); if(windows!==1)throw new Error(`${windows} BrowserWindows remain`);
  const finalChrome=await page.evaluate(()=>{const drag=document.querySelector('.app-window-drag-region');return{drag:getComputedStyle(drag).webkitAppRegion,top:document.elementsFromPoint(520,20)[0]===drag,controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length}});
  if(finalChrome.drag!=='drag'||!finalChrome.top||finalChrome.controls<3)throw new Error(`Chrome stale after camera cycles: ${JSON.stringify(finalChrome)}`);
  await page.click('.window-minimize-control'); await sleep(350);
  const minimized=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find((win)=>!win.isDestroyed())?.isMinimized()||false);
  if(!minimized)throw new Error('Minimize control did not minimize the window');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());win?.restore();win?.show()});await sleep(250);
  await page.click('.window-close-control');await sleep(250);
  const hidden=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());return!!win&&!win.isVisible()});
  if(!hidden)throw new Error('Close control did not hide the window');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());win?.show();win?.focus()});await sleep(250);
  await Promise.all([page.waitForEvent('load',{timeout:10000}),page.click('.window-refresh-control')]);
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dashboard-booting')&&window.crmWorkspaces,null,{timeout:30000});
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:30000});
  await page.screenshot({path:path.join(out,'02-home-after-cycles.png')});
  const evidence={startup,nativeDrag,sameNodes,homeComposition,homeCompositeMae,homeFps,settledFps,instantControls,domainProbe,transitions,transitTimings,personHistory,windows,finalChrome,windowControls:{refresh:true,minimized,hidden},errors};
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('[electron-playwright]',evidence);
  if(errors.length)throw new Error(errors.join(' | ')); await app.close(); process.exit(0);
}
main().catch((error)=>{console.error(error);process.exit(1)});
