// API-backed CRM entity store.
//
// The Electron client talks to the Postgres API in server/. The in-process cache
// keeps the existing ticket UI contract synchronous for reads, while writes go
// through REST with optimistic compare-and-set on record version. WebSocket
// change events keep every entity bridge fresh.
import WebSocket from 'ws';

const DEFAULT_API_URL = process.env.CRM_API_URL || 'http://127.0.0.1:3899';
const ENTITIES = ['tickets', 'deals', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports'];
const IMMUTABLE_FIELDS = new Set(['id', 'entityType', 'createdAt', 'history', 'version']);

let apiUrl = DEFAULT_API_URL.replace(/\/+$/, '');
let onChange = () => {};
let connectionState = 'offline';
let ws = null;
let reconnectTimer = null;
let refreshTimer = null;
const entityStores = new Map();
const loadedEntities = new Set();
const pendingRefresh = new Set();

function safeEntity(entity) {
  const key = String(entity || '').trim();
  if (!ENTITIES.includes(key)) throw new Error(`Invalid entity: ${entity}`);
  return key;
}

export function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function entityMap(entity) {
  const key = safeEntity(entity);
  if (!entityStores.has(key)) entityStores.set(key, new Map());
  return entityStores.get(key);
}

function normalizeRecord(entity, raw = {}) {
  const updatedAt = typeof raw.updatedAt === 'number'
    ? raw.updatedAt
    : (raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now());
  return {
    ...raw,
    id: safeId(raw.id),
    entityType: entity,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    version: Number.isFinite(raw.version) ? raw.version : 1,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function setConnection(state) {
  if (connectionState === state) return;
  connectionState = state;
  emitChange();
}

function emitChange() {
  try { onChange(); } catch { /* ignore renderer broadcast errors */ }
}

function changedValue(a, b) {
  if (Object.is(a, b)) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
  }
  return true;
}

async function request(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      setConnection('offline');
      return { ok: false, error: json.error || `HTTP ${res.status}`, status: res.status };
    }
    setConnection('live');
    return json;
  } catch (err) {
    setConnection('offline');
    return { ok: false, error: err && err.message ? err.message : 'API request failed' };
  }
}

function applyRecord(entity, record) {
  if (!record || !record.id) return null;
  const doc = normalizeRecord(entity, record);
  entityMap(entity).set(doc.id, doc);
  loadedEntities.add(entity);
  return doc;
}

function removeRecord(entity, id) {
  entityMap(entity).delete(safeId(id));
  loadedEntities.add(entity);
}

async function refreshEntity(entity) {
  const key = safeEntity(entity);
  if (pendingRefresh.has(key)) return;
  pendingRefresh.add(key);
  const res = await request(`/api/entities/${encodeURIComponent(key)}?includeDeleted=true`);
  pendingRefresh.delete(key);
  if (!res.ok) return;
  const map = entityMap(key);
  map.clear();
  (res.records || []).forEach((record) => applyRecord(key, record));
  loadedEntities.add(key);
  emitChange();
}

function scheduleRefreshAll() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    ENTITIES.forEach((entity) => { refreshEntity(entity); });
  }, 50);
}

function wsUrl() {
  return `${apiUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/api/changes`;
}

function connectSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    reconnectTimer = setTimeout(connectSocket, 2500);
    return;
  }
  ws.on('open', () => {
    setConnection('live');
    scheduleRefreshAll();
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      const entity = safeEntity(msg.entity);
      if (msg.type === 'deleted' && msg.id) removeRecord(entity, msg.id);
      else if (msg.record) applyRecord(entity, msg.record);
      emitChange();
    } catch { /* ignore malformed change packets */ }
  });
  ws.on('close', () => {
    setConnection('offline');
    reconnectTimer = setTimeout(connectSocket, 2500);
  });
  ws.on('error', () => {
    setConnection('offline');
  });
}

export function configureStore({ url } = {}) {
  if (url) apiUrl = String(url).replace(/\/+$/, '');
  connectSocket();
  scheduleRefreshAll();
}

