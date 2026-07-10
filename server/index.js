const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || process.env.CRM_API_PORT || 3899);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/crm';
const VALID_ENTITIES = new Set(['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'invoices', 'interactions']);
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

const DOMAIN_SPECS = {
  relationships: {
    table: 'crm_relationships', prefix: 'rel',
    fields: {
      fromEntity: 'from_entity', fromId: 'from_id', toEntity: 'to_entity', toId: 'to_id',
      kind: 'kind', role: 'role',
    },
    required: ['fromEntity', 'fromId', 'toEntity', 'toId'],
  },
  commitments: {
    table: 'crm_commitments', prefix: 'com', linkTable: 'crm_commitment_links', linkKey: 'commitment_id',
    fields: {
      title: 'title', kind: 'kind', status: 'status', dueAt: 'due_at', assignee: 'assignee',
      visibility: 'visibility', priority: 'priority', completedAt: 'completed_at', outcome: 'outcome',
    },
    dates: new Set(['dueAt', 'completedAt']), required: ['title'],
  },
  activities: {
    table: 'crm_activities', prefix: 'act', linkTable: 'crm_activity_links', linkKey: 'activity_id',
    fields: { kind: 'kind', occurredAt: 'occurred_at', actor: 'actor', content: 'content' },
    dates: new Set(['occurredAt']),
  },
  'workflow-entries': {
    table: 'crm_workflow_entries', prefix: 'flow',
    fields: {
      workflowKey: 'workflow_key', entityType: 'entity_type', recordId: 'record_id',
      stage: 'stage', rank: 'rank', owner: 'owner',
    },
    required: ['workflowKey', 'entityType', 'recordId', 'stage'],
  },
};

const DOMAIN_RESERVED = new Set([
  'id', 'resource', 'createdAt', 'updatedAt', 'version', 'deletedAt', 'links', 'actor', 'expectedVersion',
]);

function domainSpec(raw) {
  const key = String(raw || '').trim();
  return DOMAIN_SPECS[key] ? { key, ...DOMAIN_SPECS[key] } : null;
}

function domainId(spec) {
  return `${spec.prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function domainDoc(spec, fields, previous = {}) {
  const doc = { ...(previous && typeof previous === 'object' ? previous : {}) };
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (!spec.fields[key] && !DOMAIN_RESERVED.has(key)) doc[key] = value;
  });
  return doc;
}

function normalizeDomainLinks(links) {
  if (!Array.isArray(links)) return [];
  const seen = new Set();
  return links.map((link) => ({
    entityType: String(link?.entityType || link?.entity || '').trim(),
    recordId: safeId(link?.recordId || link?.id),
    relation: String(link?.relation || 'regarding').trim() || 'regarding',
  })).filter((link) => {
    const key = `${link.entityType}:${link.recordId}:${link.relation}`;
    if (!link.entityType || !link.recordId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function domainValue(spec, key, value) {
  if (spec.dates?.has(key)) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`${key} must be a valid date`);
    return date.toISOString();
  }
  if (key === 'rank') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('rank must be a number');
    return number;
  }
  return value;
}

function domainRow(spec, row, links = []) {
  if (!row) return null;
  const record = { ...(row.doc && typeof row.doc === 'object' ? row.doc : {}) };
  Object.entries(spec.fields).forEach(([api, column]) => { record[api] = row[column]; });
  for (const key of spec.dates || []) record[key] = dateIso(record[key]);
  return {
    ...record,
    id: row.id,
    resource: spec.key,
    createdAt: dateIso(row.created_at),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    version: row.version,
    deletedAt: dateIso(row.deleted_at),
    ...(spec.linkTable ? { links } : {}),
  };
}

async function domainLinks(client, spec, ids) {
  if (!spec.linkTable || !ids.length) return new Map();
  const rows = await client.query(
    `SELECT ${spec.linkKey}, entity_type, record_id, relation FROM ${spec.linkTable} WHERE ${spec.linkKey} = ANY($1::text[])`,
    [ids],
  );
  const map = new Map(ids.map((id) => [id, []]));
  rows.rows.forEach((row) => map.get(row[spec.linkKey])?.push({
    entityType: row.entity_type, recordId: row.record_id, relation: row.relation,
  }));
  return map;
}

async function replaceDomainLinks(client, spec, id, links) {
  if (!spec.linkTable) return;
  await client.query(`DELETE FROM ${spec.linkTable} WHERE ${spec.linkKey} = $1`, [id]);
  for (const link of normalizeDomainLinks(links)) {
    await client.query(
      `INSERT INTO ${spec.linkTable} (${spec.linkKey}, entity_type, record_id, relation) VALUES ($1, $2, $3, $4)`,
      [id, link.entityType, link.recordId, link.relation],
    );
  }
}

async function listDomain(res, spec, url) {
  const where = [];
  const values = [];
  let linkJoin = '';
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (url.searchParams.get('includeDeleted') !== 'true') where.push('d.deleted_at IS NULL');
  const directFilters = {
    status: 'status', assignee: 'assignee', workflowKey: 'workflow_key', stage: 'stage',
    entityType: spec.key === 'relationships' ? 'from_entity' : 'entity_type',
    recordId: spec.key === 'relationships' ? 'from_id' : 'record_id',
  };
  Object.entries(directFilters).forEach(([param, column]) => {
    if (spec.fields[param] && url.searchParams.has(param)) add(`d.${column} = ?`, url.searchParams.get(param));
  });
  if (spec.key === 'relationships' && url.searchParams.has('relatedEntity') && url.searchParams.has('relatedId')) {
    const entity = url.searchParams.get('relatedEntity');
    const id = safeId(url.searchParams.get('relatedId'));
    values.push(entity, id, entity, id);
    const n = values.length;
    where.push(`((d.from_entity = $${n - 3} AND d.from_id = $${n - 2}) OR (d.to_entity = $${n - 1} AND d.to_id = $${n}))`);
  }
  if (spec.linkTable && url.searchParams.has('entityType') && url.searchParams.has('recordId')) {
    values.push(url.searchParams.get('entityType'), safeId(url.searchParams.get('recordId')));
    const n = values.length;
    linkJoin = `JOIN ${spec.linkTable} l ON l.${spec.linkKey} = d.id`;
    where.push(`l.entity_type = $${n - 1} AND l.record_id = $${n}`);
  }
  if (spec.key === 'commitments' && url.searchParams.has('dueBefore')) add('d.due_at <= ?', url.searchParams.get('dueBefore'));
  if (spec.key === 'commitments' && url.searchParams.has('dueAfter')) add('d.due_at >= ?', url.searchParams.get('dueAfter'));
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
  values.push(limit);
  const rows = await pool.query(
    `SELECT d.* FROM ${spec.table} d ${linkJoin} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC LIMIT $${values.length}`,
    values,
  );
  const links = await domainLinks(pool, spec, rows.rows.map((row) => row.id));
  ok(res, { resource: spec.key, records: rows.rows.map((row) => domainRow(spec, row, links.get(row.id) || [])) });
}

async function getDomain(res, spec, id) {
  const rows = await pool.query(`SELECT * FROM ${spec.table} WHERE id = $1`, [id]);
  if (!rows.rows[0]) return fail(res, 404, 'Not found');
  const links = await domainLinks(pool, spec, [id]);
  ok(res, { resource: spec.key, record: domainRow(spec, rows.rows[0], links.get(id) || []) });
}

async function createDomain(res, spec, body) {
  if (!objectBody(body)) return fail(res, 400, 'JSON body must be an object');
  const fields = objectBody(body.fields) || body;
  const missing = (spec.required || []).filter((key) => fields[key] == null || fields[key] === '');
  if (missing.length) return fail(res, 400, `Missing required fields: ${missing.join(', ')}`);
  const id = safeId(fields.id) || domainId(spec);
  const columns = ['id', 'doc'];
  const values = [id, domainDoc(spec, fields)];
  Object.entries(spec.fields).forEach(([api, column]) => {
    if (!hasOwn(fields, api)) return;
    columns.push(column);
    values.push(domainValue(spec, api, fields[api]));
  });
  const placeholders = values.map((_, index) => `$${index + 1}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`, values,
    );
    await replaceDomainLinks(client, spec, id, fields.links || body.links || []);
    await client.query('COMMIT');
    const linkMap = await domainLinks(pool, spec, [id]);
    const record = domainRow(spec, inserted.rows[0], linkMap.get(id) || []);
    broadcast({ type: 'domain-changed', resource: spec.key, record });
    json(res, 201, { ok: true, resource: spec.key, record });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 409, 'A matching active record already exists');
    throw err;
  } finally { client.release(); }
}

async function patchDomain(res, spec, id, body) {
  if (!objectBody(body)) return fail(res, 400, 'JSON body must be an object');
  const fields = objectBody(body.fields) || body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(`SELECT * FROM ${spec.table} WHERE id = $1 FOR UPDATE`, [id]);
    const current = selected.rows[0];
    if (!current) { await client.query('ROLLBACK'); return fail(res, 404, 'Not found'); }
    const expected = Number(body.expectedVersion ?? fields.expectedVersion);
    if (Number.isFinite(expected) && expected !== current.version) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Version conflict');
    }
    const sets = ['doc = $2', 'version = version + 1', 'updated_at = now()'];
    const values = [id, domainDoc(spec, fields, current.doc)];
    Object.entries(spec.fields).forEach(([api, column]) => {
      if (!hasOwn(fields, api)) return;
      values.push(domainValue(spec, api, fields[api]));
      sets.push(`${column} = $${values.length}`);
    });
    const updated = await client.query(
      `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values,
    );
    if (spec.linkTable && (hasOwn(fields, 'links') || hasOwn(body, 'links'))) {
      await replaceDomainLinks(client, spec, id, fields.links || body.links || []);
    }
    await client.query('COMMIT');
    const linkMap = await domainLinks(pool, spec, [id]);
    const record = domainRow(spec, updated.rows[0], linkMap.get(id) || []);
    broadcast({ type: 'domain-changed', resource: spec.key, record });
    ok(res, { resource: spec.key, record });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 409, 'A matching active record already exists');
    throw err;
  } finally { client.release(); }
}

