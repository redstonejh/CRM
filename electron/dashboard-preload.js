'use strict';
// Preload for the ticketing main window. Exposes the shared shell bridges
// (auth/SSO, per-user layout store, frameless window controls) plus the tickets
// bridge. No MQTT monitoring channels — the only live data is tickets/#.
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─── Stubbed monitoring bridge ───────────────────────────────────────────────────
// The vendored dashboard shell (app.js / status-feed.js) expects a window.dashboard
// data bridge. This app does NO MQTT monitoring, so every data channel returns
// empty / never fires — the shell renders its full glass chrome over an empty
// workspace. (Real ticket data flows through window.tickets, below.) Window/settings
// channels are wired to the real main-process handlers.
contextBridge.exposeInMainWorld('dashboard', {
  getStatus: () => Promise.resolve({ status: null, connectionState: 'live' }),
  onStatus: () => {},
  onConnection: () => {},
  onCheck: () => {},
  onSetCompany: () => {},
  getHistory: () => Promise.resolve({ ok: true, history: [] }),
  getCompanies: () => Promise.resolve([]),
  getCompanyHistory: () => Promise.resolve({ results: [], rollups: [] }),
  getViewerIps: () => Promise.resolve({}),
  consumeCompanyFocus: () => Promise.resolve(null),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  closeDashboard: () => ipcRenderer.invoke('dashboard:close'),
  minimize: () => ipcRenderer.invoke('dashboard:minimize'),
});

// ─── Auth (identical to the monitor → single sign-on) ────────────────────────────
contextBridge.exposeInMainWorld('auth', {
  session: () => ipcRenderer.invoke('auth:session'),
  login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
  register: (username, password) => ipcRenderer.invoke('auth:register', { username, password }),
  setPassword: (password) => ipcRenderer.invoke('auth:set-password', { password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listUsers: () => ipcRenderer.invoke('auth:list-users'),
  createUser: (payload) => ipcRenderer.invoke('auth:create-user', payload),
  updateUser: (username, data) => ipcRenderer.invoke('auth:update-user', { username, ...data }),
  deleteUser: (username) => ipcRenderer.invoke('auth:delete-user', { username }),
  onChanged: (cb) => ipcRenderer.on('auth:changed', (_e, s) => cb(s)),
});

// ─── Tickets (the cross-app data) ────────────────────────────────────────────────
contextBridge.exposeInMainWorld('tickets', {
  list: () => ipcRenderer.invoke('tickets:list'),
  connectionState: () => ipcRenderer.invoke('tickets:connection'),
  onChanged: (cb) => ipcRenderer.on('tickets:changed', (_e, payload) => cb(payload)),
  onConnection: (cb) => ipcRenderer.on('tickets:connection', (_e, state) => cb(state)),
  claim: (id) => ipcRenderer.invoke('tickets:claim', { id }),
  unclaim: (id) => ipcRenderer.invoke('tickets:unclaim', { id }),
  assign: (id, assignee) => ipcRenderer.invoke('tickets:assign', { id, assignee }),
  resolve: (id) => ipcRenderer.invoke('tickets:resolve', { id }),
  reopen: (id) => ipcRenderer.invoke('tickets:reopen', { id }),
  comment: (id, text) => ipcRenderer.invoke('tickets:comment', { id, text }),
  update: (id, fields) => ipcRenderer.invoke('tickets:update', { id, fields }),
  create: (payload) => ipcRenderer.invoke('tickets:create', payload),
  remove: (id) => ipcRenderer.invoke('tickets:delete', { id }),
});

// ─── Misc shell ──────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
});

// ─── Per-user layout store (same backend + path scheme as the monitor) ────────────
// Namespaced per signed-in account, resolved once at load. After a sign-in the
// renderer reloads, so this re-resolves to the new user's store.
const sessionUser = (() => {
  try { return String(ipcRenderer.sendSync('auth:current-username') || ''); } catch { return ''; }
})();
const storeUserKey = sessionUser.replace(/[^a-z0-9_-]/gi, '_') || '_anon';
const storePath = path.join(os.homedir(), '.status-monitor', `crm-layout-store--${storeUserKey}.json`);

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return {}; }
}
function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

contextBridge.exposeInMainWorld('dashboardPersistence', {
  getItem(key) {
    const store = readStore();
    return Object.prototype.hasOwnProperty.call(store, key) ? String(store[key]) : null;
  },
  setItem(key, value) { const s = readStore(); s[key] = String(value); writeStore(s); },
  removeItem(key) { const s = readStore(); delete s[key]; writeStore(s); },
  keys() { return Object.keys(readStore()); },
  clear() { writeStore({}); },
});

// ─── Frameless window controls ────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('dashboardWindowControls', {
  reload: () => ipcRenderer.invoke('dashboard-window:reload'),
  minimize: () => ipcRenderer.invoke('dashboard-window:minimize'),
  close: () => ipcRenderer.invoke('dashboard-window:close'),
});
