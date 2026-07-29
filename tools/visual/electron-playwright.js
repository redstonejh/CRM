'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOTION_TARGET = { nativeHz: 100, maxFrameMs: 15, maxOver15Ms: 0, maxLongTasks: 0 };
const HOME_PREVIEW_VERSION = 'filtered-home-v46';
const HOME_PREVIEW_REST_FILTER = 'blur(0.65px)';
let nativeRefreshCalibration = null;
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

async function calibrateNativeRefresh(page, frameCount = 120) {
  return page.evaluate((count) => new Promise((resolve) => {
    const deltas = [];
    let previous = 0;
    let warmup = 8;
    const finish = () => {
      const sorted = [...deltas].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)] || 0;
      const measuredMs = deltas.reduce((sum, value) => sum + value, 0);
      resolve({
        frames:deltas.length,
        fps:measuredMs ? deltas.length * 1000 / measuredMs : 0,
        medianMs,
        nativeHz:medianMs ? Math.round(1000 / medianMs) : 0,
        maxMs:sorted.at(-1) || 0,
        over15Ms:deltas.filter((value) => value > 15).length,
      });
    };
    const tick = (now) => {
      if (warmup > 0) {
        warmup -= 1;
        previous = now;
        requestAnimationFrame(tick);
        return;
      }
      if (previous) deltas.push(now - previous);
      previous = now;
      if (deltas.length >= count) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frameCount);
}

async function installMotionProbe(page) {
  await page.evaluate(() => {
    window.__crmMotionProbes ||= {};
    window.__startCrmMotionProbe = (probeLabel, timeoutMs = 1800) => {
      const probe = {
        label:probeLabel,
        armedAt:performance.now(),
        motionStartedAt:0,
        motionEndedAt:0,
        motionDeltas:[],
        cadenceDeltas:[],
        motionSamples:[],
        observedLongTasks:[],
        done:false,
      };
      const longObserver = typeof PerformanceObserver === 'function'
        ? new PerformanceObserver((list) => list.getEntries().forEach((entry) => probe.observedLongTasks.push({
          startTime:entry.startTime,
          duration:entry.duration,
        })))
        : null;
      try { longObserver?.observe({ entryTypes:['longtask'] }); } catch {}
      probe.promise = new Promise((resolve) => {
        let previous = 0;
        let previousMoving = false;
        let sawMotion = false;
        const finish = (now, timedOut = false) => {
          longObserver?.takeRecords?.().forEach((entry) => probe.observedLongTasks.push({
            startTime:entry.startTime,
            duration:entry.duration,
          }));
          longObserver?.disconnect?.();
          const cadenceMeasured = probe.cadenceDeltas;
          const sorted = [...cadenceMeasured].sort((a, b) => a - b);
          const cadenceMs = cadenceMeasured.reduce((sum, value) => sum + value, 0);
          const cadenceSorted = [...cadenceMeasured].sort((a, b) => a - b);
          const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))] || 0;
          const medianMs = cadenceSorted[Math.floor(cadenceSorted.length / 2)] || 0;
          const motionStart = probe.motionStartedAt || now;
          const motionEnd = probe.motionEndedAt || now;
          const longTasks = probe.observedLongTasks.filter((entry) =>
            entry.startTime < motionEnd && entry.startTime + entry.duration > motionStart);
          probe.result = {
            label: probeLabel,
            durationMs: Math.max(0, motionEnd - motionStart),
            sawMotion,
            timedOut,
            frames: cadenceMeasured.length,
            fps: cadenceMs ? cadenceMeasured.length * 1000 / cadenceMs : 0,
            cadenceFps: cadenceMs ? cadenceMeasured.length * 1000 / cadenceMs : 0,
            firstFrameMs:probe.motionSamples.find((sample)=>sample.first)?.delta ?? null,
            medianMs,
            nativeHz: medianMs ? Math.round(1000 / medianMs) : 0,
            p95Ms: percentile(.95),
            p99Ms: percentile(.99),
            maxMs: sorted.at(-1) || 0,
            over15Ms: cadenceMeasured.filter((value) => value > 15).length,
            slowFrames: probe.motionSamples.filter((sample) => !sample.first && sample.delta > 15),
            longTasks,
          };
          probe.done = true;
          resolve(probe.result);
        };
        const tick = (now) => {
          // `isTransitioning()` begins during covered precomposition. The
          // coordinator's motion phase starts and ends with the real CSS
          // transform, which is the interval whose native cadence matters.
          const motionState = window.crmDeskTransit?.motionState?.() || {};
          const moving = motionState.active === true;
          if (moving && !sawMotion) {
            sawMotion = true;
            const reportedStart = motionState.startedAt == null ? NaN : Number(motionState.startedAt);
            probe.motionStartedAt = Number.isFinite(reportedStart) && reportedStart > 0 && reportedStart <= now
              ? reportedStart
              : now;
            const firstDelta = now - probe.motionStartedAt;
            if (firstDelta > 0) {
              probe.motionDeltas.push(firstDelta);
              probe.motionSamples.push({ at:firstDelta, delta:firstDelta, first:true });
            }
          }
          // Only intervals bracketed by two moving paints contribute to the
          // cadence result. The callback performs no style or layout reads.
          if (moving && previousMoving && previous) {
            const delta = now - previous;
            probe.motionDeltas.push(delta);
            probe.cadenceDeltas.push(delta);
            probe.motionSamples.push({ at:now - probe.motionStartedAt, delta });
          }
          if (!moving && previousMoving && sawMotion) {
            probe.motionEndedAt = now;
            finish(now);
            return;
          }
          if (now - probe.armedAt >= timeoutMs) {
            probe.motionEndedAt = now;
            finish(now, true);
            return;
          }
          previous = now;
          previousMoving = moving;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      window.__crmMotionProbes[probeLabel] = probe;
      return probe;
    };
  });
}

async function finishMotionProbe(page, label) {
  return page.evaluate((probeLabel) => window.__crmMotionProbes?.[probeLabel]?.promise, label);
}

async function startEndpointProbe(page, label, room, direction) {
  await page.evaluate(({ probeLabel, config, motionDirection }) => {
    window.__crmEndpointProbes ||= {};
    const probe = { label: probeLabel, direction: motionDirection, samples: [], acrylicSamples: [], settled: false, tailFrames: 3 };
    probe.promise = new Promise((resolve) => {
      const theaterName = config.theater;
      const objectSelector = [
        '.crm-overview-project', '.crm-overview-ticket', '.crm-overview-update',
        '.crm-planner-bucket', '.crm-planner-card',
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
      let activatedAt = 0;
      let acrylicKeyframes = [];
      const capture = () => {
        const surface = window.crmHomeCamera?.surface?.();
        const root = window.crmHomeCamera?.layers?.()[0];
        // Camera "transitioning" also covers the intentionally static covered
        // precomposition frame. Bracket visual-motion invariants against the
        // coordinator's exact transform interval, just like the cadence probe.
        const moving = window.crmDeskTransit?.motionState?.().active === true;
        const materializing = document.documentElement.classList.contains('crm-transit-materializing');
        const homeHandoff = !!surface?.classList.contains('crm-home-camera-handoff');
        const materialMoving = !!surface?.classList.contains(motionDirection === 'in' ? 'crm-home-acrylic-expanding' : 'crm-home-acrylic-contracting');
        const acrylic = document.querySelector('.crm-home-surface .crm-home-screen-acrylic')
          || document.querySelector('.crm-home-expander:not(.crm-home-warm) > .crm-home-transition-acrylic');
        const peripheralAcrylic = surface?.querySelector?.('.crm-home-peripheral-screen-acrylic');
        const peripheralStyle = peripheralAcrylic && getComputedStyle(peripheralAcrylic);
        const peripheralBackdrop = peripheralStyle?.webkitBackdropFilter || peripheralStyle?.backdropFilter || '';
        const peripheralHostStyle = peripheralAcrylic?.parentElement && getComputedStyle(peripheralAcrylic.parentElement);
        const peripheralAcrylicOwned = !!peripheralAcrylic
          && peripheralAcrylic.parentElement?.parentElement === surface
          && surface.classList.contains('crm-home-peripheral-acrylic-active')
          && Number(peripheralStyle.opacity) > .99
          && peripheralBackdrop.includes('blur(') && peripheralBackdrop.includes('saturate(')
          && peripheralHostStyle?.clipPath?.startsWith('path(');
        if (moving && materialMoving && acrylic) {
          const acrylicOpacity = Number(getComputedStyle(acrylic).opacity);
          probe.acrylicSamples.push(acrylicOpacity);
          if (!acrylicKeyframes.length) {
            const opacityAnimation = [...(acrylic.getAnimations?.() || [])].find((animation) =>
              animation.effect?.getKeyframes?.().some((keyframe) => keyframe.opacity != null));
            acrylicKeyframes = (opacityAnimation?.effect?.getKeyframes?.() || []).map((keyframe) => [keyframe.computedOffset, Number(keyframe.opacity)]);
          }
        }
        // This is the intentionally style-heavy visual pass. Native cadence is
        // measured later in isolated cycles with this probe completely absent.
        if (moving) {
          const grid = root?.querySelector?.(':scope > .crm-home-grid');
          const titleLayer = root?.querySelector?.(':scope > .crm-home-title-layer');
          const hand = root?.querySelector?.(':scope > .crm-home-priority-hand');
          const activeCutout = root?.querySelector?.(':scope > .crm-home-motion-variant.is-active-motion-variant');
          const cutoutStyle = activeCutout && getComputedStyle(activeCutout);
          const liveOwnersHidden = [grid, titleLayer, hand].every((node) =>
            node && getComputedStyle(node).visibility === 'hidden');
          const activeCutoutVisible = !!activeCutout
            && activeCutout.complete && activeCutout.naturalWidth > 0
            && cutoutStyle.display !== 'none' && cutoutStyle.visibility !== 'hidden'
            && Number(cutoutStyle.opacity) > .99;
          probe.samples.push({
            at:performance.now() - startedAt,
            module:document.body.dataset.crmModule || '',
            busy:!!window.crmDeskTransit?.isBusy?.(),
            moving:true,
            materializing,
            veil:!!document.querySelector('.crm-transit-veil'),
            veilReleasing:false,
            roomRevealing:document.documentElement.classList.contains('crm-transit-revealing'),
            homeHandoff,
            homeReleasing:!!surface?.classList.contains('crm-home-camera-releasing'),
            bitmapMotion:!!surface?.classList.contains('crm-home-bitmap-motion'),
            motionCutoutOwned:root?.dataset?.motionSnapshotReady === 'true' && activeCutoutVisible,
            activeCutoutVisible,
            liveOwnersHidden,
            rootTransformReady:!!root && getComputedStyle(root).willChange.includes('transform'),
            materialMoving,
            acrylicOpacity:probe.acrylicSamples.at(-1) ?? null,
            peripheralAcrylicOwned,
          });
          requestAnimationFrame(capture);
          return;
        }
        const sampleAlignment = moving && probe.samples.length % 2 === 0;
        const cameraTarget = root?.querySelector?.(`.crm-home-bucket[data-module="${config.key}"]`);
        const target = sampleAlignment ? cameraTarget : null;
        const expander = sampleAlignment ? surface?.querySelector?.('.crm-home-expander:not(.crm-home-warm)') : null;
        const targetRect = sampleAlignment ? rect(target) : null; const expanderRect = sampleAlignment ? rect(expander) : null;
        const theater = materializing
          ? [...document.querySelectorAll(`[data-crm-theater="${theaterName}"]`)].find((node) => node.hasAttribute('data-crm-transit-destination')) : null;
        // The incoming theater now exists for the whole camera move. Walking
        // eighty styled objects every rAF would manufacture the very hitch this
        // probe measures, so census its single compositor root in motion and
        // take the full stable signature only after transform completion.
        const fullRoomCensus = !!theater && !moving;
        const objects = theater ? (fullRoomCensus ? [theater, ...theater.querySelectorAll(objectSelector)] : [theater]) : [];
        const roomLayers = theater ? [...theater.querySelectorAll('[data-crm-transit-layer]'), ...(theater.matches('[data-crm-transit-layer]') ? [theater] : [])] : [];
        const homeGrid = root?.querySelector?.('.crm-home-grid');
        const homeHand = root?.querySelector?.('.crm-home-priority-hand');
        const homeBuckets = root ? [...root.querySelectorAll('.crm-home-grid > .crm-home-bucket')] : [];
        const homeNodes = homeHandoff && root ? [homeGrid, ...root.querySelectorAll('.crm-home-grid > .crm-home-bucket, .crm-home-priority-hand, .crm-home-hand-card')].filter(Boolean) : [];
        const snapshot = root?.querySelector?.(':scope > .crm-home-motion-snapshot');
        const homeBucket = homeHandoff ? root?.querySelector?.('.crm-home-grid > .crm-home-bucket') : null;
        const handoffVariant = homeHandoff ? root?.querySelector?.(':scope > .crm-home-motion-variant.is-active-motion-variant') : null;
        const homeMaterialsReady = homeHandoff && homeBuckets.length === 4 && homeBuckets.every((bucket) => {
          const style = getComputedStyle(bucket); const backdrop = style.webkitBackdropFilter || style.backdropFilter;
          return backdrop.includes('blur(') && style.backgroundImage !== 'none' && style.boxShadow.includes('26px -16px');
        });
        const homeOwnersContinuous = homeHandoff && !!cameraTarget && !!handoffVariant
          && getComputedStyle(handoffVariant).display !== 'none'
          && Number(getComputedStyle(cameraTarget).opacity) > .99
          && homeBuckets.filter((bucket) => bucket !== cameraTarget).every((bucket) => Number(getComputedStyle(bucket).opacity) <= .01)
          && Number(getComputedStyle(homeHand).opacity) <= .01;
        const homePeripheralReady = homeHandoff && peripheralAcrylicOwned;
        const veil = document.querySelector('.crm-transit-veil');
        const ownershipFade = window.crmDeskTransit?.ownershipFadeState?.();
        const endpointCover = window.crmDeskTransit?.coverState?.();
        if (!acrylicKeyframes.length && acrylic) {
          const opacityAnimation = [...(acrylic?.getAnimations?.() || [])].find((animation) =>
            animation.effect?.getKeyframes?.().some((keyframe) => keyframe.opacity != null));
          acrylicKeyframes = (opacityAnimation?.effect?.getKeyframes?.() || []).map((keyframe) => [keyframe.computedOffset, Number(keyframe.opacity)]);
        }
        const alignment = targetRect && expanderRect ? Math.max(...targetRect.map((value, index) => Math.abs(value - expanderRect[index]))) : null;
        if (!activatedAt && (moving || materializing || homeHandoff || veil)) activatedAt = performance.now();
        probe.samples.push({
          at: performance.now() - startedAt,
          module: document.body.dataset.crmModule || '', busy: !!window.crmDeskTransit?.isBusy?.(),
          moving, alignment, materializing,
          veil: !!veil, veilReleasing: !!veil?.classList.contains('is-releasing'), veilOpacity: veil ? Number(getComputedStyle(veil).opacity) : null,
          roomRevealing: document.documentElement.classList.contains('crm-transit-revealing'), roomOpacity: roomLayers.length ? Math.max(...roomLayers.map((layer) => Number(getComputedStyle(layer).opacity))) : null,
          roomTransitionDuration: roomLayers[0] ? parseFloat(getComputedStyle(roomLayers[0]).transitionDuration) || 0 : 0,
          ownershipFading:ownershipFade?.active === true,
          ownershipFadeDuration:Number(ownershipFade?.duration) || 0,
          sourceRetired:endpointCover?.sourceRetired === true,
          destinationAcrylicStable:endpointCover?.acrylicStable === true,
          destinationAcrylicOwners:Number(endpointCover?.acrylicOwners) || 0,
          homeHandoff,
          homeReleasing: !!surface?.classList.contains('crm-home-camera-releasing'),
          homeGridOpacity: homeGrid ? Number(getComputedStyle(homeGrid).opacity) : null,
          homeHandOpacity: homeHand ? Number(getComputedStyle(homeHand).opacity) : null,
          homeMaterialsReady, homeOwnersContinuous, homePeripheralReady,
          materialMoving,
          acrylicOpacity: acrylic ? Number(getComputedStyle(acrylic).opacity) : null,
          acrylicKeyframes,
          snapshotDisplay: snapshot ? getComputedStyle(snapshot).display : '', snapshotOpacity: snapshot ? Number(getComputedStyle(snapshot).opacity) : null,
          roomSignature: fullRoomCensus && objects.length ? signature(objects, roomLayers) : '', roomObjects: objects.length,
          homeSignature: homeNodes.length ? signature(homeNodes, [root?.querySelector('.crm-home-priority-hand'), ...root.querySelectorAll('.crm-home-grid > .crm-home-bucket')]) : '',
          homeShadow: homeBucket ? getComputedStyle(homeBucket).boxShadow : '',
        });
        if (probe.settled) probe.tailFrames -= 1;
        const timedOut = activatedAt ? performance.now() - activatedAt > 1800 : performance.now() - startedAt > 5000;
        if ((probe.settled && probe.tailFrames <= 0) || timedOut) {
          document.removeEventListener('crm:desk-transit-settled', onSettled);
          const endpoint = motionDirection === 'in'
            ? probe.samples.filter((sample) => sample.roomRevealing && sample.roomSignature)
            : probe.samples.filter((sample) => sample.homeHandoff && sample.homeSignature);
          const movingSamples = probe.samples.filter((sample) => sample.moving);
          const acrylicOpacities = [...probe.acrylicSamples];
          const acrylicSteps = acrylicOpacities.slice(1).map((value, index) => value - acrylicOpacities[index]);
          const acrylicIntermediate = acrylicOpacities.filter((opacity) => opacity > .01 && opacity < .99);
          const result = {
            label: probeLabel,
            hadVeil: probe.samples.some((sample) => sample.veil),
            sawRoomReveal: probe.samples.some((sample) => sample.roomRevealing && Number.isFinite(sample.roomOpacity)),
            roomRevealAtomic: (() => {
              const revealing = probe.samples.filter((sample) =>
                sample.roomRevealing && Number.isFinite(sample.roomOpacity));
              return revealing.length > 0 && revealing.every((sample) => sample.roomTransitionDuration === 0);
            })(),
            ownershipFadeTimed: probe.samples.some((sample) => sample.ownershipFading
              && sample.ownershipFadeDuration >= 60 && sample.ownershipFadeDuration <= 68),
            ownershipFadeAfterAcrylicWarm: (() => {
              const fading = probe.samples.filter((sample) => sample.ownershipFading);
              return fading.length > 0 && fading.every((sample) =>
                sample.sourceRetired && sample.destinationAcrylicStable
                && sample.destinationAcrylicOwners > 0);
            })(),
            sawHomeHandoff: probe.samples.some((sample) => sample.homeHandoff),
            sawHomeCrossfade: probe.samples.some((sample) => sample.homeReleasing),
            snapshotVisible: probe.samples.some((sample) => sample.snapshotDisplay !== 'none' && sample.snapshotOpacity > .01),
            destinationPrecomposed: probe.samples.some((sample) => sample.materializing && !sample.roomRevealing && sample.roomObjects > 0 && sample.roomOpacity <= .01),
            destinationDeferredThroughMotion: !probe.samples.some((sample) => sample.moving && sample.materializing),
            motionFrames:movingSamples.length,
            bitmapMotionEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.bitmapMotion),
            cutoutVisibleEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.motionCutoutOwned && sample.activeCutoutVisible),
            liveOwnersHiddenEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.liveOwnersHidden),
            rootTransformReadyEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.rootTransformReady),
            materialMovingEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.materialMoving),
            peripheralAcrylicEveryFrame:movingSamples.length > 0 && movingSamples.every((sample) => sample.peripheralAcrylicOwned),
            homePrecomposed:movingSamples.length > 0 && movingSamples.every((sample) => sample.motionCutoutOwned),
            endpointFrames: endpoint.length,
            endpointSignatures: new Set(endpoint.map((sample) => motionDirection === 'in' ? sample.roomSignature : sample.homeSignature)).size,
            endpointShadowsReady: motionDirection === 'in' || endpoint.every((sample) => sample.homeShadow && sample.homeShadow !== 'none'),
            endpointShadowSignatures: motionDirection === 'in' ? 0 : new Set(endpoint.map((sample) => sample.homeShadow)).size,
            endpointHomeMaterialsReady: motionDirection === 'in' || endpoint.every((sample) => sample.homeMaterialsReady),
            endpointOwnersContinuous: motionDirection === 'in' || endpoint.every((sample) => sample.homeOwnersContinuous),
            endpointPeripheralAcrylicReady: motionDirection === 'in' || endpoint.every((sample) => sample.homePeripheralReady),
            acrylicFrames: acrylicOpacities.length,
            acrylicFirst: acrylicOpacities[0] ?? null,
            acrylicLast: acrylicOpacities.at(-1) ?? null,
            acrylicMaxStep: acrylicSteps.length ? Math.max(...acrylicSteps.map(Math.abs)) : 0,
            acrylicIntermediateFrames:acrylicIntermediate.length,
            acrylicDistinctIntermediateOpacities:new Set(acrylicIntermediate.map((opacity) => opacity.toFixed(4))).size,
            acrylicNonIncreasing: acrylicSteps.every((step) => step <= .04),
            acrylicNonDecreasing: acrylicSteps.every((step) => step >= -.04),
            acrylicKeyframes,
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
    const layoutSignatures = [];
    const previewSignatures = [];
    const changedFrames = [];
    const previewChangedFrames = [];
    const layoutChanges = [];
    const nodeSelector = [
      '.crm-overview-project', '.crm-overview-ticket', '.crm-overview-update', '.crm-planner-bucket', '.crm-planner-card',
      '.tk-zone', '.tk-card', '.tk-zcard', '.tk-deck', '.crm-home-grid', '.crm-home-bucket',
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
            || node.getAttribute('data-module') || node.getAttribute('data-stage')
            || `${node.tagName.toLowerCase()}.${node.classList.item(0) || ''}`,
          rect.x.toFixed(2), rect.y.toFixed(2), rect.width.toFixed(2), rect.height.toFixed(2),
          style.transform, style.opacity,
        ];
      });
      const layoutState = {
        module: document.body.dataset.crmModule || '',
        nodes: nodes.length,
        scroll: root ? [root.scrollWidth, root.scrollHeight, root.scrollTop, root.scrollLeft] : [],
        geometry,
      };
      const previewState = window.crmHome?.previewStatus?.().map(({ key, capturedAt }) => [key, capturedAt]) || [];
      const layoutSignature = JSON.stringify(layoutState);
      const previewSignature = JSON.stringify(previewState);
      const index = layoutSignatures.length;
      if (index && layoutSignature !== layoutSignatures[index - 1]) {
        changedFrames.push(index);
        const previous = JSON.parse(layoutSignatures[index - 1]);
        const changedNodes = layoutState.geometry.reduce((changes, row, rowIndex) => {
          if (JSON.stringify(row) !== JSON.stringify(previous.geometry[rowIndex])) {
            changes.push({ before: previous.geometry[rowIndex] || null, after: row });
          }
          return changes;
        }, []).slice(0, 8);
        layoutChanges.push({
          frame:index,
          module:[previous.module, layoutState.module],
          scroll:[previous.scroll, layoutState.scroll],
          nodes:[previous.nodes, layoutState.nodes],
          changedNodes,
        });
      }
      if (index && previewSignature !== previewSignatures[index - 1]) previewChangedFrames.push(index);
      layoutSignatures.push(layoutSignature);
      previewSignatures.push(previewSignature);
      if (layoutSignatures.length >= frameCount) {
        resolve({
          frames: layoutSignatures.length,
          uniqueSignatures: new Set(layoutSignatures).size,
          changedFrames,
          layoutChanges,
          previewUniqueSignatures: new Set(previewSignatures).size,
          previewChangedFrames,
        });
      } else requestAnimationFrame(capture);
    };
    // Discard two boundary frames after the coordinator reports done. The
    // following twelve frames must be bit-for-bit identical in geometry.
    requestAnimationFrame(() => requestAnimationFrame(capture));
  }), { selector: rootSelector, frameCount: frames });
}

