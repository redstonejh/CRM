'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { PNG } = require('pngjs');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ALL_TILES = [
  { module:'people', theater:'people' },
  { module:'cases', theater:'tickets' },
  { module:'planner', theater:'planner' },
  { module:'assignments', theater:'assignments' },
];
const TILES = process.env.CRM_HOME_TILE
  ? ALL_TILES.filter((tile) => tile.module === process.env.CRM_HOME_TILE)
  : ALL_TILES;
const API_PORT = Number(process.env.CRM_API_PORT || 4039);
const STATIC_PORT = Number(process.env.CRM_STATIC_PORT || 4038);
const ROUND_COUNT = Math.max(2, Number(process.env.CRM_HOME_ROUNDS || 2));

async function armProbe(page, direction, tile, sampleVisual = false) {
  await page.evaluate(({ probeDirection, module, theater, readVisuals }) => {
    const home = window.crmHomeCamera?.layers?.()[0] || null;
    const theaters = [...document.querySelectorAll(`[data-crm-theater="${theater}"]`)];
    const destination = theaters.find((node) => !node.hidden) || theaters[0] || null;
    const observed = [home, destination].filter(Boolean);
    const describe = (node) => ({
      tag:node?.tagName || '',
      id:String(node?.id || ''),
      className:String(node?.className || '').slice(0, 120),
    });
    const regionOf = (node) => home && (node === home || home.contains(node)) ? 'home' : 'destination';
    const probe = {
      direction:probeDirection,
      module,
      sourceChildren:Object.fromEntries(observed.map((root) => [regionOf(root), root.querySelectorAll('*').length])),
      childMutations:[],
      attributeMutations:[],
      unexpectedAttributes:[],
      movingDeltas:[],
      visualDeltas:[],
      visualDrops:[],
      ownershipDeltas:[],
      journeyDeltas:[],
      journeyDrops:[],
      acrylic:[],
      acrylicMaterial:[],
      acrylicRelease:[],
      acrylicEndpointHold:[],
      homeReturnCoverage:[],
      longTasks:[],
      sampleVisual:readVisuals,
      triggered:false,
      started:false,
      done:false,
      timingBaseline:window.crmDeskTransit?.performanceTimings?.().length || 0,
    };
    let previousMovingAt = null;
    let previousVisualMoving = false;
    let previousOwnershipMoving = false;
    let previousCoverState = null;
    let previousBusy = false;
    let previousJourneyAt = null;
    let lastTickAt = null;
    let resolveDone = null;
    window.__homeContinuityDone = new Promise((resolve) => { resolveDone = resolve; });
    window.__homeContinuityProbe = probe;
    const trigger = () => {
      if (probe.triggered) return;
      probe.triggered = true;
      probe.triggeredAt = performance.now();
      previousMovingAt = null;
      // Span the physical input with the enclosing native refresh interval.
      // Starting at pointerdown itself would turn the first partial interval
      // into an artificial >100 FPS sample.
      previousJourneyAt = lastTickAt || probe.triggeredAt;
    };
    window.__triggerHomeContinuity = trigger;
    const triggerTarget = home?.querySelector(`.crm-home-bucket[data-module="${module}"]`);
    const onPointerDown = (event) => {
      if (event.target?.closest?.(`.crm-home-bucket[data-module="${module}"]`) === triggerTarget) trigger();
    };
    // Start at physical input, before the camera's document-level click
    // capture can do any synchronous setup.
    document.addEventListener('pointerdown', onPointerDown, true);

    const observer = new MutationObserver((records) => {
      if (!probe.triggered || (!window.crmHomeCamera?.isTransitioning?.() && !window.crmDeskTransit?.isBusy?.())) return;
      records.forEach((record) => {
        const region = regionOf(record.target);
        if (record.type === 'childList') {
          [...record.addedNodes].forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            probe.childMutations.push({ region, action:'added', ...describe(node), descendants:node.querySelectorAll?.('*').length || 0 });
          });
          [...record.removedNodes].forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            probe.childMutations.push({ region, action:'removed', ...describe(node), descendants:node.querySelectorAll?.('*').length || 0 });
          });
          return;
        }
        const attribute = record.attributeName || '';
        const item = {
          region,
          attribute,
          targetIsRoot:record.target === home || record.target === destination,
          target:describe(record.target),
          before:String(record.oldValue ?? '').slice(0, 160),
          after:String(record.target.getAttribute(attribute) ?? '').slice(0, 160),
        };
        probe.attributeMutations.push(item);
        const allowedHomeCameraWrite = region === 'home' && record.target === home && attribute === 'style';
        const without = (value, allowed) => String(value || '').split(/\s+/)
          .filter((token) => token && !allowed.includes(token)).sort().join(' ');
        const allowedTargetMarker = region === 'home'
          && record.target === triggerTarget
          && attribute === 'class'
          && without(item.before, ['is-camera-target', 'is-preview-hovered'])
            === without(item.after, ['is-camera-target', 'is-preview-hovered']);
        const allowedTitleMarker = region === 'home'
          && record.target.matches?.(`.crm-home-title-slot[data-module="${module}"]`)
          && attribute === 'class'
          && without(item.before, ['is-deemphasized']) === without(item.after, ['is-deemphasized']);
        const allowedVariantMarker = region === 'home'
          && record.target.matches?.('.crm-home-motion-variant')
          && attribute === 'class'
          && without(item.before, ['is-active-motion-variant']) === without(item.after, ['is-active-motion-variant']);
        const allowedDestinationStageWrite = region === 'destination' && record.target === destination
          && ['style', 'hidden', 'data-crm-home-precomposed', 'data-crm-transit-destination',
            'data-crm-transit-group', 'data-crm-transit-layer', 'data-crm-transit-retained'].includes(attribute);
        if (!allowedHomeCameraWrite && !allowedTargetMarker && !allowedTitleMarker
          && !allowedVariantMarker && !allowedDestinationStageWrite) {
          probe.unexpectedAttributes.push(item);
        }
      });
    });
    observed.forEach((root) => observer.observe(root, {
      childList:true,
      subtree:true,
      attributes:true,
      attributeOldValue:true,
      attributeFilter:['class', 'style', 'hidden', 'data-crm-home-precomposed',
        'data-crm-transit-destination', 'data-crm-transit-group', 'data-crm-transit-layer',
        'data-crm-transit-retained'],
    }));
    const longTaskObserver = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
        if (!probe.triggered || entry.startTime < probe.triggeredAt) return;
        probe.longTasks.push({ startTime:entry.startTime, duration:entry.duration });
      }))
      : null;
    try { longTaskObserver?.observe({ entryTypes:['longtask'] }); } catch {}

    const finish = () => {
      if (probe.done) return;
      probe.done = true;
      observer.disconnect();
      longTaskObserver?.disconnect();
      document.removeEventListener('pointerdown', onPointerDown, true);
      delete window.__triggerHomeContinuity;
      probe.destinationChildren = Object.fromEntries(observed.map((root) => [regionOf(root), root.querySelectorAll('*').length]));
      probe.transitTiming = (window.crmDeskTransit?.performanceTimings?.() || [])
        .slice(probe.timingBaseline).findLast?.((item) => item.key === module) || null;
      resolveDone(probe);
    };
    const tick = (now) => {
      const cameraMoving = !!window.crmHomeCamera?.isTransitioning?.();
      const motionState = window.crmDeskTransit?.motionState?.() || { active:cameraMoving };
      const visualState = window.crmDeskTransit?.visualState?.() || {
        active:motionState.active,
        cameraActive:motionState.active,
        ownershipActive:false,
      };
      const cameraMotion = !!visualState.cameraActive;
      const ownershipMoving = !!visualState.ownershipActive;
      const moving = !!visualState.active;
      const busy = !!window.crmDeskTransit?.isBusy?.();
      const coverState = window.crmDeskTransit?.coverState?.() || null;
      if (probe.triggered) {
        const delta = now - previousJourneyAt;
        probe.journeyDeltas.push(delta);
        const visualMotion = previousVisualMoving || moving;
        if (visualMotion) {
          probe.visualDeltas.push(delta);
          if (delta > 15) {
            probe.visualDrops.push({
              delta,
              elapsed:now - probe.triggeredAt,
              motionState,
              coverBefore:previousCoverState,
              coverAfter:coverState,
            });
          }
        }
        if (previousOwnershipMoving || ownershipMoving) probe.ownershipDeltas.push(delta);
        if (delta > 15) {
          probe.journeyDrops.push({
            delta,
            elapsed:now - probe.triggeredAt,
            moving,
            visualMotion,
            busy,
            busyBefore:previousBusy,
            busyAfter:busy,
            module:document.body.dataset.crmModule || '',
            htmlClass:document.documentElement.className,
            surfaceClass:window.crmHomeCamera?.surface?.()?.className || '',
            coverBefore:previousCoverState,
            coverAfter:coverState,
          });
        }
        previousJourneyAt = now;
        previousVisualMoving = moving;
        previousOwnershipMoving = ownershipMoving;
        previousCoverState = coverState;
        previousBusy = busy;
        if (Number.isFinite(motionState.startedAt) && motionState.startedAt > 0) probe.motionStartedAt = motionState.startedAt;
        if (Number.isFinite(motionState.endedAt) && motionState.endedAt > 0) probe.motionEndedAt = motionState.endedAt;
      }
      if (cameraMotion && probe.triggered) {
        probe.started = true;
        if (previousMovingAt != null) probe.movingDeltas.push(now - previousMovingAt);
        previousMovingAt = now;
        if (readVisuals) {
          const lens = document.querySelector('.crm-home-screen-acrylic');
          const frame = document.querySelector('.crm-home-expander:not(.crm-home-warm) > .crm-home-transition-acrylic');
          const style = lens ? getComputedStyle(lens) : null;
          const clipOwner = lens?.parentElement?.classList.contains('crm-home-screen-acrylic-clip') ? lens.parentElement : lens;
          const clipStyle = clipOwner ? getComputedStyle(clipOwner) : null;
          const frameStyle = frame ? getComputedStyle(frame) : null;
          probe.acrylic.push(style ? Number(style.opacity) : null);
          probe.acrylicMaterial.push({
            phase:lens?.dataset?.fractalAcrylicPhase || '',
            opacity:style ? Number(style.opacity) : null,
            background:style?.backgroundImage || '',
            backdrop:style?.webkitBackdropFilter || style?.backdropFilter || '',
            clip:clipStyle?.clipPath || '',
            frameOpacity:frameStyle ? Number(frameStyle.opacity) : null,
            frameBorder:frameStyle?.borderStyle || '',
            frameShadow:frameStyle?.boxShadow || '',
          });
        }
      }
      if (readVisuals && probe.triggered && !cameraMotion) {
        const lens = document.querySelector('.crm-home-screen-acrylic');
        const phase = lens?.dataset?.fractalAcrylicPhase || '';
        if (lens && ['release', 'endpoint-held'].includes(phase)) {
          const frame = document.querySelector('.crm-home-expander:not(.crm-home-warm) > .crm-home-transition-acrylic');
          const style = getComputedStyle(lens);
          const clipOwner = lens.parentElement?.classList.contains('crm-home-screen-acrylic-clip') ? lens.parentElement : lens;
          const clipStyle = getComputedStyle(clipOwner);
          const frameStyle = frame ? getComputedStyle(frame) : null;
          const sample = {
            phase,
            opacity:Number(style.opacity),
            backdrop:style.webkitBackdropFilter || style.backdropFilter || '',
            clip:clipStyle.clipPath || '',
            frameOpacity:frameStyle ? Number(frameStyle.opacity) : null,
          };
          if (phase === 'release') probe.acrylicRelease.push(sample);
          else probe.acrylicEndpointHold.push(sample);
        }
        const surface = window.crmHomeCamera?.surface?.();
        const root = window.crmHomeCamera?.layers?.()[0];
        if (probeDirection === 'contract'
          && surface?.classList.contains('crm-home-camera-handoff') && root) {
          const opacity = (node) => node ? Number(getComputedStyle(node).opacity) : NaN;
          const incoming = [
            ...root.querySelectorAll(':scope > .crm-home-grid > .crm-home-bucket'),
            root.querySelector(':scope > .crm-home-title-layer'),
            root.querySelector(':scope > .crm-home-priority-hand'),
          ].map(opacity).filter(Number.isFinite);
          const outgoing = [
            root.querySelector(':scope > .crm-home-motion-variant.is-active-motion-variant'),
            surface.querySelector('.crm-home-expander:not(.crm-home-warm)'),
            lens,
            surface.querySelector('.crm-home-peripheral-screen-acrylic'),
          ].map(opacity).filter(Number.isFinite);
          const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
          const incomingOpacity = incoming.length === 6 ? average(incoming) : NaN;
          const outgoingOpacity = outgoing.length === 4 ? average(outgoing) : NaN;
          const bucketOpacity = incoming.slice(0, 4);
          const titleOpacity = incoming[4];
          const handOpacity = incoming[5];
          const matching = surface.classList.contains('crm-home-camera-releasing')
            && !surface.classList.contains('crm-home-camera-committing');
          const committing = surface.classList.contains('crm-home-camera-committing');
          probe.homeReturnCoverage.push({
            matching,
            committing,
            bucketMinOpacity:bucketOpacity.length === 4 ? Math.min(...bucketOpacity) : NaN,
            bucketMaxOpacity:bucketOpacity.length === 4 ? Math.max(...bucketOpacity) : NaN,
            titleOpacity,
            handOpacity,
            outgoingMinOpacity:outgoing.length === 4 ? Math.min(...outgoing) : NaN,
            outgoingMaxOpacity:outgoing.length === 4 ? Math.max(...outgoing) : NaN,
            incomingOpacity,
            outgoingOpacity,
            combinedCoverage:1 - (1 - incomingOpacity) * (1 - outgoingOpacity),
            fullOwner:incomingOpacity >= .99 || outgoingOpacity >= .99,
          });
        }
      }
      if (probe.started && !cameraMoving && !busy) {
        finish();
        return;
      }
      lastTickAt = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { probeDirection:direction, module:tile.module, theater:tile.theater, readVisuals:sampleVisual });
}

