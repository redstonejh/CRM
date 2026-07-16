'use strict';
// Preload for the CRM main window. Exposes the shared shell bridges
// (auth/SSO, per-user layout store, frameless window controls) plus API-backed
// CRM entity bridges.
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─── Stubbed monitoring bridge ───────────────────────────────────────────────────
// The vendored dashboard shell (app.js / status-feed.js) expects a window.dashboard
// data bridge. This app does no monitoring, so every data channel returns
// empty / never fires — the shell renders its full glass chrome over an empty
// workspace. CRM data flows through window.tickets/window.crmStore below.
// Window/settings channels are wired to the real main-process handlers.
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

function entityBridge(entity) {
  return {
    list: (options = {}) => ipcRenderer.invoke('store:list', { entity, ...options }),
    get: (id) => ipcRenderer.invoke('store:get', { entity, id }),
    create: (fields) => ipcRenderer.invoke('store:create', { entity, fields }),
    update: (id, fields) => ipcRenderer.invoke('store:update', { entity, id, fields }),
    remove: (id, options = {}) => ipcRenderer.invoke('store:delete', { entity, id, ...options }),
    onChanged: (cb) => ipcRenderer.on(`store:${entity}:changed`, (_e, payload) => cb(payload)),
  };
}

// Generic CRM entities. Tickets keep their legacy bridge above until the card
// system has been generalized and re-instantiated through the factory.
contextBridge.exposeInMainWorld('crmStore', {
  list: (entity, options = {}) => ipcRenderer.invoke('store:list', { entity, ...options }),
  get: (entity, id) => ipcRenderer.invoke('store:get', { entity, id }),
  create: (entity, fields) => ipcRenderer.invoke('store:create', { entity, fields }),
  update: (entity, id, fields) => ipcRenderer.invoke('store:update', { entity, id, fields }),
  remove: (entity, id, options = {}) => ipcRenderer.invoke('store:delete', { entity, id, ...options }),
  onChanged: (cb) => ipcRenderer.on('store:changed', (_e, payload) => cb(payload)),
});
contextBridge.exposeInMainWorld('crmDomain', {
  list: (resource, query = {}) => ipcRenderer.invoke('domain:list', { resource, query }),
  get: (resource, id) => ipcRenderer.invoke('domain:get', { resource, id }),
  create: (resource, fields) => ipcRenderer.invoke('domain:create', { resource, fields }),
  update: (resource, id, fields, expectedVersion) => ipcRenderer.invoke('domain:update', { resource, id, fields, expectedVersion }),
  remove: (resource, id, options = {}) => ipcRenderer.invoke('domain:delete', { resource, id, ...options }),
  onChanged: (cb) => ipcRenderer.on('store:changed', (_e, payload) => cb(payload)),
});
contextBridge.exposeInMainWorld('crmReportsApi', {
  summary: () => ipcRenderer.invoke('reports:summary'),
});
contextBridge.exposeInMainWorld('crmBackend', {
  connection: () => ipcRenderer.invoke('backend:connection'),
  status: () => ipcRenderer.invoke('backend:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  onChanged: (cb) => ipcRenderer.on('store:changed', (_e, payload) => cb(payload)),
});
contextBridge.exposeInMainWorld('deals', entityBridge('deals'));
contextBridge.exposeInMainWorld('contacts', entityBridge('contacts'));
contextBridge.exposeInMainWorld('companies', entityBridge('companies'));
contextBridge.exposeInMainWorld('tasks', entityBridge('tasks'));
contextBridge.exposeInMainWorld('bills', entityBridge('bills'));
contextBridge.exposeInMainWorld('invoices', entityBridge('invoices'));
contextBridge.exposeInMainWorld('interactions', entityBridge('interactions'));
contextBridge.exposeInMainWorld('projects', entityBridge('projects'));
contextBridge.exposeInMainWorld('workItems', entityBridge('workItems'));

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
contextBridge.exposeInMainWorld('crmHomePreviews', {
  isCaptureWorker: new URLSearchParams(location.search).has('crmPreviewWorker'),
  list: () => ipcRenderer.invoke('home-preview:list'),
  capture: (key, viewState = null) => ipcRenderer.invoke('home-preview:capture', { key, viewState }),
  waitForIdle: () => ipcRenderer.invoke('home-preview:idle'),
  motionSnapshot: () => ipcRenderer.invoke('home-preview:motion'),
  onChanged: (cb) => ipcRenderer.on('home-preview:changed', (_event, preview) => cb(preview)),
  onMotionSnapshotChanged: (cb) => ipcRenderer.on('home-preview:motion-changed', (_event, snapshot) => cb(snapshot)),
});

// Bind the immutable frameless-window buttons before application hydration.
// Capture phase makes these handlers authoritative even if a renderer runtime
// is rebuilt or goes stale after repeated camera navigation.
if (!new URLSearchParams(location.search).has('crmPreviewWorker')) {
  const installShellControls = () => {
    [
      ['.window-refresh-control', 'dashboard-window:reload'],
      ['.window-minimize-control', 'dashboard-window:minimize'],
      ['.window-close-control', 'dashboard-window:close'],
    ].forEach(([selector, channel]) => {
      const control = document.querySelector(selector);
      if (!control || control.dataset.preloadBound === 'true') return;
      control.dataset.preloadBound = 'true';
      control.addEventListener('click', (event) => {
        event.preventDefault(); event.stopImmediatePropagation(); ipcRenderer.invoke(channel);
      }, true);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installShellControls, { once: true });
  else installShellControls();
}