export function initCrmStore({ onChange: changeCb, url } = {}) {
  onChange = typeof changeCb === 'function' ? changeCb : onChange;
  ENTITIES.forEach(entityMap);
  configureStore({ url });
}

export function emitStoreChange() {
  scheduleRefreshAll();
  emitChange();
}

export function storeConnectionState() {
  return connectionState;
}

export function listRecords(entity, { includeDeleted = true } = {}) {
  const key = safeEntity(entity);
  if (!loadedEntities.has(key)) refreshEntity(key);
  const list = [...entityMap(key).values()];
  return includeDeleted ? list : list.filter((doc) => !doc.deletedAt);
}

export function getRecord(entity, id) {
  const key = safeEntity(entity);
  const record = entityMap(key).get(safeId(id)) || null;
  if (!record) refreshEntity(key);
  return record;
}

export async function createRecord(entity, fields = {}, actor = 'unknown', options = {}) {
  const key = safeEntity(entity);
  const res = await request(`/api/entities/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: { fields, actor, options },
  });
  if (res.ok && res.record) {
    res.record = applyRecord(key, res.record);
    emitChange();
  }
  return res;
}

export async function updateRecord(entity, id, fields = {}, actor = 'unknown', options = {}) {
  const key = safeEntity(entity);
  const cur = entityMap(key).get(safeId(id)) || null;
  const res = await request(`/api/entities/${encodeURIComponent(key)}/${encodeURIComponent(safeId(id))}`, {
    method: 'PATCH',
    body: {
      fields,
      actor,
      options,
      expectedVersion: options.expectedVersion ?? cur?.version,
    },
  });
  if (res.ok && res.record) {
    res.record = applyRecord(key, res.record);
    emitChange();
  } else if (res.status === 409) {
    await refreshEntity(key);
    if (options.retryOnConflict !== false) {
      const fresh = entityMap(key).get(safeId(id));
      if (fresh) {
        return updateRecord(key, id, fields, actor, {
          ...options,
          expectedVersion: fresh.version,
          retryOnConflict: false,
        });
      }
    }
  }
  return res;
}

export async function mutateRecord(entity, id, actor, action, mutator, options = {}) {
  const key = safeEntity(entity);
  let cur = entityMap(key).get(safeId(id));
  if (!cur) {
    await refreshEntity(key);
    cur = entityMap(key).get(safeId(id));
  }
  if (!cur) return { ok: false, error: `No such ${key}` };
  const nowIso = new Date().toISOString();
  const next = { ...cur, history: [...(cur.history || [])] };
  const detail = mutator(next, nowIso);
  if (typeof detail === 'object' && detail && detail.error) return { ok: false, error: detail.error };
  const fields = {};
  for (const [field, value] of Object.entries(next)) {
    if (IMMUTABLE_FIELDS.has(field)) continue;
    if (changedValue(cur[field], value)) fields[field] = value;
  }
  return updateRecord(key, cur.id, fields, actor, {
    ...options,
    action,
    detail: typeof detail === 'string' ? detail : '',
    expectedVersion: cur.version,
    retryOnConflict: false,
  });
}

export async function deleteRecord(entity, id, actor = 'unknown', options = {}) {
  const key = safeEntity(entity);
  const cur = entityMap(key).get(safeId(id)) || null;
  const params = new URLSearchParams();
  if (options.hard) params.set('hard', '1');
  if (options.expectedVersion ?? cur?.version) params.set('version', String(options.expectedVersion ?? cur.version));
  const suffix = params.toString() ? `?${params}` : '';
  const res = await request(`/api/entities/${encodeURIComponent(key)}/${encodeURIComponent(safeId(id))}${suffix}`, {
    method: 'DELETE',
    body: { actor },
  });
  if (res.ok) {
    if (options.hard || res.deleted) removeRecord(key, id);
    else if (res.record) applyRecord(key, res.record);
    emitChange();
  } else if (res.status === 409) {
    refreshEntity(key);
  }
  return res;
}
