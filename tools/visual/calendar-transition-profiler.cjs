'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default;
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CALENDAR_OUTPUT_DIR = path.resolve(
  __dirname,
  'electron-actual',
  'calendar-transition',
);
const CALENDAR_EVIDENCE_PATH = path.join(CALENDAR_OUTPUT_DIR, 'evidence.json');

async function measureIdleCadence(page, frames = 90) {
  return page.evaluate((wanted) => new Promise((resolve) => {
    const deltas = [];
    let previous = performance.now();
    const tick = (now) => {
      if (deltas.length) deltas.push(now - previous);
      else deltas.push(0);
      previous = now;
      if (deltas.length >= wanted + 1) {
        const measured = deltas.slice(2);
        resolve(measured.length * 1000 / measured.reduce((sum, value) => sum + value, 0));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
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
    description:'Deterministic scheduled chip used to verify Calendar transition anatomy.',
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

async function beginProbe(page, label) {
  await page.evaluate((probeLabel) => {
    const camera = window.fractalCalendarCamera;
    const surface = camera.surface();
    const probe = {
      label:probeLabel,
      previous:performance.now(),
      movingDeltas:[],
      acrylic:[],
      contentCoverage:[],
      missingStructures:0,
      transformedFilters:0,
      transformedFilterValues:[],
      childMutations:[],
      longTasks:[],
      movingStartedAt:null,
      slowFrames:[],
      settledMaterialFrames:[],
      settledTransitionLensFrames:[],
      motionFilterAudit:null,
      done:false,
    };
    const observer = new MutationObserver((records) => {
      if (!camera.isTransitioning()
        || (!surface.classList.contains('fc-camera-expanding')
          && !surface.classList.contains('fc-camera-contracting'))) return;
      records.forEach((record) => {
        if (record.type !== 'childList' || (!record.addedNodes.length && !record.removedNodes.length)) return;
        probe.childMutations.push({
          target:record.target.className || record.target.nodeName,
          added:record.addedNodes.length,
          removed:record.removedNodes.length,
        });
      });
    });
    observer.observe(surface, { childList:true, subtree:true });
    let longTaskObserver = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        if (!camera.isTransitioning()
          || (!surface.classList.contains('fc-camera-expanding')
            && !surface.classList.contains('fc-camera-contracting'))) return;
        list.getEntries().forEach((entry) => {
          probe.longTasks.push(Number(entry.duration.toFixed(2)));
        });
      });
      longTaskObserver.observe({ entryTypes:['longtask'] });
    } catch {}
    const expands = probeLabel.endsWith('-in');
    const cubic = (value, first, second) => {
      const inverse = 1 - value;
      return (3 * inverse * inverse * value * first)
        + (3 * inverse * value * value * second)
        + (value * value * value);
    };
    const exchangeEase = (progress) => {
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const candidate = (low + high) / 2;
        if (cubic(candidate, .37, .63) < progress) low = candidate;
        else high = candidate;
      }
      return cubic((low + high) / 2, 0, 1);
    };
    const animationProgress = (node, name) => {
      const animation = node?.getAnimations?.().find((candidate) => candidate.animationName === name);
      const progress = animation?.effect?.getComputedTiming?.().progress;
      return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
    };
    const exchangeOpacity = (node, role) => {
      const name = expands
        ? (role === 'source' ? 'fc-transition-preview-out' : 'fc-transition-live-in')
        : (role === 'source' ? 'fc-transition-preview-in' : 'fc-transition-live-out');
      const progress = animationProgress(node, name);
      if (progress == null) {
        return expands ? (role === 'source' ? 1 : 0) : (role === 'source' ? 0 : 1);
      }
      const exchanged = expands
        ? (progress <= .78 ? 0 : exchangeEase((progress - .78) / .22))
        : (progress >= .22 ? 1 : exchangeEase(progress / .22));
      return role === 'source' ? (expands ? 1 - exchanged : exchanged) : (expands ? exchanged : 1 - exchanged);
    };
    const tick = (now) => {
      const delta = now - probe.previous;
      probe.previous = now;
      const visibleMotion = camera.isTransitioning()
        && (surface.classList.contains('fc-camera-expanding')
          || surface.classList.contains('fc-camera-contracting'));
      if (visibleMotion) {
        if (probe.movingStartedAt == null) probe.movingStartedAt = now;
        if (!probe.motionFilterAudit) {
          const effectiveOpacity = (node) => {
            let opacity = 1;
            let cursor = node;
            while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
              const style = getComputedStyle(cursor);
              if (style.display === 'none' || style.visibility !== 'visible') return 0;
              opacity *= Number(style.opacity);
              if (cursor === surface) break;
              cursor = cursor.parentElement;
            }
            return opacity;
          };
          const owners = [...surface.querySelectorAll(
            ':scope > .fc-source-screen-acrylic,'
            + ':scope > .fc-level-material,'
            + ':scope > .fc-below-material-scene > .fc-below-material-piece',
          )].map((node) => {
            const style = getComputedStyle(node);
            const backdrop = style.webkitBackdropFilter || style.backdropFilter || 'none';
            const rect = node.getBoundingClientRect();
            const role = node.classList.contains('fc-source-screen-acrylic')
              ? 'transition-lens'
              : node.classList.contains('is-suspended-destination-material')
                ? 'suspended-destination'
                : node.classList.contains('fc-below-material-piece')
                  ? 'retained-root'
                  : 'level-material';
            return {
              node:node.className || node.nodeName,
              role,
              backdrop,
              opacity:effectiveOpacity(node),
              suspended:node.dataset.materialBackdropSuspended || 'false',
              ownership:node.dataset.materialOwnership || '',
              clip:style.clipPath || style.webkitClipPath || 'none',
              rect:[rect.left, rect.top, rect.width, rect.height]
                .map((value) => Number(value.toFixed(2))),
            };
          });
          const backdropOwners = owners.filter((owner) => owner.backdrop !== 'none');
          const transitionOwners = owners.filter((owner) => (
            owner.ownership === 'transition'
            || owner.node.includes('is-suspended-destination-material')
          ));
          probe.motionFilterAudit = {
            owners,
            allocatedBackdropOwnerCount:backdropOwners.length,
            activeBackdropOwnerCount:backdropOwners.filter((owner) => owner.opacity > .01).length,
            // Contracting root material is intentionally transparent during its
            // 22% reveal. A zero-opacity level/destination filter, however,
            // would be a redundant GPU allocation hidden behind the lens.
            redundantZeroOpacityBackdropOwners:backdropOwners.filter((owner) => (
              owner.opacity <= .01
              && owner.role !== 'retained-root'
            )),
            suspendedDestinationBackdropOwners:backdropOwners.filter((owner) => (
              owner.role === 'suspended-destination'
            )),
            activeTransitionOwnerCount:transitionOwners.filter((owner) => (
              owner.backdrop !== 'none' && owner.opacity > .99
            )).length,
          };
        }
        probe.movingDeltas.push(delta);
        if (delta > 15) probe.slowFrames.push({
          at:Number((now - probe.movingStartedAt).toFixed(1)),
          delta:Number(delta.toFixed(1)),
        });
        const moving = [...surface.querySelectorAll(':scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)')].at(-1) || null;
        const live = surface.querySelector(':scope > .fc-transition-portal')
          || moving?.querySelector(':scope > .fc-expander-live');
        const preview = moving?.querySelector(':scope > .fc-transition-preview');
        // The source bitmap owns the exact inherited bucket material as well
        // as its content, so its opacity is also the acrylic-release signal.
        if (!moving || !live || !preview) probe.missingStructures += 1;
        if (preview) probe.acrylic.push(exchangeOpacity(preview, 'source'));
        if (live && preview) {
          probe.contentCoverage.push(exchangeOpacity(live, 'destination') + exchangeOpacity(preview, 'source'));
        }
      } else if (!camera.isTransitioning() && probe.movingStartedAt != null) {
        const visibleLevelMaterials = [...surface.querySelectorAll(':scope > .fc-level-material')]
          .filter((node) => {
            const style = getComputedStyle(node);
            return style.visibility === 'visible' && Number(style.opacity) > .01;
          });
        probe.settledMaterialFrames.push(visibleLevelMaterials.length);
        probe.settledTransitionLensFrames.push(
          surface.querySelectorAll(':scope > .fc-source-screen-acrylic').length,
        );
      }
      if (!probe.done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__calendarTransitionProbe = {
      probe,
      stop:() => {
        probe.done = true;
        observer.disconnect();
        longTaskObserver?.disconnect?.();
      },
    };
  }, label);
}

async function finishProbe(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const holder = window.__calendarTransitionProbe;
    holder?.stop?.();
    const probe = holder?.probe;
    if (!probe) return null;
    const measured = probe.movingDeltas.slice(1);
    const sorted = [...measured].sort((a, b) => a - b);
    const acrylicValues = probe.acrylic.filter(Number.isFinite);
    const acrylicSteps = acrylicValues.slice(1).map((value, index) => value - acrylicValues[index]);
    const expands = probe.label.endsWith('-in');
    const cubic = (value, first, second) => {
      const inverse = 1 - value;
      return (3 * inverse * inverse * value * first)
        + (3 * inverse * value * value * second)
        + (value * value * value);
    };
    const exchangeEase = (progress) => {
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const candidate = (low + high) / 2;
        if (cubic(candidate, .37, .63) < progress) low = candidate;
        else high = candidate;
      }
      return cubic((low + high) / 2, 0, 1);
    };
    const idealAcrylic = Array.from({ length:47 }, (_unused, index) => {
      const progress = index / 46;
      const exchanged = expands
        ? (progress <= .78 ? 0 : exchangeEase((progress - .78) / .22))
        : (progress >= .22 ? 1 : exchangeEase(progress / .22));
      return expands ? 1 - exchanged : exchanged;
    });
    const idealSteps = idealAcrylic.slice(1).map((value, index) => value - idealAcrylic[index]);
    const total = measured.reduce((sum, value) => sum + value, 0);
    const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
    return {
      label:probe.label,
      frames:measured.length,
      fps:total ? measured.length * 1000 / total : 0,
      p95Ms:percentile(.95),
      maxMs:sorted.at(-1) || 0,
      over20Ms:measured.filter((value) => value > 20).length,
      acrylicStart:probe.acrylic[0] ?? null,
      acrylicEnd:probe.acrylic.at(-1) ?? null,
      acrylicRange:probe.acrylic.length ? Math.max(...probe.acrylic) - Math.min(...probe.acrylic) : 0,
      acrylicDistinct:new Set(acrylicValues.map((value) => value.toFixed(2))).size,
      acrylicMaxStep:idealSteps.length ? Math.max(...idealSteps.map(Math.abs)) : 0,
      acrylicObservedMaxStep:acrylicSteps.length ? Math.max(...acrylicSteps.map(Math.abs)) : 0,
      acrylicDirectionViolations:acrylicSteps.filter((step) => expands ? step > .025 : step < -.025).length,
      minimumContentCoverage:probe.contentCoverage.length ? Math.min(...probe.contentCoverage) : 0,
      missingStructures:probe.missingStructures,
      transformedFilters:probe.transformedFilters,
      transformedFilterValues:probe.transformedFilterValues,
      childMutations:probe.childMutations,
      longTasks:probe.longTasks,
      slowFrames:probe.slowFrames,
      settledMaterialFrames:probe.settledMaterialFrames,
      settledTransitionLensFrames:probe.settledTransitionLensFrames,
      motionFilterAudit:probe.motionFilterAudit,
    };
  });
}

async function profileMove(page, label, move, settled) {
  const filterAudit = await page.evaluate((probeLabel) => {
    const camera = window.fractalCalendarCamera;
    const surface = camera.surface();
    const level = camera.level();
    const expanding = probeLabel.endsWith('-in');
    const root = surface.querySelector(':scope > .fc-level');
    const active = [...surface.querySelectorAll(':scope > .fc-expander:not(.fc-warm)')];
    const moving = expanding
      ? surface.querySelector(':scope > .fc-expander.fc-warm')
      : active.at(-1);
    const below = expanding
      ? (level === 0 ? root : active.at(-1))
      : (level === 1 ? root : active.at(-2));
    const roots = [
      ['moving-expander', moving],
      ['destination', surface.querySelector(':scope > .fc-transition-portal')],
      ['below-layer', below],
      ...[...surface.querySelectorAll(':scope > .fc-below-snapshot')]
        .map((node, index) => [`below-snapshot-${index}`, node]),
      ...[...surface.querySelectorAll(':scope > .fc-source-screen-acrylic,:scope > .fc-level-material,:scope > .fc-below-material-scene')]
        .map((node, index) => [`fixed-material-${index}`, node]),
    ];
    const violations = [];
    const fixedOwners = [];
    surface.classList.add('fc-camera-moving');
    below?.classList?.add('fc-camera-below');
    try {
      roots.forEach(([rootName, candidate]) => {
        if (!candidate) return;
        [candidate, ...candidate.querySelectorAll('*')].forEach((node) => {
          const style = getComputedStyle(node);
          const values = [style.filter, style.backdropFilter, style.webkitBackdropFilter]
            .filter((value) => value && value !== 'none');
          if (!values.length) return;
          const fixedMaterial = node.matches?.(
            '.fc-source-screen-acrylic,.fc-level-material,.fc-below-material-piece',
          );
          const containment = [];
          let cursor = node;
          while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
            const cursorStyle = getComputedStyle(cursor);
            const reasons = [];
            if (cursorStyle.transform && cursorStyle.transform !== 'none') {
              reasons.push(`transform:${cursorStyle.transform}`);
            }
            if (cursorStyle.perspective && cursorStyle.perspective !== 'none') {
              reasons.push(`perspective:${cursorStyle.perspective}`);
            }
            const willChange = String(cursorStyle.willChange || '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
            if (willChange.some((value) => ['transform', 'perspective', 'filter'].includes(value))) {
              reasons.push(`will-change:${cursorStyle.willChange}`);
            }
            if (cursor !== node) {
              const ancestorFilters = [
                cursorStyle.filter,
                cursorStyle.backdropFilter,
                cursorStyle.webkitBackdropFilter,
              ].filter((value) => value && value !== 'none');
              if (ancestorFilters.length) reasons.push(`ancestor-filter:${ancestorFilters.join('|')}`);
            }
            if (reasons.length) {
              containment.push({
                node:cursor.className || cursor.nodeName,
                reasons,
              });
            }
            if (cursor === surface) break;
            cursor = cursor.parentElement;
          }
          if (fixedMaterial && !containment.length) {
            const rect = node.getBoundingClientRect();
            fixedOwners.push({
              root:rootName,
              node:node.className || node.nodeName,
              values,
              materialSource:node.dataset.materialSourceClass || '',
              materialOwnerCount:Number(node.dataset.materialOwnerCount || 1),
              materialRole:node.dataset.materialRole || '',
              materialBounded:node.dataset.materialBounded || '',
              rect:[rect.left, rect.top, rect.width, rect.height]
                .map((value) => Number(value.toFixed(2))),
              rootMaterialScene:!!node.closest?.('.fc-below-material-scene'),
            });
          } else if (violations.length < 24) {
            violations.push({
              root:rootName,
              node:node.className || node.nodeName,
              values,
              containment,
            });
          }
        });
      });
    } finally {
      below?.classList?.remove('fc-camera-below');
      surface.classList.remove('fc-camera-moving');
    }
    return { violations, fixedOwners };
  }, label);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await beginProbe(page, label);
  await move();
  await settled();
  const probe = await finishProbe(page);
  probe.descendantFilterViolations = filterAudit.violations;
  probe.fixedMaterialOwners = filterAudit.fixedOwners;
  probe.rootFilterLayerCount = filterAudit.fixedOwners
    .filter((owner) => owner.rootMaterialScene).length;
  probe.rootMaterialOwnerCount = filterAudit.fixedOwners
    .filter((owner) => owner.rootMaterialScene)
    .reduce((sum, owner) => sum + owner.materialOwnerCount, 0);
  return probe;
}

