'use strict';

// CDMS integration boundary.
//
// CDMS remains the source of truth: its records are held in memory for the
// authenticated session and are never copied into the CRM Postgres store.
// Workflow records may reference the stable ids produced here, while sensitive
// credential material is stripped before anything crosses into the renderer.

const DEFAULT_CDMS_URL = process.env.CRM_CDMS_URL
  || process.env.CDMS_API_URL
  || 'http://192.168.203.238:6030';

const PROFILE_ENDPOINTS = [
  ['external-info', 'External access'],
  ['core', 'Core infrastructure'],
  ['workstations-users', 'People and workstations'],
  ['managed-info', 'Managed services'],
  ['guacamole', 'Remote access'],
  ['devices', 'Devices'],
  ['containers', 'Containers'],
  ['vms', 'Virtual machines'],
  ['daemons', 'Daemons'],
  ['services', 'Services'],
  ['domains', 'Domains'],
  ['cameras', 'Cameras'],
  ['emails', 'Email accounts'],
  ['users', 'Users'],
  ['workstations', 'Workstations'],
  ['phone-numbers', 'Phone numbers'],
  ['websites', 'Websites'],
];

// Do not weaken this to a display-only mask. These keys are removed before the
// renderer sees the object, so secrets cannot be recovered from devtools.
const SECRET_FIELD = /(password|passwd|passcode|(?:^|[\s_-])(?:pass|pw)(?:$|[\s_-])|secret|token|private[\s_-]*key|recovery[\s_-]*code|one[\s_-]*time|otp)/i;
const INLINE_SECRET = /\b(password|passwd|passcode|pass|pw|secret|token|private[\s_-]*key|recovery[\s_-]*code|otp)\b(\s*[:=]\s*)\S+/ig;
const DATA_ENDPOINTS = new Set([
  'clients', 'companies', 'core', 'workstations-users', 'external-info',
  'managed-info', 'admin-credentials', 'guacamole', 'devices', 'containers',
  'vms', 'daemons', 'services', 'domains', 'cameras', 'emails', 'users',
  'workstations', 'phone-numbers', 'websites',
]);
const LEGACY_DEMO_ID = /^(co|ct|dl|tk|tkt|task|cal|inv|bill|ix|proj|project|wi|com|flow|item|work|case|job)[_-]/i;
const DEMO_ENTITY = new Set([
  'tickets', 'deals', 'jobs', 'cases', 'tasks', 'calendarItems',
  'invoices', 'bills', 'projects', 'workItems', 'commitments',
]);
const CRM_OVERLAY_FIELDS = new Set([
  'lastContactAt', 'lastTouchAt', 'nextTouchAt', 'nextStep', 'scheduledDate',
  'relatedContactIds', 'history', 'meta', 'owner', 'assignee', 'tags',
]);

function text(value) {
  return String(value ?? '').trim();
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function stringList(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(text)
    .filter(Boolean))];
}

const IDENTITY_TEXT_FIELDS = [
  'title', 'description', 'note', 'subject', 'projectTitle', 'decisionMaker',
  'assignedContactName',
];

function referenceAliases(value, prefix) {
  const raw = text(value);
  if (!raw || !new RegExp(`^${prefix}[_-]`, 'i').test(raw)) return [];
  return raw.replace(new RegExp(`^${prefix}[_-]`, 'i'), '')
    .split(/[^a-z0-9]+/i)
    .map(text)
    .filter((part) => part.length >= 3);
}

function replaceIdentityText(record, aliases, replacement) {
  const next = text(replacement);
  if (!record || !next) return;
  const names = stringList(aliases).filter((alias) => alias.length >= 3 && alias.toLowerCase() !== next.toLowerCase());
  if (!names.length) return;
  IDENTITY_TEXT_FIELDS.forEach((field) => {
    if (record[field] == null || record[field] === '') return;
    let value = String(record[field]);
    names.sort((a, b) => b.length - a.length).forEach((alias) => {
      value = value.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), next);
    });
    record[field] = value;
  });
}

function stableHash(value) {
  let hash = 2166136261;
  const input = String(value || '');
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeCdmsUrl(value, fallback = DEFAULT_CDMS_URL) {
  const raw = text(value || fallback);
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname
      .replace(/\/(?:dashboard|api)\/?$/i, '/')
      .replace(/\/+$/, '');
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function sanitizeForRenderer(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForRenderer(item, seen));
  const clean = {};
  Object.entries(value).forEach(([key, item]) => {
    if (SECRET_FIELD.test(key)) return;
    clean[key] = sanitizeForRenderer(item, seen);
  });
  return clean;
}

function redactDatasetPayload(value, path = [], seen = new WeakSet()) {
  if (typeof value === 'string') return value.replace(INLINE_SECRET, '$1$2[redacted]');
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => redactDatasetPayload(item, [...path, index], seen));
  }
  const clean = {};
  const secretFields = [];
  Object.entries(value).forEach(([key, item]) => {
    if (SECRET_FIELD.test(key)) {
      secretFields.push(key);
      return;
    }
    clean[key] = redactDatasetPayload(item, [...path, key], seen);
  });
  if (secretFields.length) clean._secretFields = secretFields;
  if (path.length) clean._cdmsPath = path;
  return clean;
}

