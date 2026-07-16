// API-backed CRM entity store.
//
// The Electron client talks to the Postgres API in server/. The in-process cache
// keeps the existing ticket UI contract synchronous for reads, while writes go
// through REST with optimistic compare-and-set on record version. WebSocket
// change events keep every entity bridge fresh.
import WebSocket from 'ws';

const DEFAULT_API_URL = process.env.CRM_API_URL || 'http://127.0.0.1:3899';
const ENTITIES = ['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'bills', 'invoices', 'interactions', 'projects', 'workItems'];
const IMMUTABLE_FIELDS = new Set(['id', 'entityType', 'createdAt', 'history', 'version']);
const CLOSED_STATES = new Set(['resolved', 'done', 'closed', 'complete', 'completed', 'cancelled', 'archived']);
const DEAL_OUTCOME_STATES = new Set(['won', 'lost']);
const PAID_INVOICE_STATES = new Set(['paid', 'void', 'cancelled', 'canceled']);
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

function normalizeApiUrl(url) {
  const raw = String(url || '').trim();
  return raw ? raw.replace(/\/+$/, '') : apiUrl;
}

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

function disconnectSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!ws) return;
  const old = ws;
  ws = null;
  try { old.removeAllListeners(); } catch {}
  try { old.close(); } catch {}
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
      if (msg.type === 'domain-changed') {
        emitChange();
        return;
      }
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
  const nextUrl = normalizeApiUrl(url);
  const changed = nextUrl !== apiUrl;
  if (changed) {
    apiUrl = nextUrl;
    pendingRefresh.clear();
    loadedEntities.clear();
    entityStores.forEach((map) => map.clear());
    disconnectSocket();
    setConnection('offline');
    emitChange();
  }
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

export function storeConnectionInfo() {
  return {
    apiUrl,
    connection: connectionState,
    loadedEntities: [...loadedEntities],
    pendingEntities: [...pendingRefresh],
  };
}

export async function storeHealth() {
  const res = await request('/api/health');
  return {
    ok: !!res.ok,
    apiUrl,
    connection: connectionState,
    status: res.status || (res.ok ? 'live' : 'offline'),
    error: res.error || null,
  };
}

const DOMAIN_RESOURCES = new Set(['relationships', 'commitments', 'activities', 'workflow-entries']);

function safeDomainResource(resource) {
  const key = String(resource || '').trim();
  if (!DOMAIN_RESOURCES.has(key)) throw new Error(`Invalid domain resource: ${resource}`);
  return key;
}

