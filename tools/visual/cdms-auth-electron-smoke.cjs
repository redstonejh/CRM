'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { start } = require('./harness.js');

const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(__dirname, 'shots', 'cdms-auth');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function hasSession(request, sessionToken) {
  return String(request.headers.cookie || '')
    .split(';')
    .map((entry) => entry.trim())
    .includes(`session=${sessionToken}`);
}

async function startMockCdms() {
  const sessionToken = `mock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const calls = {
    config: 0,
    sessionChecks: 0,
    loginAttempts: [],
    logout: 0,
    logoutAuthenticated: false,
    clients: 0,
    profiles: 0,
    authenticatedDataRequests: 0,
    unexpectedPaths: [],
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === 'GET' && url.pathname === '/api/config') {
        calls.config += 1;
        sendJson(response, 200, {
          authDisabled: false,
          appName: 'Mock CDMS',
          version: '1.1.2',
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        calls.sessionChecks += 1;
        if (!hasSession(request, sessionToken)) {
          sendJson(response, 401, { error: 'Not authenticated' });
          return;
        }
        sendJson(response, 200, {
          user: {
            id: 'mock-user-1',
            username: 'operator',
            email: 'operator@example.test',
            role: 'user',
          },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(request);
        const valid = body.username === 'operator' && body.password === 'valid-password';
        calls.loginAttempts.push({ username: String(body.username || ''), valid });
        if (!valid) {
          sendJson(response, 401, { error: 'Invalid username or password' });
          return;
        }
        sendJson(response, 200, {
          success: true,
          user: {
            id: 'mock-user-1',
            username: 'operator',
            email: 'operator@example.test',
            role: 'user',
          },
        }, {
          'set-cookie': `session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax`,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        calls.logout += 1;
        calls.logoutAuthenticated = hasSession(request, sessionToken);
        sendJson(response, 200, { success: true }, {
          'set-cookie': 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/data/clients') {
        calls.clients += 1;
        if (!hasSession(request, sessionToken)) {
          sendJson(response, 401, { error: 'Not authenticated' });
          return;
        }
        calls.authenticatedDataRequests += 1;
        sendJson(response, 200, {
          clients: [{
            value: 'REAL',
            label: 'Real Company (REAL)',
            group: 'Managed',
          }],
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/data/workstations-users') {
        calls.profiles += 1;
        if (!hasSession(request, sessionToken)) {
          sendJson(response, 401, { error: 'Not authenticated' });
          return;
        }
        calls.authenticatedDataRequests += 1;
        sendJson(response, 200, {
          data: [{
            computerName: 'REAL-WS-01',
            ipAddress: '10.20.30.40',
            serviceTag: 'MOCK-SERVICE-TAG',
            location: 'Main office',
            Password: 'never-cross-renderer',
            users: [{
              name: 'Actual Operator',
              login: 'actual.operator',
              email: 'actual.operator@example.test',
              phone: '555-0100',
              recoveryToken: 'also-never-cross-renderer',
            }],
          }],
        });
        return;
      }

      calls.unexpectedPaths.push(`${request.method} ${url.pathname}`);
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  const port = await listen(server);
  return {
    server,
    calls,
    sessionToken,
    url: `http://127.0.0.1:${port}`,
  };
}

