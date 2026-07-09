// harness.js — pg-mem-backed real API server + static dashboard server.
//
// Runs the ACTUAL server (server/index.js) against an in-memory Postgres, then
// serves dashboard/ as a plain website with two rewrites to index.html:
//   1. CSP connect-src gains the API origin (http + ws) so the shim can talk
//      to the real REST/WebSocket API.
//   2. shim.js (the browser preload reproduction) is injected BEFORE app.js.
// Nothing under dashboard/ is modified on disk — the rewrite happens per
// request. Seeds the Rosa dataset unless CRM_SEED=0.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { installPgMem } = require('./pg-mem-adapter.js');
const { seed } = require('./seed.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DASHBOARD_ROOT = path.join(REPO_ROOT, 'dashboard');
const API_PORT = Number(process.env.CRM_API_PORT || 3899);
const STATIC_PORT = Number(process.env.CRM_STATIC_PORT || 3898);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function rewriteIndexHtml(html, apiUrl) {
  const wsUrl = apiUrl.replace(/^http/, 'ws');
  const rewritten = html
    .replace(/connect-src ([^;]*);/, `connect-src $1 ${apiUrl} ${wsUrl};`)
    .replace(
      /(\s*)<script type="module" src="\.\/app\/static\/app\.js"><\/script>/,
      `$1<script>window.__CRM_API_URL__ = ${JSON.stringify(apiUrl)};</script>` +
      `$1<script src="./__visual__/shim.js"></script>` +
      `$1<script type="module" src="./app/static/app.js"></script>`,
    );
  if (!rewritten.includes('__visual__/shim.js')) throw new Error('index.html rewrite failed: app.js script tag not found');
  return rewritten;
}

function startStaticServer({ apiUrl, port = STATIC_PORT } = {}) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';

      if (pathname === '/__visual__/shim.js') {
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
        res.end(fs.readFileSync(path.join(__dirname, 'shim.js')));
        return;
      }

      const filePath = path.join(DASHBOARD_ROOT, pathname);
      if (!filePath.startsWith(DASHBOARD_ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      let body = fs.readFileSync(filePath);
      if (pathname === '/index.html') body = Buffer.from(rewriteIndexHtml(body.toString('utf8'), apiUrl));
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err && err.message || err));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function waitForApi(apiUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${apiUrl}/api/health`);
      if ((await res.json()).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('API server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Starts everything in-process. Returns URLs + a stop() the caller may ignore
// in CLI mode (Ctrl+C kills the process).
async function start({ seedData = process.env.CRM_SEED !== '0' } = {}) {
  installPgMem();
  process.env.PORT = String(API_PORT);
  const apiUrl = `http://127.0.0.1:${API_PORT}`;
  require(path.join(REPO_ROOT, 'server', 'index.js'));
  await waitForApi(apiUrl);
  if (seedData) {
    const counts = await seed(apiUrl);
    console.log('[harness] seeded', counts);
  }
  const staticServer = await startStaticServer({ apiUrl });
  const staticUrl = `http://127.0.0.1:${STATIC_PORT}/`;
  console.log(`[harness] dashboard at ${staticUrl} (API ${apiUrl})`);
  return { apiUrl, staticUrl, stop: () => staticServer.close() };
}

module.exports = { start, rewriteIndexHtml };

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}