function assertMotion(label, probe, { allowColdAcrylic = false } = {}) {
  const calibratedHz = nativeRefreshCalibration?.nativeHz || 0;
  const common = !!probe && probe.sawMotion && !probe.timedOut && probe.frames >= 30
    && calibratedHz === MOTION_TARGET.nativeHz && probe.nativeHz === calibratedHz
    && probe.longTasks?.length <= MOTION_TARGET.maxLongTasks;
  const strict = common && Math.round(probe.fps) === calibratedHz
    && probe.maxMs <= MOTION_TARGET.maxFrameMs
    && probe.over15Ms <= MOTION_TARGET.maxOver15Ms;
  // Chromium can spend one or two native refresh intervals allocating the
  // first full-screen 26 px backdrop surface in an otherwise idle renderer.
  // Keep that exception limited to the first inbound acrylic sample; every
  // later direction and room remains on the strict no-drop contract.
  const boundedColdAcrylic = allowColdAcrylic && common
    && Math.round(probe.fps) >= 92
    && probe.p95Ms <= 12.5
    && probe.maxMs <= 31
    && probe.over15Ms <= 2;
  if (!strict && !boundedColdAcrylic) {
    throw new Error(`${label} missed native motion budget ${JSON.stringify({
      target:MOTION_TARGET,
      calibration:nativeRefreshCalibration,
      probe,
    })}`);
  }
  return { strict, boundedColdAcrylic };
}

function keyframesMatch(actual, expected, tolerance = .002) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((frame, index) => Array.isArray(frame) && frame.length === 2
      && Math.abs(Number(frame[0]) - expected[index][0]) <= tolerance
      && Math.abs(Number(frame[1]) - expected[index][1]) <= tolerance);
}