function domainQuery(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export async function listDomain(resource, query = {}) {
  const key = safeDomainResource(resource);
  return request(`/api/domain/${encodeURIComponent(key)}${domainQuery(query)}`);
}

export async function getDomain(resource, id) {
  const key = safeDomainResource(resource);
  return request(`/api/domain/${encodeURIComponent(key)}/${encodeURIComponent(safeId(id))}`);
}

export async function createDomain(resource, fields = {}) {
  const key = safeDomainResource(resource);
  return request(`/api/domain/${encodeURIComponent(key)}`, { method: 'POST', body: { fields } });
}

export async function updateDomain(resource, id, fields = {}, expectedVersion) {
  const key = safeDomainResource(resource);
  return request(`/api/domain/${encodeURIComponent(key)}/${encodeURIComponent(safeId(id))}`, {
    method: 'PATCH', body: { fields, expectedVersion },
  });
}

export async function deleteDomain(resource, id, { hard = false } = {}) {
  const key = safeDomainResource(resource);
  const suffix = hard ? '?hard=true' : '';
  return request(`/api/domain/${encodeURIComponent(key)}/${encodeURIComponent(safeId(id))}${suffix}`, { method: 'DELETE' });
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
    record?.number,
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

function dateOnly(value) {
  const text = String(value ?? '').trim();
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (direct) return direct[1];
  const ms = timestampOf(value);
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

function daysPastDue(value, now = Date.now()) {
  const day = dateOnly(value);
  if (!day) return 0;
  const today = new Date(now).toISOString().slice(0, 10);
  const dueMs = Date.parse(`${day}T00:00:00.000Z`);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs) || dueMs >= todayMs) return 0;
  return Math.floor((todayMs - dueMs) / 86400000);
}

function invoiceDueDate(record) {
  const meta = metaOf(record);
  return firstText(record?.dueDate, meta.dueDate);
}

function nextTouchDate(record) {
  const meta = metaOf(record);
  return dateOnly(firstText(record?.nextTouchAt, meta.nextTouchAt));
}

function coldFrontTouch(record, entity) {
  const meta = metaOf(record);
  return firstText(
    record?.lastTouchAt,
    meta.lastTouchAt,
    record?.lastContactAt,
    meta.lastContactAt,
    entity === 'invoices' ? firstText(record?.sentAt, meta.sentAt) : '',
    record?.createdAt,
    record?.updatedAt,
  );
}

function coldFrontHalfLife(record, entity, now = Date.now()) {
  if (entity === 'contacts') return 21;
  if (entity === 'deals') return dealStage(record) === 'proposal' ? 5 : 10;
  if (entity === 'invoices') return ['sent', 'overdue'].includes(invoiceState(record, now)) ? 5 : 0;
  return 0;
}

function coldFrontOf(record, entity, now = Date.now()) {
  const halfLife = coldFrontHalfLife(record, entity, now);
  if (!halfLife) return {};
  const touch = timestampOf(coldFrontTouch(record, entity));
  const days = touch ? Math.max(0, (now - touch) / 86400000) : halfLife;
  const staleness = Math.max(0, Math.min(1, days / halfLife));
  return {
    staleness,
    coldFront: staleness >= 1,
    lastTouchAt: touch ? new Date(touch).toISOString() : '',
  };
}

function invoiceState(record, now = Date.now()) {
  const meta = metaOf(record);
  const state = firstText(record?.state, meta.state, record?.status, meta.status, record?.stage, meta.stage).toLowerCase();
  if (state === 'sent' && daysPastDue(invoiceDueDate(record), now) > 0) return 'overdue';
  return state || 'draft';
}

function isPaidInvoice(record, now = Date.now()) {
  const state = invoiceState(record, now);
  const meta = metaOf(record);
  return PAID_INVOICE_STATES.has(state) || !!firstText(record?.paidAt, meta.paidAt);
}

function invoiceRow(record, now = Date.now()) {
  const dueDate = dateOnly(invoiceDueDate(record));
  const state = invoiceState(record, now);
  const overdueDays = state === 'overdue' ? daysPastDue(dueDate, now) : 0;
  return {
    ...rowBase(record, 'invoices'),
    state,
    stage: state,
    stageLabel: state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Draft',
    amountValue: amountOf(record),
    amount: amountOf(record),
    dueDate,
    dueAt: dueDate ? Date.parse(`${dueDate}T00:00:00.000Z`) : 0,
    overdueDays,
    isOverdue: state === 'overdue',
    paidAt: firstText(record?.paidAt, metaOf(record).paidAt),
    companyId: record.companyId || metaOf(record).companyId || '',
    dealId: record.dealId || metaOf(record).dealId || '',
  };
}

function invoiceAgingBucket(row) {
  if (!row.isOverdue) return 'current';
  if (row.overdueDays <= 30) return '1-30';
  if (row.overdueDays <= 60) return '31-60';
  return '61+';
}

function invoiceAgingRows(rows) {
  const labels = {
    current: 'Current',
    '1-30': '1-30 days',
    '31-60': '31-60 days',
    '61+': '61+ days',
  };
  const buckets = Object.fromEntries(Object.keys(labels).map((bucket) => [bucket, { bucket, bucketLabel: labels[bucket], count: 0, amountValue: 0, amount: 0 }]));
  rows.forEach((row) => {
    const bucket = buckets[invoiceAgingBucket(row)] || buckets.current;
    bucket.count += 1;
    bucket.amountValue += numberValue(row.amountValue);
    bucket.amount = bucket.amountValue;
  });
  return Object.values(buckets);
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
  const lastTouch = timestampOf(firstText(record?.lastTouchAt, meta.lastTouchAt, record?.lastContactAt, meta.lastContactAt, record?.updatedAt, record?.createdAt));
  return !lastTouch || now - lastTouch >= 30 * 24 * 60 * 60 * 1000;
}

function rowBase(record, entity, now = Date.now()) {
  const updatedAt = timestampOf(record.updatedAt || record.createdAt);
  return {
    id: record.id,
    entity,
    type: entity,
    title: titleOf(record),
    state: stateOf(record) || '',
    updatedAt,
    updated: updatedAt ? new Date(updatedAt).toISOString().slice(0, 10) : '',
    ...coldFrontOf(record, entity, now),
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
  const invoices = records('invoices');
  const all = ENTITIES.flatMap((entity) => records(entity).map((record) => ({ entity, record })));
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const openTickets = tickets.filter(isOpenRecord).map((record) => rowBase(record, 'tickets'));
  const allDealRows = deals.map(dealRow);
  const openDeals = allDealRows.filter((row) => isOpenDeal(row));
  const wonDeals = allDealRows.filter((row) => row.wonRatio === 1);
  const contactsDue = contacts.filter((record) => contactDue(record, now)).map((record) => rowBase(record, 'contacts', now));
  const openTasks = tasks.filter(isOpenRecord).map((record) => rowBase(record, 'tasks'));
  const scheduledItems = calendarItems.map((record) => rowBase(record, 'calendarItems'));
  const allInvoiceRows = invoices.map((record) => invoiceRow(record, now));
  const outstandingInvoices = allInvoiceRows.filter((row) => !isPaidInvoice(row, now));
  const overdueInvoices = outstandingInvoices.filter((row) => row.isOverdue);
  const invoiceAging = invoiceAgingRows(outstandingInvoices);
  const datedTaskRows = openTasks.map((row) => {
    const record = tasks.find((task) => task.id === row.id) || {};
    const meta = metaOf(record);
    return {
      ...row,
      dueDate: dateOnly(firstText(record.dueDate, meta.dueDate, record.scheduledDate, meta.scheduledDate)),
      reason: 'task',
    };
  });
  const datedCalendarRows = scheduledItems.map((row) => {
    const record = calendarItems.find((item) => item.id === row.id) || {};
    const meta = metaOf(record);
    return {
      ...row,
      dueDate: dateOnly(firstText(record.date, meta.date, record.scheduledDate, meta.scheduledDate, record.startDate, meta.startDate, record.at, meta.at)),
      reason: 'calendar',
    };
  });
  const nextTouchRows = [
    ...contacts.filter(isOpenRecord).map((record) => ({ ...rowBase(record, 'contacts', now), dueDate: nextTouchDate(record), reason: 'next-touch' })),
    ...deals.filter(isOpenDeal).map((record) => ({ ...dealRow(record), dueDate: nextTouchDate(record), reason: 'next-touch' })),
    ...invoices
      .filter((record) => ['sent', 'overdue'].includes(invoiceState(record, now)))
      .map((record) => ({ ...invoiceRow(record, now), dueDate: nextTouchDate(record), reason: 'next-touch' })),
  ].filter((row) => row.dueDate && row.dueDate <= today);
  const coldFrontRows = [
    ...contacts.filter(isOpenRecord).map((record) => ({ ...rowBase(record, 'contacts', now), reason: 'cold-front' })),
    ...deals.filter(isOpenDeal).map((record) => ({ ...dealRow(record), reason: 'cold-front' })),
  ].filter((row) => row.coldFront);
  const uniqueTodayRows = (rows) => {
    const seen = new Set();
    return rows.filter((row) => {
      const key = `${row.entity || row.type}:${row.id}`;
      if (!row.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const todayHand = uniqueTodayRows([
    ...nextTouchRows,
    ...coldFrontRows,
    ...datedTaskRows.filter((row) => row.dueDate === today),
    ...datedCalendarRows.filter((row) => row.dueDate === today),
    ...outstandingInvoices.filter((row) => row.isOverdue || row.dueDate === today).map((row) => ({ ...row, reason: row.isOverdue ? 'invoice-overdue' : 'invoice-due' })),
    ...contactsDue.map((row) => ({ ...row, reason: 'contact-touch' })),
  ]).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 100);
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
      stageLabel: entity === 'deals' ? dealRow(record).stageLabel : (entity === 'invoices' ? invoiceRow(record, now).stageLabel : ''),
      amount: ['deals', 'invoices'].includes(entity) ? amountOf(record) : '',
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
  const pipelineValue = openDeals.reduce((sum, row) => sum + numberValue(row.amountValue), 0);
  const outstandingCash = outstandingInvoices.reduce((sum, row) => sum + numberValue(row.amountValue), 0);
  return {
    generatedAt: new Date().toISOString(),
    connection: connectionState,
    totals: {
      openTickets: openTickets.length,
      openDeals: openDeals.length,
      wonDeals: wonDeals.length,
      pipelineValue,
      outstandingCash,
      outstandingInvoices: outstandingInvoices.length,
      overdueInvoices: overdueInvoices.length,
      invoiceAgingTotal: outstandingCash,
      contactsDue: contactsDue.length,
      openTasks: openTasks.length,
      scheduledCount: scheduledItems.length,
      todayHand: todayHand.length,
      coldFront: coldFrontRows.length,
    },
    datasets: {
      openTickets,
      openDeals,
      pipelineValueRows: openDeals,
      winRateRows: allDealRows,
      contactsDue,
      openTasks,
      scheduledItems,
      outstandingInvoices,
      overdueInvoices,
      invoiceAging,
      todayHand,
      coldFrontRows,
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
