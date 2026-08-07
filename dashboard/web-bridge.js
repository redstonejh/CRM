(() => {
  'use strict';

  // Electron's preload and the repository's visual harness install their own
  // bridges before deferred module scripts run. Leave those native/test
  // contracts untouched; this bridge is only for an ordinary web browser.
  if (window.crmStore && window.auth) return;

  const changeListeners = new Set();
  const authListeners = new Set();
  let socket = null;
  let socketTimer = null;
  let connectionState = 'offline';
  let currentUser = (() => {
    try {
      const username = localStorage.getItem('crm-web-current-user');
      return username ? { username } : null;
    } catch {
      return null;
    }
  })();

  const safeId = (value) => String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const query = (values = {}) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
  };
  const request = async (path, options = {}) => {
    try {
      const response = await fetch(path, {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload = await response.json().catch(() => ({}));
      connectionState = response.ok ? 'live' : (response.status === 401 ? 'unauthenticated' : 'offline');
      return response.ok && payload.ok !== false
        ? payload
        : { ok: false, error: payload.error || `HTTP ${response.status}`, status: response.status };
    } catch (error) {
      connectionState = 'offline';
      return { ok: false, error: error.message || 'Request failed' };
    }
  };

  const emitChange = (payload = {}) => {
    for (const listener of changeListeners) {
      try { listener(payload); } catch {}
    }
  };
  const connectChanges = () => {
    clearTimeout(socketTimer);
    if (!currentUser || (socket && socket.readyState < WebSocket.CLOSING)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/changes`);
    socket.addEventListener('open', () => { connectionState = 'live'; });
    socket.addEventListener('message', (event) => {
      try { emitChange(JSON.parse(event.data)); } catch {}
    });
    socket.addEventListener('close', () => {
      connectionState = 'offline';
      socket = null;
      if (currentUser) socketTimer = setTimeout(connectChanges, 2500);
    });
    socket.addEventListener('error', () => { connectionState = 'offline'; });
  };
  const onChanged = (callback) => {
    if (typeof callback !== 'function') return () => {};
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  };
  const authRequest = (action, body) => request(`/web/auth/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    body,
  });
  const applySession = (session) => {
    currentUser = session?.user || null;
    try {
      if (currentUser?.username) localStorage.setItem('crm-web-current-user', currentUser.username);
      else localStorage.removeItem('crm-web-current-user');
    } catch {}
    if (currentUser) connectChanges();
    return session;
  };

  const entityBridge = (entity) => ({
    list: (options = {}) => request(`/api/entities/${encodeURIComponent(entity)}${query(options)}`),
    get: (id) => request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(safeId(id))}`),
    create: (fields) => request(`/api/entities/${encodeURIComponent(entity)}`, {
      method: 'POST', body: { fields, actor: currentUser?.username || 'web' },
    }),
    update: (id, fields) => request(`/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', body: { fields, actor: currentUser?.username || 'web' },
    }),
    remove: (id, options = {}) => request(
      `/api/entities/${encodeURIComponent(entity)}/${encodeURIComponent(safeId(id))}${options.hard ? '?hard=1' : ''}`,
      { method: 'DELETE', body: { actor: currentUser?.username || 'web' } },
    ),
    onChanged,
  });

  const entities = ['deals', 'contacts', 'companies', 'tasks', 'bills', 'invoices', 'interactions', 'projects', 'workItems'];
  for (const entity of entities) window[entity] = entityBridge(entity);

  window.crmStore = {
    list: (entity, options = {}) => entityBridge(entity).list(options),
    get: (entity, id) => entityBridge(entity).get(id),
    create: (entity, fields) => entityBridge(entity).create(fields),
    update: (entity, id, fields) => entityBridge(entity).update(id, fields),
    remove: (entity, id, options = {}) => entityBridge(entity).remove(id, options),
    onChanged,
  };
  window.crmDomain = {
    list: (resource, values = {}) => request(`/api/domain/${encodeURIComponent(resource)}${query(values)}`),
    get: (resource, id) => request(`/api/domain/${encodeURIComponent(resource)}/${encodeURIComponent(safeId(id))}`),
    create: (resource, fields) => request(`/api/domain/${encodeURIComponent(resource)}`, {
      method: 'POST', body: { fields: { ...fields, actor: fields?.actor || currentUser?.username || 'web' } },
    }),
    update: (resource, id, fields, expectedVersion) => request(
      `/api/domain/${encodeURIComponent(resource)}/${encodeURIComponent(safeId(id))}`,
      { method: 'PATCH', body: { fields, expectedVersion } },
    ),
    batch: (resource, updates) => request(`/api/domain/${encodeURIComponent(resource)}`, {
      method: 'PATCH', body: { updates },
    }),
    remove: (resource, id, options = {}) => request(
      `/api/domain/${encodeURIComponent(resource)}/${encodeURIComponent(safeId(id))}${options.hard ? '?hard=true' : ''}`,
      { method: 'DELETE' },
    ),
    onChanged,
  };
  window.crmReportsApi = { summary: () => request('/api/reports/summary') };

  const tickets = entityBridge('tickets');
  const updateTicket = async (id, fields) => {
    const result = await tickets.update(id, fields);
    return result.ok ? { ok: true, ticket: result.record } : result;
  };
  window.tickets = {
    ...tickets,
    connectionState: () => Promise.resolve(connectionState),
    onConnection: onChanged,
    claim: (id) => updateTicket(id, { claimedBy: currentUser?.username || 'web', state: 'claimed' }),
    unclaim: (id) => updateTicket(id, { claimedBy: null, state: 'open' }),
    assign: (id, assignee) => updateTicket(id, { assignee, assignedBy: currentUser?.username || 'web', state: 'assigned' }),
    resolve: (id) => updateTicket(id, {
      state: 'resolved', resolvedBy: currentUser?.username || 'web', resolvedAt: new Date().toISOString(),
    }),
    reopen: (id) => updateTicket(id, { state: 'open', resolvedBy: null, resolvedAt: null }),
    comment: async (id, text) => {
      const record = await tickets.get(id);
      const history = Array.isArray(record?.record?.history) ? [...record.record.history] : [];
      history.push({ at: new Date().toISOString(), actor: currentUser?.username || 'web', action: 'comment', detail: text });
      return updateTicket(id, { history });
    },
  };

  window.auth = {
    session: () => authRequest('session').then(applySession),
    login: (username, password) => authRequest('login', { username, password }).then((result) => {
      if (result.ok) applySession({ user: result.user });
      return result;
    }),
    register: (username, password) => authRequest('register', { username, password }).then((result) => {
      if (result.ok) applySession({ user: result.user });
      return result;
    }),
    setPassword: (password) => authRequest('set-password', { password }),
    logout: () => authRequest('logout', {}).then((result) => {
      currentUser = null;
      try { localStorage.removeItem('crm-web-current-user'); } catch {}
      socket?.close();
      return result;
    }),
    listUsers: () => authRequest('users'),
    createUser: (payload) => authRequest('users', payload),
    updateUser: (username, data) => request(`/web/auth/users/${encodeURIComponent(username)}`, {
      method: 'PATCH', body: data,
    }),
    deleteUser: (username) => request(`/web/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
    onChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      authListeners.add(callback);
      return () => authListeners.delete(callback);
    },
  };

  const settings = { apiUrl: `${location.origin}/api`, cdmsUrl: '', web: true };
  window.crmBackend = {
    connection: async () => ({
      ok: true, settings, connection: { apiUrl: settings.apiUrl, connection: connectionState },
      cdms: await request('/web/cdms/status'),
    }),
    status: async () => {
      const health = await request('/healthz');
      return {
        ok: health.ok, settings,
        connection: { apiUrl: settings.apiUrl, connection: health.ok ? 'live' : 'offline' },
        health: { ...health, apiUrl: settings.apiUrl, connection: health.ok ? 'live' : 'offline' },
        cdms: await request('/web/cdms/status'),
        error: health.error || null,
      };
    },
    getSettings: () => Promise.resolve(settings),
    saveSettings: () => Promise.resolve({ ok: false, error: 'Backend settings are managed by Portainer environment variables' }),
    onChanged,
  };
  window.crmCdms = {
    status: () => request('/web/cdms/status'),
    refresh: () => request('/web/cdms/refresh', { method:'POST', body:{} }),
    catalog: () => request('/web/cdms/catalog'),
    dataset: (endpoint, options = {}) => request('/web/cdms/dataset', {
      method:'POST', body:{ endpoint, options },
    }),
    mutate: (options = {}) => request('/web/cdms/mutate', { method:'POST', body:options }),
    revealSecret: (options = {}) => request('/web/cdms/reveal-secret', { method:'POST', body:options }),
    preferences: (options = {}) => request(`/web/cdms/preferences${options.key ? `?key=${encodeURIComponent(options.key)}` : ''}`, {
      method:String(options.method || 'GET').toUpperCase(),
      body:['POST', 'PUT'].includes(String(options.method || 'GET').toUpperCase()) ? options : undefined,
    }),
    whois: (options = {}) => request('/web/cdms/whois', { method:'POST', body:options }),
    health: () => request('/web/cdms/health'),
    companyProfile: async (companyId) => {
      const catalog = await request('/web/cdms/catalog');
      const company = (catalog.companies || []).find((record) => String(record.id) === String(companyId));
      if (!company) return { ok:false, error:'CDMS company not found' };
      const endpoints = [
        ['external-info', 'External access'], ['core', 'Core infrastructure'],
        ['workstations-users', 'People and workstations'], ['managed-info', 'Managed services'],
        ['guacamole', 'Remote access'], ['devices', 'Devices'], ['containers', 'Containers'],
        ['vms', 'Virtual machines'], ['daemons', 'Daemons'], ['services', 'Services'],
        ['domains', 'Domains'], ['cameras', 'Cameras'], ['emails', 'Email accounts'],
        ['users', 'Users'], ['workstations', 'Workstations'], ['phone-numbers', 'Phone numbers'],
        ['websites', 'Websites'],
      ];
      const sections = await Promise.all(endpoints.map(async ([endpoint, label]) => {
        const result = await window.crmCdms.dataset(endpoint, { client:company.cdmsClient });
        const rows = Array.isArray(result.payload?.data) ? result.payload.data : [];
        return { key:endpoint, label, rows, ok:result.ok !== false, error:result.error };
      }));
      return { ok:true, company, sections };
    },
    onChanged: () => () => {},
  };
  window.dashboard = {
    getStatus: () => Promise.resolve({ status: null, connectionState }),
    onStatus: () => () => {},
    onConnection: onChanged,
    onCheck: () => () => {},
    onSetCompany: () => () => {},
    getHistory: () => Promise.resolve({ ok: true, history: [] }),
    getCompanies: async () => {
      const result = await window.crmStore.list('companies', { includeDeleted: false });
      return (result.records || []).map((company) => ({
        id: company.id,
        label: company.name || company.title || company.companyLabel || company.id,
        host: company.ipAddress || company.host || '',
      }));
    },
    getCompanyHistory: () => Promise.resolve({ results: [], rollups: [] }),
    getViewerIps: () => Promise.resolve({}),
    consumeCompanyFocus: () => Promise.resolve(null),
    getSettings: () => Promise.resolve(settings),
    saveSettings: () => Promise.resolve({ ok: false, error: 'Managed in Portainer' }),
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve({ ok: true }); },
    closeDashboard: () => Promise.resolve({ ok: true }),
    minimize: () => Promise.resolve({ ok: true }),
  };
  window.electron = {
    platform: 'web',
    getSettings: () => Promise.resolve(settings),
    saveSettings: window.crmBackend.saveSettings,
    openExternal: window.dashboard.openExternal,
    openDashboard: () => Promise.resolve({ ok: true }),
  };

  const persistencePrefix = () => `crm-layout-store--${currentUser?.username || '_anon'}--`;
  window.dashboardPersistence = {
    getItem: (key) => localStorage.getItem(`${persistencePrefix()}${key}`),
    setItem: (key, value) => localStorage.setItem(`${persistencePrefix()}${key}`, String(value)),
    removeItem: (key) => localStorage.removeItem(`${persistencePrefix()}${key}`),
    keys: () => Object.keys(localStorage)
      .filter((key) => key.startsWith(persistencePrefix()))
      .map((key) => key.slice(persistencePrefix().length)),
    clear: () => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(persistencePrefix())) localStorage.removeItem(key);
      }
    },
  };
  window.dashboardWindowControls = {
    reload: () => location.reload(),
    hideToTray: () => Promise.resolve({ ok: true }),
    minimize: () => Promise.resolve({ ok: true }),
    close: () => Promise.resolve({ ok: true }),
  };
  window.crmNavigationInput = { onCommand: () => () => {} };
  window.crmCalendarTransition = { captureStrip: () => Promise.resolve({ ok: false, error: 'Electron capture is unavailable in a browser' }) };
  window.crmHomePreviews = {
    isCaptureWorker: false,
    isTileCaptureWorker: false,
    setInteraction: () => Promise.resolve({ ok: true }),
    list: () => Promise.resolve({ ok: true, previews: [] }),
    capture: () => Promise.resolve({ ok: false }),
    waitForIdle: () => Promise.resolve({ ok: true }),
    diagnostics: () => Promise.resolve({ ok: true, web: true }),
    motionSnapshot: () => Promise.resolve(null),
    onChanged: () => () => {},
    onBatchChanged: () => () => {},
    onMotionSnapshotChanged: () => () => {},
    projectList: () => Promise.resolve({ ok: true, previews: [] }),
    captureProject: () => Promise.resolve({ ok: false }),
    onProjectChanged: () => () => {},
  };
  window.crmTilePreviews = {
    list: () => Promise.resolve({ ok: true, previews: [] }),
    capture: () => Promise.resolve({ ok: false }),
    diagnostics: () => Promise.resolve({ ok: true, web: true }),
    onChanged: () => () => {},
  };
})();
