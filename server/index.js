const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || process.env.CRM_API_PORT || 3899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/crm';
const VALID_ENTITIES = new Set(['tickets', 'deals', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'invoices', 'interactions']);
const IMMUTABLE_FIELDS = new Set(['id', 'entityType', 'createdAt', 'updatedAt', 'version']);
const REPORT_ENTITIES = [...VALID_ENTITIES];
const CREATE_BODY_KEYS = new Set(['fields', 'actor', 'options']);
const PATCH_BODY_KEYS = new Set(['fields', 'actor', 'options', 'expectedVersion']);
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

const pool = new Pool({ connectionString: DATABASE_URL });
const clients = new Set();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,if-match',
  });
  res.end(body);
}

function ok(res, payload = {}) {
  json(res, 200, { ok: true, ...payload });
}

function fail(res, status, error) {
  json(res, status, { ok: false, error });
}

function entityName(raw) {
  const entity = String(raw || '').trim();
  return VALID_ENTITIES.has(entity) ? entity : null;
}

function safeId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function dateIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function rowToRecord(row) {
  if (!row) return null;
  const doc = row.doc && typeof row.doc === 'object' ? row.doc : {};
  return {
    ...doc,
    id: row.id,
    entityType: row.entity_type,
    createdAt: dateIso(row.created_at),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    version: row.version,
    deletedAt: row.deleted_at ? dateIso(row.deleted_at) : null,
    assignee: row.assignee == null ? (doc.assignee ?? null) : row.assignee,
    history: Array.isArray(doc.history) ? doc.history : [],
  };
}

function docFrom(fields) {
  const doc = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (IMMUTABLE_FIELDS.has(key)) continue;
    if (key === 'deletedAt') continue;
    doc[key] = value;
  }
  return doc;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function objectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function rejectUnknownBodyKeys(res, body, allowed) {
  if (!objectBody(body)) { fail(res, 400, 'JSON body must be an object'); return true; }
  if (hasOwn(body, 'doc')) { fail(res, 400, 'Use fields instead of doc'); return true; }
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) { fail(res, 400, `Unknown body keys: ${unknown.join(', ')}`); return true; }
  if (hasOwn(body, 'fields') && (!objectBody(body.fields))) { fail(res, 400, 'fields must be an object'); return true; }
  return false;
}

function changedValue(a, b) {
  if (Object.is(a, b)) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
  }
  return true;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function broadcast(message) {
  const body = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(body);
  }
}

const RELATED_ENTITY_FIELDS = {
  ticketId: 'tickets',
  ticketIds: 'tickets',
  relatedTicketIds: 'tickets',
  dealId: 'deals',
  dealIds: 'deals',
  relatedDealIds: 'deals',
  contactId: 'contacts',
  contactIds: 'contacts',
  relatedContactIds: 'contacts',
  companyId: 'companies',
  companyIds: 'companies',
  relatedCompanyIds: 'companies',
  invoiceId: 'invoices',
  invoiceIds: 'invoices',
  relatedInvoiceIds: 'invoices',
  taskId: 'tasks',
  taskIds: 'tasks',
  relatedTaskIds: 'tasks',
  calendarItemId: 'calendarItems',
  calendarItemIds: 'calendarItems',
  relatedCalendarItemIds: 'calendarItems',
};

function toArray(value) {
  return Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
}

function fanoutEntity(raw) {
  const entity = entityName(raw);
  return entity && !['interactions', 'reports'].includes(entity) ? entity : null;
}