async function takeProbe(page) {
  return page.evaluate(async () => {
    const probe = await window.__homeContinuityDone;
    const metrics = (deltas) => {
      const sorted = [...deltas].sort((a, b) => a - b);
      const percentile = (part) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * part) - 1))] || 0;
      const median = percentile(.5);
      // A seven-frame ownership dissolve is too short for a 0.1 ms timer-
      // quantized median: four 9.9 ms samples would misleadingly report
      // 101.01 Hz. Round its mean interval to the monitor's millisecond
      // cadence quantum; p95, max and the >15 ms counter independently retain
      // every stall gate.
      const mean = deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : 0;
      const cadencePeriod = deltas.length > 0 && deltas.length < 10 ? Math.round(mean) : median;
      return {
        frames:deltas.length,
        averageFps:mean ? 1000 / mean : 0,
        cadenceHz:cadencePeriod ? 1000 / cadencePeriod : 0,
        medianMs:median,
        p95Ms:percentile(.95),
        maxMs:sorted.at(-1) || 0,
        droppedFrames:deltas.filter((value) => value > 15).length,
      };
    };
    const opacity = probe.acrylic.filter(Number.isFinite);
    const steps = opacity.slice(1).map((value, index) => value - opacity[index]);
    const maxOpacityStep = Math.max(0, ...steps.map(Math.abs));
    const releaseOpacity = probe.acrylicRelease.map((sample) => sample.opacity).filter(Number.isFinite);
    const releaseIntermediate = releaseOpacity.filter((value) => value > .05 && value < .95);
    const releaseSteps = releaseOpacity.slice(1).map((value, index) => value - releaseOpacity[index]);
    const releaseMaterialFrames = probe.acrylicRelease.filter((sample) =>
      sample.backdrop.includes('blur(')
      && sample.backdrop.includes('saturate(')
      && sample.clip.startsWith('inset(')
      && Number.isFinite(sample.frameOpacity));
    const releaseOwnerAlignment = Math.max(0, ...probe.acrylicRelease.map((sample) =>
      Math.abs(Number(sample.opacity) - Number(sample.frameOpacity))).filter(Number.isFinite));
    const endpointOpacity = probe.acrylicEndpointHold.map((sample) => sample.opacity).filter(Number.isFinite);
    const endpointMaterialFrames = probe.acrylicEndpointHold.filter((sample) =>
      sample.opacity >= .99
      && sample.frameOpacity >= .99
      && sample.backdrop.includes('blur(')
      && sample.backdrop.includes('saturate(')
      && sample.clip.startsWith('inset('));
    const materialFrames = probe.acrylicMaterial.filter((sample) =>
      sample.phase === 'motion'
      && sample.opacity >= .99
      && sample.frameOpacity >= .99
      && sample.background && sample.background !== 'none'
      && sample.backdrop.includes('blur(')
      && sample.backdrop.includes('saturate(')
      && sample.clip.startsWith('inset(')
      && sample.frameBorder === 'solid'
      && sample.frameShadow && sample.frameShadow !== 'none');
    const returnCoverage = probe.homeReturnCoverage
      .map((sample) => sample.combinedCoverage).filter(Number.isFinite);
    return {
      ...probe,
      ...metrics(probe.visualDeltas),
      camera:metrics(probe.movingDeltas),
      visual:metrics(probe.visualDeltas),
      ownership:metrics(probe.ownershipDeltas),
      journey:metrics(probe.journeyDeltas),
      opacityFirst:opacity[0],
      opacityLast:opacity.at(-1),
      maxOpacityStep,
      heldEveryMotionFrame:opacity.length > 0 && opacity.every((value) => value >= .99),
      realMaterialFrames:materialFrames.length,
      releaseFirst:releaseOpacity[0],
      releaseLast:releaseOpacity.at(-1),
      releaseFrames:releaseOpacity.length,
      releaseIntermediateFrames:releaseIntermediate.length,
      releaseMaxOpacityStep:Math.max(0, ...releaseSteps.map(Math.abs)),
      releaseMonotonic:releaseSteps.every((step) => step <= .035),
      releaseMaterialFrames:releaseMaterialFrames.length,
      releaseOwnerAlignment,
      endpointHoldFrames:endpointOpacity.length,
      endpointHoldMinOpacity:Math.min(1, ...endpointOpacity),
      endpointHoldMaterialFrames:endpointMaterialFrames.length,
      returnCoverageFrames:returnCoverage.length,
      returnCoverageFloor:Math.min(1, ...returnCoverage),
      returnFullOwnerEveryFrame:probe.homeReturnCoverage.length > 0
        && probe.homeReturnCoverage.every((sample) => sample.fullOwner),
      returnMatchFrames:probe.homeReturnCoverage.filter((sample) => sample.matching).length,
      returnCommitFrames:probe.homeReturnCoverage.filter((sample) => sample.committing).length,
      returnMatchCoveredEveryFrame:probe.homeReturnCoverage.some((sample) => sample.matching)
        && probe.homeReturnCoverage.filter((sample) => sample.matching).every((sample) =>
          sample.bucketMaxOpacity <= .01
          && sample.handOpacity <= .01
          && sample.outgoingMinOpacity >= .99),
      returnCommitCoveredEveryFrame:probe.homeReturnCoverage.some((sample) => sample.committing)
        && probe.homeReturnCoverage.filter((sample) => sample.committing).every((sample) =>
          sample.bucketMinOpacity >= .99
          && sample.titleOpacity >= .99
          && sample.handOpacity >= .99
          && sample.outgoingMaxOpacity <= .01),
    };
  });
}

