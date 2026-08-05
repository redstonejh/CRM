'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readyHome = () => document.body.dataset.crmModule === 'home'
  && !window.crmDeskTransit?.isBusy?.()
  && !document.querySelector('.crm-home-surface')?.hidden
  && window.crmHome?.handStatus?.().ready
  && window.crmHome?.motionStatus?.().ready
  && [...document.querySelectorAll('.crm-home-grid .crm-home-preview')].every((host) => {
    const image = host.querySelector(':scope > .crm-home-preview-foreground');
    return host.dataset.previewState === 'ready' && image?.complete && image.naturalWidth > 0;
  });

async function beginProbe(page, label) {
  await page.evaluate((probeLabel) => {
    const probe = {
      label:probeLabel, startedAt:performance.now(), previous:performance.now(),
      deltas:[], movingDeltas:[], cadenceDeltas:[], samples:[], longTasks:[], firstMovingAt:null,
      lastMovingAt:null, motionEndedAt:null, previousMoving:false, done:false,
    };
    const observer = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
        probe.longTasks.push({ startTime:entry.startTime, duration:entry.duration });
      }))
      : null;
    try { observer?.observe({ entryTypes:['longtask'] }); } catch {}
    const tick = (now) => {
      const delta = now - probe.previous;
      // Camera "transitioning" includes covered jump/precomposition frames.
      // The coordinator phase brackets the actual CSS transform and acrylic
      // animation, so cadence here represents every visibly moving frame.
      const motionState = window.crmDeskTransit?.motionState?.() || {};
      const moving = motionState.active === true;
      let visibleDelta = null;
      probe.deltas.push(delta);
      if (moving) {
        if (probe.firstMovingAt == null) {
          const reportedStart = motionState.startedAt == null ? NaN : Number(motionState.startedAt);
          probe.firstMovingAt = Number.isFinite(reportedStart) && reportedStart > 0 && reportedStart <= now
            ? reportedStart
            : now;
          try { console.timeStamp(`crm-motion-start:${probe.label}`); } catch {}
          visibleDelta = now - probe.firstMovingAt;
        } else if (probe.previousMoving) {
          visibleDelta = delta;
        }
        if (visibleDelta > 0) {
          probe.movingDeltas.push(visibleDelta);
          if (probe.previousMoving) probe.cadenceDeltas.push(visibleDelta);
        }
        probe.lastMovingAt = now;
      } else if (probe.previousMoving && probe.firstMovingAt != null) {
        probe.motionEndedAt = now;
        try { console.timeStamp(`crm-motion-end:${probe.label}`); } catch {}
      }
      probe.samples.push({
        at:now - probe.startedAt,
        delta,
        visibleDelta,
        moving,
        module:document.body.dataset.crmModule || '',
        materializing:document.documentElement.classList.contains('crm-transit-materializing'),
        revealing:document.documentElement.classList.contains('crm-transit-revealing'),
        cameraProgress:moving && probe.firstMovingAt != null ? Math.min(1, (now - probe.firstMovingAt) / 460) : null,
      });
      if (moving && visibleDelta > 15) {
        try { console.timeStamp(`crm-slow:${probe.label}:${visibleDelta.toFixed(1)}`); } catch {}
      }
      probe.previous = now;
      probe.previousMoving = moving;
      if (!probe.done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__crmTransitionProfiler = probe;
  }, label);
}