function forbiddenKeyPaths(value, prefix = 'root', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeyPaths(item, `${prefix}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    if (key !== 'mustChangePassword'
      && (/(password|passwd|passcode|secret|token|private[\s_-]*key|recovery[\s_-]*code|mfa|otp)/i.test(key)
        || /^notes?(?:\s*\d+)?$/i.test(key))) {
      output.push(`${prefix}.${key}`);
    }
    forbiddenKeyPaths(item, `${prefix}.${key}`, output);
  });
  return output;
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  const mock = await startMockCdms();
  const apiPort = await availablePort();
  let staticPort = await availablePort();
  while (staticPort === apiPort) staticPort = await availablePort();
  const harness = await start({ apiPort, staticPort });
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      CRM_API_URL: harness.apiUrl,
      CRM_CDMS_URL: mock.url,
      CRM_CDMS_DISABLED: '0',
    },
    timeout: 30_000,
  });
  const pageErrors = [];

  try {
    const page = await app.firstWindow({ timeout: 30_000 });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForLoadState('load');
    await page.waitForFunction(() => (
      document.body.classList.contains('auth-gated')
      && document.querySelector('.auth-sub')?.textContent === 'Sign in with your CDMS account'
    ), null, { timeout: 30_000 });

    const initialGate = await page.evaluate(() => ({
      providerText: document.querySelector('.auth-sub')?.textContent,
      createAccountHidden: document.querySelector('.auth-switch')?.hidden,
      profileHidden: getComputedStyle(document.querySelector('.auth-profile-cluster')).display === 'none',
    }));
    assert.equal(initialGate.providerText, 'Sign in with your CDMS account');
    assert.equal(initialGate.createAccountHidden, true);
    assert.equal(initialGate.profileHidden, true);
    await page.screenshot({ path: path.join(outDir, '01-cdms-sign-in.png') });

    await page.fill('.auth-card input[name="username"]', 'operator');
    await page.fill('.auth-card input[name="password"]', 'wrong-password');
    await page.click('.auth-card .auth-submit');
    await page.waitForFunction(() => {
      const error = document.querySelector('.auth-card .auth-error');
      return error && !error.hidden && /Incorrect CDMS username or password/.test(error.textContent || '');
    }, null, { timeout: 15_000 });

    const rejectedText = await page.textContent('.auth-card .auth-error');
    assert.match(rejectedText, /Incorrect CDMS username or password/);

    await page.fill('.auth-card input[name="username"]', 'operator');
    await page.fill('.auth-card input[name="password"]', 'valid-password');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }),
      page.click('.auth-card .auth-submit'),
    ]);
    await page.waitForFunction(async () => {
      const session = await window.auth?.session?.();
      return session?.provider === 'cdms' && session?.user?.username === 'operator';
    }, null, { timeout: 30_000 });
    await page.waitForFunction(() => (
      !!window.crmCdms
      && !!window.crmWorkspaces
      && document.querySelector('.auth-profile-name')?.textContent === 'operator'
      && getComputedStyle(document.querySelector('.auth-profile-cluster')).display === 'block'
    ), null, { timeout: 15_000 });
    await page.waitForFunction(async () => {
      const status = await window.crmCdms.status();
      return status.connection === 'live'
        && status.companies === 1
        && status.contacts === 1
        && status.assets === 1;
    }, null, { timeout: 30_000 });

    const authenticated = await page.evaluate(async () => {
      const [session, status, catalog] = await Promise.all([
        window.auth.session(),
        window.crmCdms.status(),
        window.crmCdms.catalog(),
      ]);
      const profile = document.querySelector('.auth-profile-button');
      return {
        session: {
          provider: session.provider,
          authDisabled: session.authDisabled,
          username: session.user?.username,
          role: session.user?.role,
        },
        counts: {
          companies: status.companies,
          contacts: status.contacts,
          assets: status.assets,
        },
        catalog,
        manageAccountsHidden: document.querySelector('.auth-manage')?.hidden,
        signOutHidden: document.querySelector('.auth-signout')?.hidden,
        profileVisible: profile ? getComputedStyle(profile).display !== 'none' : false,
        secretSentinelVisible: document.documentElement.innerHTML.includes('never-cross-renderer'),
        rendererCookie: document.cookie,
      };
    });

    assert.deepEqual(authenticated.session, {
      provider: 'cdms',
      authDisabled: false,
      username: 'operator',
      role: 'user',
    });
    assert.deepEqual(authenticated.counts, { companies: 1, contacts: 1, assets: 1 });
    assert.deepEqual(forbiddenKeyPaths(authenticated.catalog), []);
    assert.equal(authenticated.manageAccountsHidden, true);
    assert.equal(authenticated.signOutHidden, false);
    assert.equal(authenticated.profileVisible, true);
    assert.equal(authenticated.secretSentinelVisible, false);
    assert.equal(authenticated.rendererCookie.includes(mock.sessionToken), false);

    const cookieDuringSession = await app.evaluate(({ session }, sourceUrl) => (
      session.defaultSession.cookies.get({ url: sourceUrl })
    ), mock.url);
    const sessionCookie = cookieDuringSession.find((cookie) => cookie.name === 'session');
    assert.ok(sessionCookie, 'Electron did not retain the CDMS session cookie');
    assert.equal(sessionCookie.value, mock.sessionToken);
    assert.equal(sessionCookie.httpOnly, true);
    await page.screenshot({ path: path.join(outDir, '02-authenticated-crm.png') });

    await page.click('.auth-profile-button');
    await page.waitForSelector('.auth-profile-cluster.open .auth-signout', { state: 'visible' });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }),
      page.click('.auth-signout'),
    ]);
    await page.waitForFunction(() => (
      document.body.classList.contains('auth-gated')
      && document.querySelector('.auth-sub')?.textContent === 'Sign in with your CDMS account'
    ), null, { timeout: 30_000 });

    const loggedOut = await page.evaluate(async () => {
      const [session, status] = await Promise.all([
        window.auth.session(),
        window.crmCdms.status(),
      ]);
      return {
        provider: session.provider,
        user: session.user,
        companies: status.companies,
        contacts: status.contacts,
        assets: status.assets,
      };
    });
    assert.equal(loggedOut.provider, 'cdms');
    assert.equal(loggedOut.user, null);
    assert.deepEqual(
      { companies: loggedOut.companies, contacts: loggedOut.contacts, assets: loggedOut.assets },
      { companies: 0, contacts: 0, assets: 0 },
    );

    const cookiesAfterLogout = await app.evaluate(({ session }, sourceUrl) => (
      session.defaultSession.cookies.get({ url: sourceUrl })
    ), mock.url);
    assert.equal(cookiesAfterLogout.some((cookie) => cookie.name === 'session'), false);
    assert.equal(mock.calls.config, 1);
    assert.equal(mock.calls.sessionChecks, 1);
    assert.deepEqual(mock.calls.loginAttempts, [
      { username: 'operator', valid: false },
      { username: 'operator', valid: true },
    ]);
    assert.equal(mock.calls.logout, 1);
    assert.equal(mock.calls.logoutAuthenticated, true);
    assert.equal(mock.calls.clients, 1);
    assert.equal(mock.calls.profiles, 1);
    assert.equal(mock.calls.authenticatedDataRequests, 2);
    assert.deepEqual(mock.calls.unexpectedPaths, []);
    assert.deepEqual(pageErrors, []);

    return {
      gate: initialGate,
      rejectedLogin: true,
      session: authenticated.session,
      counts: authenticated.counts,
      httpOnlyCookie: sessionCookie.httpOnly,
      rendererSecretFields: forbiddenKeyPaths(authenticated.catalog).length,
      logoutClearedCookie: true,
      authenticatedDataRequests: mock.calls.authenticatedDataRequests,
      pageErrors,
    };
  } finally {
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.exit(0));
      return true;
    }).catch(() => {});
    await Promise.race([app.close().catch(() => {}), wait(3_000)]);
    harness.stop();
    await close(mock.server);
  }
}

const watchdog = setTimeout(() => {
  console.error('[cdms-auth-electron-smoke] timed out');
  process.exit(2);
}, 90_000);

run().then((evidence) => {
  clearTimeout(watchdog);
  console.log('[cdms-auth-electron-smoke]', JSON.stringify(evidence));
  process.exit(0);
}, (error) => {
  clearTimeout(watchdog);
  console.error('[cdms-auth-electron-smoke]', error.stack || error.message || error);
  process.exit(1);
});