async function beginCadenceProbe(page, label) {
  await page.evaluate((probeLabel) => {
    const camera = window.fractalCalendarCamera;
    const surface = camera.surface();
    const probe = {
      label:probeLabel,
      deltas:[],
      previous:null,
      started:false,
      done:false,
    };
    const tick = (now) => {
      // onTransformStart adds exactly one direction class in the same task
      // that triggers the transform. Sampling that class excludes the two
      // deliberately covered precomposition frames while measuring every
      // frame of the visible morph itself.
      const moving = surface.classList.contains('fc-camera-expanding')
        || surface.classList.contains('fc-camera-contracting');
      if (moving) {
        if (probe.previous != null) probe.deltas.push(now - probe.previous);
        probe.previous = now;
        probe.started = true;
      } else if (probe.started) {
        probe.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    window.__calendarCadenceProbe = probe;
    requestAnimationFrame(tick);
  }, label);
}

async function finishCadenceProbe(page) {
  await page.waitForFunction(() => window.__calendarCadenceProbe?.done === true, null, { timeout:5000 });
  return page.evaluate(() => {
    const probe = window.__calendarCadenceProbe;
    const measured = probe?.deltas || [];
    const sorted = [...measured].sort((a, b) => a - b);
    const total = measured.reduce((sum, value) => sum + value, 0);
    const percentile = (fraction) => (
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0
    );
    const medianMs = percentile(.5);
    return {
      label:probe?.label || '',
      frames:measured.length,
      fps:total ? measured.length * 1000 / total : 0,
      cadenceHz:medianMs ? 1000 / medianMs : 0,
      medianMs,
      p95Ms:percentile(.95),
      maxMs:sorted.at(-1) || 0,
      over15Ms:measured.filter((value) => value > 15).length,
      deltas:measured.map((value) => Number(value.toFixed(3))),
    };
  });
}

async function profileCadenceMove(page, label, move, settled) {
  await beginCadenceProbe(page, label);
  await move();
  await settled();
  return finishCadenceProbe(page);
}

async function waitForWarmTextures(page, kind, belowKeyPrefix) {
  try {
    await page.waitForFunction(({ warmKind, belowPrefix }) => {
      const warm = document.querySelector(`.fc-warm[data-kind="${warmKind}"]`);
      const preview = warm?.querySelector(':scope > .fc-transition-preview');
      const portal = document.querySelector('.fc-surface > .fc-transition-portal');
      const below = [...document.querySelectorAll('.fc-below-snapshot')]
        .find((node) => node.dataset.snapshotKey?.startsWith(belowPrefix));
      const stripTexture = document.querySelector(
        '.fc-surface > .fc-year-strip-texture[data-strip-capture-mode="compositor"]',
      );
      const stripImage = stripTexture?.querySelector(':scope > .fc-year-strip-texture-image');
      const sourceMaterial = document.querySelector('.fc-surface > .fc-source-screen-acrylic');
      const destinationMaterial = [...document.querySelectorAll('.fc-surface > .fc-level-material')]
        .find((node) => node.dataset.materialOwner === warmKind);
      const belowMaterial = [...document.querySelectorAll(
        '.fc-surface > .fc-level-material,.fc-surface > .fc-below-material-scene',
      )].find((node) => (
        node.dataset.materialBelowKey?.startsWith(belowPrefix)
        || node.dataset.materialKey?.startsWith(belowPrefix)
      ));
      const requiresStripTexture = belowPrefix.startsWith('year:');
      const transitionTextures = [
        preview,
        portal,
        below,
        ...(requiresStripTexture ? [stripTexture] : []),
      ];
      const expectedTextureCount = requiresStripTexture ? 4 : 3;
      const maxAlpha = (image) => {
        const raster = image?.matches?.('img')
          ? image
          : image?.querySelector?.(':scope > .fc-year-strip-texture-image');
        if (!raster?.complete || !raster.naturalWidth) return 0;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 200;
        const context = canvas.getContext('2d', { alpha:true, willReadFrequently:true });
        context.drawImage(raster, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let maximum = 0;
        for (let index = 3; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index]);
        return maximum;
      };
      return !!warm
        && transitionTextures.length === expectedTextureCount
        && transitionTextures.every((node) => !!node)
        && !!preview?.complete && preview.naturalWidth > 0 && preview.dataset.compositeWarm === 'true'
        && !!portal?.complete && portal.naturalWidth > 0 && portal.dataset.compositeWarm === 'true'
        && !!below?.complete && below.naturalWidth > 0 && below.dataset.compositeWarm === 'true'
        && below.dataset.snapshotHiddenCount === '1'
        && (!belowPrefix.startsWith('year:')
          || (below.dataset.snapshotControlPseudoCount === '2'
            && below.dataset.snapshotYearStripHiddenCount === '1'
            && stripImage?.complete
            && stripImage.naturalWidth > 0
            && stripTexture.dataset.snapshotReady === 'true'
            && stripTexture.dataset.snapshotFormat === 'png'
            && stripTexture.dataset.snapshotForcedOpaque === 'true'
            && stripTexture.dataset.compositeWarm === 'true'
            && !!stripTexture.dataset.stripCaptureRect
            && !!stripTexture.dataset.stripPixelSize))
        && sourceMaterial?.dataset.compositeWarm === 'true'
        && destinationMaterial?.dataset.compositeWarm === 'true'
        && belowMaterial?.dataset.compositeWarm === 'true'
        && (belowMaterial.classList.contains('fc-below-material-scene')
          ? (() => {
            const pieces = [...belowMaterial.querySelectorAll(':scope > .fc-below-material-piece')];
            const frost = pieces.find((node) => node.dataset.materialSourceClass === 'fc-frost');
            const baseUnion = pieces.find((node) => node.dataset.materialRole === 'base');
            return Number(belowMaterial.dataset.materialOwnerCount || 0) === 1
              && pieces.length === 1
              && !baseUnion
              && Number(frost?.dataset.materialOwnerCount || 0) === 1
              && frost?.dataset.materialBackdrop === 'blur(26px) saturate(1.4)';
          })()
          : belowMaterial.dataset.materialBackdrop !== 'none')
        && destinationMaterial.dataset.materialBackdrop !== 'none'
        && transitionTextures.every((node) => (
          node.dataset.snapshotFormat === 'png'
          && node.dataset.snapshotForcedOpaque === 'true'
          && maxAlpha(node) >= 128
        ));
    }, { warmKind:kind, belowPrefix:belowKeyPrefix }, { timeout:10000 });
  } catch (error) {
    const diagnostics = await page.evaluate(({ warmKind, belowPrefix }) => {
      const warm = document.querySelector(`.fc-warm[data-kind="${warmKind}"]`);
      const preview = warm?.querySelector(':scope > .fc-transition-preview');
      const portal = document.querySelector('.fc-surface > .fc-transition-portal');
      const below = [...document.querySelectorAll('.fc-below-snapshot')]
        .find((node) => node.dataset.snapshotKey?.startsWith(belowPrefix));
      const stripTexture = document.querySelector('.fc-surface > .fc-year-strip-texture');
      const sourceMaterial = document.querySelector('.fc-surface > .fc-source-screen-acrylic');
      const destinationMaterial = [...document.querySelectorAll('.fc-surface > .fc-level-material')]
        .find((node) => node.dataset.materialOwner === warmKind);
      const belowMaterial = [...document.querySelectorAll(
        '.fc-surface > .fc-level-material,.fc-surface > .fc-below-material-scene',
      )].find((node) => (
        node.dataset.materialBelowKey?.startsWith(belowPrefix)
        || node.dataset.materialKey?.startsWith(belowPrefix)
      ));
      const imageState = (image) => {
        const raster = image?.matches?.('img')
          ? image
          : image?.querySelector?.(':scope > .fc-year-strip-texture-image');
        let maximum = 0;
        try {
          if (raster?.complete && raster.naturalWidth) {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 200;
            const context = canvas.getContext('2d', { alpha:true, willReadFrequently:true });
            context.drawImage(raster, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 3; index < pixels.length; index += 4) {
              maximum = Math.max(maximum, pixels[index]);
            }
          }
        } catch {}
        return image ? {
          complete:raster?.complete,
          naturalWidth:raster?.naturalWidth,
          ready:image.dataset.snapshotReady || '',
          format:image.dataset.snapshotFormat || '',
          forcedOpaque:image.dataset.snapshotForcedOpaque || '',
          hiddenCount:image.dataset.snapshotHiddenCount || '',
          controlPseudoCount:image.dataset.snapshotControlPseudoCount || '',
          yearStripHiddenCount:image.dataset.snapshotYearStripHiddenCount || '',
          stripCaptureMode:image.dataset.stripCaptureMode || '',
          stripCaptureRect:image.dataset.stripCaptureRect || '',
          stripPixelSize:image.dataset.stripPixelSize || '',
          compositeWarm:image.dataset.compositeWarm || '',
          maxAlpha:maximum,
        } : null;
      };
      const materialState = (material) => {
        if (!material) return null;
        const style = getComputedStyle(material);
        return {
          className:material.className,
          compositeWarm:material.dataset.compositeWarm || '',
          backdrop:material.dataset.materialBackdrop
            || style.webkitBackdropFilter || style.backdropFilter || 'none',
          pieceCount:Number(material.dataset.materialPieceCount || 0),
          ownerCount:Number(material.dataset.materialOwnerCount || 0),
          pieces:[...material.querySelectorAll(':scope > .fc-below-material-piece')].map((node) => ({
            source:node.dataset.materialSourceClass || '',
            ownerCount:Number(node.dataset.materialOwnerCount || 1),
            backdrop:node.dataset.materialBackdrop || '',
          })),
          opacity:style.opacity,
        };
      };
      return {
        warm:!!warm,
        warmKinds:[...document.querySelectorAll('.fc-warm')].map((node) => node.dataset.kind || ''),
        preview:imageState(preview),
        portal:imageState(portal),
        below:imageState(below),
        stripTexture:imageState(stripTexture),
        belowKeys:[...document.querySelectorAll('.fc-below-snapshot')]
          .map((node) => node.dataset.snapshotKey || ''),
        sourceMaterial:materialState(sourceMaterial),
        destinationMaterial:materialState(destinationMaterial),
        belowMaterial:materialState(belowMaterial),
      };
    }, { warmKind:kind, belowPrefix:belowKeyPrefix }).catch(() => ({ pageClosed:true }));
    throw new Error(
      `${error.message}\nWarm texture diagnostics: ${JSON.stringify(diagnostics, null, 2)}`,
      { cause:error },
    );
  }
}

async function readFadeKeyframes(page) {
  return page.evaluate(() => {
    const wanted = new Set([
      'fc-transition-preview-out',
      'fc-transition-live-in',
      'fc-transition-preview-in',
      'fc-transition-live-out',
      'fc-below-release',
      'fc-below-return',
    ]);
    const found = {};
    const visit = (rules) => {
      [...(rules || [])].forEach((rule) => {
        if (rule.type === CSSRule.KEYFRAMES_RULE && wanted.has(rule.name)) {
          found[rule.name] = [...rule.cssRules].flatMap((frame) => (
            frame.keyText.split(',').map((key) => [
              Number((parseFloat(key) / 100).toFixed(2)),
              Number(frame.style.opacity),
            ])
          ));
        } else if (rule.cssRules) {
          visit(rule.cssRules);
        }
      });
    };
    [...document.styleSheets].forEach((sheet) => {
      try { visit(sheet.cssRules); } catch {}
    });
    return found;
  });
}

function compareScreenshots(firstPath, secondPath) {
  const first = PNG.sync.read(fs.readFileSync(firstPath));
  const second = PNG.sync.read(fs.readFileSync(secondPath));
  if (first.width !== second.width || first.height !== second.height) {
    return { changedPixels:first.width * first.height, ratio:1 };
  }
  const changedPixels = pixelmatch(
    first.data,
    second.data,
    null,
    first.width,
    first.height,
    { threshold:.1, includeAA:false },
  );
  return {
    changedPixels,
    ratio:changedPixels / (first.width * first.height),
  };
}

function compareMaterialBands(firstPath, secondPath) {
  const first = PNG.sync.read(fs.readFileSync(firstPath));
  const second = PNG.sync.read(fs.readFileSync(secondPath));
  if (first.width !== second.width || first.height !== second.height) {
    return { changedPixels:first.width * first.height, sampledPixels:first.width * first.height, ratio:1, meanChannelDelta:255 };
  }
  const bands = [
    { left:20, right:46, top:100, bottom:first.height - 90 },
    { left:first.width - 46, right:first.width - 20, top:100, bottom:first.height - 90 },
  ];
  let changedPixels = 0;
  let sampledPixels = 0;
  let channelDelta = 0;
  bands.forEach((band) => {
    for (let y = Math.max(0, band.top); y < Math.min(first.height, band.bottom); y += 1) {
      for (let x = Math.max(0, band.left); x < Math.min(first.width, band.right); x += 1) {
        const offset = (y * first.width + x) * 4;
        const delta = Math.abs(first.data[offset] - second.data[offset])
          + Math.abs(first.data[offset + 1] - second.data[offset + 1])
          + Math.abs(first.data[offset + 2] - second.data[offset + 2]);
        channelDelta += delta;
        sampledPixels += 1;
        if (delta > 18) changedPixels += 1;
      }
    }
  });
  return {
    changedPixels,
    sampledPixels,
    ratio:sampledPixels ? changedPixels / sampledPixels : 1,
    meanChannelDelta:sampledPixels ? channelDelta / (sampledPixels * 3) : 255,
  };
}

function compareScreenshotRegion(firstPath, secondPath, region, viewport) {
  const first = PNG.sync.read(fs.readFileSync(firstPath));
  const second = PNG.sync.read(fs.readFileSync(secondPath));
  const scaleX = first.width / viewport.width;
  const scaleY = first.height / viewport.height;
  const left = Math.max(0, Math.floor(region.left * scaleX));
  const right = Math.min(first.width, Math.ceil(region.right * scaleX));
  const top = Math.max(0, Math.floor(region.top * scaleY));
  const bottom = Math.min(first.height, Math.ceil(region.bottom * scaleY));
  let changedPixels = 0;
  let sampledPixels = 0;
  let channelDelta = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * first.width + x) * 4;
      const delta = Math.abs(first.data[offset] - second.data[offset])
        + Math.abs(first.data[offset + 1] - second.data[offset + 1])
        + Math.abs(first.data[offset + 2] - second.data[offset + 2]);
      sampledPixels += 1;
      channelDelta += delta;
      if (delta > 18) changedPixels += 1;
    }
  }
  return {
    changedPixels,
    sampledPixels,
    ratio:sampledPixels ? changedPixels / sampledPixels : 1,
    meanChannelDelta:sampledPixels ? channelDelta / (sampledPixels * 3) : 255,
  };
}

