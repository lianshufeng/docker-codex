import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, Deduplicator, JsonLines } from '../protocol.mjs';

const options = { now: 1000, maxBytes: 1024, maxTtlMs: 60000 };
const envelope = payload => Buffer.from(JSON.stringify({ messageId: 'one', expiresAt: 2000, payload }));
test('accept requests, notifications, and server-request replies', () => {
  for (const payload of [{ id: 1, method: 'thread/list', params: {} }, { method: 'notification' }, { id: 2, result: {} }, { id: 2, error: { code: -1 } }]) {
    assert.deepEqual(parseCommand(envelope(payload), options).payload, payload);
  }
});
test('reject invalid input, expired messages, and initialization collisions', () => {
  for (const data of [Buffer.from('{'), Buffer.from([255]), envelope([]), envelope({ id: null, method: 'x' }), envelope({ id: 1, result: {}, error: {} }), envelope({ method: 'initialize' }), envelope({ id: '__bridge_1', method: 'x' })]) {
    assert.throws(() => parseCommand(data, options));
  }
  assert.throws(() => parseCommand(envelope({ method: 'x' }), { ...options, now: 2000 }));
  assert.throws(() => parseCommand(envelope({ method: 'x' }), { ...options, maxBytes: 1 }));
});
test('dedup never evicts a live key to admit a duplicate', () => {
  const dedup = new Deduplicator(1);
  assert.equal(dedup.accept('a', 2000, 1000), true);
  assert.equal(dedup.accept('a', 2000, 1000), false);
  assert.throws(() => dedup.accept('b', 2000, 1000));
  assert.equal(dedup.accept('b', 3000, 2000), true);
});
test('JSONL preserves split UTF-8 characters and multiple messages per chunk', () => {
  const result = [];
  const lines = new JsonLines(128, message => result.push(message));
  const bytes = Buffer.from('{"text":"中文"}\n{"id":2}\n');
  for (const byte of bytes) lines.push(Buffer.from([byte]));
  lines.push(Buffer.from('{"id":3}\n{"id":4}\n'));
  assert.deepEqual(result, [{ text: '中文' }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.throws(() => new JsonLines(2, () => {}).push(Buffer.from('abc')));
});