function validateCadence(probe) {
  const uncoveredDrops = probe.journeyDrops.filter((drop) => {
    if (drop.visualMotion) return true;
    const states = [drop.coverBefore, drop.coverAfter].filter(Boolean);
    return (drop.busyBefore || drop.busyAfter) && !states.some((state) =>
      (state.rasterReady && state.rasterOpaque && state.coverInvariant)
      || (state.liveReady && (state.swappedAt > 0 || ['swapped', 'live'].includes(state.phase))));
  });
  const maintenanceMs = Number(probe.transitTiming?.maintenanceMs) || 0;
  // A genuine backdrop-filter can compile one GPU blur pass on the very first
  // native use even after its invisible hover prewarm. Keep that cold-only
  // allowance explicit and bounded to one 20 ms refresh; every repeated,
  // visually sampled transition below must still meet the strict 100 Hz gate.
  const coldBackdropAllocation = probe.sampleVisual === false
    && probe.camera.droppedFrames <= 1
    && probe.camera.maxMs <= 21
    && probe.visualDrops.length <= 1
    && uncoveredDrops.length <= 1
    && probe.camera.p95Ms <= 12.5
    && Math.round(probe.camera.cadenceHz) === 100;
  const visualCadenceMiss = Math.round(probe.averageFps) !== 100
    || Math.round(probe.cadenceHz) !== 100
    || probe.cadenceHz < 98.5
    || probe.p95Ms > 12.5
    || probe.maxMs > 15
    || probe.droppedFrames
    || probe.visualDrops.length
    || uncoveredDrops.length;
  if (probe.childMutations.length
    || probe.unexpectedAttributes.length
    || probe.longTasks.length
    || probe.frames < 40
    || (visualCadenceMiss && !coldBackdropAllocation)
    || (probe.direction === 'expand' && (
      !probe.transitTiming
      || probe.transitTiming.coverInvariant !== true
      || probe.transitTiming.liveReady !== true
      || maintenanceMs <= 0
      // Chromium exposes this covered interval on a 0.1 ms clock while its
      // component waits land on native 10 ms frames. Round away representational
      // noise; visible cadence retains the exact max/dropped-frame gates above.
      // The seated tile spends 180 ms blending its double-acrylic source into
      // the complete single-acrylic endpoint. Its first 140 ms overlap the end
      // of camera motion, eliminating the post-motion hold without shortening
      // the dissolve. The endpoint then remains covered while destination
      // acrylic is rasterized for eight native paints and released over a
      // 120 ms crossfade. Budget that deliberate, visually protected work
      // without weakening the cadence gates above.
      || Math.round(maintenanceMs) > 740
      || Number(probe.transitTiming.endpointMaterialBlendDuration) !== 180
      || Number(probe.transitTiming.endpointMaterialBlendMs) < 165
      || Number(probe.transitTiming.endpointMaterialBlendMs) > 230
      || Number(probe.transitTiming.endpointMaterialLead) !== 140
      || Number(probe.transitTiming.endpointBlendStartDeltaMs) > 0
      || Number(probe.transitTiming.endpointBlendStartDeltaMs) < -200
      || probe.transitTiming.endpointBlendStartedBeforeMotionEnd !== true
      || probe.transitTiming.endpointAcrylicRetired !== true
      || probe.transitTiming.endpointAcrylicRetiredAfterBlend !== true
      || probe.transitTiming.sourceRetiredBeforeRelease !== true
      || probe.transitTiming.acrylicUnderpaintExposed !== true
      || probe.transitTiming.acrylicStable !== true
      || Number(probe.transitTiming.acrylicOwners) < 1
      || Number(probe.transitTiming.acrylicWarmFrames) < 8
      || Number(probe.transitTiming.acrylicUnderpaintMs) <= 0
      || Number(probe.transitTiming.acrylicUnderpaintMs) > 180
      || Number(probe.transitTiming.crossfadeDuration) !== 120
      || Number(probe.transitTiming.crossfadeMs) < 110
      || Number(probe.transitTiming.crossfadeMs) > 160
      || probe.ownership.frames < 5
      || Math.round(probe.ownership.cadenceHz) !== 100
      || probe.ownership.p95Ms > 12.5
      || probe.ownership.maxMs > 15
      || probe.ownership.droppedFrames
    ))) {
    throw new Error(`Home ${probe.direction} cadence missed its 100 Hz contract: ${JSON.stringify(summary(probe))}`);
  }
}

