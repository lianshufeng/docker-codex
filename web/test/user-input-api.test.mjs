import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { sharedApi } from '../server/shared-api.mjs';
import { projectId } from '../server/app-workspace.mjs';
import { parseQuestionReply, questionKey } from '../user-input.mjs';

for (const scenario of ['idle', 'active', 'ended', 'unknown']) test(`async answer delivery and deduplication when the turn is ${scenario}`, async () => {
  const bus = new EventEmitter(), cwd = '/workspace/交互', starts = [], steers = [];
  let active = scenario !== 'idle';
  bus.state = { runId: 'run', state: 'ready' }; bus.ready = () => true; bus.supports = () => true;
  const item = { id: 'question', type: 'agentMessage', questions: [{ title: '请选择颜色', options: ['浅色', '深色'] }] };
  const data = [{ item, turnId: 'old' }];
  bus.rpc = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd, status: { type: active ? 'active' : 'idle' } } };
    if (method === 'thread/items/list') return { data, nextCursor: null };
    if (method === 'thread/turns/list') return { data: [{ id: 'old', status: 'inProgress' }] };
    if (method === 'turn/steer') {
      steers.push(params);
      if (scenario === 'unknown') throw Object.assign(new Error('response timed out'), { status: 504 });
      if (scenario === 'ended') {
        active = false;
        throw Object.assign(new Error('no active turn to steer'), { status: 502 });
      }
      return { turnId: 'old' };
    }
    if (method === 'turn/start') { starts.push(params); return { turn: { id: 'next' } }; }
    assert.fail(method);
  };
  const app = express(); app.use(express.json(), sharedApi(bus, {}, () => {}).router);
  app.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}/sessions/thread/messages`;
  const send = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ questionId: 'unknown', answer: '浅色' })).status, 409);
    assert.equal((await send({ questionId: questionKey(item.id, 0), answer: '' })).status, 400);
    const body = { questionId: questionKey(item.id, 0), answer: '自由回答', requestId: '1'.repeat(32) };
    const results = await Promise.all([send(body), send({ ...body, requestId: '2'.repeat(32) })]);
    assert.deepEqual(results.map(r => r.status).sort(), scenario === 'unknown' ? [409, 504] : [200, 409]);
    assert.equal(starts.length, Number(scenario === 'idle' || scenario === 'ended'));
    assert.equal(steers.length, Number(scenario !== 'idle'));
    if (steers.length) assert.equal(steers[0].expectedTurnId, 'old');
    for (const call of [...steers, ...starts]) {
      const [reply] = parseQuestionReply(call.input[0].text);
      assert.equal(reply.questionItemId, body.questionId);
      assert.equal(reply.answer, '自由回答');
    }
    const retry = await send(results[0].ok || results[0].status === 504 ? body : { ...body, requestId: '2'.repeat(32) });
    if (scenario === 'unknown') assert.equal(retry.status, 503);
    else assert.deepEqual(await retry.json(), { turnId: scenario === 'active' ? 'old' : 'next',
      ...(scenario === 'active' ? { steered: true } : {}), duplicate: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('pending snapshots recover after Web restart and serialize responses against the execution instance', async () => {
  const bus = new EventEmitter(), cwd = '/workspace/交互', published = [];
  bus.state = { runId: 'web-generation', state: 'ready' }; bus.ready = () => true; bus.supports = () => true;
  bus.remote = { pendingRequests: true, runId: 'execution-generation' };
  let requests = [{ id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', questions: [{ id: 'q', question: '问题' }] } }];
  bus.rpc = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    assert.equal(method, 'bridge/pendingRequests'); assert.equal(params.runId, bus.remote.runId);
    return { requests };
  };
  bus.publish = async payload => { published.push(payload); requests = []; };
  const app = express(); app.use(express.json(), sharedApi(bus, {}, () => {}).router);
  app.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/projects/${projectId(cwd)}/sessions/thread`;
  const submit = () => fetch(endpoint + '/approval', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 4, answers: { q: { answers: [] } } }) });
  try {
    assert.equal((await (await fetch(endpoint + '/history?view=items')).json()).approvals[0].id, 4);
    const results = await Promise.all([submit(), submit()]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 404]);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].result, { answers: { q: { answers: [] } } });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
