// shim.js — browser reproduction of electron/dashboard-preload.js over HTTP/WS.
//
// The visual harness serves the dashboard as a plain web page. This module
// recreates every window bridge the Electron preload exposes, backed by the
// same REST + WebSocket API the Electron main process uses (server/index.js).
// Semantics are ported from electron/store.js, electron/tickets.js and the
// IPC handlers in electron/main.js so the renderer cannot tell the difference.
//
// Loaded as a module script injected by harness.js BEFORE app.js, so every
// bridge exists by the time the shell boots.
(() => {
  const API_URL = (window.__CRM_API_URL__ || 'http://127.0.0.1:3899').replace(/\/+$/, '');
  const ACTOR = window.__CRM_ACTOR__ || 'rosa';
  const ENTITIES = ['tickets', 'deals', 'jobs', 'cases', 'contacts', 'companies', 'tasks', 'calendarItems', 'reports', 'invoices', 'interactions'];
  const IMMUTABLE_FIELDS = new Set(['id', 'entityType', 'createdAt', 'history', 'version']);

  // ─── Channel bus (replaces ipcRenderer events) ─────────────────────────────
  const listeners = new Map();
  function on(channel, cb) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
  }
  function emit(channel, payload) {
    (listeners.get(channel) || []).forEach((cb) => { try { cb(payload); } catch {} });
  }

  // ─── Store (port of electron/store.js) ─────────────────────────────────────
  let connectionState = 'offline';
  let ws = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let broadcastTimer = null;
  const entityStores = new Map();
  const loadedEntities = new Set();
  const pendingRefresh = new Set();

  function safeEntity(entity) {
    const key = String(entity || '').trim();
    if (!ENTITIES.includes(key)) throw new Error(`Invalid entity: ${entity}`);
    return key;
  }
  function safeId(id) {
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
  function changedValue(a, b) {
    if (Object.is(a, b)) return false;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
    }
    return true;
  }
  function setConnection(state) {
    if (connectionState === state) return;
    connectionState = state;
    emit('tickets:connection', connectionState);
    scheduleBroadcast();
  }

  async function request(path, { method = 'GET', body } = {}) {
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
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
    scheduleBroadcast();
  }
  function scheduleRefreshAll() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { ENTITIES.forEach((entity) => { refreshEntity(entity); }); }, 50);
  }

  function listRecords(entity, { includeDeleted = true } = {}) {
    const key = safeEntity(entity);
    if (!loadedEntities.has(key)) refreshEntity(key);
    const list = [...entityMap(key).values()];
    return includeDeleted ? list : list.filter((doc) => !doc.deletedAt);
  }
  function getRecord(entity, id) {
    const key = safeEntity(entity);
    const record = entityMap(key).get(safeId(id)) || null;
    if (!record) refreshEntity(key);
    return record;
  }

  async function createRecord(entity, fields = {}, actor = ACTOR, options = {}) {
    const key = safeEntity(entity);
    const res = await request(`/api/entities/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: { fields, actor, options },
    });
    if (res.ok && res.record) {
      res.record = applyRecord(key, res.record);
      scheduleBroadcast();
    }
    return res;
  }
  async function updateRecord(entity, id, fields = {}, actor = ACTOR, options = {}) {
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
      scheduleBroadcast();
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
  async function mutateRecord(entity, id, actor, action, mutator, options = {}) {
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
  async function deleteRecord(entity, id, actor = ACTOR, options = {}) {
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
      scheduleBroadcast();
    } else if (res.status === 409) {
      refreshEntity(key);
    }
    return res;
  }

  // ─── WebSocket change feed ─────────────────────────────────────────────────
  function connectSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/changes`);
    } catch {
      reconnectTimer = setTimeout(connectSocket, 2500);
      return;
    }
    ws.onopen = () => { setConnection('live'); scheduleRefreshAll(); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'domain-changed') {
          scheduleBroadcast();
          return;
        }
        if (!msg.entity) return;
        const entity = safeEntity(msg.entity);
        if (msg.type === 'deleted' && msg.id) removeRecord(entity, msg.id);
        else if (msg.record) applyRecord(entity, msg.record);
        scheduleBroadcast();
      } catch { /* ignore malformed packets */ }
    };
    ws.onclose = () => { setConnection('offline'); reconnectTimer = setTimeout(connectSocket, 2500); };
    ws.onerror = () => { setConnection('offline'); };
  }

  // ─── Renderer broadcasts (port of main.js broadcastTickets/broadcastStore) ─
  function ticketList() {
    const rank = (t) => (t.state === 'resolved' ? 1 : 0);
    return listRecords('tickets').sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }
  function ticketsPayload() {
    return { tickets: ticketList(), connection: connectionState };
  }
  function storePayload(entity, options = {}) {
    return { entity, records: listRecords(entity, options), connection: connectionState };
  }
  function scheduleBroadcast() {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      emit('tickets:changed', ticketsPayload());
      ENTITIES.forEach((entity) => {
        const payload = storePayload(entity);
        emit('store:changed', payload);
        emit(`store:${entity}:changed`, payload);
      });
    }, 30);
  }

  // ─── window.dashboard (stubbed monitoring bridge, as in the preload) ───────
  const settings = { apiUrl: API_URL };
  window.dashboard = {
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
    getSettings: () => Promise.resolve({ ...settings }),
    saveSettings: (s) => { Object.assign(settings, s || {}); return Promise.resolve({ ok: true, settings: { ...settings } }); },
    openExternal: () => Promise.resolve({ ok: true }),
    closeDashboard: () => Promise.resolve({ ok: true }),
    minimize: () => Promise.resolve({ ok: true }),
  };

  // ─── window.auth (always signed in as the harness actor) ───────────────────
  const sessionUser = {
    username: ACTOR,
    isAdmin: true,
    permissions: { canManageUsers: true, canClaim: true, canResolve: true },
    visibleCompanies: null,
    mustChangePassword: false,
  };
  window.auth = {
    session: () => Promise.resolve({ user: { ...sessionUser } }),
    login: () => Promise.resolve({ ok: true, user: { ...sessionUser } }),
    register: () => Promise.resolve({ ok: true, user: { ...sessionUser } }),
    setPassword: () => Promise.resolve({ ok: true }),
    logout: () => Promise.resolve({ ok: true }),
    listUsers: () => Promise.resolve({ ok: true, users: [{ ...sessionUser }] }),
    createUser: () => Promise.resolve({ ok: false, error: 'Not available in the harness' }),
    updateUser: () => Promise.resolve({ ok: false, error: 'Not available in the harness' }),
    deleteUser: () => Promise.resolve({ ok: false, error: 'Not available in the harness' }),
    onChanged: (cb) => on('auth:changed', cb),
  };

  // ─── window.tickets (port of the IPC handlers + electron/tickets.js) ───────
  const ticketResult = (result) => (!result || !result.ok ? result : { ok: true, ticket: result.record });
  window.tickets = {
    list: () => Promise.resolve(ticketsPayload()),
    connectionState: () => Promise.resolve(connectionState),
    onChanged: (cb) => on('tickets:changed', cb),
    onConnection: (cb) => on('tickets:connection', cb),
    claim: async (id) => ticketResult(await mutateRecord('tickets', id, ACTOR, 'claimed', (t) => {
      if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
      t.claimedBy = ACTOR;
      if (t.state === 'open') t.state = 'claimed';
      return `Claimed by ${ACTOR}`;
    })),
    unclaim: async (id) => ticketResult(await mutateRecord('tickets', id, ACTOR, 'unclaimed', (t) => {
      if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
      t.claimedBy = null;
      t.state = t.assignee ? 'assigned' : 'open';
      return `Released by ${ACTOR}`;
    })),
    assign: async (id, assignee) => {
      const who = String(assignee || '').trim();
      if (!who) return { ok: false, error: 'An assignee is required' };
      return ticketResult(await mutateRecord('tickets', id, ACTOR, 'assigned', (t) => {
        if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
        t.assignee = who;
        t.assignedBy = ACTOR;
        t.state = 'assigned';
        return `Assigned to ${who} by ${ACTOR}`;
      }));
    },
    resolve: async (id) => ticketResult(await mutateRecord('tickets', id, ACTOR, 'resolved', (t, nowIso) => {
      if (t.state === 'resolved') return { error: 'Ticket is already resolved' };
      t.resolvedBy = ACTOR;
      t.resolvedAt = nowIso;
      t.state = 'resolved';
      return `Resolved by ${ACTOR}`;
    })),
    reopen: async (id) => ticketResult(await mutateRecord('tickets', id, ACTOR, 'reopened', (t) => {
      if (t.state !== 'resolved') return { error: 'Ticket is not resolved' };
      t.resolvedBy = null;
      t.resolvedAt = null;
      t.state = t.assignee ? 'assigned' : (t.claimedBy ? 'claimed' : 'open');
      return `Reopened by ${ACTOR}`;
    })),
    comment: async (id, text) => {
      const body = String(text || '').trim();
      if (!body) return { ok: false, error: 'Comment text is required' };
      return ticketResult(await mutateRecord('tickets', id, ACTOR, 'comment', () => body));
    },
    update: async (id, fields) => ticketResult(await updateRecord('tickets', id, fields || {}, ACTOR, { history: false })),
    create: async ({ companyLabel, host, severity, ...rest } = {}) => ticketResult(await createRecord('tickets', {
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
    }, ACTOR, { idPrefix: 'manual', action: 'created', detail: 'Created manually' })),
    remove: (id) => deleteRecord('tickets', id, 'system', { hard: true }),
  };

  // ─── window.crmStore + per-entity bridges ──────────────────────────────────
  function entityBridge(entity) {
    return {
      list: async (options = {}) => ({ ok: true, ...storeListPayload(entity, options) }),
      get: async (id) => ({ ok: true, entity, record: getRecord(entity, id) }),
      create: (fields) => createRecord(entity, fields || {}, ACTOR),
      update: (id, fields) => updateRecord(entity, id, fields || {}, ACTOR),
      remove: (id, options = {}) => deleteRecord(entity, id, ACTOR, { hard: !!options.hard }),
      onChanged: (cb) => on(`store:${entity}:changed`, cb),
    };
  }
  function storeListPayload(entity, options = {}) {
    return storePayload(entity, { includeDeleted: options.includeDeleted !== false });
  }
  window.crmStore = {
    list: async (entity, options = {}) => ({ ok: true, ...storeListPayload(safeEntity(entity), options) }),
    get: async (entity, id) => ({ ok: true, entity: safeEntity(entity), record: getRecord(entity, id) }),
    create: (entity, fields) => createRecord(safeEntity(entity), fields || {}, ACTOR),
    update: (entity, id, fields) => updateRecord(safeEntity(entity), id, fields || {}, ACTOR),
    remove: (entity, id, options = {}) => deleteRecord(safeEntity(entity), id, ACTOR, { hard: !!options.hard }),
    onChanged: (cb) => on('store:changed', cb),
  };
  function domainPath(resource, id = '', query = {}) {
    const valid = ['relationships', 'commitments', 'activities', 'workflow-entries'];
    if (!valid.includes(resource)) throw new Error(`Invalid domain resource: ${resource}`);
    const params = new URLSearchParams();
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    const suffix = params.toString() ? `?${params}` : '';
    return `/api/domain/${encodeURIComponent(resource)}${id ? `/${encodeURIComponent(safeId(id))}` : ''}${suffix}`;
  }
  window.crmDomain = {
    list: (resource, query = {}) => request(domainPath(resource, '', query)),
    get: (resource, id) => request(domainPath(resource, id)),
    create: (resource, fields) => request(domainPath(resource), { method: 'POST', body: { fields } }),
    update: (resource, id, fields, expectedVersion) => request(domainPath(resource, id), {
      method: 'PATCH', body: { fields, expectedVersion },
    }),
    remove: (resource, id, options = {}) => request(domainPath(resource, id, options.hard ? { hard: true } : {}), { method: 'DELETE' }),
    onChanged: (cb) => on('store:changed', cb),
  };
  window.crmReportsApi = {
    summary: () => request('/api/reports/summary'),
  };
  window.crmBackend = {
    connection: () => Promise.resolve({
      ok: true,
      settings: { ...settings },
      connection: { apiUrl: API_URL, connection: connectionState, loadedEntities: [...loadedEntities], pendingEntities: [...pendingRefresh] },
    }),
    status: async () => {
      const health = await request('/api/health');
      return {
        ok: !!health.ok,
        settings: { ...settings },
        connection: { apiUrl: API_URL, connection: connectionState, loadedEntities: [...loadedEntities], pendingEntities: [...pendingRefresh] },
        health: { ok: !!health.ok, apiUrl: API_URL, connection: connectionState, status: health.ok ? 'live' : 'offline', error: health.error || null },
        error: health.error || null,
      };
    },
    getSettings: () => Promise.resolve({ ...settings }),
    saveSettings: (s) => { Object.assign(settings, s || {}); return Promise.resolve({ ok: true, settings: { ...settings } }); },
    onChanged: (cb) => on('store:changed', cb),
  };
  ['deals', 'contacts', 'companies', 'tasks', 'invoices', 'interactions'].forEach((entity) => {
    window[entity] = entityBridge(entity);
  });

  // ─── Misc shell bridges ────────────────────────────────────────────────────
  window.electron = {
    platform: 'win32',
    getSettings: () => Promise.resolve({ ...settings }),
    saveSettings: (s) => { Object.assign(settings, s || {}); return Promise.resolve({ ok: true }); },
    openExternal: () => Promise.resolve({ ok: true }),
    openDashboard: () => Promise.resolve({ ok: true }),
  };

  // Per-user layout store — localStorage-backed, namespaced like the preload's
  // file store so a fresh browser profile equals a fresh CRM profile.
  const STORE_PREFIX = `crm-layout-store--${ACTOR}::`;
  window.dashboardPersistence = {
    getItem(key) {
      const value = localStorage.getItem(STORE_PREFIX + key);
      return value === null ? null : String(value);
    },
    setItem(key, value) { localStorage.setItem(STORE_PREFIX + key, String(value)); },
    removeItem(key) { localStorage.removeItem(STORE_PREFIX + key); },
    keys() {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORE_PREFIX)) keys.push(key.slice(STORE_PREFIX.length));
      }
      return keys;
    },
    clear() { this.keys().forEach((key) => localStorage.removeItem(STORE_PREFIX + key)); },
  };
  window.dashboardWindowControls = {
    reload: () => { location.reload(); return Promise.resolve({ ok: true }); },
    minimize: () => Promise.resolve({ ok: true }),
    close: () => Promise.resolve({ ok: true }),
  };

  // ─── Boot ──────────────────────────────────────────────────────────────────
  ENTITIES.forEach(entityMap);
  connectSocket();
  scheduleRefreshAll();
})();