function normalizeRelatedRefs(record) {
  const refs = [];
  const seen = new Set();
  const push = (entityRaw, idRaw) => {
    const entity = fanoutEntity(entityRaw);
    const id = safeId(idRaw);
    if (!entity || !id) return;
    const key = `${entity}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ entity, id });
    }
  };

  const relatedIds = record?.relatedIds;
  if (Array.isArray(relatedIds)) {
    relatedIds.forEach((item) => {
      if (typeof item === 'string') {
        const match = /^([a-zA-Z][\w-]*)[:/](.+)$/.exec(item.trim());
        if (match) push(match[1], match[2]);
        return;
      }
      if (item && typeof item === 'object') {
        push(item.entity || item.entityType || item.type, item.id || item.recordId);
      }
    });
  } else if (relatedIds && typeof relatedIds === 'object') {
    Object.entries(relatedIds).forEach(([entity, ids]) => {
      toArray(ids).forEach((id) => push(entity, id));
    });
  }

  Object.entries(RELATED_ENTITY_FIELDS).forEach(([field, entity]) => {
    toArray(record?.[field]).forEach((id) => push(entity, id));
  });
  return refs;
}

async function fanOutInteraction(interaction, actor = 'unknown') {
  const refs = normalizeRelatedRefs(interaction);
  if (!refs.length) return [];
  const at = interaction.at || new Date().toISOString();
  const detail = firstText(interaction.note, interaction.description, interaction.summary, interaction.kind, 'Interaction logged');
  const changed = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ref of refs) {
      const rows = await client.query(
        'SELECT * FROM crm_records WHERE entity_type = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
        [ref.entity, ref.id],
      );
      const cur = rows.rows[0];
      if (!cur) continue;
      const prevDoc = cur.doc && typeof cur.doc === 'object' ? cur.doc : {};
      const nextDoc = {
        ...prevDoc,
        lastTouchAt: at,
        history: [
          ...(Array.isArray(prevDoc.history) ? prevDoc.history : []),
          {
            at,
            by: actor,
            action: 'interaction',
            detail,
            interactionId: interaction.id,
            kind: interaction.kind || null,
          },
        ],
      };
      const updated = await client.query(
        `UPDATE crm_records
         SET doc = $3, version = version + 1, updated_at = now()
         WHERE entity_type = $1 AND id = $2
         RETURNING *`,
        [ref.entity, ref.id, nextDoc],
      );
      changed.push({ entity: ref.entity, record: rowToRecord(updated.rows[0]) });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  changed.forEach(({ entity, record }) => broadcast({ type: 'changed', entity, record }));
  return changed.map(({ entity, record }) => ({ entity, id: record.id, version: record.version }));
}

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function listRecords(res, entity, url) {
  const includeDeleted = url.searchParams.get('includeDeleted') !== 'false';
  const rows = await pool.query(
    `SELECT * FROM crm_records
     WHERE entity_type = $1 AND ($2::boolean OR deleted_at IS NULL)
     ORDER BY updated_at DESC`,
    [entity, includeDeleted],
  );
  ok(res, { entity, records: rows.rows.map(rowToRecord), connection: 'live' });
}

async function getRecord(res, entity, id) {
  const rows = await pool.query('SELECT * FROM crm_records WHERE entity_type = $1 AND id = $2', [entity, id]);
  ok(res, { entity, record: rowToRecord(rows.rows[0]) });
}

async function createRecord(res, entity, body) {
  const payload = objectBody(body);
  if (!payload) return fail(res, 400, 'JSON body must be an object');
  if (hasOwn(payload, 'fields')) {
    const rejected = rejectUnknownBodyKeys(res, payload, CREATE_BODY_KEYS);
    if (rejected) return rejected;
  } else if (hasOwn(payload, 'doc')) {
    return fail(res, 400, 'Use fields instead of doc');
  }
  const fields = hasOwn(payload, 'fields') ? payload.fields : payload;
  const actor = hasOwn(payload, 'fields') ? (payload.actor || 'unknown') : 'unknown';
  const options = hasOwn(payload, 'fields') ? (payload.options || {}) : {};
  const nowIso = new Date().toISOString();
  const id = safeId(fields.id || `${options.idPrefix || entity}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
  const createdAt = fields.createdAt || nowIso;
  const history = Array.isArray(fields.history) ? fields.history : [{
    at: nowIso,
    by: actor,
    action: options.action || 'created',
    detail: options.detail || `Created ${entity}`,
  }];
  const doc = {
    ...docFrom(fields),
    history,
  };
  const result = await pool.query(
    `INSERT INTO crm_records (entity_type, id, created_at, updated_at, version, deleted_at, assignee, doc)
     VALUES ($1, $2, $3, now(), 1, $4, $5, $6)
     RETURNING *`,
    [entity, id, createdAt, fields.deletedAt || null, fields.assignee || null, doc],
  ).catch((err) => {
    if (err && err.code === '23505') return null;
    throw err;
  });
  if (!result) return fail(res, 409, `${entity} already exists`);
  const record = rowToRecord(result.rows[0]);
  let relatedRecords = [];
  if (entity === 'interactions') relatedRecords = await fanOutInteraction(record, actor);
  broadcast({ type: 'changed', entity, record });
  json(res, 201, { ok: true, entity, record, relatedRecords });
}

async function patchRecord(res, entity, id, body, req) {
  const payload = objectBody(body);
  if (!payload) return fail(res, 400, 'JSON body must be an object');
  const rejected = rejectUnknownBodyKeys(res, payload, PATCH_BODY_KEYS);
  if (rejected) return rejected;
  const fields = hasOwn(payload, 'fields') ? payload.fields : {};
  const actor = payload.actor || 'unknown';
  const options = payload.options || {};
  const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/^W\//, '').replace(/"/g, '')) : undefined;
  const expectedVersion = Number.isFinite(payload.expectedVersion) ? payload.expectedVersion : ifMatch;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query('SELECT * FROM crm_records WHERE entity_type = $1 AND id = $2 FOR UPDATE', [entity, id]);
    const cur = rows.rows[0];
    if (!cur) {
      await client.query('ROLLBACK');
      return fail(res, 404, `No such ${entity}`);
    }
    if (Number.isFinite(expectedVersion) && cur.version !== expectedVersion) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Version conflict: expected ${expectedVersion}, found ${cur.version}`);
    }
    const prevDoc = cur.doc && typeof cur.doc === 'object' ? cur.doc : {};
    const nextDoc = { ...prevDoc };
    const changed = [];
    for (const [key, value] of Object.entries(fields)) {
      if (IMMUTABLE_FIELDS.has(key) || key === 'deletedAt') continue;
      if (changedValue(nextDoc[key], value)) {
        nextDoc[key] = value;
        changed.push(key);
      }
    }
    let deletedAt = cur.deleted_at;
    if (Object.prototype.hasOwnProperty.call(fields, 'deletedAt')) {
      deletedAt = fields.deletedAt || null;
      changed.push('deletedAt');
    }
    let assignee = cur.assignee;
    if (Object.prototype.hasOwnProperty.call(fields, 'assignee')) {
      assignee = fields.assignee || null;
    }
    if (options.history !== false) {
      nextDoc.history = Array.isArray(nextDoc.history) ? nextDoc.history : [];
      nextDoc.history = [...nextDoc.history, {
        at: new Date().toISOString(),
        by: actor,
        action: options.action || 'edited',
        detail: options.detail || (changed.length ? `Edited ${changed.join(', ')}` : 'Edited'),
      }];
    }
    const updated = await client.query(
      `UPDATE crm_records
       SET doc = $3, assignee = $4, deleted_at = $5, version = version + 1, updated_at = now()
       WHERE entity_type = $1 AND id = $2
       RETURNING *`,
      [entity, id, nextDoc, assignee, deletedAt],
    );
    await client.query('COMMIT');
    const record = rowToRecord(updated.rows[0]);
    broadcast({ type: 'changed', entity, record });
    ok(res, { entity, record, changed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteRecord(res, entity, id, url, body) {
  const hard = url.searchParams.get('hard') === '1' || url.searchParams.get('hard') === 'true';
  // Number(null) is 0 — a finite value — so an absent version param must be
  // detected explicitly or every version-less delete 409s against "expected 0".
  const expectedVersion = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : NaN;
  const actor = body.actor || 'unknown';
  if (hard) {
    const rows = Number.isFinite(expectedVersion)
      ? await pool.query('DELETE FROM crm_records WHERE entity_type = $1 AND id = $2 AND version = $3 RETURNING version', [entity, id, expectedVersion])
      : await pool.query('DELETE FROM crm_records WHERE entity_type = $1 AND id = $2 RETURNING version', [entity, id]);
    if (!rows.rowCount) {
      if (Number.isFinite(expectedVersion)) {
        const exists = await pool.query('SELECT version FROM crm_records WHERE entity_type = $1 AND id = $2', [entity, id]);
        if (exists.rowCount) return fail(res, 409, `Version conflict: expected ${expectedVersion}, found ${exists.rows[0].version}`);
      }
      return fail(res, 404, `No such ${entity}`);
    }
    broadcast({ type: 'deleted', entity, id });
    return ok(res, { entity, id, deleted: true });
  }
  return patchRecord(res, entity, id, {
    fields: { deletedAt: new Date().toISOString() },
    actor,
    expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : undefined,
    options: { action: 'deleted', detail: `Deleted ${entity}` },
  }, { headers: {} });
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
  if (!lastTouch) return true;
  return now - lastTouch >= 30 * 24 * 60 * 60 * 1000;
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
    stageLabel: DEAL_STAGE_LABELS[stage] || firstText(stage.replace(/-/g, ' '), 'Unbucketed'),
    amountValue: amountOf(record),
    amount: amountOf(record),
    wonRatio: isWonDeal(record) ? 1 : 0,
  };
}

function summarizeRecords(recordsByEntity, connection = 'live') {
  const records = (entity) => (recordsByEntity[entity] || []).filter((record) => !record.deletedAt);
  const tickets = records('tickets');
  const deals = records('deals');
  const contacts = records('contacts');
  const tasks = records('tasks');
  const calendarItems = records('calendarItems');
  const invoices = records('invoices');
  const all = REPORT_ENTITIES.flatMap((entity) => records(entity).map((record) => ({ entity, record })));
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
  const bumpActivity = (date) => {
    const key = dayKey(date);
    if (key) activity.set(key, (activity.get(key) || 0) + 1);
  };
  all.forEach(({ record }) => {
    const history = Array.isArray(record.history) ? record.history : [];
    if (history.length) history.forEach((event) => bumpActivity(event.at || event.date || record.updatedAt));
    else bumpActivity(record.updatedAt || record.createdAt);
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
    connection,
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

async function reportSummary(res) {
  const rows = await pool.query(
    `SELECT * FROM crm_records
     WHERE entity_type = ANY($1::text[]) AND deleted_at IS NULL
     ORDER BY updated_at DESC`,
    [REPORT_ENTITIES],
  );
  const recordsByEntity = Object.fromEntries(REPORT_ENTITIES.map((entity) => [entity, []]));
  rows.rows.map(rowToRecord).forEach((record) => {
    if (recordsByEntity[record.entityType]) recordsByEntity[record.entityType].push(record);
  });
  ok(res, { summary: summarizeRecords(recordsByEntity, 'live') });
}

let overdueSweepRunning = false;

async function sweepOverdueInvoices() {
  if (overdueSweepRunning) return [];
  overdueSweepRunning = true;
  const changed = [];
  const now = Date.now();
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT * FROM crm_records
       WHERE entity_type = 'invoices' AND deleted_at IS NULL
       FOR UPDATE`,
    );
    for (const cur of rows.rows) {
      const doc = cur.doc && typeof cur.doc === 'object' ? cur.doc : {};
      const rawState = firstText(doc.state, metaOf(doc).state, doc.status, metaOf(doc).status).toLowerCase();
      if (rawState !== 'sent' || daysPastDue(invoiceDueDate(doc), now) <= 0) continue;
      const nextDoc = {
        ...doc,
        state: 'overdue',
        stage: 'overdue',
        priority: 'overdue',
        history: [
          ...(Array.isArray(doc.history) ? doc.history : []),
          {
            at: new Date().toISOString(),
            by: 'system',
            action: 'overdue',
            detail: 'Invoice moved overdue',
          },
        ],
      };
      const updated = await client.query(
        `UPDATE crm_records
         SET doc = $3, version = version + 1, updated_at = now()
         WHERE entity_type = $1 AND id = $2
         RETURNING *`,
        ['invoices', cur.id, nextDoc],
      );
      changed.push(rowToRecord(updated.rows[0]));
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
    overdueSweepRunning = false;
  }
  changed.forEach((record) => broadcast({ type: 'changed', entity: 'invoices', record }));
  return changed;
}

