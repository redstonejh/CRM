// CRM client — main process.
//
// This is the shared Electron shell with monitoring ingestion fully removed.
// CRM records live behind the Postgres API in server/; the legacy ticket bridge
// remains as a compatibility adapter while the card system is generalized.
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session as electronSession } from 'electron';
import path from 'path';
import fs from 'fs';
import squirrelStartup from 'electron-squirrel-startup';
import pngjs from 'pngjs';
import { icons } from './icons';
import auth from './auth.js';
import cdmsModule from './cdms-client.cjs';
import {
  initTickets, connectTickets, endTickets,
  ticketList, ticketConnectionState,
  claimTicket, unclaimTicket, assignTicket, resolveTicket, reopenTicket,
  commentTicket, updateTicket, createTicket, deleteTicket,
} from './tickets.js';
import {
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  storeConnectionState, storeConnectionInfo, storeHealth, reportSummary,
  listDomain, getDomain, createDomain, updateDomain, deleteDomain,
} from './store.js';
const { PNG } = pngjs;
const {
  createCdmsClient,
  CRM_OVERLAY_FIELDS,
  DEFAULT_CDMS_URL,
  normalizeCdmsUrl,
} = cdmsModule;

// Handle Squirrel.Windows install/update/uninstall events — must quit immediately.
if (squirrelStartup) app.quit();

// Kill the default application menu (File/Edit/View/Window/Help) for a chrome-free
// app. Must be called before any window is created.
Menu.setApplicationMenu(null);

// ─── Settings persistence ─────────────────────────────────────────────────────
// The CRM workflow API and CDMS source-of-truth API are separate coordinates.

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  apiUrl: process.env.CRM_API_URL || 'http://127.0.0.1:3899',
  cdmsUrl: process.env.CRM_CDMS_URL || process.env.CDMS_API_URL || DEFAULT_CDMS_URL,
};

