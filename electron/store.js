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
const CLOSED_STATES = new Set(['resolved', 'done', 'closed', 'complete', 'completed', 'cancelled', 'archived']);
const DEAL_OUTCOME_STATES = new Set(['won', 'lost']);
const DEAL_STAGE_LABELS = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

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

function metaOf(record) {
  return record && record.meta && typeof record.meta === 'object' ? record.meta : {};
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (/^\d{10,}$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dayKey(value) {
  const ms = timestampOf(value);
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

function stateOf(record) {
  const meta = metaOf(record);
  return firstText(record?.state, meta.state, record?.status, meta.status).toLowerCase();
}

function titleOf(record) {
  const meta = metaOf(record);
  return firstText(
    record?.title,
    record?.name,
    record?.client,
    record?.company,
    record?.companyLabel,
    meta.title,
    meta.name,
    meta.client,
    meta.company,
    meta.companyLabel,
    record?.id,
    'Untitled',
  );
}

function dealStage(record) {
  const meta = metaOf(record);
  const state = stateOf(record);
  const raw = firstText(record?.stage, meta.stage, record?.pipelineStage, meta.pipelineStage, state);
  const stage = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return stage || 'lead';
}

function amountOf(record) {
  const meta = metaOf(record);
  return numberValue(firstText(record?.amount, record?.value, record?.dealValue, meta.amount, meta.value, meta.dealValue));
}

function isWonDeal(record) {
  return stateOf(record) === 'won' || dealStage(record) === 'won';
}

function isOpenDeal(record) {
  const state = stateOf(record);
  const stage = dealStage(record);
  return !DEAL_OUTCOME_STATES.has(state) && !DEAL_OUTCOME_STATES.has(stage) && !CLOSED_STATES.has(state);
}

function isOpenRecord(record) {
  return !CLOSED_STATES.has(stateOf(record));
}

function contactDue(record, now = Date.now()) {
  const meta = metaOf(record);
  const lastTouch = timestampOf(firstText(record?.lastContactAt, meta.lastContactAt, record?.updatedAt, record?.createdAt));
  return !lastTouch || now - lastTouch >= 30 * 24 * 60 * 60 * 1000;
}

function rowBase(record, entity) {
  const updatedAt = timestampOf(record.updatedAt || record.createdAt);
  return {
    id: record.id,
    entity,
    type: entity,
    title: titleOf(record),
    state: stateOf(record) || '',
    updatedAt,
    updated: updatedAt ? new Date(updatedAt).toISOString().slice(0, 10) : '',
  };
}

function dealRow(record) {
  const stage = dealStage(record);
  return {
    ...rowBase(record, 'deals'),
    stage,
    stageLabel: DEAL_STAGE_LABELS[stage] || stage.replace(/-/g, ' '),
    amountValue: amountOf(record),
    amount: amountOf(record),
    wonRatio: isWonDeal(record) ? 1 : 0,
  };
}

function summarizeCachedReports() {
  const records = (entity) => listRecords(entity, { includeDeleted: false });
  const tickets = records('tickets');
  const deals = records('deals');
  const contacts = records('contacts');
  const tasks = records('tasks');
  const calendarItems = records('calendarItems');
  const all = ENTITIES.flatMap((entity) => records(entity).map((record) => ({ entity, record })));
  const now = Date.now();
  const openTickets = tickets.filter(isOpenRecord).map((record) => rowBase(record, 'tickets'));
  const allDealRows = deals.map(dealRow);
  const openDeals = allDealRows.filter((row) => isOpenDeal(row));
  const wonDeals = allDealRows.filter((row) => row.wonRatio === 1);
  const contactsDue = contacts.filter((record) => contactDue(record, now)).map((record) => rowBase(record, 'contacts'));
  const openTasks = tasks.filter(isOpenRecord).map((record) => rowBase(record, 'tasks'));
  const scheduledItems = calendarItems.map((record) => rowBase(record, 'calendarItems'));
  const activity = new Map();
  all.forEach(({ record }) => {
    const history = Array.isArray(record.history) ? record.history : [];
    const events = history.length ? history : [{ at: record.updatedAt || record.createdAt }];
    events.forEach((event) => {
      const key = dayKey(event.at || event.date);
      if (key) activity.set(key, (activity.get(key) || 0) + 1);
    });
  });
  const activityByDay = [...activity.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([day, activityCount]) => ({ day, activityCount, value: activityCount }));
  const recentRecords = all
    .map(({ entity, record }) => ({
      ...rowBase(record, entity),
      stageLabel: entity === 'deals' ? dealRow(record).stageLabel : '',
      amount: entity === 'deals' ? amountOf(record) : '',
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
  const pipelineValue = openDeals.reduce((sum, row) => sum + numberValue(row.amountValue), 0);
  return {
    generatedAt: new Date().toISOString(),
    connection: connectionState,
    totals: {
      openTickets: openTickets.length,
      openDeals: openDeals.length,
      wonDeals: wonDeals.length,
      pipelineValue,
      contactsDue: contactsDue.length,
      openTasks: openTasks.length,
      scheduledCount: scheduledItems.length,
    },
    datasets: {
      openTickets,
      openDeals,
      pipelineValueRows: openDeals,
      winRateRows: allDealRows,
      contactsDue,
      openTasks,
      scheduledItems,
      pipelineByStage: openDeals,
      activityByDay,
      recentRecords,
    },
  };
}

export async function reportSummary() {
  const res = await request('/api/reports/summary');
  if (res.ok && res.summary) return res;
  scheduleRefreshAll();
  return { ok: true, summary: summarizeCachedReports(), source: 'cache', apiError: res.error || null };
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
