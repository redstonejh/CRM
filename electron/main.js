// CRM client — main process.
//
// This is the shared Electron shell with monitoring ingestion fully removed.
// CRM records live behind the Postgres API in server/; the legacy ticket bridge
// remains as a compatibility adapter while the card system is generalized.
import { app, BrowserWindow, Tray, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import squirrelStartup from 'electron-squirrel-startup';
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
let settings = loadSettings();
const CRM_ENTITIES = ['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'invoices', 'interactions'];

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
ipcMain.handle('dashboard-window:reload', (e) => { if (isMainSender(e)) mainWindow.webContents.reload(); return { ok: true }; });
ipcMain.handle('dashboard-window:minimize', (e) => { if (isMainSender(e)) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle('dashboard-window:close', (e) => { if (isMainSender(e)) mainWindow.hide(); return { ok: true }; });
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
    onChange: () => { broadcastTickets(); broadcastStore(); refreshTray(); },
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
