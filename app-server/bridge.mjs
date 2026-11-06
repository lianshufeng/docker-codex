import mqtt from 'mqtt';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCommand, Deduplicator, JsonLines } from './protocol.mjs';

const config = JSON.parse(readFileSync('/run/secrets/mqtt.json', 'utf8'));
const instance = config.username;
if (typeof instance !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(instance)) throw new Error('Invalid MQTT username');
if (typeof config.password !== 'string' || !config.password) throw new Error('MQTT config requires password');
const base = `codex/${instance}`;
const maxBytes = 1024 * 1024;
const maxTtlMs = 60000;
const maxQueueBytes = 8 * maxBytes;
const dedup = new Deduplicator(10000);
let child, runId, ready = false, stopping = false, connected = false;
let restartTimer, initTimer, killTimer, stopTimer;
let queue = [], queueBytes = 0, publishing = false;
const log = (event, details = {}) => console.error(JSON.stringify({ event, ...details }));
const client = mqtt.connect(config.url || 'mqtt://mqtt:1883', {
  protocolVersion: 5, clientId: `codex-${instance}`, username: config.username,
  password: config.password, clean: true, reconnectPeriod: 2000,
  connectTimeout: 10000, queueQoSZero: false, resubscribe: false,
  will: { topic: `${base}/status`, payload: JSON.stringify({ state: 'offline' }), qos: 1, retain: true },
});
function status(state) {
  if (!connected) return;
  client.publish(`${base}/status`, JSON.stringify({ state, runId, time: Date.now() }), { qos: 1, retain: true }, error => {
    if (error) log('status_publish_failed', { message: error.message });
  });
}
function failChild(reason) {
  ready = false;
  log('app_server_failed', { reason });
  status('restarting');
  if (child && !killTimer) {
    const target = child;
    target.kill('SIGTERM');
    killTimer = setTimeout(() => target.kill('SIGKILL'), 3000);
  }
}
function output(type, payload) {
  const entry = { type, runId, eventId: randomUUID(), payload, time: Date.now() };
  const data = JSON.stringify(entry);
  const bytes = Buffer.byteLength(data);
  if (queue.length >= 4096 || queueBytes + bytes > maxQueueBytes) {
    // Never silently drop an event and pretend that the stream is complete.
    shutdown('output_queue_exhausted', 1);
    return;
  }
  queue.push({ data, bytes }); queueBytes += bytes;
  flush();
}
function flush() {
  if (!connected || publishing || !queue.length || stopping) return;
  publishing = true;
  const entry = queue[0];
  client.publish(`${base}/out`, entry.data, { qos: 1, retain: false, properties: { messageExpiryInterval: 60 } }, error => {
    publishing = false;
    if (error) { log('output_publish_failed', { message: error.message }); shutdown('output_publish_failed', 1); return; }
    queue.shift(); queueBytes -= entry.bytes;
    flush();
  });
}
function startChild() {
  if (stopping || child) return;
  runId = randomUUID(); ready = false; status('starting');
  const target = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = target;
  const lines = new JsonLines(maxBytes, message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid_stdout_message');
    if (message?.id === '__bridge_initialize') {
      if (message.error || !message.result) { failChild('initialize_rejected'); return; }
      target.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n', error => {
        if (error || child !== target || stopping) return;
        clearTimeout(initTimer); ready = true; status('ready');
      });
    } else output('rpc', message);
  });
  target.stdout.on('data', chunk => {
    try { lines.push(chunk); } catch (error) { failChild(error.message); }
  });
  target.stderr.on('data', chunk => log('app_server_stderr', { message: chunk.toString('utf8').slice(0, 8192) }));
  target.stdin.on('error', error => failChild(`stdin:${error.code || error.message}`));
  target.on('error', error => log('app_server_spawn_error', { message: error.message }));
  target.on('close', (code, signal) => {
    clearTimeout(initTimer); clearTimeout(killTimer); killTimer = undefined;
    if (child !== target) return;
    child = undefined; ready = false;
    log('app_server_exit', { code, signal });
    if (!stopping) { status('restarting'); restartTimer = setTimeout(startChild, 2000); }
  });
  initTimer = setTimeout(() => failChild('initialize_timeout'), 15000);
  target.stdin.write(JSON.stringify({ id: '__bridge_initialize', method: 'initialize', params: {
    clientInfo: { name: 'codex_mqtt_bridge', title: 'Codex MQTT Bridge', version: '1.0.0' },
  } }) + '\n');
}
client.on('connect', () => {
  connected = true;
  client.subscribe(`${base}/in`, { qos: 1, rh: 2, rap: true }, (error, granted) => {
    if (error || !granted?.length || granted.some(item => item.qos > 2)) {
      log('subscribe_failed', { message: error?.message || 'subscription_denied' }); shutdown('subscribe_failed', 1); return;
    }
    startChild(); status(ready ? 'ready' : 'starting'); flush();
  });
});
client.on('close', () => { connected = false; });
client.on('error', error => log('mqtt_error', { message: error.message }));
client.on('message', (topic, bytes, packet) => {
  if (stopping || topic !== `${base}/in`) return;
  let command;
  try {
    if (packet.retain) throw new Error('retained_command_rejected');
    command = parseCommand(bytes, { maxBytes, maxTtlMs });
    if (command.runId !== runId) throw new Error('run_id_mismatch');
    if (!ready || !child?.stdin.writable) throw new Error('app_server_not_ready');
    if (child.stdin.writableLength + bytes.length > maxQueueBytes) throw new Error('stdin_backpressure');
    if (!dedup.accept(command.messageId, command.expiresAt)) return;
    child.stdin.write(JSON.stringify(command.payload) + '\n');
  } catch (error) {
    output('bridgeError', { messageId: command?.messageId, code: error instanceof SyntaxError ? 'invalid_json' : error.message });
  }
});
function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true; ready = false; process.exitCode = exitCode;
  log('shutdown', { reason }); status('offline');
  clearTimeout(restartTimer); clearTimeout(initTimer);
  if (child) {
    const target = child;
    target.stdin.end(); target.kill('SIGTERM');
    killTimer = setTimeout(() => target.kill('SIGKILL'), 3000);
  }
  stopTimer = setTimeout(() => { client.end(true); process.exit(exitCode); }, 5000);
  client.end(false, {}, () => { if (!child) { clearTimeout(stopTimer); process.exit(exitCode); } });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