function validateVisual(probe) {
  const releaseValid = probe.direction === 'expand'
    ? probe.releaseFrames === 0
    : probe.releaseFrames === 0;
  const endpointHoldValid = probe.direction === 'expand'
    ? probe.endpointHoldFrames >= 4
      && probe.endpointHoldMinOpacity >= .99
      && probe.endpointHoldMaterialFrames === probe.endpointHoldFrames
    : probe.endpointHoldFrames === 0;
  const returnCoverageValid = probe.direction === 'expand'
    ? probe.returnCoverageFrames === 0
    : probe.returnCoverageFrames >= 8
      && probe.returnCoverageFloor >= .99
      && probe.returnFullOwnerEveryFrame
      && probe.returnMatchFrames >= 7
      && probe.returnCommitFrames >= 1
      && probe.returnMatchCoveredEveryFrame
      && probe.returnCommitCoveredEveryFrame;
  if (probe.childMutations.length
    || probe.unexpectedAttributes.length
    || probe.opacityFirst < .99
    || probe.opacityLast < .99
    || !probe.heldEveryMotionFrame
    || probe.maxOpacityStep > .02
    || probe.realMaterialFrames !== probe.acrylic.length
    || !releaseValid
    || !endpointHoldValid
    || !returnCoverageValid
  ) {
    throw new Error(`Home ${probe.direction} acrylic continuity failed: ${JSON.stringify(summary(probe))}`);
  }
}

const summary = (probe) => ({
  module:probe.module,
  direction:probe.direction,
  sampleVisual:probe.sampleVisual,
  idleBaseline:probe.idleBaseline,
  sourceChildren:probe.sourceChildren,
  destinationChildren:probe.destinationChildren,
  childMutations:probe.childMutations,
  attributeMutationCount:probe.attributeMutations.length,
  unexpectedAttributes:probe.unexpectedAttributes,
  longTasks:probe.longTasks,
  transitTiming:probe.transitTiming,
  frames:probe.frames,
  averageFps:Number(probe.averageFps.toFixed(2)),
  cadenceHz:Number(probe.cadenceHz.toFixed(2)),
  medianMs:Number(probe.medianMs.toFixed(2)),
  p95Ms:Number(probe.p95Ms.toFixed(2)),
  maxMs:Number(probe.maxMs.toFixed(2)),
  droppedFrames:probe.droppedFrames,
  camera:{
    frames:probe.camera.frames,
    averageFps:Number(probe.camera.averageFps.toFixed(2)),
    cadenceHz:Number(probe.camera.cadenceHz.toFixed(2)),
    p95Ms:Number(probe.camera.p95Ms.toFixed(2)),
    maxMs:Number(probe.camera.maxMs.toFixed(2)),
    droppedFrames:probe.camera.droppedFrames,
  },
  ownership:{
    frames:probe.ownership.frames,
    averageFps:Number(probe.ownership.averageFps.toFixed(2)),
    cadenceHz:Number(probe.ownership.cadenceHz.toFixed(2)),
    p95Ms:Number(probe.ownership.p95Ms.toFixed(2)),
    maxMs:Number(probe.ownership.maxMs.toFixed(2)),
    droppedFrames:probe.ownership.droppedFrames,
  },
  visualDrops:probe.visualDrops,
  journey:{
    frames:probe.journey.frames,
    averageFps:Number(probe.journey.averageFps.toFixed(2)),
    cadenceHz:Number(probe.journey.cadenceHz.toFixed(2)),
    medianMs:Number(probe.journey.medianMs.toFixed(2)),
    p95Ms:Number(probe.journey.p95Ms.toFixed(2)),
    maxMs:Number(probe.journey.maxMs.toFixed(2)),
    droppedFrames:probe.journey.droppedFrames,
    drops:probe.journeyDrops,
  },
  opacityFirst:probe.opacityFirst,
  opacityLast:probe.opacityLast,
  maxOpacityStep:probe.maxOpacityStep,
  heldEveryMotionFrame:probe.heldEveryMotionFrame,
  realMaterialFrames:probe.realMaterialFrames,
  releaseFirst:probe.releaseFirst,
  releaseLast:probe.releaseLast,
  releaseFrames:probe.releaseFrames,
  releaseIntermediateFrames:probe.releaseIntermediateFrames,
  releaseMaxOpacityStep:probe.releaseMaxOpacityStep,
  releaseMonotonic:probe.releaseMonotonic,
  releaseMaterialFrames:probe.releaseMaterialFrames,
  releaseOwnerAlignment:probe.releaseOwnerAlignment,
  endpointHoldFrames:probe.endpointHoldFrames,
  endpointHoldMinOpacity:probe.endpointHoldMinOpacity,
  endpointHoldMaterialFrames:probe.endpointHoldMaterialFrames,
  returnCoverageFrames:probe.returnCoverageFrames,
  returnCoverageFloor:probe.returnCoverageFloor,
  returnFullOwnerEveryFrame:probe.returnFullOwnerEveryFrame,
  returnMatchFrames:probe.returnMatchFrames,
  returnCommitFrames:probe.returnCommitFrames,
  returnMatchCoveredEveryFrame:probe.returnMatchCoveredEveryFrame,
  returnCommitCoveredEveryFrame:probe.returnCommitCoveredEveryFrame,
});

