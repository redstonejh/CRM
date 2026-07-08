const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || process.env.CRM_API_PORT || 3899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/crm';
const VALID_ENTITIES = new Set(['tickets', 'deals', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports']);
const IMMUTABLE_FIELDS = new Set(['id', 'entityType', 'createdAt', 'updatedAt', 'version']);
const REPORT_ENTITIES = [...VALID_ENTITIES];
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
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : body;
  const actor = body.actor || 'unknown';
  const options = body.options || {};
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
  broadcast({ type: 'changed', entity, record });
  json(res, 201, { ok: true, entity, record });
}

async function patchRecord(res, entity, id, body, req) {
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const actor = body.actor || 'unknown';
  const options = body.options || {};
  const ifMatch = req.headers['if-match'] ? Number(String(req.headers['if-match']).replace(/^W\//, '').replace(/"/g, '')) : undefined;
  const expectedVersion = Number.isFinite(body.expectedVersion) ? body.expectedVersion : ifMatch;
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
  const expectedVersion = Number(url.searchParams.get('version'));
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
  if (!lastTouch) return true;
  return now - lastTouch >= 30 * 24 * 60 * 60 * 1000;
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
  const all = REPORT_ENTITIES.flatMap((entity) => records(entity).map((record) => ({ entity, record })));
  const now = Date.now();

  const openTickets = tickets.filter(isOpenRecord).map((record) => rowBase(record, 'tickets'));
  const allDealRows = deals.map(dealRow);
  const openDeals = allDealRows.filter((row) => isOpenDeal(row));
  const wonDeals = allDealRows.filter((row) => row.wonRatio === 1);
  const contactsDue = contacts.filter((record) => contactDue(record, now)).map((record) => rowBase(record, 'contacts'));
  const openTasks = tasks.filter(isOpenRecord).map((record) => rowBase(record, 'tasks'));
  const scheduledItems = calendarItems.map((record) => rowBase(record, 'calendarItems'));

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
      stageLabel: entity === 'deals' ? dealRow(record).stageLabel : '',
      amount: entity === 'deals' ? amountOf(record) : '',
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);

  const pipelineValue = openDeals.reduce((sum, row) => sum + numberValue(row.amountValue), 0);
  return {
    generatedAt: new Date().toISOString(),
    connection,
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
