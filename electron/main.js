// CRM client — main process.
//
// This is the shared Electron shell with monitoring ingestion fully removed.
// CRM records live behind the Postgres API in server/; the legacy ticket bridge
// remains as a compatibility adapter while the card system is generalized.
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import squirrelStartup from 'electron-squirrel-startup';
import pngjs from 'pngjs';
import { icons } from './icons';
import auth from './auth.js';
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

// Handle Squirrel.Windows install/update/uninstall events — must quit immediately.
if (squirrelStartup) app.quit();

// Kill the default application menu (File/Edit/View/Window/Help) for a chrome-free
// app. Must be called before any window is created.
Menu.setApplicationMenu(null);

// ─── Settings persistence ─────────────────────────────────────────────────────
// The API URL is the only backend coordinate the Electron client owns.

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  apiUrl: process.env.CRM_API_URL || 'http://127.0.0.1:3899',
};

function loadSettings() {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    merged.apiUrl = normalizeApiUrl(merged.apiUrl) || DEFAULT_SETTINGS.apiUrl;
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
let settings = loadSettings();
const CRM_ENTITIES = ['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'bills', 'invoices', 'interactions'];
const HOME_PREVIEW_KEYS = ['desk', 'people', 'cases', 'money', 'planner', 'assignments'];
// Bump whenever room chrome changes in a way that makes an old raster false.
// The renderer refuses a different generation instead of briefly presenting
// stale arrows, controls, or styling while replacement captures are prepared.
const HOME_PREVIEW_VERSION = 'filtered-home-v30';
const homePreviewCache = new Map();
let homeMotionSnapshot = null;
let homeMotionSnapshotError = null;
let homePreviewQueue = Promise.resolve();
let homePreviewRefreshTimer = null;

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

  mainWindow.loadFile(dashboardIndexPath());

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('tickets:changed', ticketsPayload());
    mainWindow.webContents.send('tickets:connection', ticketConnectionState());
    broadcastStore();
    setTimeout(() => capturePreviewKeys(HOME_PREVIEW_KEYS, 'startup'), 250);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
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
  return { tickets: ticketList(), connection: ticketConnectionState() };
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

async function prepareCapture(win, matte = null, options = {}) {
  const preserveHomePreviewFilter = options.preserveHomePreviewFilter === true;
  const css = `
    *,*::before,*::after { animation:none !important; transition:none !important; }
    .window-control-cluster,.auth-profile-cluster,.workspace-menu-overlay-layer,.dashboard-search-popover,
    .crm-module-switch,.db-loading { display:none !important; }
    .crm-home-title-glass { display:none !important; }
    ${preserveHomePreviewFilter ? '' : '.crm-home-preview-foreground { filter:none !important; }'}
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

async function captureRoom(win) {
  await prepareCapture(win, null);
  const exact = await win.webContents.capturePage();
  await prepareCapture(win, '#000000');
  const black = await win.webContents.capturePage();
  await prepareCapture(win, '#ffffff');
  const white = await win.webContents.capturePage();
  const foreground = foregroundFromMattes(black, white);
  if (!foreground || exact.isEmpty()) return null;
  return { exact, foreground: foreground.image, bounds: foreground.bounds };
}

function waitForRenderer(win, expression, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (!win || win.isDestroyed()) { reject(new Error('Preview renderer closed')); return; }
      try { if (await win.webContents.executeJavaScript(expression, true)) { resolve(); return; } } catch {}
      if (Date.now() - started >= timeoutMs) { reject(new Error('Preview renderer timed out')); return; }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) return previewWindow;
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : { width: 1280, height: 860 };
  previewWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height, show: false, frame: false,
    backgroundColor: '#10141c', paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'dashboard-preload.js'), nodeIntegration: false, contextIsolation: true,
      sandbox: false, offscreen: true, backgroundThrottling: false,
    },
  });
  previewWindow.on('closed', () => { previewWindow = null; });
  await previewWindow.loadFile(dashboardIndexPath(), { query: { crmPreviewWorker: '1' } });
  await waitForRenderer(previewWindow, `!document.documentElement.hasAttribute('data-dashboard-booting') && !!window.crmWorkspaces`);
  return previewWindow;
}

function publishHomePreview(key, capture, layoutSignature) {
  if (!capture?.foreground || !capture?.exact) return null;
  const size = capture.exact.getSize();
  const preview = {
    key, version: HOME_PREVIEW_VERSION, width: size.width, height: size.height, capturedAt: Date.now(),
    foregroundSrc: capture.foreground.toDataURL(), exactSrc: capture.exact.toDataURL(),
    foregroundBounds: capture.bounds, layoutSignature,
  };
  homePreviewCache.set(key, preview);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('home-preview:changed', preview);
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('home-preview:changed', preview);
  return preview;
}

async function captureHomeMotionSnapshot(worker) {
  homeMotionSnapshotError = null;
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
  // The transition raster must be visually identical to resting Home. Room
  // mattes intentionally remove the preview blur; the Home motion composite
  // must preserve it or the final exchange flashes from sharp back to blur.
  await prepareCapture(worker, null, { preserveHomePreviewFilter: true });
  const image = await worker.webContents.capturePage();
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  homeMotionSnapshot = {
    version: HOME_PREVIEW_VERSION, width: size.width, height: size.height,
    capturedAt: Date.now(), src: image.toDataURL(), layoutSignature,
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('home-preview:motion-changed', homeMotionSnapshot);
  return homeMotionSnapshot;
}

function capturePreviewKeys(keys, label = 'refresh') {
  const requested = keys.filter((key) => HOME_PREVIEW_KEYS.includes(key));
  homePreviewQueue = homePreviewQueue.then(async () => {
    let worker;
    let activeCaptureKey = 'boot';
    try {
      worker = await createPreviewWindow();
      for (const key of requested) {
        activeCaptureKey = key;
        await worker.webContents.executeJavaScript(`window.crmWorkspaces.setActive(${JSON.stringify(key)})`, true);
        await waitForRenderer(worker, `document.body.dataset.crmModule === ${JSON.stringify(key)} && !!document.querySelector('[data-crm-theater]:not([hidden])')`);
        await worker.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))`, true);
        const layoutSignature = await worker.webContents.executeJavaScript(`(() => {
          const theater = document.querySelector('[data-crm-theater]:not([hidden])');
          return { module: document.body.dataset.crmModule || '', text: String(theater?.innerText || '').replace(/\\s+/g,' ').trim(),
            elements: theater?.querySelectorAll('*').length || 0, calendarYear: window.fractalCalendar?.year?.() || null };
        })()`, true);
        publishHomePreview(key, await captureRoom(worker), layoutSignature);
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
    }
    return requested.length === 1 ? homePreviewCache.get(requested[0]) || null : null;
  });
  return homePreviewQueue;
}

