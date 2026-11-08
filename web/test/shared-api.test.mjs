import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { sharedApi } from '../server/shared-api.mjs';
import { projectId } from '../server/app-workspace.mjs';

test('a multi-step file operation stops if the MQTT endpoint changes mid-request', async () => {
  const bus = new EventEmitter(); bus.state = { runId: 'first', state: 'ready' };
  bus.ready = () => true; bus.supports = () => true;
  const methods = [];
  bus.rpc = async method => { methods.push(method); bus.state.runId = 'second'; return { isDirectory: true }; };
  const app = express(); app.use(express.json());
  app.use(sharedApi(bus, {}, () => {}).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/directories`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/data/new' }) });
    assert.equal(response.status, 503);
    assert.deepEqual(methods, ['fs/getMetadata']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Linux project names create one remote child directory and reuse an existing folder', async () => {
  const bus = new EventEmitter(); bus.state = { runId: 'linux', state: 'ready' };
  bus.ready = () => true; bus.supports = () => true;
  const calls = [], directories = new Set(['/', '/workspace']);
  bus.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'fs/getMetadata') {
      if (!directories.has(params.path)) throw new Error('No such file or directory (os error 2)');
      return { isDirectory: true };
    }
    if (method === 'fs/createDirectory') { directories.add(params.path); return {}; }
    if (method === 'thread/start') return { thread: { id: 'remote-id', cwd: params.cwd } };
    throw new Error('unexpected RPC ' + method);
  };
  const app = express(); app.use(express.json()); app.use(sharedApi(bus, {}, () => {}).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const create = name => fetch(`http://127.0.0.1:${server.address().port}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal((await create('../escape')).status, 400);
    assert.equal(calls.length, 0);
    const first = await create('中文项目');
    assert.equal(first.status, 201);
    assert.equal((await first.json()).project.cwd, '/workspace/中文项目');
    assert.equal((await create('中文项目')).status, 201);
    assert.equal(calls.filter(call => call.method === 'fs/createDirectory').length, 1);
    assert.ok(calls.filter(call => call.method === 'thread/start').every(call => call.params.cwd === '/workspace/中文项目'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('legacy bridge creates unnamed threads and naming failures return the already created thread', async () => {
  const bus = new EventEmitter();
  bus.state = { runId: 'desktop', state: 'ready' };
  bus.ready = () => true;
  let naming = false, failNaming = false, starts = 0;
  const cwd = 'E:\\测试工程';
  const saved = new Map();
  bus.supports = method => method !== 'thread/name/set' || naming;
  bus.rpc = async (method, params) => {
    if (method === 'thread/start') {
      const thread = { id: `thread-${++starts}`, cwd };
      saved.set(thread.id, thread);
      return { thread: { ...thread } };
    }
    if (method === 'thread/read') return { thread: { ...saved.get(params.threadId) } };
    if (method === 'thread/name/set') {
      if (failNaming) throw new Error('name temporarily unavailable');
      saved.get(params.threadId).name = params.name;
      return {};
    }
    throw new Error('Unexpected RPC ' + method);
  };
  const app = express();
  app.use(express.json());
  app.use(sharedApi(bus, {}, () => {}).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}/sessions`;
    const send = (url, method, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send(base, 'POST', { name: 'unsupported' })).status, 409);
    assert.equal(starts, 0);
    const unnamed = await send(base, 'POST', {});
    assert.equal(unnamed.status, 201);
    assert.equal((await unnamed.json()).session.name, '新会话');
    naming = true;
    failNaming = true;
    const partial = await send(base, 'POST', { name: '需要保留会话' });
    assert.equal(partial.status, 201);
    const result = await partial.json();
    assert.equal(result.session.id, 'thread-2');
    assert.equal(result.session.name, '新会话');
    assert.match(result.warning, /会话已创建/);
    assert.equal(starts, 2);
    failNaming = false;
    const renamed = await send(`${base}/thread-2`, 'PATCH', { name: '改名成功' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).session.name, '改名成功');
    assert.equal(saved.get('thread-2').name, '改名成功');
    assert.equal((await send(base, 'POST', { name: ' ' })).status, 400);
    assert.equal(starts, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
