'use strict';

// Read-only frontend client for the original status-monitor MQTT/REST backend.
// It deliberately understands the original retained topic tree:
//   <project>/<system>/status
//   <project>/<system>/checks/<check>
//   connections/<subject>/<project>/<system>/<check>
//   <project>/<system>/heartbeat
// No state is written back to the monitoring service or broker.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MONITOR_API_URL = process.env.CRM_MONITOR_API_URL
  || process.env.MONITOR_API_URL
  || 'http://24.121.212.206:3847';
const DEFAULT_MONITOR_MQTT_HOST = process.env.CRM_MONITOR_MQTT_HOST
  || process.env.MONITOR_MQTT_HOST
  || '24.121.212.206';
const DEFAULT_MONITOR_MQTT_PORT = Number(
  process.env.CRM_MONITOR_MQTT_PORT || process.env.MONITOR_MQTT_PORT || 1883,
);
const MQTT_TOPICS = Object.freeze([
  '+/+/status',
  '+/+/checks/+',
  'connections/#',
  '+/+/heartbeat',
]);
const HISTORY_LIMIT = 5000;
const BASE_STALE_MS = 5 * 60 * 1000;
const REPORT_STALE_MS = 35 * 60 * 1000;
const CLIENT_STOP_WORDS = new Set([
  'and', 'the', 'company', 'inc', 'llc', 'ltd', 'corp', 'corporation',
  'group', 'services', 'service', 'office',
]);

const text = (value) => String(value ?? '').trim();
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const timestamp = (value, fallback = Date.now()) => {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(fallback).toISOString();
};
const clone = (value) => value == null
  ? value
  : (typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)));
const severityOf = (payload = {}) => {
  const explicit = text(payload.status).toLowerCase();
  if (['red', 'down', 'critical', 'failed', 'error'].includes(explicit)) return 'red';
  if (['yellow', 'amber', 'warning', 'degraded'].includes(explicit)) return 'yellow';
  if (['green', 'good', 'ok', 'healthy', 'live'].includes(explicit)) return 'green';
  if (payload.available === false) return 'red';
  if (finite(payload.packetLoss) > 0) return 'yellow';
  if (payload.available === true) return 'green';
  return 'grey';
};
const safeIdentifier = (value) => text(value).replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 180);
const mqttUrl = (host, port) => {
  const value = text(host) || DEFAULT_MONITOR_MQTT_HOST;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `mqtt://${value}:${Number(port) || DEFAULT_MONITOR_MQTT_PORT}`;
};
const normalizeApiUrl = (value) => {
  const raw = text(value) || DEFAULT_MONITOR_API_URL;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_MONITOR_API_URL;
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_MONITOR_API_URL;
  }
};
const normalizeConfig = (input = {}, previous = {}) => ({
  apiUrl:normalizeApiUrl(input.apiUrl ?? previous.apiUrl),
  mqttHost:text(input.mqttHost ?? previous.mqttHost) || DEFAULT_MONITOR_MQTT_HOST,
  mqttPort:Math.max(1, Math.min(65535, Number(input.mqttPort ?? previous.mqttPort) || DEFAULT_MONITOR_MQTT_PORT)),
  mqttUsername:text(input.mqttUsername ?? previous.mqttUsername),
  mqttPassword:text(input.mqttPassword ?? previous.mqttPassword),
});

function clientIdentity(client) {
  if (!client) return { code:'', label:'', tokens:[] };
  const source = typeof client === 'string' ? { label:client } : client;
  const code = text(
    source.code || source.value || source.companyCode || source.cdmsClient
      || source.sourceId || source.Abbrv,
  ).toLowerCase();
  const label = text(
    source.label || source.name || source.title || source.company
      || source['Company Name'] || code,
  ).replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
  const tokens = [...new Set(label.split(/[^a-z0-9]+/)
    .map(text)
    .filter((token) => token.length >= 3 && !CLIENT_STOP_WORDS.has(token)))];
  return { code, label, tokens };
}

