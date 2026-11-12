// Only run in the isolated message-time Compose, using its preinstalled browser.
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');

(async () => {
  const { DesktopBus } = await import('../server/desktop-mqtt.mjs');
  const config = JSON.parse(readFileSync('/tests/test-results/message-time-config.json', 'utf8'));
  const bus = new DesktopBus(config.mqtt), browser = await chromium.launch({ headless: true });
  const base = 'http://web:31027', name = '消息时间验收-' + randomUUID();
  const report = { cwd: '/workspace/' + name, threads: [], checks: [] }, errors = [];
  const save = () => writeFileSync('/tests/test-results/message-time-ui.json', JSON.stringify(report, null, 2), 'utf8');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, timeout = 150000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(300); }
    throw new Error('时间验收等待超时');
  }
  async function api(context, route, method = 'GET', data, expected = 200) {
    const response = await context.request.fetch(base + '/api' + route, { method, data });
    assert.equal(response.status(), expected, await response.text()); return response.json();
  }
  try {
    await until(() => bus.ready(), 20000);
    await until(() => fetch(base).then(r => r.ok).catch(() => false), 30000); save();
    const contexts = [], users = [];
    for (const timezoneId of ['Asia/Tokyo', 'UTC']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId });
      const credentials = { username: 'time_ui_' + randomUUID().slice(0, 10), password: randomUUID() };
      await api(context, '/auth/register', 'POST', credentials, 201);
      users.push((await api(context, '/auth/login', 'POST', credentials)).user); contexts.push(context);
    }
    const { project } = await api(contexts[0], '/projects', 'POST', { name }, 201);
    report.threads.push(...project.sessions.map(s => s.id)); save();
    const pid = project.id, sid = project.sessions[0].id, route = `/projects/${pid}/sessions/${sid}`;
    const pages = [];
    for (let i = 0; i < contexts.length; i++) {
      await contexts[i].addInitScript(({ key, value }) => localStorage.setItem(key, value), {
        key: 'codex-selection-' + users[i].id, value: JSON.stringify({ pid, sid }),
      });
      const page = await contexts[i].newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.getByRole('textbox', { name: '发送消息' }).waitFor();
    }
    const [a, b] = pages;
    await a.getByRole('textbox', { name: '发送消息' }).fill('请使用工具实际执行 sleep 12 命令，工具完成后只回复“时间验收通过”。');
    await a.getByRole('button', { name: '发送消息', exact: true }).click();
    await until(async () => (await api(contexts[0], route + '/history?view=timing')).turns.find(t => t.status === 'inProgress'));
    const active = await until(async () => {
      const times = a.locator('.working .turn-time');
      return await times.count() ? times.first().getAttribute('data-turn-id') : null;
    });
    await a.locator('.user-message time').first().waitFor();
    const firstLabel = await a.locator('.working .turn-time').textContent();
    await until(async () => (await a.locator('.working .turn-time').textContent().catch(() => firstLabel)) !== firstLabel, 5000);
    await a.locator('.tool-item').filter({ hasText: '运行中' }).first().waitFor({ timeout: 60000 });
    await b.reload(); await b.locator('.working .turn-time').waitFor();
    assert.equal(await b.locator('.working .turn-time').getAttribute('data-turn-id'), active);
    await api(contexts[0], route + '/messages', 'POST', { text: '继续原任务，回复保持简短。', steer: true });
    assert.equal(await a.locator('.working .turn-time').getAttribute('data-turn-id'), active);
    report.checks.push('真实任务：消息时间、运行计时增长、双账号运行中刷新、追加要求沿用同轮计时'); save();
    await until(async () => (await api(contexts[0], route + '/history?view=timing')).turns.find(t => t.id === active && t.status === 'completed'));
    await a.locator('.turn-time[data-turn-id="' + active + '"][data-duration-ms]').waitFor();
    const timing = (await api(contexts[0], route + '/history?view=timing')).turns.find(t => t.id === active);
    assert.equal(Number(await a.locator('.turn-time[data-turn-id="' + active + '"]').getAttribute('data-duration-ms')), timing.durationMs);
    await a.locator('.tool-duration').first().waitFor();
    const iso = await a.locator('.user-message time').first().getAttribute('datetime');
    assert.equal(await b.locator('.user-message time').first().getAttribute('datetime'), iso);
    assert.notEqual(await a.locator('.user-message time').first().textContent(), await b.locator('.user-message time').first().textContent());
    await a.reload(); await a.locator('.turn-time[data-turn-id="' + active + '"]').waitFor();
    assert.equal(Number(await a.locator('.turn-time[data-turn-id="' + active + '"]').getAttribute('data-duration-ms')), timing.durationMs);
    await a.screenshot({ path: '/tests/test-results/message-time-desktop.png', fullPage: true });
    report.checks.push('完成耗时与执行端毫秒值一致、刷新保持、工具耗时可见、同一时间按东京与UTC分别显示'); save();
    const group = b.locator('.project-group').filter({ hasText: name });
    await group.locator('.project-row').hover();
    await group.getByTitle('创建会话', { exact: true }).click();
    await b.getByRole('dialog').getByRole('textbox').fill('切换检查');
    const createdResponse = b.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${pid}/sessions`));
    await b.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    report.threads.push((await (await createdResponse).json()).session.id); save();
    await until(async () => await b.locator('.session-welcome').count());
    assert.equal(await b.locator('.turn-time').count(), 0);
    // Restore the original selected thread using a new page in the authenticated context.
    await b.reload(); await b.locator('.turn-time[data-turn-id="' + active + '"]').waitFor();
    const stopped = await api(contexts[1], route + '/messages', 'POST', { text: '请执行 sleep 30，再回复结束。' });
    await until(async () => (await api(contexts[1], route + '/history?view=timing')).turns.find(t => t.id === stopped.turnId && t.status === 'inProgress'));
    await b.locator('.working .turn-time').waitFor();
    await api(contexts[1], route + '/stop', 'POST');
    await b.locator('.turn-time[data-turn-id="' + stopped.turnId + '"]').filter({ hasText: '已停止' }).waitFor();
    const stoppedText = await b.locator('.turn-time[data-turn-id="' + stopped.turnId + '"]').textContent();
    await sleep(1300);
    assert.equal(await b.locator('.turn-time[data-turn-id="' + stopped.turnId + '"]').textContent(), stoppedText);
    report.checks.push('切换空会话不串用时，返回恢复历史，真实停止后计时固定'); save();
    let mode = 'gaps';
    await b.route('**/api/projects/*/sessions/*/history?*', async intercepted => {
      const response = await intercepted.fetch(), data = await response.json();
      if (data.items) {
        let i = 0;
        for (const item of [...data.items].reverse()) {
          if (mode === 'legacy') { delete item.startedAtMs; delete item.completedAtMs; }
          else if (['userMessage', 'agentMessage'].includes(item.type)) {
            item.startedAtMs = Date.parse('2026-11-11T23:59:00Z') + i++ * 31 * 60000;
          }
        }
      }
      if (data.turns) for (const turn of data.turns) {
        if (mode === 'legacy') { delete turn.startedAt; delete turn.completedAt; delete turn.durationMs; }
        else if (mode === 'failed') turn.status = 'failed';
      }
      await intercepted.fulfill({ response, json: data });
    });
    await b.reload(); await until(async () => await b.locator('.time-separator').count() >= 3);
    mode = 'failed'; await b.reload(); await b.locator('.turn-time').filter({ hasText: '执行失败' }).first().waitFor();
    mode = 'legacy'; await b.reload(); await b.locator('.user-message').first().waitFor();
    await until(async () => await b.locator('.turn-time').filter({ hasText: '已停止' }).count() > 0);
    assert.equal(await b.locator('.message-time').count(), 0);
    assert.equal(await b.locator('.time-separator').count(), 0);
    assert.equal(await b.locator('.turn-time[data-duration-ms]').count(), 0);
    await b.unrouteAll(); await b.reload(); await b.locator('.message-time').first().waitFor();
    await b.locator('.turn-time[data-turn-id="' + stopped.turnId + '"][data-duration-ms]').waitFor();
    assert.equal(await b.locator('.time-separator time').first().getAttribute('datetime'), await b.locator('.user-message time').first().getAttribute('datetime'));
    await b.setViewportSize({ width: 390, height: 844 });
    await b.locator('.turn-time[data-turn-id="' + stopped.turnId + '"]').scrollIntoViewIfNeeded();
    assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await b.screenshot({ path: '/tests/test-results/message-time-mobile.png', fullPage: true });
    report.checks.push('浏览器响应夹具：长间隔跨天分隔、失败状态、旧记录无时间不补造；手机无横向溢出');
    assert.deepEqual(errors, []); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally {
    save(); for (const threadId of report.threads) await bus.rpc('thread/delete', { threadId }).catch(() => {});
    await bus.rpc('fs/remove', { path: report.cwd, recursive: true }).catch(() => {});
    await bus.close(); await browser.close();
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
