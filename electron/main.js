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
const HOME_PREVIEW_VERSION = 'filtered-home-v45';
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
ipcMain.handle('dashboard-window:reload', (e) => { if (isMainSender(e)) mainWindow.webContents.reload(); return { ok: true }; });
ipcMain.handle('dashboard-window:minimize', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });
ipcMain.handle('dashboard-window:close', (e) => { if (isMainSender(e)) hideMainWindow(); return { ok: true }; });
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

ipcMain.handle('reports:summary', () => reportSummary());

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
