'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocket, WebSocketServer } = require('ws');
const { redactDatasetPayload, valueAtPath } = require('../electron/cdms-client.cjs');

const PORT = Number(process.env.CRM_WEB_PORT || 8080);
const API_URL = String(process.env.CRM_API_URL || 'http://crm-api:3899').replace(/\/+$/, '');
const CDMS_URL = String(process.env.CRM_CDMS_URL || process.env.CDMS_API_URL || 'http://192.168.203.238:6030').replace(/\/+$/, '');
const DASHBOARD_DIR = path.resolve(__dirname, '..', 'dashboard');
const DATA_DIR = path.resolve(process.env.CRM_WEB_DATA_DIR || '/data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_TTL_MS = Math.max(300000, Number(process.env.CRM_SESSION_TTL_MS) || 12 * 60 * 60 * 1000);
const COOKIE_SECURE = process.env.CRM_COOKIE_SECURE === '1';
const DEFAULT_ADMIN_USERNAME = String(process.env.CRM_ADMIN_USERNAME || 'admin').trim() || 'admin';
const DEFAULT_ADMIN_PASSWORD = String(process.env.CRM_ADMIN_PASSWORD || 'admin1');
const sessions = new Map();
const cdmsDatasetCache = new Map();
const CDMS_SECRET_FIELD = /(password|passwd|passcode|(?:^|[\s_-])(?:pass|pw)(?:$|[\s_-])|secret|token|private[\s_-]*key|recovery[\s_-]*code|one[\s_-]*time|otp)/i;
const CDMS_DATA_ENDPOINTS = new Set([
  'clients', 'companies', 'core', 'workstations-users', 'external-info',
  'managed-info', 'admin-credentials', 'guacamole', 'devices', 'containers',
  'vms', 'daemons', 'services', 'domains', 'cameras', 'emails', 'users',
  'workstations', 'phone-numbers', 'websites',
]);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Request body is too large');
  }
  if (!raw.trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
  return value;
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString('hex'),
  };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const actual = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.users)) return parsed;
  } catch {}
  return { users: [] };
}

function writeUsers(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, USERS_FILE);
}

function seedUsers() {
  const store = readUsers();
  if (!store.users.length) {
    store.users.push({
      username: DEFAULT_ADMIN_USERNAME,
      isAdmin: true,
      permissions: { canManageUsers: true },
      visibleCompanies: null,
      mustChangePassword: DEFAULT_ADMIN_PASSWORD === 'admin1',
      ...hashPassword(DEFAULT_ADMIN_PASSWORD),
    });
    writeUsers(store);
  }
  return store;
}

function rawUser(username) {
  const key = normalizeUsername(username).toLowerCase();
  return seedUsers().users.find((user) => String(user.username).toLowerCase() === key) || null;
}

function publicUser(user) {
  if (!user) return null;
  const canManageUsers = !!(user.isAdmin || user.permissions?.canManageUsers);
  return {
    username: user.username,
    isAdmin: !!user.isAdmin,
    permissions: { canManageUsers },
    visibleCompanies: canManageUsers ? null : (Array.isArray(user.visibleCompanies) ? user.visibleCompanies : []),
    mustChangePassword: !!user.mustChangePassword,
  };
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionFor(req) {
  const token = cookies(req).crm_session;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now() || !rawUser(session.username)) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session, user: rawUser(session.username) };
}

