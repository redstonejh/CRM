// CRM client — main process.
//
// This is the status monitor's Electron shell with the MQTT *monitoring* layer
// stripped out (no checks/connections/heartbeat ingestion, no ping history, no
// dashboard data feed). What remains is the shared shell — auth/SSO, settings,
// a system tray, a frameless main window — plus a thin tickets backend that
// talks to ONE retained MQTT topic tree (`tickets/#`, see electron/tickets.js).
//
// The monitor auto-creates a ticket on a sustained outage and publishes it to
// `tickets/<id>`; this app subscribes to the same tree and lets humans
// claim / assign / resolve. The two apps share ~/.status-monitor/ for accounts,
// so signing into one signs you into the other.
//
// ⚠ FRONT END IS A PLACEHOLDER: dashboard/index.html is a throwaway scaffold so
//   the backend is reachable + verifiable. The real ticketing UI is not built yet.
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

// Handle Squirrel.Windows install/update/uninstall events — must quit immediately.
if (squirrelStartup) app.quit();

// Kill the default application menu (File/Edit/View/Window/Help) for a chrome-free
// app. Must be called before any window is created.
Menu.setApplicationMenu(null);

// ─── Settings persistence ─────────────────────────────────────────────────────
// Only the broker coordinates matter here (the ticketing app does no monitoring).

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  mqttHost: '24.121.212.206',
  mqttPort: 1883,
};

function loadSettings() {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    if (!merged.mqttHost || merged.mqttHost === 'localhost' || merged.mqttHost === '127.0.0.1') {
      merged.mqttHost = DEFAULT_SETTINGS.mqttHost;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

// ─── App state ────────────────────────────────────────────────────────────────

let tray = null;
let mainWindow = null;
let settings = loadSettings();

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

// ─── IPC: settings (broker) ──────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_e, next = {}) => {
  settings = { ...settings, ...next };
  if (!settings.mqttHost) settings.mqttHost = DEFAULT_SETTINGS.mqttHost;
  if (!settings.mqttPort) settings.mqttPort = DEFAULT_SETTINGS.mqttPort;
  saveSettings(settings);
  connectTickets({ host: settings.mqttHost, port: settings.mqttPort }); // reconnect with new broker
  return { ok: true, settings };
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
// an admin. All writes flow through tickets.js → the local userData store.

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

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  auth.init();

  // Tickets are a local store now (no broker) — just wire the change broadcast.
  initTickets({
    onChange: () => { broadcastTickets(); refreshTray(); },
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