async function deleteDomain(res, spec, id, url) {
  const hard = url.searchParams.get('hard') === 'true';
  const rows = hard
    ? await pool.query(`DELETE FROM ${spec.table} WHERE id = $1 RETURNING *`, [id])
    : await pool.query(`UPDATE ${spec.table} SET deleted_at = now(), updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`, [id]);
  if (!rows.rows[0]) return fail(res, 404, 'Not found');
  broadcast({ type: 'domain-changed', resource: spec.key, id, deleted: true, hard });
  ok(res, { resource: spec.key, id, deleted: true, hard });
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

// One-way compatibility projection. Existing installs keep their data, while
// the reconstructed UI reads the explicit operating model from first boot.
async function migrateLegacyDomain() {
  const rows = await pool.query('SELECT * FROM crm_records WHERE deleted_at IS NULL');
  const records = rows.rows.map(rowToRecord);
  const companyByName = new Map(records.filter((record) => record.entityType === 'companies').map((company) => [
    firstText(company.name, company.title, company.client).toLowerCase(), company.id,
  ]).filter(([name]) => name));
  const client = await pool.connect();
  const linkFields = (record) => normalizeRelatedRefs(record).map((ref) => ({
    entityType: ref.entity, recordId: ref.id, relation: 'regarding',
  }));
  try {
    await client.query('BEGIN');
    for (const record of records) {
      const entity = record.entityType;
      if (['deals', 'jobs', 'cases', 'tickets', 'invoices'].includes(entity)) {
        const workflowKey = entity === 'deals' ? 'sales' : entity === 'invoices' ? 'money' : entity === 'tickets' ? 'cases' : entity;
        const stage = firstText(record.stage, record.state, record.status, entity === 'invoices' ? 'draft' : 'new').toLowerCase();
        await client.query(
          `INSERT INTO crm_workflow_entries (id, workflow_key, entity_type, record_id, stage, rank, owner, doc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [`legacy_flow_${safeId(entity)}_${safeId(record.id)}`, workflowKey, entity, record.id, stage, Number(record.rank) || 0, record.assignee || record.owner || null, { source: 'legacy-projection' }],
        );
      }
      if (entity === 'tasks' || entity === 'calendarItems') {
        const commitmentId = `legacy_commitment_${safeId(entity)}_${safeId(record.id)}`;
        const dueAt = firstText(record.dueAt, record.dueDate, record.at, record.date, record.startDate, record.scheduledDate) || null;
        const status = CLOSED_STATES.has(firstText(record.state, record.status).toLowerCase()) ? 'completed' : 'open';
        await client.query(
          `INSERT INTO crm_commitments (id, title, kind, status, due_at, assignee, priority, completed_at, outcome, doc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [commitmentId, firstText(record.title, record.name, record.description, entity === 'tasks' ? 'Task' : 'Scheduled commitment'),
            entity === 'tasks' ? 'task' : firstText(record.kind, record.type, 'meeting'), status, dueAt,
            record.assignee || record.owner || null, record.priority || 'normal', record.completedAt || null,
            record.outcome || null, { source: 'legacy-projection', sourceEntity: entity, sourceId: record.id }],
        );
        await replaceDomainLinks(client, DOMAIN_SPECS.commitments ? domainSpec('commitments') : null, commitmentId, linkFields(record));
      }
      if (entity === 'interactions') {
        const activityId = `legacy_activity_${safeId(record.id)}`;
        await client.query(
          `INSERT INTO crm_activities (id, kind, occurred_at, actor, content, doc)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [activityId, firstText(record.kind, record.type, 'note'), firstText(record.at, record.createdAt) || new Date().toISOString(),
            record.actor || record.by || null, firstText(record.note, record.content, record.description, record.title),
            { source: 'legacy-projection', sourceId: record.id }],
        );
        await replaceDomainLinks(client, domainSpec('activities'), activityId, linkFields(record));
      }
      if (entity !== 'companies') {
        const inferredName = firstText(record.company, record.companyName, record.companyLabel,
          ['deals', 'jobs', 'cases', 'tickets', 'invoices'].includes(entity) ? record.client : '').toLowerCase();
        const companyId = record.companyId || companyByName.get(inferredName) || '';
        if (!companyId) continue;
        const relationshipId = `legacy_rel_${safeId(entity)}_${safeId(record.id)}_${safeId(companyId)}`;
        await client.query(
          `INSERT INTO crm_relationships (id, from_entity, from_id, to_entity, to_id, kind, doc)
           VALUES ($1, $2, $3, 'companies', $4, 'belongs-to', $5) ON CONFLICT DO NOTHING`,
          [relationshipId, entity, record.id, safeId(companyId), { source: 'legacy-projection' }],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function syncWorkflowRecord(entity, record) {
  if (!record || !['deals', 'jobs', 'cases', 'tickets', 'invoices'].includes(entity)) return null;
  const workflowKey = entity === 'deals' ? 'sales' : entity === 'invoices' ? 'money' : entity === 'tickets' ? 'cases' : entity;
  const id = `flow_${safeId(workflowKey)}_${safeId(entity)}_${safeId(record.id)}`;
  const stage = firstText(record.stage, record.state, record.status, entity === 'invoices' ? 'draft' : 'new').toLowerCase();
  const existing = await pool.query(
    'SELECT * FROM crm_workflow_entries WHERE workflow_key = $1 AND entity_type = $2 AND record_id = $3 AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
    [workflowKey, entity, record.id],
  );
  let result;
  if (existing.rows[0]) {
    result = await pool.query(
      `UPDATE crm_workflow_entries SET stage = $2, rank = $3, owner = $4, updated_at = now(), version = version + 1
       WHERE id = $1 RETURNING *`,
      [existing.rows[0].id, stage, Number(record.rank) || existing.rows[0].rank || 0, record.assignee || record.owner || null],
    );
  } else {
    result = await pool.query(
      `INSERT INTO crm_workflow_entries (id, workflow_key, entity_type, record_id, stage, rank, owner, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, workflowKey, entity, record.id, stage, Number(record.rank) || 0, record.assignee || record.owner || null, { source: 'record-sync' }],
    );
  }
  const flow = domainRow(domainSpec('workflow-entries'), result.rows[0]);
  broadcast({ type: 'domain-changed', resource: 'workflow-entries', record: flow });
  return flow;
}

async function syncOperationalRecord(entity, record) {
  await syncWorkflowRecord(entity, record);
  if (!record) return;
  if (entity === 'tasks' || entity === 'calendarItems') {
    const spec = domainSpec('commitments');
    const id = `legacy_commitment_${safeId(entity)}_${safeId(record.id)}`;
    const dueAt = firstText(record.dueAt, record.dueDate, record.at, record.date, record.startDate, record.scheduledDate) || null;
    const status = CLOSED_STATES.has(firstText(record.state, record.status).toLowerCase()) ? 'completed' : 'open';
    const existing = await pool.query('SELECT * FROM crm_commitments WHERE id = $1', [id]);
    let result;
    if (existing.rows[0]) {
      result = await pool.query(
        `UPDATE crm_commitments SET title = $2, kind = $3, status = $4, due_at = $5, assignee = $6, priority = $7,
         completed_at = $8, outcome = $9, deleted_at = $10, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`,
        [id, firstText(record.title, record.name, record.description, entity === 'tasks' ? 'Task' : 'Scheduled commitment'),
          entity === 'tasks' ? 'task' : firstText(record.kind, record.type, 'meeting'), status, dueAt,
          record.assignee || record.owner || null, record.priority || 'normal', record.completedAt || null,
          record.outcome || null, record.deletedAt || null],
      );
    } else {
      result = await pool.query(
        `INSERT INTO crm_commitments (id, title, kind, status, due_at, assignee, priority, completed_at, outcome, deleted_at, doc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, firstText(record.title, record.name, record.description, entity === 'tasks' ? 'Task' : 'Scheduled commitment'),
          entity === 'tasks' ? 'task' : firstText(record.kind, record.type, 'meeting'), status, dueAt,
          record.assignee || record.owner || null, record.priority || 'normal', record.completedAt || null,
          record.outcome || null, record.deletedAt || null, { source: 'legacy-projection', sourceEntity: entity, sourceId: record.id }],
      );
    }
    const links = normalizeRelatedRefs(record).map((ref) => ({ entityType: ref.entity, recordId: ref.id, relation: 'regarding' }));
    const client = await pool.connect();
    try { await replaceDomainLinks(client, spec, id, links); } finally { client.release(); }
    const linkMap = await domainLinks(pool, spec, [id]);
    const commitment = domainRow(spec, result.rows[0], linkMap.get(id) || []);
    broadcast({ type: 'domain-changed', resource: 'commitments', record: commitment });
  }
  if (entity === 'interactions') {
    const spec = domainSpec('activities');
    const id = `legacy_activity_${safeId(record.id)}`;
    const values = [id, firstText(record.kind, record.type, 'note'), firstText(record.at, record.createdAt) || new Date().toISOString(),
      record.actor || record.by || null, firstText(record.note, record.content, record.description, record.title), record.deletedAt || null];
    const existing = await pool.query('SELECT * FROM crm_activities WHERE id = $1', [id]);
    const result = existing.rows[0]
      ? await pool.query(`UPDATE crm_activities SET kind=$2,occurred_at=$3,actor=$4,content=$5,deleted_at=$6,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`, values)
      : await pool.query(`INSERT INTO crm_activities (id,kind,occurred_at,actor,content,deleted_at,doc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [...values, { source: 'legacy-projection', sourceId: record.id }]);
    const links = normalizeRelatedRefs(record).map((ref) => ({ entityType: ref.entity, recordId: ref.id, relation: 'regarding' }));
    const client = await pool.connect();
    try { await replaceDomainLinks(client, spec, id, links); } finally { client.release(); }
    const linkMap = await domainLinks(pool, spec, [id]);
    const activity = domainRow(spec, result.rows[0], linkMap.get(id) || []);
    broadcast({ type: 'domain-changed', resource: 'activities', record: activity });
  }
  if (entity !== 'companies') {
    let companyId = record.companyId || '';
    if (!companyId) {
      const companyName = firstText(record.company, record.companyName, record.companyLabel,
        ['deals', 'jobs', 'cases', 'tickets', 'invoices'].includes(entity) ? record.client : '');
      if (companyName) {
        const companyRows = await pool.query("SELECT * FROM crm_records WHERE entity_type = 'companies' AND deleted_at IS NULL");
        const match = companyRows.rows.map(rowToRecord).find((company) => firstText(company.name, company.title, company.client).toLowerCase() === companyName.toLowerCase());
        companyId = match?.id || '';
      }
    }
    if (!companyId) return;
    const id = `legacy_rel_${safeId(entity)}_${safeId(record.id)}_${safeId(companyId)}`;
    const result = await pool.query(
      `INSERT INTO crm_relationships (id,from_entity,from_id,to_entity,to_id,kind,doc)
       VALUES ($1,$2,$3,'companies',$4,'belongs-to',$5) ON CONFLICT (id) DO UPDATE SET deleted_at=NULL,updated_at=now(),version=crm_relationships.version+1 RETURNING *`,
      [id, entity, record.id, safeId(companyId), { source: 'legacy-projection' }],
    );
    broadcast({ type: 'domain-changed', resource: 'relationships', record: domainRow(domainSpec('relationships'), result.rows[0]) });
  }
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
  await syncOperationalRecord(entity, record);
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
    await syncOperationalRecord(entity, record);
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
  if (parts[0] === 'api' && parts[1] === 'domain') {
    const spec = domainSpec(parts[2]);
    if (!spec) return fail(res, 404, 'Unknown domain resource');
    const domainRecordId = parts[3] ? safeId(decodeURIComponent(parts[3])) : null;
    if (req.method === 'GET' && !domainRecordId) return listDomain(res, spec, url);
    if (req.method === 'GET' && domainRecordId) return getDomain(res, spec, domainRecordId);
    if (req.method === 'POST' && !domainRecordId) return createDomain(res, spec, await readBody(req));
    if (req.method === 'PATCH' && domainRecordId) return patchDomain(res, spec, domainRecordId, await readBody(req));
    if (req.method === 'DELETE' && domainRecordId) return deleteDomain(res, spec, domainRecordId, url);
    return fail(res, 405, 'Method not allowed');
  }
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
  await migrateLegacyDomain();
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