function sessionCookie(token, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  return `crm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? '; Secure' : ''}`;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireSession(req, res) {
  const session = sessionFor(req);
  if (!session) sendJson(res, 401, { ok: false, error: 'Authentication required' });
  return session;
}

function canManage(session) {
  return !!(session?.user?.isAdmin || session?.user?.permissions?.canManageUsers);
}

function cdmsSessionState(session) {
  return session?.token ? sessions.get(session.token) || null : null;
}

async function cdmsRequest(session, pathname, options = {}) {
  const target = new URL(pathname, CDMS_URL);
  const state = cdmsSessionState(session);
  const headers = { accept:'application/json', ...(options.headers || {}) };
  if (state?.cdmsCookie) headers.cookie = state.cdmsCookie;
  const init = {
    method:options.method || 'GET',
    headers,
    cache:'no-store',
    signal:AbortSignal.timeout(Number(options.timeoutMs) || 15000),
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(target, init);
  const setCookie = response.headers.get('set-cookie');
  if (state && setCookie) state.cdmsCookie = setCookie.split(';')[0];
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `CDMS returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function cdmsDataPath(endpoint, client = '', query = {}) {
  const key = String(endpoint || '').trim();
  if (key === 'misc' || key.startsWith('misc/')) {
    const selected = String(client || key.slice(5) || '').trim();
    if (!selected) throw new Error('A client is required for Misc data');
    return `/api/data/misc/${encodeURIComponent(selected)}`;
  }
  if (!CDMS_DATA_ENDPOINTS.has(key)) throw new Error(`Unsupported CDMS data endpoint: ${key}`);
  const params = new URLSearchParams();
  if (client) params.set('client', String(client));
  Object.entries(query && typeof query === 'object' ? query : {}).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
  });
  return `/api/data/${key}${params.size ? `?${params}` : ''}`;
}

function cdmsCacheKey(session, endpoint, client, query) {
  return `${session?.token || '_public'}|${endpoint}|${client || ''}|${JSON.stringify(query || {})}`;
}

async function cdmsDataset(session, endpoint, options = {}) {
  const client = String(options.client || '').trim();
  const query = options.query && typeof options.query === 'object' ? options.query : {};
  const key = cdmsCacheKey(session, endpoint, client, query);
  const cached = cdmsDatasetCache.get(key);
  if (!options.force && cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) {
    return { ok:true, cached:true, endpoint, client, payload:redactDatasetPayload(cached.payload), loadedAt:cached.loadedAt };
  }
  const payload = await cdmsRequest(session, cdmsDataPath(endpoint, client, query));
  const loadedAt = Date.now();
  cdmsDatasetCache.set(key, { payload, loadedAt });
  return { ok:true, endpoint, client, payload:redactDatasetPayload(payload), loadedAt };
}

function clearCdmsCache(session) {
  const prefix = `${session?.token || '_public'}|`;
  for (const key of cdmsDatasetCache.keys()) {
    if (key.startsWith(prefix)) cdmsDatasetCache.delete(key);
  }
}

async function cdmsRoute(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return;
  const action = url.pathname.slice('/web/cdms/'.length);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
  try {
    if (action === 'status' && req.method === 'GET') {
      const config = await cdmsRequest(session, '/api/config', { timeoutMs:5000 });
      return sendJson(res, 200, {
        ok:true,
        provider:'cdms',
        baseUrl:CDMS_URL,
        connection:'live',
        authDisabled:!!config.authDisabled,
        appName:config.appName,
        version:config.version,
        user:publicUser(session.user),
      });
    }
    if (action === 'dataset' && req.method === 'POST') {
      return sendJson(res, 200, await cdmsDataset(session, String(body.endpoint || ''), body.options || {}));
    }
    if (action === 'catalog' && req.method === 'GET') {
      const result = await cdmsDataset(session, 'clients');
      const clients = Array.isArray(result.payload?.clients) ? result.payload.clients : [];
      const companies = clients.map((client, index) => ({
        id:`cdms-company-${String(client.value || index).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        source:'cdms',
        sourceId:String(client.value || ''),
        cdmsClient:String(client.value || ''),
        readOnly:true,
        name:String(client.label || client.value || 'Client').replace(/\s*\([^)]*\)\s*$/, ''),
        title:String(client.label || client.value || 'Client'),
        companyCode:String(client.value || ''),
        group:String(client.group || ''),
        state:'active',
      }));
      return sendJson(res, 200, { ok:true, companies, contacts:[], assets:[] });
    }
    if (action === 'refresh' && req.method === 'POST') {
      clearCdmsCache(session);
      const result = await cdmsDataset(session, 'clients', { force:true });
      return sendJson(res, 200, { ok:true, clients:Array.isArray(result.payload?.clients) ? result.payload.clients.length : 0 });
    }
    if (action === 'mutate' && req.method === 'POST') {
      const kind = String(body.kind || 'update');
      let pathname = '/api/data/update';
      if (kind === 'company') pathname = '/api/data/companies';
      else if (kind === 'misc') {
        if (!body.client) return sendJson(res, 400, { ok:false, error:'A client is required for Misc changes' });
        pathname = `/api/data/misc/${encodeURIComponent(String(body.client))}`;
      } else if (kind !== 'update') {
        return sendJson(res, 400, { ok:false, error:'Unsupported CDMS mutation kind' });
      }
      const result = await cdmsRequest(session, pathname, { method:'POST', body:body.body || {}, timeoutMs:20000 });
      clearCdmsCache(session);
      return sendJson(res, 200, { ok:true, ...redactDatasetPayload(result) });
    }
    if (action === 'reveal-secret' && req.method === 'POST') {
      const endpoint = String(body.endpoint || '');
      const client = String(body.client || '');
      const query = body.query && typeof body.query === 'object' ? body.query : {};
      const key = cdmsCacheKey(session, endpoint, client, query);
      if (!cdmsDatasetCache.has(key)) await cdmsDataset(session, endpoint, { client, query, force:true });
      const record = valueAtPath(cdmsDatasetCache.get(key)?.payload, body.path);
      const field = String(body.field || '');
      if (!record || !CDMS_SECRET_FIELD.test(field) || !Object.prototype.hasOwnProperty.call(record, field)) {
        return sendJson(res, 404, { ok:false, error:'That credential is no longer available' });
      }
      return sendJson(res, 200, { ok:true, value:String(record[field] ?? '') });
    }
    if (action === 'preferences' && ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
      const key = String(body.key || url.searchParams.get('key') || '');
      const pathname = key ? `/api/preferences/${encodeURIComponent(key)}` : '/api/preferences';
      const result = await cdmsRequest(session, pathname, {
        method:req.method,
        body:['POST', 'PUT'].includes(req.method) ? (body.body || {}) : undefined,
      });
      return sendJson(res, 200, { ok:true, ...redactDatasetPayload(result) });
    }
    if (action === 'whois' && req.method === 'POST') {
      const params = new URLSearchParams({ action:String(body.action || 'check') });
      if (body.domain) params.set('domain', String(body.domain));
      const result = await cdmsRequest(session, `/api/whois?${params}`, { timeoutMs:20000 });
      return sendJson(res, 200, { ok:true, ...redactDatasetPayload(result) });
    }
    if (action === 'health' && req.method === 'GET') {
      return sendJson(res, 200, { ok:true, ...redactDatasetPayload(await cdmsRequest(session, '/api/health')) });
    }
    return sendJson(res, 404, { ok:false, error:'Not found' });
  } catch (error) {
    return sendJson(res, error.status || 502, { ok:false, error:error.message });
  }
}