async function finishProbe(page) {
  return page.evaluate(() => {
    const probe = window.__crmTransitionProfiler;
    if (!probe) return null;
    probe.done = true;
    const cadenceMeasured = probe.cadenceDeltas;
    const sorted = [...cadenceMeasured].sort((a, b) => a - b);
    const cadenceTotal = cadenceMeasured.reduce((sum, value) => sum + value, 0);
    const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
    const motionStart = probe.firstMovingAt ?? probe.startedAt;
    const motionEnd = probe.motionEndedAt ?? probe.lastMovingAt ?? motionStart;
    const longTasks = probe.longTasks.filter((entry) =>
      entry.startTime < motionEnd && entry.startTime + entry.duration > motionStart)
      .map((entry) => ({ at:entry.startTime - probe.startedAt, duration:entry.duration }));
    return {
      label:probe.label,
      frames:cadenceMeasured.length,
      fps:cadenceTotal ? cadenceMeasured.length * 1000 / cadenceTotal : 0,
      firstFrameMs:probe.movingDeltas[0] ?? null,
      p95Ms:percentile(.95),
      p99Ms:percentile(.99),
      maxMs:sorted.at(-1) || 0,
      over15Ms:cadenceMeasured.filter((value) => value > 15).length,
      over20Ms:cadenceMeasured.filter((value) => value > 20).length,
      over34Ms:cadenceMeasured.filter((value) => value > 34).length,
      longTasks,
      revealFrames:probe.samples.filter((sample) => sample.moving && sample.revealing).length,
      slowFrames:probe.samples.filter((sample) => sample.moving && sample.visibleDelta > 15).map((sample) => ({
        at:Number(sample.at.toFixed(1)),
        delta:Number(sample.visibleDelta.toFixed(1)),
        cameraProgress:sample.cameraProgress == null ? null : Number(sample.cameraProgress.toFixed(3)),
        materializing:sample.materializing,
        revealing:sample.revealing,
      })),
    };
  });
}

async function profileMove(page, label, move, settled) {
  await beginProbe(page, label);
  await move();
  await settled();
  return finishProbe(page);
}

async function startBrowserTrace(page) {
  if (process.env.CRM_TRACE_TRANSITION !== '1') return null;
  const session = await page.context().newCDPSession(page);
  const events = [];
  session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  await session.send('Tracing.start', {
    transferMode:'ReportEvents',
    options:'record-as-much-as-possible',
    categories:[
      'toplevel', 'blink', 'cc', 'gpu', 'viz', 'renderer.scheduler',
      'devtools.timeline', 'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.gc',
    ].join(','),
  });
  return { session, events };
}