function matchesClient(record, client) {
  const identity = clientIdentity(client);
  if (!identity.code && !identity.label) return true;
  const subject = [
    record?.subjectId,
    record?.subjectLabel,
    record?.clientCode,
    record?.clientLabel,
  ].map((value) => text(value).toLowerCase()).filter(Boolean).join(' ');
  const general = [
    subject,
    record?.id,
    record?.label,
    record?.machine,
  ].map((value) => text(value).toLowerCase()).filter(Boolean).join(' ');
  const haystack = record?.subjectId || record?.subjectLabel ? subject : general;
  if (identity.code && new RegExp(`(^|[^a-z0-9])${identity.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack)) {
    return true;
  }
  if (identity.label && haystack.includes(identity.label)) return true;
  return identity.tokens.some((token) => haystack.includes(token));
}

function normalizeCheck(topic, payload = {}) {
  const parts = text(topic).split('/').filter(Boolean);
  const connection = parts[0] === 'connections';
  const projectId = connection ? text(parts[2]) : text(parts[0]);
  const systemId = connection ? text(parts[3]) : text(parts[1]);
  const topicId = connection ? text(parts[4]) : text(parts[3]);
  const checkedAt = timestamp(payload.checkedAt || payload.lastReceived || payload.publishedAt);
  const available = payload.available === undefined ? null : payload.available !== false;
  const latencyMs = available === false ? null : finite(payload.latencyMs);
  const packetLoss = available === false ? finite(payload.packetLoss) : finite(payload.packetLoss);
  const label = text(payload.label || payload.subjectLabel || payload.id || topicId || 'Monitoring check');
  const detail = [
    text(payload.host),
    available === false ? 'unreachable' : '',
    latencyMs == null ? '' : `${latencyMs} ms`,
    packetLoss > 0 ? `${packetLoss}% loss` : '',
    text(payload.error),
  ].filter(Boolean).join(' · ');
  return {
    topic:text(topic),
    kind:connection ? 'connection' : 'check',
    id:safeIdentifier(payload.id || topicId || topic),
    label,
    machine:label,
    subjectId:text(payload.subjectId || (connection ? parts[1] : '')),
    subjectLabel:text(payload.subjectLabel),
    projectId,
    systemId,
    system:`${projectId}/${systemId}`,
    host:text(payload.host),
    type:text(payload.type),
    available,
    latencyMs,
    packetLoss,
    refreshMinutes:finite(payload.refreshMinutes),
    severity:severityOf(payload),
    detail,
    checkedAt,
    tracked:true,
  };
}

function normalizeReport(topic, payload = {}) {
  const parts = text(topic).split('/').filter(Boolean);
  return {
    topic:text(topic),
    kind:'report',
    id:safeIdentifier(`report-${parts[0] || 'monitor'}-${parts[1] || 'status'}`),
    label:text(payload.stage || 'Report monitor'),
    machine:text(payload.stage || 'Report monitor'),
    subjectId:'',
    subjectLabel:'',
    projectId:text(parts[0]),
    systemId:text(parts[1]),
    system:`${text(parts[0])}/${text(parts[1])}`,
    host:'',
    type:'report',
    available:null,
    latencyMs:null,
    packetLoss:null,
    refreshMinutes:null,
    severity:severityOf(payload),
    detail:text(payload.detail),
    lastSuccess:text(payload.lastSuccess),
    checkedAt:timestamp(payload.checkedAt),
    tracked:true,
  };
}

function normalizeHistoryRecord(record = {}) {
  return {
    topic:text(record.topic),
    kind:text(record.kind || 'check'),
    id:safeIdentifier(record.id || record.topic || 'monitor-event'),
    label:text(record.label || record.machine || record.stage || 'Monitoring event'),
    machine:text(record.machine || record.label || record.stage || 'Monitoring event'),
    subjectId:text(record.subjectId),
    subjectLabel:text(record.subjectLabel),
    projectId:text(record.projectId),
    systemId:text(record.systemId),
    system:text(record.system),
    host:text(record.host),
    type:text(record.type),
    available:record.available === undefined || record.available === null ? null : record.available !== false,
    latencyMs:finite(record.latencyMs),
    packetLoss:finite(record.packetLoss ?? record.packetLossPct),
    severity:severityOf(record),
    detail:text(record.detail),
    lastSuccess:text(record.lastSuccess),
    checkedAt:timestamp(record.checkedAt),
    tracked:record.tracked !== false,
  };
}

function createMonitorClient(options = {}) {
  let mqttLibrary = options.mqttLib || null;
  let fetcher = options.fetcher || globalThis.fetch;
  let onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let historyFile = text(options.historyFile);
  let config = normalizeConfig(options);
  let mqttClient = null;
  let started = false;
  let connection = 'idle';
  let error = '';
  let connectedAt = 0;
  let updatedAt = 0;
  let restCheckedAt = 0;
  let restError = '';
  let notifyTimer = null;
  let persistTimer = null;
  let staleTimer = null;
  let historyLoaded = false;
  const checks = new Map();
  const reports = new Map();
  const agents = new Map();
  let history = [];
  const historyKeys = new Set();

  const publicConfig = () => ({
    apiUrl:config.apiUrl,
    mqttHost:config.mqttHost,
    mqttPort:config.mqttPort,
  });
  const status = () => ({
    ok:connection === 'live',
    provider:'original-mqtt',
    connection,
    error:error || null,
    restError:restError || null,
    connectedAt,
    updatedAt,
    restCheckedAt,
    topics:[...MQTT_TOPICS],
    config:publicConfig(),
  });
  const notify = (reason) => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      try { onChange({ reason, status:status() }); } catch {}
    }, 80);
  };
  const persistNow = () => {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!historyFile) return;
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive:true });
      const temporary = `${historyFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version:1, history:history.slice(-HISTORY_LIMIT) }), 'utf8');
      fs.renameSync(temporary, historyFile);
    } catch {}
  };
  const schedulePersist = () => {
    if (!historyFile) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 300);
  };
  const loadPersistedHistory = () => {
    if (historyLoaded) return;
    historyLoaded = true;
    if (!historyFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      const records = Array.isArray(parsed?.history) ? parsed.history : [];
      history = records.slice(-HISTORY_LIMIT).map(normalizeHistoryRecord);
      history.forEach((record) => historyKeys.add(`${record.topic}|${record.checkedAt}|${record.severity}`));
    } catch {}
  };
  const recordHistory = (record) => {
    const normalized = normalizeHistoryRecord(record);
    const key = `${normalized.topic}|${normalized.checkedAt}|${normalized.severity}`;
    if (historyKeys.has(key)) return false;
    historyKeys.add(key);
    history.push(normalized);
    if (history.length > HISTORY_LIMIT) {
      const removed = history.splice(0, history.length - HISTORY_LIMIT);
      removed.forEach((item) => historyKeys.delete(`${item.topic}|${item.checkedAt}|${item.severity}`));
    }
    schedulePersist();
    return true;
  };
  const touch = (record, target) => {
    const previous = target.get(record.topic);
    target.set(record.topic, record);
    updatedAt = Math.max(updatedAt, Date.parse(record.checkedAt) || Date.now());
    if (!previous || previous.checkedAt !== record.checkedAt || previous.severity !== record.severity) {
      recordHistory(record);
    }
  };
  const handleHeartbeat = (topic, payload = {}) => {
    const parts = text(topic).split('/').filter(Boolean);
    const projectId = text(payload.projectId || parts[0]);
    const systemId = text(payload.systemId || parts[1]);
    const checkedAt = timestamp(payload.publishedAt);
    agents.set(`${projectId}/${systemId}`, {
      id:`${projectId}/${systemId}`,
      projectId,
      systemId,
      checkedAt,
      serverStarted:text(payload.serverStarted),
      checks:Array.isArray(payload.checks) ? payload.checks.length : 0,
      connections:Array.isArray(payload.connectionTests) ? payload.connectionTests.length : 0,
    });
    updatedAt = Math.max(updatedAt, Date.parse(checkedAt) || Date.now());
  };
  const handleMessage = (topic, message) => {
    const raw = Buffer.isBuffer(message) ? message : Buffer.from(message || '');
    if (!raw.length) {
      checks.delete(topic);
      reports.delete(topic);
      updatedAt = Date.now();
      notify('mqtt-tombstone');
      return;
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { return; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (topic.endsWith('/heartbeat')) handleHeartbeat(topic, payload);
    else if (topic.endsWith('/status')) touch(normalizeReport(topic, payload), reports);
    else if (topic.includes('/checks/') || topic.startsWith('connections/')) {
      const check = normalizeCheck(topic, payload);
      touch(check, checks);
      if (check.system) {
        const agent = agents.get(check.system) || {
          id:check.system,
          projectId:check.projectId,
          systemId:check.systemId,
          serverStarted:'',
          checks:0,
          connections:0,
        };
        agent.checkedAt = check.checkedAt;
        agents.set(check.system, agent);
      }
    }
    notify('mqtt-message');
  };
  const disconnectMqtt = () => {
    if (mqttClient) {
      try { mqttClient.removeAllListeners(); mqttClient.end(true); } catch {}
      mqttClient = null;
    }
  };
  const connectMqtt = () => {
    disconnectMqtt();
    if (!started) return;
    try {
      if (!mqttLibrary) mqttLibrary = require('mqtt');
      connection = 'connecting';
      error = '';
      notify('mqtt-connecting');
      const mqttOptions = {
        clean:true,
        reconnectPeriod:15000,
        connectTimeout:8000,
      };
      if (config.mqttUsername) {
        mqttOptions.username = config.mqttUsername;
        mqttOptions.password = config.mqttPassword;
      }
      mqttClient = mqttLibrary.connect(mqttUrl(config.mqttHost, config.mqttPort), mqttOptions);
      mqttClient.on('connect', () => {
        connection = 'live';
        connectedAt = Date.now();
        error = '';
        mqttClient.subscribe([...MQTT_TOPICS], { qos:0 }, (subscribeError) => {
          if (subscribeError) {
            error = subscribeError.message || 'MQTT subscription failed';
            notify('mqtt-subscribe-error');
          }
        });
        notify('mqtt-live');
      });
      mqttClient.on('message', handleMessage);
      mqttClient.on('reconnect', () => {
        connection = 'connecting';
        notify('mqtt-reconnecting');
      });
      mqttClient.on('error', (mqttError) => {
        connection = 'offline';
        error = mqttError?.message || 'MQTT connection failed';
        notify('mqtt-error');
      });
      mqttClient.on('close', () => {
        if (!started) return;
        connection = 'offline';
        notify('mqtt-close');
      });
    } catch (connectError) {
      connection = 'offline';
      error = connectError?.message || 'MQTT client is unavailable';
      notify('mqtt-error');
    }
  };

  const fetchJson = async (pathname, timeoutMs = 6000) => {
    if (typeof fetcher !== 'function') throw new Error('REST transport is unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${config.apiUrl}${pathname}`, {
        headers:{ accept:'application/json' },
        cache:'no-store',
        signal:controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  };
  const refreshRest = async () => {
    const settled = await Promise.allSettled([
      fetchJson('/api/status'),
      fetchJson('/api/history?limit=500'),
      fetchJson('/api/info'),
    ]);
    restCheckedAt = Date.now();
    const failures = settled.filter((result) => result.status === 'rejected');
    restError = failures.length === settled.length
      ? (failures[0]?.reason?.message || 'Monitoring REST API is unavailable')
      : '';
    const current = settled[0].status === 'fulfilled' ? settled[0].value?.current : null;
    if (current) touch(normalizeReport('rest/original/status', current), reports);
    const records = settled[1].status === 'fulfilled' && Array.isArray(settled[1].value?.results)
      ? settled[1].value.results
      : [];
    records.slice().reverse().forEach((record) => recordHistory({
      ...record,
      topic:`rest/history/${record.id || record.checkedAt || 'event'}`,
      kind:'report',
      label:record.stage || 'Report monitor',
    }));
    notify(failures.length ? 'rest-partial' : 'rest-live');
    return {
      ok:failures.length < settled.length,
      error:restError || null,
      status:settled[0].status === 'fulfilled' ? settled[0].value : null,
      info:settled[2].status === 'fulfilled' ? {
        checkCron:text(settled[2].value?.checkCron),
        greenThresholdHours:finite(settled[2].value?.greenThresholdHours),
        mqttWsPort:finite(settled[2].value?.mqttWsPort),
      } : null,
    };
  };

  const liveRecord = (record, now = Date.now()) => {
    const age = now - (Date.parse(record.checkedAt) || 0);
    const refreshMs = Math.max(
      record.kind === 'report' ? REPORT_STALE_MS : BASE_STALE_MS,
      (finite(record.refreshMinutes) || 0) * 3 * 60 * 1000,
    );
    if (age <= refreshMs) return { ...record, stale:false };
    return { ...record, severity:'offline', stale:true };
  };
  const snapshot = (query = {}) => {
    const client = query.client || query;
    const now = Date.now();
    const records = [...checks.values(), ...reports.values()]
      .filter((record) => matchesClient(record, client))
      .map((record) => liveRecord(record, now))
      .sort((left, right) => {
        const weight = { red:0, yellow:1, offline:2, grey:3, green:4 };
        return (weight[left.severity] ?? 3) - (weight[right.severity] ?? 3)
          || left.label.localeCompare(right.label);
      });
    const agentRows = [...agents.values()].map((agent) => ({
      ...agent,
      online:now - (Date.parse(agent.checkedAt) || 0) <= BASE_STALE_MS,
    }));
    const totals = {
      total:records.length,
      good:records.filter((record) => record.severity === 'green').length,
      degraded:records.filter((record) => record.severity === 'yellow').length,
      down:records.filter((record) => record.severity === 'red').length,
      offline:records.filter((record) => ['offline', 'grey'].includes(record.severity)).length,
      agents:agentRows.length,
      agentsOnline:agentRows.filter((agent) => agent.online).length,
    };
    return {
      ok:connection === 'live' || records.length > 0,
      status:status(),
      client:clientIdentity(client),
      totals,
      checks:records,
      agents:agentRows,
      updatedAt,
    };
  };
  const historySnapshot = (query = {}) => {
    const client = query.client || query;
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const results = history
      .filter((record) => matchesClient(record, client))
      .slice()
      .sort((left, right) => (Date.parse(right.checkedAt) || 0) - (Date.parse(left.checkedAt) || 0))
      .slice(0, limit);
    return { ok:true, client:clientIdentity(client), results:clone(results), total:results.length };
  };
  const configure = (next = {}) => {
    const previous = config;
    if (typeof next.fetcher === 'function') fetcher = next.fetcher;
    if (typeof next.onChange === 'function') onChange = next.onChange;
    if (next.historyFile !== undefined) historyFile = text(next.historyFile);
    config = normalizeConfig(next, config);
    const mqttChanged = previous.mqttHost !== config.mqttHost
      || previous.mqttPort !== config.mqttPort
      || previous.mqttUsername !== config.mqttUsername
      || previous.mqttPassword !== config.mqttPassword;
    if (started && mqttChanged) connectMqtt();
    return status();
  };
  const start = async (next = {}) => {
    configure(next);
    if (started) return status();
    started = true;
    loadPersistedHistory();
    connectMqtt();
    clearInterval(staleTimer);
    staleTimer = setInterval(() => notify('stale-tick'), 60000);
    void refreshRest().catch((refreshError) => {
      restCheckedAt = Date.now();
      restError = refreshError?.message || 'Monitoring REST API is unavailable';
      notify('rest-error');
    });
    return status();
  };
  const stop = () => {
    started = false;
    clearTimeout(notifyTimer);
    clearInterval(staleTimer);
    disconnectMqtt();
    persistNow();
    connection = 'idle';
    return status();
  };

  return {
    configure,
    start,
    stop,
    status,
    snapshot,
    history:historySnapshot,
    refresh:refreshRest,
    handleMessage,
    topics:() => [...MQTT_TOPICS],
    _matchesClient:matchesClient,
  };
}

module.exports = {
  BASE_STALE_MS,
  DEFAULT_MONITOR_API_URL,
  DEFAULT_MONITOR_MQTT_HOST,
  DEFAULT_MONITOR_MQTT_PORT,
  MQTT_TOPICS,
  createMonitorClient,
  matchesClient,
  normalizeCheck,
  normalizeReport,
};