function valueAtPath(value, path = []) {
  let current = value;
  for (const part of Array.isArray(path) ? path : []) {
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))) return undefined;
    current = current[part];
  }
  return current;
}

function sanitizeProfileRow(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value.replace(/\b(password|passwd|passcode|secret|token|mfa|otp)\b\s*[:=]\s*\S+/ig, '$1 [redacted]');
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeProfileRow(item, seen));
  const clean = {};
  Object.entries(value).forEach(([key, item]) => {
    if (SECRET_FIELD.test(key) || /^notes?(?:\s*\d+)?$/i.test(key.trim())) return;
    clean[key] = sanitizeProfileRow(item, seen);
  });
  return clean;
}

function normalizeUser(user, { authDisabled = false } = {}) {
  if (!user) return null;
  const role = text(user.role || (user.isAdmin ? 'admin' : 'user')).toLowerCase();
  const isAdmin = role === 'admin' || !!user.isAdmin;
  return {
    id: text(user.id || user.username),
    username: firstText(user.username, user.email, 'guest'),
    email: text(user.email) || null,
    role: isAdmin ? 'admin' : 'user',
    isAdmin,
    permissions: { canManageUsers: false },
    visibleCompanies: null,
    mustChangePassword: false,
    provider: 'cdms',
    authDisabled: !!authDisabled,
  };
}

function companyName(client) {
  const label = firstText(client?.label, client?.value, 'Company');
  const code = text(client?.value);
  if (!code) return label;
  const suffix = new RegExp(`\\s*\\(${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*$`, 'i');
  return label.replace(suffix, '').trim() || label;
}

