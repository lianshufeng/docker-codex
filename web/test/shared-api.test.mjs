import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { sharedApi } from '../server/shared-api.mjs';
import { projectId } from '../server/app-workspace.mjs';

test('paged projects fetch one upstream page and restore the selected session separately', async () => {
  const bus = new EventEmitter();
  bus.state = { runId: 'test', state: 'ready' };
  const cwd = '/workspace/test', calls = [];
  bus.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd } };
    return { data: Array.from({ length: 30 }, (_, i) => ({ id: String(i), cwd })), nextCursor: 'next' };
  };
  const app = express();
  app.use(sharedApi(bus, {}, () => {}).router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/projects?view=page`;
    const first = await (await fetch(base + '&selected=saved')).json();
    assert.equal(first.nextCursor, 'next');
    assert.equal(first.projects[0].sessions.length, 31);
    assert.ok(first.projects[0].sessions.some(s => s.id === 'saved'));
    assert.deepEqual(calls.map(call => call.method), ['thread/list', 'thread/read']);
    assert.equal(calls[0].params.limit, 30);
    await fetch(base + '&cursor=next&q=' + encodeURIComponent('中文'));
    assert.equal(calls[2].params.cursor, 'next');
    assert.equal(calls[2].params.searchTerm, '中文');
    assert.equal(calls.length, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('project catalog pages ten distinct directories independently of session pagination', async () => {
  const bus = new EventEmitter();
  bus.state = { runId: 'test' };
  bus.supports = () => false;
  const thread = (i, suffix = '') => ({ id: i + suffix, cwd: '/workspace/项目-' + String(i).padStart(2, '0') });
  const upstream = [];
  bus.rpc = async (method, params) => {
    assert.equal(method, 'thread/list');
    if (params.cwd) {
      assert.equal(params.cwd, thread(0).cwd);
      return { data: [thread(0), thread(0, '-second'), thread(1)], nextCursor: null };
    }
    upstream.push(params.cursor);
    return params.cursor
      ? { data: [thread(0, '-second'), ...Array.from({ length: 10 }, (_, i) => thread(i + 13))], nextCursor: null }
      : { data: Array.from({ length: 13 }, (_, i) => thread(i)), nextCursor: 'more-threads' };
  };
  const app = express();
  app.use(sharedApi(bus, {}, () => {}).router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/projects?view=catalog`;
    const first = await (await fetch(base)).json();
    assert.deepEqual(upstream, [undefined]);
    const nextUrl = base + '&cursor=' + encodeURIComponent(first.nextCursor);
    const second = await (await fetch(nextUrl)).json();
    assert.deepEqual(await (await fetch(nextUrl)).json(), second);
    assert.deepEqual(upstream, [undefined, 'more-threads']);
    const last = await (await fetch(base + '&cursor=' + encodeURIComponent(second.nextCursor))).json();
    assert.deepEqual([first.projects.length, second.projects.length, last.projects.length], [10, 10, 3]);
    assert.deepEqual(upstream, [undefined, 'more-threads']);
    const sessionsUrl = new URL(`/projects/${first.projects[0].id}/sessions`, base);
    const { sessions } = await (await fetch(sessionsUrl)).json();
    assert.deepEqual(sessions.map(s => s.id), ['0', '0-second']);
    assert.equal(new Set([...first.projects, ...second.projects, ...last.projects].map(p => p.id)).size, 23);
    assert.equal(last.nextCursor, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('retrying an accepted message does not start or steer a second turn', async () => {
  const bus = new EventEmitter();
  bus.state = { runId: 'test', state: 'ready' };
  bus.ready = () => true;
  const cwd = '/workspace/test', calls = [];
  bus.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd, status: { type: 'idle' } } };
    if (method === 'config/read') return { config: { model: 'test-model' } };
    if (method === 'turn/start') return { turn: { id: 'turn' } };
    assert.fail(method);
  };
  const app = express();
  app.use(sharedApi(bus, {}, () => {}).router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}/sessions/thread/messages`;
    const send = steer => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '0'.repeat(32), text: '中文', steer, plan: true }) });
    assert.deepEqual(await (await send(false)).json(), { turnId: 'turn' });
    assert.deepEqual(await (await send(true)).json(), { turnId: 'turn', duplicate: true });
    const starts = calls.filter(call => call.method === 'turn/start');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].params.collaborationMode, { mode: 'plan', settings: {
      model: 'test-model', reasoning_effort: null, developer_instructions: null } });
    assert.equal(calls.some(call => call.method === 'turn/steer'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('interactive requests validate answers and forward the response for each protocol', async () => {
  const bus = new EventEmitter();
  bus.state = { runId: 'test', state: 'ready' };
  bus.ready = () => true;
  const cwd = '/workspace/test', published = [];
  bus.rpc = async (method, { threadId }) => {
    assert.equal(method, 'thread/read');
    return { thread: { id: threadId, cwd } };
  };
  bus.publish = async payload => { published.push(payload); };
  const app = express();
  app.use(express.json(), sharedApi(bus, {}, () => {}).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const submit = (threadId, body) => fetch(
      `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}/sessions/${threadId}/approval`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ask = (id, questions) => bus.emit('notification', {
      id, method: 'item/tool/requestUserInput', params: { threadId: 'target', questions }
    }, bus.state.runId);
    const color = { id: 'color', options: [{ label: '蓝色' }] };
    ask(1, [color]);
    assert.equal((await submit('other', { requestId: 1, answers: { color: '蓝色' } })).status, 404);
    assert.equal((await submit('target', { requestId: 1, answers: { color: '红色' } })).status, 400);
    assert.equal((await submit('target', { requestId: 1, answers: { color: '蓝色' } })).status, 200);
    ask(2, [color, { id: 'size', options: [{ label: '小' }], isOther: true }]);
    assert.equal((await submit('target', { requestId: 2, answers: { color: '蓝色' } })).status, 400);
    const response = { requestId: 2, answers: { color: '蓝色', size: '大' } };
    const attempts = await Promise.all([submit('target', response), submit('target', response)]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 404]);
    const elicit = (id, params) => bus.emit('notification', {
      id, method: 'mcpServer/elicitation/request', params: { threadId: 'target', turnId: null, ...params }
    }, bus.state.runId);
    elicit(3, { mode: 'form', requestedSchema: { type: 'object', required: ['colors', 'count', 'enabled'], properties: {
      colors: { type: 'array', minItems: 2, items: { anyOf: [{ const: 'blue', title: '蓝色' }, { const: 'red', title: '红色' }] } },
      count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' }, email: { type: 'string', format: 'email' }
    } } });
    bus.emit('notification', { method: 'turn/completed', params: {
      threadId: 'target', turn: { id: 'unrelated' }
    } }, bus.state.runId);
    const content = { colors: ['blue', 'red'], count: 2, enabled: false };
    for (const invalid of [{ colors: ['blue', 'blue'] }, { count: 1.5 }, { email: 'bad' }, { unexpected: true }]) {
      assert.equal((await submit('target', { requestId: 3, action: 'accept', content: { ...content, ...invalid } })).status, 400);
    }
    assert.equal((await submit('target', { requestId: 3, action: 'accept', content })).status, 200);
    elicit(4, { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } });
    assert.equal((await submit('target', { requestId: 4, action: 'accept', content: {} })).status, 400);
    assert.equal((await submit('target', { requestId: 4, action: 'cancel' })).status, 200);
    elicit(5, { mode: 'url', url: 'javascript:alert(1)' });
    assert.equal((await submit('target', { requestId: 5, action: 'accept' })).status, 400);
    assert.equal((await submit('target', { requestId: 5, action: 'decline' })).status, 200);
    elicit(6, { mode: 'url', url: 'https://example.com/' });
    assert.equal((await submit('target', { requestId: 6, action: 'accept' })).status, 200);
    elicit(7, { mode: 'openai/form', requestedSchema: { type: 'object', required: ['name'],
      properties: { name: { type: 'string' } } } });
    assert.equal((await submit('target', { requestId: 7, action: 'accept', content: { name: '中文' } })).status, 200);
    ask(8, [{ id: 'text', options: null }]);
    assert.equal((await submit('target', { requestId: 8, answers: { text: '自由输入' } })).status, 200);
    ask(9, [color]);
    bus.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'target', requestId: '9' } }, bus.state.runId);
    assert.equal((await submit('target', { requestId: 9, answers: { color: '蓝色' } })).status, 404);
    assert.deepEqual(published, [
      { id: 1, result: { answers: { color: { answers: ['蓝色'] } } } },
      { id: 2, result: { answers: { color: { answers: ['蓝色'] }, size: { answers: ['大'] } } } },
      { id: 3, result: { action: 'accept', content, _meta: null } },
      { id: 4, result: { action: 'cancel', content: null, _meta: null } },
      { id: 5, result: { action: 'decline', content: null, _meta: null } },
      { id: 6, result: { action: 'accept', content: null, _meta: null } },
      { id: 7, result: { action: 'accept', content: { name: '中文' }, _meta: null } },
      { id: 8, result: { answers: { text: { answers: ['自由输入'] } } } }
    ]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

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
