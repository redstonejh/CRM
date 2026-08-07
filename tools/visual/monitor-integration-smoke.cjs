'use strict';

const assert = require('node:assert/strict');
const {
  MQTT_TOPICS,
  createMonitorClient,
  matchesClient,
  normalizeCheck,
} = require('../../electron/monitor-client.cjs');

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

(async () => {
  const normalized = normalizeCheck(
    'project/system/checks/router',
    {
      id:'router',
      label:'Grayson Router',
      host:'192.0.2.1',
      available:true,
      latencyMs:7,
      packetLoss:0,
      checkedAt:new Date().toISOString(),
      password:'must-not-cross',
    },
  );
  assert.equal(normalized.password, undefined);
  assert.equal(matchesClient(normalized, { code:'GLC', label:'Grayson Lumber Company' }), true);
  assert.equal(matchesClient(normalized, { code:'VANCE', label:'Vance' }), false);

  const client = createMonitorClient({
    apiUrl:process.env.CRM_MONITOR_API_URL || 'http://24.121.212.206:3847',
    mqttHost:process.env.CRM_MONITOR_MQTT_HOST || '24.121.212.206',
    mqttPort:Number(process.env.CRM_MONITOR_MQTT_PORT) || 1883,
  });
  await client.start();
  const live = await waitFor(() => {
    const current = client.snapshot();
    return current.status.connection === 'live' && current.totals.total > 0 ? current : null;
  });
  assert.ok(live, 'Original MQTT broker did not yield retained monitoring checks');
  assert.deepEqual(client.topics(), [...MQTT_TOPICS]);
  assert.equal(live.status.provider, 'original-mqtt');
  assert.ok(live.totals.agents > 0);
  assert.ok(live.checks.every((record) => (
    !Object.keys(record).some((key) => /password|secret|token/i.test(key))
  )));

  const scoped = client.snapshot({
    client:{ code:'GLC', label:'Grayson Lumber Company' },
  });
  assert.ok(scoped.totals.total > 0);
  assert.ok(scoped.totals.total < live.totals.total);
  const history = client.history({ limit:25 });
  assert.ok(history.results.length > 0);
  client.stop();

  console.log(JSON.stringify({
    ok:true,
    provider:live.status.provider,
    connection:live.status.connection,
    topics:client.topics(),
    totals:live.totals,
    grayson:scoped.totals,
    history:history.results.length,
    restFallback:live.status.restError || null,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