function loadSettings() {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    // Explicit process configuration is authoritative for this launch. This
    // keeps managed deployments and isolated test instances from inheriting a
    // stale URL that a previous interactive session persisted.
    if (process.env.CRM_API_URL) merged.apiUrl = process.env.CRM_API_URL;
    if (process.env.CRM_CDMS_URL || process.env.CDMS_API_URL) {
      merged.cdmsUrl = process.env.CRM_CDMS_URL || process.env.CDMS_API_URL;
    }
    merged.apiUrl = normalizeApiUrl(merged.apiUrl) || DEFAULT_SETTINGS.apiUrl;
    merged.cdmsUrl = normalizeCdmsUrl(merged.cdmsUrl) || DEFAULT_SETTINGS.cdmsUrl;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function normalizeApiUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_SETTINGS.apiUrl;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// ─── App state ────────────────────────────────────────────────────────────────

let tray = null;
let mainWindow = null;
let previewWindow = null;
let exitRequested = false;
let ticketsEnded = false;
let settings = loadSettings();
const CRM_ENTITIES = ['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'assets', 'tasks', 'calendarItems', 'reports', 'bills', 'invoices', 'interactions', 'projects', 'workItems'];
const cdms = createCdmsClient({
  baseUrl: settings.cdmsUrl,
  disabled: process.env.CRM_CDMS_DISABLED === '1',
  onChange: ({ reason }) => handleCdmsChanged(reason),
});
const HOME_PREVIEW_KEYS = ['people', 'cases', 'planner', 'assignments'];
// Bump whenever room chrome changes in a way that makes an old raster false.
// The renderer refuses a different generation instead of briefly presenting
// stale arrows, controls, or styling while replacement captures are prepared.
const HOME_PREVIEW_VERSION = 'filtered-home-v46';
const homePreviewCache = new Map();
const homePreviewViewStates = new Map();
const homePreviewViewStateGenerations = new Map();
let homePreviewViewStateGeneration = 0;
const PROJECT_PREVIEW_VERSION = 'project-tile-v1';
const projectPreviewCache = new Map();
let homeMotionSnapshot = null;
let homeMotionSnapshotError = null;
let homePreviewResizeTimer = null;
let homePreviewBoundsKey = '';
let homePreviewQueue = Promise.resolve();
let homePreviewRefreshTimer = null;
let homePreviewStartupTimer = null;
let projectGalleryHomeRefreshTimer = null;
let projectPreviewCaptureCount = 0;
let plannerHomeCaptureRequestGeneration = 0;
let projectPreviewBatchPlannerGeneration = 0;
let homePreviewActivityGeneration = 0;
let homePreviewInteractionActive = false;
let homePreviewInteractionWaiters = [];

function setHomePreviewInteraction(active) {
  homePreviewInteractionActive = !!active;
  if (previewWindow && !previewWindow.isDestroyed()) {
    // The hidden renderer only paints static capture states. Throttle it to one
    // frame while the visible camera owns the GPU, then restore a deliberately
    // modest capture cadence after the handoff.
    try { previewWindow.webContents.setFrameRate(homePreviewInteractionActive ? 1 : 30); } catch {}
  }
  if (!homePreviewInteractionActive) {
    const waiters = homePreviewInteractionWaiters;
    homePreviewInteractionWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

function waitForHomePreviewInteraction() {
  return homePreviewInteractionActive
    ? new Promise((resolve) => homePreviewInteractionWaiters.push(resolve))
    : Promise.resolve();
}

// ─── Main window ────────────────────────────────────────────────────────────────
// Loaded from a STATIC file (dashboard/index.html), shipped as an extraResource —
// the same pattern the monitor uses for its dashboard. There is no Vite renderer.
// NO HOT-RELOAD: edits to dashboard/* need a window reload (Ctrl+R / the reload
// control / dash.reload() over CDP), not a code re-run.

function dashboardIndexPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dashboard', 'index.html');
  }
  const candidates = [
    path.join(app.getAppPath(), 'dashboard', 'index.html'),
    path.join(process.cwd(), 'dashboard', 'index.html'),
    path.join(__dirname, '..', '..', 'dashboard', 'index.html'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,            // the renderer will draw its own chrome (future UI)
    autoHideMenuBar: true,
    backgroundColor: '#10141c',
    webPreferences: {
      preload: path.join(__dirname, 'dashboard-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,        // lets dashboard-preload.js use node:fs for the layout store
    },
  });

  // Windows/Linux expose physical mouse Back/Forward buttons as app commands.
  // Keep them inside the CRM's viewport history instead of Electron's file URL
  // navigation, which has no understanding of the app's spatial cameras.
  mainWindow.on('app-command', (event, command) => {
    const direction = command === 'browser-backward' ? 'back' : command === 'browser-forward' ? 'forward' : '';
    if (!direction || !mainWindow || mainWindow.isDestroyed()) return;
    event.preventDefault();
    mainWindow.webContents.send('crm:navigation-command', direction);
  });

  mainWindow.loadFile(dashboardIndexPath());

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  // Every user-facing close path is a move to the tray. Only the explicit
  // tray-menu Exit command sets exitRequested and lets Electron destroy the
  // window. This also covers Alt+F4 and taskbar thumbnail Close, not just the
  // renderer's custom titlebar button.
  mainWindow.on('close', (event) => {
    if (exitRequested) return;
    event.preventDefault();
    hideMainWindow();
  });

  // Keep legacy/programmatic minimize calls consistent with the tray lifecycle.
  // The visible titlebar slot is now available to the renderer's contextual Add
  // control, but callers using the old API still get a safe background hide.
  mainWindow.on('minimize', () => {
    if (exitRequested) return;
    hideMainWindow();
  });

  // Windows does not emit before-quit/close during session shutdown. Flush the
  // backend lifecycle without blocking logout, restart, or shutdown.
  mainWindow.on('query-session-end', () => endTicketsOnce());
  mainWindow.on('session-end', () => endTicketsOnce());

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('tickets:changed', ticketsPayload());
    mainWindow.webContents.send('tickets:connection', ticketConnectionState());
    broadcastStore();
    homePreviewBoundsKey = previewBoundsKey(mainWindow);
    mainWindow.on('resize', scheduleHomePreviewBoundsRefresh);
    clearTimeout(homePreviewStartupTimer);
    homePreviewActivityGeneration += 1;
    homePreviewStartupTimer = setTimeout(() => {
      homePreviewStartupTimer = null;
      capturePreviewKeys(HOME_PREVIEW_KEYS, 'startup');
    }, 250);
  });

  mainWindow.on('closed', () => {
    clearTimeout(homePreviewResizeTimer);
    clearTimeout(homePreviewRefreshTimer);
    clearTimeout(homePreviewStartupTimer);
    clearTimeout(projectGalleryHomeRefreshTimer);
    homePreviewResizeTimer = null;
    homePreviewRefreshTimer = null;
    homePreviewStartupTimer = null;
    projectGalleryHomeRefreshTimer = null;
    homePreviewBoundsKey = '';
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
    previewWindow = null;
    mainWindow = null;
  });
  return mainWindow;
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.hide();
}

function showMainWindow() {
  const win = createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

// ─── Tickets → renderer broadcasts ──────────────────────────────────────────────

function openWindows() {
  return [mainWindow].filter((w) => w && !w.isDestroyed());
}

function ticketsPayload() {
  return { tickets: cdms.overlayRecords('tickets', ticketList()), connection: ticketConnectionState() };
}

function broadcastTickets() {
  const payload = ticketsPayload();
  openWindows().forEach((w) => w.webContents.send('tickets:changed', payload));
}

function broadcastTicketConnection(state) {
  openWindows().forEach((w) => w.webContents.send('tickets:connection', state));
}

function foregroundFromMattes(blackImage, whiteImage) {
  if (!blackImage || !whiteImage || blackImage.isEmpty() || whiteImage.isEmpty()) return null;
  const size = blackImage.getSize();
  const whiteSize = whiteImage.getSize();
  if (size.width !== whiteSize.width || size.height !== whiteSize.height) return null;
  const black = blackImage.toBitmap();
  const white = whiteImage.toBitmap();
  if (black.length !== white.length || black.length !== size.width * size.height * 4) return null;
  const png = new PNG({ width: size.width, height: size.height });
  const output = png.data;
  let minX = size.width, minY = size.height, maxX = -1, maxY = -1;
  for (let index = 0; index < black.length; index += 4) {
    const deltaB = Math.max(0, white[index] - black[index]);
    const deltaG = Math.max(0, white[index + 1] - black[index + 1]);
    const deltaR = Math.max(0, white[index + 2] - black[index + 2]);
    const alpha = Math.max(0, Math.min(255, 255 - Math.round((deltaB + deltaG + deltaR) / 3)));
    if (alpha <= 2) {
      output[index] = 0; output[index + 1] = 0; output[index + 2] = 0; output[index + 3] = 0;
      continue;
    }
    output[index] = Math.min(255, Math.round(black[index + 2] * 255 / alpha));
    output[index + 1] = Math.min(255, Math.round(black[index + 1] * 255 / alpha));
    output[index + 2] = Math.min(255, Math.round(black[index] * 255 / alpha));
    output[index + 3] = alpha;
    if (alpha > 12) {
      const pixel = index / 4;
      const x = pixel % size.width;
      const y = Math.floor(pixel / size.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const image = nativeImage.createFromBuffer(PNG.sync.write(png));
  const bounds = maxX >= minX && maxY >= minY
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : { x: 0, y: 0, width: size.width, height: size.height };
  return { image, bounds };
}

function transparentImageRegion(image, region, viewport) {
  if (!image || image.isEmpty() || !Array.isArray(region) || region.length < 4 || !Array.isArray(viewport) || viewport.length < 2) return '';
  const png = PNG.sync.read(image.toPNG());
  const regionValues = region.slice(0, 4).map(Number);
  if (!regionValues.every(Number.isFinite)) return '';
  const scaleX = png.width / Math.max(1, Number(viewport[0]) || png.width);
  const scaleY = png.height / Math.max(1, Number(viewport[1]) || png.height);
  const [regionX, regionY, regionWidth, regionHeight] = regionValues;
  const left = Math.min(png.width, Math.max(0, Math.floor(regionX * scaleX)));
  const top = Math.min(png.height, Math.max(0, Math.floor(regionY * scaleY)));
  const right = Math.min(png.width, Math.max(left, Math.ceil((regionX + regionWidth) * scaleX)));
  const bottom = Math.min(png.height, Math.max(top, Math.ceil((regionY + regionHeight) * scaleY)));
  for (let y = top; y < bottom; y += 1) png.data.fill(0, (y * png.width + left) * 4, (y * png.width + right) * 4);
  return nativeImage.createFromBuffer(PNG.sync.write(png)).toDataURL();
}

async function prepareCapture(win, matte = null, options = {}) {
  await waitForHomePreviewInteraction();
  const preserveHomePreviewFilter = options.preserveHomePreviewFilter === true;
  const homeMotionObjectsOnly = options.homeMotionObjectsOnly === true;
  const css = `
    *,*::before,*::after { animation:none !important; transition:none !important; }
    .window-control-cluster,.window-glass-control,.auth-profile-cluster,.workspace-menu-overlay-layer,.dashboard-search-popover,
    .crm-module-switch,.crm-viewport-date,.db-loading { display:none !important; }
    .crm-home-title-glass { display:none !important; }
    ${preserveHomePreviewFilter ? '' : '.crm-home-level > .crm-home-grid > .crm-home-bucket > .crm-home-preview > .crm-home-preview-foreground { filter:none !important; }'}
    ${homeMotionObjectsOnly ? '.crm-home-level > .crm-home-grid > .crm-home-bucket { -webkit-backdrop-filter:none !important; backdrop-filter:none !important; }' : ''}
    ${matte ? `html,body { --page-background:${matte} !important; --bg:${matte} !important; --bg-end:${matte} !important;
      background:${matte} !important; background-color:${matte} !important; }
      html::before,html::after,body::before,body::after,.workspace-photo-backdrop,.liquid-glass-webgl-canvas { display:none !important; }` : ''}
  `;
  await win.webContents.executeJavaScript(`(() => {
    window.__crmPreviewClasses ||= {
      htmlPhoto: document.documentElement.classList.contains('has-photo-background'),
      bodyPhoto: document.body.classList.contains('has-photo-background'),
      webgl: document.body.classList.contains('webgl-glass-on'),
    };
    document.activeElement?.blur?.();
    const original = window.__crmPreviewClasses;
    const matte = ${JSON.stringify(matte)};
    document.documentElement.classList.toggle('has-photo-background', !matte && original.htmlPhoto);
    document.body.classList.toggle('has-photo-background', !matte && original.bodyPhoto);
    document.body.classList.toggle('webgl-glass-on', !matte && original.webgl);
    let style = document.getElementById('crm-preview-capture-style');
    if (!style) { style = document.createElement('style'); style.id = 'crm-preview-capture-style'; document.head.appendChild(style); }
    style.textContent = ${JSON.stringify(css)};
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))));
  })()`, true);
  try { win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1, movementX: 0, movementY: 0 }); } catch {}
  win.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 60));
}

async function captureForeground(win, options = {}) {
  await waitForHomePreviewInteraction();
  await prepareCapture(win, '#000000', options);
  const black = await win.webContents.capturePage();
  await waitForHomePreviewInteraction();
  await prepareCapture(win, '#ffffff', options);
  const white = await win.webContents.capturePage();
  return foregroundFromMattes(black, white);
}

async function captureRoom(win) {
  await waitForHomePreviewInteraction();
  await prepareCapture(win, null);
  const exact = await win.webContents.capturePage();
  await waitForHomePreviewInteraction();
  const foreground = await captureForeground(win);
  if (!foreground || exact.isEmpty()) return null;
  return { exact, foreground: foreground.image, bounds: foreground.bounds };
}

function waitForRenderer(win, expression, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (!win || win.isDestroyed()) { reject(new Error('Preview renderer closed')); return; }
      try { if (await win.webContents.executeJavaScript(expression, true)) { resolve(); return; } } catch {}
      if (Date.now() - started >= timeoutMs) {
        let state = null;
        try {
          state = await win.webContents.executeJavaScript(`(() => ({
            readyState: document.readyState,
            booting: document.documentElement.hasAttribute('data-dashboard-booting'),
            module: document.body?.dataset?.crmModule || '',
            workspaces: !!window.crmWorkspaces,
            peopleCards: !!window.peopleCards,
            ticketStacks: !!window.ticketStacks,
            planner: !!window.crmPlanner,
            assignments: !!window.crmAssignments,
            theaters: [...document.querySelectorAll('[data-crm-theater]')].map((node) => ({
              key: node.dataset.crmTheater || '',
              hidden: node.hidden,
              children: node.childElementCount,
            })),
          }))()`, true);
        } catch {}
        reject(new Error(`Preview renderer timed out (${expression}): ${JSON.stringify(state)}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) return previewWindow;
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : { width: 1280, height: 860 };
  const worker = new BrowserWindow({
    width: bounds.width, height: bounds.height, show: false, frame: false,
    backgroundColor: '#10141c', paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'dashboard-preload.js'), nodeIntegration: false, contextIsolation: true,
      sandbox: false, offscreen: true, backgroundThrottling: false,
    },
  });
  previewWindow = worker;
  try { worker.webContents.setFrameRate(homePreviewInteractionActive ? 1 : 30); } catch {}
  worker.on('closed', () => { if (previewWindow === worker) previewWindow = null; });
  try {
    await worker.loadFile(dashboardIndexPath(), { query: { crmPreviewWorker: '1' } });
    await waitForRenderer(worker, `!document.documentElement.hasAttribute('data-dashboard-booting') && !!window.crmWorkspaces`);
    return worker;
  } catch (error) {
    if (!worker.isDestroyed()) worker.destroy();
    if (previewWindow === worker) previewWindow = null;
    throw error;
  }
}

function publishHomePreview(key, capture, layoutSignature, viewState = null) {
  if (!capture?.foreground || !capture?.exact) return null;
  const size = capture.exact.getSize();
  const preview = {
    key, version: HOME_PREVIEW_VERSION, width: size.width, height: size.height, capturedAt: Date.now(),
    foregroundSrc: capture.foreground.toDataURL(), exactSrc: capture.exact.toDataURL(),
    foregroundBounds: capture.bounds, layoutSignature, viewState,
  };
  homePreviewCache.set(key, preview);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('home-preview:changed', preview);
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('home-preview:changed', preview);
  return preview;
}

function publishProjectPreview(projectId, capture, viewState = null) {
  if (!capture?.foreground || !capture?.exact) return null;
  const size = capture.exact.getSize();
  const preview = {
    key:String(projectId), version:PROJECT_PREVIEW_VERSION, width:size.width, height:size.height, capturedAt:Date.now(),
    foregroundSrc:capture.foreground.toDataURL(), exactSrc:capture.exact.toDataURL(),
    foregroundBounds:capture.bounds, viewState,
  };
  projectPreviewCache.set(String(projectId), preview);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('project-preview:changed', preview);
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('project-preview:changed', preview);
  return preview;
}

function scheduleProjectGalleryHomeRefresh() {
  clearTimeout(projectGalleryHomeRefreshTimer);
  projectGalleryHomeRefreshTimer = setTimeout(() => {
    projectGalleryHomeRefreshTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) capturePreviewKeys(['planner'], 'project gallery ready');
  }, 220);
}

async function waitForProjectGalleryImages(worker) {
  await worker.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const settle = () => {
      const projectCount = window.crmPlanner?.projects?.().length || 0;
      const images = [...document.querySelectorAll('.crm-project-bucket[data-planner-project] > .crm-home-preview > .crm-home-preview-foreground')];
      if ((projectCount && images.length >= projectCount) || performance.now() - started >= 800) {
        Promise.race([
          Promise.all(images.map((image) => image.decode?.().catch(() => null))),
          new Promise((done) => setTimeout(done, 800)),
        ]).then(resolve);
        return;
      }
      setTimeout(settle, 40);
    };
    requestAnimationFrame(() => requestAnimationFrame(settle));
  })`, true);
}

function captureProjectPreview(projectId, viewState = {}) {
  const key = String(projectId || '').trim();
  if (!key) return Promise.resolve(null);
  clearTimeout(projectGalleryHomeRefreshTimer);
  projectGalleryHomeRefreshTimer = null;
  if (!projectPreviewCaptureCount) projectPreviewBatchPlannerGeneration = plannerHomeCaptureRequestGeneration;
  projectPreviewCaptureCount += 1;
  homePreviewActivityGeneration += 1;
  homePreviewQueue = homePreviewQueue.catch(() => null).then(async () => {
    let worker;
    try {
      await waitForHomePreviewInteraction();
      worker = await createPreviewWindow();
      await worker.webContents.executeJavaScript(`window.crmWorkspaces.setActive('planner')`, true);
      await waitForRenderer(worker, `document.body.dataset.crmModule === 'planner' && !!window.crmPlanner`);
      const state = { ...viewState, view:'project', selectedId:key };
      await worker.webContents.executeJavaScript(`window.crmHome?.applyCaptureState?.('planner', ${JSON.stringify(state)})`, true);
      await waitForRenderer(worker, `window.crmPlanner?.view?.() === 'project'
        && !!document.querySelector('.crm-planner-project-world .crm-planner-buckets')`);
      await worker.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))`, true);
      return publishProjectPreview(key, await captureRoom(worker), state);
    } catch (error) {
      console.error(`[project-preview] capture failed at ${key}:`, error?.message || error);
      return null;
    } finally {
      projectPreviewCaptureCount = Math.max(0, projectPreviewCaptureCount - 1);
      if (!projectPreviewCaptureCount) {
        // Reuse one renderer for the whole project batch, then retire it. A
        // subsequent Projects/Home capture starts with the completed cache
        // instead of the worker's pre-batch placeholder state.
        if (worker && !worker.isDestroyed()) worker.destroy();
        if (previewWindow === worker) previewWindow = null;
        if (plannerHomeCaptureRequestGeneration === projectPreviewBatchPlannerGeneration) scheduleProjectGalleryHomeRefresh();
      }
    }
  });
  return homePreviewQueue;
}

async function captureHomeMotionSnapshot(worker) {
  homeMotionSnapshotError = null;
  await waitForHomePreviewInteraction();
  await worker.webContents.executeJavaScript(`(async () => {
    const captureStyle = document.getElementById('crm-preview-capture-style');
    if (captureStyle) captureStyle.textContent = '';
    const original = window.__crmPreviewClasses;
    if (original) {
      document.documentElement.classList.toggle('has-photo-background', original.htmlPhoto);
      document.body.classList.toggle('has-photo-background', original.bodyPhoto);
      document.body.classList.toggle('webgl-glass-on', original.webgl);
    }
    window.crmWorkspaces.setActive('home');
    window.crmHome?.refresh?.();
    await window.crmHome?.ensureHandReady?.();
  })()`, true);
  await waitForRenderer(worker, `document.body.dataset.crmModule === 'home'
    && window.crmHome?.handStatus?.().ready
    && window.crmHome?.previewStatus?.().every((item) => item.state === 'ready')`);
  await worker.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))`, true);
  const layoutSignature = await worker.webContents.executeJavaScript(`window.crmHome?.motionLayoutSignature?.() || ''`, true);
  if (!layoutSignature) throw new Error('Home motion layout signature unavailable');
  // Capture Home's objects plus its translucent acrylic coat, never the fixed
  // workspace backdrop or a live backdrop filter. One cached texture can then
  // carry peripheral material without re-rasterizing moving glass every frame.
  const foreground = await captureForeground(worker, { preserveHomePreviewFilter: true, homeMotionObjectsOnly: true });
  if (!foreground?.image || foreground.image.isEmpty()) return null;
  const size = foreground.image.getSize();
  let layout = null;
  try { layout = JSON.parse(layoutSignature); } catch {}
  const [gridX = 0, gridY = 0] = (layout?.grid || []).map((value) => Number(value) || 0);
  const variants = Object.fromEntries((layout?.buckets || []).map((bucket) => {
    const [key] = bucket;
    // Canonical Home tiles carry both their unique tile id and viewport module
    // before the geometry. Accept the previous five-field signature as well
    // so an in-flight host/renderer refresh remains compatible.
    const geometry = bucket.length >= 6 ? bucket.slice(2, 6) : bucket.slice(1, 5);
    const [x = 0, y = 0, width = 0, height = 0] = geometry.map(Number);
    return [
      key,
      transparentImageRegion(foreground.image, [gridX + x, gridY + y, width, height], layout.viewport),
    ];
  }).filter(([key, src]) => !!key && !!src));
  homeMotionSnapshot = {
    version: HOME_PREVIEW_VERSION, width: size.width, height: size.height,
    capturedAt: Date.now(), src: foreground.image.toDataURL(), layoutSignature,
    foregroundBounds: foreground.bounds, backgroundMode: 'shared', materialMode: 'cached-acrylic', variants,
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('home-preview:motion-changed', homeMotionSnapshot);
  return homeMotionSnapshot;
}

function capturePreviewKeys(keys, label = 'refresh', viewStates = {}) {
  const requested = keys.filter((key) => HOME_PREVIEW_KEYS.includes(key));
  if (requested.includes('planner')) {
    plannerHomeCaptureRequestGeneration += 1;
    clearTimeout(projectGalleryHomeRefreshTimer);
    projectGalleryHomeRefreshTimer = null;
  }
  requested.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(viewStates || {}, key) || !viewStates[key]) return;
    homePreviewViewStates.set(key, viewStates[key]);
    homePreviewViewStateGenerations.set(key, ++homePreviewViewStateGeneration);
  });
  homePreviewActivityGeneration += 1;
  homePreviewQueue = homePreviewQueue.then(async () => {
    let worker;
    let activeCaptureKey = 'boot';
    try {
      worker = await createPreviewWindow();
      for (const key of requested) {
        await waitForHomePreviewInteraction();
        activeCaptureKey = key;
        await worker.webContents.executeJavaScript(`window.crmWorkspaces.setActive(${JSON.stringify(key)})`, true);
        await waitForRenderer(worker, `document.body.dataset.crmModule === ${JSON.stringify(key)} && !!document.querySelector('[data-crm-theater]:not([hidden])')`);
        const viewStateGeneration = homePreviewViewStateGenerations.get(key) || 0;
        const viewState = viewStates?.[key] ?? homePreviewViewStates.get(key) ?? null;
        if (viewState) {
          await worker.webContents.executeJavaScript(`window.crmHome?.applyCaptureState?.(${JSON.stringify(key)}, ${JSON.stringify(viewState)})`, true);
        }
        if (key === 'planner') await waitForProjectGalleryImages(worker);
        await worker.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))`, true);
        const layoutSignature = await worker.webContents.executeJavaScript(`(() => {
          const theater = document.querySelector('[data-crm-theater]:not([hidden])');
          const selector = '.tk-zone[data-stage],.tk-card[data-id],.tk-zcard[data-id],.crm-planner-bucket[data-planner-bucket],.crm-planner-card[data-planner-card],.crm-assignment-bucket[data-assignment-stage],.crm-assignment-work-card[data-assignment-card]';
          const objects = [...(theater?.querySelectorAll(selector) || [])].map((node) => [
            node.dataset.id || node.dataset.plannerBucket || node.dataset.plannerCard || node.dataset.assignmentStage || node.dataset.assignmentCard || node.dataset.stage || '',
            node.getAttribute('aria-label') || node.querySelector(':scope > .tk-zone-hd .tk-zone-title')?.textContent?.trim() || '',
            node.classList.contains('crm-object-small') ? 'small' : 'large',
            node.classList.contains('is-stack-expanded') ? 'expanded' : 'stacked',
          ]);
          return { module: document.body.dataset.crmModule || '', objects, calendarYear: window.fractalCalendar?.year?.() || null };
        })()`, true);
        const capture = await captureRoom(worker);
        // An explicit room-state request may arrive while a broad background
        // refresh is already painting this key. Never publish that older frame:
        // the queued stateful capture must be the observable handoff.
        if ((homePreviewViewStateGenerations.get(key) || 0) !== viewStateGeneration) continue;
        publishHomePreview(key, capture, layoutSignature, viewState);
      }
      // A one-room refresh (for example after a Large/Small choice) must also
      // refresh the resting Home composite. Otherwise the reverse camera would
      // briefly fly toward the old-size snapshot before handing off to Home.
      if (requested.length) {
        activeCaptureKey = 'home-motion';
        await captureHomeMotionSnapshot(worker);
      }
    } catch (error) {
      homeMotionSnapshotError = `${activeCaptureKey}: ${String(error?.stack || error?.message || error)}`;
      console.error(`[home-preview] ${label} capture failed at ${activeCaptureKey}:`, error?.message || error);
    } finally {
      if (worker && !worker.isDestroyed()) worker.destroy();
      if (previewWindow === worker) previewWindow = null;
    }
    return requested.length === 1 ? homePreviewCache.get(requested[0]) || null : null;
  });
  return homePreviewQueue;
}

function scheduleHomePreviewRefresh(label = 'store change', delay = 700) {
  clearTimeout(homePreviewRefreshTimer);
  homePreviewActivityGeneration += 1;
  homePreviewRefreshTimer = setTimeout(() => {
    homePreviewRefreshTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    capturePreviewKeys(HOME_PREVIEW_KEYS, label);
  }, delay);
}

function previewBoundsKey(win) {
  if (!win || win.isDestroyed()) return '';
  const { width, height } = win.getContentBounds();
  return `${width}x${height}`;
}

function scheduleHomePreviewBoundsRefresh() {
  clearTimeout(homePreviewResizeTimer);
  homePreviewActivityGeneration += 1;
  homePreviewResizeTimer = setTimeout(() => {
    homePreviewResizeTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const nextBoundsKey = previewBoundsKey(mainWindow);
    if (!nextBoundsKey || nextBoundsKey === homePreviewBoundsKey) return;
    homePreviewBoundsKey = nextBoundsKey;
    // Keep the existing pixels on screen while their correctly-sized
    // replacements are prepared; the renderer rejects them for motion as soon
    // as its viewport signature changes, so no stale raster can enter a dive.
    capturePreviewKeys(HOME_PREVIEW_KEYS, 'window resize');
  }, 260);
}

function storePayload(entity, options = {}) {
  const localRecords = entity === 'assets' ? [] : listRecords(entity, options);
  return {
    entity,
    records: cdms.overlayRecords(entity, localRecords),
    connection: storeConnectionState(),
    source: cdms.status(),
  };
}

const REPORT_IDENTITY_FIELDS = [
  'source', 'readOnly', 'referenceSource', 'cdmsReference',
  'companyId', 'company', 'companyName', 'companyLabel', 'companyCode', 'cdmsCompanyId',
  'contactId', 'contact', 'contactName', 'ownerContactId', 'assignedContactId', 'cdmsContactId',
  'assetId', 'cdmsAssetId', 'ipAddress', 'host',
  'username', 'email', 'phone', 'role', 'owner', 'assignee',
];

function reportEntity(row) {
  const raw = String(row?.entity || row?.type || '').trim();
  const lower = raw.toLowerCase();
  const aliases = {
    ticket: 'tickets', contact: 'contacts', company: 'companies', deal: 'deals',
    task: 'tasks', invoice: 'invoices', calendar: 'calendarItems',
    calendaritem: 'calendarItems', calendaritems: 'calendarItems',
  };
  return aliases[lower] || raw;
}

function reportTitle(entity, record, fallback) {
  const values = entity === 'tickets' || entity === 'cases' || entity === 'jobs'
    ? [record?.companyLabel, record?.company, record?.client, record?.title, record?.name]
    : [record?.title, record?.name, record?.client, record?.companyLabel, record?.company];
  values.push(fallback);
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || 'Untitled';
}

function mergeReportIdentity(row, entity, record, { replaceId = false } = {}) {
  if (!record) return row;
  const output = { ...row };
  if (replaceId && record.id) output.id = record.id;
  output.title = reportTitle(entity, record, row.title);
  REPORT_IDENTITY_FIELDS.forEach((field) => {
    const value = record[field];
    if (value !== undefined && value !== null && value !== '') output[field] = value;
  });
  return output;
}

function decorateReportPayload(payload) {
  const status = cdms.status();
  if (!payload?.summary?.datasets || status.connection !== 'live' || !status.contacts) return payload;
  const datasets = payload.summary.datasets;
  const rows = Object.values(datasets).flatMap((value) => Array.isArray(value) ? value : []);
  const contactIds = rows.filter((row) => reportEntity(row) === 'contacts').map((row) => String(row.id || '')).filter(Boolean);
  const companyIds = rows.filter((row) => reportEntity(row) === 'companies').map((row) => String(row.id || '')).filter(Boolean);
  const contactReferences = cdms.referencesFor('contacts', contactIds);
  const companyReferences = cdms.referencesFor('companies', companyIds);
  let linkedRows = 0;

  const decoratedDatasets = Object.fromEntries(Object.entries(datasets).map(([key, value]) => {
    if (!Array.isArray(value)) return [key, value];
    return [key, value.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const entity = reportEntity(row);
      let record = null;
      let replaceId = false;
      if (entity === 'contacts') {
        record = contactReferences.get(String(row.id || '')) || null;
        replaceId = true;
      } else if (entity === 'companies') {
        record = companyReferences.get(String(row.id || '')) || null;
        replaceId = true;
      } else {
        try { record = getRecord(entity, row.id); } catch {}
        record = cdms.decorateRecord(entity, record || row);
      }
      if (record?.source === 'cdms' || record?.cdmsReference || record?.referenceSource === 'cdms') linkedRows += 1;
      return mergeReportIdentity(row, entity, record, { replaceId });
    })];
  }));

  return {
    ...payload,
    identitySource: 'cdms',
    summary: {
      ...payload.summary,
      identitySource: 'cdms',
      identityCounts: {
        companies: status.companies,
        contacts: status.contacts,
        assets: status.assets,
        linkedRows,
      },
      datasets: decoratedDatasets,
    },
  };
}

function broadcastStore(entity = null) {
  const entities = entity ? [entity] : CRM_ENTITIES;
  openWindows().forEach((w) => {
    entities.forEach((name) => {
      const payload = storePayload(name);
      w.webContents.send('store:changed', payload);
      w.webContents.send(`store:${name}:changed`, payload);
    });
  });
}

function handleCdmsChanged(reason = 'cdms') {
  broadcastAuth();
  broadcastTickets();
  broadcastStore();
  refreshTray();
  scheduleHomePreviewRefresh(`CDMS ${reason}`, 300);
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function buildContextMenu() {
  const s = identitySession();
  const who = s.user ? `Signed in as ${s.user.username}` : 'Not signed in';
  const open = ticketList().filter((t) => t.state !== 'resolved').length;
  return Menu.buildFromTemplate([
    { label: `CRM — ${open} open tickets`, enabled: false },
    { label: who, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => showMainWindow() },
    { label: 'Exit', click: () => requestAppExit() },
  ]);
}

function endTicketsOnce() {
  if (ticketsEnded) return;
  ticketsEnded = true;
  try {
    endTickets();
  } catch (error) {
    // Cleanup must never strand the user in a process that cannot exit.
    console.error('[crm] Ticket shutdown cleanup failed:', error);
  }
}

function requestAppExit() {
  if (exitRequested) return;
  exitRequested = true;
  endTicketsOnce();
  app.quit();
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(ticketConnectionState() === 'live' ? icons.blue : icons.grey);
  const open = ticketList().filter((t) => t.state !== 'resolved').length;
  tray.setToolTip(open ? `CRM — ${open} open tickets` : 'CRM');
}

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function identitySession() {
  const cdmsSession = cdms.session();
  if (cdmsSession.connection === 'live') return cdmsSession;
  const local = auth.session();
  return {
    ...local,
    provider: 'local',
    authDisabled: false,
    connection: cdmsSession.connection,
    cdmsUrl: cdmsSession.cdmsUrl,
    cdmsError: cdmsSession.error || null,
  };
}

function broadcastAuth() {
  const payload = identitySession();
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('auth:changed', payload);
  });
}

function canManageUsers() {
  const s = identitySession();
  return !!(s.user && (s.user.isAdmin || s.user.permissions.canManageUsers));
}

// The signed-in user actor for ticket actions, or null when nobody is signed in.
function actor() {
  return identitySession().user?.username || null;
}

// ─── IPC: auth ──────────────────────────────────────────────────────────────────
// CDMS is authoritative whenever it is reachable. The original local account
// store remains an offline fallback so a CDMS outage cannot strand local work.

ipcMain.handle('auth:session', () => identitySession());

ipcMain.handle('auth:login', async (_e, { username, password } = {}) => {
  const cdmsSession = cdms.session();
  const result = cdmsSession.connection === 'live'
    ? await cdms.login(username, password)
    : auth.login(username, password);
  if (result.ok) { broadcastAuth(); refreshTray(); }
  return result;
});

ipcMain.handle('auth:logout', async () => {
  const cdmsSession = cdms.session();
  const result = cdmsSession.connection === 'live'
    ? await cdms.logout()
    : auth.logout();
  broadcastAuth();
  refreshTray();
  return result;
});

ipcMain.handle('auth:register', (_e, payload) => {
  if (cdms.session().connection === 'live') return { ok: false, error: 'Create CDMS accounts in CDMS' };
  const result = auth.register(payload || {});
  if (result.ok) { broadcastAuth(); refreshTray(); }
  return result;
});

ipcMain.handle('auth:set-password', (_e, { password } = {}) => {
  if (cdms.session().connection === 'live') return { ok: false, error: 'Change your password in CDMS' };
  const result = auth.setOwnPassword(password);
  if (result.ok) broadcastAuth();
  return result;
});

ipcMain.handle('auth:list-users', () => (
  identitySession().provider === 'local' && canManageUsers()
    ? { ok: true, users: auth.listUsers() }
    : { ok: false, error: 'CDMS accounts are managed in CDMS' }
));
ipcMain.handle('auth:create-user', (_e, payload) => (
  identitySession().provider === 'local' && canManageUsers()
    ? auth.createUser(payload || {})
    : { ok: false, error: 'CDMS accounts are managed in CDMS' }
));
ipcMain.handle('auth:update-user', (_e, { username, ...rest } = {}) => (
  identitySession().provider === 'local' && canManageUsers()
    ? auth.updateUser(username, rest)
    : { ok: false, error: 'CDMS accounts are managed in CDMS' }
));
ipcMain.handle('auth:delete-user', (_e, { username } = {}) => (
  identitySession().provider === 'local' && canManageUsers()
    ? auth.deleteUser(username)
    : { ok: false, error: 'CDMS accounts are managed in CDMS' }
));

// Synchronous lookup so dashboard-preload.js can namespace the layout store.
ipcMain.on('auth:current-username', (e) => { e.returnValue = identitySession().user?.username || ''; });

// ─── IPC: settings (API) ────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', async (_e, next = {}) => {
  const apiUrl = normalizeApiUrl(next.apiUrl ?? settings.apiUrl);
  if (!apiUrl) return { ok: false, error: 'API URL must be an http(s) URL' };
  const cdmsUrl = normalizeCdmsUrl(next.cdmsUrl ?? settings.cdmsUrl);
  if (!cdmsUrl) return { ok: false, error: 'CDMS URL must be an http(s) URL' };
  const cdmsChanged = cdmsUrl !== settings.cdmsUrl;
  settings = { ...settings, ...next, apiUrl, cdmsUrl };
  saveSettings(settings);
  connectTickets({ url: settings.apiUrl });
  if (cdmsChanged) {
    await cdms.initialize({
      baseUrl: settings.cdmsUrl,
      fetcher: electronSession.defaultSession.fetch.bind(electronSession.defaultSession),
      disabled: process.env.CRM_CDMS_DISABLED === '1',
    });
  }
  broadcastStore();
  return { ok: true, settings, connection: storeConnectionInfo(), cdms: cdms.status() };
});
ipcMain.handle('backend:connection', () => ({ ok: true, settings, connection: storeConnectionInfo(), cdms: cdms.status() }));
ipcMain.handle('backend:status', async () => {
  const health = await storeHealth();
  return {
    ok: health.ok,
    settings,
    connection: storeConnectionInfo(),
    health,
    cdms: cdms.status(),
    error: health.error || null,
  };
});

// ─── IPC: CDMS source data ──────────────────────────────────────────────────────

ipcMain.handle('cdms:status', () => cdms.status());
ipcMain.handle('cdms:refresh', () => cdms.refreshCatalog({ force: true }));
ipcMain.handle('cdms:catalog', () => cdms.catalog());
ipcMain.handle('cdms:company-profile', (_event, { companyId, force = false } = {}) => (
  cdms.companyProfile(String(companyId || ''), { force: !!force })
));

// ─── IPC: window controls ────────────────────────────────────────────────────────

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('dashboard:open', () => { showMainWindow(); return { ok: true }; });

function isMainSender(e) {
  return mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
}
function isPreviewSender(e) {
  return previewWindow && !previewWindow.isDestroyed() && e.sender === previewWindow.webContents;
}

// Calendar motion only needs one immutable, tightly bounded compositor sample:
// the visible year-strip border box. Its outer shadow is transferred from the
// same computed native style in the renderer, so the capture never flattens
// or occludes neighboring Calendar content.
// The renderer cannot supply a rectangle (or any other capture argument);
// main derives and validates the exact region from the authenticated main
// window before and after capture so this cannot become a generic screenshot
// bridge.
const CALENDAR_STRIP_CAPTURE_PADDING = 0;
let calendarStripCapturePending = 0;
let calendarStripCaptureLastError = '';
let calendarStripCaptureWorkerCreatedCount = 0;
let calendarStripCaptureWorkerDestroyedCount = 0;
const calendarStripRectIsValid = (rect, contentWidth, contentHeight) => {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return false;
  const center = rect.x + (rect.width / 2);
  return rect.width >= 100
    && rect.width <= 240
    && rect.height >= 40
    && rect.height <= 90
    && rect.y >= 48
    && rect.y <= 104
    && rect.x >= 0
    && rect.x + rect.width <= contentWidth
    && rect.y + rect.height <= contentHeight
    && Math.abs(center - (contentWidth / 2)) <= 4;
};
const calendarStripState = async (win, { requireVisible = false } = {}) => {
  if (!win || win.isDestroyed()) return null;
  const state = await win.webContents.executeJavaScript(`(() => {
    const calendar = window.fractalCalendar;
    const camera = window.fractalCalendarCamera;
    const surface = camera?.surface?.();
    if (!calendar || !camera || !surface
      || document.body?.dataset?.crmModule !== 'calendar'
      || !camera.isActive?.()
      || camera.isTransitioning?.()
      || surface.hidden
      || surface.classList.contains('fc-camera-moving')) return null;
    const request = calendar.stripCaptureRequestState?.();
    const root = camera.layers?.()?.[0];
    const strips = root instanceof HTMLElement
      ? [...root.children].filter((node) => node.matches?.('.fc-year-strip'))
      : [];
    if (!request || strips.length !== 1) return null;
    const strip = strips[0];
    const label = strip.querySelector(':scope > .fc-year-label');
    const rect = strip.getBoundingClientRect();
    const style = getComputedStyle(strip);
    const viewport = camera.expRect?.();
    if (!label || !viewport
      || strip.classList.contains('fc-year-strip-portal')
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || ![viewport.x, viewport.y, viewport.w, viewport.h].every(Number.isFinite)) return null;
    const geometry = [
      innerWidth, innerHeight,
      viewport.x.toFixed(2), viewport.y.toFixed(2),
      viewport.w.toFixed(2), viewport.h.toFixed(2),
    ].join('|');
    const level = Number(camera.level?.());
    const year = Number(label.textContent?.trim());
    return {
      ready:request.ready === true
        && request.geometry === geometry
        && rect.width >= 100
        && rect.height >= 40,
      visible:level === 0
        && style.visibility !== 'hidden'
        && Number(style.opacity) > .99,
      captureKey:String(request.captureKey || ''),
      captureRevision:String(request.captureRevision || ''),
      visualSignature:String(request.visualSignature || ''),
      geometry,
      rect:{ x:rect.x, y:rect.y, width:rect.width, height:rect.height },
      dpr:devicePixelRatio,
      year,
      level,
      backgroundTone:String(document.documentElement.dataset.background || ''),
      verifiedCalendarYear:Number(calendar.year?.()),
      verifiedLevel:level,
      verifiedActive:calendar.isActive?.(),
      verifiedModule:document.body.dataset.crmModule,
    };
  })()`, true);
  if (!state || state.ready !== true || typeof state.captureKey !== 'string') return null;
  if (!state.captureKey || state.captureKey.length > 512) return null;
  if (state.verifiedActive !== true
    || state.verifiedModule !== 'calendar'
    || Number(state.year) !== Number(state.verifiedCalendarYear)
    || Number(state.level) !== Number(state.verifiedLevel)
    || ![0, 1, 2].includes(Number(state.level))
    || (requireVisible && (state.visible !== true || Number(state.level) !== 0))) return null;
  const year = Number(state.year);
  if (!Number.isInteger(year) || year < 1901 || year > 2200) return null;
  const captureRevision = String(state.captureRevision || '');
  if (!/^[a-z0-9]+$/i.test(captureRevision) || captureRevision.length > 64) return null;
  if (typeof state.visualSignature !== 'string'
    || !/^[a-z0-9]+$/i.test(state.visualSignature)
    || state.visualSignature.length > 64
    || typeof state.geometry !== 'string'
    || !state.geometry
    || state.geometry.length > 256) return null;
  if (!/^(?:tone-(?:light-grey|grey|dark-grey|black)|photo-(?:bark|cloud|jungle|moss|sand|shore|turf|water|water2|denim|marble|leather|texture|paint|paintspill|city|modern|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)|solar-system)$/.test(
    String(state.backgroundTone || ''),
  )) return null;
  const rect = {
    x:Number(state.rect?.x),
    y:Number(state.rect?.y),
    width:Number(state.rect?.width),
    height:Number(state.rect?.height),
  };
  const [contentWidth, contentHeight] = win.getContentSize();
  if (!calendarStripRectIsValid(rect, contentWidth, contentHeight)) return null;
  const dpr = Number(state.dpr);
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 4) return null;
  return {
    captureKey:state.captureKey,
    captureRevision,
    rect,
    dpr,
    contentWidth,
    contentHeight,
    visible:state.visible === true,
    level:Number(state.level),
    year,
    backgroundTone:String(state.backgroundTone),
    geometry:state.geometry,
    visualSignature:state.visualSignature,
  };
};
const calendarStripRendererAudit = async (win) => {
  if (!win || win.isDestroyed()) return { destroyed:true };
  try {
    const state = await win.webContents.executeJavaScript(`(() => {
      const calendar = window.fractalCalendar;
      const camera = window.fractalCalendarCamera;
      const request = calendar?.stripCaptureRequestState?.() || null;
      const root = camera?.layers?.()?.[0];
      const strip = root instanceof HTMLElement
        ? [...root.children].find((node) => node.matches?.('.fc-year-strip'))
        : null;
      const rect = strip?.getBoundingClientRect?.();
      return {
        booting:document.documentElement.hasAttribute('data-dashboard-booting'),
        module:String(document.body?.dataset?.crmModule || ''),
        calendarPresent:!!calendar,
        cameraPresent:!!camera,
        active:calendar?.isActive?.() === true,
        year:Number(calendar?.year?.()),
        level:Number(calendar?.level?.()),
        rect:rect ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height } : null,
        dpr:Number(devicePixelRatio),
        geometry:String(request?.geometry || ''),
        tone:String(document.documentElement.dataset.background || ''),
        signature:String(request?.visualSignature || ''),
        revision:String(request?.captureRevision || ''),
        key:String(request?.captureKey || ''),
        requestReady:request?.ready === true,
        requestVisible:request?.visible === true,
      };
    })()`, true);
    return {
      ...state,
      contentSize:win.getContentSize(),
      destroyed:win.isDestroyed(),
    };
  } catch (error) {
    return {
      error:String(error?.message || error || 'Calendar renderer audit failed'),
      destroyed:win.isDestroyed(),
    };
  }
};
const calendarStripStatesMatch = (before, after) => !!before
  && !!after
  && after.captureKey === before.captureKey
  && after.captureRevision === before.captureRevision
  && after.visualSignature === before.visualSignature
  && after.geometry === before.geometry
  && after.backgroundTone === before.backgroundTone
  && after.year === before.year
  && after.level === before.level
  && after.visible === before.visible
  && after.contentWidth === before.contentWidth
  && after.contentHeight === before.contentHeight
  && Math.abs(after.dpr - before.dpr) <= .01
  && ['x', 'y', 'width', 'height'].every(
    (property) => Math.abs(after.rect[property] - before.rect[property]) <= .1,
  );
const captureCalendarStripRegion = async (win, before) => {
  const left = Math.max(0, Math.floor(before.rect.x - CALENDAR_STRIP_CAPTURE_PADDING));
  const top = Math.max(0, Math.floor(before.rect.y - CALENDAR_STRIP_CAPTURE_PADDING));
  const right = Math.min(
    before.contentWidth,
    Math.ceil(before.rect.x + before.rect.width + CALENDAR_STRIP_CAPTURE_PADDING),
  );
  const bottom = Math.min(
    before.contentHeight,
    Math.ceil(before.rect.y + before.rect.height + CALENDAR_STRIP_CAPTURE_PADDING),
  );
  const captureRect = { x:left, y:top, width:right - left, height:bottom - top };
  if (captureRect.width < before.rect.width || captureRect.height < before.rect.height) {
    throw new Error('Calendar strip capture bounds are invalid');
  }
  const captureOptions = {
    stayHidden:!win.isVisible(),
    stayAwake:true,
  };
  const image = await win.webContents.capturePage(captureRect, captureOptions);
  const after = await calendarStripState(win, { requireVisible:true });
  if (!calendarStripStatesMatch(before, after)) {
    const error = new Error('Calendar strip changed during capture');
    error.calendarStripCapture = {
      kind:'state-mismatch',
      before,
      after,
      imageEmpty:image.isEmpty(),
      windowVisible:win.isVisible(),
      captureOptions,
    };
    throw error;
  }
  if (image.isEmpty()) {
    const error = new Error('Calendar strip capture returned an empty bitmap');
    error.calendarStripCapture = {
      kind:'empty-bitmap',
      before,
      after,
      imageEmpty:true,
      windowVisible:win.isVisible(),
      captureOptions,
    };
    throw error;
  }
  const pixelSize = image.getSize();
  const expectedWidth = captureRect.width * before.dpr;
  const expectedHeight = captureRect.height * before.dpr;
  if (Math.abs(pixelSize.width - expectedWidth) > 2
    || Math.abs(pixelSize.height - expectedHeight) > 2
    || pixelSize.width > 2048
    || pixelSize.height > 1024) {
    throw new Error('Calendar strip capture pixel size is invalid');
  }
  return {
    image,
    captureRect,
    stripRect:before.rect,
    pixelSize,
    dpr:before.dpr,
    stateAfter:after,
  };
};
const captureCalendarStripOffscreen = async (request, audit) => {
  const worker = new BrowserWindow({
    width:request.contentWidth,
    height:request.contentHeight,
    show:false,
    frame:false,
    backgroundColor:'#10141c',
    paintWhenInitiallyHidden:true,
    webPreferences:{
      preload:path.join(__dirname, 'dashboard-preload.js'),
      nodeIntegration:false,
      contextIsolation:true,
      sandbox:false,
      offscreen:true,
      backgroundThrottling:false,
    },
  });
  calendarStripCaptureWorkerCreatedCount += 1;
  audit.worker = {
    createdIndex:calendarStripCaptureWorkerCreatedCount,
    boot:null,
    validatedState:null,
    final:null,
    captureResolved:false,
    destroyedCountAtCaptureResolved:null,
    destroyedAfterCaptureResolved:false,
    destroyed:false,
  };
  try {
    try { worker.webContents.setFrameRate(30); } catch {}
    await worker.loadFile(dashboardIndexPath(), {
      query:{ crmPreviewWorker:'1', crmCalendarStripWorker:'1' },
    });
    await waitForRenderer(
      worker,
      `!document.documentElement.hasAttribute('data-dashboard-booting')
        && !!window.crmWorkspaces && !!window.fractalCalendar`,
    );
    audit.worker.boot = await calendarStripRendererAudit(worker);
    await worker.webContents.executeJavaScript(`(async () => {
      const backgroundTone = ${JSON.stringify(request.backgroundTone)};
      const backgroundOptions = [...document.querySelectorAll('[data-background-tone]')]
        .filter((node) => node.dataset.backgroundTone === backgroundTone);
      if (backgroundOptions.length !== 1) {
        throw new Error('Canonical background option unavailable');
      }
      backgroundOptions[0].click();
      await Promise.resolve(window.__dashboardBackgroundPreloadReady).catch(() => null);
      window.crmWorkspaces.setActive('calendar');
      await window.fractalCalendar.applyHomePreviewState({
        year:${JSON.stringify(request.year)},
        camera:{ level:0, selectors:[] },
      });
      await window.fractalCalendar.refresh();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`, true);
    await waitForRenderer(
      worker,
      `document.body.dataset.crmModule === 'calendar'
        && window.fractalCalendar?.year?.() === ${JSON.stringify(request.year)}
        && (() => {
          const state = window.fractalCalendar?.stripCaptureState?.();
          if (!state?.ready) return false;
          if (window.__crmCalendarStripStableKey !== state.captureKey) {
            window.__crmCalendarStripStableKey = state.captureKey;
            window.__crmCalendarStripStableSince = performance.now();
            return false;
          }
          return performance.now() - window.__crmCalendarStripStableSince >= 220;
        })()`,
    );
    const workerState = await calendarStripState(worker, { requireVisible:true });
    audit.worker.validatedState = workerState;
    const sameGeometry = workerState
      && ['x', 'y', 'width', 'height'].every(
        (property) => Math.abs(workerState.rect[property] - request.rect[property]) <= .1,
      );
    const mismatches = [
      !workerState && 'state',
      workerState && !sameGeometry && 'geometry',
      workerState && workerState.captureKey !== request.captureKey && 'capture-key',
      workerState && workerState.captureRevision !== request.captureRevision && 'capture-revision',
      workerState && workerState.visualSignature !== request.visualSignature && 'visual-signature',
      workerState && workerState.backgroundTone !== request.backgroundTone && 'background-tone',
      workerState && Math.abs(workerState.dpr - request.dpr) > .01 && 'dpr',
    ].filter(Boolean);
    if (mismatches.length) {
      throw new Error(`Offscreen Calendar strip mismatch: ${mismatches.join(', ')}`);
    }
    const capture = await captureCalendarStripRegion(worker, workerState);
    audit.worker.captureResolved = true;
    audit.worker.destroyedCountAtCaptureResolved = calendarStripCaptureWorkerDestroyedCount;
    return capture;
  } finally {
    audit.worker.final = await calendarStripRendererAudit(worker);
    audit.worker.destroyedAfterCaptureResolved = audit.worker.captureResolved === true;
    if (!worker.isDestroyed()) worker.destroy();
    calendarStripCaptureWorkerDestroyedCount += 1;
    audit.worker.destroyed = worker.isDestroyed();
    audit.worker.destroyedIndex = calendarStripCaptureWorkerDestroyedCount;
  }
};
let calendarStripCaptureQueue = Promise.resolve();

ipcMain.handle('dashboard-window:reload', (e) => { if (isMainSender(e)) mainWindow.webContents.reload(); return { ok: true }; });
ipcMain.handle('dashboard-window:minimize', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });
ipcMain.handle('dashboard-window:close', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });
ipcMain.handle('calendar-transition:capture-strip', async (event) => {
  if (!isMainSender(event) || !mainWindow.isVisible()) {
    return { ok:false, error:'Calendar strip capture is unavailable' };
  }
  const run = async () => {
    const audit = {
      mainRequest:null,
      mainFinal:null,
      captureResult:null,
      worker:null,
      renderer:null,
      workerCountsBefore:{
        created:calendarStripCaptureWorkerCreatedCount,
        destroyed:calendarStripCaptureWorkerDestroyedCount,
      },
      workerCountsAfter:null,
      captureFailure:null,
      error:'',
    };
    calendarStripCapturePending += 1;
    let response = null;
    try {
      const request = await calendarStripState(mainWindow);
      audit.mainRequest = request;
      if (!request) throw new Error('Calendar strip is not in a stable capture state');
      const capture = request.visible
        ? { ...await captureCalendarStripRegion(mainWindow, request), source:'main' }
        : { ...await captureCalendarStripOffscreen(request, audit), source:'offscreen' };
      audit.captureResult = {
        source:capture.source,
        captureRect:capture.captureRect,
        stripRect:capture.stripRect,
        pixelSize:capture.pixelSize,
        dpr:capture.dpr,
        stateAfter:capture.stateAfter,
      };
      const finalState = await calendarStripState(mainWindow);
      audit.mainFinal = finalState;
      if (!calendarStripStatesMatch(request, finalState)) {
        throw new Error('Calendar strip request changed during capture');
      }
      calendarStripCaptureLastError = '';
      response = {
        ok:true,
        src:capture.image.toDataURL(),
        captureKey:request.captureKey,
        captureRevision:request.captureRevision,
        captureRect:capture.captureRect,
        stripRect:capture.stripRect,
        pixelSize:capture.pixelSize,
        dpr:capture.dpr,
        source:capture.source,
      };
    } catch (error) {
      calendarStripCaptureLastError = String(
        error?.message || error || 'Calendar strip capture failed',
      );
      audit.error = calendarStripCaptureLastError;
      audit.captureFailure = error?.calendarStripCapture || null;
      response = { ok:false, error:calendarStripCaptureLastError };
    } finally {
      if (!audit.mainFinal) {
        audit.mainFinal = await calendarStripState(mainWindow).catch(() => null);
      }
      calendarStripCapturePending = Math.max(0, calendarStripCapturePending - 1);
      audit.renderer = {
        pending:calendarStripCapturePending,
        lastError:calendarStripCaptureLastError,
      };
      audit.workerCountsAfter = {
        created:calendarStripCaptureWorkerCreatedCount,
        destroyed:calendarStripCaptureWorkerDestroyedCount,
        live:calendarStripCaptureWorkerCreatedCount
          - calendarStripCaptureWorkerDestroyedCount,
      };
      response.audit = audit;
    }
    return response;
  };
  calendarStripCaptureQueue = calendarStripCaptureQueue.catch(() => null).then(run);
  try { return await calendarStripCaptureQueue; } catch (error) {
    return { ok:false, error:String(error?.message || 'Calendar strip capture failed') };
  }
});
ipcMain.on('home-preview:interaction', (event, active) => {
  if (isMainSender(event)) setHomePreviewInteraction(active);
});
ipcMain.handle('home-preview:list', (event) => {
  if (!isMainSender(event) && !isPreviewSender(event)) return { ok: false, previews: [] };
  return { ok: true, version: HOME_PREVIEW_VERSION, previews: [...homePreviewCache.values()] };
});
ipcMain.handle('project-preview:list', (event) => {
  if (!isMainSender(event) && !isPreviewSender(event)) return { ok:false, previews:[] };
  return { ok:true, version:PROJECT_PREVIEW_VERSION, previews:[...projectPreviewCache.values()] };
});
ipcMain.handle('project-preview:capture', async (event, { projectId, viewState = null } = {}) => {
  const key = String(projectId || '').trim();
  if (!isMainSender(event) || !key || key.length > 200) return { ok:false, error:'Invalid project preview key' };
  const preview = await captureProjectPreview(key, viewState || {});
  return preview ? { ok:true, preview } : { ok:false, error:'Project preview capture failed' };
});
ipcMain.handle('home-preview:idle', async (event) => {
  if (!isMainSender(event)) return { ok: false };
  const started = Date.now();
  let quietGeneration = -1;
  let quietSince = 0;
  while (Date.now() - started < 30000) {
    const queue = homePreviewQueue;
    await queue.catch(() => null);
    const capturing = !!previewWindow && !previewWindow.isDestroyed();
    if (homePreviewStartupTimer || homePreviewResizeTimer || homePreviewRefreshTimer || capturing || queue !== homePreviewQueue) {
      quietGeneration = -1;
      quietSince = 0;
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    if (quietGeneration !== homePreviewActivityGeneration) {
      quietGeneration = homePreviewActivityGeneration;
      quietSince = Date.now();
    }
    if (Date.now() - quietSince >= 900) {
      return { ok: true, capturing: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return { ok: false, capturing: !!previewWindow && !previewWindow.isDestroyed(), error: 'Preview engine did not become idle' };
});
ipcMain.handle('home-preview:motion', (event) => {
  if (!isMainSender(event)) return { ok: false, snapshot: null };
  return { ok: true, snapshot: homeMotionSnapshot, error: homeMotionSnapshotError };
});
ipcMain.handle('home-preview:capture', async (event, { key, viewState = null } = {}) => {
  if (!isMainSender(event) || !HOME_PREVIEW_KEYS.includes(key)) return { ok: false, error: 'Invalid preview key' };
  const preview = await capturePreviewKeys([key], 'room refresh', { [key]: viewState });
  return preview ? { ok: true, preview } : { ok: false, error: 'Preview capture failed' };
});
ipcMain.handle('dashboard:minimize', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });
ipcMain.handle('dashboard:close', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });

// ─── IPC: tickets ────────────────────────────────────────────────────────────────
// Reads are open; writes require a signed-in user; delegate (assign) still requires
// an admin. All writes flow through tickets.js -> store.js -> the CRM API.

ipcMain.handle('tickets:list', () => ticketsPayload());
ipcMain.handle('tickets:connection', () => ticketConnectionState());

function requireUser() {
  const who = actor();
  return who ? { who } : { error: { ok: false, error: 'Sign in to manage tickets' } };
}

ipcMain.handle('tickets:claim', (_e, { id } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return claimTicket(id, g.who);
});
ipcMain.handle('tickets:unclaim', (_e, { id } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return unclaimTicket(id, g.who);
});
ipcMain.handle('tickets:assign', (_e, { id, assignee } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  if (!canManageUsers()) return { ok: false, error: 'Only an admin can delegate tickets' };
  return assignTicket(id, assignee, g.who);
});
ipcMain.handle('tickets:resolve', (_e, { id } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return resolveTicket(id, g.who);
});
ipcMain.handle('tickets:reopen', (_e, { id } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return reopenTicket(id, g.who);
});
ipcMain.handle('tickets:comment', (_e, { id, text } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return commentTicket(id, text, g.who);
});
ipcMain.handle('tickets:update', (_e, { id, fields } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return updateTicket(id, fields || {}, g.who);
});
ipcMain.handle('tickets:create', (_e, payload = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return createTicket(payload, g.who);
});
ipcMain.handle('tickets:delete', (_e, { id } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return deleteTicket(id);
});

// ─── IPC: generic CRM store ────────────────────────────────────────────────────
// New CRM modules use this seam. The legacy ticket bridge above remains intact
// until the card-system factory is proven against ticketing.

function entityName(entity) {
  const key = String(entity || '').trim();
  return CRM_ENTITIES.includes(key) ? key : null;
}

function cdmsSourceRecord(entity, id) {
  return cdms.getRecord(entity, id);
}

async function updateCdmsOverlay(entity, id, fields, actorName) {
  if (!['contacts', 'companies'].includes(entity)) {
    return { ok: false, error: 'This CDMS record is read-only; edit it in CDMS' };
  }
  const allowed = Object.fromEntries(Object.entries(fields || {}).filter(([field]) => CRM_OVERLAY_FIELDS.has(field)));
  if (!Object.keys(allowed).length) {
    return { ok: false, error: 'CDMS source fields are read-only; CRM follow-up fields can still be saved' };
  }
  const existing = getRecord(entity, id);
  const result = existing
    ? await updateRecord(entity, id, allowed, actorName)
    : await createRecord(entity, {
      id,
      source: 'cdms-overlay',
      sourceId: id,
      ...allowed,
    }, actorName, {
      action: 'linked',
      detail: 'Created CRM relationship metadata for a CDMS record',
    });
  if (result?.record) {
    result.record = cdms.overlayRecords(entity, [result.record])
      .find((record) => String(record.id) === String(id)) || result.record;
  }
  return result;
}

ipcMain.handle('store:list', (_e, { entity, includeDeleted = true } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  return { ok: true, ...storePayload(key, { includeDeleted: !!includeDeleted }) };
});

ipcMain.handle('store:get', (_e, { entity, id } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  const sourceRecord = cdmsSourceRecord(key, id);
  if (sourceRecord) {
    const localOverlay = key === 'assets' ? null : getRecord(key, id);
    const merged = cdms.overlayRecords(key, localOverlay ? [localOverlay] : [])
      .find((record) => String(record.id) === String(id)) || sourceRecord;
    return { ok: true, entity: key, record: merged, source: 'cdms' };
  }
  if (key === 'assets') return { ok: true, entity: key, record: null, source: 'cdms' };
  const local = getRecord(key, id);
  return {
    ok: true,
    entity: key,
    record: local ? cdms.decorateRecord(key, local) : null,
  };
});

ipcMain.handle('store:create', (_e, { entity, fields } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  if (key === 'assets') return { ok: false, error: 'CDMS infrastructure is read-only in CRM' };
  const g = requireUser(); if (g.error) return g.error;
  return createRecord(key, fields || {}, g.who);
});

ipcMain.handle('store:update', (_e, { entity, id, fields } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  const g = requireUser(); if (g.error) return g.error;
  if (cdmsSourceRecord(key, id) || String(id || '').startsWith('cdms-')) {
    return updateCdmsOverlay(key, id, fields, g.who);
  }
  return updateRecord(key, id, fields || {}, g.who);
});

ipcMain.handle('store:delete', (_e, { entity, id, hard = false } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  if (cdmsSourceRecord(key, id) || String(id || '').startsWith('cdms-')) {
    return { ok: false, error: 'This CDMS record is read-only; edit it in CDMS' };
  }
  const g = requireUser(); if (g.error) return g.error;
  return deleteRecord(key, id, g.who, { hard: !!hard });
});

ipcMain.handle('domain:list', async (_e, { resource, query } = {}) => {
  const result = await listDomain(resource, query);
  if (resource !== 'commitments' || !Array.isArray(result?.records)) return result;
  return { ...result, records: cdms.overlayRecords('commitments', result.records) };
});
ipcMain.handle('domain:get', async (_e, { resource, id } = {}) => {
  const result = await getDomain(resource, id);
  if (resource !== 'commitments' || !result?.record) return result;
  return { ...result, record: cdms.decorateRecord('commitments', result.record) };
});
ipcMain.handle('domain:create', (_e, { resource, fields } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return createDomain(resource, { ...(fields || {}), actor: fields?.actor || g.who });
});
ipcMain.handle('domain:update', (_e, { resource, id, fields, expectedVersion } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return updateDomain(resource, id, fields || {}, expectedVersion);
});
ipcMain.handle('domain:delete', (_e, { resource, id, hard = false } = {}) => {
  const g = requireUser(); if (g.error) return g.error;
  return deleteDomain(resource, id, { hard: !!hard });
});

ipcMain.handle('reports:summary', async () => decorateReportPayload(await reportSummary()));

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();

  auth.init();
  await cdms.initialize({
    baseUrl: settings.cdmsUrl,
    fetcher: electronSession.defaultSession.fetch.bind(electronSession.defaultSession),
    disabled: process.env.CRM_CDMS_DISABLED === '1',
  });

  // Tickets are an API-backed compatibility adapter; generic CRM entities share
  // the same Postgres/API store seam.
  initTickets({
    url: settings.apiUrl,
    onChange: () => {
      broadcastTickets();
      broadcastStore();
      refreshTray();
      scheduleHomePreviewRefresh('live data change');
    },
  });

  tray = new Tray(icons.grey);
  refreshTray();
  tray.on('click', () => toggleMainWindow());
  tray.on('double-click', () => showMainWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));

  // The main window is the primary surface — open it on launch.
  showMainWindow();
});

// Tray app: closing the window does NOT quit (stays alive in the tray).
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => showMainWindow());
app.on('before-quit', (event) => {
  // Installer/update lifecycle must retain Electron's normal immediate exit.
  if (squirrelStartup) return;
  if (!exitRequested) {
    event.preventDefault();
    hideMainWindow();
    return;
  }
  endTicketsOnce();
});
app.on('will-quit', () => endTicketsOnce());
