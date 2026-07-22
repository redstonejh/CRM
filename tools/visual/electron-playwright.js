'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOTION_TARGET = { minFps: 95, maxP95Ms: 18, maxFrameMs: 50, maxOver34Ms: 1 };
const HOME_PREVIEW_VERSION = 'filtered-home-v44';
const HOME_PREVIEW_REST_FILTER = 'blur(1.8px)';
const readyHome = () => document.body.dataset.crmModule === 'home'
  && !document.querySelector('.crm-home-surface')?.hidden
  && document.querySelectorAll('.crm-home-grid > .crm-home-bucket').length === 4
  && window.crmHome?.handStatus?.().ready
  && window.crmHome?.motionStatus?.().ready
  && [...document.querySelectorAll('.crm-home-grid .crm-home-preview')].every((host) => {
    const image = host.querySelector(':scope > .crm-home-preview-foreground');
    return host.dataset.previewState === 'ready'
      && !!host.querySelector(':scope > .crm-home-preview-state[role="status"]')
      && image?.complete && image.naturalWidth > 0;
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
          // The audit deliberately takes one in-flight screenshot. Chromium can
          // spend a single frame copying that surface, so keep that stall under
          // the explicit max/over-34ms limits while measuring camera cadence
          // from the remaining animation frames.
          const cadence = measured.filter((value) => value <= 25);
          const cadenceMs = cadence.reduce((sum, value) => sum + value, 0);
          const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] || 0;
          probe.result = {
            label: probeLabel,
            durationMs: now - probe.startedAt,
            frames: measured.length,
            fps: measuredMs ? measured.length * 1000 / measuredMs : 0,
            cadenceFps: cadenceMs ? cadence.length * 1000 / cadenceMs : 0,
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
      const signature = (nodes, compositorRoots = []) => JSON.stringify(nodes.slice(0, 80).map((node) => {
        const style = getComputedStyle(node);
        return [node.dataset.id || node.dataset.recordId || node.dataset.stage || node.dataset.assignmentCommitment || node.className,
          rect(node), style.transform, compositorRoots.includes(node) ? 'compositor-crossfade' : style.opacity];
      }));
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
        const objects = theater ? [theater, ...theater.querySelectorAll(objectSelector)] : [];
        const roomLayers = theater ? [...theater.querySelectorAll('[data-crm-transit-layer]'), ...(theater.matches('[data-crm-transit-layer]') ? [theater] : [])] : [];
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
          roomRevealing: document.documentElement.classList.contains('crm-transit-revealing'), roomOpacity: roomLayers.length ? Math.max(...roomLayers.map((layer) => Number(getComputedStyle(layer).opacity))) : null,
          homeHandoff,
          homeReleasing: !!surface?.classList.contains('crm-home-camera-releasing'),
          snapshotDisplay: snapshot ? getComputedStyle(snapshot).display : '', snapshotOpacity: snapshot ? Number(getComputedStyle(snapshot).opacity) : null,
          roomSignature: objects.length ? signature(objects, roomLayers) : '', roomObjects: objects.length,
          homeSignature: homeNodes.length ? signature(homeNodes, [root?.querySelector('.crm-home-priority-hand'), ...root.querySelectorAll('.crm-home-grid > .crm-home-bucket')]) : '',
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
            sawRoomReveal: probe.samples.some((sample) => sample.roomRevealing && sample.roomOpacity > .001 && sample.roomOpacity < 1),
            sawHomeRelease: probe.samples.some((sample) => sample.homeReleasing && sample.snapshotDisplay !== 'none' && sample.snapshotOpacity < .999 && sample.snapshotOpacity > 0),
            endpointFrames: endpoint.length,
            endpointSignatures: new Set(endpoint.map((sample) => motionDirection === 'in' ? sample.roomSignature : sample.homeSignature)).size,
            endpointShadowsReady: motionDirection === 'in' || endpoint.every((sample) => sample.homeShadow && sample.homeShadow !== 'none'),
            endpointShadowSignatures: motionDirection === 'in' ? 0 : new Set(endpoint.map((sample) => sample.homeShadow)).size,
            minAlignmentError: aligned.length ? Math.min(...aligned) : Infinity,
            timeline: probe.samples.filter((sample, index, samples) => index === 0 || ['module','busy','moving','materializing','veil','veilReleasing','roomRevealing','homeHandoff','homeReleasing'].some((key) => sample[key] !== samples[index - 1][key])).map((sample) => ({ at:sample.at,module:sample.module,busy:sample.busy,moving:sample.moving,materializing:sample.materializing,veil:sample.veil,veilReleasing:sample.veilReleasing,roomRevealing:sample.roomRevealing,homeHandoff:sample.homeHandoff,homeReleasing:sample.homeReleasing })),
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
  if (!probe || probe.cadenceFps < MOTION_TARGET.minFps || probe.p95Ms > MOTION_TARGET.maxP95Ms
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

function imageAlphaStats(buffer) {
  const image = PNG.sync.read(buffer);
  let transparent = 0, partial = 0, opaque = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    const alpha = image.data[index];
    if (alpha <= 2) transparent += 1;
    else if (alpha >= 253) opaque += 1;
    else partial += 1;
  }
  const pixels = image.width * image.height;
  return { width:image.width, height:image.height, transparent, partial, opaque,
    transparentRatio:transparent / pixels, partialRatio:partial / pixels };
}

function imageRegionMaxAlpha(buffer, region, viewport) {
  const image = PNG.sync.read(buffer);
  const scaleX = image.width / Math.max(1, Number(viewport?.[0]) || image.width);
  const scaleY = image.height / Math.max(1, Number(viewport?.[1]) || image.height);
  const left = Math.max(0, Math.floor(region[0] * scaleX)); const top = Math.max(0, Math.floor(region[1] * scaleY));
  const right = Math.min(image.width, Math.ceil((region[0] + region[2]) * scaleX)); const bottom = Math.min(image.height, Math.ceil((region[1] + region[3]) * scaleY));
  let max = 0;
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) max = Math.max(max, image.data[(y * image.width + x) * 4 + 3]);
  return max;
}

async function main() {
  const out = path.join(__dirname, 'electron-actual');
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const { apiUrl } = await start();
  const requestedTicketCommitmentId = 'com_native_home_ticket_handoff';
  const due = new Date(); due.setDate(due.getDate() - 30);
  const fixtureResponse = await fetch(`${apiUrl}/api/domain/commitments`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({fields:{
      id:requestedTicketCommitmentId,title:'Reply on native Home ticket handoff',kind:'ticket-work',status:'open',priority:'critical',assignee:null,dueAt:due.toISOString(),
      links:[{entityType:'tickets',recordId:'tkt_bluepeak_mail',relation:'regarding'}],
    }}),
  });
  const fixture = await fixtureResponse.json();
  if (!fixtureResponse.ok || !fixture.ok) throw new Error(`Could not seed native Home ticket handoff: ${fixture.error || fixtureResponse.status}`);
  const nativeTicketCommitmentId = fixture.record?.id;
  if (!nativeTicketCommitmentId) throw new Error('Native Home ticket handoff fixture returned no record ID');
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
      const host = bucket.querySelector('.crm-home-preview'); const image = host.querySelector(':scope > .crm-home-preview-foreground');
      const title = document.querySelector(`.crm-home-title-layer > .crm-home-title-slot[data-module="${bucket.dataset.module}"] .crm-home-title`);
      const titleGlass = title?.closest('.crm-home-title-glass');
      const loader = host.querySelector(':scope > .crm-home-preview-state');
      const style = getComputedStyle(bucket);
      const titleStyle = title && getComputedStyle(title);
      const rect = bucket.getBoundingClientRect();
      return { key: bucket.dataset.module, version: host.dataset.previewVersion, images: host.querySelectorAll(':scope > img').length, tag: image?.tagName, width: image?.naturalWidth, height: image?.naturalHeight,
        renderedWidth:rect.width, renderedHeight:rect.height, aspectError:Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight),
        loader: { exists: !!loader, role: loader?.getAttribute('role'), hiddenAtReady: loader ? getComputedStyle(loader).visibility === 'hidden' : false },
        variant: image?.dataset.previewVariant, previewFilter: getComputedStyle(image).filter, titleOpacity: Number(getComputedStyle(titleGlass).opacity),
        titleSize: titleStyle?.fontSize, titleWeight: titleStyle?.fontWeight, titleFamily: titleStyle?.fontFamily, titleShadow: titleStyle?.textShadow,
        titleOutsideFilteredTile: !!title && !title.closest('.crm-home-bucket'),
        shift: getComputedStyle(host).getPropertyValue('--far-shift-y').trim(), liveTrees: host.querySelectorAll('.crm-home-lod-scene,.crm-home-lod-root,[data-crm-theater]').length,
        glass: { backdrop: style.webkitBackdropFilter || style.backdropFilter, background: style.backgroundImage } };
    }),
    controls: document.querySelectorAll('.window-control-cluster .window-glass-control').length,
    calendar: (() => {
      const node = document.querySelector('.crm-viewport-date');
      const style = node && getComputedStyle(node);
      return { exists:!!node, hidden:node?.hidden === true, display:style?.display || '' };
    })(),
    homeLayers: {
      levels: document.querySelectorAll('.crm-home-surface > .crm-home-level').length,
      hands: document.querySelectorAll('.crm-home-level > .crm-home-priority-hand').length,
      cards: document.querySelectorAll('.crm-home-level > .crm-home-priority-hand > .crm-home-hand-card').length,
      uniqueCards: new Set([...document.querySelectorAll('.crm-home-level > .crm-home-priority-hand > .crm-home-hand-card')].map((card) => card.dataset.priorityId)).size,
      titleLayers: document.querySelectorAll('.crm-home-level > .crm-home-title-layer').length,
      titles: document.querySelectorAll('.crm-home-level > .crm-home-title-layer .crm-home-title').length,
      rootWillChange: getComputedStyle(document.querySelector('.crm-home-level')).willChange,
      snapshots: document.querySelectorAll('.crm-home-level > .crm-home-motion-snapshot').length,
      motionVariants: document.querySelectorAll('.crm-home-level > .crm-home-motion-variant').length,
      snapshotDisplay: getComputedStyle(document.querySelector('.crm-home-level > .crm-home-motion-snapshot')).display,
      sceneBackdrops: document.querySelectorAll('.crm-home-scene-backdrop').length,
      workspaceBackdrops: document.querySelectorAll('body > .workspace-photo-backdrop:not([hidden])').length,
      backgroundMode: window.crmHome?.motionStatus?.().backgroundMode || '',
    },
    drag: (() => { const node = document.querySelector('.app-window-drag-region'); const style = getComputedStyle(node); return { region: style.webkitAppRegion, top: document.elementsFromPoint(520,20)[0] === node }; })(),
  }));
  if (startup.buckets.length !== 4 || startup.buckets.some((item) => item.version !== HOME_PREVIEW_VERSION || item.images !== 1 || item.tag !== 'IMG' || item.width < 880 || item.height < 600 || item.aspectError > .01 || item.liveTrees)) {
    throw new Error(`Home is not four inert native captures: ${JSON.stringify(startup)}`);
  }
  if (startup.buckets.some((item) => item.variant !== 'filtered' || !item.previewFilter.includes(HOME_PREVIEW_REST_FILTER)
    || !item.loader.exists || item.loader.role !== 'status' || !item.loader.hiddenAtReady
    || item.titleOpacity < .9 || item.titleSize !== '15px' || item.titleWeight !== '600'
    || !item.titleFamily.includes('Segoe UI Variable Text') || item.titleShadow.includes('12px') || !item.titleOutsideFilteredTile)) {
    throw new Error(`Home tiles do not rest with filtered previews and emphasized titles: ${JSON.stringify(startup.buckets)}`);
  }
  if (startup.homeLayers.levels !== 1 || startup.homeLayers.hands !== 1
    || startup.homeLayers.cards !== startup.homeLayers.uniqueCards || startup.homeLayers.titleLayers !== 1 || startup.homeLayers.titles !== 4
    || startup.homeLayers.rootWillChange !== 'auto' || startup.homeLayers.snapshots !== 1 || startup.homeLayers.motionVariants !== 4 || startup.homeLayers.snapshotDisplay !== 'none'
    || startup.homeLayers.sceneBackdrops !== 0 || startup.homeLayers.workspaceBackdrops !== 1 || startup.homeLayers.backgroundMode !== 'shared') {
    throw new Error(`Home resting layers duplicate or occlude live content: ${JSON.stringify(startup.homeLayers)}`);
  }
  if (!startup.calendar.exists || !startup.calendar.hidden || startup.calendar.display !== 'none') {
    throw new Error(`The global calendar control must not appear at Home: ${JSON.stringify(startup.calendar)}`);
  }
  await page.click('.crm-home-bucket[data-module="people"]');
  await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit?.isBusy?.() && window.crmDeskTransit?.canGoBack?.(), null, { timeout:15000 });
  await app.evaluate(({BrowserWindow}) => {
    const win=BrowserWindow.getAllWindows().find((item)=>item.isVisible()&&!item.isDestroyed());
    win?.emit('app-command',{preventDefault(){}},'browser-backward');
  });
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit?.isBusy?.() && window.crmDeskTransit?.canGoForward?.(), null, { timeout:15000 });
  const nativeBackState=await page.evaluate(()=>({module:document.body.dataset.crmModule,history:window.crmDeskTransit.historyState(),clusterHidden:document.querySelector('.crm-module-switch')?.hidden,forwardDisabled:document.querySelector('[data-crm-history-forward]')?.disabled}));
  await page.screenshot({path:path.join(out,'home-history.png')});
  await app.evaluate(({BrowserWindow}) => {
    const win=BrowserWindow.getAllWindows().find((item)=>item.isVisible()&&!item.isDestroyed());
    win?.emit('app-command',{preventDefault(){}},'browser-forward');
  });
  await page.waitForFunction(() => document.body.dataset.crmModule === 'people' && !window.crmDeskTransit?.isBusy?.() && !window.crmDeskTransit?.canGoForward?.(), null, { timeout:15000 });
  const nativeForwardState=await page.evaluate(()=>({module:document.body.dataset.crmModule,history:window.crmDeskTransit.historyState(),clusterHidden:document.querySelector('.crm-module-switch')?.hidden,buttons:document.querySelectorAll('.crm-module-switch button').length}));
  const nativeHistory={back:nativeBackState,forward:nativeForwardState};
  if(!nativeBackState.clusterHidden||nativeBackState.forwardDisabled||nativeBackState.module!=='home'||nativeForwardState.module!=='people'||nativeForwardState.clusterHidden||nativeForwardState.buttons!==3)throw new Error(`Native mouse history commands failed: ${JSON.stringify(nativeHistory)}`);
  await page.evaluate(()=>window.crmDeskTransit.driveTo('home'));
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home' && !window.crmDeskTransit?.isBusy?.(), null, { timeout:15000 });
  const initialPreviewTime = Math.max(...await page.evaluate(() => window.crmHome.previewStatus().map((item) => item.capturedAt || 0)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.setContentSize(1360, 900));
  try {
    await page.waitForFunction((capturedAt) => innerWidth === 1360 && innerHeight === 900
      && window.crmHome?.motionStatus?.().ready
      && window.crmHome.previewStatus().every((item) => item.capturedAt > capturedAt)
      && [...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')].every((image) => image.naturalWidth === innerWidth && image.naturalHeight === innerHeight), initialPreviewTime, { timeout:60000 });
  } catch (error) {
    const resizeState = await page.evaluate(() => ({ viewport:[innerWidth,innerHeight], motion:window.crmHome?.motionStatus?.(), previews:window.crmHome?.previewStatus?.(), images:[...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')].map((image) => [image.naturalWidth,image.naturalHeight]) }));
    throw new Error(`Home previews did not recapture after resize: ${JSON.stringify(resizeState)} (${error.message})`);
  }
  const resizedPreviewTime = Math.max(...await page.evaluate(() => window.crmHome.previewStatus().map((item) => item.capturedAt || 0)));
  const resizedAlignment = await page.evaluate(() => [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')].map((bucket) => {
    const image = bucket.querySelector('.crm-home-preview-foreground'); const rect = bucket.getBoundingClientRect();
    return { key:bucket.dataset.module, tile:rect.width / rect.height, preview:image.naturalWidth / image.naturalHeight };
  }));
  if (resizedAlignment.some((item) => Math.abs(item.tile - item.preview) > .01)) throw new Error(`Resized previews are stretched: ${JSON.stringify(resizedAlignment)}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.setContentSize(1280, 860));
  try {
    await page.waitForFunction((capturedAt) => innerWidth === 1280 && innerHeight === 860
      && window.crmHome?.motionStatus?.().ready
      && window.crmHome.previewStatus().every((item) => item.capturedAt > capturedAt), resizedPreviewTime, { timeout:60000 });
  } catch (error) {
    const restoreState = await page.evaluate(() => ({ viewport:[innerWidth,innerHeight], motion:window.crmHome?.motionStatus?.(), currentMotionSignature:window.crmHome?.motionLayoutSignature?.(), previews:window.crmHome?.previewStatus?.(), images:[...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')].map((image) => [image.naturalWidth,image.naturalHeight]) }));
    throw new Error(`Home previews did not recapture after restoring size: ${JSON.stringify(restoreState)} (${error.message})`);
  }
  const loadingSignal = await page.evaluate(() => {
    const source = document.querySelector('.crm-home-surface .crm-home-preview');
    const probe = source?.cloneNode(true);
    if (!probe) return null;
    probe.dataset.previewState = 'waiting';
    Object.assign(probe.style, { position:'fixed', left:'-1000px', top:'0', width:'240px', height:'160px' });
    document.body.appendChild(probe);
    const state = probe.querySelector(':scope > .crm-home-preview-state');
    const mark = state?.querySelector('.crm-home-preview-state-mark');
    const result = { opacity:Number(getComputedStyle(state).opacity), visibility:getComputedStyle(state).visibility,
      label:state?.textContent.trim(), animation:getComputedStyle(mark, '::after').animationName };
    probe.remove();
    return result;
  });
  if (!loadingSignal || loadingSignal.opacity !== 1 || loadingSignal.visibility !== 'visible'
    || loadingSignal.label !== 'Preparing view' || loadingSignal.animation !== 'crm-home-preview-turn') {
    throw new Error(`Home preview loading signal is not visibly progressive: ${JSON.stringify(loadingSignal)}`);
  }
  const stalePreviewFallback = await page.evaluate(async () => {
    const preview = (await window.crmHomePreviews.list()).previews.find((item) => item.key === 'people');
    if (!preview) return null;
    window.crmHome.acceptPreview({ ...preview, version:'previous-renderer-build' }, true);
    const host = document.querySelector('.crm-home-bucket[data-module="people"] .crm-home-preview');
    const image = host?.querySelector(':scope > .crm-home-preview-foreground');
    const stale = { status:window.crmHome.previewStatus().find((item) => item.key === 'people')?.state,
      hostState:host?.dataset.previewState, visible:!!image?.complete && image.naturalWidth > 0 && getComputedStyle(image).display !== 'none' };
    window.crmHome.acceptPreview(preview, true);
    stale.restored = window.crmHome.previewStatus().find((item) => item.key === 'people')?.state;
    return stale;
  });
  if (!stalePreviewFallback || stalePreviewFallback.status !== 'stale' || stalePreviewFallback.hostState !== 'stale'
    || !stalePreviewFallback.visible || stalePreviewFallback.restored !== 'ready') {
    throw new Error(`Renderer/host preview version skew blanks Home: ${JSON.stringify(stalePreviewFallback)}`);
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
    const title = document.querySelector('.crm-home-title-layer > .crm-home-title-slot[data-module="people"] .crm-home-title-glass');
    const titleOpacity = Number(getComputedStyle(title).opacity);
    return image?.complete && getComputedStyle(image).filter.includes('blur(0px)')
      && titleOpacity >= .23 && titleOpacity < .33;
  });
  const hoveredTileState = await hoverTile.evaluate((bucket) => ({
    images: bucket.querySelectorAll('.crm-home-preview > img').length,
    titleOpacity: Number(getComputedStyle(document.querySelector(`.crm-home-title-layer > .crm-home-title-slot[data-module="${bucket.dataset.module}"] .crm-home-title-glass`)).opacity),
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
      && Number(getComputedStyle(document.querySelector('.crm-home-title-layer > .crm-home-title-slot[data-module="people"] .crm-home-title-glass')).opacity) > .9;
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
  const sameNodes = await page.evaluate(() => { const selector='.crm-home-grid > .crm-home-bucket .crm-home-preview > .crm-home-preview-foreground'; const before=[...document.querySelectorAll(selector)]; for(let i=0;i<20;i+=1)window.crmHome.refresh(); const after=[...document.querySelectorAll(selector)]; return before.length===4&&after.length===4&&before.every((node,index)=>node===after[index]); });
  if (!sameNodes) throw new Error('Home refresh recreated screenshot objects');
  const homeComposition = await page.evaluate(() => {
    const grid = document.querySelector('.crm-home-grid');
    const bucket = grid?.querySelector(':scope > .crm-home-bucket');
    return { gridContain: getComputedStyle(grid).contain, bucketShadow: getComputedStyle(bucket).boxShadow };
  });
  if (homeComposition.gridContain.includes('paint') || /42px/.test(homeComposition.bucketShadow)) {
    throw new Error(`Home shadows are still clipped or merged by the floating-menu shadow: ${JSON.stringify(homeComposition)}`);
  }
  const motionSnapshotResult = await page.evaluate(() => window.crmHomePreviews?.motionSnapshot?.());
  const motionSnapshotBuffer = Buffer.from(motionSnapshotResult?.snapshot?.src?.split(',')[1] || '', 'base64');
  const homeMotionAlpha = imageAlphaStats(motionSnapshotBuffer);
  const motionVariants = Object.keys(motionSnapshotResult?.snapshot?.variants || {});
  const motionLayout = JSON.parse(motionSnapshotResult?.snapshot?.layoutSignature || '{}');
  const [motionGridX=0,motionGridY=0] = motionLayout.grid || [];
  const motionVariantCutouts = (motionLayout.buckets || []).map(([key,x,y,width,height]) => ({ key, maxAlpha:imageRegionMaxAlpha(Buffer.from((motionSnapshotResult?.snapshot?.variants?.[key] || '').split(',')[1] || '', 'base64'), [motionGridX+x,motionGridY+y,width,height], motionLayout.viewport) }));
  if (motionSnapshotResult?.snapshot?.backgroundMode !== 'shared' || motionSnapshotResult?.snapshot?.materialMode !== 'cached-acrylic' || motionVariants.length !== 4 || motionVariantCutouts.some((item)=>item.maxAlpha>2) || homeMotionAlpha.transparentRatio < .2 || homeMotionAlpha.partialRatio < .02) {
    throw new Error(`Home transition texture still owns an opaque wallpaper: ${JSON.stringify({ snapshot:motionSnapshotResult?.snapshot && { backgroundMode:motionSnapshotResult.snapshot.backgroundMode, foregroundBounds:motionSnapshotResult.snapshot.foregroundBounds }, alpha:homeMotionAlpha })}`);
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
    {key:'people',theater:'people',content:'.tk-zone',expected:16}, {key:'cases',theater:'tickets',content:'.tk-zone',expected:3},
    {key:'planner',theater:'planner',content:'.crm-planner-bucket',expected:0}, {key:'assignments',theater:'assignments',content:'.crm-assignment-bucket',expected:5},
  ];
  const transitions=[];
  for (const room of rooms) {
    const before = await page.evaluate((key)=>window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0,room.key);
    const previewNodeToken = await page.evaluate((key) => {
      const image = document.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview-foreground`);
      const token = `${key}-${Date.now()}-${Math.random()}`;
      if (image) image.dataset.liveSyncProbe = token;
      return token;
    }, room.key);
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
    const mid=await page.evaluate(()=>{const e=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const r=e?.getBoundingClientRect();const root=window.crmHomeCamera?.layers?.()[0];const surface=window.crmHomeCamera?.surface?.();const drag=document.querySelector('.app-window-drag-region');const titles=[...(root?.querySelectorAll('.crm-home-title-glass')||[])];const grid=root?.querySelector(':scope>.crm-home-grid');const hand=root?.querySelector(':scope>.crm-home-priority-hand');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');const status=window.crmHome?.motionStatus?.();const expanderStyle=e&&getComputedStyle(e);const target=root?.querySelector('.crm-home-bucket.is-camera-target');const targetStyle=target&&getComputedStyle(target);const foreground=e?.querySelector('.crm-home-preview-foreground');const buckets=[...(root?.querySelectorAll('.crm-home-grid>.crm-home-bucket')||[])];const bucketMaterialClear=buckets.every((bucket)=>{const style=getComputedStyle(bucket);return style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.backgroundImage==='none'&&style.boxShadow==='none'&&style.borderColor==='rgba(0, 0, 0, 0)'&&(style.webkitBackdropFilter||style.backdropFilter)==='none'});const objectComposition=!!snapshot&&getComputedStyle(snapshot).display==='none'&&!!variant&&variant.dataset.motionVariant===target?.dataset.module&&getComputedStyle(variant).display!=='none'&&getComputedStyle(grid).visibility==='visible'&&buckets.every((bucket)=>getComputedStyle(bucket.querySelector('.crm-home-preview')).visibility==='hidden')&&getComputedStyle(hand).visibility==='hidden';const materialClear=bucketMaterialClear&&!!target&&targetStyle?.backgroundColor==='rgba(0, 0, 0, 0)'&&targetStyle?.backgroundImage==='none'&&targetStyle?.boxShadow==='none'&&expanderStyle?.backgroundColor==='rgba(0, 0, 0, 0)'&&expanderStyle?.backgroundImage==='none'&&expanderStyle?.boxShadow==='none'&&(expanderStyle.webkitBackdropFilter||expanderStyle.backdropFilter)==='none';return{module:document.body.dataset.crmModule,transitioning:window.crmHomeCamera?.isTransitioning?.(),images:e?.querySelectorAll('img').length||0,rect:r?{width:r.width,height:r.height}:null,neighborOpacity:root?Number(getComputedStyle(root).opacity):0,targetMaterial:targetStyle?{background:targetStyle.backgroundImage,color:targetStyle.backgroundColor,shadow:targetStyle.boxShadow,border:targetStyle.border}:null,expanderMaterial:expanderStyle?{background:expanderStyle.backgroundImage,color:expanderStyle.backgroundColor,shadow:expanderStyle.boxShadow,border:expanderStyle.border}:null,titlesHidden:surface?.classList.contains('crm-home-camera-expanding')&&titles.length>0&&titles.every((title)=>getComputedStyle(title).visibility==='hidden'),motionComposite:objectComposition,signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),rootComposited:root?getComputedStyle(root).willChange.includes('transform'):false,sharedBackground:status?.backgroundMode==='shared'&&document.querySelectorAll('.crm-home-scene-backdrop').length===0&&document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&!!foreground&&!e?.querySelector('.crm-home-preview-exact')&&materialClear,dragTop:document.elementsFromPoint(520,20)[0]===drag,controlsTop:[...document.querySelectorAll('.window-control-cluster .window-glass-control')].every((n)=>{const b=n.getBoundingClientRect(),h=document.elementsFromPoint(b.left+b.width/2,b.top+b.height/2)[0];return h===n||n.contains(h)})}});
    const acrylicMid=await page.evaluate(()=>{const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const acrylic=expander?.querySelector(':scope>.crm-home-transition-acrylic');const target=root?.querySelector('.crm-home-bucket.is-camera-target');const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const buckets=[...(root?.querySelectorAll('.crm-home-grid>.crm-home-bucket')||[])];const material=(node)=>{if(!node)return null;const style=getComputedStyle(node),rect=node.getBoundingClientRect();return{opacity:Number(style.opacity),background:style.backgroundImage,backdrop:style.webkitBackdropFilter||style.backdropFilter,shadow:style.boxShadow,rect:[rect.x,rect.y,rect.width,rect.height]}};const selected=material(target),lid=material(expander),lens=material(acrylic);const nonTargets=buckets.filter((bucket)=>bucket!==target);return{frame:expander?.dataset.fractalFrame||'',selected,lid,lens,opacityTotal:(selected?.opacity||0)+(lid?.opacity||0),lensAligned:!!lens&&!!lid&&lens.rect.every((value,index)=>Math.abs(value-lid.rect[index])<=1),neighborAcrylic:nonTargets.length===3&&nonTargets.every((bucket)=>{const style=getComputedStyle(bucket);return(style.webkitBackdropFilter||style.backdropFilter)==='none'&&style.backgroundImage.includes('rgba(22, 26, 36, 0.62)')&&style.boxShadow!=='none'}),objects:!!variant&&getComputedStyle(variant).display!=='none'&&variant.dataset.motionVariant===target?.dataset.module&&getComputedStyle(snapshot).display==='none'&&nonTargets.every((bucket)=>getComputedStyle(bucket.querySelector('.crm-home-preview')).visibility==='hidden')&&getComputedStyle(target?.querySelector('.crm-home-preview')).visibility==='visible',sharedWallpaper:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&!expander?.querySelector('.crm-home-preview-exact')&&!!expander?.querySelector('.crm-home-preview-foreground'),acrylicLive:!!lens&&lens.backdrop==='none'&&lens.background.includes('rgba(22, 26, 36, 0.62)')&&lens.opacity>.99,surfaceMoving:surface?.classList.contains('crm-home-camera-moving')}});
    const inFlight=mid.module==='home'&&mid.transitioning&&mid.images===1&&mid.rect&&mid.rect.width>=300;
    const alreadyLanded=mid.module===room.key&&!mid.transitioning;
    if((!inFlight&&!alreadyLanded)||(inFlight&&(mid.neighborOpacity<.99||!mid.titlesHidden||!mid.signatureMatches||!mid.rootComposited||!acrylicMid.objects||!acrylicMid.sharedWallpaper||!acrylicMid.acrylicLive||!acrylicMid.lensAligned||acrylicMid.opacityTotal<.94||acrylicMid.opacityTotal>1.08||!acrylicMid.surfaceMoving))||!mid.dragTop||!mid.controlsTop)throw new Error(`${room.key} camera mid-state broken: ${JSON.stringify({mid,acrylicMid})}`);
    await page.screenshot({path:path.join(out,`transition-${room.key}.png`)});
    await page.waitForFunction((key)=>document.body.dataset.crmModule===key&&!window.crmDeskTransit?.isBusy?.()&&!document.querySelector('.crm-transit-veil'),room.key,{timeout:15000});
    const inboundEndpoint=await finishEndpointProbe(page,`in-${room.key}`);
    if(!inboundEndpoint.sawVeilRelease||!inboundEndpoint.sawRoomReveal||inboundEndpoint.endpointFrames<3||inboundEndpoint.endpointSignatures!==1||inboundEndpoint.minAlignmentError>1.25||inboundEndpoint.final.materializing||inboundEndpoint.final.veil)throw new Error(`${room.key} inbound endpoint handoff is discontinuous: ${JSON.stringify({inboundEndpoint,inboundReaction,motion:probe.transition})}`);
    await page.mouse.move(1,1); await sleep(80);
    const inboundStability=await sampleLayoutStability(page,`[data-crm-theater="${room.theater}"]:not([hidden])`);
    if(inboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after inbound transition: ${JSON.stringify(inboundStability)}`);
    const state=await page.evaluate(async(config)=>{
      const theater=document.querySelector(`[data-crm-theater="${config.theater}"]`);
      const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===config.key);
      const signatureSelector='.tk-zone[data-stage],.tk-card[data-id],.tk-zcard[data-id],.crm-planner-bucket[data-planner-bucket],.crm-planner-card[data-planner-card],.crm-assignment-bucket[data-assignment-stage],.crm-assignment-work-card[data-assignment-card]';
      const signature={module:document.body.dataset.crmModule||'',objects:[...(theater?.querySelectorAll(signatureSelector)||[])].map((node)=>[node.dataset.id||node.dataset.plannerBucket||node.dataset.plannerCard||node.dataset.assignmentStage||node.dataset.assignmentCard||node.dataset.stage||'',node.getAttribute('aria-label')||node.querySelector(':scope > .tk-zone-hd .tk-zone-title')?.textContent?.trim()||'',node.classList.contains('crm-object-small')?'small':'large',node.classList.contains('is-stack-expanded')?'expanded':'stacked']),calendarYear:window.fractalCalendar?.year?.()||null};
      const bucketGeometry=[...(theater?.querySelectorAll('.tk-zone')||[])].map((bucket)=>{const rect=bucket.getBoundingClientRect();return{width:rect.width,height:rect.height,ratio:rect.height?rect.width/rect.height:0}}).filter((bucket)=>bucket.width>0&&bucket.height>0);
      const bucketHeaders=[...(theater?.querySelectorAll('.tk-zone')||[])].filter((bucket)=>bucket.getBoundingClientRect().width>0).map((bucket)=>{const title=bucket.querySelector('.tk-zone-title');const bars=bucket.querySelector('.tk-zone-hd-r');const bucketRect=bucket.getBoundingClientRect();const barsRect=bars?.getBoundingClientRect();return{title:title?.textContent.trim()||'',whiteSpace:title?getComputedStyle(title).whiteSpace:'',singleLine:!!title&&title.scrollHeight<=title.clientHeight+1,count:bucket.querySelectorAll('.tk-zone-count').length,barsPosition:bars?getComputedStyle(bars).position:'',barsRight:barsRect?Math.round(bucketRect.right-barsRect.right):null}});
      const assignmentPipeline=theater?.querySelector('.crm-assignment-pipeline');const assignmentClip=theater?.querySelector('.crm-assignment-board-clip');const assignmentBar=theater?.querySelector('.crm-assignment-hsb');const assignmentThumb=theater?.querySelector('.crm-assignment-hth');
      return{visible:!!theater&&!theater.hidden,count:theater?.querySelectorAll(config.content).length||0,arrows:theater?.querySelectorAll('svg.tk-flow,.tk-flow-shaft,.tk-flow-head').length||0,unstackControls:theater?.querySelectorAll('.tk-zone-spread,.crm-assignment-stack-toggle,.crm-planner-stack-toggle').length||0,bucketGeometry,bucketHeaders,assignmentOverflow:assignmentPipeline&&assignmentClip?Math.max(0,assignmentPipeline.scrollWidth-assignmentClip.clientWidth):0,assignmentScroller:assignmentBar?{on:assignmentBar.classList.contains('is-on'),track:assignmentBar.getBoundingClientRect().width,thumb:assignmentThumb?.getBoundingClientRect().width||0}:null,signature,previewSignature:preview?.layoutSignature||null,exactSrc:preview?.exactSrc||'',veil:document.querySelectorAll('.crm-transit-veil').length,invalid:[...(theater?.querySelectorAll('*')||[])].filter((n)=>/NaN|Infinity/.test(getComputedStyle(n).transform)).length};
    },room);
    const liveBuffer=await page.screenshot({path:path.join(out,`room-${room.key}.png`)});
    const exactBuffer=Buffer.from(state.exactSrc.split(',')[1]||'','base64');
    const pixelMae=imageDifference(exactBuffer,liveBuffer,{left:50,right:1230,top:105,bottom:755});
    const probe={settled:await page.evaluate(()=>window.__fps),transition:await finishMotionProbe(page,`in-${room.key}`)};
    assertMotion(`${room.key} inbound`,probe.transition);
    let companyRailMotion=null;
    if(room.key==='people'){
      await page.evaluate(()=>window.peopleCards.scrollZonesBy(-9999,true));await sleep(80);
      await page.evaluate(()=>window.crmHomePreviews?.waitForIdle?.());await sleep(120);
      companyRailMotion=await page.evaluate(()=>new Promise((resolve)=>{document.activeElement?.blur?.();const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])');const mutations=[];const observer=new MutationObserver((records)=>mutations.push(...records));observer.observe(theater,{subtree:true,attributes:true,attributeFilter:['data-zone-lod']});const deltas=[];const longTasks=[];let previous=performance.now(),started=previous;const longObserver=new PerformanceObserver((list)=>list.getEntries().forEach((entry)=>longTasks.push(entry.duration)));try{longObserver.observe({entryTypes:['longtask']})}catch{}window.peopleCards.scrollZonesBy(9999);const tick=(now)=>{deltas.push(now-previous);previous=now;if(now-started<900){requestAnimationFrame(tick);return;}observer.disconnect();longObserver.disconnect();const sorted=[...deltas].sort((a,b)=>a-b);const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]||0;const parked=[...theater.querySelectorAll('.tk-zone[data-zone-lod="parked"]')];resolve({frames:deltas.length,fps:deltas.length*1000/(now-started),p95,max:Math.max(...deltas),over34:deltas.filter((value)=>value>34).length,longTasks,mutations:mutations.length,parked:parked.length,deferred:theater.querySelectorAll('.tk-zcard.is-lazy-shell').length,hidden:parked.every((bucket)=>{const style=getComputedStyle(bucket);return style.visibility==='hidden'&&style.contentVisibility==='hidden';})});};requestAnimationFrame(tick)}));
      if(companyRailMotion.frames<60||companyRailMotion.fps<80||companyRailMotion.p95>20.5||companyRailMotion.max>55||companyRailMotion.over34>2||companyRailMotion.longTasks.length||companyRailMotion.mutations>28||companyRailMotion.parked!==6||companyRailMotion.deferred!==150||!companyRailMotion.hidden)throw new Error(`People horizontal LOD is not compositor-stable: ${JSON.stringify(companyRailMotion)}`);
      await page.evaluate(()=>window.peopleCards.scrollZonesBy(-9999,true));await sleep(80);
    }
    const badBucket=room.key==='assignments'
      ? state.bucketGeometry.some((bucket)=>bucket.width<200||bucket.width>275||bucket.height<500||bucket.height>710||bucket.ratio<.35||bucket.ratio>.45)
      : room.key!=='planner'&&state.bucketGeometry.some((bucket)=>bucket.width<180||bucket.width>270||bucket.height<300||bucket.height>410||bucket.ratio<.55||bucket.ratio>.85);
    const badHeader=state.bucketHeaders.some((header)=>!header.title||header.whiteSpace!=='nowrap'||!header.singleLine||header.count||(room.key!=='assignments'&&(header.barsPosition!=='absolute'||header.barsRight<8||header.barsRight>60)));
    const badAssignmentScroller=room.key==='assignments'&&(!state.assignmentScroller?.on||state.assignmentOverflow<100||state.assignmentScroller.thumb<28||state.assignmentScroller.thumb>=state.assignmentScroller.track-10);
    if(!state.visible||state.count!==room.expected||state.arrows||state.unstackControls||badBucket||badHeader||badAssignmentScroller||state.veil||state.invalid||JSON.stringify(state.signature)!==JSON.stringify(state.previewSignature)||pixelMae>12||probe.settled.fps<40||probe.transition.fps<45)throw new Error(`${room.key} capture/live mismatch: ${JSON.stringify({state:{...state,exactSrc:undefined},pixelMae,probe})}`);
    const synchronization = await page.evaluate((key) => {
      let changed = false;
      if (key === 'people') {
        const api = window.peopleCards; const stage = api?.contract?.().stages?.[0]?.key;
        if (stage) { api.setStageExpanded(stage, !api.expandedStages().includes(stage)); changed = true; }
      } else if (key === 'cases') {
        const api = window.ticketStacks; const stage = document.querySelector('[data-crm-theater="tickets"] .tk-zone[data-stage]')?.dataset.stage;
        if (stage) { api.setStageExpanded(stage, !api.expandedStages().includes(stage)); changed = true; }
      } else if (key === 'planner') {
        const api = window.crmPlanner; const projects = api?.projects?.() || []; const selected = api?.selected?.();
        const alternate = projects.find((project) => project.id !== selected);
        if (alternate) { api.selectProject(alternate.id); changed = true; }
        else {
          const stage = document.querySelector('[data-crm-theater="planner"] .crm-planner-bucket')?.dataset.plannerBucket;
          if (selected && stage) { api.setStageExpanded(selected, stage, !api.expandedStages().includes(`${selected}:${stage}`)); changed = true; }
        }
      } else if (key === 'assignments') {
        const api = window.crmAssignments; const stage = document.querySelector('[data-crm-theater="assignments"] .crm-assignment-bucket')?.dataset.assignmentStage;
        if (stage) api.setStageExpanded(stage, !api.expandedStages().includes(stage));
        api.scrollBy(190, true); changed = true;
      }
      return { changed };
    }, room.key);
    await page.mouse.move(1,1); await sleep(280);
    const expectedViewState = await page.evaluate((key) => window.crmHome.captureDisplayedState(key), room.key);
    const synchronizedLiveBuffer = await page.screenshot({path:path.join(out,`room-${room.key}-synchronized.png`)});
    await startMotionProbe(page,`out-${room.key}`);
    await startEndpointProbe(page,`out-${room.key}`,room,'out');
    const outboundReaction=await page.evaluate(()=>{const started=performance.now();window.__homeDrive=window.crmDeskTransit.driveTo('home');return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),level:window.crmHomeCamera?.level?.(),module:document.body.dataset.crmModule}});
    if(!outboundReaction.busy||outboundReaction.level!==1||outboundReaction.module!=='home'||outboundReaction.elapsedMs>50)throw new Error(`${room.key} Home click did not start its camera move immediately: ${JSON.stringify(outboundReaction)}`);
    await sleep(100);
    const outboundMid=await page.evaluate(()=>{const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const grid=root?.querySelector(':scope>.crm-home-grid');const hand=root?.querySelector(':scope>.crm-home-priority-hand');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');const status=window.crmHome?.motionStatus?.();const expanderStyle=expander&&getComputedStyle(expander);const target=root?.querySelector('.crm-home-bucket.is-camera-target');const buckets=[...(grid?.querySelectorAll(':scope>.crm-home-bucket')||[])];const objectComposition=!!snapshot&&getComputedStyle(snapshot).display==='none'&&!!variant&&variant.dataset.motionVariant===target?.dataset.module&&getComputedStyle(variant).display!=='none'&&getComputedStyle(grid).visibility==='visible'&&buckets.every((bucket)=>getComputedStyle(bucket.querySelector('.crm-home-preview')).visibility==='hidden')&&getComputedStyle(hand).visibility==='hidden';return{moving:window.crmHomeCamera?.isTransitioning?.(),rootOpacity:root?Number(getComputedStyle(root).opacity):1,motionComposite:objectComposition,signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),expanderAbove:!!expander&&!!root&&Number(getComputedStyle(expander).zIndex)>Number(getComputedStyle(root).zIndex),sharedBackground:status?.backgroundMode==='shared'&&document.querySelectorAll('.crm-home-scene-backdrop').length===0&&document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&!!expander?.querySelector('.crm-home-preview-foreground')&&!expander?.querySelector('.crm-home-preview-exact')&&expanderStyle?.backgroundColor==='rgba(0, 0, 0, 0)'&&(expanderStyle.webkitBackdropFilter||expanderStyle.backdropFilter)==='none',titlesVisible:[...(root?.querySelectorAll('.crm-home-title-glass')||[])].every((title)=>getComputedStyle(title).visibility==='visible'),contracting:surface?.classList.contains('crm-home-camera-contracting')}});
    const outboundAcrylic=await page.evaluate(()=>{const root=window.crmHomeCamera?.layers?.()[0];const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');const acrylic=expander?.querySelector(':scope>.crm-home-transition-acrylic');const target=root?.querySelector('.crm-home-bucket.is-camera-target');const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');const buckets=[...(root?.querySelectorAll('.crm-home-grid>.crm-home-bucket')||[])];const material=(node)=>{if(!node)return null;const style=getComputedStyle(node),rect=node.getBoundingClientRect();return{opacity:Number(style.opacity),background:style.backgroundImage,backdrop:style.webkitBackdropFilter||style.backdropFilter,shadow:style.boxShadow,rect:[rect.x,rect.y,rect.width,rect.height]}};const selected=material(target),lid=material(expander),lens=material(acrylic);const nonTargets=buckets.filter((bucket)=>bucket!==target);return{frame:expander?.dataset.fractalFrame||'',selected,lid,lens,opacityTotal:(selected?.opacity||0)+(lid?.opacity||0),lensAligned:!!lens&&!!lid&&lens.rect.every((value,index)=>Math.abs(value-lid.rect[index])<=1),neighborAcrylic:nonTargets.length===3&&nonTargets.every((bucket)=>{const style=getComputedStyle(bucket);return(style.webkitBackdropFilter||style.backdropFilter)==='none'&&style.backgroundImage.includes('rgba(22, 26, 36, 0.62)')&&style.boxShadow!=='none'}),objects:!!variant&&getComputedStyle(variant).display!=='none'&&variant.dataset.motionVariant===target?.dataset.module&&getComputedStyle(snapshot).display==='none'&&nonTargets.every((bucket)=>getComputedStyle(bucket.querySelector('.crm-home-preview')).visibility==='hidden')&&getComputedStyle(target?.querySelector('.crm-home-preview')).visibility==='visible',sharedWallpaper:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&!expander?.querySelector('.crm-home-preview-exact')&&!!expander?.querySelector('.crm-home-preview-foreground'),acrylicLive:!!lens&&lens.backdrop==='none'&&lens.background.includes('rgba(22, 26, 36, 0.62)')&&lens.opacity>.99}});
    if(!outboundMid.moving||outboundMid.rootOpacity<.99||!outboundMid.signatureMatches||!outboundMid.expanderAbove||!outboundMid.titlesVisible||!outboundMid.contracting||!outboundAcrylic.objects||!outboundAcrylic.sharedWallpaper||!outboundAcrylic.acrylicLive||!outboundAcrylic.lensAligned||outboundAcrylic.opacityTotal<.94||outboundAcrylic.opacityTotal>1.08)throw new Error(`${room.key} return composition diverged from resting Home: ${JSON.stringify({outboundMid,outboundAcrylic})}`);
    await page.evaluate(()=>window.__homeDrive); await page.waitForFunction(readyHome,null,{timeout:15000});
    const outboundEndpoint=await finishEndpointProbe(page,`out-${room.key}`);
    if(!outboundEndpoint.sawHomeRelease||outboundEndpoint.endpointFrames<3||outboundEndpoint.endpointSignatures!==1||!outboundEndpoint.endpointShadowsReady||outboundEndpoint.endpointShadowSignatures!==1||outboundEndpoint.minAlignmentError>1.25||outboundEndpoint.final.homeHandoff||outboundEndpoint.final.homeReleasing||outboundEndpoint.final.snapshotDisplay!=='none')throw new Error(`${room.key} Home endpoint handoff is discontinuous: ${JSON.stringify(outboundEndpoint)}`);
    const outbound=await finishMotionProbe(page,`out-${room.key}`);
    assertMotion(`${room.key} outbound`,outbound);
    const outboundStability=await sampleLayoutStability(page,'.crm-home-surface:not([hidden])');
    await page.waitForFunction(({key,before})=>{const status=window.crmHome.previewStatus().find((item)=>item.key===key);return status?.state==='ready'&&status.capturedAt>before;},{key:room.key,before},{timeout:60000});
    const synchronizedPreview=await page.evaluate(async({key,token})=>{const status=window.crmHome.previewStatus().find((item)=>item.key===key);const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===key);const host=document.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);const image=host?.querySelector(':scope > .crm-home-preview-foreground');return{after:status?.capturedAt||0,state:status?.state,sameNode:image?.dataset.liveSyncProbe===token,hostCapturedAt:Number(host?.dataset.capturedAt||0),viewState:preview?.viewState||null,exactSrc:preview?.exactSrc||''};},{key:room.key,token:previewNodeToken});
    const after=synchronizedPreview.after;
    const synchronizedExactBuffer=Buffer.from(synchronizedPreview.exactSrc.split(',')[1]||'','base64');
    const synchronizedPixelMae=imageDifference(synchronizedExactBuffer,synchronizedLiveBuffer,{left:50,right:1230,top:105,bottom:755});
    if(outboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after returning Home: ${JSON.stringify(outboundStability)}`);
    if(after<=before||synchronizedPreview.state!=='ready'||!synchronizedPreview.sameNode||synchronizedPreview.hostCapturedAt!==after||JSON.stringify(synchronizedPreview.viewState)!==JSON.stringify(expectedViewState)||synchronizedPixelMae>12)throw new Error(`${room.key} Home tile did not synchronize with the displayed room: ${JSON.stringify({before,after,synchronization,expectedViewState,actualViewState:synchronizedPreview.viewState,sameNode:synchronizedPreview.sameNode,hostCapturedAt:synchronizedPreview.hostCapturedAt,synchronizedPixelMae})}`);
    transitions.push({key:room.key,mid,acrylicMid,outboundMid,outboundAcrylic,pixelMae,synchronizedPixelMae,fps:probe.settled.fps,companyRailMotion,inbound:probe.transition,outbound,inboundEndpoint,outboundEndpoint,inboundStability,outboundStability,inboundReaction,outboundReaction,signatureMatches:true,previewRefreshed:after>before,previewNodePreserved:synchronizedPreview.sameNode});
  }
  const handTicket=await page.evaluate((commitmentId)=>{
    const card=document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(commitmentId)}"]`);
    return card?{commitmentId:card.dataset.commitmentId,ticketId:card.dataset.recordId}:null;
  },nativeTicketCommitmentId);
  if(!handTicket){const handState=await page.evaluate(async(commitmentId)=>({commitmentId,status:window.crmHome?.handStatus?.(),cards:[...document.querySelectorAll('.crm-home-hand-card')].map((card)=>({commitmentId:card.dataset.commitmentId,entity:card.dataset.recordEntity,recordId:card.dataset.recordId})),record:(await window.crmDomain.list('commitments',{includeDeleted:false,limit:300})).records?.find((item)=>item.id===commitmentId)||null}),nativeTicketCommitmentId);throw new Error(`Home hand has no linked ticket for the native handoff probe: ${JSON.stringify(handState)}`)}
  await page.hover('.crm-home-priority-hand > .crm-home-hand-card:last-child');await sleep(420);
  await startMotionProbe(page,'hand-ticket-in');
  await page.click(`.crm-home-hand-card[data-commitment-id="${handTicket.commitmentId}"]`);
  await sleep(80);
  const handTicketEarly=await page.evaluate(()=>({module:document.body.dataset.crmModule,busy:window.crmDeskTransit?.isBusy?.(),moving:window.crmHomeCamera?.isTransitioning?.(),detail:document.querySelectorAll('.ticket-detail-overlay:not([hidden])').length,recordWorld:!!document.querySelector('.record-world-shell:not([hidden])')}));
  if(handTicketEarly.module!=='home'||!handTicketEarly.busy||!handTicketEarly.moving||handTicketEarly.detail||handTicketEarly.recordWorld)throw new Error(`Home ticket opened before its world handoff: ${JSON.stringify(handTicketEarly)}`);
  await page.waitForFunction((ticketId)=>document.body.dataset.crmModule==='cases'&&!window.crmDeskTransit?.isBusy?.()&&!!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail')&&[...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zcard,[data-crm-theater="tickets"]:not([hidden]) .tk-deck .tk-card')].some((card)=>card.dataset.id===ticketId&&card.style.visibility==='hidden'),handTicket.ticketId,{timeout:15000});
  const handTicketMotion=await finishMotionProbe(page,'hand-ticket-in');assertMotion('Home hand ticket inbound',handTicketMotion);
  const handTicketSettled=await page.evaluate((ticketId)=>({module:document.body.dataset.crmModule,details:document.querySelectorAll('.ticket-detail-overlay:not([hidden])').length,nativeSources:[...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zcard,[data-crm-theater="tickets"]:not([hidden]) .tk-deck .tk-card')].filter((card)=>card.dataset.id===ticketId).map((card)=>({className:card.className,visibility:card.style.visibility})),transient:document.querySelectorAll('.tk-external-source').length,recordWorld:!!document.querySelector('.record-world-shell:not([hidden])'),veil:document.querySelectorAll('.crm-transit-veil').length,expander:document.querySelectorAll('.crm-home-expander:not(.crm-home-warm)').length}),handTicket.ticketId);
  if(handTicketSettled.module!=='cases'||handTicketSettled.details!==1||!handTicketSettled.nativeSources.some((source)=>source.visibility==='hidden')||handTicketSettled.transient||handTicketSettled.recordWorld||handTicketSettled.veil||handTicketSettled.expander)throw new Error(`Home ticket did not settle into one native reveal: ${JSON.stringify(handTicketSettled)}`);
  await page.screenshot({path:path.join(out,'ticket-hand-detail.png')});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.ticket-detail-overlay:not([hidden])'),null,{timeout:5000});
  await page.evaluate(()=>window.crmDeskTransit.driveTo('home'));await page.waitForFunction(readyHome,null,{timeout:15000});
  const nativeProjectId=await page.evaluate(async()=>{
    const project=await window.crmPlanner.createProject('Native preview project','',['Backlog','In progress','Done']);
    const stage=window.crmPlanner.projects().find((item)=>item.id===project?.id)?.buckets?.[1];
    if(project&&stage)await window.crmPlanner.createCard(project.id,stage.id,'Native preview card');
    return project?.id||'';
  });
  if(!nativeProjectId)throw new Error('Could not create native project-preview fixture');
  await page.evaluate(()=>window.crmWorkspaces.setActive('planner'));
  await page.waitForFunction((projectId)=>window.crmPlanner?.projectPreviewStatus?.().some((item)=>item.id===projectId&&item.ready),nativeProjectId,{timeout:60000});
  const projectPreviewBefore=await page.evaluate(async(projectId)=>{
    const tile=document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`);const image=tile?.querySelector(':scope>.crm-home-preview>.crm-home-preview-foreground');const rect=tile?.getBoundingClientRect();
    const preview=(await window.crmHomePreviews.projectList()).previews.find((item)=>item.key===projectId);if(image)image.dataset.nativeProjectProbe='preserve';
    return{rect:rect&&[rect.x,rect.y,rect.width,rect.height],image:!!image,natural:[image?.naturalWidth||0,image?.naturalHeight||0],filter:image?getComputedStyle(image).filter:'',exactSrc:preview?.exactSrc||'',foregroundSrc:preview?.foregroundSrc||'',title:document.querySelector(`[data-project-title="${CSS.escape(projectId)}"] .crm-home-title`)?.textContent.trim()||''};
  },nativeProjectId);
  if(!projectPreviewBefore.image||!projectPreviewBefore.exactSrc||!projectPreviewBefore.foregroundSrc||!projectPreviewBefore.filter.includes('blur(1.8px)')||projectPreviewBefore.natural[0]!==1280||projectPreviewBefore.natural[1]!==860||projectPreviewBefore.title!=='Native preview project')throw new Error(`Nested project tile did not use the native Home preview contract: ${JSON.stringify({...projectPreviewBefore,exactSrc:!!projectPreviewBefore.exactSrc,foregroundSrc:!!projectPreviewBefore.foregroundSrc})}`);
  await page.screenshot({path:path.join(out,'projects-nested.png')});
  const projectDiveStart=await page.evaluate((projectId)=>new Promise((resolve)=>{
    const tile=document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`);const source=tile?.getBoundingClientRect();window.__nativeProjectOpen=window.crmPlanner.openProject(projectId);requestAnimationFrame(()=>{const layer=window.crmProjectsCamera?.layers?.()[1]||document.querySelector('.crm-planner-project-world');const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const acrylic=layer?.querySelector(':scope>.crm-project-transition-acrylic');const live=layer?.querySelector(':scope>.crm-planner-project-live');const rect=layer?.getBoundingClientRect();const acrylicStyle=acrylic&&getComputedStyle(acrylic);resolve({source:source&&[source.x,source.y,source.width,source.height],rect:rect&&[rect.x,rect.y,rect.width,rect.height],overlay:!!overlay,opacity:overlay?Number(getComputedStyle(overlay).opacity):0,src:overlay?.src||'',acrylic:!!acrylic,acrylicOpacity:acrylicStyle?Number(acrylicStyle.opacity):0,acrylicBackdrop:acrylicStyle?.backdropFilter||'',liveOpacity:live?Number(getComputedStyle(live).opacity):1,wallpapers:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length,level:window.crmPlanner.level(),transitioning:window.crmProjectsCamera?.isTransitioning?.()})})
  }),nativeProjectId);
  if(!projectDiveStart.overlay||projectDiveStart.opacity<.99||projectDiveStart.src!==projectPreviewBefore.foregroundSrc||!projectDiveStart.acrylic||projectDiveStart.acrylicOpacity<.99||projectDiveStart.acrylicBackdrop!=='none'||projectDiveStart.liveOpacity>.01||projectDiveStart.wallpapers!==1||!projectDiveStart.rect||projectDiveStart.rect.some((value,index)=>Math.abs(value-projectDiveStart.source[index])>1.25))throw new Error(`Project zoom did not carry one acrylic/object composition from its source: ${JSON.stringify({...projectDiveStart,src:!!projectDiveStart.src})}`);
  await page.waitForFunction(()=>window.crmPlanner?.view?.()==='project'&&!window.crmProjectsCamera?.isTransitioning?.(),null,{timeout:15000});await sleep(180);
  const projectDiveSettled=await page.evaluate(()=>{const layer=window.crmProjectsCamera.layers()[1];const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const acrylic=layer?.querySelector(':scope>.crm-project-transition-acrylic');const live=layer?.querySelector(':scope>.crm-planner-project-live');const rect=layer?.getBoundingClientRect();return{rect:rect&&[rect.x,rect.y,rect.width,rect.height],opacity:overlay?Number(getComputedStyle(overlay).opacity):null,acrylicOpacity:acrylic?Number(getComputedStyle(acrylic).opacity):null,liveOpacity:live?Number(getComputedStyle(live).opacity):null,buckets:layer?.querySelectorAll('.crm-planner-bucket').length||0,cards:layer?.querySelectorAll('.crm-planner-card').length||0}});
  if(!projectDiveSettled.rect||projectDiveSettled.rect.some((value,index)=>Math.abs(value-[0,0,1280,860][index])>1)||projectDiveSettled.opacity!==0||projectDiveSettled.acrylicOpacity!==0||projectDiveSettled.liveOpacity!==1||projectDiveSettled.buckets!==3||projectDiveSettled.cards!==1)throw new Error(`Project zoom did not hand off to its real settled workspace: ${JSON.stringify(projectDiveSettled)}`);
  await page.screenshot({path:path.join(out,'project-world.png')});
  const projectReturnStart=await page.evaluate(()=>new Promise((resolve)=>{window.crmPlanner.back();requestAnimationFrame(()=>{const layer=document.querySelector('.crm-planner-project-world.crm-planner-contracting');const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const live=layer?.querySelector(':scope>.crm-planner-project-live');resolve({overlay:!!overlay,opacity:overlay?Number(getComputedStyle(overlay).opacity):0,src:overlay?.src||'',liveOpacity:live?Number(getComputedStyle(live).opacity):1})})}));
  if(!projectReturnStart.overlay||projectReturnStart.src!==projectPreviewBefore.foregroundSrc||projectReturnStart.opacity<0||projectReturnStart.opacity>1||projectReturnStart.liveOpacity<0||projectReturnStart.liveOpacity>1.01||projectReturnStart.opacity+projectReturnStart.liveOpacity<.94||projectReturnStart.opacity+projectReturnStart.liveOpacity>1.08)throw new Error(`Project return did not begin with one covered object crossfade: ${JSON.stringify({...projectReturnStart,src:!!projectReturnStart.src})}`);
  await sleep(140);
  const projectReturnAcrylic=await page.evaluate(()=>{const layer=document.querySelector('.crm-planner-project-world.crm-planner-contracting');const acrylic=layer?.querySelector(':scope>.crm-project-transition-acrylic');const style=acrylic&&getComputedStyle(acrylic);return{moving:window.crmProjectsCamera?.isTransitioning?.(),opacity:style?Number(style.opacity):0,backdrop:style?.backdropFilter||'',frame:layer?.dataset.fractalFrame||'',wallpapers:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length}});
  if(!projectReturnAcrylic.moving||projectReturnAcrylic.opacity<.95||projectReturnAcrylic.backdrop!=='none'||projectReturnAcrylic.frame!=='source'||projectReturnAcrylic.wallpapers!==1)throw new Error(`Project return dropped its acrylic in flight: ${JSON.stringify(projectReturnAcrylic)}`);
  await page.waitForFunction(()=>window.crmPlanner?.view?.()==='projects'&&!window.crmProjectsCamera?.isTransitioning?.(),null,{timeout:15000});
  const projectReturn=await page.evaluate((projectId)=>{const tile=document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`);const rect=tile?.getBoundingClientRect();const image=tile?.querySelector(':scope>.crm-home-preview>.crm-home-preview-foreground');return{rect:rect&&[rect.x,rect.y,rect.width,rect.height],sameNode:image?.dataset.nativeProjectProbe==='preserve',layers:window.crmProjectsCamera.layers().filter(Boolean).length}},nativeProjectId);
  if(!projectReturn.sameNode||projectReturn.layers!==1||projectReturn.rect.some((value,index)=>Math.abs(value-projectPreviewBefore.rect[index])>1))throw new Error(`Project return replaced or shifted its source tile: ${JSON.stringify(projectReturn)}`);
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));
  try { await page.waitForFunction(readyHome,null,{timeout:30000}); }
  catch (error) {
    const state=await page.evaluate(async()=>{const ipc=await window.crmHomePreviews?.motionSnapshot?.();return{module:document.body.dataset.crmModule,homeHidden:document.querySelector('.crm-home-surface')?.hidden,buckets:document.querySelectorAll('.crm-home-grid>.crm-home-bucket').length,hand:window.crmHome?.handStatus?.(),motion:window.crmHome?.motionStatus?.(),currentLayout:window.crmHome?.motionLayoutSignature?.(),ipc:ipc&&{ok:ipc.ok,error:ipc.error,snapshot:ipc.snapshot&&{version:ipc.snapshot.version,capturedAt:ipc.snapshot.capturedAt,layoutSignature:ipc.snapshot.layoutSignature,materialMode:ipc.snapshot.materialMode}},previews:window.crmHome?.previewStatus?.(),idle:await window.crmHomePreviews?.waitForIdle?.()}});
    throw new Error(`Home did not become preview-ready after nested project return: ${JSON.stringify(state)}`,{cause:error});
  }
  const transitTimings=await page.evaluate(()=>window.crmDeskTransit?.performanceTimings?.()||[]);
  const unsettled=transitTimings.filter((item)=>item.settled===false);
  if(unsettled.length)throw new Error(`Destinations were revealed before stable geometry: ${JSON.stringify(unsettled)}`);
  await page.evaluate(()=>window.crmWorkspaces.setActive('people'));
  await page.waitForFunction(()=>!!document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]'),null,{timeout:10000});
  await page.$eval('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]',(card)=>{const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20,button:2}))});
  await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
  await page.waitForSelector('.crm-person-history-shell:not([hidden]) .crm-person-history',{timeout:10000});await sleep(250);
  const personHistory=await page.evaluate(()=>{const shell=document.querySelector('.crm-person-history-shell:not([hidden])');const panel=shell?.querySelector('.crm-person-history');const thread=panel?.querySelector('.crm-person-history-thread');const composer=panel?.querySelector('.crm-person-history-composer');const source=document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');const rect=panel?.getBoundingClientRect();const sourceRect=source?.getBoundingClientRect();const shellStyle=shell&&getComputedStyle(shell);const tint=getComputedStyle(document.querySelector('.crm-module-switch'),'::after');const events=[...(panel?.querySelectorAll('.crm-person-history-event')||[])];return{heading:panel?.querySelector('.crm-person-history-kicker')?.textContent.trim(),repeatedIdentity:!!panel?.querySelector('.crm-person-history-title'),seededSystem:events.some((event)=>/^seed(?:ed|ing)?\b/i.test(event.querySelector('.crm-person-history-event-content')?.textContent.trim()||'')),events:events.length,filters:panel?.querySelectorAll('[data-history-filter]').length||0,composerHidden:composer?.hidden===true,canonical:panel?.classList.contains('crm-menu-surface')||false,compact:!!rect&&rect.width<=370&&rect.height<=540,inBounds:!!rect&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,adjacent:!!rect&&!!sourceRect&&(Math.abs(rect.left-sourceRect.right)<=12||Math.abs(sourceRect.left-rect.right)<=12),transparent:!!shellStyle&&shellStyle.backgroundColor==='rgba(0, 0, 0, 0)'&&['none',''].includes(shellStyle.backdropFilter),noLegacyChrome:!panel?.querySelector('.crm-person-history-body,.crm-person-history-sidebar,.crm-person-history-summary,.crm-person-history-filters'),noHorizontalOverflow:!!panel&&!!thread&&panel.scrollWidth<=panel.clientWidth+1&&thread.scrollWidth<=thread.clientWidth+1,canonicalActions:[...(panel?.querySelectorAll('button')||[])].every((button)=>button.classList.contains('crm-menu-action')),tinted:tint.backgroundImage.includes('rgba(13, 35, 72')&&tint.boxShadow!=='none'}});
  if(personHistory.heading!=='Conversation history'||personHistory.repeatedIdentity||personHistory.seededSystem||personHistory.events<5||personHistory.filters!==0||!personHistory.composerHidden||!personHistory.canonical||!personHistory.compact||!personHistory.inBounds||!personHistory.adjacent||!personHistory.transparent||!personHistory.noLegacyChrome||!personHistory.noHorizontalOverflow||!personHistory.canonicalActions||!personHistory.tinted)throw new Error(`Person history native layout broken: ${JSON.stringify(personHistory)}`);
  await page.screenshot({path:path.join(out,'person-history.png')});
  await page.click('[data-person-history-close]');
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:15000});
  const settledFps=await frameRate(page); if(settledFps<45)throw new Error(`Settled Home FPS ${settledFps}`);
  await page.evaluate(()=>window.crmHome.waitForPreviewSync()); await sleep(100); const windowDetails=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter((win)=>!win.isDestroyed()).map((win)=>({id:win.id,url:win.webContents.getURL(),visible:win.isVisible(),loading:win.webContents.isLoading(),bounds:win.getBounds()}))); const windows=windowDetails.length; if(windows!==1)throw new Error(`${windows} BrowserWindows remain after preview synchronization: ${JSON.stringify(windowDetails)}`);
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
  const evidence={startup,nativeHistory,nativeDrag,sameNodes,homeComposition,homeMotionAlpha,homeFps,settledFps,instantControls,domainProbe,transitions,handTicket:{ticket:handTicket,early:handTicketEarly,settled:handTicketSettled,motion:handTicketMotion},projectTiles:{before:{...projectPreviewBefore,exactSrc:!!projectPreviewBefore.exactSrc,foregroundSrc:!!projectPreviewBefore.foregroundSrc},diveStart:{...projectDiveStart,src:!!projectDiveStart.src},settled:projectDiveSettled,returnStart:{...projectReturnStart,src:!!projectReturnStart.src},returnAcrylic:projectReturnAcrylic,returned:projectReturn},transitTimings,personHistory,windows,finalChrome,windowControls:{refresh:true,minimized,hidden},errors};
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('[electron-playwright]',evidence);
  if(errors.length)throw new Error(errors.join(' | ')); await app.close(); process.exit(0);
}
main().catch((error)=>{console.error(error);process.exit(1)});
