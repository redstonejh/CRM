'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron:electron } = require('playwright');
const { PNG } = require('pngjs');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OUTPUT_DIR = path.resolve(__dirname, 'electron-actual', 'calendar-transition');
const EVIDENCE_PATH = path.join(OUTPUT_DIR, 'evidence.json');
const YEAR_SCREENSHOT_PATH = path.join(OUTPUT_DIR, 'calendar-year-true-acrylic.png');
const MONTH_SCREENSHOT_PATH = path.join(OUTPUT_DIR, 'calendar-month-true-acrylic.png');
const MONTH_TRACE_PATH = path.join(OUTPUT_DIR, 'month-in-trace.json');
const DAY_TRACE_PATH = path.join(OUTPUT_DIR, 'day-in-trace.json');
const MATERIAL_HANDOFF_MS = 72;

async function startTransitionTrace(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Tracing.start', {
    categories:[
      'blink',
      'cc',
      'devtools.timeline',
      'gpu',
      'toplevel',
      'viz',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.layers',
    ].join(','),
    transferMode:'ReturnAsStream',
  });
  return session;
}

async function saveTransitionTrace(session, outputPath) {
  if (!session) return;
  const complete = new Promise((resolve) => {
    session.once('Tracing.tracingComplete', resolve);
  });
  await session.send('Tracing.end');
  const { stream } = await complete;
  const chunks = [];
  for (;;) {
    const result = await session.send('IO.read', { handle:stream });
    if (result.data) chunks.push(result.base64Encoded
      ? Buffer.from(result.data, 'base64')
      : Buffer.from(result.data));
    if (result.eof) break;
  }
  await session.send('IO.close', { handle:stream });
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
  await session.detach();
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function summarizeCadence(values) {
  const samples = values.filter((value) => Number.isFinite(value) && value > 0);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const medianMs = percentile(samples, .5);
  return {
    frames:samples.length,
    fps:total ? samples.length * 1000 / total : 0,
    cadenceHz:medianMs ? 1000 / medianMs : 0,
    medianMs,
    p95Ms:percentile(samples, .95),
    maxMs:Math.max(0, ...samples),
    over15Ms:samples.filter((value) => value > 15).length,
    over20Ms:samples.filter((value) => value > 20).length,
  };
}

function compareDayAcrylicPixels(enabledBuffer, disabledBuffer, geometry) {
  const enabled = PNG.sync.read(enabledBuffer);
  const disabled = PNG.sync.read(disabledBuffer);
  if (enabled.width !== disabled.width || enabled.height !== disabled.height) {
    throw new Error('Calendar acrylic screenshots do not share one geometry');
  }
  const scaleX = enabled.width / Math.max(1, geometry.viewport.width);
  const scaleY = enabled.height / Math.max(1, geometry.viewport.height);
  const mask = new Uint8Array(enabled.width * enabled.height);
  geometry.rects.forEach((rect) => {
    const left = Math.max(0, Math.floor(rect.left * scaleX));
    const top = Math.max(0, Math.floor(rect.top * scaleY));
    const right = Math.min(enabled.width, Math.ceil(rect.right * scaleX));
    const bottom = Math.min(enabled.height, Math.ceil(rect.bottom * scaleY));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) mask[(y * enabled.width) + x] = 1;
    }
  });
  let insideCount = 0;
  let insideTotal = 0;
  let insideMax = 0;
  let outsideCount = 0;
  let outsideTotal = 0;
  for (let index = 0, pixel = 0; index < enabled.data.length; index += 4, pixel += 1) {
    const difference = Math.abs(enabled.data[index] - disabled.data[index])
      + Math.abs(enabled.data[index + 1] - disabled.data[index + 1])
      + Math.abs(enabled.data[index + 2] - disabled.data[index + 2]);
    if (mask[pixel]) {
      insideCount += 1;
      insideTotal += difference;
      insideMax = Math.max(insideMax, difference);
    } else {
      outsideCount += 1;
      outsideTotal += difference;
    }
  }
  return {
    tileCount:geometry.rects.length,
    insideMean:insideTotal / Math.max(1, insideCount),
    insideMax,
    outsideMean:outsideTotal / Math.max(1, outsideCount),
  };
}

async function measureDayAcrylicPixels(page) {
  const geometry = await page.evaluate(() => ({
    viewport:{ width:innerWidth, height:innerHeight },
    rects:[...document.querySelectorAll(
      '.fc-expander[data-kind="month"]:not(.fc-warm) .fc-day',
    )].map((day) => {
      const rect = day.getBoundingClientRect();
      return {
        left:rect.left,
        top:rect.top,
        right:rect.right,
        bottom:rect.bottom,
      };
    }),
  }));
  const enabled = await page.screenshot();
  const override = await page.addStyleTag({
    content:'.fc-day-screen-material{'
      + '-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
  });
  await page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  const disabled = await page.screenshot();
  await override.evaluate((element) => element.remove());
  await page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  return compareDayAcrylicPixels(enabled, disabled, geometry);
}