async function captureTransitionVisuals(page) {
  const outputDir = CALENDAR_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive:true });
  const paths = {};
  const midpointStructures = {};
  const exchangeStructures = {};
  const phaseHolds = {};
  const shot = async (name) => {
    const target = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path:target });
    paths[name] = target;
  };
  const neutralFrame = async () => {
    await page.mouse.move(2, 2);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const waitMoving = (direction) => page.waitForFunction((value) => (
    window.fractalCalendarCamera.surface().classList.contains(`fc-camera-${value}`)
  ), direction);
  const waitLevel = (level) => page.waitForFunction((value) => (
    window.fractalCalendar.level() === value && !window.fractalCalendarCamera.isTransitioning()
  ), level);
  const inspectMidpoint = async (name) => {
    midpointStructures[name] = await page.evaluate(() => {
      const surface = window.fractalCalendarCamera.surface();
      const visible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility === 'visible' && Number(style.opacity) > .01
          && rect.width > 1 && rect.height > 1;
      };
      const visiblePreviews = [...surface.querySelectorAll('.fc-transition-preview')].filter(visible);
      const moving = [...surface.querySelectorAll(
        ':scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)',
      )].at(-1);
      const preview = moving?.querySelector(':scope > .fc-transition-preview');
      const portal = surface.querySelector(':scope > .fc-transition-portal');
      const target = surface.querySelector(':scope > .fc-camera-below .fc-camera-target');
      const activeSnapshot = surface.querySelector(':scope > .fc-below-snapshot.is-active');
      const belowMaterial = surface.querySelector(
        ':scope > .fc-level-material.is-below-material,:scope > .fc-below-material-scene.is-below-material',
      );
      const materialStyle = belowMaterial ? getComputedStyle(belowMaterial) : null;
      const materialRect = belowMaterial?.getBoundingClientRect();
      const strip = surface.querySelector(':scope > .fc-year-strip.fc-year-strip-portal');
      const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture.is-active');
      const stripStyle = strip ? getComputedStyle(strip) : null;
      const stripTextureStyle = stripTexture ? getComputedStyle(stripTexture) : null;
      const stripTextureRect = stripTexture?.getBoundingClientRect();
      const stripShadow = stripTexture?.querySelector(':scope > .fc-year-strip-texture-shadow');
      const stripShadowRect = stripShadow?.getBoundingClientRect();
      const stripShadowStyle = stripShadow ? getComputedStyle(stripShadow) : null;
      const stripControls = [...(strip?.querySelectorAll('.window-glass-control') || [])];
      const capturedStripRect = String(stripTexture?.dataset.stripRect || '')
        .split(',').map(Number);
      const keyFor = (node) => (
        node?.dataset?.month
          ? `month:${node.dataset.month}`
          : `day:${node?.dataset?.date || ''}`
      );
      return {
        visibleSourcePreviews:visiblePreviews.length,
        targetOpacity:target ? Number(getComputedStyle(target).opacity) : null,
        activeBelowSnapshots:surface.querySelectorAll(':scope > .fc-below-snapshot.is-active').length,
        belowSnapshotHiddenCount:Number(activeSnapshot?.dataset.snapshotHiddenCount || 0),
        belowSnapshotYearStripHiddenCount:Number(
          activeSnapshot?.dataset.snapshotYearStripHiddenCount || 0,
        ),
        previewKey:preview?.dataset.transitionSource || '',
        portalKey:portal?.dataset.transitionSource || '',
        snapshotKey:activeSnapshot?.dataset.snapshotSelectedKey || '',
        targetKey:keyFor(target),
        keyIdentity:!!preview
          && preview.dataset.transitionSource === portal?.dataset.transitionSource
          && preview.dataset.transitionSource === activeSnapshot?.dataset.snapshotSelectedKey
          && preview.dataset.transitionSource === keyFor(target),
        belowMaterialOpacity:materialStyle ? Number(materialStyle.opacity) : null,
        belowMaterialBackdrop:belowMaterial?.classList.contains('fc-level-material')
          ? (materialStyle?.webkitBackdropFilter || materialStyle?.backdropFilter || 'none')
          : [...(belowMaterial?.querySelectorAll('.fc-below-material-piece') || [])]
            .map((node) => getComputedStyle(node).webkitBackdropFilter || getComputedStyle(node).backdropFilter)
            .filter((value) => value && value !== 'none'),
        belowMaterialRect:materialRect
          ? [materialRect.x, materialRect.y, materialRect.width, materialRect.height].map((value) => Number(value.toFixed(2)))
          : null,
        stripPortalCount:surface.querySelectorAll(
          ':scope > .fc-year-strip.fc-year-strip-portal',
        ).length,
        stripTextureCount:surface.querySelectorAll(
          ':scope > .fc-year-strip-texture.is-active',
        ).length,
        yearStripCount:document.querySelectorAll('.fc-year-strip').length,
        stripIdentity:!!strip
          && strip === window.__calendarYearStripSource
          && stripTexture?.dataset.stripSourceIdentity === strip.dataset.stripIdentity,
        stripGeometryStable:strip?.dataset.portalGeometryStable === 'true',
        stripOpacity:stripTextureStyle ? Number(stripTextureStyle.opacity) : null,
        stripRect:capturedStripRect.length === 4 && capturedStripRect.every(Number.isFinite)
          ? capturedStripRect.map((value) => Number(value.toFixed(2)))
          : null,
        stripCaptureRect:stripTextureRect
          ? [stripTextureRect.x, stripTextureRect.y, stripTextureRect.width, stripTextureRect.height]
            .map((value) => Number(value.toFixed(2)))
          : null,
        stripCaptureBounded:!!stripTextureRect
          && capturedStripRect.length === 4
          && capturedStripRect.every(Number.isFinite)
          && stripTextureRect.width - capturedStripRect[2] >= -.1
          && stripTextureRect.width - capturedStripRect[2] <= 48.1
          && stripTextureRect.height - capturedStripRect[3] >= -.1
          && stripTextureRect.height - capturedStripRect[3] <= 48.1
          && capturedStripRect[0] - stripTextureRect.left >= -.1
          && capturedStripRect[0] - stripTextureRect.left <= 24.1
          && capturedStripRect[1] - stripTextureRect.top >= -.1
          && capturedStripRect[1] - stripTextureRect.top <= 24.1
          && stripTextureRect.right - (capturedStripRect[0] + capturedStripRect[2]) >= -.1
          && stripTextureRect.right - (capturedStripRect[0] + capturedStripRect[2]) <= 24.1
          && stripTextureRect.bottom - (capturedStripRect[1] + capturedStripRect[3]) >= -.1
          && stripTextureRect.bottom - (capturedStripRect[1] + capturedStripRect[3]) <= 24.1,
        stripShadowExact:!!stripShadowRect
          && capturedStripRect.length === 4
          && capturedStripRect.every((value, index) => (
            Number.isFinite(value)
            && Math.abs(value - [
              stripShadowRect.x, stripShadowRect.y,
              stripShadowRect.width, stripShadowRect.height,
            ][index]) <= .1
          ))
          && stripShadow?.dataset.stripOuterShadow === stripShadowStyle?.boxShadow,
        stripCompositorTexture:stripTexture?.dataset.snapshotReady === 'true'
          && stripTexture.dataset.snapshotFormat === 'png'
          && stripTexture.dataset.snapshotForcedOpaque === 'true'
          && stripTexture.dataset.compositeWarm === 'true'
          && stripTexture.dataset.stripCaptureMode === 'compositor'
          && !!stripTexture.dataset.stripCaptureRect
          && !!stripTexture.dataset.stripPixelSize,
        stripNativePaintSuspended:stripStyle?.visibility === 'hidden'
          && (stripStyle.webkitBackdropFilter || stripStyle.backdropFilter) === 'none'
          && stripControls.every((control) => {
            const style = getComputedStyle(control);
            return style.visibility === 'hidden'
              && (style.webkitBackdropFilter || style.backdropFilter) === 'none';
          }),
        stripInteractionLocked:stripStyle?.pointerEvents === 'none'
          && stripTextureStyle?.pointerEvents === 'none'
          && stripControls.every((control) => getComputedStyle(control).pointerEvents === 'none'),
      };
    });
  };
  const armPhaseHold = (name, phase) => page.evaluate(({ probeName, probePhase }) => {
    delete window.__crmCalendarTransitionGate;
    delete window.__crmCalendarTransitionResumeGate;
    delete window.__crmCalendarTransitionPhaseError;
    window.__crmCalendarTransitionProbe = {
      name:probeName,
      phase:probePhase,
      hold(gatePhase, detail) {
        return new Promise((resolve) => {
          window.__crmCalendarTransitionGate = { phase:gatePhase, detail, resolve };
        });
      },
      resumed(gatePhase, detail) {
        window.__crmCalendarTransitionResumeGate = { phase:gatePhase, detail };
      },
      failed(gatePhase, detail) {
        window.__crmCalendarTransitionPhaseError = { phase:gatePhase, detail };
      },
    };
  }, { probeName:name, probePhase:phase });
  const waitPhaseHold = async (name, direction) => {
    await page.waitForFunction(({ probeName, probeDirection }) => (
      (window.__crmCalendarTransitionGate?.phase === probeName
        && window.__crmCalendarTransitionGate?.detail?.direction === probeDirection)
      || window.__crmCalendarTransitionPhaseError?.phase === probeName
    ), { probeName:name, probeDirection:direction }, { timeout:3000 });
    const phaseError = await page.evaluate(() => window.__crmCalendarTransitionPhaseError
      ? { ...window.__crmCalendarTransitionPhaseError }
      : null);
    if (phaseError) {
      throw new Error(`Calendar phase hold did not commit: ${JSON.stringify(phaseError)}`);
    }
    const detail = await page.evaluate(() => ({ ...window.__crmCalendarTransitionGate.detail }));
    phaseHolds[name] = detail;
    return detail;
  };
  const releasePhaseHold = async (name) => {
    await page.evaluate(() => {
      window.__crmCalendarTransitionGate?.resolve?.();
    });
    await page.waitForFunction((probeName) => (
      window.__crmCalendarTransitionResumeGate?.phase === probeName
    ), name, { timeout:5000 });
    const resumed = await page.evaluate(() => ({
      ...window.__crmCalendarTransitionResumeGate.detail,
    }));
    phaseHolds[name].resumed = resumed;
    await page.evaluate(() => {
      delete window.__crmCalendarTransitionGate;
      delete window.__crmCalendarTransitionResumeGate;
      delete window.__crmCalendarTransitionPhaseError;
      delete window.__crmCalendarTransitionProbe;
    });
  };
  const inspectExchange = async (name) => {
    exchangeStructures[name] = await page.evaluate(() => {
      const surface = window.fractalCalendarCamera.surface();
      const moving = [...surface.querySelectorAll(
        ':scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)',
      )].at(-1);
      const preview = moving?.querySelector(':scope > .fc-transition-preview');
      const portal = surface.querySelector(':scope > .fc-transition-portal');
      const snapshot = surface.querySelector(':scope > .fc-below-snapshot.is-active');
      const target = surface.querySelector(':scope > .fc-camera-below .fc-camera-target');
      const strip = surface.querySelector(':scope > .fc-year-strip.fc-year-strip-portal');
      const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture.is-active');
      const stripStyle = strip ? getComputedStyle(strip) : null;
      const stripTextureStyle = stripTexture ? getComputedStyle(stripTexture) : null;
      const stripControls = [...(strip?.querySelectorAll('.window-glass-control') || [])];
      const keyFor = (node) => (
        node?.dataset?.month
          ? `month:${node.dataset.month}`
          : `day:${node?.dataset?.date || ''}`
      );
      const animation = preview?.getAnimations?.().find((candidate) => (
        candidate.animationName === 'fc-transition-preview-out'
        || candidate.animationName === 'fc-transition-preview-in'
      ));
      const progress = animation?.effect?.getComputedTiming?.().progress;
      const sourceOpacity = Number(getComputedStyle(preview).opacity);
      const destinationOpacity = Number(getComputedStyle(portal).opacity);
      const sourceChip = target?.querySelector?.('.fc-chip');
      const destinationChip = moving?.querySelector?.(':scope > .fc-expander-live .fc-chip');
      const previewRect = preview?.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      const sourceChipRect = sourceChip?.getBoundingClientRect();
      const destinationChipRect = destinationChip?.getBoundingClientRect();
      const mappedSourceChip = (
        previewRect && targetRect && sourceChipRect && targetRect.width > 0 && targetRect.height > 0
      ) ? {
          left:previewRect.left
            + ((sourceChipRect.left - targetRect.left) / targetRect.width) * previewRect.width,
          top:previewRect.top
            + ((sourceChipRect.top - targetRect.top) / targetRect.height) * previewRect.height,
          width:(sourceChipRect.width / targetRect.width) * previewRect.width,
          height:(sourceChipRect.height / targetRect.height) * previewRect.height,
        } : null;
      const overlap = (left, right) => {
        if (!left || !right) return 0;
        const intersectionWidth = Math.max(
          0,
          Math.min(left.left + left.width, right.left + right.width)
            - Math.max(left.left, right.left),
        );
        const intersectionHeight = Math.max(
          0,
          Math.min(left.top + left.height, right.top + right.height)
            - Math.max(left.top, right.top),
        );
        const intersection = intersectionWidth * intersectionHeight;
        const smaller = Math.min(left.width * left.height, right.width * right.height);
        return smaller ? intersection / smaller : 0;
      };
      const destinationRect = destinationChipRect ? {
        left:destinationChipRect.left,
        top:destinationChipRect.top,
        width:destinationChipRect.width,
        height:destinationChipRect.height,
      } : null;
      const previewKey = preview?.dataset.transitionSource || '';
      const expanding = surface.classList.contains('fc-camera-expanding');
      return {
        progress:Number.isFinite(progress) ? progress : null,
        exchangePhase:Number.isFinite(progress) ? (expanding ? progress : 1 - progress) : null,
        sourceOpacity,
        destinationOpacity,
        opacitySum:sourceOpacity + destinationOpacity,
        previewKey,
        portalKey:portal?.dataset.transitionSource || '',
        snapshotKey:snapshot?.dataset.snapshotSelectedKey || '',
        targetKey:keyFor(target),
        keyIdentity:!!previewKey
          && previewKey === portal?.dataset.transitionSource
          && previewKey === snapshot?.dataset.snapshotSelectedKey
          && previewKey === keyFor(target),
        snapshotHiddenCount:Number(snapshot?.dataset.snapshotHiddenCount || 0),
        snapshotYearStripHiddenCount:Number(snapshot?.dataset.snapshotYearStripHiddenCount || 0),
        stripPortalCount:surface.querySelectorAll(
          ':scope > .fc-year-strip.fc-year-strip-portal',
        ).length,
        stripTextureCount:surface.querySelectorAll(
          ':scope > .fc-year-strip-texture.is-active',
        ).length,
        yearStripCount:document.querySelectorAll('.fc-year-strip').length,
        stripIdentity:!!strip
          && strip === window.__calendarYearStripSource
          && stripTexture?.dataset.stripSourceIdentity === strip.dataset.stripIdentity,
        stripGeometryStable:strip?.dataset.portalGeometryStable === 'true',
        stripOpacity:stripTextureStyle ? Number(stripTextureStyle.opacity) : null,
        stripDestinationOpacitySum:stripTextureStyle
          ? Number(stripTextureStyle.opacity) + destinationOpacity
          : null,
        stripCompositorTexture:stripTexture?.dataset.snapshotReady === 'true'
          && stripTexture.dataset.snapshotFormat === 'png'
          && stripTexture.dataset.compositeWarm === 'true'
          && stripTexture.dataset.stripCaptureMode === 'compositor',
        stripNativePaintSuspended:stripStyle?.visibility === 'hidden'
          && (stripStyle.webkitBackdropFilter || stripStyle.backdropFilter) === 'none'
          && stripControls.every((control) => {
            const style = getComputedStyle(control);
            return style.visibility === 'hidden'
              && (style.webkitBackdropFilter || style.backdropFilter) === 'none';
          }),
        stripInteractionLocked:stripStyle?.pointerEvents === 'none'
          && stripTextureStyle?.pointerEvents === 'none'
          && stripControls.every((control) => getComputedStyle(control).pointerEvents === 'none'),
        scheduledChipSourceCount:target?.querySelectorAll?.('.fc-chip').length || 0,
        scheduledChipDestinationCount:moving?.querySelectorAll?.(
          ':scope > .fc-expander-live .fc-chip',
        ).length || 0,
        scheduledChipOverlap:Number(overlap(mappedSourceChip, destinationRect).toFixed(4)),
      };
    });
  };

  await neutralFrame();
  const rootControlGeometry = await page.evaluate(() => {
    const strip = document.querySelector('.fc-level > .fc-year-strip');
    window.__calendarYearStripSource = strip;
    const stripRect = strip?.getBoundingClientRect();
    const face = strip?.querySelector('.fc-year-face');
    const faceRect = face?.getBoundingClientRect();
    const arrows = [...(strip?.querySelectorAll('.fc-year-btn') || [])];
    const captureMargin = 24;
    return {
      viewport:{ width:innerWidth, height:innerHeight },
      strip:stripRect ? {
        left:stripRect.left,
        right:stripRect.right,
        top:stripRect.top,
        bottom:stripRect.bottom,
      } : null,
      capture:stripRect ? {
        left:Math.max(0, stripRect.left - captureMargin),
        right:Math.min(innerWidth, stripRect.right + captureMargin),
        top:Math.max(0, stripRect.top - captureMargin),
        bottom:Math.min(innerHeight, stripRect.bottom + captureMargin),
      } : null,
      design:{
        menuSurface:strip?.classList.contains('crm-menu-surface') === true,
        faceGlass:face?.classList.contains('window-glass-control') === true,
        faceRect:faceRect
          ? [faceRect.x, faceRect.y, faceRect.width, faceRect.height]
            .map((value) => Number(value.toFixed(2)))
          : null,
        arrows:arrows.map((arrow) => ({
          glass:arrow.classList.contains('window-glass-control'),
          secondary:arrow.classList.contains('crm-secondary-control'),
          opacity:Number(getComputedStyle(arrow).opacity),
        })),
      },
    };
  });
  const warmMonth = async () => {
    const month = page.locator(
      '.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)',
    ).first();
    await month.hover();
    await waitForWarmTextures(page, 'month', 'year:');
    return month;
  };
  const warmDay = async () => {
    const day = page.locator(
      '.fc-expander[data-kind="month"] > .fc-expander-live .fc-day[data-date]:has(.fc-chip)',
    ).first();
    await day.hover();
    await waitForWarmTextures(page, 'day', 'month:');
    return day;
  };
  const openMonth = async () => {
    const month = await warmMonth();
    const started = waitMoving('expanding');
    await month.click();
    await started;
  };
  const openDay = async () => {
    const day = await warmDay();
    const started = waitMoving('expanding');
    await day.click();
    await started;
  };
  const goBack = async () => {
    const started = waitMoving('contracting');
    await page.evaluate(() => window.fractalCalendar.back());
    await started;
  };

  await shot('year-source');

  await armPhaseHold('month-in-midpoint', .5);
  await openMonth();
  await waitPhaseHold('month-in-midpoint', 'expand');
  await inspectMidpoint('month-in');
  await shot('month-in-midpoint');
  await releasePhaseHold('month-in-midpoint');
  await waitLevel(1);
  await neutralFrame();
  await shot('month-settled');

  await goBack();
  await waitLevel(0);
  await armPhaseHold('month-in-exchange', .89);
  await openMonth();
  await waitPhaseHold('month-in-exchange', 'expand');
  await inspectExchange('month-in');
  await shot('month-in-exchange');
  await releasePhaseHold('month-in-exchange');
  await waitLevel(1);

  await armPhaseHold('day-in-midpoint', .5);
  await openDay();
  await waitPhaseHold('day-in-midpoint', 'expand');
  await inspectMidpoint('day-in');
  await shot('day-in-midpoint');
  await releasePhaseHold('day-in-midpoint');
  await waitLevel(2);
  await neutralFrame();
  await shot('day-settled');

  await goBack();
  await waitLevel(1);
  await armPhaseHold('day-in-exchange', .89);
  await openDay();
  await waitPhaseHold('day-in-exchange', 'expand');
  await inspectExchange('day-in');
  await shot('day-in-exchange');
  await releasePhaseHold('day-in-exchange');
  await waitLevel(2);

  await armPhaseHold('day-out-exchange', .89);
  await goBack();
  await waitPhaseHold('day-out-exchange', 'contract');
  await inspectExchange('day-out');
  await shot('day-out-exchange');
  await releasePhaseHold('day-out-exchange');
  await waitLevel(1);

  await openDay();
  await waitLevel(2);
  await armPhaseHold('day-out-midpoint', .5);
  await goBack();
  await waitPhaseHold('day-out-midpoint', 'contract');
  await inspectMidpoint('day-out');
  await shot('day-out-midpoint');
  await releasePhaseHold('day-out-midpoint');
  await waitLevel(1);
  await neutralFrame();
  await shot('month-returned');

  await armPhaseHold('month-out-exchange', .89);
  await goBack();
  await waitPhaseHold('month-out-exchange', 'contract');
  await inspectExchange('month-out');
  await shot('month-out-exchange');
  await releasePhaseHold('month-out-exchange');
  await waitLevel(0);

  await openMonth();
  await waitLevel(1);
  await armPhaseHold('month-out-midpoint', .5);
  await goBack();
  await waitPhaseHold('month-out-midpoint', 'contract');
  await inspectMidpoint('month-out');
  await shot('month-out-midpoint');
  await releasePhaseHold('month-out-midpoint');
  await waitLevel(0);
  await neutralFrame();
  await shot('year-returned');
  const stripCleanup = await page.evaluate(() => {
    const strips = [...document.querySelectorAll('.fc-year-strip')];
    const strip = strips[0] || null;
    const stripTextures = [...document.querySelectorAll('.fc-surface > .fc-year-strip-texture')];
    const rect = strip?.getBoundingClientRect();
    return {
      count:strips.length,
      sameIdentity:strip === window.__calendarYearStripSource,
      directPortalCount:document.querySelectorAll(
        '.fc-surface > .fc-year-strip.fc-year-strip-portal',
      ).length,
      activeTextureCount:stripTextures.filter((node) => node.classList.contains('is-active')).length,
      cachedTextureCount:stripTextures.length,
      cachedTexturesReady:stripTextures.every((node) => (
        node.dataset.snapshotReady === 'true'
        && node.dataset.snapshotFormat === 'png'
        && node.dataset.stripCaptureMode === 'compositor'
        && Number(getComputedStyle(node).opacity) === 0
      )),
      restoredParent:strip?.parentElement?.classList.contains('fc-level') === true,
      geometry:rect
        ? [rect.x, rect.y, rect.width, rect.height].map((value) => Number(value.toFixed(2)))
        : null,
    };
  });

  return {
    outputDir,
    paths,
    rootControlGeometry,
    midpointStructures,
    exchangeStructures,
    phaseHolds,
    stripCleanup,
    monthEndpointDiff:compareScreenshots(paths['month-settled'], paths['month-returned']),
    yearEndpointDiff:compareScreenshots(paths['year-source'], paths['year-returned']),
    rootEntryMaterialDiff:compareMaterialBands(paths['year-source'], paths['month-in-midpoint']),
    rootReturnMaterialDiff:compareMaterialBands(paths['year-returned'], paths['month-out-midpoint']),
    dayOutMaterialDiff:compareMaterialBands(paths['month-settled'], paths['day-out-midpoint']),
    topStripEntryDiff:compareScreenshotRegion(
      paths['year-source'],
      paths['month-in-midpoint'],
      rootControlGeometry.capture,
      rootControlGeometry.viewport,
    ),
    topStripReturnDiff:compareScreenshotRegion(
      paths['year-returned'],
      paths['month-out-midpoint'],
      rootControlGeometry.capture,
      rootControlGeometry.viewport,
    ),
  };
}