function authSession(req, res) {
  const session = sessionFor(req);
  sendJson(res, 200, {
    user: publicUser(session?.user),
    provider: 'local',
    authDisabled: false,
    connection: 'live',
  });
}

async function authRoute(req, res, url) {
  const action = url.pathname.slice('/web/auth/'.length);
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
  if (action === 'session' && req.method === 'GET') return authSession(req, res);
  if (action === 'login' && req.method === 'POST') {
    const user = rawUser(body.username);
    if (!user || !verifyPassword(body.password, user)) {
      return sendJson(res, 401, { ok: false, error: 'Incorrect username or password' });
    }
    const token = createSession(user.username);
    return sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'register' && req.method === 'POST') {
    const username = normalizeUsername(body.username);
    if (!username) return sendJson(res, 400, { ok: false, error: 'Username is required' });
    if (!body.password) return sendJson(res, 400, { ok: false, error: 'Password is required' });
    const store = seedUsers();
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { ok: false, error: 'That username is already taken' });
    }
    const user = {
      username,
      isAdmin: false,
      permissions: { canManageUsers: false },
      visibleCompanies: [],
      mustChangePassword: false,
      ...hashPassword(body.password),
    };
    store.users.push(user);
    writeUsers(store);
    const token = createSession(user.username);
    return sendJson(res, 201, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(token) });
  }
  if (action === 'logout' && req.method === 'POST') {
    const session = sessionFor(req);
    if (session) sessions.delete(session.token);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  const session = requireSession(req, res);
  if (!session) return;
  if (action === 'set-password' && req.method === 'POST') {
    if (!body.password) return sendJson(res, 400, { ok: false, error: 'Password is required' });
    const store = seedUsers();
    const user = store.users.find((item) => item.username.toLowerCase() === session.username.toLowerCase());
    Object.assign(user, hashPassword(body.password));
    user.mustChangePassword = false;
    writeUsers(store);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }
  if (!canManage(session)) return sendJson(res, 403, { ok: false, error: 'Admin access is required' });
  if (action === 'users' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, users: seedUsers().users.map(publicUser) });
  }
  if (action === 'users' && req.method === 'POST') {
    const username = normalizeUsername(body.username);
    if (!username || !body.password) return sendJson(res, 400, { ok: false, error: 'Username and password are required' });
    const store = seedUsers();
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { ok: false, error: 'That username is already taken' });
    }
    store.users.push({
      username,
      isAdmin: false,
      permissions: { canManageUsers: !!body.canManageUsers },
      visibleCompanies: Array.isArray(body.visibleCompanies) ? body.visibleCompanies : [],
      mustChangePassword: true,
      ...hashPassword(body.password),
    });
    writeUsers(store);
    return sendJson(res, 201, { ok: true });
  }
  const userMatch = action.match(/^users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    const username = decodeURIComponent(userMatch[1]);
    const store = seedUsers();
    const user = store.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!user) return sendJson(res, 404, { ok: false, error: 'No such account' });
    if (!user.isAdmin && body.canManageUsers !== undefined) user.permissions = { canManageUsers: !!body.canManageUsers };
    if (!user.isAdmin && Array.isArray(body.visibleCompanies)) user.visibleCompanies = body.visibleCompanies;
    if (body.password) Object.assign(user, hashPassword(body.password));
    writeUsers(store);
    return sendJson(res, 200, { ok: true });
  }
  if (userMatch && req.method === 'DELETE') {
    const username = decodeURIComponent(userMatch[1]);
    if (username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()) {
      return sendJson(res, 400, { ok: false, error: 'The admin account cannot be deleted' });
    }
    const store = seedUsers();
    const originalLength = store.users.length;
    store.users = store.users.filter((item) => item.username.toLowerCase() !== username.toLowerCase());
    if (store.users.length === originalLength) return sendJson(res, 404, { ok: false, error: 'No such account' });
    writeUsers(store);
    for (const [token, item] of sessions) {
      if (item.username.toLowerCase() === username.toLowerCase()) sessions.delete(token);
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function proxyHttp(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return;
  const target = new URL(`${url.pathname}${url.search}`, API_URL);
  const headers = { ...req.headers, host: target.host, 'x-crm-user': session.username };
  for (const name of ['connection', 'cookie', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete headers[name];
  }
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
    duplex: ['GET', 'HEAD'].includes(req.method) ? undefined : 'half',
  });
  const responseHeaders = {};
  for (const [key, value] of upstream.headers) {
    if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  }
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function health(req, res) {
  try {
    const upstream = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    const payload = await upstream.json();
    if (!upstream.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${upstream.status}`);
    sendJson(res, 200, { ok: true, status: 'live', api: payload.status || 'live' });
  } catch (error) {
    sendJson(res, 503, { ok: false, status: 'degraded', error: error.message });
  }
}

function serveStatic(req, res, url) {
  const rawPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(DASHBOARD_DIR, `.${rawPath}`);
  if (filePath !== DASHBOARD_DIR && !filePath.startsWith(`${DASHBOARD_DIR}${path.sep}`)) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return sendJson(res, 404, { ok: false, error: 'Not found' });
    const headers = {
      'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'cache-control': filePath.endsWith('index.html') || filePath.endsWith('web-bridge.js')
        ? 'no-cache'
        : 'public, max-age=3600',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') return health(req, res);
    if (url.pathname.startsWith('/web/auth/')) return authRoute(req, res, url);
    if (url.pathname.startsWith('/web/cdms/')) return cdmsRoute(req, res, url);
    if (url.pathname.startsWith('/api/')) return proxyHttp(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return serveStatic(req, res, url);
  })().catch((error) => {
    console.error('[crm-web]', error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error' });
    else res.destroy();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/api/changes' || !sessionFor(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (browserSocket) => {
    const upstreamUrl = `${API_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/api/changes`;
    const upstreamSocket = new WebSocket(upstreamUrl);
    browserSocket.on('message', (message) => {
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(message);
    });
    upstreamSocket.on('message', (message) => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(message);
    });
    browserSocket.on('close', () => upstreamSocket.close());
    upstreamSocket.on('close', () => browserSocket.close());
    browserSocket.on('error', () => upstreamSocket.close());
    upstreamSocket.on('error', () => browserSocket.close());
  });
});

seedUsers();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`CRM web dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`CRM API upstream: ${API_URL}`);
});
