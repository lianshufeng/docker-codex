import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client/public/theme.js', import.meta.url), 'utf8');
function controller(hour, saved, blocked = false) {
  let now = new Date(2026, 10, 12, hour), next = 0;
  const timers = new Map(), events = {}, values = new Map([['assistant-appearance', saved]]);
  const root = { dataset: {}, style: {} }, meta = {};
  const window = { addEventListener: (name, fn) => { events[name] = fn; } };
  runInNewContext(source, {
    window,
    document: { documentElement: root, querySelector: () => ({ setAttribute: (key, value) => { meta[key] = value; } }), addEventListener: (name, fn) => { events[name] = fn; } },
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return values.get(key); }, setItem: (key, value) => { if (blocked) throw Error('blocked'); values.set(key, value); } },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } },
    setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    clearTimeout: id => timers.delete(id),
  });
  return { api: window.assistantTheme, root, meta, timers, events, values,
    time(hour, minute = 0, day = 12) { now = new Date(2026, 10, day, hour, minute); },
    tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); },
  };
}

test('自动模式严格按本地08:00和20:00切换，跨午夜继续调度', () => {
  const c = controller(7);
  assert.equal(c.api.getSnapshot().mode, 'auto');
  for (const [hour, minute, day, theme] of [[7,59,12,'dark'],[8,0,12,'light'],[19,59,12,'light'],[20,0,12,'dark'],[0,0,13,'dark'],[8,0,13,'light']]) {
    c.time(hour, minute, day); c.tick();
    assert.equal(c.root.dataset.theme, theme);
    assert.equal(c.root.style.colorScheme, theme);
    assert.equal(c.timers.size, 1);
    assert.ok([...c.timers.values()][0].ms > 0 && [...c.timers.values()][0].ms <= 60000);
  }
  assert.equal(c.meta.content, '#ffffff');
});

test('手动偏好持久化、清除自动定时器，刷新和恢复焦点不改变主题', () => {
  const c = controller(9);
  for (const theme of ['dark', 'light']) {
    c.api.setMode(theme); c.time(theme === 'light' ? 23 : 10);
    c.events.focus(); c.events.visibilitychange(); c.events.pageshow();
    assert.equal(c.root.dataset.theme, theme);
    assert.equal(c.timers.size, 0);
    assert.equal(controller(5, c.values.get('assistant-appearance')).root.dataset.theme, theme);
  }
  c.api.setMode('auto'); assert.equal(c.timers.size, 1);
});

test('多标签页同步、清空保存值和异常值回退自动，订阅可取消', () => {
  const c = controller(9, 'invalid');
  assert.equal(c.api.getSnapshot().mode, 'auto');
  let calls = 0;
  const stop = c.api.subscribe(() => { calls++; });
  c.events.storage({ key: 'assistant-appearance', newValue: 'dark' });
  assert.equal(c.root.dataset.theme, 'dark'); assert.equal(c.timers.size, 0);
  const snapshot = c.api.getSnapshot(); c.events.focus();
  assert.equal(c.api.getSnapshot(), snapshot); assert.equal(calls, 1);
  stop(); c.events.storage({ key: null, newValue: null });
  assert.equal(c.api.getSnapshot().mode, 'auto'); assert.equal(c.root.dataset.theme, 'light');
  assert.equal(calls, 1);
});

test('浏览器禁止存储时仍能初始化和手动切换，休眠恢复重新计算时间', () => {
  const c = controller(9, undefined, true);
  c.time(23); c.events.visibilitychange(); assert.equal(c.root.dataset.theme, 'dark');
  c.api.setMode('light'); assert.equal(c.root.dataset.theme, 'light');
  assert.equal(c.timers.size, 0);
});