async function seedCalendarProof(apiUrl) {
  const fields = {
    id:'calendar_transition_item',
    title:'Scheduled network check',
    date:'2026-07-15',
    at:'2026-07-15T16:00:00.000Z',
    kind:'ticket',
    priority:'medium',
    state:'open',
    description:'Deterministic scheduled tile used by the Calendar transition profiler.',
  };
  const response = await fetch(`${apiUrl}/api/entities/calendarItems`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ fields, actor:'calendar-profiler' }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Calendar proof seed failed: ${result.error}`);
  return { calendarItems:1 };
}

async function measureIdleCadence(page, frames = 100) {
  return page.evaluate((wanted) => new Promise((resolve) => {
    const deltas = [];
    let previous = 0;
    const tick = (now) => {
      if (previous) deltas.push(now - previous);
      previous = now;
      if (deltas.length >= wanted) {
        resolve(deltas.slice(2));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

async function measureAnimatedSurfaceCadence(page, selector, frames = 100) {
  return page.evaluate(({ targetSelector, wanted }) => new Promise((resolve, reject) => {
    const target = document.querySelector(targetSelector);
    if (!target) {
      reject(new Error(`Missing animated cadence target: ${targetSelector}`));
      return;
    }
    const previousTransform = target.style.transform;
    const previousWillChange = target.style.willChange;
    target.style.willChange = 'transform';
    const deltas = [];
    let previous = 0;
    let frame = 0;
    const finish = () => {
      target.style.transform = previousTransform;
      target.style.willChange = previousWillChange;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(deltas.slice(2))));
    };
    const tick = (now) => {
      if (previous) deltas.push(now - previous);
      previous = now;
      frame += 1;
      target.style.transform = `translate3d(${(Math.sin(frame * .16) * 5).toFixed(3)}px,0,0)`;
      if (deltas.length >= wanted) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { targetSelector:selector, wanted:frames });
}

async function installProfiler(page) {
  await page.evaluate(() => {
    window.__calendarTransitionProfiler?.destroy?.();

    const legacySelector = [
      '.fc-frost',
      '.fc-day-frost',
      '.fc-level-material',
      '.fc-transition-portal',
      '.fc-below-snapshot',
      '.fc-below-material-scene',
      '.fc-strip-texture',
    ].join(',');
    const state = {
      armed:null,
      active:null,
      records:[],
      observer:null,
      longTaskObserver:null,
      destroyed:false,
    };

    const effectiveOpacity = (node, stop) => {
      let opacity = 1;
      let cursor = node;
      while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
        const style = getComputedStyle(cursor);
        if (style.display === 'none' || style.visibility !== 'visible') return 0;
        opacity *= Number(style.opacity);
        if (cursor === stop) break;
        cursor = cursor.parentElement;
      }
      return opacity;
    };
    const keyframesFor = (node) => (node?.getAnimations?.() || [])
      .filter((animation) => !['finished', 'idle'].includes(animation.playState))
      .flatMap((animation) => animation.effect?.getKeyframes?.() || []);
    const animatedProperty = (frames, property) => {
      const values = frames
        .map((frame) => frame[property])
        .filter((value) => value != null && value !== '');
      return new Set(values).size > 1;
    };
    const auditMotion = () => {
      const camera = window.fractalCalendarCamera;
      const surface = camera?.surface?.();
      const lens = [...(surface?.querySelectorAll('.fc-source-screen-acrylic') || [])]
        .find((candidate) => candidate.dataset.fractalAcrylicPhase === 'motion');
      const clipOwner = lens?.parentElement || null;
      if (!clipOwner || !lens || lens.dataset.fractalAcrylicPhase !== 'motion') return null;
      const ownerFrames = keyframesFor(clipOwner);
      const lensFrames = keyframesFor(lens);
      const sharedDayOwner = surface.querySelector(
        ':scope > .fc-day-screen-material-owner',
      );
      const sharedDayFrames = keyframesFor(sharedDayOwner);
      const sharedDayStyle = sharedDayOwner && getComputedStyle(sharedDayOwner);
      const ownerStyle = getComputedStyle(clipOwner);
      const lensStyle = getComputedStyle(lens);
      const cover = surface.querySelector(':scope > .fc-live-backdrop-cover');
      const coverFrames = keyframesFor(cover);
      const sourcePhoto = document.querySelector('body > .workspace-photo-backdrop');
      const sourcePhotoPanels = [...(sourcePhoto?.querySelectorAll('.workspace-photo-panel') || [])];
      const coverPhotoPanels = [...(cover?.querySelectorAll(
        '.fc-live-backdrop-wallpaper > .workspace-photo-backdrop .workspace-photo-panel',
      ) || [])];
      const backdropCandidates = [...surface.querySelectorAll(
        '.crm-tile-material-plane,.fc-day-screen-material,.fc-source-screen-acrylic',
      )].map((node) => {
        const style = getComputedStyle(node);
        return {
          node,
          className:node.className,
          phase:node.dataset.fractalAcrylicPhase || '',
          backdrop:style.webkitBackdropFilter || style.backdropFilter,
          opacity:Number(style.opacity),
          effectiveOpacity:effectiveOpacity(node, surface),
          visibility:style.visibility,
          display:style.display,
        };
      });
      const backdropOwners = backdropCandidates.filter((candidate) => (
        String(candidate.backdrop).includes('blur(')
          && candidate.effectiveOpacity > 0
      ));
      return {
        lensPhase:lens.dataset.fractalAcrylicPhase,
        lensDirection:lens.dataset.fractalAcrylicDirection,
        ownerClip:String(ownerStyle.clipPath),
        ownerClipIsPath:String(ownerStyle.clipPath).startsWith('path('),
        ownerClipIsInset:String(ownerStyle.clipPath).startsWith('inset('),
        ownerClipLength:String(ownerStyle.clipPath).length,
        lensBackdrop:lensStyle.webkitBackdropFilter || lensStyle.backdropFilter,
        lensBackdropOwner:lens.dataset.crmAcrylicBackdropOwner || '',
        lensOpacity:Number(lensStyle.opacity),
        lensEffectiveOpacity:effectiveOpacity(lens, surface),
        ownerTransformAnimated:animatedProperty(ownerFrames, 'transform'),
        lensTransformAnimated:animatedProperty(lensFrames, 'transform'),
        ownerClipAnimated:animatedProperty(ownerFrames, 'clipPath')
          || animatedProperty(ownerFrames, 'webkitClipPath'),
        ownerAnimationCount:clipOwner.getAnimations().length,
        lensAnimationCount:lens.getAnimations().length,
        sharedDayClipAnimated:animatedProperty(sharedDayFrames, 'clipPath')
          || animatedProperty(sharedDayFrames, 'webkitClipPath'),
        sharedDayClipIsPath:String(sharedDayStyle?.clipPath || '').startsWith('path('),
        sharedDayAnimationCount:sharedDayOwner?.getAnimations?.().length || 0,
        visibleBackdropOwnerCount:backdropOwners.length,
        backdropCandidates:backdropCandidates.map(({ node:_node, ...candidate }) => candidate),
        liveBackdropCover:{
          present:!!cover,
          opacity:Number(getComputedStyle(cover).opacity),
          opacityAnimated:animatedProperty(coverFrames, 'opacity'),
          transformAnimated:animatedProperty(coverFrames, 'transform'),
          clipAnimated:animatedProperty(coverFrames, 'clipPath')
            || animatedProperty(coverFrames, 'webkitClipPath'),
          sourcePhotoPanels:sourcePhotoPanels.length,
          clonedPhotoPanels:coverPhotoPanels.length,
          panelsMatch:sourcePhotoPanels.length === coverPhotoPanels.length
            && sourcePhotoPanels.every((panel, index) => (
              panel.style.backgroundImage === coverPhotoPanels[index]?.style?.backgroundImage
            )),
          rasterNodeCount:cover?.querySelectorAll('canvas,video,img.fc-strip-texture').length || 0,
        },
        legacyNodeCount:surface.querySelectorAll(legacySelector).length,
        rasterNodeCount:surface.querySelectorAll('canvas,video,img.fc-strip-texture').length,
      };
    };
    const finishRecord = (record) => {
      if (record.done) return;
      record.done = true;
      record.completedAt = performance.now();
      state.records.push(record);
      if (state.active === record) state.active = null;
    };
    const tick = (record, now) => {
      if (state.destroyed || record.done) return;
      if (record.firstFrameAt == null) {
        record.firstFrameAt = now;
        record.firstFrameLatencyMs = Math.max(0, performance.now() - record.eventAt);
      } else {
        const delta = now - record.previousFrameAt;
        record.deltas.push(delta);
        record.timedDeltas.push({ delta, elapsed:now - record.eventAt });
      }
      record.previousFrameAt = now;
      if (record.captureAudit && !record.motionAudit) record.motionAudit = auditMotion();
      if (record.settledAt != null) {
        record.settledPaints += 1;
        if (record.settledPaints >= 2) {
          finishRecord(record);
          return;
        }
      }
      requestAnimationFrame((next) => tick(record, next));
    };
    const onNavigation = (event) => {
      if (event.detail?.apiName !== 'fractalCalendarCamera') return;
      if (event.detail.phase === 'start') {
        const armed = state.armed || {
          label:`calendar-${event.detail.direction}-${state.records.length + 1}`,
          armedAt:performance.now(),
        };
        const record = {
          label:armed.label,
          direction:event.detail.direction,
          startLevel:event.detail.level,
          armedAt:armed.armedAt,
          eventAt:performance.now(),
          eventLatencyMs:performance.now() - armed.armedAt,
          firstFrameAt:null,
          firstFrameLatencyMs:null,
          previousFrameAt:null,
          settledAt:null,
          settledPaints:0,
          deltas:[],
          timedDeltas:[],
          longTasks:[],
          childMutations:0,
          addedNodes:0,
          removedNodes:0,
          captureAudit:armed.captureAudit === true,
          motionAudit:null,
          done:false,
        };
        state.armed = null;
        state.active = record;
        requestAnimationFrame((now) => tick(record, now));
      } else if (event.detail.phase === 'settled' && state.active) {
        state.active.settledAt = performance.now();
        state.active.endLevel = event.detail.level;
      }
    };
    document.addEventListener('crm:camera-navigation', onNavigation);

    state.observer = new MutationObserver((records) => {
      const record = state.active;
      if (!record) return;
      records.forEach((mutation) => {
        if (mutation.type !== 'childList') return;
        record.childMutations += 1;
        record.addedNodes += mutation.addedNodes.length;
        record.removedNodes += mutation.removedNodes.length;
      });
    });
    state.observer.observe(window.fractalCalendarCamera.surface(), {
      childList:true,
      subtree:true,
    });
    try {
      state.longTaskObserver = new PerformanceObserver((list) => {
        if (!state.active) return;
        list.getEntries().forEach((entry) => {
          const record = state.active;
          if (!record) return;
          const startOffsetMs = entry.startTime - record.eventAt;
          record.longTasks.push({
            durationMs:Number(entry.duration.toFixed(2)),
            startOffsetMs:Number(startOffsetMs.toFixed(2)),
            endOffsetMs:Number((startOffsetMs + entry.duration).toFixed(2)),
          });
        });
      });
      state.longTaskObserver.observe({ entryTypes:['longtask'] });
    } catch {}

    window.__calendarTransitionProfiler = {
      arm(label, captureAudit = false) {
        state.armed = { label, captureAudit, armedAt:performance.now() };
      },
      record(label) {
        return state.records.find((entry) => entry.label === label) || null;
      },
      records() {
        return state.records;
      },
      destroy() {
        state.destroyed = true;
        state.observer?.disconnect();
        state.longTaskObserver?.disconnect();
        document.removeEventListener('crm:camera-navigation', onNavigation);
      },
    };
  });
}

async function profileMove(page, label, action, endLevel, {
  captureAudit = false,
  prepare = null,
} = {}) {
  if (typeof prepare === 'function') await prepare();
  await page.evaluate(({ name, audit }) => (
    window.__calendarTransitionProfiler.arm(name, audit)
  ), { name:label, audit:captureAudit });
  await action();
  await page.waitForFunction((level) => (
    window.fractalCalendar.level() === level
    && !window.fractalCalendarCamera.isTransitioning()
  ), endLevel, { timeout:15000 });
  await page.waitForFunction((name) => (
    window.__calendarTransitionProfiler.record(name)?.done === true
  ), label, { timeout:5000 });
  const raw = await page.evaluate((name) => (
    window.__calendarTransitionProfiler.record(name)
  ), label);
  const durationMs = raw.settledAt - raw.eventAt;
  const longTasks = raw.longTasks.map((entry) => {
    const motionOverlapMs = Math.max(
      0,
      Math.min(entry.endOffsetMs, durationMs) - Math.max(entry.startOffsetMs, 0),
    );
    return {
      ...entry,
      motionOverlapMs:Number(motionOverlapMs.toFixed(2)),
      phase:entry.endOffsetMs <= durationMs
        ? 'motion'
        : entry.startOffsetMs >= durationMs
          ? 'handoff'
          : 'boundary',
    };
  });
  return {
    label:raw.label,
    direction:raw.direction,
    startLevel:raw.startLevel,
    endLevel:raw.endLevel,
    eventLatencyMs:raw.eventLatencyMs,
    firstFrameLatencyMs:raw.firstFrameLatencyMs,
    durationMs,
    longTasks,
    childMutations:raw.childMutations,
    addedNodes:raw.addedNodes,
    removedNodes:raw.removedNodes,
    motionAudit:raw.motionAudit,
    stalls:raw.timedDeltas
      .filter((sample) => sample.delta > 15)
      .map((sample) => ({
        elapsedMs:Number(sample.elapsed.toFixed(2)),
        deltaMs:Number(sample.delta.toFixed(2)),
      })),
    cadence:summarizeCadence(raw.deltas),
    transformCadence:summarizeCadence(
      raw.timedDeltas
        .filter((sample) => sample.elapsed <= durationMs)
        .map((sample) => sample.delta),
    ),
    handoffCadence:summarizeCadence(
      raw.timedDeltas
        .filter((sample) => sample.elapsed > durationMs)
        .map((sample) => sample.delta),
    ),
  };
}

async function auditArchitecture(page, phase) {
  return page.evaluate((auditPhase) => {
    const camera = window.fractalCalendarCamera;
    const surface = camera.surface();
    const effectiveOpacity = (node, stop) => {
      let opacity = 1;
      for (let cursor = node; cursor; cursor = cursor.parentElement) {
        const style = getComputedStyle(cursor);
        if (style.display === 'none' || style.visibility !== 'visible') return 0;
        opacity *= Number(style.opacity);
        if (cursor === stop) break;
      }
      return opacity;
    };
    const root = surface.querySelector(':scope > .fc-level[data-kind="year"]');
    const rootMonths = [...root.querySelectorAll(':scope > .fc-grid > .fc-month')];
    const rootPreviews = [...root.querySelectorAll(
      ':scope > .fc-grid > .fc-month > .fc-calendar-tile-preview',
    )];
    const rootPreviewImages = rootPreviews.map((preview) => (
      preview.querySelector(':scope > .fc-calendar-tile-preview-render')
    )).filter(Boolean);
    const syntheticRootNodes = [...root.querySelectorAll(
      ':scope > .fc-grid .fc-day-preview-cell',
    )];
    const rootDays = [...root.querySelectorAll(':scope > .fc-grid > .fc-month .fc-day')];
    const warmMonthShells = [...surface.querySelectorAll(
      ':scope > .fc-expander.fc-warm[data-kind="month"]',
    )];
    const warmMonthDays = [...surface.querySelectorAll(
      ':scope > .fc-expander.fc-warm[data-kind="month"] .fc-day',
    )];
    const rootPlanes = [...root.querySelectorAll(
      ':scope > .fc-year-screen-material-owner > .crm-tile-material-plane',
    )];
    if (!rootPlanes.length) {
      rootPlanes.push(...surface.querySelectorAll(
        ':scope > .fc-year-screen-material-owner > .crm-tile-material-plane',
      ));
    }
    const activeMonth = surface.querySelector(
      ':scope > .fc-expander[data-kind="month"]:not(.fc-warm)',
    );
    const monthLive = activeMonth?.querySelector(':scope > .fc-expander-live');
    const monthCollection = monthLive?.querySelector(':scope > .fc-day-stage > .fc-days');
    const monthDays = [...(monthLive?.querySelectorAll(
      ':scope > .fc-day-stage > .fc-days > .fc-day',
    ) || [])];
    const monthDayPreviews = monthDays.map((day) => (
      day.querySelector(':scope > .fc-calendar-tile-preview')
    )).filter(Boolean);
    const monthDayPreviewImages = monthDayPreviews.map((preview) => (
      preview.querySelector(':scope > .fc-calendar-tile-preview-render')
    )).filter(Boolean);
    const monthPlane = monthLive?.querySelector(':scope > .crm-tile-material-plane');
    const screenDayOwner = surface.querySelector(':scope > .fc-day-screen-material-owner');
    const screenDayPlane = screenDayOwner?.querySelector(':scope > .fc-day-screen-material');
    const activeDay = surface.querySelector(
      ':scope > .fc-expander[data-kind="day"]:not(.fc-warm)',
    );
    const activeDayLive = activeDay?.querySelector(':scope > .fc-expander-live');
    const retainedDayLens = [...surface.querySelectorAll('.fc-source-screen-acrylic')]
      .find((lens) => lens.dataset.fractalAcrylicPhase === 'retained-endpoint');
    const retainedDayOwner = retainedDayLens?.parentElement || null;
    const objectFor = window.fractalCalendar._objectForElement;
    const objectGraph = window.fractalCalendar._objectGraph();
    const graphDays = objectGraph.children.flatMap((month) => month.children || []);
    const homeTile = document.querySelector(
      '.crm-home-level > .crm-home-grid > [data-crm-tile-instance="viewport"]',
    );
    const objectShape = (object) => Object.keys(object || {}).sort().join('|');
    const componentChildren = (element) => [...(element?.children || [])].map(
      (child) => `${child.tagName}:${child.classList.contains('crm-home-preview')}`,
    ).join('|');
    const calendarIndex = window.fractalCalendar._objectIndex();
    const homeIndex = window.crmHome?._objectIndex?.();
    const liveBackdropCover = surface.querySelector(':scope > .fc-live-backdrop-cover');
    const legacySelector = [
      '.fc-frost',
      '.fc-day-frost',
      '.fc-level-material',
      '.fc-transition-portal',
      '.fc-below-snapshot',
      '.fc-below-material-scene',
      '.fc-strip-texture',
    ].join(',');
    const tileAudit = (tiles, expectedKind = 'calendar-day') => {
      const objects = tiles.map((tile) => objectFor(tile)).filter(Boolean);
      return {
        count:tiles.length,
        buttonCount:tiles.filter((tile) => tile.tagName === 'BUTTON').length,
        sharedClassCount:tiles.filter((tile) => tile.classList.contains('crm-home-bucket')).length,
        canonicalClassCount:tiles.filter((tile) => tile.classList.contains('crm-tile')).length,
        viewportInstanceCount:tiles.filter(
          (tile) => tile.dataset.crmTileInstance === 'viewport',
        ).length,
        schemaCount:tiles.filter((tile) => tile.dataset.tileSchemaVersion === '1').length,
        identityCount:new Set(tiles.map((tile) => tile.dataset.tileId)).size,
        targetCount:new Set(tiles.map((tile) => tile.dataset.tileTargetId)).size,
        calendarKindCount:tiles.filter((tile) => tile.dataset.tileKind === expectedKind).length,
        objectBoundCount:objects.length,
        canonicalObjectCount:objects.filter((object) => window.crmTileSystem.isObject(object)).length,
        objectIdentityCount:new Set(objects).size,
        directBackdropCount:tiles.filter((tile) => {
          const style = getComputedStyle(tile);
          return !!style && String(
            style.webkitBackdropFilter || style.backdropFilter,
          ).includes('blur(');
        }).length,
        visibleBackdropCount:tiles.filter((tile) => {
          const style = getComputedStyle(tile);
          return !!style
            && style.display !== 'none'
            && style.visibility === 'visible'
            && Number(style.opacity) > .998
            && String(style.webkitBackdropFilter || style.backdropFilter).includes('blur(');
        }).length,
      };
    };
    const tileSurfaceAudit = (tile) => {
      if (!tile) return null;
      const style = getComputedStyle(tile);
      return {
        backdrop:style.webkitBackdropFilter || style.backdropFilter,
        background:style.backgroundImage,
        opacity:Number(style.opacity),
        sharedComponent:tile.matches(
          '.crm-tile.crm-home-bucket[data-crm-tile-instance="viewport"]',
        ),
        previewChildren:tile.querySelectorAll(':scope > .crm-home-preview').length,
        otherChildren:tile.querySelectorAll(':scope > :not(.crm-home-preview)').length,
      };
    };
    const planeAudit = (plane) => {
      if (!plane) return null;
      const style = getComputedStyle(plane);
      return {
        count:Number(plane.dataset.crmTileMaterialCount || 0),
        ready:plane.dataset.crmTileMaterialReady === 'true',
        clipIsPath:String(style.clipPath).startsWith('path('),
        clipIsUrl:String(style.clipPath).startsWith('url('),
        clipIsActive:String(style.clipPath) !== 'none',
        clipLength:String(style.clipPath).length,
        maskIsActive:String(style.maskImage || style.webkitMaskImage) !== 'none',
        maskMode:plane.dataset.crmTileMaterialMode || '',
        backdrop:style.webkitBackdropFilter || style.backdropFilter,
        opacity:Number(style.opacity),
        muted:plane.dataset.crmTileMaterialMuted === 'true',
      };
    };
    const screenPlaneAudit = (owner, plane) => {
      if (!owner || !plane) return null;
      const ownerStyle = getComputedStyle(owner);
      const planeStyle = getComputedStyle(plane);
      const clip = String(ownerStyle.clipPath) !== 'none'
        ? String(ownerStyle.clipPath)
        : String(planeStyle.clipPath);
      return {
        count:Number(plane.dataset.crmTileMaterialCount || 0),
        ready:plane.dataset.crmTileMaterialReady === 'true',
        ownerHidden:owner.hidden,
        ownerClipIsPath:clip.startsWith('path('),
        ownerClipIsUrl:clip.startsWith('url('),
        ownerClipLength:clip.length,
        backdrop:planeStyle.webkitBackdropFilter || planeStyle.backdropFilter,
        opacity:Number(planeStyle.opacity),
        visibility:planeStyle.visibility,
      };
    };
    const rootPlaneAudits = rootPlanes.map(planeAudit);
    const referenceMonth = document.querySelector('.crm-home-grid > .crm-home-bucket');
    const referenceMonthStyle = referenceMonth && getComputedStyle(referenceMonth);
    const referenceMonthDirectBackdrop = referenceMonthStyle
      && (referenceMonthStyle.webkitBackdropFilter || referenceMonthStyle.backdropFilter);
    const referenceHomePlane = document.querySelector(
      '.crm-home-peripheral-screen-acrylic',
    );
    const referenceHomePlaneStyle = referenceHomePlane && getComputedStyle(referenceHomePlane);
    const referenceMonthBackdrop = referenceMonthDirectBackdrop
      && referenceMonthDirectBackdrop !== 'none'
      ? referenceMonthDirectBackdrop
      : (referenceHomePlaneStyle
        && (referenceHomePlaneStyle.webkitBackdropFilter || referenceHomePlaneStyle.backdropFilter));
    const rootStyle = getComputedStyle(root);
    const gridStyle = getComputedStyle(root.querySelector(':scope > .fc-grid'));
    const sourcePhoto = document.querySelector('body > .workspace-photo-backdrop');
    const sourcePhotoPanels = [...(sourcePhoto?.querySelectorAll('.workspace-photo-panel') || [])];
    const coverPhotoPanels = [...(liveBackdropCover?.querySelectorAll(
      '.fc-live-backdrop-wallpaper > .workspace-photo-backdrop .workspace-photo-panel',
    ) || [])];
    const coverStyle = liveBackdropCover && getComputedStyle(liveBackdropCover);
    const coverSceneStyle = liveBackdropCover
      && getComputedStyle(liveBackdropCover.querySelector('.fc-live-backdrop-scene'));
    const prewarmLenses = [...surface.querySelectorAll(
      '.fc-source-screen-acrylic[data-fractal-acrylic-phase="prewarm"]',
    )];
    return {
      phase:auditPhase,
      level:window.fractalCalendar.level(),
      rootTiles:tileAudit(rootMonths, 'calendar-month'),
      rootCollection:{
        owner:root.querySelector(':scope > .fc-grid')?.dataset.crmTileCollection || '',
        expected:objectGraph.tile.id,
        count:Number(root.querySelector(':scope > .fc-grid')?.dataset.crmTileChildCount || 0),
      },
      rootPreview:{
        count:rootPreviews.length,
        imageCount:rootPreviewImages.length,
        readyCount:rootPreviews.filter((preview) => preview.dataset.previewState === 'ready').length,
        rendererCount:rootPreviews.filter(
          (preview) => preview.dataset.previewRenderer === 'calendar-month-full',
        ).length,
        provenanceChildCount:rootPreviews.filter((preview, index) => (
          Number(preview.dataset.previewCanonicalChildren)
            === objectFor(rootMonths[index])?.children?.length
        )).length,
        inertCount:rootPreviews.filter((preview) => (
          preview.tagName === 'DIV'
          && !preview.matches('button,[data-crm-tile],.crm-home-bucket')
          && getComputedStyle(preview).pointerEvents === 'none'
        )).length,
        backdropCount:rootPreviewImages.filter((preview) => String(
          getComputedStyle(preview).webkitBackdropFilter
            || getComputedStyle(preview).backdropFilter,
        ).includes('blur(')).length,
        syntheticDayCount:syntheticRootNodes.length,
        realDayCount:rootDays.length,
        warmRealDayCount:warmMonthDays.length,
      },
      warmMonthCache:{
        shellCount:warmMonthShells.length,
        inertShellCount:warmMonthShells.filter((shell) => {
          const style = getComputedStyle(shell);
          return Number(style.opacity) <= .001
            && style.pointerEvents === 'none';
        }).length,
        shellSharesGraphObject:warmMonthShells.every((shell) => (
          objectGraph.children.includes(objectFor(shell))
        )),
        tiles:tileAudit(warmMonthDays),
        graphOwnedDayCount:warmMonthDays.filter((day) => (
          graphDays.includes(objectFor(day))
        )).length,
        readyPreviewCount:warmMonthDays.filter((day) => (
          day.querySelector(':scope > .fc-calendar-tile-preview')
            ?.dataset.previewState === 'ready'
        )).length,
      },
      rootMaterials:{
        planeCount:rootPlaneAudits.length,
        tileCount:rootPlaneAudits.reduce((sum, plane) => sum + plane.count, 0),
        readyCount:rootPlaneAudits.filter((plane) => plane.ready).length,
        pathCount:rootPlaneAudits.filter((plane) => plane.clipIsPath).length,
        urlClipCount:rootPlaneAudits.filter((plane) => plane.clipIsUrl).length,
        maskCount:rootPlaneAudits.filter((plane) => plane.maskIsActive).length,
        backdropCount:rootPlaneAudits.filter(
          (plane) => String(plane.backdrop).includes('blur('),
        ).length,
        minTileCount:rootPlaneAudits.length
          ? Math.min(...rootPlaneAudits.map((plane) => plane.count))
          : 0,
        maxTileCount:rootPlaneAudits.length
          ? Math.max(...rootPlaneAudits.map((plane) => plane.count))
          : 0,
        maxClipLength:rootPlaneAudits.length
          ? Math.max(...rootPlaneAudits.map((plane) => plane.clipLength))
          : 0,
        visibleCount:rootPlaneAudits.filter((plane) => plane.opacity > .998).length,
      },
      liveBackdropCover:{
        present:!!liveBackdropCover,
        visible:!!liveBackdropCover && !liveBackdropCover.hidden
          && coverStyle?.display !== 'none'
          && coverStyle?.visibility === 'visible'
          && Number(coverStyle?.opacity || 0) > .01,
        opacity:Number(coverStyle?.opacity || 0),
        clipIsInset:String(coverStyle?.clipPath || '').startsWith('inset('),
        sceneTransform:coverSceneStyle?.transform || '',
        sourcePhotoPanels:sourcePhotoPanels.length,
        clonedPhotoPanels:coverPhotoPanels.length,
        panelsMatch:sourcePhotoPanels.length === coverPhotoPanels.length
          && sourcePhotoPanels.every((panel, index) => (
            panel.style.backgroundImage === coverPhotoPanels[index]?.style?.backgroundImage
          )),
        rasterNodeCount:liveBackdropCover
          ?.querySelectorAll('canvas,video,img.fc-strip-texture').length || 0,
      },
      rootSurfaceClear:(
        !String(rootStyle.webkitBackdropFilter || rootStyle.backdropFilter).includes('blur(')
        && !String(gridStyle.webkitBackdropFilter || gridStyle.backdropFilter).includes('blur(')
      ),
      monthTilesMatchHome:!!referenceMonthStyle && rootMonths.every((month) => {
        const style = getComputedStyle(month);
        return style.backgroundImage === referenceMonthStyle.backgroundImage
          && (style.webkitBackdropFilter || style.backdropFilter) === 'none';
      }) && rootPlaneAudits.length === 1
        && rootPlaneAudits[0].backdrop === referenceMonthBackdrop,
      monthMaterialParity:{
        referenceBackground:referenceMonthStyle?.backgroundImage || '',
        monthBackgrounds:[...new Set(rootMonths.map(
          (month) => getComputedStyle(month).backgroundImage,
        ))],
        referenceBackdrop:referenceMonthBackdrop || '',
        directBackdrops:[...new Set(rootMonths.map((month) => {
          const style = getComputedStyle(month);
          return style.webkitBackdropFilter || style.backdropFilter;
        }))],
        planeBackdrop:rootPlaneAudits[0]?.backdrop || '',
      },
      prewarmMaterials:{
        count:prewarmLenses.length,
        maxOpacity:Math.max(0, ...prewarmLenses.map((lens) => Number(
          getComputedStyle(lens).opacity,
        ))),
      },
      activeMonth:activeMonth ? {
        month:activeMonth.dataset.month,
        tiles:tileAudit(monthDays),
        shellSharesRootObject:objectFor(activeMonth) === objectFor(rootMonths.find(
          (month) => month.dataset.month === activeMonth.dataset.month,
        )),
        dayObjectsSharedWithGraph:monthDays.filter(
          (day) => objectFor(day) === graphDays.find(
            (object) => window.crmTileSystem.dataOf(object)?.date === day.dataset.date,
          ),
        ).length,
        oneNodeShape:objectShape(objectFor(homeTile)) === objectShape(objectFor(activeMonth))
          && objectShape(objectFor(activeMonth)) === objectShape(objectFor(monthDays[0])),
        oneComponent:componentChildren(homeTile) === componentChildren(rootMonths[0])
          && componentChildren(rootMonths[0]) === componentChildren(monthDays[0]),
        treePath:calendarIndex.pathTo(objectFor(monthDays[0])),
        treeIndexOwnsDay:calendarIndex.objectForId(objectFor(monthDays[0])?.tile?.id)
          === objectFor(monthDays[0]),
        homeIndexOwnsTile:homeIndex?.objectForId(objectFor(homeTile)?.tile?.id)
          === objectFor(homeTile),
        forbiddenDaySurfaceCount:monthDays.reduce((sum, day) => sum + day.querySelectorAll(
          '.crm-tile-acrylic,.fc-day-object-view,.fc-day-tile-preview,.fc-day-live-preview,'
            + '.fc-day-expander-tint,.fc-day-detail-material',
        ).length, 0),
        collection:{
          owner:monthCollection?.dataset.crmTileCollection || '',
          expected:objectFor(activeMonth)?.tile?.id || '',
          declared:Number(monthCollection?.dataset.crmTileChildCount || 0),
          direct:monthCollection?.children?.length || 0,
          nonTiles:monthCollection?.querySelectorAll(
            ':scope > :not([data-crm-tile-instance="viewport"])',
          ).length || 0,
        },
        previewViewCount:monthDays.filter(
          (day) => day.dataset.tileObjectView === 'preview',
        ).length,
        previews:{
          count:monthDayPreviews.length,
          imageCount:monthDayPreviewImages.length,
          readyCount:monthDayPreviews.filter(
            (preview) => preview.dataset.previewState === 'ready',
          ).length,
          rendererCount:monthDayPreviews.filter(
            (preview) => preview.dataset.previewRenderer === 'calendar-day-full',
          ).length,
          fallbackCount:monthDayPreviews.filter(
            (preview) => !!preview.querySelector(':scope > .fc-day-capture-fallback'),
          ).length,
          inertCount:monthDayPreviews.filter((preview) => (
            !preview.matches('button,[data-crm-tile],.crm-tile,.crm-home-bucket')
            && getComputedStyle(preview).pointerEvents === 'none'
          )).length,
          nestedTileCount:monthDayPreviews.filter(
            (preview) => !!preview.querySelector('[data-crm-tile],.crm-tile,.crm-home-bucket'),
          ).length,
        },
        sourceMaterials:{
          first:tileSurfaceAudit(monthDays[0]),
          hovered:tileSurfaceAudit(monthDays.find((day) => day.matches(':hover'))),
        },
        dayTileRenderer:window.fractalCalendar.tilePreviewStatus(
          objectFor(activeMonth)?.tile?.id,
        ),
        plane:planeAudit(monthPlane),
        screenPlane:screenPlaneAudit(screenDayOwner, screenDayPlane),
        transitionFrameOpacity:Number(getComputedStyle(
          activeMonth.querySelector(':scope > .fc-transition-acrylic'),
        ).opacity),
        liveSurfaceClear:(() => {
          const style = getComputedStyle(monthLive);
          return (style.backgroundImage === 'none' || style.backgroundImage === '')
            && !String(style.webkitBackdropFilter || style.backdropFilter).includes('blur(');
        })(),
      } : null,
      activeDay:activeDay ? {
        date:activeDay.dataset.date,
        isSharedTile:activeDay.matches('[data-crm-tile][data-tile-schema-version="1"]'),
        sharesMonthDayObject:objectFor(activeDay) === objectFor(monthDays.find(
          (day) => day.dataset.date === activeDay.dataset.date,
        )),
        fullRendererSharesObject:objectFor(activeDayLive) === objectFor(activeDay),
        fullRendererView:activeDayLive?.dataset.tileObjectView || '',
        fullRenderer:activeDayLive?.dataset.tileRenderer || '',
        material:tileSurfaceAudit(activeDay),
        screenMaterial:(() => {
          const sharedAtEndpoint = screenDayPlane
            && screenDayOwner
            && !screenDayOwner.hidden
            && Number(getComputedStyle(screenDayPlane).opacity) >= .998
            && String(
              getComputedStyle(screenDayPlane).webkitBackdropFilter
                || getComputedStyle(screenDayPlane).backdropFilter,
            ).includes('blur(');
          const material = retainedDayLens || (sharedAtEndpoint ? screenDayPlane : null);
          const owner = retainedDayOwner || (sharedAtEndpoint ? screenDayOwner : null);
          if (!material || !owner) return null;
          const lensStyle = getComputedStyle(material);
          const ownerStyle = getComputedStyle(owner);
          const clip = String(ownerStyle.clipPath) !== 'none'
            ? String(ownerStyle.clipPath)
            : String(lensStyle.clipPath);
          return {
            phase:retainedDayLens
              ? (retainedDayLens.dataset.fractalAcrylicPhase || '')
              : 'shared-day-endpoint',
            direction:retainedDayLens?.dataset.fractalAcrylicDirection || '',
            ownerHidden:owner.hidden,
            ownerClipIsInset:clip.startsWith('inset('),
            ownerClipIsPath:clip.startsWith('path('),
            ownerClipIsUrl:clip.startsWith('url('),
            backdrop:lensStyle.webkitBackdropFilter || lensStyle.backdropFilter,
            opacity:Number(lensStyle.opacity),
            effectiveOpacity:effectiveOpacity(material, surface),
            visibility:lensStyle.visibility,
          };
        })(),
      } : null,
      yearChromeCount:document.querySelectorAll('body > .fc-year-strip').length,
      legacyNodeCount:surface.querySelectorAll(legacySelector).length,
      rasterNodeCount:surface.querySelectorAll('canvas,video,img.fc-strip-texture').length,
      renderer:window.fractalCalendar.stripCaptureDiagnostics(),
      tileRenderer:window.fractalCalendar.tilePreviewStatus(),
    };
  }, phase);
}

function architectureFailures(audit, expectedLevel) {
  const failures = [];
  if (audit.level !== expectedLevel) failures.push(`${audit.phase} level was ${audit.level}`);
  const expectedRootMonths = 12;
  const expectedVisibleRootMonths = expectedLevel === 0 ? expectedRootMonths : 0;
  if (audit.rootTiles.count !== expectedRootMonths
    || audit.rootTiles.buttonCount !== expectedRootMonths
    || audit.rootTiles.sharedClassCount !== expectedRootMonths
    || audit.rootTiles.canonicalClassCount !== expectedRootMonths
    || audit.rootTiles.viewportInstanceCount !== expectedRootMonths
    || audit.rootTiles.schemaCount !== expectedRootMonths
    || audit.rootTiles.identityCount !== expectedRootMonths
    || audit.rootTiles.targetCount !== expectedRootMonths
    || audit.rootTiles.calendarKindCount !== expectedRootMonths
    || audit.rootTiles.objectBoundCount !== expectedRootMonths
    || audit.rootTiles.canonicalObjectCount !== expectedRootMonths
    || audit.rootTiles.objectIdentityCount !== expectedRootMonths
    || audit.rootTiles.directBackdropCount !== 0
    || audit.rootTiles.visibleBackdropCount !== 0) {
    failures.push(`${audit.phase} root months are not canonical Home-style tile instances`);
  }
  if (audit.rootCollection?.owner !== audit.rootCollection?.expected
    || audit.rootCollection?.count !== expectedRootMonths) {
    failures.push(`${audit.phase} root months did not come from the canonical child collection`);
  }
  if (audit.rootPreview?.count !== expectedRootMonths
    || audit.rootPreview?.imageCount !== expectedRootMonths
    || audit.rootPreview?.readyCount !== expectedRootMonths
    || audit.rootPreview?.rendererCount !== expectedRootMonths
    || audit.rootPreview?.provenanceChildCount !== expectedRootMonths
    || audit.rootPreview?.inertCount !== audit.rootPreview?.count
    || audit.rootPreview?.backdropCount !== 0
    || audit.rootPreview?.syntheticDayCount !== 0
    || audit.rootPreview?.realDayCount !== 0) {
    failures.push(`${audit.phase} year tiles did not use twelve canonical full-render captures`);
  }
  const expectedWarmMonthDays = audit.phase === 'year-return' ? 31 : 0;
  const expectedWarmMonthShells = expectedWarmMonthDays ? 1 : 0;
  if (audit.warmMonthCache?.shellCount !== expectedWarmMonthShells
    || audit.warmMonthCache?.inertShellCount !== expectedWarmMonthShells
    || audit.warmMonthCache?.shellSharesGraphObject !== true
    || audit.warmMonthCache?.tiles?.count !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.buttonCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.sharedClassCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.canonicalClassCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.viewportInstanceCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.schemaCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.identityCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.objectBoundCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.canonicalObjectCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.tiles?.objectIdentityCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.graphOwnedDayCount !== expectedWarmMonthDays
    || audit.warmMonthCache?.readyPreviewCount !== expectedWarmMonthDays) {
    failures.push(`${audit.phase} retained month cache was not one inert canonical tile view`);
  }
  if (audit.rootMaterials?.planeCount !== 1
    || audit.rootMaterials?.tileCount !== expectedRootMonths
    || audit.rootMaterials?.readyCount !== 1
    || audit.rootMaterials?.pathCount !== 0
    || audit.rootMaterials?.urlClipCount !== 1
    || audit.rootMaterials?.maskCount !== 0
    || audit.rootMaterials?.backdropCount !== 1
    || audit.rootMaterials?.minTileCount !== expectedRootMonths
    || audit.rootMaterials?.maxTileCount !== expectedRootMonths
    || audit.rootMaterials?.visibleCount !== (expectedLevel === 0 ? 1 : 0)) {
    failures.push(`${audit.phase} did not consolidate the canonical month acrylic into one plane`);
  }
  const coverShouldBeVisible = expectedLevel > 0;
  if (!audit.liveBackdropCover?.present
    || audit.liveBackdropCover.visible !== coverShouldBeVisible
    || (coverShouldBeVisible && audit.liveBackdropCover.opacity < .999)
    || !audit.liveBackdropCover.clipIsInset
    || audit.liveBackdropCover.sceneTransform !== 'none'
    || !audit.liveBackdropCover.panelsMatch
    || audit.liveBackdropCover.rasterNodeCount !== 0) {
    failures.push(`${audit.phase} did not preserve the live wallpaper handoff layer`);
  }
  if (!audit.rootSurfaceClear) failures.push(`${audit.phase} Calendar root gained background acrylic`);
  if (!audit.monthTilesMatchHome) failures.push(`${audit.phase} month tiles drifted from Home material`);
  if (audit.prewarmMaterials?.maxOpacity > .05) {
    failures.push(`${audit.phase} exposed an opaque Calendar prewarm surface`);
  }
  if (audit.yearChromeCount !== 1) failures.push(`${audit.phase} year chrome was duplicated`);
  if (audit.legacyNodeCount || audit.rasterNodeCount) {
    failures.push(`${audit.phase} retained legacy calendar raster/material nodes`);
  }
  if (audit.renderer?.mode !== 'live-camera-chrome'
    || audit.renderer?.captureWorkers !== 0
    || audit.renderer?.pending !== 0
    || audit.renderer?.lastError) {
    failures.push(`${audit.phase} retained a calendar capture worker`);
  }
  if (audit.tileRenderer?.length !== expectedRootMonths
    || audit.tileRenderer.some((preview) => (
      preview.state !== 'ready' || preview.renderer !== 'calendar-month-full'
    ))) {
    failures.push(`${audit.phase} canonical month tile captures were not settled`);
  }
  return failures;
}

async function main() {
  const apiPort = Number(process.env.CRM_CALENDAR_API_PORT || process.env.CRM_API_PORT || 4029);
  const staticPort = Number(process.env.CRM_CALENDAR_STATIC_PORT || process.env.CRM_STATIC_PORT || 4028);
  fs.mkdirSync(OUTPUT_DIR, { recursive:true });
  fs.rmSync(EVIDENCE_PATH, { force:true });
  fs.rmSync(YEAR_SCREENSHOT_PATH, { force:true });
  fs.rmSync(MONTH_SCREENSHOT_PATH, { force:true });
  fs.rmSync(MONTH_TRACE_PATH, { force:true });
  fs.rmSync(DAY_TRACE_PATH, { force:true });

  console.log('[calendar-profiler] starting harness');
  const harness = await start({
    apiPort,
    staticPort,
    seedData:true,
    seedFn:seedCalendarProof,
  });
  console.log('[calendar-profiler] launching Electron');
  const app = await electron.launch({
    args:['.'],
    cwd:path.resolve(__dirname, '..', '..'),
    env:{
      ...process.env,
      CRM_API_URL:harness.apiUrl,
      CRM_API_PORT:String(apiPort),
      CRM_CDMS_DISABLED:'1',
    },
    timeout:30000,
  });

  try {
    console.log('[calendar-profiler] waiting for first window');
    const page = await app.firstWindow();
    console.log('[calendar-profiler] waiting for dashboard boot');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => (
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && window.crmWorkspaces
      && window.fractalCalendarCamera
    ), null, { timeout:30000 });
    console.log('[calendar-profiler] activating calendar and waiting for month previews');
    await page.evaluate(async () => {
      await window.crmHomePreviews?.waitForIdle?.();
      window.crmWorkspaces.setActive('calendar');
      await window.fractalCalendar.refresh();
    });
    console.log('[calendar-profiler] calendar refreshed; capture status polling started');
    const initialPreviewResult = await page.evaluate(async () => {
      const counts = [];
      const started = performance.now();
      let sampling = true;
      const sample = () => {
        const hosts = [...document.querySelectorAll(
          '.fc-level[data-kind="year"] > .fc-grid > .fc-month '
            + '> .fc-calendar-tile-preview',
        )];
        const ready = hosts.filter((host) => host.dataset.previewState === 'ready').length;
        const staging = hosts.filter((host) => host.dataset.previewState === 'staging').length;
        const previous = counts[counts.length - 1];
        if (!previous || previous.ready !== ready || previous.staging !== staging) {
          counts.push({ at:performance.now() - started, ready, staging });
        }
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const result = await window.fractalCalendar.waitForTilePreviews(undefined, 30000);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      sampling = false;
      sample();
      return {
        ...result,
        elapsedMs:performance.now() - started,
        readyTransitions:counts,
      };
    });
    if (initialPreviewResult.ready !== 12) {
      const diagnostics = await page.evaluate(
        () => window.crmTilePreviews?.diagnostics?.(),
      );
      throw new Error(JSON.stringify({ initialPreviewResult, diagnostics }));
    }
    console.log('[calendar-profiler] month previews settled');
    await page.waitForFunction(() => {
      const months = [...document.querySelectorAll(
        '.fc-level[data-kind="year"] > .fc-grid > .fc-month.crm-home-bucket',
      )];
      return document.body.dataset.crmModule === 'calendar'
        && window.fractalCalendar.level() === 0
        && !window.fractalCalendarCamera.isTransitioning()
        && months.length === 12
        && [...document.querySelectorAll(
          '.fc-level[data-kind="year"] .fc-month > .fc-calendar-tile-preview[data-preview-state="ready"]',
        )].length === 12
        && document.querySelectorAll(
          '.fc-level[data-kind="year"] .fc-calendar-tile-preview-render',
        ).length === 12
        && document.querySelectorAll(
          '.fc-level[data-kind="year"] .fc-day-preview-cell',
        ).length === 0
        && document.querySelectorAll(
          '.fc-level[data-kind="year"] .fc-day',
        ).length === 0
        && document.querySelectorAll(
          '.fc-expander.fc-warm[data-kind="month"] .fc-day',
        ).length === 0
        && months.every((month) => String(
          getComputedStyle(month).webkitBackdropFilter
            || getComputedStyle(month).backdropFilter,
        ) === 'none')
        && String((() => {
          const plane = document.querySelector(
            '.fc-surface > .fc-year-screen-material-owner > .fc-calendar-year-material',
          );
          const style = plane && getComputedStyle(plane);
          return style && (style.webkitBackdropFilter || style.backdropFilter);
        })()).includes('blur(');
    }, null, { timeout:60000 });
    await page.waitForFunction(() => {
      const sourcePanels = document.querySelectorAll(
        'body > .workspace-photo-backdrop .workspace-photo-panel',
      );
      const clonePanels = document.querySelectorAll(
        '.fc-live-backdrop-cover .workspace-photo-backdrop .workspace-photo-panel',
      );
      return sourcePanels.length > 0 && sourcePanels.length === clonePanels.length;
    }, null, { timeout:10000 });
    await sleep(180);

    let displayHz = 0;
    try {
      displayHz = await app.evaluate(({ screen }) => (
        screen.getPrimaryDisplay().displayFrequency || 0
      ));
    } catch {}
    const idleRounds = [];
    for (let round = 0; round < 3; round += 1) {
      idleRounds.push(summarizeCadence(await measureIdleCadence(page, 90)));
    }
    const idle = [...idleRounds].sort((a, b) => a.cadenceHz - b.cadenceHz)[1];
    await installProfiler(page);

    const architecture = [];
    architecture.push(await auditArchitecture(page, 'year-rest'));
    await page.screenshot({ path:YEAR_SCREENSHOT_PATH });
    const yearSurfaceRounds = [];
    for (let round = 0; round < 3; round += 1) {
      yearSurfaceRounds.push(summarizeCadence(await measureAnimatedSurfaceCadence(
        page,
        '.fc-level[data-kind="year"] > .fc-grid',
        90,
      )));
    }
    const yearSurface = [...yearSurfaceRounds].sort((a, b) => a.fps - b.fps)[1];

    // Dispatch directly in the renderer. Playwright's locator click moves the
    // host cursor first, which deliberately invokes hover prefetch and can
    // misattribute that separate preparation task to the navigation record.
    const openMonth = () => page.evaluate(() => document.querySelector(
      '.fc-level[data-kind="year"] .fc-month[data-month="7"]',
    )?.click());
    const openDay = () => page.evaluate(() => document.querySelector(
      '.fc-expander[data-kind="month"] > .fc-expander-live '
      + '.fc-day[data-date="2026-07-15"]',
    )?.click());
    const goBack = () => page.evaluate(() => window.fractalCalendar.back());

    // The geometry audit reads computed animation state once. Keep it separate
    // from the passive cadence pass so the profiler itself never forces style
    // or layout while measuring frame delivery.
    const auditMoves = [];
    auditMoves.push(await profileMove(
      page,
      'audit-month-in',
      openMonth,
      1,
      { captureAudit:true },
    ));
    const dayTilePreviewResult = await page.evaluate(
      async () => {
        const month = document.querySelector(
          '.fc-expander[data-kind="month"]:not(.fc-warm)',
        );
        const object = window.fractalCalendar._objectForElement(month);
        const counts = [];
        const started = performance.now();
        let sampling = true;
        const sample = () => {
          const hosts = [...month.querySelectorAll(
            '.fc-day > .fc-calendar-tile-preview',
          )];
          const ready = hosts.filter((host) => host.dataset.previewState === 'ready').length;
          const staging = hosts.filter(
            (host) => host.dataset.previewState === 'staging',
          ).length;
          const previous = counts[counts.length - 1];
          if (!previous || previous.ready !== ready || previous.staging !== staging) {
            counts.push({ at:performance.now() - started, ready, staging });
          }
          if (sampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        const result = await window.fractalCalendar.waitForTilePreviews(object?.tile?.id);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        sampling = false;
        sample();
        return {
          ...result,
          elapsedMs:performance.now() - started,
          readyTransitions:counts,
          captureDiagnostics:await window.crmTilePreviews?.diagnostics?.(),
        };
      },
    );
    if (dayTilePreviewResult.ready !== dayTilePreviewResult.total) {
      throw new Error(
        `Canonical day tile previews did not settle: ${JSON.stringify(dayTilePreviewResult)}`,
      );
    }
    await sleep(MATERIAL_HANDOFF_MS + 180);
    architecture.push(await auditArchitecture(page, 'month-rest'));
    await page.screenshot({ path:MONTH_SCREENSHOT_PATH });
    const dayAcrylicPixels = await measureDayAcrylicPixels(page);
    const monthSurfaceRounds = [];
    for (let round = 0; round < 3; round += 1) {
      monthSurfaceRounds.push(summarizeCadence(await measureAnimatedSurfaceCadence(
        page,
        '.fc-expander[data-kind="month"]:not(.fc-warm) > .fc-expander-live',
        90,
      )));
    }
    const monthSurface = [...monthSurfaceRounds].sort((a, b) => a.fps - b.fps)[1];

    auditMoves.push(await profileMove(
      page,
      'audit-day-in',
      openDay,
      2,
      { captureAudit:true },
    ));
    await sleep(MATERIAL_HANDOFF_MS + 180);
    architecture.push(await auditArchitecture(page, 'day-rest'));

    auditMoves.push(await profileMove(
      page,
      'audit-day-out',
      goBack,
      1,
      { captureAudit:true },
    ));
    auditMoves.push(await profileMove(
      page,
      'audit-month-out',
      goBack,
      0,
      { captureAudit:true },
    ));
    await sleep(MATERIAL_HANDOFF_MS + 180);
    architecture.push(await auditArchitecture(page, 'year-return'));

    await sleep(320);
    const moves = [];
    const traceTarget = String(process.env.CRM_CALENDAR_TRACE || '');
    let traceSession = ['1', 'month-in'].includes(traceTarget)
      ? await startTransitionTrace(page)
      : null;
    moves.push(await profileMove(page, 'month-in', openMonth, 1));
    if (traceSession) {
      await saveTransitionTrace(traceSession, MONTH_TRACE_PATH);
      traceSession = null;
    }
    await sleep(260);
    if (traceTarget === 'day-in') traceSession = await startTransitionTrace(page);
    moves.push(await profileMove(page, 'day-in', openDay, 2));
    if (traceSession) {
      await saveTransitionTrace(traceSession, DAY_TRACE_PATH);
      traceSession = null;
    }
    await sleep(MATERIAL_HANDOFF_MS + 40);
    moves.push(await profileMove(page, 'day-out', goBack, 1));
    await sleep(MATERIAL_HANDOFF_MS + 40);
    moves.push(await profileMove(page, 'month-out', goBack, 0));

    const evidence = {
      displayHz,
      idleRounds,
      idle,
      rootTilePreviewResult:initialPreviewResult,
      architecture,
      surfaceCadence:{
        yearRounds:yearSurfaceRounds,
        year:yearSurface,
        monthRounds:monthSurfaceRounds,
        month:monthSurface,
      },
      dayTilePreviewResult,
      dayAcrylicPixels,
      auditMoves,
      moves,
    };
    const failures = architecture.flatMap((audit) => (
      architectureFailures(audit, {
        'year-rest':0,
        'month-rest':1,
        'day-rest':2,
        'year-return':0,
      }[audit.phase])
    ));
    const monthAudit = architecture.find((audit) => audit.phase === 'month-rest')?.activeMonth;
    if (!monthAudit
      || ![28, 29, 30, 31].includes(monthAudit.tiles.count)
      || monthAudit.tiles.buttonCount !== monthAudit.tiles.count
      || monthAudit.tiles.sharedClassCount !== monthAudit.tiles.count
      || monthAudit.tiles.canonicalClassCount !== monthAudit.tiles.count
      || monthAudit.tiles.viewportInstanceCount !== monthAudit.tiles.count
      || monthAudit.tiles.schemaCount !== monthAudit.tiles.count
      || monthAudit.tiles.identityCount !== monthAudit.tiles.count
      || monthAudit.tiles.targetCount !== monthAudit.tiles.count
      || monthAudit.tiles.calendarKindCount !== monthAudit.tiles.count
      || monthAudit.tiles.objectBoundCount !== monthAudit.tiles.count
      || monthAudit.tiles.canonicalObjectCount !== monthAudit.tiles.count
      || monthAudit.tiles.objectIdentityCount !== monthAudit.tiles.count
      || monthAudit.dayObjectsSharedWithGraph !== monthAudit.tiles.count
      || monthAudit.shellSharesRootObject !== true
      || monthAudit.oneNodeShape !== true
      || monthAudit.oneComponent !== true
      || monthAudit.treeIndexOwnsDay !== true
      || monthAudit.homeIndexOwnsTile !== true
      || monthAudit.treePath?.length !== 2
      || monthAudit.forbiddenDaySurfaceCount !== 0
      || monthAudit.collection?.owner !== monthAudit.collection?.expected
      || monthAudit.collection?.declared !== monthAudit.tiles.count
      || monthAudit.collection?.direct !== monthAudit.tiles.count
      || monthAudit.collection?.nonTiles !== 0
      || monthAudit.previewViewCount !== monthAudit.tiles.count
      || monthAudit.previews?.count !== monthAudit.tiles.count
      || monthAudit.previews?.imageCount !== monthAudit.tiles.count
      || monthAudit.previews?.readyCount !== monthAudit.tiles.count
      || monthAudit.previews?.rendererCount !== monthAudit.tiles.count
      || monthAudit.previews?.fallbackCount !== 0
      || monthAudit.previews?.inertCount !== monthAudit.tiles.count
      || monthAudit.previews?.nestedTileCount !== 0
      || monthAudit.dayTileRenderer?.length !== monthAudit.tiles.count
      || monthAudit.dayTileRenderer.some((preview) => (
        preview.state !== 'ready'
          || preview.renderer !== 'calendar-day-full'
          || preview.captureQuality?.validated !== true
          || preview.captureQuality?.batch !== true
          || preview.captureQuality?.matteSeparationRatio < .2
          || preview.captureQuality?.transparentRatio < .2
          || preview.captureQuality?.opaqueRatio >= .92
          || preview.captureQuality?.nearSolidRatio >= .9
      ))
      || monthAudit.tiles.directBackdropCount !== 0
      || monthAudit.tiles.visibleBackdropCount !== 0
      || monthAudit.plane?.count !== monthAudit.tiles.count
      || monthAudit.plane?.clipIsPath !== true
      || monthAudit.plane?.ready !== true
      || monthAudit.plane?.muted !== true
      || String(monthAudit.plane?.backdrop) !== 'none'
      || monthAudit.plane?.opacity < .998
      || monthAudit.screenPlane?.count !== monthAudit.tiles.count
      || monthAudit.screenPlane?.ready !== true
      || monthAudit.screenPlane?.ownerHidden !== false
      || (monthAudit.screenPlane?.ownerClipIsPath !== true
        && monthAudit.screenPlane?.ownerClipIsUrl !== true)
      || !String(monthAudit.screenPlane?.backdrop).includes('blur(')
      || monthAudit.screenPlane?.opacity < .998
      || monthAudit.screenPlane?.visibility !== 'visible'
      || dayAcrylicPixels.tileCount !== monthAudit.tiles.count
      || dayAcrylicPixels.insideMean < 2
      || dayAcrylicPixels.insideMax < 10
      || dayAcrylicPixels.outsideMean > .25
      || monthAudit.transitionFrameOpacity > .001
      || !monthAudit.liveSurfaceClear) {
      failures.push('expanded month days are not canonical tiles on one true-acrylic plane');
    }
    const rootPreviewProgressive = initialPreviewResult.readyTransitions?.some(
      (state) => state.ready > 0 && state.ready < initialPreviewResult.total,
    );
    const dayPreviewProgressive = dayTilePreviewResult.readyTransitions?.some(
      (state) => state.ready > 0 && state.ready < dayTilePreviewResult.total,
    );
    if (initialPreviewResult.ready !== initialPreviewResult.total
      || initialPreviewResult.elapsedMs > 15000
      || rootPreviewProgressive
      || dayTilePreviewResult.ready !== dayTilePreviewResult.total
      || dayTilePreviewResult.elapsedMs > 8000
      || dayPreviewProgressive) {
      failures.push('calendar tile previews are not fast atomic scope commits');
    }
    const dayAudit = architecture.find((audit) => audit.phase === 'day-rest')?.activeDay;
    const dayDirectAcrylic = String(dayAudit?.material?.backdrop).includes('blur(')
      && dayAudit?.material?.opacity >= .998;
    const dayRetainedAcrylic = [
      'retained-endpoint',
      'shared-day-endpoint',
    ].includes(dayAudit?.screenMaterial?.phase)
      && !dayAudit?.screenMaterial?.ownerHidden
      && (dayAudit?.screenMaterial?.ownerClipIsInset
        || dayAudit?.screenMaterial?.ownerClipIsPath
        || dayAudit?.screenMaterial?.ownerClipIsUrl)
      && String(dayAudit?.screenMaterial?.backdrop).includes('blur(')
      && dayAudit?.screenMaterial?.opacity >= .998
      && dayAudit?.screenMaterial?.effectiveOpacity >= .998
      && dayAudit?.screenMaterial?.visibility === 'visible';
    if (dayAudit?.date !== '2026-07-15'
      || !dayAudit?.isSharedTile
      || dayAudit.sharesMonthDayObject !== true
      || dayAudit.fullRendererSharesObject !== true
      || dayAudit.fullRendererView !== 'full'
      || dayAudit.fullRenderer !== 'calendar-day-full'
      || dayAudit.material?.sharedComponent !== true
      || dayAudit.material?.previewChildren !== 0
      || dayAudit.material?.otherChildren < 2
      || (!dayDirectAcrylic && !dayRetainedAcrylic)) {
      failures.push('day detail endpoint is not a shared tile with the canonical material');
    }

    const idleCadence = Math.max(1, idle.cadenceHz);
    const cadenceFloor = Math.min(95, idleCadence * .92);
    const deliveredFpsFloor = Math.min(72, idle.fps * .7);
    const movingP95Budget = Math.max(21, idle.medianMs * 2.1);
    const movingMaxBudget = Math.max(60, idle.medianMs * 6);
    const handoffMaxBudget = Math.max(90, idle.medianMs * 9);
    [
      ['year', yearSurface],
      ['month', monthSurface],
    ].forEach(([label, cadence]) => {
      if (cadence.cadenceHz < cadenceFloor
        || cadence.fps < deliveredFpsFloor
        || cadence.p95Ms > movingP95Budget
        || cadence.maxMs > movingMaxBudget) {
        failures.push(
          `${label} sustained surface cadence fell below budget `
          + `(${cadence.fps.toFixed(2)} fps, p95 ${cadence.p95Ms.toFixed(2)}ms, `
          + `max ${cadence.maxMs.toFixed(2)}ms)`,
        );
      }
    });
    auditMoves.forEach((move) => {
      const audit = move.motionAudit;
      const crossesYearBoundary = move.startLevel === 0 || move.endLevel === 0;
      const transformClipPath = audit?.ownerTransformAnimated === true
        && audit?.lensTransformAnimated === true
        && audit?.ownerClipAnimated === false;
      const stationaryLensClipPath = audit?.ownerTransformAnimated === false
        && audit?.lensTransformAnimated === false
        && audit?.ownerClipAnimated === true;
      const sharedDayBackdrop = !crossesYearBoundary
        && audit?.lensBackdropOwner === 'day-shared'
        && audit?.sharedDayClipAnimated === true
        && audit?.sharedDayClipIsPath === true
        && audit?.sharedDayAnimationCount === 1
        && audit?.visibleBackdropOwnerCount === 1
        && audit?.backdropCandidates?.some((candidate) => (
          String(candidate.className).includes('fc-day-screen-material')
            && String(candidate.backdrop).includes('blur(')
            && candidate.effectiveOpacity > .998
        ));
      if (!audit
        || (audit.ownerClipIsPath !== true && audit.ownerClipIsInset !== true)
        || (!String(audit.lensBackdrop).includes('blur(') && !sharedDayBackdrop)
        || (!transformClipPath && !stationaryLensClipPath)
        || (!sharedDayBackdrop && audit.visibleBackdropOwnerCount < 2)
        || audit.visibleBackdropOwnerCount > 3
        || audit.liveBackdropCover?.present !== true
        || audit.liveBackdropCover?.opacityAnimated !== crossesYearBoundary
        || (!crossesYearBoundary && audit.liveBackdropCover?.opacity < .998)
        || audit.liveBackdropCover?.transformAnimated !== false
        || audit.liveBackdropCover?.clipAnimated !== false
        || audit.liveBackdropCover?.panelsMatch !== true
        || audit.liveBackdropCover?.rasterNodeCount !== 0
        || audit.legacyNodeCount
        || audit.rasterNodeCount) {
        failures.push(`${move.label} did not use a canonical single-owner acrylic path`);
      }
    });
    moves.forEach((move) => {
      if (move.firstFrameLatencyMs > Math.max(35, idle.medianMs * 3.5)) {
        failures.push(`${move.label} delayed its first moving frame (${move.firstFrameLatencyMs.toFixed(2)}ms)`);
      }
      if (move.transformCadence.cadenceHz < cadenceFloor
        || move.transformCadence.fps < deliveredFpsFloor
        || move.transformCadence.p95Ms > movingP95Budget
        || move.transformCadence.maxMs > movingMaxBudget
        || move.handoffCadence.maxMs > handoffMaxBudget) {
        failures.push(
          `${move.label} cadence fell below the calibrated animation budget `
          + `(${move.transformCadence.fps.toFixed(2)} transform fps, transform p95 `
          + `${move.transformCadence.p95Ms.toFixed(2)}ms, transform max `
          + `${move.transformCadence.maxMs.toFixed(2)}ms, handoff max `
          + `${move.handoffCadence.maxMs.toFixed(2)}ms)`,
        );
      }
      const motionLongTasks = move.longTasks.filter((entry) => entry.motionOverlapMs >= 50);
      if (motionLongTasks.length) {
        failures.push(
          `${move.label} produced a renderer long task during motion `
          + `(${motionLongTasks.map((entry) => `${entry.motionOverlapMs}ms`).join(', ')})`,
        );
      }
    });

    evidence.failures = failures;
    fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      displayHz:evidence.displayHz,
      idle:evidence.idle,
      surfaceCadence:evidence.surfaceCadence,
      auditMoves:evidence.auditMoves.map((move) => ({
        label:move.label,
        cadence:move.cadence,
        motionAudit:move.motionAudit,
      })),
      moves:evidence.moves.map((move) => ({
        label:move.label,
        firstFrameLatencyMs:move.firstFrameLatencyMs,
        cadence:move.cadence,
        transformCadence:move.transformCadence,
        handoffCadence:move.handoffCadence,
        longTasks:move.longTasks,
      })),
      failures,
    }, null, 2));
    if (failures.length) {
      throw new Error(`Calendar true-acrylic tile budget missed: ${failures.join('; ')}`);
    }
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
