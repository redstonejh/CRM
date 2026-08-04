'use strict';

// Captures the actual settled Electron Home surface. The browser-only visual
// harness cannot own Electron's canonical room-capture bridge, so its Home
// screenshot necessarily stops at "Preparing view" and must never be used as
// the finished visual baseline.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');
const { rosaDataset } = require('./seed.js');

const API_PORT = Number(process.env.CRM_NATIVE_HOME_API_PORT || 4269);
const STATIC_PORT = Number(process.env.CRM_NATIVE_HOME_STATIC_PORT || 4268);
const REST_FILTER = 'blur(0.65px)';

async function seedNativeHome(apiUrl) {
  const data = rosaDataset();
  const postEntity = async (entity, fields) => {
    const response = await fetch(`${apiUrl}/api/entities/${entity}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        fields,
        actor:'rosa',
        options:{ detail:`Seeded ${entity}` },
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Seeding ${entity}/${fields.id} failed: ${result.error}`);
  };
  const postDomain = async (resource, fields) => {
    const response = await fetch(`${apiUrl}/api/domain/${resource}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ fields }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Seeding ${resource}/${fields.id} failed: ${result.error}`);
  };
  const counts = {};
  const order = [
    'companies', 'contacts', 'deals', 'bills', 'invoices', 'tasks',
    'tickets', 'calendarItems', 'projects', 'workItems',
  ];
  for (const entity of order) {
    await Promise.all(data[entity].map((fields) => postEntity(entity, fields)));
    counts[entity] = data[entity].length;
  }
  // Interaction writes fan touch state onto related records and therefore stay
  // ordered; the independent bulk records above can safely seed concurrently.
  for (const fields of data.interactions) await postEntity('interactions', fields);
  counts.interactions = data.interactions.length;
  for (const fields of data.commitments) await postDomain('commitments', fields);
  counts.commitments = data.commitments.length;
  for (const fields of data.workflowEntries) await postDomain('workflow-entries', fields);
  counts.workflowEntries = data.workflowEntries.length;
  return counts;
}

async function main() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, 'electron-actual', '01-home-settled.png'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-native-home-'));
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const { apiUrl, stop } = await start({
    apiPort:API_PORT,
    staticPort:STATIC_PORT,
    seedFn:seedNativeHome,
  });
  let app = null;
  try {
    app = await electron.launch({
      args:['.', `--user-data-dir=${profile}`],
      cwd:path.resolve(__dirname, '..', '..'),
      env:{
        ...process.env,
        CRM_API_URL:apiUrl,
        CRM_API_PORT:String(API_PORT),
        CRM_CDMS_DISABLED:'1',
      },
      timeout:30000,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())
        || BrowserWindow.getAllWindows()[0];
      win?.setBounds({ x:0, y:0, width:1600, height:1000 });
    });
    await page.waitForLoadState('load');
    await page.waitForFunction(() =>
      !document.documentElement.hasAttribute('data-dashboard-booting')
      && !!window.crmWorkspaces, null, { timeout:30000 });
    await page.evaluate(() => window.crmWorkspaces.setActive('home'));
    await page.waitForFunction((restFilter) => {
      const previews = window.crmHome?.previewStatus?.() || [];
      const buckets = [...document.querySelectorAll('.crm-home-grid > .crm-home-bucket')];
      if (previews.length !== 6 || buckets.length !== 6
        || previews.some(({ state }) => state !== 'ready')) return false;
      return buckets.every((bucket) => {
        const host = bucket.querySelector('.crm-home-preview');
        const image = host?.querySelector(':scope > .crm-home-preview-foreground');
        const title = document.querySelector(
          `.crm-home-title-slot[data-module="${bucket.dataset.module}"] .crm-home-title`,
        );
        const bucketRect = bucket.getBoundingClientRect();
        const titleRect = title?.getBoundingClientRect();
        return !!title && host?.dataset.previewState === 'ready'
          && image?.complete && image.naturalWidth === innerWidth && image.naturalHeight === innerHeight
          && getComputedStyle(image).filter.includes(restFilter)
          && parseFloat(getComputedStyle(title).fontSize) >= 15
          && bucketRect.bottom - titleRect.bottom >= 24;
      });
    }, REST_FILTER, { timeout:60000 });
    await page.evaluate(() => window.crmHome?.waitForPreviewSync?.());
    await page.mouse.move(12, 400);
    await page.waitForTimeout(250);

    const finalState = await page.evaluate(() => ({
      module:document.body.dataset.crmModule,
      preparing:document.querySelectorAll(
        '.crm-home-grid > .crm-home-bucket > .crm-home-preview:not([data-preview-state="ready"])'
      ).length,
      previews:[...document.querySelectorAll('.crm-home-grid .crm-home-preview-foreground')]
        .map((image) => ({
          width:image.naturalWidth,
          height:image.naturalHeight,
          filter:getComputedStyle(image).filter,
        })),
    }));
    if (finalState.module !== 'home' || finalState.preparing !== 0
      || finalState.previews.length !== 6) {
      throw new Error(`Home was not settled for capture: ${JSON.stringify(finalState)}`);
    }
    await page.screenshot({ path:output });
    console.log(`[native-home] ${path.relative(process.cwd(), output)} ${JSON.stringify(finalState)}`);
  } finally {
    stop();
    if (app) {
      const processHandle = app.process();
      const exited = new Promise((resolve) => processHandle.once('exit', resolve));
      try { await app.evaluate(({ app:electronApp }) => electronApp.exit(0)); } catch {}
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (processHandle.exitCode == null) processHandle.kill();
    }
    try {
      fs.rmSync(profile, { recursive:true, force:true, maxRetries:8, retryDelay:250 });
    } catch (error) {
      console.warn(`[native-home] could not remove temporary profile ${profile}: ${error.message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
