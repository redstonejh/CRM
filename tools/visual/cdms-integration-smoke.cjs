'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {
  createCdmsClient,
  sanitizeProfileRow,
} = require(path.resolve(__dirname, '..', '..', 'electron', 'cdms-client.cjs'));

const LIVE_URL = process.env.CRM_CDMS_URL || 'http://192.168.203.238:6030';
const secretKey = /(password|passwd|passcode|(?:^|[\s_-])(?:pass|pw)(?:$|[\s_-])|secret|token|private[\s_-]*key|recovery[\s_-]*code|one[\s_-]*time|otp)/i;

function forbiddenPaths(value, prefix = 'root', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenPaths(item, `${prefix}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    if ((key !== 'mustChangePassword' && secretKey.test(key)) || /^notes?(?:\s*\d+)?$/i.test(key)) output.push(`${prefix}.${key}`);
    forbiddenPaths(item, `${prefix}.${key}`, output);
  });
  return output;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function mockAuthenticatedContract() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const signedIn = /\bsession=mock-session\b/.test(req.headers.cookie || '');
    if (url.pathname === '/api/config') return json(res, 200, { authDisabled: false, appName: 'Mock CDMS', version: '1.1.2' });
    if (url.pathname === '/api/auth/me') {
      return signedIn
        ? json(res, 200, { user: { id: 'user-1', username: 'operator', role: 'user' } })
        : json(res, 401, { error: 'Not authenticated' });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      return json(res, 200, {
        success: true,
        user: { id: 'user-1', username: 'operator', role: 'user' },
      }, { 'set-cookie': 'session=mock-session; HttpOnly; Path=/; SameSite=Lax' });
    }
    if (url.pathname === '/api/auth/logout') {
      return json(res, 200, { success: true }, { 'set-cookie': 'session=; Max-Age=0; HttpOnly; Path=/' });
    }
    if (!signedIn) return json(res, 401, { error: 'Not authenticated' });
    if (url.pathname === '/api/data/clients') {
      return json(res, 200, { clients: [{ value: 'REAL', label: 'Real Company (REAL)', group: 'Managed' }] });
    }
    if (url.pathname === '/api/data/workstations-users') {
      return json(res, 200, {
        data: [{
          fullName: 'Actual Person',
          username: 'aperson',
          email: 'person@example.test',
          computerName: 'WS-01',
          ipAddress: '10.0.0.25',
          Password: 'must-never-cross',
        }],
      });
    }
    return json(res, 200, { data: [] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  let cookie = '';
  const cookieFetcher = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    return response;
  };
  try {
    const client = createCdmsClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      fetcher: cookieFetcher,
    });
    const initial = await client.initialize();
    assert.equal(initial.connection, 'live');
    assert.equal(initial.user, null);
    const login = await client.login('operator', 'valid-password');
    assert.equal(login.ok, true);
    assert.equal(login.user.username, 'operator');
    assert.equal(client.records('companies').length, 1);
    assert.equal(client.records('contacts').length, 1);
    assert.equal(client.records('assets').length, 1);
    assert.deepEqual(forbiddenPaths(client.catalog()), []);
    const logout = await client.logout();
    assert.equal(logout.ok, true);
    assert.equal(client.records('contacts').length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function liveContract() {
  const client = createCdmsClient({ baseUrl: LIVE_URL });
  const status = await client.initialize();
  assert.equal(status.connection, 'live', status.error || 'CDMS must be reachable');
  assert.ok(status.companies > 0, 'CDMS must return companies');
  assert.ok(status.contacts > 0, 'CDMS must return people');
  assert.ok(status.assets > 0, 'CDMS must return devices');
  assert.deepEqual(forbiddenPaths(client.catalog()), []);
  const reportSeeds = Array.from({ length: Math.min(160, status.contacts) }, (_, index) => `fixture-contact-${index + 1}`);
  const reportReferences = client.referencesFor('contacts', reportSeeds);
  assert.equal(reportReferences.size, reportSeeds.length);
  assert.equal(new Set([...reportReferences.values()].map((record) => record.id)).size, reportSeeds.length);

  const ticket = client.decorateRecord('tickets', {
    id: 'tkt_demo_cdms_contract',
    title: 'Connectivity investigation',
    companyId: 'co_demo',
    companyLabel: 'Demonstration Company',
    host: 'fake.demo.local',
  });
  assert.ok(String(ticket.companyId).startsWith('cdms-company-'));
  assert.ok(ticket.cdmsReference);
  assert.ok(ticket.cdmsAssetId);
  assert.notEqual(ticket.host, 'fake.demo.local');
  assert.ok(ticket.ipAddress);

  const project = client.decorateRecord('projects', {
    id: 'proj_demo_cdms_contract',
    title: 'Demonstration Company Upgrade',
    ownerContactId: 'ct_demo',
  });
  assert.ok(String(project.ownerContactId).startsWith('cdms-contact-'));
  assert.ok(project.owner);
  assert.ok(project.title);

  const firstCompany = client.records('companies')[0];
  const profile = await client.companyProfile(firstCompany.id);
  assert.equal(profile.ok, true);
  assert.deepEqual(forbiddenPaths(profile), []);
  assert.deepEqual(forbiddenPaths(sanitizeProfileRow({
    Password: 'never',
    Notes: 'password: never',
    Username: 'allowed',
    IP: '10.0.0.1',
  })), []);

  return {
    connection: status.connection,
    authDisabled: status.authDisabled,
    companies: status.companies,
    contacts: status.contacts,
    assets: status.assets,
    partialFailures: status.partialFailures,
    profileSections: profile.summary.sections,
    profileRecords: profile.summary.records,
    uniqueReportReferences: reportReferences.size,
    secretsExposed: 0,
    workflowReferences: {
      ticketCompany: !!ticket.cdmsCompanyId,
      ticketAsset: !!ticket.cdmsAssetId,
      ticketIp: !!ticket.ipAddress,
      projectOwner: !!project.ownerContactId,
    },
  };
}

(async () => {
  await mockAuthenticatedContract();
  const live = await liveContract();
  process.stdout.write(`${JSON.stringify({ ok: true, authenticatedContract: true, live }, null, 2)}\n`);
})().catch((error) => {
  console.error('[cdms-integration-smoke]', error.stack || error.message || error);
  process.exitCode = 1;
});
