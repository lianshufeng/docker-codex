// Run after starting docker-compose.yaml; uses no model credentials.
import mqtt from 'mqtt';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

const instance = process.env.CODEX_INSTANCE_ID || 'default';
const base = `codex/${instance}`;
const compose = ['compose', '-f', 'docker-compose.yaml'];
const events = [];
let state;
const client = await mqtt.connectAsync(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883', {
  protocolVersion: 5, username: instance, password: process.env.MQTT_PASSWORD, reconnectPeriod: 500,
});
client.on('error', error => console.error('MQTT:', error.message));
client.on('message', (topic, bytes) => {
  const message = JSON.parse(bytes);
  if (topic.endsWith('/status')) state = message;
  else events.push(message);
});
client.on('connect', () => client.subscribe([`${base}/out`, `${base}/status`], { qos: 1 }));
await client.subscribeAsync([`${base}/out`, `${base}/status`], { qos: 1 });
async function until(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Timed out waiting for expected response');
}
function command(payload, overrides = {}) {
  return { messageId: randomUUID(), runId: state.runId, expiresAt: Date.now() + 30000, payload, ...overrides };
}
function publish(data, options = {}) {
  return client.publishAsync(`${base}/in`, typeof data === 'string' ? data : JSON.stringify(data), { qos: 1, retain: false, ...options });
}
async function rpc(id, method, params = {}) {
  await publish(command({ id, method, params }));
  const event = await until(() => events.find(event => event.type === 'rpc' && event.payload.id === id));
  assert.equal(event.payload.error, undefined, JSON.stringify(event));
  return event.payload.result;
}
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
try {
  await until(() => state?.state === 'ready');
  assert.ok(Array.isArray((await rpc(1, 'thread/list', { limit: 1 })).data));
  console.log('PASS real app-server initialization + RPC');
  const invalidCases = [
    ['{', 'invalid_json'],
    [command({ method: 'thread/list' }, { expiresAt: Date.now() - 1 }), 'invalid_expiry'],
    [command({ method: 'thread/list' }, { runId: 'old' }), 'run_id_mismatch'],
    [command({ method: 'initialize' }), 'initialization_owned_by_bridge'],
  ];
  for (const [input, code] of invalidCases) {
    await publish(input);
    await until(() => events.find(event => event.type === 'bridgeError' && event.payload.code === code));
  }
  await publish(command({ method: 'thread/list' }), { retain: true });
  await until(() => events.find(event => event.payload.code === 'retained_command_rejected'));
  await publish('', { retain: true }); // Clear the test retained message.
  assert.ok(Array.isArray((await rpc(2, 'thread/list')).data));
  console.log('PASS malformed / expired / stale / retained input does not crash bridge');
  const duplicate = command({ id: 3, method: 'thread/list', params: {} });
  await publish(duplicate); await publish(duplicate);
  await until(() => events.find(event => event.payload.id === 3));
  await delay(500);
  assert.equal(events.filter(event => event.payload.id === 3).length, 1);
  console.log('PASS duplicate command executes once');
  const previousRun = state.runId;
  const container = docker(...compose, 'ps', '-q', 'codex-app-server');
  docker('exec', container, 'python', '-c', 'import os,pathlib; targets=[int(p.name) for p in pathlib.Path("/proc").iterdir() if p.name.isdigit() and p.joinpath("comm").read_text().strip()=="codex"]; assert targets; [os.kill(pid,9) for pid in targets]');
  await until(() => state?.state === 'ready' && state.runId !== previousRun);
  await rpc(4, 'thread/list');
  console.log('PASS child crash restarts with new runId');
  const restartedAt = Date.now();
  state = undefined;
  docker(...compose, 'restart', 'mqtt');
  await until(() => client.connected && state?.state === 'ready' && state.time >= restartedAt);
  await rpc(5, 'thread/list');
  console.log('PASS broker restart reconnects');
  await assert.rejects(client.publishAsync('codex/another-instance/in', '{}', { qos: 1 }));
  console.log('PASS ACL rejects cross-instance publish');
  console.log('ALL SMOKE TESTS PASSED');
} finally {
  await client.endAsync(true);
}