async function verifyColdNavigation(page) {
  const proof = await page.evaluate(() => {
    const camera = window.fractalCalendarCamera;
    const surface = camera.surface();
    camera.dropWarm?.();
    const target = document.querySelector(
      '.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)',
    );
    const key = `month:${target?.dataset.month || ''}`;
    const state = {
      key,
      noWarmBefore:!surface.querySelector(':scope > .fc-warm'),
      noTexturesBefore:!surface.querySelector(
        ':scope > .fc-transition-portal,:scope > .fc-below-snapshot',
      ),
      preMotionFrames:0,
      preMotionMinimumTargetOpacity:1,
      preMotionUnexpectedMovingFrames:0,
      texturesReadyAtMotion:false,
      keyIdentityAtMotion:false,
      deferredTextureReadyAtMotion:false,
      movingObserved:false,
    };
    window.__calendarColdProof = state;
    const tick = () => {
      if (state.movingObserved) return;
      if (!camera.isTransitioning()) {
        state.preMotionFrames += 1;
        state.preMotionMinimumTargetOpacity = Math.min(
          state.preMotionMinimumTargetOpacity,
          Number(getComputedStyle(target).opacity),
        );
        if (surface.classList.contains('fc-camera-moving')) {
          state.preMotionUnexpectedMovingFrames += 1;
        }
        requestAnimationFrame(tick);
        return;
      }
      state.movingObserved = true;
      const moving = [...surface.querySelectorAll(
        ':scope > .fc-expander:not(.fc-warm):not(.fc-camera-below)',
      )].at(-1);
      const preview = moving?.querySelector(':scope > .fc-transition-preview');
      const portal = surface.querySelector(':scope > .fc-transition-portal');
      const below = surface.querySelector(':scope > .fc-below-snapshot.is-active');
      const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture.is-active');
      const sourceMaterial = surface.querySelector(':scope > .fc-source-screen-acrylic');
      const destinationMaterial = surface.querySelector(
        ':scope > .fc-level-material.is-suspended-destination-material',
      );
      const belowMaterial = surface.querySelector(
        ':scope > .fc-below-material-scene.is-below-material',
      );
      const textures = [preview, portal, below, stripTexture];
      const materials = [sourceMaterial, destinationMaterial, belowMaterial];
      state.texturesReadyAtMotion = textures.every((node) => (
        node?.dataset.snapshotReady === 'true'
        && node.dataset.snapshotFormat === 'png'
        && node.dataset.compositeWarm === 'true'
      )) && materials.every((node) => node?.dataset.compositeWarm === 'true');
      state.keyIdentityAtMotion = preview?.dataset.transitionSource === key
        && portal?.dataset.transitionSource === key
        && below?.dataset.snapshotSelectedKey === key
        && below?.dataset.snapshotHiddenCount === '1'
        && below?.dataset.snapshotYearStripHiddenCount === '1'
        && stripTexture?.dataset.stripCaptureMode === 'compositor'
        && !!stripTexture?.dataset.stripCaptureKey;
      state.deferredTextureReadyAtMotion = surface.dataset.deferredTextureReady === 'true';
    };
    requestAnimationFrame(tick);
    target?.click();
    return state;
  });
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 1
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:30000 });
  const settled = await page.evaluate(() => ({ ...window.__calendarColdProof }));
  await page.evaluate(() => window.fractalCalendar.back());
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 0
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:10000 });
  return { ...proof, ...settled };
}

