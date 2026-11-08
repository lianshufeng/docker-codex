import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopBus } from '../server/desktop-mqtt.mjs';
import { remotePaths } from '../server/remote-paths.mjs';

async function setup() {
  const client = new EventEmitter(); client.connected = true; client.sent = [];
  client.subscribe = (topics, options, callback) => callback(null, (Array.isArray(topics) ? topics : [topics]).map(topic => ({ topic, qos: 1 })));
  client.publishAsync = async (topic, bytes) => { client.sent.push({ topic, ...JSON.parse(bytes) }); };
  client.endAsync = async () => { client.connected = false; client.emit('close'); };
  const bus = new DesktopBus({ processId: 123, username: 'test', url: 'mqtt://localhost' }, () => client);
  client.emit('connect');
  const message = (suffix, value) => client.emit('message', `codex/123/${suffix}`, Buffer.from(JSON.stringify(value)), {});
  message('status', { attached: true, writerReady: true });
  await new Promise(resolve => setTimeout(resolve, 350));
  const reply = (request, result = {}) => message(`reply/${request.id}`, { id: request.id, result });
  return { bus, client, message, reply };
}

test('desktop forwards concurrent RPC, maps replies and forwards approvals without replaying retained events', async () => {
  const { bus, client, message, reply } = await setup();
  try {
    const a = bus.rpc('model/list'), b = bus.rpc('thread/list');
    await new Promise(setImmediate); assert.equal(client.sent.length, 2);
    assert.equal(client.sent[0].topic, 'codex/123/command');
    reply(client.sent[0], { data: ['model'] }); assert.deepEqual(await a, { data: ['model'] });
    reply(client.sent[1], { data: [] }); await b;
    const events = []; bus.on('notification', (event, runId) => events.push({ event, runId }));
    message('observed/output', { id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    assert.equal(events.length, 1); assert.equal(events[0].runId, bus.state.runId);
    client.emit('message', 'codex/123/observed/output', Buffer.from('{"method":"turn/completed"}'), { retain: true });
    assert.equal(events.length, 1);
    const approval = bus.publish({ id: 12, result: { decision: 'accept' } });
    await new Promise(setImmediate);
    assert.equal(client.sent[2].method, 'rpc/respond');
    assert.equal(client.sent[2].params.requestId, 12);
    reply(client.sent[2], { written: true }); await approval;
  } finally { await bus.close(); }
});

test('desktop forwards methods and large Unicode requests without a business whitelist', async () => {
  const { bus, client } = await setup();
  try {
    const method = bus.rpc('future/method', { input: '中文'.repeat(4000) });
    await new Promise(setImmediate);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].method, 'future/method');
    const reply = client.sent[0];
    client.emit('message', `codex/123/reply/${reply.id}`, Buffer.from(JSON.stringify({ id: reply.id, result: { accepted: true } })), {});
    assert.deepEqual(await method, { accepted: true });
  } finally { await bus.close(); }
});

test('discovery refuses ambiguous targets instead of sending commands to either', async () => {
  const { bus, client } = await setup();
  try {
    client.emit('message', 'codex/456/status', Buffer.from('{"attached":true,"writerReady":true,"protocolVersion":1}'), {});
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(bus.state.state, 'ambiguous');
    await assert.rejects(bus.rpc('model/list'), /多个执行端/);
    assert.equal(client.sent.length, 0);
  } finally { await bus.close(); }
});

test('desktop disconnect rejects in-flight work and reconnect permits new requests', async () => {
  const { bus, client, message } = await setup();
  try {
    const one = bus.rpc('thread/read'), two = bus.rpc('turn/start');
    const rejected = Promise.all([assert.rejects(one), assert.rejects(two)]);
    await new Promise(setImmediate); client.connected = false; client.emit('close');
    client.connected = true; client.emit('connect'); message('status', { attached: true, writerReady: true });
    await new Promise(resolve => setTimeout(resolve, 350));
    await rejected; assert.equal(client.sent.length, 2);
    const uncertain = bus.rpc('turn/start');
    await new Promise(setImmediate);
    message(`reply/${client.sent[2].id}`, { result: { accepted: true } });
    assert.deepEqual(await uncertain, { accepted: true });
    const third = bus.rpc('turn/start'); await new Promise(setImmediate);
    message(`reply/${client.sent[3].id}`, { result: { accepted: true } });
    assert.deepEqual(await third, { accepted: true });
    assert.equal(client.sent.length, 4);
  } finally { await bus.close(); }
});

test('remote paths handle Windows cwd casing, file URLs and cross-drive escapes', () => {
  const win = remotePaths('E:/共享/workspace');
  const cwd = win.join('user', 'project');
  assert.ok(win.equal('e:/共享/workspace/USER/project', cwd));
  assert.equal(win.relative(cwd, 'E:\\共享\\workspace\\user\\project\\图.png'), '图.png');
  assert.equal(win.relative(cwd, '/E:/共享/workspace/user/project/图.png'), '图.png');
  assert.equal(win.relative(cwd, 'C:\\secret.png'), '../');
  assert.ok(win.relative(cwd, 'E:\\共享\\workspace\\other\\secret.png').startsWith('../'));
  assert.ok(!win.equal('user/project', cwd));
  const linux = remotePaths('/workspace');
  assert.ok(!linux.equal('/workspace/User', '/workspace/user'));
  assert.equal(linux.relative('/workspace/user/project', '/workspace/user/project/图.png'), '图.png');
});