async function finishBrowserTrace(trace) {
  if (!trace) return null;
  const complete = new Promise((resolve) => trace.session.once('Tracing.tracingComplete', resolve));
  await trace.session.send('Tracing.end');
  await Promise.race([
    complete,
    sleep(30000).then(() => { throw new Error('Browser tracing did not complete within 30000 ms'); }),
  ]);
  const processNames = new Map();
  const threadNames = new Map();
  trace.events.forEach((event) => {
    if (event.ph !== 'M') return;
    if (event.name === 'process_name') processNames.set(event.pid, event.args?.name || '');
    if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name || '');
  });
  const markers = trace.events.filter((event) =>
    event.name === 'TimeStamp' && String(event.args?.data?.message || '').startsWith('crm-'))
    .map((event) => ({ ts:event.ts, message:event.args?.data?.message || '', pid:event.pid, tid:event.tid }));
  const motionStarts = markers.filter((marker) => marker.message.startsWith('crm-motion-start:'));
  const compositorCadence = motionStarts.map((start) => {
    const label = start.message.slice('crm-motion-start:'.length);
    const end = markers.find((marker) =>
      marker.ts > start.ts && marker.message === `crm-motion-end:${label}`);
    const draws = end ? trace.events.filter((event) =>
      event.name === 'Display::DrawAndSwap'
      && event.ph === 'X'
      && Number(event.ts) >= start.ts
      && Number(event.ts) <= end.ts)
      .map((event) => Number(event.ts))
      .sort((a, b) => a - b) : [];
    const deltas = draws.slice(1).map((value, index) => (value - draws[index]) / 1000);
    const sorted = [...deltas].sort((a, b) => a - b);
    const total = draws.length > 1 ? (draws.at(-1) - draws[0]) / 1000 : 0;
    return {
      label,
      durationMs:end ? (end.ts - start.ts) / 1000 : 0,
      frames:draws.length,
      fps:total > 0 ? (draws.length - 1) * 1000 / total : 0,
      medianMs:sorted[Math.floor(sorted.length / 2)] || 0,
      maxMs:sorted.at(-1) || 0,
      over15Ms:deltas.filter((value) => value > 15).length,
      deltas,
    };
  });
  const longEvents = trace.events.filter((event) => event.ph === 'X' && Number(event.dur) >= 5000)
    .map((event) => ({
      name:event.name,
      ms:Number((Number(event.dur) / 1000).toFixed(3)),
      ts:event.ts,
      process:processNames.get(event.pid) || String(event.pid),
      thread:threadNames.get(`${event.pid}:${event.tid}`) || String(event.tid),
      category:event.cat || '',
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 30);
  const nearMarkers = markers.filter((marker) => marker.message.startsWith('crm-slow:')).map((marker) => ({
    marker,
    events:trace.events.filter((event) => {
      if (event.ph !== 'X' || !Number(event.dur)) return false;
      const start = Number(event.ts);
      const end = start + Number(event.dur);
      return start <= marker.ts + 30000 && end >= marker.ts - 30000;
    }).map((event) => ({
      name:event.name,
      ms:Number((Number(event.dur) / 1000).toFixed(3)),
      offsetMs:Number(((Number(event.ts) - marker.ts) / 1000).toFixed(3)),
      process:processNames.get(event.pid) || String(event.pid),
      thread:threadNames.get(`${event.pid}:${event.tid}`) || String(event.tid),
      category:event.cat || '',
    })).filter((event) => event.ms >= .5).sort((a, b) => b.ms - a.ms).slice(0, 40),
  }));
  return { markers, compositorCadence, nearMarkers, longEvents, eventCount:trace.events.length };
}

async function main() {
  const profileRoom = String(process.env.CRM_PROFILE_ROOM || 'cases').trim() || 'cases';
  const roomSelector = `.crm-home-bucket[data-module="${profileRoom}"]`;
  const repeatCount = Math.max(1, Math.min(12, Number(process.env.CRM_PROFILE_REPEATS) || 1));
  const traceAll = process.env.CRM_TRACE_ALL === '1';
  const captureTransition = process.env.CRM_CAPTURE_TRANSITION === '1';
  const captureDelay = Math.max(0, Number(process.env.CRM_CAPTURE_DELAY) || 150);
  const captureDir = path.resolve(__dirname, 'electron-actual', 'transition-performance');
  let capturedAcrylic = null;
  const harness = await start();
  const app = await electron.launch({
    args:['.'],
    cwd:path.resolve(__dirname, '..', '..'),
    env:{ ...process.env, CRM_API_URL:harness.apiUrl, CRM_CDMS_DISABLED:'1' },
    timeout:30000,
  });
  try {
    const page = await app.firstWindow();
    const windowReadyAt = performance.now();
    await page.waitForLoadState('load');
    const documentLoadedAt = performance.now();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction(readyHome, null, { timeout:60000 });
    const homeReadyAt = performance.now();
    await page.waitForFunction(() => {
      const state = window.crmHome?.prewarmStatus?.();
      return !!state && !state.running && state.pending.length === 0;
    }, null, { timeout:60000 });
    const factoriesReadyAt = performance.now();
    await page.evaluate(() => window.crmHome?.waitForPreviewSync?.());
    const previewsIdleAt = performance.now();
    await sleep(160);
    const loadTiming = {
      documentLoadMs:documentLoadedAt - windowReadyAt,
      homeReadyMs:homeReadyAt - windowReadyAt,
      factoriesReadyMs:factoriesReadyAt - windowReadyAt,
      previewsIdleMs:previewsIdleAt - windowReadyAt,
    };

    const before = await page.evaluate((selector) => {
      const bucket = document.querySelector(selector);
      const image = bucket?.querySelector('.crm-home-preview-foreground');
      return {
        bucketTransform:image ? getComputedStyle(image).transform : '',
        farShift:bucket?.querySelector('.crm-home-preview')?.style.getPropertyValue('--far-shift-y') || '',
      };
    }, roomSelector);
    // Match a physical pointer interaction: entering a tile gives Chromium two
    // or more paints to upload the existing transition texture before click.
    await page.hover(roomSelector);
    await sleep(160);

    const fullBrowserTrace = traceAll ? await startBrowserTrace(page) : null;
    const inboundBrowserTrace = traceAll ? null : await startBrowserTrace(page);
    const inbound = await profileMove(
      page,
      `${profileRoom}-in`,
      async () => {
        await page.click(roomSelector);
        if (!captureTransition) return;
        await sleep(captureDelay);
        capturedAcrylic = await page.evaluate(() => {
          const surface = window.crmHomeCamera?.surface?.();
          const surfaceRect = surface?.getBoundingClientRect();
          const root = window.crmHomeCamera?.layers?.()[0];
          const host = surface?.querySelector?.('.crm-home-peripheral-acrylic-clip');
          const lens = host?.querySelector?.('.crm-home-peripheral-screen-acrylic');
          const group = surface?.querySelector?.('.crm-home-peripheral-acrylic-defs clipPath > g');
          const matrix = new DOMMatrix(getComputedStyle(group).transform);
          const mapped = [...(group?.children || [])].map((shape) => {
            const x = Number(shape.getAttribute('x')) || 0;
            const y = Number(shape.getAttribute('y')) || 0;
            const width = Number(shape.getAttribute('width')) || 0;
            const height = Number(shape.getAttribute('height')) || 0;
            const p1 = new DOMPoint(x, y).matrixTransform(matrix);
            const p2 = new DOMPoint(x + width, y + height).matrixTransform(matrix);
            return [p1.x, p1.y, p2.x - p1.x, p2.y - p1.y];
          });
          const buckets = [...(root?.querySelectorAll(':scope > .crm-home-grid > .crm-home-bucket') || [])]
            .map((bucket) => {
              const rect = bucket.getBoundingClientRect();
              return [rect.x - surfaceRect.x, rect.y - surfaceRect.y, rect.width, rect.height];
            });
          const errors = mapped.map((rect, index) =>
            Math.max(...rect.map((value, axis) => Math.abs(value - (buckets[index]?.[axis] || 0)))));
          const lensStyle = lens && getComputedStyle(lens);
          const hostStyle = host && getComputedStyle(host);
          const animation = group?.getAnimations?.()[0] || null;
          return {
            moving:window.crmDeskTransit?.motionState?.() || null,
            clip:hostStyle?.clipPath || '',
            backdrop:lensStyle?.webkitBackdropFilter || lensStyle?.backdropFilter || '',
            opacity:Number(lensStyle?.opacity || 0),
            groupTransform:getComputedStyle(group).transform || '',
            animationProperty:animation?.effect?.getKeyframes?.()?.some((frame) => frame.transform != null) ? 'transform' : '',
            animationTime:Number(animation?.currentTime),
            mapped,
            buckets,
            maxGeometryError:Math.max(0, ...errors),
          };
        });
        fs.mkdirSync(captureDir, { recursive:true });
        await page.screenshot({ path:path.join(captureDir, `${profileRoom}-mid.png`) });
      },
      () => page.waitForFunction((room) => document.body.dataset.crmModule === room && !window.crmDeskTransit?.isBusy?.(), profileRoom, { timeout:15000 }),
    );
    const inboundTrace = await finishBrowserTrace(inboundBrowserTrace);
    const retention = await page.evaluate(() => {
      const surface = window.crmHomeCamera?.surface?.();
      const root = window.crmHomeCamera?.layers?.()[0];
      const variant = root?.querySelector(':scope > .crm-home-motion-variant.is-active-motion-variant');
      const surfaceStyle = surface && getComputedStyle(surface);
      const variantStyle = variant && getComputedStyle(variant);
      return {
        hidden:surface?.hidden === true,
        key:surface?.dataset.crmHomeRetained || '',
        display:surfaceStyle?.display || '',
        zIndex:surfaceStyle?.zIndex || '',
        pointerEvents:surfaceStyle?.pointerEvents || '',
        gridVisibility:getComputedStyle(root?.querySelector(':scope > .crm-home-grid')).visibility,
        variant:variant?.dataset.motionVariant || '',
        variantDisplay:variantStyle?.display || '',
        variantOpacity:Number(variantStyle?.opacity),
        variantTransform:variantStyle?.transform || '',
        variantWillChange:variantStyle?.willChange || '',
      };
    });
    if (!retention.hidden || retention.key !== profileRoom || retention.display !== 'block'
      || retention.zIndex !== '0' || retention.pointerEvents !== 'none'
      || retention.gridVisibility !== 'hidden' || retention.variant !== profileRoom
      || retention.variantDisplay === 'none' || retention.variantOpacity !== .001
      || retention.variantTransform === 'none' || !retention.variantWillChange.includes('transform')) {
      throw new Error(`Inactive Home did not retain only its selected camera bitmap: ${JSON.stringify(retention)}`);
    }
    const browserTrace = traceAll ? null : await startBrowserTrace(page);
    const outbound = await profileMove(
      page,
      `${profileRoom}-out`,
      () => page.$eval('.crm-home-control', (button) => button.click()),
      () => page.waitForFunction(readyHome, null, { timeout:15000 }),
    );
    const trace = await finishBrowserTrace(browserTrace);
    const repeats = [];
    for (let index = 0; index < repeatCount; index += 1) {
      await page.evaluate(() => window.crmHome?.waitForPreviewSync?.());
      await page.hover(roomSelector);
      await sleep(160);
      const repeatInbound = await profileMove(
        page,
        `${profileRoom}-repeat-${index + 1}-in`,
        () => page.click(roomSelector),
        () => page.waitForFunction((room) => document.body.dataset.crmModule === room && !window.crmDeskTransit?.isBusy?.(), profileRoom, { timeout:15000 }),
      );
      const repeatOutbound = await profileMove(
        page,
        `${profileRoom}-repeat-${index + 1}-out`,
        () => page.$eval('.crm-home-control', (button) => button.click()),
        () => page.waitForFunction(readyHome, null, { timeout:15000 }),
      );
      repeats.push({ inbound:repeatInbound, outbound:repeatOutbound });
    }
    const fullTrace = await finishBrowserTrace(fullBrowserTrace);
    const repeatInbound = repeats[0]?.inbound || null;
    const repeatOutbound = repeats[0]?.outbound || null;
    const acrylicGeometry = await page.evaluate(() => {
      const surface = window.crmHomeCamera?.surface?.();
      const host = surface?.querySelector?.('.crm-home-peripheral-acrylic-clip');
      const lens = host?.querySelector?.('.crm-home-peripheral-screen-acrylic');
      const group = surface?.querySelector?.('.crm-home-peripheral-acrylic-defs clipPath > g');
      const hostStyle = host && getComputedStyle(host);
      const lensStyle = lens && getComputedStyle(lens);
      return {
        clip:hostStyle?.clipPath || '',
        backdrop:lensStyle?.webkitBackdropFilter || lensStyle?.backdropFilter || '',
        opacity:Number(lensStyle?.opacity || 0),
        shapes:group?.children?.length || 0,
        transform:getComputedStyle(group).transform || '',
      };
    });
    const evidence = { profileRoom, repeatCount, loadTiming, before, retention, capturedAcrylic, acrylicGeometry, inbound, outbound, repeatInbound, repeatOutbound, repeats, inboundTrace, trace, fullTrace };
    console.log(JSON.stringify(evidence, null, 2));
    const visibleMoves = [inbound, outbound, ...repeats.flatMap((repeat) => [repeat.inbound, repeat.outbound])];
    if (!captureTransition && (before.bucketTransform !== 'none' || before.farShift
      || visibleMoves.some((probe) => Math.round(probe.fps) !== 100
        || probe.p95Ms > 11 || probe.maxMs > 15 || probe.over15Ms
        || probe.revealFrames || probe.longTasks.length))) {
      throw new Error(`Transition profiler missed its budget: ${JSON.stringify(evidence)}`);
    }
  } finally {
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.exit(0));
      return true;
    }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), sleep(3000)]);
    harness.stop();
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