async function verifyResizeInvalidation(page, app) {
  const original = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((win) => (
      win.isVisible()
      && win.webContents.getLastWebPreferences()?.offscreen !== true
      && /dashboard\/index\.html/i.test(win.webContents.getURL())
      && !/[?&](?:crmPreviewWorker|crmCalendarStripWorker)=1(?:&|$)/
        .test(win.webContents.getURL())
    ));
    if (windows.length !== 1) throw new Error('Expected one native Calendar window');
    const [width, height] = windows[0].getContentSize();
    return { width, height };
  });
  const resizeNativeWindow = async (size) => {
    const applied = await app.evaluate(({ BrowserWindow }, requested) => {
      const windows = BrowserWindow.getAllWindows().filter((win) => (
        win.isVisible()
        && win.webContents.getLastWebPreferences()?.offscreen !== true
        && /dashboard\/index\.html/i.test(win.webContents.getURL())
        && !/[?&](?:crmPreviewWorker|crmCalendarStripWorker)=1(?:&|$)/
          .test(win.webContents.getURL())
      ));
      if (windows.length !== 1) throw new Error('Expected one native Calendar window');
      windows[0].setContentSize(requested.width, requested.height, false);
      const [width, height] = windows[0].getContentSize();
      return { width, height };
    }, size);
    await page.waitForFunction(({ width, height }) => (
      innerWidth === width && innerHeight === height
    ), applied, { timeout:10000 });
    return applied;
  };
  const month = page.locator('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)').first();
  await month.hover();
  await waitForWarmTextures(page, 'month', 'year:');
  await month.click();
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 1
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:10000 });
  const hiddenCapture = await page.evaluate(async () => {
    const result = await window.crmCalendarTransition.captureStrip();
    const { src = '', ...metadata } = result || {};
    return {
      ...metadata,
      png:typeof src === 'string' && src.startsWith('data:image/png;base64,'),
      renderer:window.fractalCalendar.stripCaptureDiagnostics?.() || null,
    };
  });
  const before = await page.evaluate(() => {
    const surface = window.fractalCalendarCamera.surface();
    const portal = surface.querySelector(':scope > .fc-transition-portal');
    const below = surface.querySelector(':scope > .fc-below-snapshot');
    const material = surface.querySelector(':scope > .fc-below-material-scene');
    const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture');
    window.__calendarResizeOld = { portal, below, material, stripTexture };
    return {
      signature:surface.dataset.geometrySignature || '',
      portalGeometry:portal?.dataset.transitionGeometry || '',
      belowGeometry:below?.dataset.snapshotGeometry || '',
      stripGeometry:stripTexture?.dataset.stripGeometry || '',
      stripCaptureKey:stripTexture?.dataset.stripCaptureKey || '',
      stripCaptureRevision:stripTexture?.dataset.stripCaptureRevision || '',
      requestRevision:window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '',
      stripCaptureSource:stripTexture?.dataset.stripCaptureSource || '',
      stripKeyParity:stripTexture?.dataset.stripCaptureKey
        === window.fractalCalendar.stripCaptureRequestState()?.captureKey,
    };
  });
  const resized = {
    width:Math.max(1000, original.width - 48),
    height:Math.max(680, original.height - 36),
  };
  let nativeResizeApplied = false;
  try {
    nativeResizeApplied = true;
    await resizeNativeWindow(resized);
  const synchronous = await page.evaluate(() => {
    const surface = window.fractalCalendarCamera.surface();
    return {
      geometryReady:window.fractalCalendar.geometryReady(),
      signature:surface.dataset.geometrySignature || '',
      oldPortalDisconnected:window.__calendarResizeOld.portal?.isConnected === false,
      oldBelowDisconnected:window.__calendarResizeOld.below?.isConnected === false,
      oldMaterialDisconnected:window.__calendarResizeOld.material?.isConnected === false,
      oldStripTextureDisconnected:window.__calendarResizeOld.stripTexture?.isConnected === false,
    };
  });
  try {
    await page.waitForFunction(() => window.fractalCalendar.geometryReady(), null, { timeout:15000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const surface = window.fractalCalendarCamera.surface();
      const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture');
      let bridge = null;
      let bridgeError = '';
      try {
        const result = await window.crmCalendarTransition?.captureStrip?.();
        if (result) {
          const { src = '', ...metadata } = result;
          bridge = {
            ...metadata,
            png:typeof src === 'string' && src.startsWith('data:image/png;base64,'),
          };
        }
      } catch (captureError) {
        bridgeError = String(captureError?.message || captureError || '');
      }
      return {
        geometryReady:window.fractalCalendar.geometryReady(),
        geometrySignature:surface.dataset.geometrySignature || '',
        request:window.fractalCalendar.stripCaptureRequestState?.() || null,
        renderer:window.fractalCalendar.stripCaptureDiagnostics?.() || null,
        stripTexture:stripTexture ? {
          key:stripTexture.dataset.stripCaptureKey || '',
          revision:stripTexture.dataset.stripCaptureRevision || '',
          source:stripTexture.dataset.stripCaptureSource || '',
          ready:stripTexture.dataset.snapshotReady || '',
          format:stripTexture.dataset.snapshotFormat || '',
          compositeWarm:stripTexture.dataset.compositeWarm || '',
        } : null,
        bridge,
        bridgeError,
      };
    });
    throw new Error(`Calendar resize readiness timeout: ${JSON.stringify(diagnostics)}`, {
      cause:error,
    });
  }
  const rebuilt = await page.evaluate(() => {
    const surface = window.fractalCalendarCamera.surface();
    const portal = surface.querySelector(':scope > .fc-transition-portal');
    const below = surface.querySelector(':scope > .fc-below-snapshot');
    const material = surface.querySelector(':scope > .fc-below-material-scene');
    const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture');
    return {
      signature:surface.dataset.geometrySignature || '',
      portalGeometry:portal?.dataset.transitionGeometry || '',
      belowGeometry:below?.dataset.snapshotGeometry || '',
      portalReady:portal?.dataset.snapshotReady === 'true'
        && portal.dataset.compositeWarm === 'true',
      belowReady:below?.dataset.snapshotReady === 'true'
        && below.dataset.compositeWarm === 'true',
      materialReady:material?.dataset.compositeWarm === 'true',
      stripReady:stripTexture?.dataset.snapshotReady === 'true'
        && stripTexture.dataset.snapshotFormat === 'png'
        && stripTexture.dataset.compositeWarm === 'true'
        && stripTexture.dataset.stripCaptureMode === 'compositor',
      stripGeometry:stripTexture?.dataset.stripGeometry || '',
      stripCaptureKey:stripTexture?.dataset.stripCaptureKey || '',
      stripCaptureRevision:stripTexture?.dataset.stripCaptureRevision || '',
      requestRevision:window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '',
      stripCaptureSource:stripTexture?.dataset.stripCaptureSource || '',
      stripKeyParity:stripTexture?.dataset.stripCaptureKey
        === window.fractalCalendar.stripCaptureRequestState()?.captureKey,
      renderer:window.fractalCalendar.stripCaptureDiagnostics?.() || null,
      staleNodesReused:[portal, below, material, stripTexture].some((node) => (
        node === window.__calendarResizeOld.portal
        || node === window.__calendarResizeOld.below
        || node === window.__calendarResizeOld.material
        || node === window.__calendarResizeOld.stripTexture
      )),
    };
  });
  await resizeNativeWindow(original);
  await page.waitForFunction(() => window.fractalCalendar.geometryReady(), null, { timeout:15000 });
  nativeResizeApplied = false;
  const restored = await page.evaluate(() => {
    const surface = window.fractalCalendarCamera.surface();
    const portal = surface.querySelector(':scope > .fc-transition-portal');
    const below = surface.querySelector(':scope > .fc-below-snapshot');
    const stripTexture = surface.querySelector(':scope > .fc-year-strip-texture');
    return {
      signature:surface.dataset.geometrySignature || '',
      portalGeometry:portal?.dataset.transitionGeometry || '',
      belowGeometry:below?.dataset.snapshotGeometry || '',
      stripGeometry:stripTexture?.dataset.stripGeometry || '',
      stripCaptureRevision:stripTexture?.dataset.stripCaptureRevision || '',
      requestRevision:window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '',
      stripCaptureSource:stripTexture?.dataset.stripCaptureSource || '',
      stripKeyParity:stripTexture?.dataset.stripCaptureKey
        === window.fractalCalendar.stripCaptureRequestState()?.captureKey,
      renderer:window.fractalCalendar.stripCaptureDiagnostics?.() || null,
      ready:portal?.dataset.snapshotReady === 'true'
        && below?.dataset.snapshotReady === 'true'
        && stripTexture?.dataset.snapshotReady === 'true'
        && stripTexture.dataset.stripCaptureMode === 'compositor',
    };
  });
  await page.evaluate(() => window.fractalCalendar.back());
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 0
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:10000 });
    return { original, resized, hiddenCapture, before, synchronous, rebuilt, restored };
  } finally {
    if (nativeResizeApplied) {
      await resizeNativeWindow(original).catch(() => null);
      await page.waitForFunction(
        () => window.fractalCalendar.geometryReady(),
        null,
        { timeout:15000 },
      ).catch(() => null);
    }
  }
}

async function verifyThemeInvalidation(page) {
  const month = page.locator('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)').first();
  await month.hover();
  await waitForWarmTextures(page, 'month', 'year:');
  await month.click();
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 1
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:10000 });
  const changed = await page.evaluate(async () => {
    const root = document.documentElement;
    const originalTone = root.dataset.background || '';
    const targetTone = originalTone === 'tone-black' ? 'tone-grey' : 'tone-black';
    const oldTexture = document.querySelector('.fc-surface > .fc-year-strip-texture');
    const oldKey = oldTexture?.dataset.stripCaptureKey || '';
    const oldRevision = window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '';
    const option = [...document.querySelectorAll('[data-background-tone]')]
      .find((node) => node.dataset.backgroundTone === targetTone);
    option?.click();
    await Promise.resolve(window.__dashboardBackgroundPreloadReady).catch(() => null);
    await Promise.resolve();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      originalTone,
      targetTone,
      appliedTone:root.dataset.background || '',
      oldKey,
      oldRevision,
      oldTextureDisconnected:oldTexture?.isConnected === false,
      staleTextureCount:document.querySelectorAll('.fc-surface > .fc-year-strip-texture').length,
      requestKey:window.fractalCalendar.stripCaptureRequestState()?.captureKey || '',
      requestRevision:window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '',
    };
  });
  await page.evaluate(() => window.fractalCalendar.back());
  await page.waitForFunction(() => (
    window.fractalCalendar.level() === 0
    && !window.fractalCalendarCamera.isTransitioning()
  ), null, { timeout:30000 });
  const captured = await page.evaluate(() => {
    const texture = document.querySelector('.fc-surface > .fc-year-strip-texture');
    const strip = document.querySelector('.fc-level > .fc-year-strip');
    return {
      tone:document.documentElement.dataset.background || '',
      textureReady:texture?.dataset.snapshotReady === 'true'
        && texture.dataset.snapshotFormat === 'png'
        && texture.dataset.compositeWarm === 'true',
      captureSource:texture?.dataset.stripCaptureSource || '',
      captureKey:texture?.dataset.stripCaptureKey || '',
      captureRevision:texture?.dataset.stripCaptureRevision || '',
      requestKey:window.fractalCalendar.stripCaptureRequestState()?.captureKey || '',
      requestRevision:window.fractalCalendar.stripCaptureRequestState()?.captureRevision || '',
      activeTextureCount:document.querySelectorAll(
        '.fc-surface > .fc-year-strip-texture.is-active',
      ).length,
      nativeRestored:strip?.parentElement?.classList.contains('fc-level') === true
        && !strip.classList.contains('fc-year-strip-portal'),
      renderer:window.fractalCalendar.stripCaptureDiagnostics?.() || null,
    };
  });
  await page.evaluate(async (tone) => {
    const option = [...document.querySelectorAll('[data-background-tone]')]
      .find((node) => node.dataset.backgroundTone === tone);
    option?.click();
    await Promise.resolve(window.__dashboardBackgroundPreloadReady).catch(() => null);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, changed.originalTone);
  return { changed, captured };
}