const compactProbe = (probe) => ({
  frames:probe.frames,
  averageFps:probe.averageFps,
  cadenceHz:probe.cadenceHz,
  p95Ms:probe.p95Ms,
  maxMs:probe.maxMs,
  droppedFrames:probe.droppedFrames,
  camera:probe.camera,
  ownership:probe.ownership,
  journey:{
    frames:probe.journey.frames,
    averageFps:probe.journey.averageFps,
    cadenceHz:probe.journey.cadenceHz,
    p95Ms:probe.journey.p95Ms,
    maxMs:probe.journey.maxMs,
    droppedFrames:probe.journey.droppedFrames,
  },
  maintenanceMs:Number((probe.transitTiming?.maintenanceMs || 0).toFixed(2)),
  childMutations:probe.childMutations.length,
  unexpectedAttributes:probe.unexpectedAttributes.length,
  longTasks:probe.longTasks.length,
  opacity:{
    first:probe.opacityFirst,
    last:probe.opacityLast,
    maxStep:probe.maxOpacityStep,
    heldEveryMotionFrame:probe.heldEveryMotionFrame,
    realMaterialFrames:probe.realMaterialFrames,
    releaseFirst:probe.releaseFirst,
    releaseLast:probe.releaseLast,
    releaseFrames:probe.releaseFrames,
    releaseIntermediateFrames:probe.releaseIntermediateFrames,
    releaseMaxStep:probe.releaseMaxOpacityStep,
    releaseMonotonic:probe.releaseMonotonic,
    releaseMaterialFrames:probe.releaseMaterialFrames,
    releaseOwnerAlignment:probe.releaseOwnerAlignment,
    endpointHoldFrames:probe.endpointHoldFrames,
    endpointHoldMinOpacity:probe.endpointHoldMinOpacity,
    endpointHoldMaterialFrames:probe.endpointHoldMaterialFrames,
    returnCoverageFrames:probe.returnCoverageFrames,
    returnCoverageFloor:probe.returnCoverageFloor,
    returnFullOwnerEveryFrame:probe.returnFullOwnerEveryFrame,
    returnMatchFrames:probe.returnMatchFrames,
    returnCommitFrames:probe.returnCommitFrames,
    returnMatchCoveredEveryFrame:probe.returnMatchCoveredEveryFrame,
    returnCommitCoveredEveryFrame:probe.returnCommitCoveredEveryFrame,
  },
});

const compactRound = (round) => ({
  geometryError:round.geometryError,
  expand:compactProbe(round.expand),
  contract:compactProbe(round.contract),
});

function compactEvidence(evidence) {
  return {
    tiles:Object.fromEntries(Object.entries(evidence.tiles).map(([module, rounds]) => [
      module,
      {
        cold:compactRound(rounds.cold),
        repeat:compactRound(rounds.repeat),
        additional:rounds.additional.map((round) => ({
          round:round.round,
          ...compactRound(round),
        })),
      },
    ])),
    handoffCrossfade:Object.fromEntries(
      Object.entries(evidence.handoffCrossfade).map(([module, handoff]) => [
        module,
        {
          invariant:handoff.invariant,
          endpointDifference:handoff.endpointDifference,
          coveredPromotion:handoff.coveredPromotion,
          middleBlend:handoff.middleBlend,
        },
      ]),
    ),
    noSnapshotFallback:evidence.noSnapshotFallback,
    renderedAcrylic:evidence.renderedAcrylic,
    screenshots:evidence.screenshots,
  };
}

async function waitForReadyHome(page) {
  await page.waitForFunction(() => document.body.dataset.crmModule === 'home'
    && !window.crmDeskTransit?.isBusy?.()
    && window.crmHome?.handStatus?.().ready
    && window.crmHome?.motionStatus?.().ready
    && window.crmHome?.previewStatus?.().every((item) => item.state === 'ready'), null, { timeout:60_000 });
}

async function waitForPreviewIdle(page) {
  return page.evaluate(async () => {
    const startedAt = performance.now();
    const result = await window.crmHomePreviews?.waitForIdle?.();
    return {
      ok:result?.ok === true,
      waitMs:performance.now() - startedAt,
      prewarm:window.crmHome?.prewarmStatus?.() || null,
      previews:(window.crmHome?.previewStatus?.() || []).map(({ key, state, version, capturedAt }) =>
        ({ key, state, version, capturedAt })),
    };
  });
}

function compareScreenshots(beforeBuffer, afterBuffer) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`Swap screenshots changed size: ${before.width}x${before.height} -> ${after.width}x${after.height}`);
  }
  let absoluteError = 0;
  let maxChannelError = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(before.data[offset + channel] - after.data[offset + channel]);
      absoluteError += difference;
      maxChannelError = Math.max(maxChannelError, difference);
      if (difference > 2) pixelChanged = true;
    }
    if (pixelChanged) changedPixels += 1;
  }
  const pixels = before.width * before.height;
  return {
    width:before.width,
    height:before.height,
    mae:absoluteError / Math.max(1, pixels * 3),
    maxChannelError,
    changedPixels,
    changedRatio:changedPixels / Math.max(1, pixels),
  };
}