function rowsFromPayload(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

function isLegacyReference(value, prefix) {
  const raw = text(value);
  if (!raw) return false;
  if (prefix === 'company') return /^co[_-]/i.test(raw);
  if (prefix === 'contact') return /^ct[_-]/i.test(raw);
  return LEGACY_DEMO_ID.test(raw);
}

function isDemoRecord(entity, record) {
  if (!record || record.source === 'cdms') return false;
  if (record.demo === true || record.source === 'demo') return true;
  if (!DEMO_ENTITY.has(entity)) return false;
  return LEGACY_DEMO_ID.test(text(record.id));
}

async function mapLimit(items, limit, mapper) {
  const values = Array.from(items || []);
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length || 1)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function createCdmsClient(options = {}) {
  let fetcher = options.fetcher || globalThis.fetch;
  let onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let disabled = !!options.disabled;
  let baseUrl = normalizeCdmsUrl(options.baseUrl) || DEFAULT_CDMS_URL;
  let requestGeneration = 0;
  let refreshPromise = null;
  let profileCache = new Map();
  let datasetCache = new Map();
  let catalog = { companies: [], contacts: [], assets: [] };
  let state = {
    connection: disabled ? 'disabled' : 'idle',
    config: null,
    user: null,
    authDisabled: false,
    error: null,
    checkedAt: 0,
    syncedAt: 0,
    partialFailures: 0,
  };

  const notify = (reason) => {
    try { onChange({ reason, status: status() }); } catch {}
  };

  function configure(next = {}) {
    if (typeof next.fetcher === 'function') fetcher = next.fetcher;
    if (typeof next.onChange === 'function') onChange = next.onChange;
    if (next.disabled !== undefined) disabled = !!next.disabled;
    const normalized = normalizeCdmsUrl(next.baseUrl || baseUrl);
    if (normalized && normalized !== baseUrl) {
      baseUrl = normalized;
      clearCatalog();
      state = {
        connection: disabled ? 'disabled' : 'idle',
        config: null,
        user: null,
        authDisabled: false,
        error: null,
        checkedAt: 0,
        syncedAt: 0,
        partialFailures: 0,
      };
    } else if (disabled) {
      clearCatalog();
      state.connection = 'disabled';
      state.user = null;
    }
    requestGeneration += 1;
    return status();
  }

  function clearCatalog() {
    catalog = { companies: [], contacts: [], assets: [] };
    profileCache = new Map();
    datasetCache = new Map();
    state.syncedAt = 0;
    state.partialFailures = 0;
  }

  function dataPath(endpoint, client = '', query = {}) {
    const key = text(endpoint);
    if (key.startsWith('misc/')) {
      const requestedClient = text(client || key.slice(5));
      if (!requestedClient) throw new Error('A client is required for Misc data');
      return `/api/data/misc/${encodeURIComponent(requestedClient)}`;
    }
    if (!DATA_ENDPOINTS.has(key)) throw new Error(`Unsupported CDMS data endpoint: ${key}`);
    const params = new URLSearchParams();
    if (client) params.set('client', text(client));
    Object.entries(query && typeof query === 'object' ? query : {}).forEach(([name, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
    });
    return `/api/data/${key}${params.size ? `?${params}` : ''}`;
  }

  function datasetCacheKey(endpoint, client = '', query = {}) {
    return `${text(endpoint)}|${text(client)}|${JSON.stringify(query || {})}`;
  }

  async function dataset(endpoint, options = {}) {
    const client = text(options.client);
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const key = datasetCacheKey(endpoint, client, query);
    const cached = datasetCache.get(key);
    if (!options.force && cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) {
      return {
        ok: true,
        cached: true,
        endpoint:text(endpoint),
        client,
        payload:redactDatasetPayload(cached.payload),
        loadedAt:cached.loadedAt,
      };
    }
    const payload = await request(dataPath(endpoint, client, query), {
      timeoutMs:Number(options.timeoutMs) || 15000,
    });
    const loadedAt = Date.now();
    datasetCache.set(key, { payload, loadedAt });
    return {
      ok: true,
      endpoint:text(endpoint),
      client,
      payload:redactDatasetPayload(payload),
      loadedAt,
    };
  }

  function invalidateDatasets() {
    datasetCache = new Map();
    profileCache = new Map();
    state.syncedAt = 0;
  }

  async function mutateData(options = {}) {
    const kind = text(options.kind || 'update');
    let path = '/api/data/update';
    let body = options.body && typeof options.body === 'object' ? options.body : {};
    if (kind === 'company') path = '/api/data/companies';
    else if (kind === 'misc') {
      const client = text(options.client);
      if (!client) return { ok:false, error:'A client is required for Misc changes' };
      path = `/api/data/misc/${encodeURIComponent(client)}`;
    } else if (kind !== 'update') {
      return { ok:false, error:`Unsupported CDMS mutation kind: ${kind}` };
    }
    const allowedActions = kind === 'company'
      ? new Set(['add', 'update'])
      : kind === 'misc'
        ? new Set(['updateCell', 'addRow', 'deleteRow'])
        : new Set(['updateCell', 'updateRow', 'addRow', 'deleteRow', 'setInactive']);
    if (!allowedActions.has(text(body.action))) {
      return { ok:false, error:`Unsupported CDMS mutation action: ${text(body.action)}` };
    }
    try {
      const result = await request(path, { method:'POST', body, timeoutMs:20000 });
      invalidateDatasets();
      notify('dataset-mutation');
      return { ok:true, ...sanitizeForRenderer(result) };
    } catch (error) {
      return { ok:false, error:error.message, status:error.status || 0 };
    }
  }

  async function revealSecret(options = {}) {
    const endpoint = text(options.endpoint);
    const client = text(options.client);
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const key = datasetCacheKey(endpoint, client, query);
    if (!datasetCache.has(key)) await dataset(endpoint, { client, query, force:true });
    const cached = datasetCache.get(key);
    const field = text(options.field);
    if (!cached || !field || !SECRET_FIELD.test(field)) {
      return { ok:false, error:'That field cannot be revealed' };
    }
    const record = valueAtPath(cached.payload, options.path);
    if (!record || typeof record !== 'object' || !Object.prototype.hasOwnProperty.call(record, field)) {
      return { ok:false, error:'The credential is no longer available; refresh the record' };
    }
    return { ok:true, value:String(record[field] ?? '') };
  }

  async function preferences(options = {}) {
    const key = text(options.key);
    const path = key ? `/api/preferences/${encodeURIComponent(key)}` : '/api/preferences';
    const method = text(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
      return { ok:false, error:'Unsupported preference operation' };
    }
    try {
      const payload = await request(path, {
        method,
        body:['POST', 'PUT'].includes(method) ? (options.body || {}) : undefined,
      });
      return { ok:true, ...sanitizeForRenderer(payload) };
    } catch (error) {
      return { ok:false, error:error.message, status:error.status || 0 };
    }
  }

  async function whois(options = {}) {
    const action = text(options.action || 'check');
    if (!['check', 'lookup'].includes(action)) return { ok:false, error:'Unsupported WHOIS action' };
    const params = new URLSearchParams({ action });
    if (options.domain) params.set('domain', text(options.domain));
    try {
      return { ok:true, ...sanitizeForRenderer(await request(`/api/whois?${params}`, { timeoutMs:20000 })) };
    } catch (error) {
      return { ok:false, error:error.message, status:error.status || 0 };
    }
  }

  async function health() {
    try {
      return { ok:true, ...sanitizeForRenderer(await request('/api/health', { timeoutMs:10000 })) };
    } catch (error) {
      return { ok:false, error:error.message, status:error.status || 0 };
    }
  }

  async function request(path, requestOptions = {}) {
    if (disabled) {
      const error = new Error('CDMS integration is disabled');
      error.status = 0;
      throw error;
    }
    if (typeof fetcher !== 'function') throw new Error('No CDMS network transport is available');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(requestOptions.timeoutMs) || 10000);
    const headers = { Accept: 'application/json', ...(requestOptions.headers || {}) };
    const init = {
      method: requestOptions.method || 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    };
    if (requestOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(requestOptions.body);
    }
    let response;
    try {
      response = await fetcher(`${baseUrl}${path}`, init);
    } catch (error) {
      const wrapped = new Error(error?.name === 'AbortError' ? 'CDMS request timed out' : (error?.message || 'CDMS request failed'));
      wrapped.status = 0;
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
    let payload = null;
    const raw = await response.text();
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    }
    if (!response.ok) {
      const error = new Error(firstText(payload?.error, payload?.message, response.statusText, `CDMS returned ${response.status}`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload || {};
  }

  async function initialize(next = {}) {
    configure(next);
    if (disabled) {
      notify('disabled');
      return status();
    }
    const generation = ++requestGeneration;
    state.connection = 'connecting';
    state.error = null;
    notify('connecting');
    try {
      const config = await request('/api/config', { timeoutMs: 5000 });
      if (generation !== requestGeneration) return status();
      state.config = sanitizeForRenderer(config);
      state.authDisabled = !!config.authDisabled;
      state.connection = 'live';
      state.checkedAt = Date.now();
      if (state.authDisabled) {
        state.user = normalizeUser({ id: 'guest', username: 'guest', role: 'admin' }, { authDisabled: true });
      } else {
        try {
          const session = await request('/api/auth/me', { timeoutMs: 5000 });
          state.user = normalizeUser(session.user);
        } catch (error) {
          if (error.status !== 401) throw error;
          state.user = null;
        }
      }
      notify('session');
      if (state.user) await refreshCatalog({ force: true });
    } catch (error) {
      if (generation !== requestGeneration) return status();
      state.connection = 'offline';
      state.error = error?.message || 'CDMS is unavailable';
      state.checkedAt = Date.now();
      state.user = null;
      clearCatalog();
      notify('offline');
    }
    return status();
  }

  async function login(username, password) {
    if (disabled || state.connection === 'offline') {
      return { ok: false, error: state.error || 'CDMS is unavailable' };
    }
    if (state.authDisabled) {
      state.user = normalizeUser({ id: 'guest', username: 'guest', role: 'admin' }, { authDisabled: true });
      await refreshCatalog({ force: true });
      notify('login');
      return { ok: true, user: state.user, provider: 'cdms', authDisabled: true };
    }
    const name = text(username);
    if (!name || !password) return { ok: false, error: 'Username and password are required' };
    try {
      const payload = await request('/api/auth/login', {
        method: 'POST',
        body: { username: name, password },
        timeoutMs: 10000,
      });
      state.user = normalizeUser(payload.user);
      state.connection = 'live';
      state.error = null;
      await refreshCatalog({ force: true });
      notify('login');
      return { ok: true, user: state.user, provider: 'cdms', authDisabled: false };
    } catch (error) {
      return { ok: false, error: error.status === 401 ? 'Incorrect CDMS username or password' : error.message };
    }
  }

  async function logout() {
    try { await request('/api/auth/logout', { method: 'POST', timeoutMs: 5000 }); } catch {}
    clearCatalog();
    state.user = state.authDisabled
      ? normalizeUser({ id: 'guest', username: 'guest', role: 'admin' }, { authDisabled: true })
      : null;
    notify('logout');
    if (state.user) await refreshCatalog({ force: true });
    return { ok: true, user: state.user, provider: 'cdms', authDisabled: state.authDisabled };
  }

  function contactCandidates(row) {
    const nested = Array.isArray(row?.users) ? row.users : [];
    if (!nested.length) return [row];
    return nested.map((user) => ({
      ...row,
      ...user,
      fullName: firstText(user.name, row.fullName),
      username: firstText(user.login, user.username, row.username),
      phone: firstText(user.phone, user.cell, row.phone),
      email: firstText(user.email, row.email),
    }));
  }

  function normalizeCatalog(clients, profiles) {
    const syncedIso = new Date().toISOString();
    const companyRecords = clients.map((client) => {
      const code = text(client.value);
      const name = companyName(client);
      return {
        id: `cdms-company-${stableHash(code.toLowerCase())}`,
        source: 'cdms',
        sourceId: code,
        cdmsClient: code,
        readOnly: true,
        name,
        title: name,
        company: name,
        companyCode: code,
        abbrv: code,
        group: text(client.group),
        description: [text(client.group), code ? `CDMS ${code}` : 'CDMS'].filter(Boolean).join(' · '),
        state: 'active',
        priority: 'none',
        createdAt: syncedIso,
        updatedAt: syncedIso,
        deletedAt: null,
        version: 1,
      };
    });
    const companyByCode = new Map(companyRecords.map((company) => [company.cdmsClient.toLowerCase(), company]));
    const contactMap = new Map();
    const assetMap = new Map();

    profiles.forEach((profile) => {
      if (!profile || !profile.client) return;
      const company = companyByCode.get(text(profile.client.value).toLowerCase());
      if (!company) return;
      (profile.rows || []).forEach((row) => {
        const computerName = firstText(row.computerName, row['Computer Name'], row._wsComputerName);
        const ipAddress = firstText(row.ipAddress, row['IP Address'], row['IP address'], row.IP, row.IntIP);
        const serviceTag = firstText(row.serviceTag, row['Service Tag']);
        const location = firstText(row.location, row.Location, row.Grouping);
        if (computerName || ipAddress || serviceTag) {
          const assetKey = `${company.cdmsClient}|${computerName}|${ipAddress}|${serviceTag}`.toLowerCase();
          const id = `cdms-asset-${stableHash(assetKey)}`;
          const existing = assetMap.get(id) || {
            id,
            source: 'cdms',
            sourceId: assetKey,
            readOnly: true,
            kind: 'workstation',
            type: 'workstation',
            name: firstText(computerName, ipAddress, serviceTag, 'Workstation'),
            title: firstText(computerName, ipAddress, serviceTag, 'Workstation'),
            host: firstText(computerName, ipAddress),
            ipAddress,
            ipAddresses: [],
            serviceTag,
            location,
            cpu: text(row.cpu),
            description: firstText(row.description, [location, serviceTag].filter(Boolean).join(' · ')),
            companyId: company.id,
            company: company.name,
            companyLabel: company.name,
            companyCode: company.companyCode,
            state: String(row.Active ?? 'active') === '0' ? 'inactive' : 'active',
            priority: 'none',
            contactIds: [],
            createdAt: syncedIso,
            updatedAt: syncedIso,
            deletedAt: null,
            version: 1,
          };
          existing.ipAddresses = stringList([...existing.ipAddresses, ipAddress]);
          assetMap.set(id, existing);
        }

        contactCandidates(row).forEach((candidate) => {
          const name = firstText(candidate.fullName, candidate.name, candidate.userDisplay, candidate.username, candidate.login);
          const username = firstText(candidate.username, candidate.login, candidate._userLogin);
          const email = firstText(candidate.email, candidate.Email);
          const phone = firstText(candidate.phone, candidate.cell, candidate.Phone);
          if (!name && !username && !email && !phone) return;
          const identity = firstText(username, email, name, phone).toLowerCase();
          const id = `cdms-contact-${stableHash(`${company.cdmsClient}|${identity}`)}`;
          const existing = contactMap.get(id) || {
            id,
            source: 'cdms',
            sourceId: `${company.cdmsClient}:${identity}`,
            readOnly: true,
            name: firstText(name, username, email, 'CDMS user'),
            title: firstText(name, username, email, 'CDMS user'),
            client: firstText(name, username, email, 'CDMS user'),
            fullName: firstText(name, username),
            username,
            login: username,
            email,
            phone,
            role: 'CDMS user',
            companyId: company.id,
            company: company.name,
            companyName: company.name,
            companyLabel: company.name,
            companyCode: company.companyCode,
            location,
            workstation: computerName,
            workstations: [],
            ipAddress,
            ipAddresses: [],
            serviceTag,
            serviceTags: [],
            assetIds: [],
            description: '',
            state: 'open',
            status: 'active',
            priority: 'none',
            createdAt: syncedIso,
            updatedAt: syncedIso,
            deletedAt: null,
            version: 1,
          };
          existing.workstations = stringList([...existing.workstations, computerName]);
          existing.ipAddresses = stringList([...existing.ipAddresses, ipAddress]);
          existing.serviceTags = stringList([...existing.serviceTags, serviceTag]);
          if (!existing.email) existing.email = email;
          if (!existing.phone) existing.phone = phone;
          if (!existing.location) existing.location = location;
          if (!existing.workstation) existing.workstation = existing.workstations[0] || '';
          if (!existing.ipAddress) existing.ipAddress = existing.ipAddresses[0] || '';
          existing.description = [
            existing.username ? `Login ${existing.username}` : '',
            existing.email,
            existing.workstation,
            existing.ipAddress,
          ].filter(Boolean).join(' · ');
          contactMap.set(id, existing);
        });
      });
    });

    const assets = [...assetMap.values()];
    const contacts = [...contactMap.values()];
    const assetsByCompany = new Map();
    assets.forEach((asset) => {
      if (!assetsByCompany.has(asset.companyId)) assetsByCompany.set(asset.companyId, []);
      assetsByCompany.get(asset.companyId).push(asset);
    });
    const contactsByCompany = new Map();
    contacts.forEach((contact) => {
      if (!contactsByCompany.has(contact.companyId)) contactsByCompany.set(contact.companyId, []);
      contactsByCompany.get(contact.companyId).push(contact);
      const contactAssets = assets.filter((asset) => (
        asset.companyId === contact.companyId
        && ((contact.workstations || []).includes(asset.name) || (contact.ipAddresses || []).includes(asset.ipAddress))
      ));
      contact.assetIds = stringList(contactAssets.map((asset) => asset.id));
      contactAssets.forEach((asset) => {
        asset.contactIds = stringList([...asset.contactIds, contact.id]);
      });
    });
    companyRecords.forEach((company) => {
      const companyAssets = assetsByCompany.get(company.id) || [];
      const companyContacts = contactsByCompany.get(company.id) || [];
      company.contactCount = companyContacts.length;
      company.assetCount = companyAssets.length;
      company.ipAddresses = stringList(companyAssets.flatMap((asset) => asset.ipAddresses || [asset.ipAddress]));
      company.ipAddress = company.ipAddresses[0] || '';
      company.host = companyAssets[0]?.host || company.ipAddress || '';
      company.description = [
        company.group,
        `${companyContacts.length} ${companyContacts.length === 1 ? 'person' : 'people'}`,
        `${companyAssets.length} ${companyAssets.length === 1 ? 'device' : 'devices'}`,
      ].filter(Boolean).join(' · ');
    });
    return {
      companies: companyRecords.sort((a, b) => a.name.localeCompare(b.name)),
      contacts: contacts.sort((a, b) => a.name.localeCompare(b.name)),
      assets: assets.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async function refreshCatalog({ force = false } = {}) {
    if (disabled || !state.user) return { ok: false, error: 'Sign in to CDMS first', ...catalogSummary() };
    if (!force && state.syncedAt && Date.now() - state.syncedAt < 5 * 60 * 1000) {
      return { ok: true, cached: true, ...catalogSummary() };
    }
    if (refreshPromise) return refreshPromise;
    const generation = requestGeneration;
    refreshPromise = (async () => {
      try {
        const clientPayload = await request('/api/data/clients', { timeoutMs: 15000 });
        const clients = Array.isArray(clientPayload.clients) ? clientPayload.clients.filter((client) => text(client?.value)) : [];
        let failures = 0;
        const profiles = await mapLimit(clients, 6, async (client) => {
          try {
            const payload = await request(`/api/data/workstations-users?client=${encodeURIComponent(client.value)}`, { timeoutMs: 15000 });
            return { client, rows: rowsFromPayload(payload) };
          } catch (error) {
            if (error.status === 401) throw error;
            failures += 1;
            return { client, rows: [] };
          }
        });
        if (generation !== requestGeneration) return { ok: false, stale: true, ...catalogSummary() };
        catalog = normalizeCatalog(clients, profiles);
        profileCache = new Map();
        state.syncedAt = Date.now();
        state.partialFailures = failures;
        state.connection = 'live';
        state.error = failures ? `${failures} client data source${failures === 1 ? '' : 's'} could not be read` : null;
        notify('catalog');
        return { ok: true, partialFailures: failures, ...catalogSummary() };
      } catch (error) {
        if (error.status === 401) {
          state.user = null;
          clearCatalog();
          notify('session-expired');
          return { ok: false, error: 'Your CDMS session expired' };
        }
        state.error = error.message;
        notify('catalog-error');
        return { ok: false, error: error.message, ...catalogSummary() };
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function catalogSummary() {
    return {
      companies: catalog.companies.length,
      contacts: catalog.contacts.length,
      assets: catalog.assets.length,
      syncedAt: state.syncedAt,
      partialFailures: state.partialFailures,
    };
  }

  function status() {
    return {
      ok: state.connection === 'live',
      provider: 'cdms',
      baseUrl,
      connection: state.connection,
      authDisabled: state.authDisabled,
      user: state.user ? { ...state.user, permissions: { ...state.user.permissions } } : null,
      appName: state.config?.appName || 'Client Data Management System',
      version: state.config?.version || '',
      error: state.error,
      checkedAt: state.checkedAt,
      ...catalogSummary(),
    };
  }

  function sessionSnapshot() {
    const current = status();
    return {
      user: current.user,
      provider: 'cdms',
      authDisabled: current.authDisabled,
      connection: current.connection,
      cdmsUrl: current.baseUrl,
      error: current.error,
    };
  }

  function records(entity) {
    if (entity === 'companies') return catalog.companies;
    if (entity === 'contacts') return catalog.contacts;
    if (entity === 'assets') return catalog.assets;
    return [];
  }

  function getRecord(entity, id) {
    return records(entity).find((record) => String(record.id) === String(id)) || null;
  }

  function indexFor(seed, length) {
    if (!length) return -1;
    return parseInt(stableHash(seed), 36) % length;
  }

  function referencesFor(entity, seeds = []) {
    const pool = records(entity);
    const keys = [...new Set((Array.isArray(seeds) ? seeds : [seeds]).map(text).filter(Boolean))].sort();
    const assignments = new Map();
    const used = new Set();
    keys.forEach((key) => {
      if (!pool.length) return;
      let index = indexFor(`${entity}:${key}`, pool.length);
      let probes = 0;
      while (used.has(index) && probes < pool.length) {
        index = (index + 1) % pool.length;
        probes += 1;
      }
      assignments.set(key, pool[index]);
      used.add(index);
    });
    return assignments;
  }

  function decorateRecord(entity, input) {
    if (!input || input.source === 'cdms' || !catalog.companies.length) return input;
    const record = { ...input };
    const demo = isDemoRecord(entity, record);
    const originalCompanyName = firstText(
      record.companyLabel,
      record.companyName,
      record.company,
      ['tickets', 'cases', 'jobs', 'deals'].includes(entity) ? record.client : '',
    );
    const originalContactName = firstText(
      record.contactName,
      record.contact,
      record.decisionMaker,
      entity === 'projects' ? record.owner : '',
      ['workItems', 'commitments'].includes(entity) ? firstText(record.assignedContactName, record.assignee) : '',
    );
    const originalContactId = firstText(record.contactId, record.ownerContactId, record.assignedContactId);
    const companyAliases = [originalCompanyName, ...referenceAliases(record.companyId, 'co')];
    const contactAliases = [originalContactName, ...referenceAliases(originalContactId, 'ct')];
    const requestedCompany = getRecord('companies', record.companyId);
    const shouldBindCompany = !requestedCompany && (demo || isLegacyReference(record.companyId, 'company'));
    const companySeed = record.projectId ? `project:${record.projectId}` : `${entity}:${record.id}`;
    const needsAsset = ['tickets', 'cases', 'jobs', 'tasks', 'workItems', 'commitments'].includes(entity);
    const needsContact = needsAsset || ['projects', 'calendarItems', 'deals', 'invoices', 'interactions'].includes(entity);
    const preferredCompanies = catalog.companies.filter((candidate) => (
      (!needsAsset || catalog.assets.some((asset) => asset.companyId === candidate.id))
      && (!needsContact || catalog.contacts.some((contact) => contact.companyId === candidate.id))
    ));
    const companyPool = preferredCompanies.length ? preferredCompanies : catalog.companies;
    const company = requestedCompany || (shouldBindCompany
      ? companyPool[indexFor(`${companySeed}:company`, companyPool.length)]
      : null);
    if (company) {
      record.companyId = company.id;
      record.company = company.name;
      record.companyName = company.name;
      record.companyLabel = company.name;
      record.companyCode = company.companyCode;
      record.cdmsCompanyId = company.id;
      if ('client' in record) record.client = company.name;
      replaceIdentityText(record, companyAliases, company.name);
      if (demo && entity === 'invoices') {
        record.title = [firstText(record.number, record.reference), company.name].filter(Boolean).join(' — ');
      }
      if (demo && (entity === 'projects' || record.projectId)) {
        const sourceTitle = firstText(entity === 'projects' ? record.title : record.projectTitle);
        const kind = (sourceTitle.match(/\b(launch|upgrade|refresh|migration|rollout|project)\b/i) || [])[1] || 'project';
        const projectTitle = `${company.name} ${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}`;
        if (entity === 'projects') record.title = projectTitle;
        if ('projectTitle' in record) record.projectTitle = projectTitle;
      }
    }

    const companyContacts = company
      ? catalog.contacts.filter((contact) => contact.companyId === company.id)
      : catalog.contacts;
    const currentContact = getRecord('contacts', record.contactId || record.ownerContactId || record.assignedContactId);
    const legacyContact = isLegacyReference(record.contactId, 'contact')
      || isLegacyReference(record.ownerContactId, 'contact')
      || isLegacyReference(record.assignedContactId, 'contact');
    const contact = currentContact || ((demo || legacyContact) && companyContacts.length
      ? companyContacts[indexFor(`${entity}:${record.id}:contact`, companyContacts.length)]
      : null);
    if (contact) {
      if ('contactId' in record || ['tickets', 'tasks', 'cases', 'jobs', 'calendarItems', 'deals', 'invoices', 'interactions'].includes(entity)) record.contactId = contact.id;
      if ('ownerContactId' in record || entity === 'projects') record.ownerContactId = contact.id;
      if ('assignedContactId' in record || entity === 'workItems' || entity === 'commitments') record.assignedContactId = contact.id;
      if (entity === 'projects') record.owner = contact.name;
      if (entity === 'workItems' || entity === 'commitments') record.assignee = contact.name;
      if ('decisionMaker' in record || entity === 'deals') record.decisionMaker = contact.name;
      record.contact = contact.name;
      record.contactName = contact.name;
      record.cdmsContactId = contact.id;
      replaceIdentityText(record, contactAliases, contact.name);
      if (demo && entity === 'calendarItems') {
        let context = firstText(record.title, record.kind, 'event');
        [contact.name, company?.name].filter(Boolean).forEach((prefix) => {
          if (context.toLowerCase().startsWith(prefix.toLowerCase())) context = context.slice(prefix.length);
        });
        if (/\s+[—–-]\s+/.test(context)) {
          context = context.split(/\s+[—–-]\s+/).slice(1).join(' — ');
        }
        context = context.replace(/^[\s—–:|-]+/, '').trim() || firstText(record.kind, 'event');
        record.title = `${contact.name} — ${context}`;
      }
      if (String(record.linkedEntityType || '').toLowerCase() === 'contacts'
        && (!getRecord('contacts', record.linkedRecordId) || isLegacyReference(record.linkedRecordId, 'contact'))) {
        record.linkedRecordId = contact.id;
      }
      if (Array.isArray(record.links)) {
        record.links = record.links.map((link) => (
          String(link?.entityType || '').toLowerCase() === 'contacts'
            && (!getRecord('contacts', link.recordId) || isLegacyReference(link.recordId, 'contact'))
            ? { ...link, recordId: contact.id }
            : link
        ));
      }
    }

    const companyAssets = company ? catalog.assets.filter((asset) => asset.companyId === company.id) : [];
    const asset = companyAssets.length
      ? companyAssets[indexFor(`${entity}:${record.id}:asset`, companyAssets.length)]
      : null;
    if (asset && demo && ['tickets', 'cases', 'jobs', 'tasks', 'workItems', 'commitments'].includes(entity)) {
      record.assetId = asset.id;
      record.cdmsAssetId = asset.id;
      record.ipAddress = asset.ipAddress;
      record.host = [asset.name, asset.ipAddress].filter(Boolean).join(' · ');
    }
    if (company || contact || asset) {
      record.cdmsReference = true;
      record.referenceSource = 'cdms';
    }
    return record;
  }

  function overlayRecords(entity, localRecords = []) {
    const local = Array.isArray(localRecords) ? localRecords : [];
    if (entity === 'assets') return [...catalog.assets];
    if (entity === 'companies' && catalog.companies.length) {
      const overlays = new Map(local.map((record) => [String(record?.id || ''), record]));
      return [
        ...catalog.companies.map((record) => mergeCrmOverlay(record, overlays.get(record.id))),
        ...local.filter((record) => !getRecord('companies', record?.id) && (record?.source === 'cdms' || !/^co[_-]/i.test(text(record?.id)))),
      ];
    }
    if (entity === 'contacts' && catalog.contacts.length) {
      const overlays = new Map(local.map((record) => [String(record?.id || ''), record]));
      return [
        ...catalog.contacts.map((record) => mergeCrmOverlay(record, overlays.get(record.id))),
        ...local.filter((record) => !getRecord('contacts', record?.id) && (record?.source === 'cdms' || !/^ct[_-]/i.test(text(record?.id)))),
      ];
    }
    return local.map((record) => decorateRecord(entity, record));
  }

  function mergeCrmOverlay(sourceRecord, overlay) {
    if (!overlay || overlay.source !== 'cdms-overlay') return sourceRecord;
    const merged = { ...sourceRecord };
    CRM_OVERLAY_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(overlay, field)) merged[field] = overlay[field];
    });
    merged.crmOverlay = true;
    merged.crmOverlayVersion = overlay.version;
    merged.crmUpdatedAt = overlay.updatedAt;
    return merged;
  }

  async function companyProfile(companyId, { force = false } = {}) {
    const company = getRecord('companies', companyId);
    if (!company) return { ok: false, error: 'CDMS company not found' };
    const cached = profileCache.get(company.id);
    if (!force && cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) return cached.payload;
    const results = await mapLimit(PROFILE_ENDPOINTS, 5, async ([endpoint, label]) => {
      try {
        const payload = await request(`/api/data/${endpoint}?client=${encodeURIComponent(company.cdmsClient)}`, { timeoutMs: 15000 });
        return {
          key: endpoint,
          label,
          rows: rowsFromPayload(payload).map((row) => sanitizeProfileRow(row)),
          ok: true,
        };
      } catch (error) {
        return { key: endpoint, label, rows: [], ok: false, error: error.message };
      }
    });
    const payload = {
      ok: true,
      company: sanitizeForRenderer(company),
      sections: results,
      summary: {
        sections: results.filter((section) => section.ok && section.rows.length).length,
        records: results.reduce((total, section) => total + section.rows.length, 0),
        failures: results.filter((section) => !section.ok).length,
      },
      loadedAt: Date.now(),
    };
    profileCache.set(company.id, { loadedAt: Date.now(), payload });
    return payload;
  }

  return {
    configure,
    initialize,
    login,
    logout,
    refreshCatalog,
    status,
    session: sessionSnapshot,
    catalog: () => ({
      ok: state.connection === 'live',
      status: status(),
      companies: catalog.companies.map((record) => sanitizeForRenderer(record)),
      contacts: catalog.contacts.map((record) => sanitizeForRenderer(record)),
      assets: catalog.assets.map((record) => sanitizeForRenderer(record)),
    }),
    records,
    getRecord,
    referencesFor,
    overlayRecords,
    decorateRecord,
    companyProfile,
    dataset,
    mutateData,
    revealSecret,
    preferences,
    whois,
    health,
    clear: () => {
      clearCatalog();
      notify('clear');
    },
  };
}

module.exports = {
  CRM_OVERLAY_FIELDS,
  DEFAULT_CDMS_URL,
  PROFILE_ENDPOINTS,
  createCdmsClient,
  normalizeCdmsUrl,
  normalizeUser,
  sanitizeForRenderer,
  redactDatasetPayload,
  valueAtPath,
  sanitizeProfileRow,
  stableHash,
};
