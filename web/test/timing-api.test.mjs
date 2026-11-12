import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import { sharedApi } from '../server/shared-api.mjs';
import { projectId } from '../server/app-workspace.mjs';

test('timing history stays paginated, checks session ownership, and strips all tool output', async t => {
  const bus = new EventEmitter(), calls = [], cwd = '/workspace/时间';
  let rejectMetadataOnly = false;
  let notMaterialized = false;
  bus.state = { runId: 'test' };
  bus.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', cwd } };
    assert.equal(method, 'thread/turns/list');
    if (notMaterialized) throw new Error('thread is not materialized yet');
    if (rejectMetadataOnly && params.itemsView === 'notLoaded') throw new Error('paginated_threads is not supported yet');
    return { data: [{ id: 'turn', status: 'completed', startedAt: 100, completedAt: 104, durationMs: 3456,
      items: [{ aggregatedOutput: '不能传输的完整工具输出' }] }], nextCursor: 'more' };
  };
  const app = express(); app.use(sharedApi(bus, {}, () => {}).router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/projects/`;
  const response = await fetch(base + projectId(cwd) + '/sessions/thread/history?view=timing&cursor=older');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.turns[0].durationMs, 3456);
  assert.equal(result.turns[0].items, undefined);
  assert.equal(result.nextCursor, 'more');
  assert.deepEqual(calls[1].params, { threadId: 'thread', limit: 50, itemsView: 'notLoaded', sortDirection: 'desc', cursor: 'older' });
  assert.equal((await fetch(base + projectId('/workspace/其他') + '/sessions/thread/history?view=timing')).status, 404);
  rejectMetadataOnly = true; calls.length = 0;
  const legacy = await fetch(base + projectId(cwd) + '/sessions/thread/history?view=timing');
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).turns[0].items, undefined);
  assert.deepEqual(calls.slice(1).map(call => call.params.itemsView), ['notLoaded', 'summary']);
  notMaterialized = true;
  const empty = await fetch(base + projectId(cwd) + '/sessions/thread/history?view=timing');
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { turns: [], nextCursor: null });
});