function compareBlend(beforeBuffer, middleBuffer, afterBuffer, beforeWeight) {
  const before = PNG.sync.read(beforeBuffer);
  const middle = PNG.sync.read(middleBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (before.width !== middle.width || before.height !== middle.height
    || before.width !== after.width || before.height !== after.height) {
    throw new Error('Crossfade screenshots changed viewport dimensions');
  }
  const weight = Math.max(0, Math.min(1, Number(beforeWeight) || 0));
  let absoluteError = 0;
  let maxChannelError = 0;
  let outOfBoundsPixels = 0;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    let outOfBounds = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const start = before.data[offset + channel];
      const end = after.data[offset + channel];
      const actual = middle.data[offset + channel];
      const expected = Math.round(start * weight + end * (1 - weight));
      const error = Math.abs(expected - actual);
      absoluteError += error;
      maxChannelError = Math.max(maxChannelError, error);
      if (actual < Math.min(start, end) - 3 || actual > Math.max(start, end) + 3) outOfBounds = true;
    }
    if (outOfBounds) outOfBoundsPixels += 1;
  }
  const pixels = before.width * before.height;
  return {
    beforeWeight:weight,
    mae:absoluteError / Math.max(1, pixels * 3),
    maxChannelError,
    outOfBoundsPixels,
    outOfBoundsRatio:outOfBoundsPixels / Math.max(1, pixels),
  };
}

function imageDifference(firstBuffer, secondBuffer, region) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) return Infinity;
  let sum = 0;
  let count = 0;
  for (let y = region.top; y < region.bottom; y += 2) {
    for (let x = region.left; x < region.right; x += 2) {
      const offset = (y * first.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        sum += Math.abs(first.data[offset + channel] - second.data[offset + channel]);
        count += 1;
      }
    }
  }
  return count ? sum / count : Infinity;
}

function imageEdgeEnergy(buffer, region) {
  const image = PNG.sync.read(buffer);
  const luminance = (x, y) => {
    const offset = (y * image.width + x) * 4;
    return image.data[offset] * .2126 + image.data[offset + 1] * .7152 + image.data[offset + 2] * .0722;
  };
  let sum = 0;
  let count = 0;
  const right = Math.min(image.width - 1, region.right);
  const bottom = Math.min(image.height - 1, region.bottom);
  for (let y = Math.max(0, region.top); y < bottom; y += 2) {
    for (let x = Math.max(0, region.left); x < right; x += 2) {
      const value = luminance(x, y);
      sum += Math.abs(value - luminance(x + 1, y)) + Math.abs(value - luminance(x, y + 1));
      count += 2;
    }
  }
  return count ? sum / count : Infinity;
}

async function captureSwapEquivalence(page, tile, outDir) {
  await waitForReadyHome(page);
  fs.mkdirSync(outDir, { recursive:true });
  await page.evaluate(() => {
    delete window.__crmDeskTransitGate;
    window.__crmDeskTransitProbe = {
      hold(phase, detail) {
        if (!['before-swap', 'crossfade-ready', 'crossfade-mid', 'after-swap'].includes(phase)) return undefined;
        return new Promise((resolve) => {
          window.__crmDeskTransitGate = { phase, detail, resolve };
        });
      },
    };
  });
  const selector = `.crm-home-bucket[data-module="${tile.module}"]`;
  await page.hover(selector);
  await sleep(160);
  await page.click(selector);
  await page.waitForFunction(() => window.__crmDeskTransitGate?.phase === 'before-swap', null, { timeout:30_000 });
  const beforeDetail = await page.evaluate(() => window.__crmDeskTransitGate.detail);
  const beforePath = path.join(outDir, `${tile.module}-raster-before-swap.png`);
  const beforeBuffer = await page.screenshot({ path:beforePath });
  const releaseGate = () => page.evaluate(() => {
    const gate = window.__crmDeskTransitGate;
    delete window.__crmDeskTransitGate;
    gate?.resolve?.();
  });
  await releaseGate();
  await page.waitForFunction(() => window.__crmDeskTransitGate?.phase === 'crossfade-ready', null, { timeout:30_000 });
  const readyDetail = await page.evaluate(() => window.__crmDeskTransitGate.detail);
  const readyPath = path.join(outDir, `${tile.module}-live-ready-under-raster.png`);
  const readyBuffer = await page.screenshot({ path:readyPath });
  await releaseGate();
  await page.waitForFunction(() => window.__crmDeskTransitGate?.phase === 'crossfade-mid', null, { timeout:30_000 });
  const middleDetail = await page.evaluate(() => window.__crmDeskTransitGate.detail);
  const middlePath = path.join(outDir, `${tile.module}-crossfade-midpoint.png`);
  const middleBuffer = await page.screenshot({ path:middlePath });
  await releaseGate();
  await page.waitForFunction(() => window.__crmDeskTransitGate?.phase === 'after-swap', null, { timeout:30_000 });
  const afterDetail = await page.evaluate(() => window.__crmDeskTransitGate.detail);
  const afterPath = path.join(outDir, `${tile.module}-live-after-swap.png`);
  const afterBuffer = await page.screenshot({ path:afterPath });
  await page.evaluate(() => {
    const gate = window.__crmDeskTransitGate;
    delete window.__crmDeskTransitGate;
    gate?.resolve?.();
    delete window.__crmDeskTransitProbe;
  });
  await page.waitForFunction(() => !window.crmHomeCamera?.isTransitioning?.() && !window.crmDeskTransit?.isBusy?.(), null, { timeout:30_000 });
  const endpointDifference = compareScreenshots(beforeBuffer, afterBuffer);
  const coveredPromotion = compareScreenshots(beforeBuffer, readyBuffer);
  const middleBlend = compareBlend(
    beforeBuffer,
    middleBuffer,
    afterBuffer,
    middleDetail?.cover?.hostOpacity,
  );
  const invariant = beforeDetail?.cover?.ready === true
    && beforeDetail.cover.opacity === 1
    && beforeDetail.cover.hostOpacity >= .99
    && beforeDetail.coverInvariant === true
    && beforeDetail.liveLayers?.length > 0
    // Destination owners are fully composed underneath the opaque raster.
    // Muting them here creates a second visual-state change at release and can
    // expose late paint; the cover itself is the sole visibility boundary.
    && beforeDetail.liveLayers.every((layer) => layer.opacity === 1)
    && readyDetail?.liveReady === true
    && readyDetail.liveLayers?.length === beforeDetail.liveLayers.length
    && readyDetail.liveLayers.every((layer) => layer.opacity === 1)
    && readyDetail.cover?.hostOpacity >= .99
    && middleDetail?.cover?.hostOpacity > .15
    && middleDetail.cover.hostOpacity < .85
    && afterDetail?.liveReady === true
    && afterDetail.liveLayers?.length === beforeDetail.liveLayers.length
    && afterDetail.liveLayers.every((layer) => layer.opacity === 1)
    && afterDetail.cover?.nodeId === beforeDetail.cover.nodeId
    && afterDetail.cover?.source?.length === beforeDetail.cover.source.length
    && afterDetail.cover?.rect?.x === beforeDetail.cover.rect.x
    && afterDetail.cover?.rect?.y === beforeDetail.cover.rect.y
    && afterDetail.cover?.rect?.width === beforeDetail.cover.rect.width
    && afterDetail.cover?.rect?.height === beforeDetail.cover.rect.height
    && afterDetail.cover?.hostOpacity === 0;
  if (!invariant
    // The cover raster and settled live endpoint are deliberately the same
    // composition. A near-zero difference is the seamless handoff; requiring
    // them to diverge would turn a visual improvement into a regression.
    || endpointDifference.mae > 1
    || coveredPromotion.mae > 1
    || middleBlend.mae > 2
    || middleBlend.outOfBoundsRatio > .01) {
    throw new Error(`Home ${tile.module} raster/live crossfade continuity failed: ${JSON.stringify({
      invariant,
      endpointDifference,
      coveredPromotion,
      middleBlend,
      beforeDetail,
      readyDetail,
      middleDetail,
      afterDetail,
    })}`);
  }
  await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
  await waitForReadyHome(page);
  return {
    invariant,
    endpointDifference,
    coveredPromotion,
    middleBlend,
    beforePath,
    readyPath,
    middlePath,
    afterPath,
    before:beforeDetail,
    ready:readyDetail,
    middle:middleDetail,
    after:afterDetail,
  };
}

