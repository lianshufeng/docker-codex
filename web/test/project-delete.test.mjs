import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { sharedApi } from '../server/shared-api.mjs';
import { projectId } from '../server/app-workspace.mjs';

async function fixture(t, options = {}) {
  const cwd = options.cwd || '/workspace/删除验收', bus = new EventEmitter(), calls = [], events = [];
  const threads = new Map((options.threads || [
    { id: 'a', cwd }, { id: 'b', cwd, archived: true }, { id: 'c', cwd, loadedOnly: true },
    { id: 'other', cwd: cwd + '-其他项目' },
  ]).map(thread => [thread.id, { status: { type: 'idle' }, ...thread }]));
  bus.state = { runId: 'test', state: 'ready' };
  bus.ready = () => true;
  bus.supports = method => method !== 'thread/delete' || options.supported !== false;
  bus.rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (options.rpc) await options.rpc(method, params, bus);
    if (method === 'thread/list') {
      const filtered = [...threads.values()].filter(thread => !thread.loadedOnly &&
        Boolean(thread.archived) === Boolean(params.archived) &&
        (!params.cwd || thread.cwd === params.cwd) &&
        (!params.ancestorThreadId || thread.parent === params.ancestorThreadId));
      const start = Number(params.cursor || 0);
      return { data: filtered.slice(start, start + 1), nextCursor: start + 1 < filtered.length ? String(start + 1) : null };
    }
    if (method === 'thread/loaded/list') return { data: [...threads.values()].filter(t => t.loadedOnly).map(t => t.id) };
    if (method === 'thread/read') {
      if (!threads.has(params.threadId)) throw new Error('thread not found');
      return { thread: threads.get(params.threadId) };
    }
    if (method === 'thread/delete') {
      threads.delete(params.threadId);
      for (const [id, thread] of threads) if (thread.parent === params.threadId) threads.delete(id);
      return {};
    }
    assert.fail('Unexpected mutation: ' + method);
  };
  const app = express(); app.use(express.json());
  app.use(sharedApi(bus, {}, (_, event) => events.push(event)).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}`;
  return { url, threads, calls, events, bus, remove: () => fetch(url, { method: 'DELETE' }) };
}

test('project deletion includes every page, archived and loaded sessions, preserving other projects and files', async t => {
  const f = await fixture(t, { threads: [
    { id: 'a', cwd: '/workspace/删除验收' }, { id: 'b', cwd: '/workspace/删除验收' },
    { id: 'c', cwd: '/workspace/删除验收', archived: true },
    { id: 'd', cwd: '/workspace/删除验收', loadedOnly: true },
    { id: 'other', cwd: '/workspace/删除验收-其他项目' },
  ] });
  const response = await f.remove(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).deleted.sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...f.threads.keys()], ['other']);
  assert.equal(f.calls.some(c => c.method.startsWith('fs/')), false);
  assert.equal(f.events.filter(e => e.removed).length, 4);
  assert.equal((await f.remove()).status, 200);
});

test('active or reserved sessions prevent all deletion, including on a later page', async t => {
  for (const reserved of [false, true]) {
    const f = await fixture(t);
    if (reserved) f.bus.emit('notification', { method: 'turn/started', params: { threadId: 'b', turn: { id: 'turn' } } }, 'test');
    else f.threads.get('b').status.type = 'active';
    const response = await f.remove(); assert.equal(response.status, 409);
    assert.match((await response.json()).error, /已删除 0.*正在执行/);
    assert.equal(f.calls.some(c => c.method === 'thread/delete'), false);
  }
});

test('unsupported endpoint and invalid project id do not delete anything', async t => {
  const f = await fixture(t, { supported: false });
  assert.equal((await f.remove()).status, 409);
  assert.equal((await fetch(f.url.replace(/[^/]+$/, 'invalid'), { method: 'DELETE' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('descendants are checked before cascade deletion and cross-project descendants are refused', async t => {
  const f = await fixture(t);
  f.threads.set('child', { id: 'child', parent: 'a', cwd: '/workspace/other' });
  assert.equal((await f.remove()).status, 409);
  assert.equal(f.calls.some(c => c.method === 'thread/delete'), false);
  f.threads.get('child').cwd = '/workspace/删除验收';
  const response = await f.remove(); assert.equal(response.status, 200);
  assert.ok((await response.json()).deleted.includes('child'));
  assert.equal(f.calls.filter(c => c.method === 'thread/delete' && c.params.threadId === 'child').length, 0);
});

test('partial failure is reported, broadcasts completed deletions, and can be retried', async t => {
  let failed = false;
  const f = await fixture(t, { rpc: (method, params) => {
    if (method === 'thread/delete' && params.threadId === 'b' && !failed) { failed = true; throw new Error('测试失败'); }
  } });
  const response = await f.remove(); assert.equal(response.status, 502);
  assert.match((await response.json()).error, /已删除 1.*测试失败/);
  assert.ok(f.events.some(e => e.removed === 'a'));
  assert.equal((await f.remove()).status, 200);
  assert.deepEqual([...f.threads.keys()], ['other']);
});

test('endpoint changes stop subsequent deletion requests', async t => {
  const f = await fixture(t, { rpc: (method, params, bus) => {
    if (method === 'thread/delete') bus.state.runId = 'replacement';
  } });
  assert.equal((await f.remove()).status, 503);
  assert.equal(f.calls.filter(c => c.method === 'thread/delete').length, 1);
});

test('new writes are rejected while a project deletion is in progress', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { rpc: async method => {
    if (method === 'thread/delete') { started(); await gate; }
  } });
  const deleting = f.remove();
  await entered;
  try {
    for (const route of ['/sessions', '/sessions/a/messages', '/sessions/a/archive']) {
      assert.equal((await fetch(f.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
    }
    assert.equal((await fetch(f.url.replace(/\/projects\/.*$/, '/projects'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/workspace/删除验收' }),
    })).status, 409);
  } finally { release(); }
  assert.equal((await deleting).status, 200);
});

test('Windows project deletion matches stored paths regardless of casing', async t => {
  const f = await fixture(t, { cwd: 'E:\\Workspace\\删除验收' });
  assert.equal((await f.remove()).status, 200);
  assert.deepEqual([...f.threads.keys()], ['other']);
});

test('ephemeral sessions and unsupported descendant filters fail before deleting anything', async t => {
  const f = await fixture(t);
  f.threads.get('b').ephemeral = true;
  assert.equal((await f.remove()).status, 409);
  assert.equal(f.calls.some(c => c.method === 'thread/delete'), false);
  f.threads.get('b').ephemeral = false;
  f.threads.get('a').parent = 'a';
  assert.equal((await f.remove()).status, 502);
  assert.equal(f.calls.some(c => c.method === 'thread/delete'), false);
});
