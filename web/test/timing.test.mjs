import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsed, duration, messageTime, separator, dateLabel } from '../client/src/timing.ts';

test('turn timing uses recorded duration and keeps seconds separate from milliseconds', () => {
  assert.equal(elapsed({ id: 't', status: 'inProgress', startedAt: 1700000000 }, 1700000002500), 2500);
  assert.equal(elapsed({ id: 't', status: 'completed', startedAt: 100, completedAt: 104, durationMs: 3456 }, 999999), 3456);
  assert.equal(elapsed({ id: 't', status: 'interrupted', startedAt: 100, completedAt: 104 }, 999999), 4000);
  assert.equal(elapsed({ id: 't', status: 'failed' }, 999999), undefined);
  assert.equal(elapsed({ id: 't', status: 'inProgress', startedAt: 100 }, 99000), 0);
  assert.equal(elapsed({ id: 't', status: 'completed', durationMs: 0 }, 999999), 0);
});

test('message timestamps and separators respect missing data, long gaps and local day boundaries', () => {
  assert.equal(messageTime({}), undefined);
  assert.equal(messageTime({ startedAtMs: NaN, completedAtMs: 1000 }), 1000);
  const now = new Date(2026, 10, 12, 12, 0).getTime();
  assert.ok(separator(now));
  assert.equal(separator(now + 29 * 60000, now), false);
  assert.ok(separator(now + 30 * 60000, now));
  assert.ok(separator(new Date(2026, 10, 13, 0, 1).getTime(), new Date(2026, 10, 12, 23, 59).getTime()));
  assert.match(dateLabel(now, now), /^今天/);
  assert.match(dateLabel(new Date(2026, 10, 11, 12).getTime(), now), /^昨天/);
  assert.equal(duration(125000), '2分5秒');
  assert.equal(duration(3725000), '1小时2分5秒');
  assert.equal(duration(1234, true), '1.2秒');
});