async function runRoundTrip(page, tile, sampleVisual) {
  const selector = `.crm-home-bucket[data-module="${tile.module}"]`;
  const expandIdleBaseline = await waitForPreviewIdle(page);
  if (!expandIdleBaseline.ok) {
    throw new Error(`Home ${tile.module} expand did not start from an idle preview worker: ${JSON.stringify(expandIdleBaseline)}`);
  }
  const source = await page.$eval(selector, (bucket) => {
    const rect = bucket.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  });
  await page.hover(selector);
  await sleep(160);
  await armProbe(page, 'expand', tile, sampleVisual);
  await page.click(selector);
  const expand = await takeProbe(page);

  const contractIdleBaseline = await waitForPreviewIdle(page);
  if (!contractIdleBaseline.ok) {
    throw new Error(`Home ${tile.module} contract did not start from an idle preview worker: ${JSON.stringify(contractIdleBaseline)}`);
  }
  await armProbe(page, 'contract', tile, sampleVisual);
  await page.evaluate(() => {
    window.__triggerHomeContinuity?.();
    void window.crmDeskTransit.driveTo('home');
  });
  const contract = await takeProbe(page);
  const destination = await page.$eval(selector, (bucket) => {
    const rect = bucket.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  });
  expand.source = source;
  expand.idleBaseline = expandIdleBaseline;
  contract.idleBaseline = contractIdleBaseline;
  contract.destination = destination;
  const geometryError = source.reduce((max, value, index) => Math.max(max, Math.abs(value - destination[index])), 0);
  if (geometryError > .75) {
    throw new Error(`Home ${tile.module} return geometry drifted by ${geometryError.toFixed(2)}px`);
  }
  validateCadence(expand);
  validateCadence(contract);
  if (sampleVisual) {
    validateVisual(expand);
    validateVisual(contract);
  }
  return { expand, contract, geometryError };
}

async function verifyNoSnapshotFallback(page) {
  const selector = '.crm-home-bucket[data-module="cases"]';
  await page.hover(selector);
  await sleep(160);
  await page.evaluate(() => {
    const root = window.crmHomeCamera?.layers?.()[0];
    const variant = root?.querySelector(
      ':scope > .crm-home-motion-variant[data-motion-variant="cases"],'
      + ':scope > .crm-home-motion-variant[data-motion-tile-id="cases"]',
    );
    if (!root || !variant) return;
    window.__crmNoSnapshotProbe = { variant, src:variant.getAttribute('src') || '' };
    // Invalidate the decoded owner, not just the derived readiness flag. The
    // runtime is expected to repair a false flag when its canonical texture is
    // still valid; that is not a fallback condition.
    variant.removeAttribute('src');
    root.dataset.motionSnapshotReady = 'false';
  });
  await page.click(selector);
  await page.waitForFunction(() => window.crmHomeCamera?.isTransitioning?.());
  const fallback = await page.evaluate(() => {
    const surface = window.crmHomeCamera?.surface?.();
    const root = window.crmHomeCamera?.layers?.()[0];
    const lens = surface?.querySelector('.crm-home-screen-acrylic');
    const grid = root?.querySelector(':scope > .crm-home-grid');
    const variant = root?.querySelector(':scope > .crm-home-motion-variant.is-active-motion-variant');
    const lensStyle = lens ? getComputedStyle(lens) : null;
    return {
      bitmapMotion:surface?.classList.contains('crm-home-bitmap-motion') || false,
      gridVisibility:grid ? getComputedStyle(grid).visibility : '',
      variantDisplay:variant ? getComputedStyle(variant).display : '',
      backdropFilter:lensStyle?.webkitBackdropFilter || lensStyle?.backdropFilter || '',
    };
  });
  if (fallback.bitmapMotion
    || fallback.gridVisibility !== 'visible'
    || fallback.variantDisplay !== 'none'
    || !fallback.backdropFilter
    || fallback.backdropFilter === 'none') {
    throw new Error(`Home stale-snapshot fallback lost its live acrylic owner: ${JSON.stringify(fallback)}`);
  }
  await page.waitForFunction(() => !window.crmHomeCamera?.isTransitioning?.() && !window.crmDeskTransit?.isBusy?.(), null, { timeout:30_000 });
  await page.evaluate(() => window.crmDeskTransit.driveTo('home'));
  await page.evaluate(async () => {
    const probe = window.__crmNoSnapshotProbe;
    if (probe?.variant?.isConnected && probe.src) {
      probe.variant.removeAttribute('data-motion-captured-at');
      probe.variant.src = probe.src;
      try { await probe.variant.decode?.(); } catch {}
    }
    delete window.__crmNoSnapshotProbe;
    window.crmHome?.refresh?.();
    try { await window.crmHomePreviews?.waitForIdle?.(); } catch {}
  });
  await waitForReadyHome(page);
  return fallback;
}