function exactOffscreenAudit(audit) {
  const request = audit?.mainRequest;
  const finalState = audit?.mainFinal;
  const workerState = audit?.worker?.validatedState;
  const workerFinal = audit?.worker?.final;
  const counts = audit?.workerCountsAfter;
  const sameRect = request?.rect && workerState?.rect
    && ['x', 'y', 'width', 'height'].every(
      (property) => Math.abs(workerState.rect[property] - request.rect[property]) <= .1,
    );
  return request?.visible === false
    && request?.level === 1
    && finalState?.captureKey === request.captureKey
    && finalState?.captureRevision === request.captureRevision
    && workerState?.visible === true
    && workerState?.level === 0
    && workerState?.captureKey === request.captureKey
    && workerState?.captureRevision === request.captureRevision
    && workerState?.geometry === request.geometry
    && workerState?.backgroundTone === request.backgroundTone
    && workerState?.visualSignature === request.visualSignature
    && Math.abs(workerState?.dpr - request.dpr) <= .01
    && sameRect
    && workerFinal?.module === 'calendar'
    && workerFinal?.year === request.year
    && workerFinal?.level === 0
    && workerFinal?.key === request.captureKey
    && workerFinal?.revision === request.captureRevision
    && audit?.worker?.captureResolved === true
    && audit?.worker?.destroyedAfterCaptureResolved === true
    && audit?.worker?.destroyedCountAtCaptureResolved === audit?.workerCountsBefore?.destroyed
    && audit?.worker?.destroyed === true
    && counts?.created === counts?.destroyed
    && counts?.live === 0
    && audit?.renderer?.pending === 0
    && audit?.renderer?.lastError === '';
}

function exactOffscreenCaptureAudit(result) {
  return result?.ok === true
    && result.source === 'offscreen'
    && result.png === true
    && exactOffscreenAudit(result.audit);
}

async function auditCaptureWindows(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().map((win) => ({
      visible:win.isVisible(),
      url:win.webContents.getURL(),
      offscreenPreference:win.webContents.getLastWebPreferences()?.offscreen === true,
    }));
    const isDashboard = (entry) => /dashboard\/index\.html/i.test(entry.url);
    const isCalendarWorker = (entry) => (
      /[?&]crmCalendarStripWorker=1(?:&|$)/.test(entry.url)
    );
    const isAnyPreviewWorker = (entry) => (
      /[?&]crmPreviewWorker=1(?:&|$)/.test(entry.url)
    );
    return {
      count:windows.length,
      visibleMainCount:windows.filter((entry) => (
        entry.visible
        && isDashboard(entry)
        && !isAnyPreviewWorker(entry)
        && !isCalendarWorker(entry)
      )).length,
      calendarStripWorkerCount:windows.filter(isCalendarWorker).length,
      previewWorkerCount:windows.filter(isAnyPreviewWorker).length,
      offscreenPreferenceCount:windows.filter((entry) => entry.offscreenPreference).length,
      windows,
    };
  });
}