function scheduleHomePreviewRefresh(label = 'store change', delay = 700) {
  clearTimeout(homePreviewRefreshTimer);
  homePreviewRefreshTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    capturePreviewKeys(HOME_PREVIEW_KEYS, label);
  }, delay);
}

function storePayload(entity, options = {}) {
  return { entity, records: listRecords(entity, options), connection: storeConnectionState() };
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

// ─── Tray ────────────────────────────────────────────────────────────────────

function buildContextMenu() {
  const s = auth.session();
  const who = s.user ? `Signed in as ${s.user.username}` : 'Not signed in';
  const open = ticketList().filter((t) => t.state !== 'resolved').length;
  return Menu.buildFromTemplate([
    { label: `CRM — ${open} open tickets`, enabled: false },
    { label: who, enabled: false },
    { type: 'separator' },
    { label: 'Open CRM', click: () => showMainWindow() },
    { label: 'Quit', click: () => { endTickets(); app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(ticketConnectionState() === 'live' ? icons.blue : icons.grey);
  const open = ticketList().filter((t) => t.state !== 'resolved').length;
  tray.setToolTip(open ? `CRM — ${open} open tickets` : 'CRM');
}

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function broadcastAuth() {
  const payload = auth.session();
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('auth:changed', payload);
  });
}

function canManageUsers() {
  const s = auth.session();
  return !!(s.user && (s.user.isAdmin || s.user.permissions.canManageUsers));
}

// The signed-in user actor for ticket actions, or null when nobody is signed in.
function actor() {
  return auth.currentUser() || null;
}

// ─── IPC: auth (shared with the monitor) ────────────────────────────────────────

ipcMain.handle('auth:session', () => auth.session());

ipcMain.handle('auth:login', (_e, { username, password } = {}) => {
  const result = auth.login(username, password);
  if (result.ok) { broadcastAuth(); refreshTray(); }
  return result;
});

ipcMain.handle('auth:logout', () => {
  const result = auth.logout();
  broadcastAuth();
  refreshTray();
  return result;
});

ipcMain.handle('auth:register', (_e, payload) => {
  const result = auth.register(payload || {});
  if (result.ok) { broadcastAuth(); refreshTray(); }
  return result;
});

ipcMain.handle('auth:set-password', (_e, { password } = {}) => {
  const result = auth.setOwnPassword(password);
  if (result.ok) broadcastAuth();
  return result;
});

ipcMain.handle('auth:list-users', () => (
  canManageUsers() ? { ok: true, users: auth.listUsers() } : { ok: false, error: 'Not allowed' }
));
ipcMain.handle('auth:create-user', (_e, payload) => (
  canManageUsers() ? auth.createUser(payload || {}) : { ok: false, error: 'Not allowed' }
));
ipcMain.handle('auth:update-user', (_e, { username, ...rest } = {}) => (
  canManageUsers() ? auth.updateUser(username, rest) : { ok: false, error: 'Not allowed' }
));
ipcMain.handle('auth:delete-user', (_e, { username } = {}) => (
  canManageUsers() ? auth.deleteUser(username) : { ok: false, error: 'Not allowed' }
));

// Synchronous lookup so dashboard-preload.js can namespace the layout store.
ipcMain.on('auth:current-username', (e) => { e.returnValue = auth.currentUser() || ''; });

// ─── IPC: settings (API) ────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_e, next = {}) => {
  const apiUrl = normalizeApiUrl(next.apiUrl ?? settings.apiUrl);
  if (!apiUrl) return { ok: false, error: 'API URL must be an http(s) URL' };
  settings = { ...settings, ...next, apiUrl };
  saveSettings(settings);
  connectTickets({ url: settings.apiUrl });
  broadcastStore();
  return { ok: true, settings, connection: storeConnectionInfo() };
});
ipcMain.handle('backend:connection', () => ({ ok: true, settings, connection: storeConnectionInfo() }));
ipcMain.handle('backend:status', async () => {
  const health = await storeHealth();
  return {
    ok: health.ok,
    settings,
    connection: storeConnectionInfo(),
    health,
    error: health.error || null,
  };
});

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
ipcMain.handle('dashboard-window:minimize', (e) => { if (isMainSender(e)) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle('dashboard-window:close', (e) => { if (isMainSender(e)) mainWindow.hide(); return { ok: true }; });
ipcMain.handle('home-preview:list', (event) => {
  if (!isMainSender(event) && !isPreviewSender(event)) return { ok: false, previews: [] };
  return { ok: true, previews: [...homePreviewCache.values()] };
});
ipcMain.handle('home-preview:motion', (event) => {
  if (!isMainSender(event)) return { ok: false, snapshot: null };
  return { ok: true, snapshot: homeMotionSnapshot, error: homeMotionSnapshotError };
});
ipcMain.handle('home-preview:capture', async (event, { key } = {}) => {
  if (!isMainSender(event) || !HOME_PREVIEW_KEYS.includes(key)) return { ok: false, error: 'Invalid preview key' };
  const preview = await capturePreviewKeys([key], 'room refresh');
  return preview ? { ok: true, preview } : { ok: false, error: 'Preview capture failed' };
});
ipcMain.handle('dashboard:minimize', (e) => { if (isMainSender(e)) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle('dashboard:close', (e) => { if (isMainSender(e)) mainWindow.hide(); return { ok: true }; });

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

ipcMain.handle('store:list', (_e, { entity, includeDeleted = true } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  return { ok: true, ...storePayload(key, { includeDeleted: !!includeDeleted }) };
});

ipcMain.handle('store:get', (_e, { entity, id } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  return { ok: true, entity: key, record: getRecord(key, id) };
});

ipcMain.handle('store:create', (_e, { entity, fields } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  const g = requireUser(); if (g.error) return g.error;
  return createRecord(key, fields || {}, g.who);
});

ipcMain.handle('store:update', (_e, { entity, id, fields } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  const g = requireUser(); if (g.error) return g.error;
  return updateRecord(key, id, fields || {}, g.who);
});

ipcMain.handle('store:delete', (_e, { entity, id, hard = false } = {}) => {
  const key = entityName(entity);
  if (!key) return { ok: false, error: 'Unknown entity' };
  const g = requireUser(); if (g.error) return g.error;
  return deleteRecord(key, id, g.who, { hard: !!hard });
});

ipcMain.handle('domain:list', (_e, { resource, query } = {}) => listDomain(resource, query));
ipcMain.handle('domain:get', (_e, { resource, id } = {}) => getDomain(resource, id));
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

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  auth.init();

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
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));

  // The main window is the primary surface — open it on launch.
  showMainWindow();
});

// Tray app: closing the window does NOT quit (stays alive in the tray).
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', () => endTickets());
