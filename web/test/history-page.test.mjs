import test from 'node:test';
import assert from 'node:assert/strict';
import { compactItem, historyPage } from '../server/history-page.mjs';

test('item history uses bounded descending pages and defers large command output', async () => {
  const calls = [];
  const bus = { rpc: async (method, params) => {
    calls.push({ method, params });
    return { data: [{ turnId: 'turn', item: { id: 'tool', type: 'commandExecution', aggregatedOutput: '中文'.repeat(5000) } }],
      nextCursor: params.cursor ? null : 'older' };
  } };
  const first = await historyPage(bus, 'thread');
  assert.equal(first.items[0].outputDeferred, true);
  assert.equal(first.items[0].aggregatedOutput, undefined);
  assert.equal(calls[0].params.limit, 50);
  assert.equal(calls[0].params.sortDirection, 'desc');
  await historyPage(bus, 'thread', first.nextCursor);
  assert.equal(calls[1].params.cursor, 'older');
  assert.equal((await historyPage(bus, 'thread', undefined, { itemId: 'tool', turnId: 'turn' })).output, '中文'.repeat(5000));
});

test('legacy turn history pages a long turn without dropping or repeating items', async () => {
  const entries = Array.from({ length: 123 }, (_, index) => ({ id: String(index), type: 'agentMessage', text: '消息' }));
  const bus = { rpc: async method => {
    if (method === 'thread/items/list') throw new Error('method not found');
    return { data: [{ id: 'turn', items: entries }], nextCursor: null };
  } };
  const loaded = [];
  let cursor;
  do {
    const page = await historyPage(bus, 'thread', cursor);
    assert.ok(page.items.length <= 50);
    loaded.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(loaded, entries.map(item => item.id).reverse());
  assert.equal(new Set(loaded).size, entries.length);
});

test('history failures do not silently fall back or accept malformed cursors', async () => {
  const calls = [];
  const bus = { rpc: async method => { calls.push(method); throw new Error('connection lost'); } };
  await assert.rejects(historyPage(bus, 'thread'), /connection lost/);
  assert.deepEqual(calls, ['thread/items/list']);
  await assert.rejects(historyPage(bus, 'thread', 'invalid'), /游标无效/);
});

test('history preserves recorded item lifecycle times without fabricating missing timestamps', async () => {
  const bus = { rpc: async () => ({ data: [
    { turnId: 'turn', startedAtMs: 1730000000123, completedAtMs: 1730000000456,
      item: { id: 'user', type: 'userMessage', startedAtMs: null } },
    { turnId: 'turn', item: { id: 'old', type: 'agentMessage' } },
  ] }) };
  const { items } = await historyPage(bus, 'thread');
  assert.equal(items[0].startedAtMs, 1730000000123);
  assert.equal(items[0].completedAtMs, 1730000000456);
  assert.equal(items[1].startedAtMs, undefined);
  assert.equal(items[1].completedAtMs, undefined);
  const legacy = compactItem({ id: 'legacy', startedAtMs: 1000 }, 'turn');
  assert.equal(legacy.startedAtMs, 1000);
  assert.equal(compactItem({ startedAtMs: NaN, completedAtMs: -1 }, 'turn').completedAtMs, undefined);
});