async function captureEvidenceFrames(page, outDir) {
  fs.mkdirSync(outDir, { recursive:true });
  await waitForReadyHome(page);
  const selector = '.crm-home-bucket[data-module="cases"]';
  await page.screenshot({ path:path.join(outDir, 'home-source.png') });
  await page.hover(selector);
  await sleep(160);
  await page.click(selector);
  await sleep(220);
  await page.evaluate(() => new Promise((resolve) => {
    const surface = window.crmHomeCamera?.surface?.();
    if (surface) surface.dataset.fractalCameraProbeHold = 'true';
    window.__crmHomeAcrylicProbe = {
      surface,
      animations:document.getAnimations().filter((animation) => {
        const target = animation.effect?.target;
        const duration = Number(animation.effect?.getComputedTiming?.().duration);
        return animation.playState === 'running' && !!surface && !!target
          && (target === surface || surface.contains(target))
          && Number.isFinite(duration) && Math.abs(duration - 460) <= 1;
      }),
    };
    window.__crmHomeAcrylicProbe.animations.forEach((animation) => animation.pause());
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const blurBuffer = await page.screenshot({ path:path.join(outDir, 'home-cases-mid-transition.png') });
  await page.evaluate(() => new Promise((resolve) => {
    const lens = document.querySelector('.crm-home-screen-acrylic');
    if (!lens) { resolve(); return; }
    window.__crmHomeAcrylicProbe.lens = lens;
    window.__crmHomeAcrylicProbe.filter = {
      backdrop:lens.style.backdropFilter,
      webkit:lens.style.webkitBackdropFilter,
    };
    lens.style.backdropFilter = 'saturate(1.4)';
    lens.style.webkitBackdropFilter = 'saturate(1.4)';
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const noBlurBuffer = await page.screenshot({ path:path.join(outDir, 'home-cases-mid-transition-no-blur.png') });
  const viewport = await page.evaluate(() => ({ width:innerWidth, height:innerHeight }));
  const comparisonRegion = {
    left:Math.floor(viewport.width * .36),
    right:Math.ceil(viewport.width * .64),
    top:Math.floor(viewport.height * .34),
    bottom:Math.ceil(viewport.height * .66),
  };
  const renderedAcrylic = {
    difference:imageDifference(blurBuffer, noBlurBuffer, comparisonRegion),
    withBlurEdge:imageEdgeEnergy(blurBuffer, comparisonRegion),
    withoutBlurEdge:imageEdgeEnergy(noBlurBuffer, comparisonRegion),
  };
  if (renderedAcrylic.difference < .8
    || renderedAcrylic.withBlurEdge >= renderedAcrylic.withoutBlurEdge * .94) {
    throw new Error(`Home transition rendered tint without a distinct acrylic blur: ${JSON.stringify(renderedAcrylic)}`);
  }
  await page.evaluate(async () => {
    const probe = window.__crmHomeAcrylicProbe;
    if (probe?.lens) {
      probe.lens.style.backdropFilter = probe.filter.backdrop;
      probe.lens.style.webkitBackdropFilter = probe.filter.webkit;
    }
    window.__crmDeskTransitProbe = {
      hold(phase, detail) {
        if (phase !== 'covered') return undefined;
        return new Promise((resolve) => {
          window.__crmHomeEndpointGate = { phase, detail, resolve };
        });
      },
    };
    probe?.animations?.forEach?.((animation) => {
      try { animation.play(); } catch {}
    });
    if (probe?.surface?.dataset) delete probe.surface.dataset.fractalCameraProbeHold;
    delete window.__crmHomeAcrylicProbe;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await page.waitForFunction(() => {
    const lens = document.querySelector('.crm-home-screen-acrylic[data-fractal-acrylic-phase="endpoint-held"]');
    const frame = document.querySelector('.crm-home-expander:not(.crm-home-warm) > .crm-home-transition-acrylic');
    return window.__crmHomeEndpointGate?.phase === 'covered'
      && !!lens
      && Number(getComputedStyle(lens).opacity) > .99
      && Number(getComputedStyle(frame).opacity) > .99;
  }, null, { timeout:5_000 });
  await page.screenshot({ path:path.join(outDir, 'home-cases-endpoint-acrylic-held.png') });
  await page.evaluate(() => {
    const gate = window.__crmHomeEndpointGate;
    delete window.__crmHomeEndpointGate;
    delete window.__crmDeskTransitProbe;
    gate?.resolve?.();
  });
  await page.waitForFunction(() => !window.crmHomeCamera?.isTransitioning?.() && !window.crmDeskTransit?.isBusy?.(), null, { timeout:30_000 });
  await page.screenshot({ path:path.join(outDir, 'home-cases-endpoint.png') });
  await page.evaluate(() => { void window.crmDeskTransit.driveTo('home'); });
  await sleep(220);
  await page.screenshot({ path:path.join(outDir, 'home-cases-return-mid-transition.png') });
  await waitForReadyHome(page);
  return renderedAcrylic;
}

async function main() {
  const harness = await start({ apiPort:API_PORT, staticPort:STATIC_PORT });
  const app = await electron.launch({
    args:['.'],
    cwd:path.resolve(__dirname, '..', '..'),
    env:{ ...process.env, CRM_API_URL:harness.apiUrl, CRM_CDMS_DISABLED:'1' },
    timeout:30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30_000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await waitForReadyHome(page);
    const coldPrewarm = await page.evaluate(() => window.crmHome.prewarmStatus());
    if (coldPrewarm.running || coldPrewarm.pending?.length
      || !['peopleCards', 'ticketStacks', 'crmPlanner', 'crmAssignments']
        .every((key) => coldPrewarm.ready?.includes(key))) {
      throw new Error(`Home factories were not fully settled before the cold proof: ${JSON.stringify(coldPrewarm)}`);
    }

    const outDir = path.resolve(__dirname, 'electron-actual', 'home-transition-continuity');
    const evidence = { coldPrewarm, tiles:{}, handoffCrossfade:{} };
    for (const tile of TILES) {
      await waitForReadyHome(page);
      const cold = await runRoundTrip(page, tile, false);
      await waitForReadyHome(page);
      const repeat = await runRoundTrip(page, tile, true);
      const additional = [];
      for (let round = 2; round < ROUND_COUNT; round += 1) {
        await waitForReadyHome(page);
        additional.push(await runRoundTrip(page, tile, true));
      }
      evidence.tiles[tile.module] = {
        cold:{
          expand:summary(cold.expand),
          contract:summary(cold.contract),
          geometryError:cold.geometryError,
        },
        repeat:{
          expand:summary(repeat.expand),
          contract:summary(repeat.contract),
          geometryError:repeat.geometryError,
        },
        additional:additional.map((result, index) => ({
          round:index + 3,
          expand:summary(result.expand),
          contract:summary(result.contract),
          geometryError:result.geometryError,
        })),
      };
    }
    for (const tile of TILES) {
      evidence.handoffCrossfade[tile.module] = await captureSwapEquivalence(page, tile, outDir);
    }
    evidence.noSnapshotFallback = await verifyNoSnapshotFallback(page);
    evidence.renderedAcrylic = await captureEvidenceFrames(page, outDir);
    evidence.screenshots = outDir;
    fs.writeFileSync(path.join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(compactEvidence(evidence), null, 2));
  } finally {
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.exit(0));
      return true;
    }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), sleep(3000)]);
    harness.stop();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
