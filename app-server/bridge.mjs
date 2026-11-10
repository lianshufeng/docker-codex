import mqtt from 'mqtt';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCommand, Deduplicator, JsonLines } from './protocol.mjs';
import { fileService } from './file-service.mjs';

const config = JSON.parse(readFileSync('/run/secrets/mqtt.json', 'utf8'));
const instance = config.username;
if (typeof instance !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(instance)) throw new Error('Invalid MQTT username');
if (typeof config.password !== 'string' || !config.password) throw new Error('MQTT config requires password');
const base = `codex/${instance}`;
const maxTtlMs = 60000;
const maxQueueBytes = 32 * 1024 * 1024;
const dedup = new Deduplicator(Infinity);
let child, runId, ready = false, stopping = false, connected = false;
let restartTimer, initTimer, killTimer, stopTimer;
let queue = [], queueBytes = 0, publishing = false;
const routes = new Map(), commandResults = new Map(), serverRequests = new Set();
const replyTopic = id => `reply/${encodeURIComponent(String(id))}`;
function cacheReply(key, payload) {
  commandResults.set(key, { payload, expiresAt: Date.now() + maxTtlMs });
}
const log = (event, details = {}) => console.error(JSON.stringify({ event, ...details }));
const client = mqtt.connect(config.url || 'mqtt://mqtt:1883', {
  protocolVersion: 5, clientId: `codex-${instance}`, username: config.username,
  password: config.password, clean: true, reconnectPeriod: 2000,
  connectTimeout: 10000, queueQoSZero: false, resubscribe: false,
  will: { topic: `${base}/status`, payload: JSON.stringify({ state: 'offline' }), qos: 1, retain: true },
});
const files = fileService(client, base);
function status(state) {
  if (!connected) return;
  client.publish(`${base}/status`, JSON.stringify({ state, runId, time: Date.now(), attached: state === 'ready',
    writerReady: state === 'ready', protocolVersion: 1, methods: '*', maxRequestBytes: null,
    fileTransfer: { version: 1, chunkBytes: 512 * 1024, maxFileBytes: null } }), { qos: 1, retain: true }, error => {
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
  if (type === 'rpc') {
    const route = routes.get(payload.id);
    if (!payload.method && route) {
      routes.delete(payload.id);
      const reply = { ...payload, id: route.id };
      cacheReply(route.key, reply);
      enqueue(replyTopic(route.id), reply);
      return;
    } else if (payload.method) {
      if (payload.id !== undefined) serverRequests.add(payload.id);
      enqueue('observed/output', payload);
    } else if (payload.id !== undefined) {
      serverRequests.delete(payload.id);
    }
    if (payload.method === 'serverRequest/resolved') serverRequests.delete(payload.params?.requestId);
  }
  const entry = { type, runId, eventId: randomUUID(), payload, time: Date.now() };
  enqueue('out', entry);
}
function enqueue(topic, entry) {
  const data = JSON.stringify(entry);
  const bytes = Buffer.byteLength(data);
  if (queueBytes > 0 && queueBytes + bytes > maxQueueBytes) {
    // Never silently drop an event and pretend that the stream is complete.
    shutdown('output_queue_exhausted', 1);
    return;
  }
  queue.push({ topic, data, bytes }); queueBytes += bytes;
  flush();
}
function flush() {
  if (!connected || publishing || !queue.length || stopping) return;
  publishing = true;
  const entry = queue[0];
  client.publish(`${base}/${entry.topic}`, entry.data, { qos: 1, retain: false, properties: { messageExpiryInterval: 60 } }, error => {
    publishing = false;
    if (error) { log('output_publish_failed', { message: error.message }); shutdown('output_publish_failed', 1); return; }
    queue.shift(); queueBytes -= entry.bytes;
    flush();
  });
}
function startChild() {
  if (stopping || child) return;
  runId = randomUUID(); routes.clear(); commandResults.clear(); serverRequests.clear(); ready = false; status('starting');
  const target = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = target;
  const lines = new JsonLines(Infinity, message => {
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
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
  } }) + '\n');
}
client.on('connect', () => {
  connected = true;
  client.subscribe([`${base}/in`, `${base}/command`, `${base}/files/request/+`], { qos: 1, rh: 2, rap: true }, (error, granted) => {
    if (error || !granted?.length || granted.some(item => item.qos > 2)) {
      log('subscribe_failed', { message: error?.message || 'subscription_denied' }); shutdown('subscribe_failed', 1); return;
    }
    startChild(); status(ready ? 'ready' : 'starting'); flush();
  });
});
client.on('close', () => { connected = false; });
client.on('error', error => log('mqtt_error', { message: error.message }));
client.on('message', (topic, bytes, packet) => {
  if (!stopping && ready && files.accept(topic, bytes, packet)) return;
  if (!stopping && topic === `${base}/command`) {
    let id, validId = false;
    try {
      if (packet.retain) return;
      const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!request || typeof request !== 'object' || Array.isArray(request)) return;
      id = request.id;
      validId = typeof id === 'string' || Number.isSafeInteger(id);
      if (Object.hasOwn(request, 'id') && !validId) return;
      if (!ready || !child?.stdin.writable) throw new Error('app_server_not_ready');
      if (['initialize', 'initialized'].includes(request.method)) throw new Error('initialization_owned_by_bridge');
      if (child.stdin.writableNeedDrain) throw new Error('stdin_backpressure');
      if (!validId) {
        child.stdin.write(JSON.stringify(request) + '\n'); return;
      }
      const key = JSON.stringify([id, request.method ?? null]);
      for (const [entry, value] of commandResults) {
        if (value.expiresAt <= Date.now()) commandResults.delete(entry);
      }
      const previous = commandResults.get(key);
      if (previous) { if (previous.payload) enqueue(replyTopic(id), previous.payload); return; }
      if (request.method === 'rpc/respond' || !Object.hasOwn(request, 'method')) {
        const response = request.method === 'rpc/respond' ? request.params : request;
        const requestId = request.method === 'rpc/respond' ? response?.requestId : id;
        if (!response || Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error') || !serverRequests.delete(requestId)) {
          throw new Error('反向请求已结束或回答格式无效');
        }
        const payload = { id: requestId, ...(Object.hasOwn(response, 'result') ? { result: response.result } : { error: response.error }) };
        child.stdin.write(JSON.stringify(payload) + '\n');
        if (request.method === 'rpc/respond') {
          const reply = { id, result: { written: true } };
          cacheReply(key, reply); enqueue(replyTopic(id), reply);
        }
      } else {
        const payload = { ...request, id: `mqtt-${randomUUID()}` };
        commandResults.set(key, { expiresAt: Infinity });
        routes.set(payload.id, { id, key }); child.stdin.write(JSON.stringify(payload) + '\n');
      }
    } catch (error) {
      if (validId) enqueue(replyTopic(id), { id, error: error.message });
    }
    return;
  }
  if (stopping || topic !== `${base}/in`) return;
  let command;
  try {
    if (packet.retain) throw new Error('retained_command_rejected');
    command = parseCommand(bytes, { maxBytes: Infinity, maxTtlMs });
    if (command.runId !== runId) throw new Error('run_id_mismatch');
    if (!ready || !child?.stdin.writable) throw new Error('app_server_not_ready');
    if (child.stdin.writableNeedDrain) throw new Error('stdin_backpressure');
    if (!dedup.accept(command.messageId, command.expiresAt)) return;
    child.stdin.write(JSON.stringify(command.payload) + '\n');
  } catch (error) {
    output('bridgeError', { messageId: command?.messageId, code: error instanceof SyntaxError ? 'invalid_json' : error.message });
  }
});
function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true; ready = false; process.exitCode = exitCode;
  files.close();
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