function startOverdueSweep() {
  sweepOverdueInvoices().catch((err) => console.error('[overdue-sweep]', err));
  const timer = setInterval(() => {
    sweepOverdueInvoices().catch((err) => console.error('[overdue-sweep]', err));
  }, 60000);
  if (typeof timer.unref === 'function') timer.unref();
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health' || url.pathname === '/api/health') return ok(res, { status: 'live' });
  if (url.pathname === '/api/reports/summary' && req.method === 'GET') return reportSummary(res);

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'entities') return fail(res, 404, 'Not found');
  const entity = entityName(parts[2]);
  if (!entity) return fail(res, 404, 'Unknown entity');
  const id = parts[3] ? safeId(decodeURIComponent(parts[3])) : null;

  if (req.method === 'GET' && !id) return listRecords(res, entity, url);
  if (req.method === 'GET' && id) return getRecord(res, entity, id);
  if (req.method === 'POST' && !id) return createRecord(res, entity, await readBody(req));
  if (req.method === 'PATCH' && id) return patchRecord(res, entity, id, await readBody(req), req);
  if (req.method === 'DELETE' && id) return deleteRecord(res, entity, id, url, await readBody(req).catch(() => ({})));
  return fail(res, 405, 'Method not allowed');
}

async function main() {
  await initDb();
  startOverdueSweep();
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      fail(res, 500, 'Internal server error');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.send(JSON.stringify({ type: 'hello', entities: [...VALID_ENTITIES] }));
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/changes') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  server.listen(PORT, () => {
    console.log(`CRM API listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
