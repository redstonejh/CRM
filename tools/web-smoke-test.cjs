'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket, WebSocketServer } = require('ws');

const API_PORT = 43989;
const WEB_PORT = 43990;
const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-web-smoke-'));
let child;
let apiServer;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, payload: await response.json() };
}

function websocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    const timer = setTimeout(() => reject(new Error('WebSocket smoke test timed out')), 5000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve({ socket, payload: JSON.parse(String(data)) });
    });
    socket.once('error', reject);
  });
}

async function main() {
  apiServer = http.createServer(async (req, res) => {
    const body = JSON.stringify(
      req.url === '/api/health'
        ? { ok: true, status: 'live' }
        : { ok: true, records: [{ id: 'web-smoke', entityType: 'companies', name: 'Web Smoke' }] },
    );
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const apiWss = new WebSocketServer({ noServer: true });
  apiWss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'hello', entities: ['companies'] })));
  apiServer.on('upgrade', (req, socket, head) => {
    apiWss.handleUpgrade(req, socket, head, (ws) => apiWss.emit('connection', ws, req));
  });
  await listen(apiServer, API_PORT);

  child = spawn(process.execPath, ['status-monitor-web/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CRM_WEB_PORT: String(WEB_PORT),
      CRM_API_URL: `http://127.0.0.1:${API_PORT}`,
      CRM_WEB_DATA_DIR: dataDir,
      CRM_ADMIN_USERNAME: 'smoke-admin',
      CRM_ADMIN_PASSWORD: 'smoke-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErrors = '';
  child.stderr.on('data', (chunk) => { childErrors += chunk; });
  child.once('exit', (code) => {
    if (code && code !== 0) childErrors += `web server exited with ${code}`;
  });

  const base = `http://127.0.0.1:${WEB_PORT}`;
  const health = await waitFor(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, status: 'live', api: 'live' });

  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /web-bridge\.js/);
  assert.match(index, /<title>CRM<\/title>/);

  const unauthenticated = await json(`${base}/api/entities/companies`);
  assert.equal(unauthenticated.response.status, 401);

  const badLogin = await json(`${base}/web/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-admin', password: 'wrong' }),
  });
  assert.equal(badLogin.response.status, 401);

  const login = await json(`${base}/web/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-admin', password: 'smoke-password' }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.user.username, 'smoke-admin');
  const cookie = login.response.headers.get('set-cookie').split(';', 1)[0];

  const session = await json(`${base}/web/auth/session`, { headers: { cookie } });
  assert.equal(session.payload.user.username, 'smoke-admin');

  const proxied = await json(`${base}/api/entities/companies`, { headers: { cookie } });
  assert.equal(proxied.response.status, 200);
  assert.equal(proxied.payload.records[0].id, 'web-smoke');

  const ws = await websocket(`ws://127.0.0.1:${WEB_PORT}/api/changes`, cookie);
  assert.equal(ws.payload.type, 'hello');
  ws.socket.close();

  const users = await json(`${base}/web/auth/users`, { headers: { cookie } });
  assert.equal(users.response.status, 200);
  assert.equal(users.payload.users[0].username, 'smoke-admin');

  const monitor = await json(`${base}/web/monitor/status`, { headers: { cookie } });
  assert.equal(monitor.response.status, 200);
  assert.equal(monitor.payload.provider, 'original-mqtt');
  assert.ok(Array.isArray(monitor.payload.topics));
  assert.ok(monitor.payload.topics.includes('+/+/checks/+'));

  if (childErrors) throw new Error(childErrors);
  console.log('Web smoke: health, auth, protected proxies, original MQTT status, users, and WebSocket proxy passed.');
}

main().finally(async () => {
  if (child && !child.killed) child.kill();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
