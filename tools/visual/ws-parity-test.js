// ws-parity-test.js — the backend contract the renderer's store depends on.
//
// Runs the REAL server (pg-mem-backed, unseeded) and asserts the WebSocket +
// REST behaviors the shim/electron store rely on: hello + fresh-list on
// connect (replay), change broadcasts on create/update, soft-delete tombstones
// (kept + broadcast + filterable), hard-delete 'deleted' packets, and
// optimistic version conflicts with re-fetch → retry. 12 assertions.
'use strict';
const { installPgMem } = require('./pg-mem-adapter.js');

const API_PORT = 3894;
const API = `http://127.0.0.1:${API_PORT}`;

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(` ok  ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const { WebSocket } = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/api/changes`);
    const messages = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      messages.push(msg);
      waiters.splice(0).forEach((w) => w());
    });
    ws.on('open', () => resolve({
      ws,
      messages,
      // Wait until a message matching `pred` has arrived (or time out).
      waitFor(pred, timeoutMs = 3000) {
        return new Promise((res2) => {
          const check = () => { const hit = messages.find(pred); if (hit) { res2(hit); return true; } return false; };
          if (check()) return;
          const timer = setTimeout(() => res2(null), timeoutMs);
          const tick = () => { if (check()) clearTimeout(timer); else waiters.push(tick); };
          waiters.push(tick);
        });
      },
    }));
    ws.on('error', reject);
  });
}

async function main() {
  installPgMem();
  process.env.PORT = String(API_PORT);
  require('../../server/index.js');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { if ((await (await fetch(`${API}/api/health`)).json()).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }

  // 1 — health
  const health = await api('GET', '/api/health');
  assert('health endpoint live', health.json.ok === true);

  // 2 — connect replays state: hello packet + a fresh list returns records
  const pre = await api('POST', '/api/entities/deals', { fields: { id: 'ws_pre', title: 'Pre-existing deal', stage: 'lead' }, actor: 'test' });
  assert('create returns the record', pre.status === 201 && pre.json.record.id === 'ws_pre');
  const client = await connectWs();
  const hello = await client.waitFor((m) => m.type === 'hello');
  assert('hello announces the entity set on connect', !!hello && Array.isArray(hello.entities) && hello.entities.includes('deals'));
  const replay = await api('GET', '/api/entities/deals?includeDeleted=true');
  assert('replay-on-connect: fresh list holds pre-connect records', replay.json.records.some((r) => r.id === 'ws_pre'));

  // 3 — create broadcasts a changed packet
  await api('POST', '/api/entities/deals', { fields: { id: 'ws_live', title: 'Live deal', stage: 'lead' }, actor: 'test' });
  const createdMsg = await client.waitFor((m) => m.type === 'changed' && m.entity === 'deals' && m.record?.id === 'ws_live');
  assert('create broadcasts changed over WS', !!createdMsg && createdMsg.record.version === 1);

  // 4 — update broadcasts, version increments
  const patch = await api('PATCH', '/api/entities/deals/ws_live', { fields: { stage: 'proposal' }, actor: 'test', expectedVersion: 1 });
  assert('patch with matching version succeeds', patch.json.ok === true && patch.json.record.version === 2);
  const patchMsg = await client.waitFor((m) => m.type === 'changed' && m.record?.id === 'ws_live' && m.record.version === 2);
  assert('update broadcasts the new version', !!patchMsg && patchMsg.record.stage === 'proposal');

  // 5 — version conflict → 409, re-fetch shows current, retry succeeds
  const conflict = await api('PATCH', '/api/entities/deals/ws_live', { fields: { stage: 'won' }, actor: 'test', expectedVersion: 1 });
  assert('stale expectedVersion is rejected with 409', conflict.status === 409 && conflict.json.ok === false);
  const refetch = await api('GET', '/api/entities/deals/ws_live');
  assert('re-fetch after conflict returns the live version', refetch.json.record.version === 2);
  const retry = await api('PATCH', '/api/entities/deals/ws_live', { fields: { stage: 'won' }, actor: 'test', expectedVersion: refetch.json.record.version });
  assert('retry with the re-fetched version succeeds', retry.json.ok === true && retry.json.record.stage === 'won');

  // 6 — soft delete: tombstone kept, broadcast, filterable
  await api('DELETE', '/api/entities/deals/ws_live?version=' + retry.json.record.version, { actor: 'test' });
  const tombstoneMsg = await client.waitFor((m) => m.type === 'changed' && m.record?.id === 'ws_live' && m.record.deletedAt);
  const withDeleted = await api('GET', '/api/entities/deals?includeDeleted=true');
  const withoutDeleted = await api('GET', '/api/entities/deals?includeDeleted=false');
  assert('soft delete broadcasts a tombstoned record', !!tombstoneMsg);
  assert('tombstone kept when includeDeleted, filtered when not',
    withDeleted.json.records.some((r) => r.id === 'ws_live' && r.deletedAt)
    && !withoutDeleted.json.records.some((r) => r.id === 'ws_live'));

  // 7 — hard delete: a deleted packet, record gone entirely
  await api('DELETE', '/api/entities/deals/ws_pre?hard=1', { actor: 'test' });
  const deletedMsg = await client.waitFor((m) => m.type === 'deleted' && m.entity === 'deals' && m.id === 'ws_pre');
  const finalList = await api('GET', '/api/entities/deals?includeDeleted=true');
  assert('hard delete broadcasts a deleted packet and removes the record',
    !!deletedMsg && !finalList.json.records.some((r) => r.id === 'ws_pre'));

  client.ws.close();
  console.log(`\nWS parity: ${passed}/${passed + failed} assertions passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
