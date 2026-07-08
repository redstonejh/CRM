// Tickets compatibility adapter over the generic CRM entity store.
//
// The renderer still consumes window.tickets. Internally, tickets are now typed
// CRM records stored through the Postgres API in server/.
import {
  initCrmStore,
  configureStore,
  emitStoreChange,
  storeConnectionState,
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  mutateRecord,
  deleteRecord,
} from './store.js';

const ENTITY = 'tickets';

export function initTickets({ onChange: changeCb, url } = {}) {
  initCrmStore({ onChange: changeCb, url });
  emitStoreChange();
}

export function connectTickets({ url } = {}) {
  if (url) configureStore({ url });
  else emitStoreChange();
}
export function endTickets() { /* API/WebSocket lifecycle is owned by store.js */ }
export function ticketConnectionState() { return storeConnectionState(); }

export function ticketList() {
  const rank = (t) => (t.state === 'resolved' ? 1 : 0);
  return listRecords(ENTITY).sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function ticketGet(id) {
  return getRecord(ENTITY, id);
}

export async function claimTicket(id, actor) {
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'claimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = actor;
    if (t.state === 'open') t.state = 'claimed';
    return `Claimed by ${actor}`;
  }));
}

function ticketResult(result) {
  if (!result || !result.ok) return result;
  return { ok: true, ticket: result.record };
}

export async function unclaimTicket(id, actor) {
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'unclaimed', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.claimedBy = null;
    t.state = t.assignee ? 'assigned' : 'open';
    return `Released by ${actor}`;
  }));
}

export async function assignTicket(id, assignee, actor) {
  const who = String(assignee || '').trim();
  if (!who) return { ok: false, error: 'An assignee is required' };
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'assigned', (t) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.assignee = who;
    t.assignedBy = actor;
    t.state = 'assigned';
    return `Assigned to ${who} by ${actor}`;
  }));
}

export async function resolveTicket(id, actor) {
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'resolved', (t, nowIso) => {
    if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
    t.resolvedBy = actor;
    t.resolvedAt = nowIso;
    t.state = 'resolved';
    return `Resolved by ${actor}`;
  }));
}

export async function reopenTicket(id, actor) {
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'reopened', (t) => {
    if (t.state !== 'resolved') return { error: 'Ticket is not resolved' };
    t.resolvedBy = null;
    t.resolvedAt = null;
    t.state = t.assignee ? 'assigned' : (t.claimedBy ? 'claimed' : 'open');
    return `Reopened by ${actor}`;
  }));
}

export async function commentTicket(id, text, actor) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Comment text is required' };
  return ticketResult(await mutateRecord(ENTITY, id, actor, 'comment', () => body));
}

export async function updateTicket(id, fields = {}, actor) {
  // Silent because ticket-stacks keeps its own user-facing activity trail for
  // live field edits, stage movement, trash/restore, and cosmetic changes.
  return ticketResult(await updateRecord(ENTITY, id, fields || {}, actor, { history: false }));
}

export async function deleteTicket(id) {
  return deleteRecord(ENTITY, id, 'system', { hard: true });
}

export async function createTicket({ companyLabel, host, severity, ...rest } = {}, actor) {
  const nowIso = new Date().toISOString();
  const result = await createRecord(ENTITY, {
    episodeKey: null,
    companyId: null,
    companyLabel: String(companyLabel || '(manual)'),
    host: String(host || ''),
    severity: severity || 'red',
    state: 'open',
    assignee: null,
    assignedBy: null,
    claimedBy: null,
    recoveredAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...rest,
  }, actor, {
    idPrefix: 'manual',
    action: 'created',
    detail: 'Created manually',
  });
  if (result.ok && result.record && !result.record.createdAt) result.record.createdAt = nowIso;
  return ticketResult(result);
}
