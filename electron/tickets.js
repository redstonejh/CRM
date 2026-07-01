// ─── Tickets backend (local store) ─────────────────────────────────────────────
//
// The MQTT broker layer has been GUTTED. Tickets now live entirely in a local
// store persisted to `userData/tickets.json` — this app is a self-contained
// ticket manager (create / claim / assign / resolve / reopen / comment / edit /
// delete), no broker, no network. The exported surface is unchanged so main.js
// and the renderer keep working; connectTickets/endTickets are now no-ops kept
// only for signature compatibility, and the connection state is always 'live'.
//
// Schema (unchanged — still mirrors the old retained doc):
//   { id, episodeKey, companyId, companyLabel, host,
//     severity, state, createdAt,
//     assignee, assignedBy, claimedBy,
//     recoveredAt, resolvedAt, resolvedBy,
//     updatedAt, version, history:[{at,by,action,detail}] }
//   state ∈ open | claimed | assigned | resolved   (severity is informational)
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

let onChange = () => {};                // called whenever the store changes
const cache = new Map();                // id -> ticket doc
let loaded = false;

// ─── Persistence ───────────────────────────────────────────────────────────────
// One JSON file under userData. Writes are synchronous (the store is tiny and
// mutations are user-paced), so a created/edited/deleted ticket survives a restart.

function storeFile() {
  return path.join(app.getPath('userData'), 'tickets.json');
}

function loadStore() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tickets) ? raw.tickets : []);
    cache.clear();
    for (const t of list) if (t && t.id) cache.set(safeId(t.id), t);
  } catch { /* no file yet → empty store */ }
}

function persist() {
  try { fs.writeFileSync(storeFile(), JSON.stringify([...cache.values()], null, 2)); }
  catch (err) { console.error('[TICKETS] persist failed:', err && err.message); }
}

function emitChange() {
  persist();
  try { onChange(); } catch { /* ignore */ }
}

// id doubles as a filename-safe key. Manual ids are pre-sanitised.
function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// ─── Lifecycle (no-op broker stubs) ─────────────────────────────────────────────

export function initTickets({ onChange: changeCb } = {}) {
  onChange = typeof changeCb === 'function' ? changeCb : onChange;
  loadStore();
  emitChange();
}

// Broker reconnect used to live here — now a no-op kept so settings:save's call
// doesn't throw. Just re-emits from the (already loaded) local store.
export function connectTickets() { loadStore(); emitChange(); }
export function endTickets() { /* nothing to tear down */ }

// The store is always "live" now (no connection to be grey/black about).
export function ticketConnectionState() { return 'live'; }

// Newest first; resolved tickets sink below open ones.
export function ticketList() {
  loadStore();
  const rank = (t) => (t.state === 'resolved' ? 1 : 0);
  return [...cache.values()].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function ticketGet(id) { loadStore(); return cache.get(safeId(id)) || null; }

// ─── Mutations ─────────────────────────────────────────────────────────────────
// Read-modify-write on the cached doc, then persist + notify. Returns
// { ok, ticket } or { ok:false, error }.

function mutate(id, actor, action, mutator) {
  loadStore();
  const key = safeId(id);
  const cur = cache.get(key);
  if (!cur) return { ok: false, error: 'No such ticket' };
  const nowIso = new Date().toISOString();
  const next = { ...cur, history: [...(cur.history || [])] };
  const detail = mutator(next, nowIso);   // mutator may return an error string to abort
  if (typeof detail === 'object' && detail && detail.error) return { ok: false, error: detail.error };
  next.history.push({ at: nowIso, by: actor || 'unknown', action, detail: typeof detail === 'string' ? detail : '' });
  next.updatedAt = Date.now();
  next.version = (cur.version || 0) + 1;
  cache.set(key, next);
  emitChange();
  return { ok: true, ticket: next };
}

// Take ownership ("I'll handle this").
export function claimTicket(id, actor) {
  return mutate(id, actor, 'claimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = actor;
    if (t.state === 'open') t.state = 'claimed';
    return `Claimed by ${actor}`;
  });
}

// Release a claim.
export function unclaimTicket(id, actor) {
  return mutate(id, actor, 'unclaimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = null;
    t.state = t.assignee ? 'assigned' : 'open';
    return `Released by ${actor}`;
  });
}

// Delegate to someone else.
export function assignTicket(id, assignee, actor) {
  const who = String(assignee || '').trim();
  if (!who) return { ok: false, error: 'An assignee is required' };
  return mutate(id, actor, 'assigned', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.assignee = who;
    t.assignedBy = actor;
    t.state = 'assigned';
    return `Assigned to ${who} by ${actor}`;
  });
}

// A human closes the ticket.
export function resolveTicket(id, actor) {
  return mutate(id, actor, 'resolved', (t, nowIso) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.resolvedBy = actor;
    t.resolvedAt = nowIso;
    t.state = 'resolved';
    return `Resolved by ${actor}`;
  });
}

// Reopen a resolved ticket back into its working state.
export function reopenTicket(id, actor) {
  return mutate(id, actor, 'reopened', (t) => {
    if (t.state !== 'resolved') return { error: 'Ticket is not resolved' };
    t.resolvedBy = null;
    t.resolvedAt = null;
    t.state = t.assignee ? 'assigned' : (t.claimedBy ? 'claimed' : 'open');
    return `Reopened by ${actor}`;
  });
}

// Append a note without changing state.
export function commentTicket(id, text, actor) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Comment text is required' };
  return mutate(id, actor, 'comment', () => body);
}

// Set the human-editable fields on the ticket.
const EDITABLE_TICKET_FIELDS = ['title', 'description', 'priority', 'assignee'];
export function updateTicket(id, fields = {}, actor) {
  return mutate(id, actor, 'edited', (t) => {
    const changed = [];
    for (const k of EDITABLE_TICKET_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
      const v = fields[k] == null || fields[k] === '' ? null : String(fields[k]);
      if ((t[k] ?? null) !== v) { t[k] = v; changed.push(k); }
    }
    if (!changed.length) return { error: 'No changes' };
    // Naming an assignee on a still-open ticket advances it to "assigned".
    if (changed.includes('assignee') && t.assignee && t.state === 'open') t.state = 'assigned';
    return `Edited ${changed.join(', ')}`;
  });
}

// Hard-delete a ticket from the local store.
export function deleteTicket(id) {
  loadStore();
  const key = safeId(id);
  if (!cache.delete(key)) return { ok: false, error: 'No such ticket' };
  emitChange();
  return { ok: true };
}

// Manually raise a ticket.
export function createTicket({ companyLabel, host, severity } = {}, actor) {
  loadStore();
  const nowIso = new Date().toISOString();
  // Unique, key-safe id. (Date.now() is fine in the main process.)
  const id = safeId(`manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
  const doc = {
    id, episodeKey: null,
    companyId: null, companyLabel: String(companyLabel || '(manual)'), host: String(host || ''),
    severity: severity || 'red', state: 'open', createdAt: nowIso,
    assignee: null, assignedBy: null, claimedBy: null,
    recoveredAt: null, resolvedAt: null, resolvedBy: null,
    updatedAt: Date.now(), version: 1,
    history: [{ at: nowIso, by: actor || 'unknown', action: 'created', detail: 'Created manually' }],
  };
  cache.set(id, doc);
  emitChange();
  return { ok: true, ticket: doc };
}