function assertHomeFade(label, probe, direction) {
  const expected = [[0, 1], [1, 1]];
  const endpointsValid = probe?.acrylicFirst >= .99 && probe?.acrylicLast >= .99
    && probe?.acrylicMaxStep <= .02;
  if (!probe || probe.motionFrames < 30 || !probe.bitmapMotionEveryFrame
    || !probe.cutoutVisibleEveryFrame || !probe.liveOwnersHiddenEveryFrame
    || !probe.rootTransformReadyEveryFrame || !probe.materialMovingEveryFrame
    || probe.acrylicFrames < 30 || probe.acrylicIntermediateFrames !== 0
    || !keyframesMatch(probe.acrylicKeyframes, expected)
    || !endpointsValid) {
    throw new Error(`${label} did not retain full acrylic through every transform frame: ${JSON.stringify({ expected, direction, probe })}`);
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

function imageEdgeEnergy(buffer, region) {
  const image = PNG.sync.read(buffer);
  const luminance = (x, y) => {
    const index = (y * image.width + x) * 4;
    return image.data[index] * .2126 + image.data[index + 1] * .7152 + image.data[index + 2] * .0722;
  };
  let sum = 0, count = 0;
  const right = Math.min(image.width - 1, region.right);
  const bottom = Math.min(image.height - 1, region.bottom);
  for (let y = Math.max(0, region.top); y < bottom; y += 2) for (let x = Math.max(0, region.left); x < right; x += 2) {
    const value = luminance(x, y);
    sum += Math.abs(value - luminance(x + 1, y)) + Math.abs(value - luminance(x, y + 1));
    count += 2;
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
  const app = await electron.launch({
    args: ['.'],
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      CRM_API_URL: apiUrl,
      CRM_API_PORT: String(process.env.CRM_API_PORT || new URL(apiUrl).port || '3899'),
      CRM_CDMS_DISABLED: process.env.CRM_CDMS_DISABLED || '1',
    },
    timeout: 30000,
  });
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
  // Calibration must measure the settled application, not the deliberate
  // one-time factory precomposition that begins 250ms after Home activates.
  // Finish that work and the preview queues first. Windows can occasionally
  // delay one renderer callback even at an otherwise exact 100 Hz idle VSync;
  // take independent full-length samples and accept only an entirely clean one.
  await page.waitForFunction(() => {
    const state = window.crmHome?.prewarmStatus?.();
    return !!state && !state.running && state.pending.length === 0;
  }, null, { timeout:60000 });
  await page.evaluate(() => window.crmHome?.waitForPreviewSync?.());
  await sleep(150);
  const calibrationAttempts=[];
  for(let attempt=0;attempt<3;attempt+=1){
    const sample=await calibrateNativeRefresh(page);
    calibrationAttempts.push(sample);
    const clean=sample.nativeHz===MOTION_TARGET.nativeHz
      &&Math.round(sample.fps)===MOTION_TARGET.nativeHz
      &&sample.maxMs<=MOTION_TARGET.maxFrameMs
      &&sample.over15Ms<=MOTION_TARGET.maxOver15Ms;
    if(clean){nativeRefreshCalibration={...sample,attempts:calibrationAttempts};break}
    await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
  }
  if (!nativeRefreshCalibration) {
    throw new Error(`Native display calibration did not produce a clean ${MOTION_TARGET.nativeHz} Hz baseline: ${JSON.stringify(calibrationAttempts)}`);
  }

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
  if (startup.buckets.length !== 4 || startup.buckets.some((item) => item.version !== HOME_PREVIEW_VERSION || item.images !== 1 || item.tag !== 'IMG' || item.width < 880 || item.height < 600 || item.aspectError > .01 || item.shift || item.liveTrees)) {
    throw new Error(`Home is not four inert native captures: ${JSON.stringify(startup)}`);
  }
  if (startup.buckets.some((item) => item.variant !== 'filtered' || !item.previewFilter.includes(HOME_PREVIEW_REST_FILTER)
    || !item.loader.exists || item.loader.role !== 'status' || !item.loader.hiddenAtReady
    || item.titleOpacity < .9 || item.titleSize !== '16px' || item.titleWeight !== '650'
    || !item.titleFamily.includes('Segoe UI Variable Text') || item.titleShadow.includes('12px') || !item.titleOutsideFilteredTile)) {
    throw new Error(`Home tiles do not rest with filtered previews and emphasized titles: ${JSON.stringify(startup.buckets)}`);
  }
  if (startup.homeLayers.levels !== 1 || startup.homeLayers.hands !== 1
    || startup.homeLayers.cards !== startup.homeLayers.uniqueCards || startup.homeLayers.titleLayers !== 1 || startup.homeLayers.titles !== 4
     || !startup.homeLayers.rootWillChange.includes('transform') || startup.homeLayers.snapshots !== 1 || startup.homeLayers.motionVariants !== 4 || startup.homeLayers.snapshotDisplay !== 'none'
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
    let dragEnd=dragStart;
    for(let attempt=0;attempt<2;attempt+=1){
      await app.evaluate(({ BrowserWindow })=>{const win=BrowserWindow.getAllWindows().find((item)=>item.isVisible());win?.show();win?.focus();});
      await page.bringToFront();await sleep(160);
      const hit=await page.evaluate(()=>{const node=document.elementsFromPoint(520,20)[0];return{drag:getComputedStyle(node).webkitAppRegion,classes:node.className||node.tagName}});
      if(hit.drag!=='drag')throw new Error(`Native drag point lost its title-bar region: ${JSON.stringify(hit)}`);
      await page.mouse.move(520,20);await page.mouse.down();await page.mouse.move(640,90,{steps:12});await page.mouse.up();await sleep(220);
      dragEnd=await app.evaluate(({ BrowserWindow })=>BrowserWindow.getAllWindows().find((win)=>win.isVisible())?.getPosition());
      if(Math.abs(dragEnd[0]-dragStart[0])>=60&&Math.abs(dragEnd[1]-dragStart[1])>=30)break;
    }
    nativeDrag = { dx:dragEnd[0]-dragStart[0], dy:dragEnd[1]-dragStart[1] };
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
  if (motionSnapshotResult?.snapshot?.version !== HOME_PREVIEW_VERSION || motionSnapshotResult?.snapshot?.backgroundMode !== 'shared' || motionSnapshotResult?.snapshot?.materialMode !== 'live-peripheral-acrylic' || motionVariants.length !== 4 || motionVariantCutouts.some((item)=>item.maxAlpha>2) || homeMotionAlpha.transparentRatio < .2 || homeMotionAlpha.partialRatio < .02) {
    throw new Error(`Home transition texture is not the current cached cutout architecture: ${JSON.stringify({ snapshot:motionSnapshotResult?.snapshot && { version:motionSnapshotResult.snapshot.version, backgroundMode:motionSnapshotResult.snapshot.backgroundMode, materialMode:motionSnapshotResult.snapshot.materialMode, foregroundBounds:motionSnapshotResult.snapshot.foregroundBounds }, alpha:homeMotionAlpha })}`);
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

  let reloadLeaseRecovery=null;
  for (let index=0; index<2; index+=1) {
    if(index===0){
      await page.evaluate(()=>{
        window.crmHomePreviews.setInteraction(true,'native-reload-lease-probe');
        window.__nativeReloadCapture=window.crmHomePreviews.capture('people').catch(()=>null);
      });
      await sleep(40);
    }
    await page.reload({ waitUntil:'load' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction(readyHome, null, { timeout:30000 });
    const chrome = await page.evaluate(() => { const drag=document.querySelector('.app-window-drag-region'); return { drag:getComputedStyle(drag).webkitAppRegion, top:document.elementsFromPoint(520,20)[0]===drag, controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length }; });
    if (chrome.drag !== 'drag' || !chrome.top || chrome.controls < 3) throw new Error(`Chrome stale after reload ${index+1}: ${JSON.stringify(chrome)}`);
    if(index===0){
      const started=Date.now();
      const idle=await Promise.race([
        page.evaluate(()=>window.crmHomePreviews.waitForIdle()),
        // Releasing the document lease unblocks the already-requested capture,
        // but that native-image capture still has to finish before the engine
        // can report globally idle. Keep this outer guard just beyond the
        // main-process handler's own bounded 30 second deadline.
        sleep(32000).then(()=>({ok:false,error:'reload lease recovery timed out'})),
      ]);
      reloadLeaseRecovery={...idle,elapsedMs:Date.now()-started};
      if(!idle?.ok)throw new Error(`Reload did not release the old preview interaction lease: ${JSON.stringify(reloadLeaseRecovery)}`);
    }
  }

  const allRooms = [
    {key:'people',theater:'people',content:'.tk-zone',expected:17}, {key:'cases',theater:'tickets',content:'.tk-zone',expected:3},
    {key:'planner',theater:'planner',content:'.crm-planner-bucket',expected:0}, {key:'assignments',theater:'assignments',content:'.tk-zone[data-stage]',expected:5},
  ];
  const requestedRoomKeys = new Set(String(process.env.CRM_VISUAL_ROOMS || '').split(',').map((key)=>key.trim()).filter(Boolean));
  const knownRoomKeys = new Set(allRooms.map((room)=>room.key));
  const unknownRoomKeys = [...requestedRoomKeys].filter((key)=>!knownRoomKeys.has(key));
  if(unknownRoomKeys.length)throw new Error(`CRM_VISUAL_ROOMS contains unknown rooms: ${unknownRoomKeys.join(',')}`);
  const rooms = requestedRoomKeys.size ? allRooms.filter((room)=>requestedRoomKeys.has(room.key)) : allRooms;
  if(!rooms.length)throw new Error(`CRM_VISUAL_ROOMS selected no known rooms: ${[...requestedRoomKeys].join(',')}`);
  const transitions=[];
  for (const room of rooms) {
    let inboundHeldState=null;
    const before = await page.evaluate((key)=>window.crmHome.previewStatus().find((item)=>item.key===key)?.capturedAt||0,room.key);
    const previewNodeToken = await page.evaluate((key) => {
      const image = document.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview-foreground`);
      const token = `${key}-${Date.now()}-${Math.random()}`;
      if (image) image.dataset.liveSyncProbe = token;
      return token;
    }, room.key);
    const selector=`.crm-home-grid > .crm-home-bucket[data-module="${room.key}"]`;
    await page.hover(selector); await sleep(160);
    const homeSourceMaterial=await page.$eval(selector,(bucket)=>{
      const style=getComputedStyle(bucket);
      return{
        backgroundColor:style.backgroundColor,
        backgroundImage:style.backgroundImage,
        backdropFilter:style.webkitBackdropFilter||style.backdropFilter,
        borderColor:style.borderColor,
        borderStyle:style.borderStyle,
        boxShadow:style.boxShadow,
      };
    });
    await page.evaluate(() => { const p=window.__fps={start:performance.now(),frames:0,fps:0}; const tick=(now)=>{p.frames+=1;if(now-p.start<1100)requestAnimationFrame(tick);else p.fps=p.frames*1000/(now-p.start)};requestAnimationFrame(tick); });
    await startEndpointProbe(page, `in-${room.key}`, room, 'in');
    const inboundReaction=await page.$eval(selector,(bucket)=>{
      const source=bucket.getBoundingClientRect();
      const started=performance.now();
      bucket.click();
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      return{
        elapsedMs:performance.now()-started,
        busy:window.crmDeskTransit?.isBusy?.(),
        transitioning:window.crmHomeCamera?.isTransitioning?.(),
        sourceWidth:source.width,
        sourceHeight:source.height,
        initialTransform:expander?.style.transform||'',
        initialFrame:expander?.dataset.fractalFrame||'',
      };
    });
    if(!inboundReaction.busy||!inboundReaction.transitioning||inboundReaction.elapsedMs>50||!inboundReaction.initialTransform.includes('scale(')||inboundReaction.initialFrame!=='source')throw new Error(`${room.key} click did not begin its tile camera move immediately: ${JSON.stringify(inboundReaction)}`);
    await sleep(100);
    const mid=await page.evaluate(()=>{
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      const rect=expander?.getBoundingClientRect();
      const root=window.crmHomeCamera?.layers?.()[0];
      const surface=window.crmHomeCamera?.surface?.();
      const drag=document.querySelector('.app-window-drag-region');
      const grid=root?.querySelector(':scope>.crm-home-grid');
      const titleLayer=root?.querySelector(':scope>.crm-home-title-layer');
      const hand=root?.querySelector(':scope>.crm-home-priority-hand');
      const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');
      const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');
      const status=window.crmHome?.motionStatus?.();
      const expanderStyle=expander&&getComputedStyle(expander);
      const target=root?.querySelector('.crm-home-bucket.is-camera-target');
      const foreground=expander?.querySelector('.crm-home-preview-foreground');
      const exact=expander?.querySelector('.crm-home-preview-exact');
      const exactHidden=!exact||getComputedStyle(exact).display==='none'||getComputedStyle(exact).visibility==='hidden'||Number(getComputedStyle(exact).opacity)<=.001;
      const liveOwnersHidden=[grid,titleLayer,hand].every((node)=>node&&getComputedStyle(node).visibility==='hidden');
      const motionCutoutOwns=!!snapshot&&getComputedStyle(snapshot).display==='none'
        &&!!variant&&variant.dataset.motionVariant===target?.dataset.module
        &&getComputedStyle(variant).display!=='none'&&Number(getComputedStyle(variant).opacity)>.99;
      const expanderNeutral=!!expanderStyle
        &&expanderStyle.backgroundColor==='rgba(0, 0, 0, 0)'
        &&expanderStyle.backgroundImage==='none'
        &&expanderStyle.boxShadow==='none'
        &&(expanderStyle.webkitBackdropFilter||expanderStyle.backdropFilter)==='none';
      return{
        module:document.body.dataset.crmModule,
        transitioning:window.crmHomeCamera?.isTransitioning?.(),
        images:expander?.querySelectorAll('img').length||0,
        rect:rect?{width:rect.width,height:rect.height}:null,
        rootOpacity:root?Number(getComputedStyle(root).opacity):0,
        liveOwnersHidden,
        motionCutoutOwns,
         signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),
         bitmapMotion:surface?.classList.contains('crm-home-bitmap-motion'),
         motionSnapshotReady:root?.dataset?.motionSnapshotReady||'',
         motionVariantKey:root?.dataset?.motionVariant||'',
         targetModule:target?.dataset?.module||'',
         targetTileId:target?.dataset?.tileId||'',
         variantState:variant?{
           module:variant.dataset.motionVariant||'',
           tileId:variant.dataset.motionTileId||'',
           complete:variant.complete,
           naturalWidth:variant.naturalWidth,
           display:getComputedStyle(variant).display,
           opacity:Number(getComputedStyle(variant).opacity),
         }:null,
        rootComposited:root?getComputedStyle(root).willChange.includes('transform'):false,
        noEndpointImage:exactHidden,
        sharedBackground:status?.backgroundMode==='shared'
          &&status?.materialMode==='live-peripheral-acrylic'
          &&document.querySelectorAll('.crm-home-scene-backdrop').length===0
          &&document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1
          &&!!foreground&&exactHidden&&expanderNeutral,
        surfaceMoving:surface?.classList.contains('crm-home-camera-moving'),
        dragTop:document.elementsFromPoint(520,20)[0]===drag,
        controlsTop:[...document.querySelectorAll('.window-control-cluster .window-glass-control')].every((node)=>{
          const bounds=node.getBoundingClientRect();
          const hit=document.elementsFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2)[0];
          return hit===node||node.contains(hit);
        }),
      };
    });
    const acrylicMid=await page.evaluate((expected)=>{
      const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      const edge=expander?.querySelector(':scope>.crm-home-transition-acrylic');
      const plane=surface?.querySelector('.crm-home-screen-acrylic');
      const clipHost=plane?.parentElement?.classList.contains('crm-home-screen-acrylic-clip')?plane.parentElement:plane;
      const peripheralPlane=surface?.querySelector('.crm-home-peripheral-screen-acrylic');
      const peripheralHost=peripheralPlane?.parentElement;
      const exact=expander?.querySelector('.crm-home-preview-exact');
      const exactHidden=!exact||getComputedStyle(exact).display==='none'||getComputedStyle(exact).visibility==='hidden'||Number(getComputedStyle(exact).opacity)<=.001;
      const target=root?.querySelector('.crm-home-bucket.is-camera-target');
      const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');
      const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');
      const material=(node,clipped=false)=>{
        if(!node)return null;
        const style=getComputedStyle(node),rect=node.getBoundingClientRect();
        let bounds=[rect.x,rect.y,rect.width,rect.height];
        if(clipped){
          const match=style.clipPath.match(/^inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/);
          if(match){
            const top=Number(match[1]),right=Number(match[2]),bottom=Number(match[3]),left=Number(match[4]);
            bounds=[rect.x+left,rect.y+top,rect.width-left-right,rect.height-top-bottom];
          }
        }
        const matrix=style.transform&&style.transform!=='none'?new DOMMatrix(style.transform):new DOMMatrix();
        return{
          opacity:Number(style.opacity),
          backgroundColor:style.backgroundColor,
          backgroundImage:style.backgroundImage,
          backdrop:style.webkitBackdropFilter||style.backdropFilter,
          borderColor:style.borderColor,
          borderStyle:style.borderStyle,
          shadow:style.boxShadow,
          clip:style.clipPath,
          scale:[matrix.a,matrix.d],
          rect:bounds,
        };
      };
      const lid=material(expander),lens=material(plane),lensHost=material(clipHost,true),frame=material(edge);
      const peripheralLens=material(peripheralPlane),peripheralClip=material(peripheralHost);
      const animationFor=(node,property)=>{
        const matches=[...(node?.getAnimations?.()||[])].filter((animation)=>{
          const duration=Number(animation.effect?.getComputedTiming?.().duration);
          const keyframes=animation.effect?.getKeyframes?.()||[];
          return animation.effect?.target===node
            &&animation.playState!=='idle'&&animation.playState!=='paused'
            &&animation.replaceState!=='removed'
            &&Number.isFinite(duration)&&Math.abs(duration-460)<=1
            &&keyframes.some((keyframe)=>keyframe[property]!=null);
        });
        return matches.at(-1)||null;
      };
      const transformAnimation=animationFor(expander,'transform');
      const clipAnimation=animationFor(clipHost,'clipPath');
      const opacityAnimation=animationFor(plane,'opacity');
      const peripheralClipAnimation=animationFor(peripheralHost,'clipPath');
      const animations=[transformAnimation,clipAnimation,opacityAnimation];
      const animationTimes=animations.map((animation)=>animation?.currentTime==null?NaN:Number(animation.currentTime));
      const animationStarts=animations.map((animation)=>animation?.startTime==null?NaN:Number(animation.startTime));
      const aligned=(values)=>values.every(Number.isFinite)&&values.slice(1).every((value)=>Math.abs(value-values[0])<=1.5);
      const cutoutOwned=!!variant&&getComputedStyle(variant).display!=='none'
        &&Number(getComputedStyle(variant).opacity)>.99
        &&variant.dataset.motionVariant===target?.dataset.module
        &&getComputedStyle(snapshot).display==='none';
      const tintCopied=!!lens
        &&lens.backgroundColor===expected.backgroundColor
        &&lens.backgroundImage===expected.backgroundImage
        &&lens.backdrop===expected.backdropFilter;
      const frameCopied=!!frame
        &&frame.borderColor===expected.borderColor
        &&frame.borderStyle===expected.borderStyle
        &&frame.shadow===expected.boxShadow;
      const peripheralState=window.crmHome?.peripheralAcrylicState?.();
      const peripheralTimes=[transformAnimation,peripheralClipAnimation].map((animation)=>animation?.currentTime==null?NaN:Number(animation.currentTime));
      const peripheralStarts=[transformAnimation,peripheralClipAnimation].map((animation)=>animation?.startTime==null?NaN:Number(animation.startTime));
      return{
        frame:expander?.dataset.fractalFrame||'',
        lid,lens,lensHost,edge:frame,exact:material(exact),peripheralLens,peripheralClip,peripheralState,
        lensAligned:!!lensHost&&!!lid&&lensHost.rect.every((value,index)=>Math.abs(value-lid.rect[index])<=1.25),
        timelineAligned:animations.every(Boolean)&&aligned(animationTimes)&&aligned(animationStarts),
        animationTimes,
        animationStarts,
        animationStates:animations.map((animation)=>animation?.playState||'missing'),
        cutoutOwned,
        sharedWallpaper:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&exactHidden&&!!expander?.querySelector('.crm-home-preview-foreground'),
        tintCopied,
        frameCopied,
        peripheralTimelineAligned:!!peripheralClipAnimation&&aligned(peripheralTimes)&&aligned(peripheralStarts),
        peripheralAcrylic:!!peripheralLens&&!!peripheralClip
          &&peripheralHost?.parentElement===surface
          &&surface?.classList.contains('crm-home-peripheral-acrylic-active')
          &&peripheralState?.active&&peripheralState.phase==='motion'&&peripheralState.direction==='expand'&&peripheralState.neighborCount===3
          &&peripheralLens.opacity>.99
          &&peripheralLens.backgroundColor==='rgba(0, 0, 0, 0)'
          &&peripheralLens.backgroundImage==='none'
          &&peripheralLens.scale.every((value)=>Math.abs(value-1)<.001)
          &&peripheralLens.backdrop.includes('blur(26px)')
          &&peripheralLens.backdrop.includes('saturate(1.4)')
          &&peripheralClip.clip.startsWith('path('),
        cachedLens:!!lens&&!!lensHost&&clipHost?.parentElement===surface
          &&lens.scale.every((value)=>Math.abs(value-1)<.001)
          &&lensHost.scale.every((value)=>Math.abs(value-1)<.001)
          &&lens.backdrop.includes('blur(26px)')
          &&lens.backdrop.includes('saturate(1.4)')
          &&lensHost.clip.startsWith('inset(')
          &&frame?.backdrop==='none'
          &&frame?.backgroundColor==='rgba(0, 0, 0, 0)'
          &&frame?.backgroundImage==='none',
        surfaceMoving:surface?.classList.contains('crm-home-camera-moving'),
      };
    },homeSourceMaterial);
    const inFlight=mid.module==='home'&&mid.transitioning&&mid.images>=1&&mid.images<=2&&mid.noEndpointImage&&mid.rect&&mid.rect.width>inboundReaction.sourceWidth+20;
    const alreadyLanded=mid.module===room.key&&!mid.transitioning;
    if((!inFlight&&!alreadyLanded)||(inFlight&&(mid.rootOpacity<.99||!mid.liveOwnersHidden||!mid.motionCutoutOwns||!mid.signatureMatches||!mid.rootComposited||!mid.sharedBackground||!mid.surfaceMoving||!acrylicMid.cutoutOwned||!acrylicMid.sharedWallpaper||!acrylicMid.cachedLens||!acrylicMid.tintCopied||!acrylicMid.frameCopied||!acrylicMid.lensAligned||!acrylicMid.timelineAligned||!acrylicMid.peripheralAcrylic||!acrylicMid.peripheralTimelineAligned||!acrylicMid.surfaceMoving))||(!nativeDrag.syntheticMissAllowed&&!mid.dragTop)||!mid.controlsTop)throw new Error(`${room.key} camera mid-state broken: ${JSON.stringify({mid,acrylicMid,homeSourceMaterial})}`);
    await page.waitForFunction((key)=>document.body.dataset.crmModule===key&&!window.crmDeskTransit?.isBusy?.()&&!document.querySelector('.crm-transit-veil'),room.key,{timeout:15000});
    const inboundEndpoint=await finishEndpointProbe(page,`in-${room.key}`);
    assertHomeFade(`${room.key} inbound visual`,inboundEndpoint,'in');
    if(inboundEndpoint.hadVeil||!inboundEndpoint.destinationDeferredThroughMotion||!inboundEndpoint.destinationPrecomposed||!inboundEndpoint.sawRoomReveal||!inboundEndpoint.roomRevealAtomic||!inboundEndpoint.ownershipFadeTimed||!inboundEndpoint.ownershipFadeAfterAcrylicWarm||!inboundEndpoint.peripheralAcrylicEveryFrame||inboundEndpoint.endpointFrames<1||inboundEndpoint.endpointSignatures!==1||inboundEndpoint.snapshotVisible||inboundEndpoint.final.materializing||inboundEndpoint.final.veil)throw new Error(`${room.key} inbound did not hand to its endpoint-precomposed live room: ${JSON.stringify({inboundEndpoint,inboundReaction})}`);
    const inactiveHomeRetention=await page.evaluate((key)=>{const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');const surfaceStyle=surface&&getComputedStyle(surface);const variantStyle=variant&&getComputedStyle(variant);return{hidden:surface?.hidden===true,key:surface?.dataset.crmHomeRetained||'',display:surfaceStyle?.display||'',zIndex:surfaceStyle?.zIndex||'',pointerEvents:surfaceStyle?.pointerEvents||'',gridVisibility:getComputedStyle(root?.querySelector(':scope>.crm-home-grid')).visibility,variant:variant?.dataset.motionVariant||'',variantDisplay:variantStyle?.display||'',variantOpacity:Number(variantStyle?.opacity),variantTransform:variantStyle?.transform||'',variantWillChange:variantStyle?.willChange||'',expected:key}},room.key);
    if(!inactiveHomeRetention.hidden||inactiveHomeRetention.key!==room.key||inactiveHomeRetention.display!=='block'||inactiveHomeRetention.zIndex!=='0'||inactiveHomeRetention.pointerEvents!=='none'||inactiveHomeRetention.gridVisibility!=='hidden'||inactiveHomeRetention.variant!==room.key||inactiveHomeRetention.variantDisplay==='none'||inactiveHomeRetention.variantOpacity!==.001||inactiveHomeRetention.variantTransform==='none'||!inactiveHomeRetention.variantWillChange.includes('transform'))throw new Error(`${room.key} did not leave exactly one inert Home camera bitmap resident: ${JSON.stringify(inactiveHomeRetention)}`);
    await page.mouse.move(1,1); await sleep(80);
    let companyRailMotion=null;
    if(room.key==='people'){
      // Measure the promoted rail before screenshot readback, multi-megabyte
      // preview IPC cloning, or pixel comparison can leave delayed GC/GPU work
      // in the renderer. Semantic idle covers both renderer maintenance and
      // the hidden capture worker; the rail itself holds that lease in motion.
      // Home is intentionally frozen while a room is active: new compositions
      // remain queued until the return handoff. Only the offscreen worker must
      // reach idle here; asking Home to flush would invalidate that invariant.
      await page.evaluate(()=>window.crmHomePreviews.waitForIdle());
      await page.evaluate(()=>window.peopleCards.scrollZonesBy(-9999,true));
      await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
      companyRailMotion=await page.evaluate(()=>new Promise((resolve)=>{document.activeElement?.blur?.();const theater=document.querySelector('[data-crm-theater="people"]:not([hidden])');const mutations=[];const observer=new MutationObserver((records)=>mutations.push(...records));observer.observe(theater,{subtree:true,childList:true,attributes:true,attributeFilter:['data-zone-lod','data-face-deferred','class']});const deltas=[];const over15At=[];const longTasks=[];let previous=performance.now(),started=previous;const longObserver=new PerformanceObserver((list)=>list.getEntries().forEach((entry)=>longTasks.push(entry.duration)));try{longObserver.observe({entryTypes:['longtask']})}catch{}window.peopleCards.scrollZonesBy(9999);const tick=(now)=>{const delta=now-previous;deltas.push(delta);previous=now;if(delta>15){const state=window.peopleCards.zoneScrollState?.()||{};over15At.push({index:deltas.length-1,delta,x:state.x,target:state.target});}if(now-started<900){requestAnimationFrame(tick);return;}observer.disconnect();longObserver.disconnect();const sorted=[...deltas].sort((a,b)=>a-b);const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]||0;const parked=[...theater.querySelectorAll('.tk-zone[data-zone-lod="parked"]')],buckets=[...theater.querySelectorAll('.tk-zone')],nonEmpty=buckets.filter((bucket)=>bucket.querySelector('.tk-zcard')),readyTops=nonEmpty.filter((bucket)=>{const card=bucket.querySelector('.tk-zcard:last-child');return card&&!card.classList.contains('is-lazy-shell')&&!!card.querySelector('.ticket-fields');}),clip=theater.querySelector('.tk-zone-hclip'),track=theater.querySelector('.tk-zone-htrack'),lens=track?.querySelector(':scope > .tk-zone-hacrylic-lens'),clipRect=clip?.getBoundingClientRect(),lensStyle=lens&&getComputedStyle(lens);const lodMutations=mutations.filter((record)=>record.type==='attributes'&&record.attributeName==='data-zone-lod').length;const faceMutations=mutations.filter((record)=>record.type==='childList'||(record.type==='attributes'&&record.target.closest?.('.tk-zcard'))).length;resolve({frames:deltas.length,fps:deltas.length*1000/(now-started),p95,max:Math.max(...deltas),over15:deltas.filter((value)=>value>15).length,over15At,longTasks,lodMutations,faceMutations,parked:parked.length,nonEmpty:nonEmpty.length,readyTops:readyTops.length,totalCards:theater.querySelectorAll('.tk-zcard').length,deferred:theater.querySelectorAll('.tk-zcard.is-lazy-shell').length,sharedLens:track.classList.contains('has-shared-zone-acrylic')&&lensStyle?.backdropFilter.includes('blur')&&lensStyle.clipPath!=='none'&&buckets.every((bucket)=>getComputedStyle(bucket).backdropFilter==='none'),clipped:getComputedStyle(clip).overflowX==='hidden'&&getComputedStyle(track).willChange.includes('transform')&&parked.every((bucket)=>{const style=getComputedStyle(bucket),rect=bucket.getBoundingClientRect();return style.visibility==='visible'&&style.contentVisibility==='visible'&&!!clipRect&&(rect.right<=clipRect.left||rect.left>=clipRect.right);})});};requestAnimationFrame(tick)}));
      // Permit one isolated scheduler vblank while keeping the 900 ms sample,
      // p95, average cadence, mutation count, and long-task gates strict.
      if(companyRailMotion.frames<85||companyRailMotion.fps<98.5||companyRailMotion.p95>12.5||companyRailMotion.max>21||companyRailMotion.over15>1||companyRailMotion.longTasks.length||companyRailMotion.lodMutations<1||companyRailMotion.lodMutations>28||companyRailMotion.faceMutations!==0||companyRailMotion.parked<6||companyRailMotion.readyTops!==companyRailMotion.nonEmpty||companyRailMotion.deferred!==companyRailMotion.totalCards-companyRailMotion.nonEmpty||!companyRailMotion.sharedLens||!companyRailMotion.clipped)throw new Error(`People horizontal LOD is not compositor-stable at native ${MOTION_TARGET.nativeHz} Hz: ${JSON.stringify(companyRailMotion)}`);
      await page.evaluate(()=>window.peopleCards.scrollZonesBy(-9999,true));
      await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    }
    const inboundStability=await sampleLayoutStability(page,`[data-crm-theater="${room.theater}"]:not([hidden])`);
    if(inboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after inbound transition: ${JSON.stringify(inboundStability)}`);
    const state=await page.evaluate(async(config)=>{
      const theater=document.querySelector(`[data-crm-theater="${config.theater}"]`);
      const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===config.key);
      const signatureSelector='.tk-zone[data-stage],.tk-card[data-id],.tk-zcard[data-id],.crm-planner-bucket[data-planner-bucket],.crm-planner-card[data-planner-card]';
      const signature={module:document.body.dataset.crmModule||'',objects:[...(theater?.querySelectorAll(signatureSelector)||[])].map((node)=>[node.dataset.id||node.dataset.plannerBucket||node.dataset.plannerCard||node.dataset.stage||'',node.getAttribute('aria-label')||node.querySelector(':scope > .tk-zone-hd .tk-zone-title')?.textContent?.trim()||'',node.classList.contains('crm-object-small')?'small':'large',node.classList.contains('is-stack-expanded')?'expanded':'stacked']),calendarYear:window.fractalCalendar?.year?.()||null};
      const bucketGeometry=[...(theater?.querySelectorAll('.tk-zone')||[])].map((bucket)=>{const rect=bucket.getBoundingClientRect();return{width:rect.width,height:rect.height,ratio:rect.height?rect.width/rect.height:0}}).filter((bucket)=>bucket.width>0&&bucket.height>0);
      const bucketHeaders=[...(theater?.querySelectorAll('.tk-zone')||[])].filter((bucket)=>bucket.getBoundingClientRect().width>0).map((bucket)=>{const title=bucket.querySelector('.tk-zone-title');const bars=bucket.querySelector('.tk-zone-hd-r');const bucketRect=bucket.getBoundingClientRect();const barsRect=bars?.getBoundingClientRect();return{title:title?.textContent.trim()||'',whiteSpace:title?getComputedStyle(title).whiteSpace:'',singleLine:!!title&&title.scrollHeight<=title.clientHeight+1,count:bucket.querySelectorAll('.tk-zone-count').length,barsPosition:bars?getComputedStyle(bars).position:'',barsRight:barsRect?Math.round(bucketRect.right-barsRect.right):null}});
      const assignmentApi=config.key==='assignments'?window.crmAssignments:null;const assignmentContract=assignmentApi?.contract?.()||null;const assignmentZones=[...(theater?.querySelectorAll('.tk-zone[data-stage]')||[])];const assignmentCards=[...(theater?.querySelectorAll('.tk-zcard[data-id]')||[])];const assignmentClip=theater?.querySelector('.tk-zone-hclip');const assignmentTrack=theater?.querySelector('.tk-zone-htrack');const assignmentBar=theater?.querySelector('.tk-zone-hsb');const assignmentThumb=theater?.querySelector('.tk-zone-hth');const assignmentRequiredMethods=['setActive','reload','baseline','contract','homePreviewState','applyHomePreviewState','performanceState','createCard','moveToStage','setStageExpanded','expandedStages','zoneScrollState','scrollZonesBy'];const assignmentMissingMethods=assignmentApi?assignmentRequiredMethods.filter((method)=>typeof assignmentApi[method]!=='function'):[];
      const assignmentStageIdentity=assignmentZones.map((zone)=>({key:zone.dataset.stage||'',label:zone.querySelector(':scope > .tk-zone-hd .tk-zone-title')?.textContent?.trim()||'',sizeKey:zone.dataset.crmSizeKey||''}));const assignmentCardIdentity=assignmentCards.map((card)=>({id:card.dataset.id||'',entity:card.dataset.recordEntity||'',sizeKey:card.dataset.crmSizeKey||'',stage:card.closest('.tk-zone[data-stage]')?.dataset.stage||''}));
      const assignmentStageKeys=new Set(assignmentStageIdentity.map(({key})=>key));const assignmentRecords=assignmentApi?.items?.()||[];const expectedAssignmentStage=(record)=>['completed','complete','resolved','done','closed','archived','cancelled','canceled'].includes(String(record?.status||'').toLowerCase())?'done':assignmentStageKeys.has(String(record?.assignmentStage||'').toLowerCase())?String(record.assignmentStage).toLowerCase():(record?.assignedContactId||String(record?.assignee||'').trim()?'assigned':'unassigned');const assignmentActual=Object.fromEntries(assignmentCardIdentity.map(({id,stage})=>[id,stage]));const assignmentPlacements=assignmentRecords.map((record)=>({id:record.id,expected:expectedAssignmentStage(record),actual:assignmentActual[record.id]||''}));
      const assignmentCanonical=config.key!=='assignments'||(theater?.matches('section.crm-theater[data-crm-theater="assignments"]')&&assignmentZones.length===assignmentContract?.stages?.length&&assignmentCards.length>0&&JSON.stringify(assignmentStageIdentity.map(({key,label})=>({key,label})))===JSON.stringify(assignmentContract.stages)&&assignmentStageIdentity.every(({key,sizeKey})=>sizeKey===`bucket:assignments:${key}`)&&assignmentCardIdentity.every(({id,entity,sizeKey})=>id&&entity==='commitments'&&sizeKey===`card:commitments:${id}`)&&new Set(assignmentCardIdentity.map(({id})=>id)).size===assignmentCardIdentity.length&&assignmentPlacements.every(({expected,actual})=>expected===actual)&&assignmentPlacements.some(({expected})=>expected==='done')&&!theater.querySelector(':scope > .tk-stacks,:scope > .tk-scrim,.tk-deck'));
      const assignmentOverflow=assignmentTrack&&assignmentClip?Math.max(0,assignmentTrack.scrollWidth-assignmentClip.clientWidth):0;const assignmentScrollState=assignmentApi?.zoneScrollState?.()||null;
      return{visible:!!theater&&!theater.hidden,count:theater?.querySelectorAll(config.content).length||0,arrows:theater?.querySelectorAll('svg.tk-flow,.tk-flow-shaft,.tk-flow-head').length||0,unstackControls:theater?.querySelectorAll('.tk-zone-spread,.crm-planner-stack-toggle').length||0,bucketGeometry,bucketHeaders,assignmentCanonical,assignmentContract,assignmentStageIdentity,assignmentCardIdentity,assignmentPlacements,assignmentMissingMethods,assignmentLegacy:document.querySelectorAll('.crm-assignment-bucket,.crm-assignment-work-card').length,assignmentMiniatures:document.querySelectorAll('.crm-factory-mini-scene').length,assignmentOverflow,assignmentScrollState,assignmentScroller:assignmentBar?{on:assignmentBar.classList.contains('is-on'),track:assignmentBar.getBoundingClientRect().width,thumb:assignmentThumb?.getBoundingClientRect().width||0,trackTransform:assignmentTrack?getComputedStyle(assignmentTrack).transform:''}:null,signature,previewSignature:preview?.layoutSignature||null,exactSrc:preview?.exactSrc||'',veil:document.querySelectorAll('.crm-transit-veil').length,invalid:[...(theater?.querySelectorAll('*')||[])].filter((n)=>/NaN|Infinity/.test(getComputedStyle(n).transform)).length};
    },room);
    const liveBuffer=await page.screenshot({path:path.join(out,`room-${room.key}.png`)});
    const exactBuffer=Buffer.from(state.exactSrc.split(',')[1]||'','base64');
    const pixelMae=imageDifference(exactBuffer,liveBuffer,{left:50,right:1230,top:105,bottom:755});
    if(room.key==='people'){
      inboundHeldState={pixelMae,noEndpointImage:await page.evaluate(()=>!document.querySelector('.crm-home-preview-exact,.crm-transit-veil'))};
      if(!inboundHeldState.noEndpointImage||pixelMae>1)throw new Error(`Home camera did not land directly on the live settled room: ${JSON.stringify(inboundHeldState)}`);
    }
    const settledProbe=await page.evaluate(()=>window.__fps);
    const badBucket=room.key!=='planner'&&state.bucketGeometry.some((bucket)=>bucket.width<180||bucket.width>270||bucket.height<300||bucket.height>410||bucket.ratio<.55||bucket.ratio>.85);
    const badHeader=state.bucketHeaders.some((header)=>!header.title||header.whiteSpace!=='nowrap'||!header.singleLine||header.count||header.barsPosition!=='absolute'||header.barsRight<8||header.barsRight>60);
    const badAssignmentContract=room.key==='assignments'&&(!state.assignmentCanonical||state.assignmentMissingMethods.length||state.assignmentLegacy||state.assignmentMiniatures||state.assignmentContract?.workflowKind!=='lifecycle'||state.assignmentContract?.horizontalZones!==true||state.assignmentContract?.horizontalZoneRows!==1||state.assignmentContract?.lazyZoneCards!==false||state.assignmentContract?.restoreZoneExpansion!==false||state.assignmentContract?.stageAuthority!=='source'||state.assignmentContract?.deletionAuthority!=='source'||state.assignmentContract?.atomicSourceMove!==true||state.assignmentContract?.deckScaffold!==false||state.assignmentContract?.leftDeckEnabled!==false||state.assignmentContract?.rightDeckEnabled!==false||state.assignmentContract?.trashEnabled!==false||state.assignmentContract?.stageMovement!=='free'||state.assignmentContract?.showProgressBars!==true);
    const badAssignmentScroller=room.key==='assignments'&&(!state.assignmentScroller||!state.assignmentScrollState||state.assignmentScrollState.x>1||state.assignmentScrollState.x<state.assignmentScrollState.min-1||(state.assignmentOverflow>1&&(!state.assignmentScroller.on||state.assignmentScroller.thumb<28||state.assignmentScroller.thumb>=state.assignmentScroller.track))||(state.assignmentOverflow<=1&&(Math.abs(state.assignmentScrollState.x)>1||Math.abs(state.assignmentScrollState.min)>1)));
    if(!state.visible||state.count!==room.expected||state.arrows||state.unstackControls||badBucket||badHeader||badAssignmentContract||badAssignmentScroller||state.veil||state.invalid||JSON.stringify(state.signature)!==JSON.stringify(state.previewSignature)||pixelMae>12||settledProbe.fps<40)throw new Error(`${room.key} capture/live mismatch: ${JSON.stringify({state:{...state,exactSrc:undefined},pixelMae,settledProbe})}`);
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
        const api = window.crmAssignments; const stage = document.querySelector('[data-crm-theater="assignments"] .tk-zone[data-stage]')?.dataset.stage;
        if (stage) api.setStageExpanded(stage, !api.expandedStages().includes(stage));
        api.scrollZonesBy(190, true); changed = true;
      }
      return { changed };
    }, room.key);
    await page.mouse.move(1,1); await sleep(280);
    const expectedViewState = await page.evaluate((key) => window.crmHome.captureDisplayedState(key), room.key);
    const synchronizedLiveBuffer = await page.screenshot({path:path.join(out,`room-${room.key}-synchronized.png`)});
    const outboundSourceMaterial=await page.evaluate((key)=>{
      const bucket=window.crmHomeCamera?.layers?.()[0]?.querySelector(`.crm-home-bucket[data-module="${CSS.escape(key)}"]`);
      const style=bucket&&getComputedStyle(bucket);
      return style?{
        backgroundColor:style.backgroundColor,
        backgroundImage:style.backgroundImage,
        backdropFilter:style.webkitBackdropFilter||style.backdropFilter,
        borderColor:style.borderColor,
        borderStyle:style.borderStyle,
        boxShadow:style.boxShadow,
      }:null;
    },room.key);
    await startEndpointProbe(page,`out-${room.key}`,room,'out');
    const outboundReaction=await page.evaluate(()=>{const started=performance.now();window.__homeDrive=window.crmDeskTransit.driveTo('home');return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),level:window.crmHomeCamera?.level?.(),module:document.body.dataset.crmModule}});
    if(!outboundReaction.busy||outboundReaction.level!==1||outboundReaction.module!=='home'||outboundReaction.elapsedMs>50)throw new Error(`${room.key} Home click did not start its camera move immediately: ${JSON.stringify(outboundReaction)}`);
    await sleep(100);
    const outboundMid=await page.evaluate(()=>{
      const surface=window.crmHomeCamera?.surface?.();
      const root=window.crmHomeCamera?.layers?.()[0];
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      const grid=root?.querySelector(':scope>.crm-home-grid');
      const titleLayer=root?.querySelector(':scope>.crm-home-title-layer');
      const hand=root?.querySelector(':scope>.crm-home-priority-hand');
      const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');
      const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');
      const status=window.crmHome?.motionStatus?.();
      const expanderStyle=expander&&getComputedStyle(expander);
      const exact=expander?.querySelector('.crm-home-preview-exact');
      const exactHidden=!exact||getComputedStyle(exact).display==='none'||getComputedStyle(exact).visibility==='hidden'||Number(getComputedStyle(exact).opacity)<=.001;
      const target=root?.querySelector('.crm-home-bucket.is-camera-target');
      const liveOwnersHidden=[grid,titleLayer,hand].every((node)=>node&&getComputedStyle(node).visibility==='hidden');
      const motionCutoutOwns=!!snapshot&&getComputedStyle(snapshot).display==='none'
        &&!!variant&&variant.dataset.motionVariant===target?.dataset.module
        &&getComputedStyle(variant).display!=='none'&&Number(getComputedStyle(variant).opacity)>.99;
      const expanderNeutral=!!expanderStyle
        &&expanderStyle.backgroundColor==='rgba(0, 0, 0, 0)'
        &&expanderStyle.backgroundImage==='none'
        &&expanderStyle.boxShadow==='none'
        &&(expanderStyle.webkitBackdropFilter||expanderStyle.backdropFilter)==='none';
      return{
        moving:window.crmHomeCamera?.isTransitioning?.(),
        rootOpacity:root?Number(getComputedStyle(root).opacity):1,
        liveOwnersHidden,
        motionCutoutOwns,
        signatureMatches:status?.layoutSignature===window.crmHome?.motionLayoutSignature?.(),
        bitmapMotion:surface?.classList.contains('crm-home-bitmap-motion'),
        motionSnapshotReady:root?.dataset?.motionSnapshotReady||'',
        motionVariantKey:root?.dataset?.motionVariant||'',
        targetModule:target?.dataset?.module||'',
        targetTileId:target?.dataset?.tileId||'',
        variantState:variant?{
          module:variant.dataset.motionVariant||'',
          tileId:variant.dataset.motionTileId||'',
          complete:variant.complete,
          naturalWidth:variant.naturalWidth,
          display:getComputedStyle(variant).display,
          opacity:Number(getComputedStyle(variant).opacity),
        }:null,
        expanderAbove:!!expander&&!!root&&Number(getComputedStyle(expander).zIndex)>Number(getComputedStyle(root).zIndex),
        noEndpointImage:exactHidden,
        sharedBackground:status?.backgroundMode==='shared'
          &&status?.materialMode==='live-peripheral-acrylic'
          &&document.querySelectorAll('.crm-home-scene-backdrop').length===0
          &&document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1
          &&!!expander?.querySelector('.crm-home-preview-foreground')&&exactHidden&&expanderNeutral,
        contracting:surface?.classList.contains('crm-home-camera-contracting'),
      };
    });
    const outboundAcrylic=await page.evaluate((expected)=>{
      const surface=window.crmHomeCamera?.surface?.();const root=window.crmHomeCamera?.layers?.()[0];
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      const edge=expander?.querySelector(':scope>.crm-home-transition-acrylic');
      const plane=surface?.querySelector('.crm-home-screen-acrylic');
      const clipHost=plane?.parentElement?.classList.contains('crm-home-screen-acrylic-clip')?plane.parentElement:plane;
      const peripheralPlane=surface?.querySelector('.crm-home-peripheral-screen-acrylic');
      const peripheralHost=peripheralPlane?.parentElement;
      const exact=expander?.querySelector('.crm-home-preview-exact');
      const exactHidden=!exact||getComputedStyle(exact).display==='none'||getComputedStyle(exact).visibility==='hidden'||Number(getComputedStyle(exact).opacity)<=.001;
      const target=root?.querySelector('.crm-home-bucket.is-camera-target');
      const variant=root?.querySelector(':scope>.crm-home-motion-variant.is-active-motion-variant');
      const snapshot=root?.querySelector(':scope>.crm-home-motion-snapshot');
      const material=(node,clipped=false)=>{
        if(!node)return null;
        const style=getComputedStyle(node),rect=node.getBoundingClientRect();
        let bounds=[rect.x,rect.y,rect.width,rect.height];
        if(clipped){
          const match=style.clipPath.match(/^inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/);
          if(match){
            const top=Number(match[1]),right=Number(match[2]),bottom=Number(match[3]),left=Number(match[4]);
            bounds=[rect.x+left,rect.y+top,rect.width-left-right,rect.height-top-bottom];
          }
        }
        const matrix=style.transform&&style.transform!=='none'?new DOMMatrix(style.transform):new DOMMatrix();
        return{
          opacity:Number(style.opacity),
          backgroundColor:style.backgroundColor,
          backgroundImage:style.backgroundImage,
          backdrop:style.webkitBackdropFilter||style.backdropFilter,
          borderColor:style.borderColor,
          borderStyle:style.borderStyle,
          shadow:style.boxShadow,
          clip:style.clipPath,
          scale:[matrix.a,matrix.d],
          rect:bounds,
        };
      };
      const lid=material(expander),lens=material(plane),lensHost=material(clipHost,true),frame=material(edge);
      const peripheralLens=material(peripheralPlane),peripheralClip=material(peripheralHost);
      const animationFor=(node,property)=>{
        const matches=[...(node?.getAnimations?.()||[])].filter((animation)=>{
          const duration=Number(animation.effect?.getComputedTiming?.().duration);
          const keyframes=animation.effect?.getKeyframes?.()||[];
          return animation.effect?.target===node
            &&animation.playState!=='idle'&&animation.playState!=='paused'
            &&animation.replaceState!=='removed'
            &&Number.isFinite(duration)&&Math.abs(duration-460)<=1
            &&keyframes.some((keyframe)=>keyframe[property]!=null);
        });
        return matches.at(-1)||null;
      };
      const transformAnimation=animationFor(expander,'transform');
      const clipAnimation=animationFor(clipHost,'clipPath');
      const opacityAnimation=animationFor(plane,'opacity');
      const peripheralClipAnimation=animationFor(peripheralHost,'clipPath');
      const animations=[transformAnimation,clipAnimation,opacityAnimation];
      const animationTimes=animations.map((animation)=>animation?.currentTime==null?NaN:Number(animation.currentTime));
      const animationStarts=animations.map((animation)=>animation?.startTime==null?NaN:Number(animation.startTime));
      const aligned=(values)=>values.every(Number.isFinite)&&values.slice(1).every((value)=>Math.abs(value-values[0])<=1.5);
      const cutoutOwned=!!variant&&getComputedStyle(variant).display!=='none'
        &&Number(getComputedStyle(variant).opacity)>.99
        &&variant.dataset.motionVariant===target?.dataset.module
        &&getComputedStyle(snapshot).display==='none';
      const tintCopied=!!lens&&!!expected
        &&lens.backgroundColor===expected.backgroundColor
        &&lens.backgroundImage===expected.backgroundImage
        &&lens.backdrop===expected.backdropFilter;
      const frameCopied=!!frame&&!!expected
        &&frame.borderColor===expected.borderColor
        &&frame.borderStyle===expected.borderStyle
        &&frame.shadow===expected.boxShadow;
      const peripheralState=window.crmHome?.peripheralAcrylicState?.();
      const peripheralTimes=[transformAnimation,peripheralClipAnimation].map((animation)=>animation?.currentTime==null?NaN:Number(animation.currentTime));
      const peripheralStarts=[transformAnimation,peripheralClipAnimation].map((animation)=>animation?.startTime==null?NaN:Number(animation.startTime));
      return{
        frame:expander?.dataset.fractalFrame||'',
        lid,lens,lensHost,edge:frame,exact:material(exact),peripheralLens,peripheralClip,peripheralState,
        lensAligned:!!lensHost&&!!lid&&lensHost.rect.every((value,index)=>Math.abs(value-lid.rect[index])<=1.25),
        timelineAligned:animations.every(Boolean)&&aligned(animationTimes)&&aligned(animationStarts),
        animationTimes,
        animationStarts,
        animationStates:animations.map((animation)=>animation?.playState||'missing'),
        cutoutOwned,
        sharedWallpaper:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length===1&&exactHidden&&!!expander?.querySelector('.crm-home-preview-foreground'),
        tintCopied,
        frameCopied,
        peripheralTimelineAligned:!!peripheralClipAnimation&&aligned(peripheralTimes)&&aligned(peripheralStarts),
        peripheralAcrylic:!!peripheralLens&&!!peripheralClip
          &&peripheralHost?.parentElement===surface
          &&surface?.classList.contains('crm-home-peripheral-acrylic-active')
          &&peripheralState?.active&&peripheralState.phase==='motion'&&peripheralState.direction==='contract'&&peripheralState.neighborCount===3
          &&peripheralLens.opacity>.99
          &&peripheralLens.backgroundColor==='rgba(0, 0, 0, 0)'
          &&peripheralLens.backgroundImage==='none'
          &&peripheralLens.scale.every((value)=>Math.abs(value-1)<.001)
          &&peripheralLens.backdrop.includes('blur(26px)')
          &&peripheralLens.backdrop.includes('saturate(1.4)')
          &&peripheralClip.clip.startsWith('path('),
        cachedLens:!!lens&&!!lensHost&&clipHost?.parentElement===surface
          &&lens.scale.every((value)=>Math.abs(value-1)<.001)
          &&lensHost.scale.every((value)=>Math.abs(value-1)<.001)
          &&lens.backdrop.includes('blur(26px)')
          &&lens.backdrop.includes('saturate(1.4)')
          &&lensHost.clip.startsWith('inset(')
          &&frame?.backdrop==='none'
          &&frame?.backgroundColor==='rgba(0, 0, 0, 0)'
          &&frame?.backgroundImage==='none',
      };
    },outboundSourceMaterial);
    if(!outboundMid.moving||outboundMid.rootOpacity<.99||!outboundMid.liveOwnersHidden||!outboundMid.motionCutoutOwns||!outboundMid.noEndpointImage||!outboundMid.sharedBackground||!outboundMid.signatureMatches||!outboundMid.expanderAbove||!outboundMid.contracting||!outboundAcrylic.cutoutOwned||!outboundAcrylic.sharedWallpaper||!outboundAcrylic.cachedLens||!outboundAcrylic.tintCopied||!outboundAcrylic.frameCopied||!outboundAcrylic.lensAligned||!outboundAcrylic.timelineAligned||!outboundAcrylic.peripheralAcrylic||!outboundAcrylic.peripheralTimelineAligned)throw new Error(`${room.key} return composition diverged from resting Home: ${JSON.stringify({outboundMid,outboundAcrylic,outboundSourceMaterial})}`);
    await page.evaluate(()=>window.__homeDrive); await page.waitForFunction(readyHome,null,{timeout:15000});
    const outboundEndpoint=await finishEndpointProbe(page,`out-${room.key}`);
    assertHomeFade(`${room.key} outbound visual`,outboundEndpoint,'out');
    if(outboundEndpoint.hadVeil||!outboundEndpoint.homePrecomposed||!outboundEndpoint.sawHomeHandoff||outboundEndpoint.sawHomeCrossfade||outboundEndpoint.snapshotVisible||!outboundEndpoint.peripheralAcrylicEveryFrame||outboundEndpoint.endpointFrames<1||outboundEndpoint.endpointSignatures!==1||!outboundEndpoint.endpointShadowsReady||outboundEndpoint.endpointShadowSignatures!==1||!outboundEndpoint.endpointHomeMaterialsReady||!outboundEndpoint.endpointOwnersContinuous||!outboundEndpoint.endpointPeripheralAcrylicReady||outboundEndpoint.final.homeHandoff||outboundEndpoint.final.homeReleasing||outboundEndpoint.final.snapshotDisplay!=='none')throw new Error(`${room.key} outbound did not hand smoothly to precomposed Home: ${JSON.stringify(outboundEndpoint)}`);
    const outboundStability=await sampleLayoutStability(page,'.crm-home-surface:not([hidden])');
    await page.waitForFunction(({key,before})=>{const status=window.crmHome.previewStatus().find((item)=>item.key===key);return status?.state==='ready'&&status.capturedAt>before;},{key:room.key,before},{timeout:60000});
    const synchronizedPreview=await page.evaluate(async({key,token})=>{const status=window.crmHome.previewStatus().find((item)=>item.key===key);const preview=(await window.crmHomePreviews.list()).previews.find((item)=>item.key===key);const host=document.querySelector(`.crm-home-bucket[data-module="${key}"] .crm-home-preview`);const image=host?.querySelector(':scope > .crm-home-preview-foreground');return{after:status?.capturedAt||0,state:status?.state,sameNode:image?.dataset.liveSyncProbe===token,hostCapturedAt:Number(host?.dataset.capturedAt||0),viewState:preview?.viewState||null,exactSrc:preview?.exactSrc||''};},{key:room.key,token:previewNodeToken});
    const after=synchronizedPreview.after;
    const synchronizedExactBuffer=Buffer.from(synchronizedPreview.exactSrc.split(',')[1]||'','base64');
    const synchronizedPixelMae=imageDifference(synchronizedExactBuffer,synchronizedLiveBuffer,{left:50,right:1230,top:105,bottom:755});
    if(outboundStability.uniqueSignatures!==1)throw new Error(`${room.key} kept shifting after returning Home: ${JSON.stringify(outboundStability)}`);
    if(after<=before||synchronizedPreview.state!=='ready'||!synchronizedPreview.sameNode||synchronizedPreview.hostCapturedAt!==after||JSON.stringify(synchronizedPreview.viewState)!==JSON.stringify(expectedViewState)||synchronizedPixelMae>12)throw new Error(`${room.key} Home tile did not synchronize with the displayed room: ${JSON.stringify({before,after,synchronization,expectedViewState,actualViewState:synchronizedPreview.viewState,sameNode:synchronizedPreview.sameNode,hostCapturedAt:synchronizedPreview.hostCapturedAt,synchronizedPixelMae})}`);
    transitions.push({key:room.key,mid,acrylicMid,outboundMid,outboundAcrylic,pixelMae,inboundHeldState:inboundHeldState&&{...inboundHeldState,exactSrc:!!inboundHeldState.exactSrc},synchronizedPixelMae,fps:settledProbe.fps,companyRailMotion,inactiveHomeRetention,inbound:inboundEndpoint,outbound:outboundEndpoint,inboundEndpoint,outboundEndpoint,inboundStability,outboundStability,inboundReaction,outboundReaction,signatureMatches:true,previewRefreshed:after>before,previewNodePreserved:synchronizedPreview.sameNode});
  }
  const homeTransitionCoverage=new Set(transitions.flatMap((transition)=>[
    `${transition.key}:in`,
    `${transition.key}:out`,
  ]));
  const expectedHomeTransitionCoverage=new Set(rooms.flatMap((room)=>[
    `${room.key}:in`,
    `${room.key}:out`,
  ]));
  if(homeTransitionCoverage.size!==expectedHomeTransitionCoverage.size
    ||[...expectedHomeTransitionCoverage].some((key)=>!homeTransitionCoverage.has(key))){
    throw new Error(`Full Home transition coverage is incomplete: ${JSON.stringify([...homeTransitionCoverage])}`);
  }
  // The endpoint probe intentionally allocates per-frame geometry/material
  // signatures. Those objects are test-only and no longer have callbacks once
  // coverage is complete; retaining them can schedule a V8 major GC inside the
  // following 460ms rAF diagnostic even while compositor presentation remains
  // at native rate. Discard and collect that instrumentation garbage while Home
  // is idle so the isolated probe measures the product, not its prior observer.
  await page.evaluate(()=>{
    window.__crmEndpointProbes={};
    window.__crmMotionProbes={};
  });
  // Do not force a heap collection here. It can discard Chromium's prewarmed
  // backdrop surface immediately before the cadence sample, turning this into
  // a synthetic cold-allocation benchmark instead of measuring the app path.
  await page.evaluate(()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
  // Cadence gets its own transition cycles. No endpoint/style probe, screenshot,
  // layout sampler, or polling callback runs while the camera is moving.
  await installMotionProbe(page);
  const cadenceTransitions=[];
  for(const room of rooms){
    const selector=`.crm-home-grid > .crm-home-bucket[data-module="${room.key}"]`;
    await page.hover(selector);await sleep(160);
    const inboundLabel=`cadence-in-${room.key}`;
    const cadenceInboundReaction=await page.$eval(selector,(bucket,label)=>{
      window.__startCrmMotionProbe(label);
      const started=performance.now();
      bucket.click();
      return{
        elapsedMs:performance.now()-started,
        busy:window.crmDeskTransit?.isBusy?.(),
        transitioning:window.crmHomeCamera?.isTransitioning?.(),
      };
    },inboundLabel);
    if(!cadenceInboundReaction.busy||!cadenceInboundReaction.transitioning||cadenceInboundReaction.elapsedMs>50)throw new Error(`${room.key} cadence click did not synchronously start motion: ${JSON.stringify(cadenceInboundReaction)}`);
    const cadenceInbound=await finishMotionProbe(page,inboundLabel);
    const cadenceInboundAssessment=assertMotion(`${room.key} isolated inbound`,cadenceInbound,{
      allowColdAcrylic:cadenceTransitions.length===0&&room.key==='people',
    });
    await page.waitForFunction((key)=>document.body.dataset.crmModule===key&&!window.crmDeskTransit?.isBusy?.(),room.key,{timeout:15000});

    const outboundLabel=`cadence-out-${room.key}`;
    const cadenceOutboundReaction=await page.$eval('.crm-home-control',(button,label)=>{
      window.__startCrmMotionProbe(label);
      const started=performance.now();
      button.click();
      return{
        elapsedMs:performance.now()-started,
        busy:window.crmDeskTransit?.isBusy?.(),
        transitioning:window.crmHomeCamera?.isTransitioning?.(),
        level:window.crmHomeCamera?.level?.(),
        module:document.body.dataset.crmModule,
      };
    },outboundLabel);
    // The return path synchronously seats the full-screen bucket lid and commits
    // Home behind it. Its compositor transform deliberately starts on the next
    // rAF, after that covered precomposition frame.
    if(!cadenceOutboundReaction.busy||cadenceOutboundReaction.level!==1||cadenceOutboundReaction.module!=='home'||cadenceOutboundReaction.elapsedMs>50)throw new Error(`${room.key} cadence Home click did not synchronously seat its motion cover: ${JSON.stringify(cadenceOutboundReaction)}`);
    const cadenceOutbound=await finishMotionProbe(page,outboundLabel);
    assertMotion(`${room.key} isolated outbound`,cadenceOutbound);
    await page.waitForFunction(readyHome,null,{timeout:15000});
    await page.evaluate(()=>window.crmHome?.waitForPreviewSync?.());await sleep(60);
    let warmRepeat=null;
    if(cadenceInboundAssessment.boundedColdAcrylic){
      await page.hover(selector);await sleep(160);
      const repeatInboundLabel=`cadence-repeat-in-${room.key}`;
      const repeatInboundReaction=await page.$eval(selector,(bucket,label)=>{
        window.__startCrmMotionProbe(label);
        const started=performance.now();bucket.click();
        return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),transitioning:window.crmHomeCamera?.isTransitioning?.()};
      },repeatInboundLabel);
      if(!repeatInboundReaction.busy||!repeatInboundReaction.transitioning||repeatInboundReaction.elapsedMs>50)throw new Error(`${room.key} warm-repeat click did not synchronously start motion: ${JSON.stringify(repeatInboundReaction)}`);
      const repeatInbound=await finishMotionProbe(page,repeatInboundLabel);
      assertMotion(`${room.key} warm-repeat inbound`,repeatInbound);
      await page.waitForFunction((key)=>document.body.dataset.crmModule===key&&!window.crmDeskTransit?.isBusy?.(),room.key,{timeout:15000});
      const repeatOutboundLabel=`cadence-repeat-out-${room.key}`;
      const repeatOutboundReaction=await page.$eval('.crm-home-control',(button,label)=>{
        window.__startCrmMotionProbe(label);
        const started=performance.now();button.click();
        return{elapsedMs:performance.now()-started,busy:window.crmDeskTransit?.isBusy?.(),level:window.crmHomeCamera?.level?.(),module:document.body.dataset.crmModule};
      },repeatOutboundLabel);
      if(!repeatOutboundReaction.busy||repeatOutboundReaction.level!==1||repeatOutboundReaction.module!=='home'||repeatOutboundReaction.elapsedMs>50)throw new Error(`${room.key} warm-repeat Home click did not synchronously start motion: ${JSON.stringify(repeatOutboundReaction)}`);
      const repeatOutbound=await finishMotionProbe(page,repeatOutboundLabel);
      assertMotion(`${room.key} warm-repeat outbound`,repeatOutbound);
      await page.waitForFunction(readyHome,null,{timeout:15000});
      await page.evaluate(()=>window.crmHome?.waitForPreviewSync?.());await sleep(60);
      warmRepeat={inbound:repeatInbound,outbound:repeatOutbound,inboundReaction:repeatInboundReaction,outboundReaction:repeatOutboundReaction};
    }
    cadenceTransitions.push({
      key:room.key,
      inbound:cadenceInbound,
      inboundAssessment:cadenceInboundAssessment,
      outbound:cadenceOutbound,
      warmRepeat,
      inboundReaction:cadenceInboundReaction,
      outboundReaction:cadenceOutboundReaction,
    });
  }
  const cadenceCoverage=new Set(cadenceTransitions.flatMap((transition)=>[
    `${transition.key}:in`,
    `${transition.key}:out`,
  ]));
  if(cadenceCoverage.size!==expectedHomeTransitionCoverage.size
    ||[...expectedHomeTransitionCoverage].some((key)=>!cadenceCoverage.has(key))){
    throw new Error(`Isolated Home cadence coverage is incomplete: ${JSON.stringify([...cadenceCoverage])}`);
  }
  const handTicket=await page.evaluate((commitmentId)=>{
    const card=document.querySelector(`.crm-home-hand-card[data-commitment-id="${CSS.escape(commitmentId)}"]`);
    return card?{commitmentId:card.dataset.commitmentId,ticketId:card.dataset.recordId}:null;
  },nativeTicketCommitmentId);
  if(!handTicket){const handState=await page.evaluate(async(commitmentId)=>({commitmentId,status:window.crmHome?.handStatus?.(),cards:[...document.querySelectorAll('.crm-home-hand-card')].map((card)=>({commitmentId:card.dataset.commitmentId,entity:card.dataset.recordEntity,recordId:card.dataset.recordId})),record:(await window.crmDomain.list('commitments',{includeDeleted:false,limit:300})).records?.find((item)=>item.id===commitmentId)||null}),nativeTicketCommitmentId);throw new Error(`Home hand has no linked ticket for the native handoff probe: ${JSON.stringify(handState)}`)}
  const handTicketSelector=`.crm-home-hand-card[data-commitment-id="${handTicket.commitmentId}"]`;
  await page.hover(handTicketSelector);await sleep(420);
  const handTicketPrecomposed=await page.evaluate(()=>[...document.querySelectorAll('[data-crm-home-precomposed]')].map((node)=>node.dataset.crmTheater));
  if(!handTicketPrecomposed.includes('tickets'))throw new Error(`Home hand did not precompose its linked ticket world: ${JSON.stringify(handTicketPrecomposed)}`);
  await page.click(handTicketSelector);
  await sleep(80);
  const handTicketEarly=await page.evaluate(()=>({module:document.body.dataset.crmModule,busy:window.crmDeskTransit?.isBusy?.(),moving:window.crmHomeCamera?.isTransitioning?.(),detail:document.querySelectorAll('.ticket-detail-overlay:not([hidden])').length,recordWorld:!!document.querySelector('.record-world-shell:not([hidden])')}));
  if(handTicketEarly.module!=='home'||!handTicketEarly.busy||!handTicketEarly.moving||handTicketEarly.detail||handTicketEarly.recordWorld)throw new Error(`Home ticket opened before its world handoff: ${JSON.stringify(handTicketEarly)}`);
  await page.waitForFunction((ticketId)=>document.body.dataset.crmModule==='cases'&&!window.crmDeskTransit?.isBusy?.()&&!!document.querySelector('.ticket-detail-overlay:not([hidden]) .ticket-detail')&&[...document.querySelectorAll('[data-crm-theater="tickets"]:not([hidden]) .tk-zcard,[data-crm-theater="tickets"]:not([hidden]) .tk-deck .tk-card')].some((card)=>card.dataset.id===ticketId&&card.style.visibility==='hidden'),handTicket.ticketId,{timeout:15000});
  const handTicketMotion=null;
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
  if(!projectPreviewBefore.image||!projectPreviewBefore.exactSrc||!projectPreviewBefore.foregroundSrc||!projectPreviewBefore.filter.includes(HOME_PREVIEW_REST_FILTER)||projectPreviewBefore.natural[0]!==1280||projectPreviewBefore.natural[1]!==860||projectPreviewBefore.title!=='Native preview project')throw new Error(`Nested project tile did not use the native Home preview contract: ${JSON.stringify({...projectPreviewBefore,exactSrc:!!projectPreviewBefore.exactSrc,foregroundSrc:!!projectPreviewBefore.foregroundSrc})}`);
  await page.screenshot({path:path.join(out,'projects-nested.png')});
  await page.evaluate(()=>{window.__startNativeProjectContinuity=(layerForFrame)=>new Promise((resolve)=>{
    const samples=[];let sawOwnedMotion=false;const armedAt=performance.now();
    const tick=()=>{const layer=layerForFrame();const frame=layer?.querySelector(':scope>.crm-project-transition-acrylic');const screenLens=document.querySelector('.crm-planner-surface .crm-project-screen-acrylic');const acrylic=screenLens||((sawOwnedMotion&&!window.crmProjectsCamera?.isTransitioning?.())?frame:null);const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const exact=layer?.querySelector(':scope>.crm-project-transition-exact');const live=layer?.querySelector(':scope>.crm-planner-project-live');const moving=!!window.crmProjectsCamera?.isTransitioning?.();const materialMoving=!!screenLens&&!!document.querySelector('.crm-planner-surface.crm-project-acrylic-expanding,.crm-planner-surface.crm-project-acrylic-contracting');
      if(acrylic&&((moving&&(materialMoving||!sawOwnedMotion))||(sawOwnedMotion&&!moving))){sawOwnedMotion=true;const style=getComputedStyle(acrylic),owner=getComputedStyle(layer),frameStyle=frame&&getComputedStyle(frame),exactStyle=exact&&getComputedStyle(exact);const acrylicHost=screenLens?.parentElement?.classList.contains('crm-project-screen-acrylic-clip')?screenLens.parentElement:screenLens;const hostStyle=acrylicHost&&getComputedStyle(acrylicHost);const matrix=hostStyle?.transform&&hostStyle.transform!=='none'?new DOMMatrix(hostStyle.transform):new DOMMatrix();const animations=[...(screenLens?.getAnimations?.()||[]),...(acrylicHost&&acrylicHost!==screenLens?(acrylicHost.getAnimations?.()||[]):[])];const opacityAnimation=(screenLens?.getAnimations?.()||[]).find((animation)=>(animation.effect?.getKeyframes?.()||[]).some((keyframe)=>keyframe.opacity!=null));const phase=screenLens?.dataset?.fractalAcrylicPhase||'';const previewOpacity=Number(overlay?getComputedStyle(overlay).opacity:0),liveOpacity=Number(live?getComputedStyle(live).opacity:0);samples.push({at:performance.now(),phase,opacity:Number(style.opacity)*(screenLens?1:Number(owner.opacity)),opacityTime:Number(opacityAnimation?.currentTime),owned:Number(owner.opacity)>.99&&!layer.style.transition.includes('opacity')&&(!screenLens||acrylicHost?.parentElement===window.crmProjectsCamera?.surface?.()),backdrop:style.backdropFilter||'',objects:previewOpacity+liveOpacity,previewOpacity,liveOpacity,exactCover:!!exact&&exactStyle?.visibility==='visible'&&Number(exactStyle.opacity)>.99,internalReady:layer?.dataset.projectAcrylicReady==='true',internalOwners:Number(layer?.dataset.projectAcrylicOwners)||0,frame:layer?.dataset.fractalFrame||'',material:materialMoving,probeMutated:!!window.__nativeProjectBlurProbeActive,timed:!screenLens||animations.length>=(phase==='release'?1:2),screenSpace:!screenLens||(Math.abs(matrix.a-1)<.001&&Math.abs(matrix.d-1)<.001&&hostStyle?.clipPath?.startsWith('inset(')),frameNeutral:!screenLens||(frameStyle?.backgroundImage==='none'&&frameStyle?.backdropFilter==='none'),opacityKeyframes:(opacityAnimation?.effect?.getKeyframes?.()||[]).map((keyframe)=>[keyframe.computedOffset,Number(keyframe.opacity)])})}
      if(moving||(!sawOwnedMotion&&performance.now()-armedAt<2000)){requestAnimationFrame(tick);return}
      const opacities=samples.map((sample)=>sample.opacity);const opacitySteps=samples.slice(1).map((sample,index)=>({value:sample.opacity-samples[index].opacity,gap:sample.at-samples[index].at}));const cadenceOpacitySteps=opacitySteps.filter((sample)=>sample.gap<=15);const firstBelowFull=opacities.findIndex((opacity)=>opacity<.99);const firstFull=opacities.findIndex((opacity)=>opacity>.99);const materialSamples=samples.filter((sample)=>sample.material&&!sample.probeMutated);
      const motionSamples=samples.filter((sample)=>sample.phase==='motion');const releaseSamples=samples.filter((sample)=>sample.phase==='release');
      resolve({frames:samples.length,materialFrames:materialSamples.length,motionFrames:motionSamples.length,releaseFrames:releaseSamples.length,motionHeldEveryFrame:motionSamples.length>0&&motionSamples.every((sample)=>sample.opacity>=.99),releaseMonotonic:releaseSamples.slice(1).every((sample,index)=>sample.opacity<=releaseSamples[index].opacity+.04),releasePreviewHeldEveryFrame:releaseSamples.length>0&&releaseSamples.every((sample)=>sample.previewOpacity>.99&&sample.liveOpacity<.01&&!sample.exactCover&&!sample.internalReady),firstOpacity:opacities[0]??null,lastOpacity:opacities.at(-1)??null,maxOpacityStep:cadenceOpacitySteps.length?Math.max(...cadenceOpacitySteps.map((sample)=>Math.abs(sample.value))):0,maxObservedOpacityStep:opacitySteps.length?Math.max(...opacitySteps.map((sample)=>Math.abs(sample.value))):0,maxSampleGap:opacitySteps.length?Math.max(...opacitySteps.map((sample)=>sample.gap)):0,intermediateFrames:opacities.filter((opacity)=>opacity>.01&&opacity<.99).length,entryTailFrames:firstBelowFull<0?0:opacities.length-firstBelowFull,exitLeadFrames:firstFull<0?opacities.length:firstFull,nonIncreasing:opacitySteps.every((sample)=>sample.value<=.04),nonDecreasing:opacitySteps.every((sample)=>sample.value>=-.04),timedEveryFrame:materialSamples.length>0&&materialSamples.every((sample)=>sample.timed),screenSpaceEveryFrame:materialSamples.length>0&&materialSamples.every((sample)=>sample.screenSpace),frameNeutralEveryFrame:materialSamples.length>0&&materialSamples.every((sample)=>sample.frameNeutral),opacityKeyframes:materialSamples.find((sample)=>sample.opacityKeyframes.length)?.opacityKeyframes||[],ownedEveryFrame:samples.length>0&&samples.every((sample)=>sample.owned),realEveryFrame:materialSamples.length>0&&materialSamples.every((sample)=>sample.backdrop.includes('blur(26px)')),minObjectCoverage:samples.length?Math.min(...samples.map((sample)=>sample.objects)):0,maxObjectCoverage:samples.length?Math.max(...samples.map((sample)=>sample.objects)):0,framesSeen:[...new Set(samples.map((sample)=>sample.frame))],wallpapers:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length});
    };requestAnimationFrame(tick);
  })});
  const projectDiveStart=await page.evaluate((projectId)=>new Promise((resolve)=>{
    window.__nativeProjectContinuity=window.__startNativeProjectContinuity(()=>window.crmProjectsCamera?.layers?.()[1]||document.querySelector('.crm-planner-project-world:not(.crm-planner-warm)'));
    const tile=document.querySelector(`.crm-project-bucket[data-planner-project="${CSS.escape(projectId)}"]`);const source=tile?.getBoundingClientRect();window.__nativeProjectOpen=window.crmPlanner.openProject(projectId);requestAnimationFrame(()=>{const layer=window.crmProjectsCamera?.layers?.()[1]||document.querySelector('.crm-planner-project-world');const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const frame=layer?.querySelector(':scope>.crm-project-transition-acrylic');const acrylic=document.querySelector('.crm-planner-surface .crm-project-screen-acrylic');const live=layer?.querySelector(':scope>.crm-planner-project-live');const rect=layer?.getBoundingClientRect();const acrylicStyle=acrylic&&getComputedStyle(acrylic);const acrylicHost=acrylic?.parentElement?.classList.contains('crm-project-screen-acrylic-clip')?acrylic.parentElement:acrylic;const hostStyle=acrylicHost&&getComputedStyle(acrylicHost);const frameStyle=frame&&getComputedStyle(frame);const matrix=hostStyle?.transform&&hostStyle.transform!=='none'?new DOMMatrix(hostStyle.transform):new DOMMatrix();const layerStyle=layer&&getComputedStyle(layer);resolve({source:source&&[source.x,source.y,source.width,source.height],rect:rect&&[rect.x,rect.y,rect.width,rect.height],overlay:!!overlay,opacity:overlay?Number(getComputedStyle(overlay).opacity):0,src:overlay?.src||'',acrylic:!!acrylic,acrylicOpacity:acrylicStyle?Number(acrylicStyle.opacity):0,acrylicBackdrop:acrylicStyle?.backdropFilter||'',acrylicClip:hostStyle?.clipPath||'',screenScale:[matrix.a,matrix.d],frameBackground:frameStyle?.backgroundImage||'',frameBackdrop:frameStyle?.backdropFilter||'',layerOpacity:layerStyle?Number(layerStyle.opacity):0,layerTransition:layer?.style.transition||'',liveOpacity:live?Number(getComputedStyle(live).opacity):1,wallpapers:document.querySelectorAll('body>.workspace-photo-backdrop:not([hidden])').length,level:window.crmPlanner.level(),transitioning:window.crmProjectsCamera?.isTransitioning?.()})})
  }),nativeProjectId);
  if(!projectDiveStart.overlay||projectDiveStart.opacity<.99||projectDiveStart.src!==projectPreviewBefore.foregroundSrc||!projectDiveStart.acrylic||projectDiveStart.acrylicOpacity<.99||!projectDiveStart.acrylicBackdrop.includes('blur(26px)')||!projectDiveStart.acrylicClip.startsWith('inset(')||projectDiveStart.screenScale.some((value)=>Math.abs(value-1)>.001)||projectDiveStart.frameBackground!=='none'||projectDiveStart.frameBackdrop!=='none'||projectDiveStart.layerOpacity<.99||projectDiveStart.layerTransition.includes('opacity')||projectDiveStart.liveOpacity>.01||projectDiveStart.wallpapers!==1||!projectDiveStart.rect||projectDiveStart.rect.some((value,index)=>Math.abs(value-projectDiveStart.source[index])>1.25))throw new Error(`Project zoom did not carry one screen-space acrylic/object composition from its source: ${JSON.stringify({...projectDiveStart,src:!!projectDiveStart.src})}`);
  await sleep(80);
  await page.evaluate(()=>new Promise((resolve)=>{
    const surface=window.crmProjectsCamera?.surface?.();
    if(surface)surface.dataset.fractalCameraProbeHold='true';
    window.__nativeProjectProbeSurface=surface;
    window.__nativePausedAnimations=document.getAnimations().filter((animation)=>{
      const target=animation.effect?.target;
      const duration=Number(animation.effect?.getComputedTiming?.().duration);
      const keyframes=animation.effect?.getKeyframes?.()||[];
      const cameraProperty=keyframes.some((keyframe)=>
        keyframe.transform!=null||keyframe.clipPath!=null||keyframe.opacity!=null);
      return animation.playState==='running'&&!!surface&&!!target
        &&(target===surface||surface.contains(target))
        &&Number.isFinite(duration)&&Math.abs(duration-460)<=1&&cameraProperty;
    });
    window.__nativePausedAnimations.forEach((animation)=>animation.pause());
    requestAnimationFrame(()=>requestAnimationFrame(resolve));
  }));
  // Sample within the actual source tile. Project tiles now use the shared
  // adaptive grid, so their screen position is deliberately not fixed.
  const [projectSourceX,projectSourceY,projectSourceWidth,projectSourceHeight]=projectDiveStart.source;
  const projectBlurClip={
    x:Math.floor(projectSourceX+projectSourceWidth*.68),
    y:Math.floor(projectSourceY+projectSourceHeight*.54),
    width:Math.max(48,Math.floor(projectSourceWidth*.24)),
    height:Math.max(48,Math.floor(projectSourceHeight*.28)),
  };
  let projectBlurBuffer;
  let projectNoBlurBuffer;
  let projectProbeRelease={timedOut:false};
  try{
    projectBlurBuffer=await page.screenshot({path:path.join(out,'transition-project-acrylic.png'),clip:projectBlurClip});
    const projectLensFilter=await page.evaluate(()=>new Promise((resolve)=>{const lens=document.querySelector('.crm-planner-surface .crm-project-screen-acrylic');if(!lens){resolve(null);return}const original={backdrop:lens.style.backdropFilter,webkit:lens.style.webkitBackdropFilter};window.__nativeProjectBlurProbeActive=true;lens.style.backdropFilter='saturate(1.4)';lens.style.webkitBackdropFilter='saturate(1.4)';window.__nativeProjectLensFilter={lens,original};requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(original)))}));
    if(!projectLensFilter)throw new Error('Nested project transition had no screen-space acrylic lens for rendered blur verification');
    projectNoBlurBuffer=await page.screenshot({path:path.join(out,'transition-project-acrylic-no-blur.png'),clip:projectBlurClip});
  }finally{
    projectProbeRelease=await page.evaluate(async()=>{
      let timedOut=false;
      const surface=window.__nativeProjectProbeSurface;
      try{
        const saved=window.__nativeProjectLensFilter;
        if(saved?.lens){
          saved.lens.style.backdropFilter=saved.original.backdrop;
          saved.lens.style.webkitBackdropFilter=saved.original.webkit;
        }
        window.__nativeProjectBlurProbeActive=false;
        const completions=[];
        (window.__nativePausedAnimations||[]).forEach((animation)=>{
          try{
            animation.play();
            completions.push(Promise.resolve(animation.finished).catch(()=>null));
          }catch{}
        });
        let timeoutId=0;
        const outcome=await Promise.race([
          Promise.allSettled(completions).then(()=>'settled'),
          new Promise((resolve)=>{timeoutId=setTimeout(()=>resolve('timeout'),6000);}),
        ]);
        clearTimeout(timeoutId);
        timedOut=outcome==='timeout';
      }finally{
        if(surface?.dataset)delete surface.dataset.fractalCameraProbeHold;
        window.__nativePausedAnimations=[];
        window.__nativeProjectProbeSurface=null;
        window.__nativeProjectLensFilter=null;
        window.__nativeProjectBlurProbeActive=false;
        await new Promise((resolve)=>requestAnimationFrame(resolve));
      }
      return{timedOut};
    });
  }
  if(projectProbeRelease.timedOut)throw new Error('Nested project transition animations did not resume within 6000 ms');
  await sleep(20);await page.screenshot({path:path.join(out,'transition-project.png')});
  const projectBlurRegion={left:0,right:projectBlurClip.width,top:0,bottom:projectBlurClip.height};
  const projectRenderedBlur={difference:imageDifference(projectBlurBuffer,projectNoBlurBuffer,projectBlurRegion),withBlurEdge:imageEdgeEnergy(projectBlurBuffer,projectBlurRegion),withoutBlurEdge:imageEdgeEnergy(projectNoBlurBuffer,projectBlurRegion)};
  if(projectRenderedBlur.difference<1||projectRenderedBlur.withBlurEdge>=projectRenderedBlur.withoutBlurEdge*.9)throw new Error(`Nested project lens rendered tint without a material screen-space blur: ${JSON.stringify(projectRenderedBlur)}`);
  const projectDiveContinuity=await page.evaluate(()=>window.__nativeProjectContinuity);
  if(projectDiveContinuity.frames<20||projectDiveContinuity.materialFrames<20||projectDiveContinuity.motionFrames<20||projectDiveContinuity.releaseFrames<5||!projectDiveContinuity.motionHeldEveryFrame||!projectDiveContinuity.releaseMonotonic||!projectDiveContinuity.releasePreviewHeldEveryFrame||projectDiveContinuity.firstOpacity<.99||projectDiveContinuity.lastOpacity>.05||projectDiveContinuity.intermediateFrames<2||projectDiveContinuity.intermediateFrames>14||projectDiveContinuity.maxOpacityStep>.18||!projectDiveContinuity.nonIncreasing||!projectDiveContinuity.timedEveryFrame||!projectDiveContinuity.screenSpaceEveryFrame||!projectDiveContinuity.frameNeutralEveryFrame||!keyframesMatch(projectDiveContinuity.opacityKeyframes,[[0,1],[1,1]])||!projectDiveContinuity.ownedEveryFrame||!projectDiveContinuity.realEveryFrame||projectDiveContinuity.minObjectCoverage<.94||projectDiveContinuity.maxObjectCoverage>1.08)throw new Error(`Project zoom did not visibly release real acrylic over its unchanged project preview: ${JSON.stringify(projectDiveContinuity)}`);
  await page.waitForFunction(()=>window.crmPlanner?.view?.()==='project'&&!window.crmProjectsCamera?.isTransitioning?.(),null,{timeout:15000});await sleep(30);
  const projectDiveSettled=await page.evaluate(()=>{const layer=window.crmProjectsCamera.layers()[1];const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const exact=layer?.querySelector(':scope>.crm-project-transition-exact');const acrylic=layer?.querySelector(':scope>.crm-project-transition-acrylic');const live=layer?.querySelector(':scope>.crm-planner-project-live');const rect=layer?.getBoundingClientRect();return{rect:rect&&[rect.x,rect.y,rect.width,rect.height],opacity:overlay?Number(getComputedStyle(overlay).opacity):null,noEndpointImage:!exact,acrylicOpacity:acrylic?Number(getComputedStyle(acrylic).opacity):null,liveOpacity:live?Number(getComputedStyle(live).opacity):null,acrylicReady:layer?.dataset.projectAcrylicReady==='true',acrylicCoveredDuringWarm:layer?.dataset.projectAcrylicCoveredDuringWarm==='true',acrylicOwners:Number(layer?.dataset.projectAcrylicOwners)||0,acrylicWarmFrames:Number(layer?.dataset.projectAcrylicWarmFrames)||0,lenses:document.querySelectorAll('.crm-planner-surface .crm-project-screen-acrylic').length,buckets:layer?.querySelectorAll('.crm-planner-bucket').length||0,cards:layer?.querySelectorAll('.crm-planner-card').length||0}});
  if(!projectDiveSettled.rect||projectDiveSettled.rect.some((value,index)=>Math.abs(value-[0,0,1280,860][index])>1)||projectDiveSettled.opacity!==0||!projectDiveSettled.noEndpointImage||projectDiveSettled.acrylicOpacity!==0||projectDiveSettled.liveOpacity!==1||!projectDiveSettled.acrylicReady||!projectDiveSettled.acrylicCoveredDuringWarm||projectDiveSettled.acrylicOwners<1||projectDiveSettled.acrylicWarmFrames<4||projectDiveSettled.lenses!==0||projectDiveSettled.buckets!==3||projectDiveSettled.cards!==1)throw new Error(`Project zoom did not warm its real acrylic buckets beneath the exact endpoint before handoff: ${JSON.stringify(projectDiveSettled)}`);
  const projectWorldBuffer=await page.screenshot({path:path.join(out,'project-world.png')});
  const projectSettledPixelMae=imageDifference(Buffer.from(projectPreviewBefore.exactSrc.split(',')[1]||'','base64'),projectWorldBuffer,{left:50,right:1230,top:105,bottom:755});
  if(projectSettledPixelMae>1)throw new Error(`Project endpoint texture displaced from its settled world: ${JSON.stringify({projectSettledPixelMae})}`);
  const projectReturnStart=await page.evaluate(()=>new Promise((resolve)=>{window.__nativeProjectReturnContinuity=window.__startNativeProjectContinuity(()=>document.querySelector('.crm-planner-project-world.crm-planner-contracting'));window.crmPlanner.back();requestAnimationFrame(()=>{const layer=document.querySelector('.crm-planner-project-world.crm-planner-contracting');const overlay=layer?.querySelector(':scope>.crm-project-transition-preview');const frame=layer?.querySelector(':scope>.crm-project-transition-acrylic');const acrylic=document.querySelector('.crm-planner-surface .crm-project-screen-acrylic');const live=layer?.querySelector(':scope>.crm-planner-project-live');const acrylicStyle=acrylic&&getComputedStyle(acrylic);const acrylicHost=acrylic?.parentElement?.classList.contains('crm-project-screen-acrylic-clip')?acrylic.parentElement:acrylic;const hostStyle=acrylicHost&&getComputedStyle(acrylicHost);const frameStyle=frame&&getComputedStyle(frame);const matrix=hostStyle?.transform&&hostStyle.transform!=='none'?new DOMMatrix(hostStyle.transform):new DOMMatrix();resolve({overlay:!!overlay,opacity:overlay?Number(getComputedStyle(overlay).opacity):0,src:overlay?.src||'',liveOpacity:live?Number(getComputedStyle(live).opacity):1,acrylic:!!acrylic,acrylicOpacity:acrylicStyle?Number(acrylicStyle.opacity):null,acrylicBackdrop:acrylicStyle?.backdropFilter||'',acrylicClip:hostStyle?.clipPath||'',screenScale:[matrix.a,matrix.d],frameBackground:frameStyle?.backgroundImage||'',frameBackdrop:frameStyle?.backdropFilter||'',layerOpacity:layer?Number(getComputedStyle(layer).opacity):0,layerTransition:layer?.style.transition||''})})}));
  if(!projectReturnStart.overlay||projectReturnStart.src!==projectPreviewBefore.foregroundSrc||projectReturnStart.opacity<0||projectReturnStart.opacity>1||projectReturnStart.liveOpacity<0||projectReturnStart.liveOpacity>1.01||projectReturnStart.opacity+projectReturnStart.liveOpacity<.94||projectReturnStart.opacity+projectReturnStart.liveOpacity>1.08||!projectReturnStart.acrylic||projectReturnStart.acrylicOpacity<.99||!projectReturnStart.acrylicBackdrop.includes('blur(26px)')||!projectReturnStart.acrylicClip.startsWith('inset(')||projectReturnStart.screenScale.some((value)=>Math.abs(value-1)>.001)||projectReturnStart.frameBackground!=='none'||projectReturnStart.frameBackdrop!=='none'||projectReturnStart.layerOpacity<.99||projectReturnStart.layerTransition.includes('opacity'))throw new Error(`Project return did not begin with one full-strength unscaled acrylic lens: ${JSON.stringify({...projectReturnStart,src:!!projectReturnStart.src})}`);
  const projectReturnContinuity=await page.evaluate(()=>window.__nativeProjectReturnContinuity);
  if(projectReturnContinuity.frames<20||projectReturnContinuity.materialFrames<20||projectReturnContinuity.motionFrames<20||projectReturnContinuity.releaseFrames!==0||!projectReturnContinuity.motionHeldEveryFrame||projectReturnContinuity.firstOpacity<.99||projectReturnContinuity.lastOpacity<.99||projectReturnContinuity.intermediateFrames!==0||projectReturnContinuity.maxOpacityStep>.02||!projectReturnContinuity.timedEveryFrame||!projectReturnContinuity.screenSpaceEveryFrame||!projectReturnContinuity.frameNeutralEveryFrame||!keyframesMatch(projectReturnContinuity.opacityKeyframes,[[0,1],[1,1]])||!projectReturnContinuity.ownedEveryFrame||!projectReturnContinuity.realEveryFrame||projectReturnContinuity.minObjectCoverage<.94||projectReturnContinuity.maxObjectCoverage>1.08||projectReturnContinuity.wallpapers!==1||!projectReturnContinuity.framesSeen.includes('source'))throw new Error(`Project return did not retain full acrylic through the complete zoom-out: ${JSON.stringify(projectReturnContinuity)}`);
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
  const coldAcrylicHandoffs=transitTimings.filter((item)=>!item.sourceRetiredBeforeRelease||!item.acrylicStable||item.acrylicOwners<1||item.acrylicWarmFrames<4);
  if(coldAcrylicHandoffs.length)throw new Error(`Destinations were revealed before their final acrylic surfaces were warm: ${JSON.stringify(coldAcrylicHandoffs)}`);
  await page.evaluate(()=>window.crmWorkspaces.setActive('people'));
  await page.waitForFunction(()=>!!document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]'),null,{timeout:10000});
  await page.$eval('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]',(card)=>{const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20,button:2}))});
  await page.click('.tk-menu .tk-menu-item[data-act^="custom-"]');
  await page.waitForSelector('.crm-person-history-shell:not([hidden]) .crm-person-history',{timeout:10000});await sleep(250);
  const personHistory=await page.evaluate(()=>{const shell=document.querySelector('.crm-person-history-shell:not([hidden])');const panel=shell?.querySelector('.crm-person-history');const thread=panel?.querySelector('.crm-person-history-thread');const composer=panel?.querySelector('.crm-person-history-composer');const source=document.querySelector('[data-crm-theater="people"] .tk-zcard[data-id="ct_marta"]');const rect=panel?.getBoundingClientRect();const sourceRect=source?.getBoundingClientRect();const shellStyle=shell&&getComputedStyle(shell);const switcher=document.querySelector('.crm-module-switch');const backing=getComputedStyle(switcher,'::after');const secondary=[...switcher.querySelectorAll('.crm-secondary-control')].map((control)=>getComputedStyle(control));const events=[...(panel?.querySelectorAll('.crm-person-history-event')||[])];return{heading:panel?.querySelector('.crm-person-history-kicker')?.textContent.trim(),repeatedIdentity:!!panel?.querySelector('.crm-person-history-title'),seededSystem:events.some((event)=>/^seed(?:ed|ing)?\b/i.test(event.querySelector('.crm-person-history-event-content')?.textContent.trim()||'')),events:events.length,filters:panel?.querySelectorAll('[data-history-filter]').length||0,composerHidden:composer?.hidden===true,canonical:panel?.classList.contains('crm-menu-surface')||false,compact:!!rect&&rect.width<=370&&rect.height<=540,inBounds:!!rect&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,adjacent:!!rect&&!!sourceRect&&(Math.abs(rect.left-sourceRect.right)<=12||Math.abs(sourceRect.left-rect.right)<=12),transparent:!!shellStyle&&shellStyle.backgroundColor==='rgba(0, 0, 0, 0)'&&['none',''].includes(shellStyle.backdropFilter),noLegacyChrome:!panel?.querySelector('.crm-person-history-body,.crm-person-history-sidebar,.crm-person-history-summary,.crm-person-history-filters'),noHorizontalOverflow:!!panel&&!!thread&&panel.scrollWidth<=panel.clientWidth+1&&thread.scrollWidth<=thread.clientWidth+1,canonicalActions:[...(panel?.querySelectorAll('button')||[])].every((button)=>button.classList.contains('crm-menu-action')),uniformSecondary:backing.content==='none'&&secondary.length===3&&secondary.every((style)=>style.width==='46px'&&style.height==='46px'&&style.backgroundImage!=='none')}});
  if(personHistory.heading!=='Conversation history'||personHistory.repeatedIdentity||personHistory.seededSystem||personHistory.events<5||personHistory.filters!==0||!personHistory.composerHidden||!personHistory.canonical||!personHistory.compact||!personHistory.inBounds||!personHistory.adjacent||!personHistory.transparent||!personHistory.noLegacyChrome||!personHistory.noHorizontalOverflow||!personHistory.canonicalActions||!personHistory.uniformSecondary)throw new Error(`Person history native layout broken: ${JSON.stringify(personHistory)}`);
  await page.screenshot({path:path.join(out,'person-history.png')});
  await page.click('[data-person-history-close]');
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:15000});
  const duplicateHomeTileId='native-duplicate-people-tile';
  await page.evaluate((tileId)=>window.crmHome.createTile('people',{id:tileId,label:'People alternate view'}),duplicateHomeTileId);
  await page.waitForFunction((tileId)=>document.querySelectorAll('.crm-home-grid>.crm-home-bucket').length===5
    &&!!document.querySelector(`.crm-home-bucket[data-tile-id="${CSS.escape(tileId)}"]`),duplicateHomeTileId,{timeout:10000});
  await page.evaluate(()=>window.crmHome.waitForPreviewSync());
  const duplicateHomeSource=await page.$eval(`.crm-home-bucket[data-tile-id="${duplicateHomeTileId}"]`,(bucket)=>{
    const rect=bucket.getBoundingClientRect();
    bucket.click();
    return{tileId:bucket.dataset.tileId,module:bucket.dataset.viewportModule,rect:[rect.x,rect.y,rect.width,rect.height]};
  });
  await page.waitForFunction(()=>document.body.dataset.crmModule==='people'&&!window.crmDeskTransit?.isBusy?.(),null,{timeout:15000});
  const duplicateHomeRetained=await page.evaluate((tileId)=>{
    const surface=window.crmHomeCamera?.surface?.();
    const root=window.crmHomeCamera?.layers?.()[0];
    const routed=[...root.querySelectorAll('.crm-home-bucket[data-viewport-module="people"]')].map((bucket)=>({
      tileId:bucket.dataset.tileId,
      module:bucket.getAttribute('data-module'),
    }));
    return{
      retained:surface?.dataset.crmHomeRetained||'',
      retainedTile:surface?.dataset.crmHomeRetainedTile||'',
      returnTile:root?.dataset.returnTileId||'',
      routed,
      exact:routed.filter((bucket)=>bucket.module==='people').length===1
        &&routed.find((bucket)=>bucket.module==='people')?.tileId===tileId,
    };
  },duplicateHomeTileId);
  if(duplicateHomeSource.module!=='people'||duplicateHomeRetained.retained!=='people'
    ||duplicateHomeRetained.retainedTile!==duplicateHomeTileId
    ||duplicateHomeRetained.returnTile!==duplicateHomeTileId||!duplicateHomeRetained.exact){
    throw new Error(`Duplicate Home tile lost its physical return identity: ${JSON.stringify({duplicateHomeSource,duplicateHomeRetained})}`);
  }
  const duplicateHomeReturnStart=await page.$eval('.crm-home-control',(button)=>new Promise((resolve)=>{
    button.click();
    requestAnimationFrame(()=>{
      const root=window.crmHomeCamera?.layers?.()[0];
      const expander=document.querySelector('.crm-home-expander:not(.crm-home-warm)');
      resolve({expanderTile:expander?.dataset.tileId||'',returnTile:root?.dataset.returnTileId||''});
    });
  }));
  if(duplicateHomeReturnStart.expanderTile!==duplicateHomeTileId||duplicateHomeReturnStart.returnTile!==duplicateHomeTileId){
    throw new Error(`Duplicate Home return targeted another copy: ${JSON.stringify(duplicateHomeReturnStart)}`);
  }
  await page.waitForFunction((tileId)=>document.body.dataset.crmModule==='home'&&!window.crmDeskTransit?.isBusy?.()
    &&document.querySelectorAll('.crm-home-grid>.crm-home-bucket').length===5
    &&!!document.querySelector(`.crm-home-bucket[data-tile-id="${CSS.escape(tileId)}"]`),duplicateHomeTileId,{timeout:15000});
  const duplicateHomeReturned=await page.evaluate((tileId)=>{
    const buckets=[...document.querySelectorAll('.crm-home-bucket[data-viewport-module="people"]')];
    const tile=buckets.find((bucket)=>bucket.dataset.tileId===tileId);
    const rect=tile?.getBoundingClientRect();
    return{
      restoredRoutes:buckets.every((bucket)=>bucket.dataset.module==='people'),
      retained:window.crmHomeCamera?.surface?.()?.hasAttribute('data-crm-home-retained'),
      rect:rect&&[rect.x,rect.y,rect.width,rect.height],
    };
  },duplicateHomeTileId);
  if(!duplicateHomeReturned.restoredRoutes||duplicateHomeReturned.retained
    ||!duplicateHomeReturned.rect||duplicateHomeReturned.rect.some((value,index)=>Math.abs(value-duplicateHomeSource.rect[index])>1)){
    throw new Error(`Duplicate Home tile did not return to its unchanged source cell: ${JSON.stringify({duplicateHomeSource,duplicateHomeReturned})}`);
  }
  await page.evaluate((tileId)=>window.crmHome.removeTile(tileId),duplicateHomeTileId);
  await page.waitForFunction(readyHome,null,{timeout:15000});
  await page.evaluate(()=>window.crmHome.waitForPreviewSync());
  const duplicateHomeTile={id:duplicateHomeTileId,source:duplicateHomeSource,retained:duplicateHomeRetained,returnStart:duplicateHomeReturnStart,returned:duplicateHomeReturned};
  const settledFps=await frameRate(page); if(settledFps<45)throw new Error(`Settled Home FPS ${settledFps}`);
  await page.evaluate(()=>window.crmHome.waitForPreviewSync()); await sleep(100); const windowDetails=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter((win)=>!win.isDestroyed()).map((win)=>({id:win.id,url:win.webContents.getURL(),visible:win.isVisible(),loading:win.webContents.isLoading(),bounds:win.getBounds()}))); const windows=windowDetails.length; if(windows!==1)throw new Error(`${windows} BrowserWindows remain after preview synchronization: ${JSON.stringify(windowDetails)}`);
  const finalChrome=await page.evaluate(()=>{const drag=document.querySelector('.app-window-drag-region');return{drag:getComputedStyle(drag).webkitAppRegion,top:document.elementsFromPoint(520,20)[0]===drag,controls:document.querySelectorAll('.window-control-cluster .window-glass-control').length}});
  if(finalChrome.drag!=='drag'||!finalChrome.top||finalChrome.controls<3)throw new Error(`Chrome stale after camera cycles: ${JSON.stringify(finalChrome)}`);
  await page.click('.window-add-control');
  await page.waitForSelector('#context-add-menu:not([hidden]) .context-add-action');
  const homeAddMenu=await page.evaluate(()=>({
    heading:document.querySelector('#context-add-menu .context-add-menu-heading')?.textContent.trim(),
    ids:[...document.querySelectorAll('#context-add-menu [data-context-add-action]')].map((item)=>item.dataset.contextAddAction),
    labels:[...document.querySelectorAll('#context-add-menu [data-context-add-action]')].map((item)=>item.querySelector('.context-add-action-label')?.textContent.trim()),
  }));
  if(homeAddMenu.heading!=='Add to Home'||homeAddMenu.ids.length!==4||homeAddMenu.ids.some((id)=>!id.startsWith('home-tile-'))||homeAddMenu.labels.some((label)=>!/ tile$/i.test(label)))throw new Error(`Home add menu exposed an irrelevant object: ${JSON.stringify(homeAddMenu)}`);
  await page.keyboard.press('Escape');
  await page.click('.window-close-control');await sleep(250);
  const trayState=await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());return{hidden:!!win&&!win.isVisible(),minimized:!!win&&win.isMinimized(),live:!!win&&!win.isDestroyed()}});
  if(!trayState.hidden||trayState.minimized||!trayState.live)throw new Error(`Close control did not hide the live window to tray: ${JSON.stringify(trayState)}`);
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find((item)=>!item.isDestroyed());win?.show();win?.focus()});await sleep(250);
  await Promise.all([page.waitForEvent('load',{timeout:10000}),page.click('.window-refresh-control')]);
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dashboard-booting')&&window.crmWorkspaces,null,{timeout:30000});
  await page.evaluate(()=>window.crmWorkspaces.setActive('home'));await page.waitForFunction(readyHome,null,{timeout:30000});
  await page.screenshot({path:path.join(out,'02-home-after-cycles.png')});
  const evidence={startup,nativeRefreshCalibration,nativeHistory,nativeDrag,sameNodes,homeComposition,homeMotionAlpha,homeFps,settledFps,instantControls,domainProbe,reloadLeaseRecovery,selectedRooms:rooms.map((room)=>room.key),transitions,cadenceTransitions,duplicateHomeTile,handTicket:{ticket:handTicket,early:handTicketEarly,settled:handTicketSettled,motion:handTicketMotion},projectTiles:{before:{...projectPreviewBefore,exactSrc:!!projectPreviewBefore.exactSrc,foregroundSrc:!!projectPreviewBefore.foregroundSrc},diveStart:{...projectDiveStart,src:!!projectDiveStart.src},renderedBlur:projectRenderedBlur,diveContinuity:projectDiveContinuity,settled:{...projectDiveSettled,exactSrc:!!projectDiveSettled.exactSrc,pixelMae:projectSettledPixelMae},returnStart:{...projectReturnStart,src:!!projectReturnStart.src},returnContinuity:projectReturnContinuity,returned:projectReturn},transitTimings,personHistory,windows,finalChrome,windowControls:{refresh:true,addMenu:homeAddMenu,tray:trayState},errors};
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)); console.log('[electron-playwright]',evidence);
  if(errors.length)throw new Error(errors.join(' | '));
  // Product close events intentionally hide to the tray. End the automated
  // desktop process through Electron's explicit exit path so Playwright does
  // not wait forever on the newly-correct close interception.
  await app.evaluate(({app})=>{setImmediate(()=>app.exit(0));return true}).catch(()=>{});
  await Promise.race([app.close().catch(()=>{}),sleep(3000)]);
  process.exit(0);
}
main().catch((error)=>{console.error(error);process.exit(1)});