async function main() {
  const apiPort = Number(process.env.CRM_CALENDAR_API_PORT || process.env.CRM_API_PORT || 4029);
  const staticPort = Number(process.env.CRM_CALENDAR_STATIC_PORT || process.env.CRM_STATIC_PORT || 4028);
  if (process.env.CRM_CALENDAR_CAPTURE_PROBE_ONLY !== '1') {
    fs.mkdirSync(CALENDAR_OUTPUT_DIR, { recursive:true });
    fs.rmSync(CALENDAR_EVIDENCE_PATH, { force:true });
  }
  const harness = await start({
    apiPort,
    staticPort,
    seedData:true,
    seedFn:seedCalendarProof,
  });
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
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await page.waitForFunction(() => (
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && window.crmWorkspaces
      && window.fractalCalendarCamera
    ), null, { timeout:30000 });
    await page.evaluate(async () => {
      await window.crmHomePreviews?.waitForIdle?.();
      window.crmWorkspaces.setActive('calendar');
      await window.fractalCalendar.refresh();
    });
    await page.waitForFunction(() => (
      document.body.dataset.crmModule === 'calendar'
      && window.fractalCalendar.level() === 0
      && !window.fractalCalendarCamera.isTransitioning()
    ), null, { timeout:30000 });
    const captureBridgeAudit = await page.evaluate(async () => {
      const state = window.fractalCalendar.stripCaptureState();
      const capture = await window.crmCalendarTransition?.captureStrip?.({
        x:0, y:0, width:innerWidth, height:innerHeight,
      });
      return {
        argumentCount:window.crmCalendarTransition?.captureStrip?.length,
        stateReady:state?.ready === true,
        stateKey:state?.captureKey || '',
        stateRevision:state?.captureRevision || '',
        stateRect:state?.rect || null,
        ok:capture?.ok === true,
        captureKey:capture?.captureKey || '',
        captureRevision:capture?.captureRevision || '',
        captureRect:capture?.captureRect || null,
        stripRect:capture?.stripRect || null,
        pixelSize:capture?.pixelSize || null,
        dpr:capture?.dpr || null,
        source:capture?.source || '',
        viewport:[innerWidth, innerHeight],
        png:typeof capture?.src === 'string'
          && capture.src.startsWith('data:image/png;base64,'),
      };
    });
    if (process.env.CRM_CALENDAR_CAPTURE_PROBE_ONLY === '1') {
      await page.waitForSelector(
        '.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)',
        { timeout:10000 },
      );
      const resizeInvalidation = await verifyResizeInvalidation(page, app);
      const themeInvalidation = await verifyThemeInvalidation(page);
      const renderer = await page.evaluate(
        () => window.fractalCalendar.stripCaptureDiagnostics?.() || null,
      );
      const captureWindowAudit = await auditCaptureWindows(app);
      const evidence = {
        mode:'capture-probe',
        captureBridgeAudit,
        resizeInvalidation,
        themeInvalidation,
        renderer,
        captureWindowAudit,
      };
      const failures = [];
      if (!exactOffscreenCaptureAudit(resizeInvalidation.hiddenCapture)) {
        failures.push('initial hidden-root capture audit was not exact');
      }
      if (!resizeInvalidation.synchronous.oldPortalDisconnected
        || !resizeInvalidation.synchronous.oldBelowDisconnected
        || !resizeInvalidation.synchronous.oldMaterialDisconnected
        || !resizeInvalidation.synchronous.oldStripTextureDisconnected
        || !resizeInvalidation.rebuilt.portalReady
        || !resizeInvalidation.rebuilt.belowReady
        || !resizeInvalidation.rebuilt.materialReady
        || !resizeInvalidation.rebuilt.stripReady
        || resizeInvalidation.rebuilt.stripCaptureSource !== 'offscreen'
        || !resizeInvalidation.rebuilt.stripKeyParity
        || !exactOffscreenAudit(resizeInvalidation.rebuilt.renderer?.lastAudit)
        || !resizeInvalidation.restored.ready
        || resizeInvalidation.restored.stripCaptureSource !== 'offscreen'
        || !resizeInvalidation.restored.stripKeyParity
        || !exactOffscreenAudit(resizeInvalidation.restored.renderer?.lastAudit)) {
        failures.push('resize hidden-root capture did not rebuild exactly');
      }
      if (themeInvalidation.changed.appliedTone !== themeInvalidation.changed.targetTone
        || !themeInvalidation.changed.oldTextureDisconnected
        || themeInvalidation.changed.staleTextureCount !== 0
        || !themeInvalidation.captured.textureReady
        || themeInvalidation.captured.captureSource !== 'offscreen'
        || themeInvalidation.captured.captureKey !== themeInvalidation.captured.requestKey
        || !exactOffscreenAudit(themeInvalidation.captured.renderer?.lastAudit)) {
        failures.push('theme hidden-root capture did not rebuild exactly');
      }
      if (renderer?.pending !== 0
        || renderer?.promiseCount !== 0
        || renderer?.lastError
        || captureWindowAudit.visibleMainCount !== 1
        || captureWindowAudit.calendarStripWorkerCount !== 0) {
        failures.push('capture worker or renderer state did not clean up');
      }
      console.log(JSON.stringify(evidence, null, 2));
      if (failures.length) {
        throw new Error(`Calendar focused capture probe missed: ${failures.join('; ')}`);
      }
      return;
    }
    await page.waitForSelector('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)', { timeout:10000 });
    const coldNavigation = await verifyColdNavigation(page);
    await sleep(180);

    let displayHz = 0;
    try {
      displayHz = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().displayFrequency || 0);
    } catch {}
    const idleRounds = [];
    for (let round = 0; round < 3; round += 1) {
      idleRounds.push(await measureIdleCadence(page, 70));
    }
    const idleFps = [...idleRounds].sort((a, b) => a - b)[1];
    // Electron's Windows display metadata can report the 59.94 compositor
    // compatibility rate while requestAnimationFrame is actually paced by the
    // 100 Hz panel. The calibrated renderer cadence is therefore authoritative.
    const expectedHz = idleFps >= 95
      ? 100
      : Math.max(1, displayHz >= 95 ? 100 : (displayHz || Math.round(idleFps)));
    const fadeKeyframes = await readFadeKeyframes(page);

    const month = page.locator('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)').first();
    await month.hover();
    await waitForWarmTextures(page, 'month', 'year:');
    const monthWarm = await page.evaluate(() => {
      const warm = document.querySelector('.fc-warm[data-kind="month"]');
      const source = document.querySelector('.fc-level > .fc-grid > .fc-month:hover');
      const portal = document.querySelector('.fc-surface > .fc-transition-portal');
      const below = [...document.querySelectorAll('.fc-below-snapshot')]
        .find((node) => node.dataset.snapshotKey?.startsWith('year:'));
      const destinationMaterial = document.querySelector('.fc-level-material[data-material-owner="month"]');
      const belowMaterial = [...document.querySelectorAll('.fc-below-material-scene')]
        .find((node) => node.dataset.materialKey?.startsWith('year:'));
      if (warm) warm.dataset.continuityProbe = 'month';
      window.__calendarMonthSource = source;
      return {
        ready:!!warm
          && !!warm.querySelector(':scope > .fc-transition-preview')
          && !!warm.querySelector(':scope > .fc-expander-live')
          && !!portal
          && below?.dataset.snapshotHiddenCount === '1'
          && below?.dataset.snapshotControlPseudoCount === '2'
          && below?.dataset.snapshotYearStripHiddenCount === '1'
          && destinationMaterial?.dataset.materialBackdrop !== 'none'
          && Number(belowMaterial?.dataset.materialOwnerCount || 0) === 1
          && Number(belowMaterial?.dataset.materialPieceCount || 0) === 1
          && !belowMaterial?.querySelector('.fc-below-material-base-union')
          && !belowMaterial?.querySelector('.fc-below-material-control-union')
          && Number(belowMaterial?.querySelector(
            '.fc-below-material-piece[data-material-source-class="fc-frost"]',
          )?.dataset.materialOwnerCount || 0) === 1
          && belowMaterial?.querySelector(
            '.fc-below-material-piece[data-material-source-class="fc-frost"]',
          )?.dataset.materialBackdrop === 'blur(26px) saturate(1.4)',
        belowSnapshotHiddenCount:Number(below?.dataset.snapshotHiddenCount || 0),
        belowSnapshotControlPseudoCount:Number(below?.dataset.snapshotControlPseudoCount || 0),
        belowSnapshotYearStripHiddenCount:Number(
          below?.dataset.snapshotYearStripHiddenCount || 0,
        ),
        destinationBackdrop:destinationMaterial?.dataset.materialBackdrop || '',
        belowMaterialPieceCount:Number(belowMaterial?.dataset.materialPieceCount || 0),
        belowMaterialOwnerCount:Number(belowMaterial?.dataset.materialOwnerCount || 0),
        belowMaterialUnionOwnerCount:Number(
          belowMaterial?.querySelector('.fc-below-material-base-union')?.dataset.materialOwnerCount || 0,
        ),
        belowMaterialControlUnionOwnerCount:Number(
          belowMaterial?.querySelector('.fc-below-material-control-union')
            ?.dataset.materialOwnerCount || 0,
        ),
        belowMaterialFrostOwnerCount:Number(
          belowMaterial?.querySelector(
            '.fc-below-material-piece[data-material-source-class="fc-frost"]',
          )?.dataset.materialOwnerCount || 0,
        ),
      };
    });
    const monthIn = await profileMove(
      page,
      'month-in',
      () => month.click(),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 1 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const monthIdentity = await page.evaluate(() => (
      document.querySelector('.fc-expander[data-kind="month"]')?.dataset?.continuityProbe === 'month'
    ));

    const day = page.locator('.fc-expander[data-kind="month"] > .fc-expander-live .fc-day[data-date]:has(.fc-chip)').first();
    await day.hover();
    await waitForWarmTextures(page, 'day', 'month:');
    const dayWarm = await page.evaluate(() => {
      const warm = document.querySelector('.fc-warm[data-kind="day"]');
      const source = document.querySelector('.fc-expander[data-kind="month"] > .fc-expander-live .fc-day:hover');
      const portal = document.querySelector('.fc-surface > .fc-transition-portal');
      const preview = warm?.querySelector(':scope > .fc-transition-preview');
      const chip = source?.querySelector('.fc-chip');
      const accent = chip ? getComputedStyle(chip, '::before') : null;
      const below = [...document.querySelectorAll('.fc-below-snapshot')]
        .find((node) => node.dataset.snapshotKey?.startsWith('month:'));
      const destinationMaterial = document.querySelector('.fc-level-material[data-material-owner="day"]');
      const belowMaterial = [...document.querySelectorAll('.fc-level-material')]
        .find((node) => node.dataset.materialBelowKey?.startsWith('month:'));
      if (warm) warm.dataset.continuityProbe = 'day';
      window.__calendarDaySource = source;
      return {
        ready:!!warm
          && !!preview
          && !!warm.querySelector(':scope > .fc-expander-live .fc-day-detail')
          && !!portal
          && below?.dataset.snapshotHiddenCount === '1'
          && destinationMaterial?.dataset.materialBackdrop !== 'none'
          && belowMaterial?.dataset.materialBackdrop !== 'none',
        sourceDate:source?.dataset?.date || '',
        chipAccent:accent ? {
          content:accent.content,
          width:accent.width,
          backgroundColor:accent.backgroundColor,
        } : null,
        snapshotPseudoCount:Number(preview?.dataset?.snapshotPseudoCount || 0),
        belowSnapshotHiddenCount:Number(below?.dataset.snapshotHiddenCount || 0),
        destinationBackdrop:destinationMaterial?.dataset.materialBackdrop || '',
        belowBackdrop:belowMaterial?.dataset.materialBackdrop || '',
      };
    });
    const historyBefore = await page.evaluate(() => window.fractalCalendarCamera.historyState());
    const dayIn = await profileMove(
      page,
      'day-in',
      () => day.click(),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 2 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const dayEndpoint = await page.evaluate(() => {
      const expander = document.querySelector('.fc-expander[data-kind="day"]');
      return {
        reused:expander?.dataset?.continuityProbe === 'day',
        prebuiltStillPresent:!!expander?.querySelector(':scope > .fc-transition-preview')
          && !!expander?.querySelector(':scope > .fc-expander-live .fc-day-detail'),
        history:window.fractalCalendarCamera.historyState(),
      };
    });
    const dayOut = await profileMove(
      page,
      'day-out',
      () => page.evaluate(() => window.fractalCalendar.back()),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 1 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const returnEndpoint = await page.evaluate(() => ({
      sameSource:window.__calendarDaySource?.isConnected === true,
      targetCleared:!window.__calendarDaySource?.classList?.contains('fc-camera-target'),
      history:window.fractalCalendarCamera.historyState(),
    }));
    const monthOut = await profileMove(
      page,
      'month-out',
      () => page.evaluate(() => window.fractalCalendar.back()),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 0 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const rootEndpoint = await page.evaluate(() => ({
      sameSource:window.__calendarMonthSource?.isConnected === true,
      targetCleared:!window.__calendarMonthSource?.classList?.contains('fc-camera-target'),
      history:window.fractalCalendarCamera.historyState(),
    }));
    const resizeInvalidation = await verifyResizeInvalidation(page, app);
    const themeInvalidation = await verifyThemeInvalidation(page);
    const captureWindowAudit = await auditCaptureWindows(app);

    // Run cadence as a separate, timestamp-only pass. The structural pass
    // above intentionally reads computed styles and observes mutations; doing
    // either inside this pass would make the profiler itself a source of
    // missed frames.
    const cadenceMonth = page.locator('.fc-level > .fc-grid > .fc-month:has(.fc-day-preview-item)').first();
    await cadenceMonth.hover();
    await waitForWarmTextures(page, 'month', 'year:');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cadenceMonthIn = await profileCadenceMove(
      page,
      'month-in',
      () => cadenceMonth.click(),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 1 && !window.fractalCalendarCamera.isTransitioning()),
    );

    const cadenceDay = page.locator('.fc-expander[data-kind="month"] > .fc-expander-live .fc-day[data-date]:has(.fc-chip)').first();
    await cadenceDay.hover();
    await waitForWarmTextures(page, 'day', 'month:');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cadenceDayIn = await profileCadenceMove(
      page,
      'day-in',
      () => cadenceDay.click(),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 2 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const cadenceDayOut = await profileCadenceMove(
      page,
      'day-out',
      () => page.evaluate(() => window.fractalCalendar.back()),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 1 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const cadenceMonthOut = await profileCadenceMove(
      page,
      'month-out',
      () => page.evaluate(() => window.fractalCalendar.back()),
      () => page.waitForFunction(() => window.fractalCalendar.level() === 0 && !window.fractalCalendarCamera.isTransitioning()),
    );
    const cadence = [cadenceMonthIn, cadenceDayIn, cadenceDayOut, cadenceMonthOut];

    const evidence = {
      displayHz,
      idleFps,
      idleRounds,
      expectedHz,
      fadeKeyframes,
      captureBridgeAudit,
      coldNavigation,
      resizeInvalidation,
      themeInvalidation,
      captureWindowAudit,
      monthWarm,
      monthIn,
      monthIdentity,
      dayWarm,
      historyBefore,
      dayIn,
      dayEndpoint,
      dayOut,
      returnEndpoint,
      monthOut,
      rootEndpoint,
      cadence,
    };

    const moves = [monthIn, dayIn, dayOut, monthOut];
    const failures = [];
    const expectedFadeKeyframes = {
      'fc-transition-preview-out':[[0, 1], [.78, 1], [1, 0]],
      'fc-transition-live-in':[[0, 0], [.78, 0], [1, 1]],
      'fc-transition-preview-in':[[0, 0], [.22, 1], [1, 1]],
      'fc-transition-live-out':[[0, 1], [.22, 0], [1, 0]],
      'fc-below-release':[[0, 1], [.78, 1], [1, 0]],
      'fc-below-return':[[0, 0], [.22, 1], [1, 1]],
    };
    if (Object.entries(expectedFadeKeyframes)
      .some(([name, expected]) => JSON.stringify(fadeKeyframes[name]) !== JSON.stringify(expected))) {
      failures.push('calendar fades do not inherit Home’s exact 78/22 acrylic exchange');
    }
    if (expectedHz !== 100 || idleRounds.some((fps) => Math.round(fps) !== 100)) {
      failures.push(`idle renderer did not calibrate to 100Hz (${idleRounds.map((fps) => fps.toFixed(2)).join(', ')})`);
    }
    if (!coldNavigation.noWarmBefore || !coldNavigation.noTexturesBefore
      || coldNavigation.preMotionFrames < 1
      || coldNavigation.preMotionMinimumTargetOpacity < .99
      || coldNavigation.preMotionUnexpectedMovingFrames
      || !coldNavigation.texturesReadyAtMotion
      || !coldNavigation.keyIdentityAtMotion
      || !coldNavigation.deferredTextureReadyAtMotion) {
      failures.push(`cold rapid click was not safely deferred (${JSON.stringify(coldNavigation)})`);
    }
    if (captureBridgeAudit.argumentCount !== 0
      || !captureBridgeAudit.stateReady
      || !captureBridgeAudit.ok
      || !captureBridgeAudit.png
      || captureBridgeAudit.source !== 'main'
      || captureBridgeAudit.captureKey !== captureBridgeAudit.stateKey
      || !/^[a-z0-9]+$/i.test(captureBridgeAudit.stateRevision)
      || captureBridgeAudit.captureRevision !== captureBridgeAudit.stateRevision
      || !captureBridgeAudit.stateKey.endsWith(`:${captureBridgeAudit.stateRevision}`)
      || Math.abs(Number(captureBridgeAudit.stripRect?.x) - Number(captureBridgeAudit.stateRect?.x)) > .1
      || Math.abs(Number(captureBridgeAudit.stripRect?.y) - Number(captureBridgeAudit.stateRect?.y)) > .1
      || Number(captureBridgeAudit.captureRect?.width) >= Number(captureBridgeAudit.viewport?.[0])
      || Number(captureBridgeAudit.captureRect?.height) >= Number(captureBridgeAudit.viewport?.[1])) {
      failures.push(`Calendar capture bridge was not narrowly bounded (${JSON.stringify(captureBridgeAudit)})`);
    }
    if (!resizeInvalidation.before.signature
      || resizeInvalidation.synchronous.signature === resizeInvalidation.before.signature
      || !resizeInvalidation.synchronous.oldPortalDisconnected
      || !resizeInvalidation.synchronous.oldBelowDisconnected
      || !resizeInvalidation.synchronous.oldMaterialDisconnected
      || !resizeInvalidation.synchronous.oldStripTextureDisconnected
      || resizeInvalidation.rebuilt.signature !== resizeInvalidation.synchronous.signature
      || resizeInvalidation.rebuilt.portalGeometry !== resizeInvalidation.rebuilt.signature
      || resizeInvalidation.rebuilt.belowGeometry !== resizeInvalidation.rebuilt.signature
      || resizeInvalidation.rebuilt.stripGeometry !== resizeInvalidation.rebuilt.signature
      || !resizeInvalidation.rebuilt.portalReady
      || !resizeInvalidation.rebuilt.belowReady
      || !resizeInvalidation.rebuilt.materialReady
      || !resizeInvalidation.rebuilt.stripReady
      || resizeInvalidation.rebuilt.stripCaptureSource !== 'offscreen'
      || !resizeInvalidation.rebuilt.stripKeyParity
      || !/^[a-z0-9]+$/i.test(resizeInvalidation.before.requestRevision)
      || resizeInvalidation.rebuilt.stripCaptureRevision !== resizeInvalidation.rebuilt.requestRevision
      || resizeInvalidation.rebuilt.staleNodesReused
      || resizeInvalidation.restored.signature !== resizeInvalidation.before.signature
      || resizeInvalidation.restored.portalGeometry !== resizeInvalidation.restored.signature
      || resizeInvalidation.restored.belowGeometry !== resizeInvalidation.restored.signature
      || resizeInvalidation.restored.stripGeometry !== resizeInvalidation.restored.signature
      || resizeInvalidation.restored.stripCaptureSource !== 'offscreen'
      || !resizeInvalidation.restored.stripKeyParity
      || resizeInvalidation.restored.stripCaptureRevision !== resizeInvalidation.restored.requestRevision
      || !resizeInvalidation.restored.ready) {
      failures.push(`resize reused stale transition geometry (${JSON.stringify(resizeInvalidation)})`);
    }
    if (captureWindowAudit.visibleMainCount !== 1
      || captureWindowAudit.calendarStripWorkerCount !== 0) {
      failures.push(`Calendar capture worker leaked (${JSON.stringify(captureWindowAudit)})`);
    }
    if (!themeInvalidation.changed.originalTone
      || themeInvalidation.changed.appliedTone !== themeInvalidation.changed.targetTone
      || !themeInvalidation.changed.oldTextureDisconnected
      || themeInvalidation.changed.staleTextureCount !== 0
      || themeInvalidation.changed.requestKey === themeInvalidation.changed.oldKey
      || !/^[a-z0-9]+$/i.test(themeInvalidation.changed.oldRevision)
      || themeInvalidation.captured.tone !== themeInvalidation.changed.targetTone
      || !themeInvalidation.captured.textureReady
      || themeInvalidation.captured.captureSource !== 'offscreen'
      || themeInvalidation.captured.captureKey !== themeInvalidation.captured.requestKey
      || themeInvalidation.captured.captureRevision !== themeInvalidation.captured.requestRevision
      || themeInvalidation.captured.activeTextureCount !== 0
      || !themeInvalidation.captured.nativeRestored) {
      failures.push(`theme invalidation did not recapture exactly (${JSON.stringify(themeInvalidation)})`);
    }
    if (!monthWarm.ready || !monthIdentity) failures.push('month destination was not prebuilt/reused');
    if (!dayWarm.ready || !dayWarm.sourceDate || !dayWarm.chipAccent
      || dayWarm.snapshotPseudoCount < 1
      || !dayEndpoint.reused || !dayEndpoint.prebuiltStillPresent) {
      failures.push('day destination was not prebuilt/reused');
    }
    if (parseFloat(dayWarm.chipAccent?.width || 0) < 2.5
      || !dayWarm.chipAccent?.backgroundColor
      || dayWarm.chipAccent.backgroundColor === 'rgba(0, 0, 0, 0)') {
      failures.push('scheduled chip accent was not materialized into the transition texture');
    }
    if (!returnEndpoint.sameSource || !returnEndpoint.targetCleared) failures.push('day return did not restore its unchanged source');
    if (!rootEndpoint.sameSource || !rootEndpoint.targetCleared || rootEndpoint.history.level !== 0) {
      failures.push('month return did not restore its unchanged source');
    }
    if (dayEndpoint.history.level !== 2 || dayEndpoint.history.selectors.length !== 2
      || returnEndpoint.history.level !== 1 || returnEndpoint.history.selectors[0] !== historyBefore.selectors[0]) {
      failures.push('calendar history changed across day round-trip');
    }
    moves.forEach((probe) => {
      if (probe.missingStructures || probe.transformedFilters
        || probe.descendantFilterViolations.length
        || probe.childMutations.length || probe.longTasks.length) {
        failures.push(`${probe.label} performed visible/runtime work during motion`);
      }
      if (!probe.fixedMaterialOwners?.length) {
        failures.push(`${probe.label} did not expose an audited fixed acrylic owner`);
      }
      const expectedSettledMaterialCount = probe.label === 'month-out' ? 0 : 1;
      if (!probe.settledMaterialFrames?.length
        || probe.settledMaterialFrames.some((count) => count !== expectedSettledMaterialCount)
        || probe.settledTransitionLensFrames?.some((count) => count !== 0)) {
        failures.push(
          `${probe.label} settled with level-material frames `
          + `${JSON.stringify(probe.settledMaterialFrames)} / lens frames `
          + `${JSON.stringify(probe.settledTransitionLensFrames)} `
          + `instead of ${expectedSettledMaterialCount}/0`,
        );
      }
      if (probe.label.startsWith('month-')
        && (probe.rootFilterLayerCount !== 1 || probe.rootMaterialOwnerCount !== 1)) {
        failures.push(
          `${probe.label} root material used ${probe.rootFilterLayerCount} GPU filters `
          + `for ${probe.rootMaterialOwnerCount} audited owners`,
        );
      }
      if (probe.label.startsWith('month-')
        && (probe.motionFilterAudit?.allocatedBackdropOwnerCount !== 2
          || probe.motionFilterAudit?.activeTransitionOwnerCount !== 1
          || !probe.motionFilterAudit?.owners?.find((owner) => (
            owner.role === 'transition-lens'
          ))?.clip?.startsWith('path(')
          || probe.motionFilterAudit?.redundantZeroOpacityBackdropOwners?.length
          || probe.motionFilterAudit?.suspendedDestinationBackdropOwners?.length)) {
        failures.push(
          `${probe.label} active motion did not retain exact 2-filter/1-transition day-union ownership `
          + `(${JSON.stringify(probe.motionFilterAudit)})`,
        );
      }
      if (probe.label.startsWith('month-')) {
        const rootOwners = probe.fixedMaterialOwners.filter((owner) => owner.rootMaterialScene);
        const frost = rootOwners.find((owner) => owner.materialSource === 'fc-frost');
        if (rootOwners.length !== 1
          || frost?.materialOwnerCount !== 1
          || !frost?.values.includes('blur(26px) saturate(1.4)')) {
          failures.push(`${probe.label} root material did not retain the day-only acrylic recipe`);
        }
      }
      if (probe.acrylicRange < .65) failures.push(`${probe.label} acrylic did not perform its controlled fade`);
      if (probe.acrylicDistinct < 8 || probe.acrylicDirectionViolations
        || probe.acrylicObservedMaxStep > .18) {
        failures.push(`${probe.label} acrylic fade was stepped or non-monotonic`);
      }
      if (probe.minimumContentCoverage < .96) failures.push(`${probe.label} exposed a content-opacity gap`);
    });
    cadence.forEach((probe) => {
      if (probe.cadenceHz < 98.5 || probe.fps < 98.5
        || Math.round(probe.cadenceHz) !== 100 || Math.round(probe.fps) !== 100) {
        failures.push(`${probe.label} timestamp cadence ${probe.fps.toFixed(2)}fps/${probe.cadenceHz.toFixed(2)}Hz`);
      }
      if (probe.p95Ms > 12.5 || probe.maxMs > 15 || probe.over15Ms) {
        failures.push(`${probe.label} dropped a frame (p95 ${probe.p95Ms.toFixed(2)}ms, max ${probe.maxMs.toFixed(2)}ms)`);
      }
    });
    if (failures.length) {
      console.log(JSON.stringify(evidence, null, 2));
      throw new Error(`Calendar continuity budget missed: ${failures.join('; ')}`);
    }
    evidence.visuals = await captureTransitionVisuals(page);
    console.log(JSON.stringify(evidence, null, 2));
    const visualFailures = [];
    const expectedPhaseHolds = {
      'month-in-midpoint':['expand', .5],
      'month-in-exchange':['expand', .89],
      'day-in-midpoint':['expand', .5],
      'day-in-exchange':['expand', .89],
      'day-out-exchange':['contract', .89],
      'day-out-midpoint':['contract', .5],
      'month-out-exchange':['contract', .89],
      'month-out-midpoint':['contract', .5],
    };
    Object.entries(expectedPhaseHolds).forEach(([name, [direction, phase]]) => {
      const hold = evidence.visuals.phaseHolds?.[name];
      const expectedRaw = direction === 'contract' ? 1 - phase : phase;
      const rootTransition = name.startsWith('month-');
      const expectedRoles = rootTransition
        ? ['moving', 'preview', 'portal', 'snapshot', 'below-material', 'strip', 'lens']
        : ['moving', 'preview', 'portal', 'snapshot', 'below-material', 'lens'];
      if (hold?.direction !== direction
        || Math.abs(Number(hold?.phase) - phase) > .0001
        || Math.abs(Number(hold?.rawPhase) - expectedRaw) > .0001
        || hold?.phaseVerified !== true
        || Number(hold?.animationCount) !== (rootTransition ? 6 : 5)
        || JSON.stringify(hold?.targetRoles) !== JSON.stringify(expectedRoles)
        || hold?.moving !== true
        || Number(hold?.pausedCount) !== Number(hold?.animationCount)
        || hold?.resumed?.direction !== direction
        || Number(hold?.resumed?.animationCount) !== Number(hold?.animationCount)
        || Number(hold?.resumed?.awaitedCount) !== Number(hold?.animationCount)
        || Number(hold?.resumed?.fulfilledCount) !== Number(hold?.animationCount)
        || Number(hold?.resumed?.settledPaints) !== 2
        || hold?.resumed?.prematureSettlement !== false
        || hold?.resumed?.settledCamera !== true
        || Object.values(hold?.resumed?.staleVisible || {}).some((count) => count !== 0)) {
        visualFailures.push(
          `${name} was not held on its exact compositor phase `
          + `(${JSON.stringify(hold)})`,
        );
      }
    });
    if (evidence.visuals.monthEndpointDiff.ratio > .0025
      || evidence.visuals.yearEndpointDiff.ratio > .0025) {
      visualFailures.push(
        `settled endpoint changed after round-trip: month ${(evidence.visuals.monthEndpointDiff.ratio * 100).toFixed(3)}%, `
        + `year ${(evidence.visuals.yearEndpointDiff.ratio * 100).toFixed(3)}%`,
      );
    }
    Object.entries(evidence.visuals.midpointStructures).forEach(([name, structure]) => {
      if (structure.visibleSourcePreviews !== 1
        || structure.targetOpacity !== 0
        || structure.activeBelowSnapshots !== 1
        || structure.belowSnapshotHiddenCount !== 1
        || !structure.keyIdentity) {
        visualFailures.push(`${name} duplicated or failed to cut out its selected source`);
      }
      if (structure.belowMaterialOpacity == null || structure.belowMaterialOpacity < .98) {
        visualFailures.push(`${name} did not retain the exact below acrylic at midpoint`);
      }
      if (name.startsWith('month-')) {
        const expected = evidence.visuals.rootControlGeometry?.strip;
        const actual = structure.stripRect;
        const expectedRect = expected
          ? [expected.left, expected.top, expected.right - expected.left, expected.bottom - expected.top]
          : null;
        const geometryExact = !!actual && !!expectedRect
          && actual.every((value, index) => Math.abs(value - expectedRect[index]) <= .1);
        if (structure.belowSnapshotYearStripHiddenCount !== 1
          || structure.stripPortalCount !== 1
          || structure.stripTextureCount !== 1
          || structure.yearStripCount !== 1
          || structure.stripIdentity !== true
          || structure.stripGeometryStable !== true
          || structure.stripCompositorTexture !== true
          || structure.stripNativePaintSuspended !== true
          || structure.stripCaptureBounded !== true
          || structure.stripShadowExact !== true
          || structure.stripInteractionLocked !== true
          || Math.abs(Number(structure.stripOpacity) - 1) > .01
          || !geometryExact) {
          visualFailures.push(`${name} did not retain the exact compositor year-strip texture`);
        }
      } else if (structure.stripPortalCount !== 0) {
        visualFailures.push(`${name} retained an unrelated year-strip portal`);
      }
    });
    Object.entries(evidence.visuals.exchangeStructures).forEach(([name, structure]) => {
      const chipSpatiallyBounded = structure.scheduledChipOverlap <= .1
        || structure.scheduledChipOverlap >= .8;
      if (!structure.keyIdentity
        || structure.snapshotHiddenCount !== 1
        || structure.exchangePhase == null
        || structure.exchangePhase < .84
        || structure.exchangePhase > .97
        || structure.sourceOpacity <= .08
        || structure.sourceOpacity >= .92
        || structure.destinationOpacity <= .08
        || structure.destinationOpacity >= .92
        || Math.abs(structure.opacitySum - 1) > .025
        || structure.scheduledChipSourceCount !== 1
        || structure.scheduledChipDestinationCount !== 1
        || !chipSpatiallyBounded) {
        visualFailures.push(
          `${name} exchange was not a key-identical, pixel-bounded single-chip blend `
          + `(${JSON.stringify(structure)})`,
        );
      }
      if (name.startsWith('month-')
        && (structure.snapshotYearStripHiddenCount !== 1
          || structure.stripPortalCount !== 1
          || structure.stripTextureCount !== 1
          || structure.yearStripCount !== 1
          || structure.stripIdentity !== true
          || structure.stripGeometryStable !== true
          || structure.stripInteractionLocked !== true
          || structure.stripCompositorTexture !== true
          || structure.stripNativePaintSuspended !== true
          || structure.stripOpacity <= .08
          || structure.stripOpacity >= .92
          || Math.abs(structure.stripDestinationOpacitySum - 1) > .025)) {
        visualFailures.push(`${name} did not crossfade the exact compositor year strip`);
      }
    });
    const stripCleanup = evidence.visuals.stripCleanup;
    const sourceStrip = evidence.visuals.rootControlGeometry?.strip;
    const sourceGeometry = sourceStrip
      ? [
        sourceStrip.left,
        sourceStrip.top,
        sourceStrip.right - sourceStrip.left,
        sourceStrip.bottom - sourceStrip.top,
      ]
      : null;
    const cleanupGeometryExact = !!stripCleanup?.geometry && !!sourceGeometry
      && stripCleanup.geometry.every(
        (value, index) => Math.abs(value - sourceGeometry[index]) <= .1,
      );
    if (stripCleanup?.count !== 1
      || stripCleanup?.sameIdentity !== true
      || stripCleanup?.directPortalCount !== 0
      || stripCleanup?.activeTextureCount !== 0
      || stripCleanup?.cachedTextureCount < 1
      || stripCleanup?.cachedTexturesReady !== true
      || stripCleanup?.restoredParent !== true
      || !cleanupGeometryExact) {
      visualFailures.push(`native year strip did not restore exactly (${JSON.stringify(stripCleanup)})`);
    }
    const dayOutStructure = evidence.visuals.midpointStructures['day-out'];
    if (!String(dayOutStructure?.belowMaterialBackdrop || '').includes('blur(')
      || (dayOutStructure?.belowMaterialRect?.[2] || 0) < 1000
      || (dayOutStructure?.belowMaterialRect?.[3] || 0) < 600) {
      visualFailures.push('day-out midpoint did not carry the settled full-viewport month acrylic owner');
    }
    if (evidence.visuals.dayOutMaterialDiff.ratio > .01
      || evidence.visuals.dayOutMaterialDiff.meanChannelDelta > 2) {
      visualFailures.push(
        `day-out acrylic bands diverged from settled month `
        + `(${(evidence.visuals.dayOutMaterialDiff.ratio * 100).toFixed(3)}%, `
        + `${evidence.visuals.dayOutMaterialDiff.meanChannelDelta.toFixed(2)} mean channel delta)`,
      );
    }
    ['rootEntryMaterialDiff', 'rootReturnMaterialDiff'].forEach((name) => {
      const comparison = evidence.visuals[name];
      if (comparison.ratio > .01 || comparison.meanChannelDelta > 2) {
        visualFailures.push(
          `${name} diverged from resting root `
          + `(${(comparison.ratio * 100).toFixed(3)}%, `
          + `${comparison.meanChannelDelta.toFixed(2)} mean channel delta)`,
        );
      }
    });
    const rootDesign = evidence.visuals.rootControlGeometry?.design;
    if (rootDesign?.menuSurface !== false
      || rootDesign?.faceGlass !== true
      || !Array.isArray(rootDesign?.faceRect)
      || Math.abs(rootDesign.faceRect[1] - 12) > .5
      || Math.abs(rootDesign.faceRect[2] - 46) > .5
      || Math.abs(rootDesign.faceRect[3] - 46) > .5
      || rootDesign?.arrows?.length !== 2
      || rootDesign.arrows.some((arrow) => (
        arrow.glass !== true || arrow.secondary !== false || arrow.opacity !== 0
      ))) {
      visualFailures.push(
        `root year control did not retain the quiet top-date design `
        + `(${JSON.stringify(rootDesign)})`,
      );
    }
    ['topStripEntryDiff', 'topStripReturnDiff'].forEach((name) => {
      const comparison = evidence.visuals[name];
      if (comparison.ratio > .01 || comparison.meanChannelDelta > 2) {
        visualFailures.push(
          `${name} diverged from the resting year strip `
          + `(${(comparison.ratio * 100).toFixed(3)}%, `
          + `${comparison.meanChannelDelta.toFixed(2)} mean channel delta)`,
        );
      }
    });
    if (visualFailures.length) {
      throw new Error(`Calendar visual continuity budget missed: ${visualFailures.join('; ')}`);
    }
    fs.writeFileSync(
      CALENDAR_EVIDENCE_PATH,
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
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
