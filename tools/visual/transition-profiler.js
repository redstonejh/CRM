'use strict';

const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readyHome = () => document.body.dataset.crmModule === 'home'
  && !document.querySelector('.crm-home-surface')?.hidden
  && window.crmHome?.handStatus?.().ready
  && window.crmHome?.motionStatus?.().ready
  && window.crmHome?.previewStatus?.().every((item) => item.state === 'ready');

async function beginProbe(page, label) {
  await page.evaluate((probeLabel) => {
    const probe = {
      label:probeLabel, startedAt:performance.now(), previous:performance.now(),
      deltas:[], movingDeltas:[], samples:[], longTasks:[], firstMovingAt:null, done:false,
    };
    const observer = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => list.getEntries().forEach((entry) => {
        probe.longTasks.push({ at:entry.startTime - probe.startedAt, duration:entry.duration });
      }))
      : null;
    try { observer?.observe({ entryTypes:['longtask'] }); } catch {}
    const tick = (now) => {
      const delta = now - probe.previous;
      const moving = !!window.crmHomeCamera?.isTransitioning?.();
      probe.deltas.push(delta);
      if (moving) {
        probe.movingDeltas.push(delta);
        if (probe.firstMovingAt == null) probe.firstMovingAt = now;
      }
      probe.samples.push({
        at:now - probe.startedAt,
        delta,
        moving,
        module:document.body.dataset.crmModule || '',
        materializing:document.documentElement.classList.contains('crm-transit-materializing'),
        revealing:document.documentElement.classList.contains('crm-transit-revealing'),
        cameraProgress:moving && probe.firstMovingAt != null ? Math.min(1, (now - probe.firstMovingAt) / 460) : null,
      });
      probe.previous = now;
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
    const measured = probe.movingDeltas.slice(1);
    const sorted = [...measured].sort((a, b) => a - b);
    const total = measured.reduce((sum, value) => sum + value, 0);
    const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
    return {
      label:probe.label,
      frames:measured.length,
      fps:total ? measured.length * 1000 / total : 0,
      p95Ms:percentile(.95),
      p99Ms:percentile(.99),
      maxMs:sorted.at(-1) || 0,
      over20Ms:measured.filter((value) => value > 20).length,
      over34Ms:measured.filter((value) => value > 34).length,
      longTasks:probe.longTasks,
      revealFrames:probe.samples.filter((sample) => sample.moving && sample.revealing).length,
      slowFrames:probe.samples.filter((sample) => sample.moving && sample.delta > 20).map((sample) => ({
        at:Number(sample.at.toFixed(1)),
        delta:Number(sample.delta.toFixed(1)),
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
  await sleep(80);
  return finishProbe(page);
}

async function main() {
  const { apiUrl } = await start();
  const app = await electron.launch({
    args:['.'],
    cwd:path.resolve(__dirname, '..', '..'),
    env:{ ...process.env, CRM_API_URL:apiUrl, CRM_API_PORT:'3899' },
    timeout:30000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dashboard-booting') && window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction(readyHome, null, { timeout:60000 });
    await sleep(160);

    const before = await page.evaluate(() => {
      const bucket = document.querySelector('.crm-home-bucket[data-module="cases"]');
      const image = bucket?.querySelector('.crm-home-preview-foreground');
      return {
        bucketTransform:image ? getComputedStyle(image).transform : '',
        farShift:bucket?.querySelector('.crm-home-preview')?.style.getPropertyValue('--far-shift-y') || '',
      };
    });
    // Match a physical pointer interaction: entering a tile gives Chromium two
    // or more paints to upload the existing transition texture before click.
    await page.hover('.crm-home-bucket[data-module="cases"]');
    await sleep(160);

    const inbound = await profileMove(
      page,
      'cases-in',
      () => page.click('.crm-home-bucket[data-module="cases"]'),
      () => page.waitForFunction(() => document.body.dataset.crmModule === 'cases' && !window.crmDeskTransit?.isBusy?.(), null, { timeout:15000 }),
    );
    const outbound = await profileMove(
      page,
      'cases-out',
      () => page.evaluate(() => window.crmDeskTransit.driveTo('home')),
      () => page.waitForFunction(readyHome, null, { timeout:15000 }),
    );
    await page.hover('.crm-home-bucket[data-module="cases"]');
    await sleep(160);
    const repeatInbound = await profileMove(
      page,
      'cases-repeat-in',
      () => page.click('.crm-home-bucket[data-module="cases"]'),
      () => page.waitForFunction(() => document.body.dataset.crmModule === 'cases' && !window.crmDeskTransit?.isBusy?.(), null, { timeout:15000 }),
    );
    const repeatOutbound = await profileMove(
      page,
      'cases-repeat-out',
      () => page.evaluate(() => window.crmDeskTransit.driveTo('home')),
      () => page.waitForFunction(readyHome, null, { timeout:15000 }),
    );
    const evidence = { before, inbound, outbound, repeatInbound, repeatOutbound };
    console.log(JSON.stringify(evidence, null, 2));
    const warmMoves = [outbound, repeatInbound, repeatOutbound];
    if (before.bucketTransform !== 'none' || before.farShift
      || inbound.fps < 80 || inbound.maxMs > 55 || inbound.revealFrames
      || warmMoves.some((probe) => probe.fps < 95 || probe.p95Ms > 20.5 || probe.maxMs > 50 || probe.revealFrames)
      || [inbound, ...warmMoves].some((probe) => probe.longTasks.length)) {
      throw new Error(`Transition profiler missed its budget: ${JSON.stringify(evidence)}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
