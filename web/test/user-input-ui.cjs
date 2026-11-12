// Isolated Compose only. Uses the real app-server and a deterministic Responses provider.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { chromium } = require('/usr/local/lib/node_modules/playwright');

(async () => {
  const { DesktopBus } = await import('../server/desktop-mqtt.mjs');
  const { projectId } = await import('../server/app-workspace.mjs');
  const config = JSON.parse(readFileSync('/tests/test-results/input-config.json', 'utf8'));
  const bus = new DesktopBus(config.mqtt), browser = await chromium.launch({ headless: true });
  const report = { run: randomUUID(), cwd: '', threads: [], accounts: [], checks: [] };
  const base = 'http://web:31029', pages = [], contexts = [], errors = [];
  const save = () => {
    const data = JSON.stringify(report, null, 2);
    writeFileSync('/tests/test-results/input-ui.json', data, 'utf8');
    writeFileSync(`/tests/test-results/input-ui-${report.run}.json`, data, 'utf8');
  };
  async function until(fn, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw Error('交互验收等待超时');
  }
  async function api(context, route, method = 'GET', data, expected = 200) {
    const response = await context.request.fetch(base + '/api' + route, { method, data });
    assert.equal(response.status(), expected, `${route}: ${await response.text()}`);
    return response.json();
  }
  const card = page => page.locator('.question-card').first();
  async function screen(page, name) { await page.screenshot({ path: `/tests/test-results/input-${name}.png`, fullPage: true }); }
  async function openThread(page, user, pid, sid) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: 'codex-selection-' + user.id, value: { pid, sid } });
    await page.reload(); await page.getByRole('textbox', { name: '发送消息' }).waitFor();
  }
  try {
    await until(() => bus.ready());
    await until(() => fetch(base).then(r => r.ok).catch(() => false));
    report.cwd = '/workspace/input-ui-' + report.run; save();
    await bus.rpc('fs/createDirectory', { path: report.cwd });
    const provider = (await bus.rpc('config/read')).config.model_provider;
    const threadConfig = {
      [`model_providers.${provider}.base_url`]: 'http://codex-input-provider:38119/v1',
      [`model_providers.${provider}.requires_openai_auth`]: false,
      [`model_providers.${provider}.supports_websockets`]: false,
      'features.default_mode_request_user_input': true,
      'features.send_message_to_user_async': true,
    };
    async function newThread(name, model = 'gpt-5.4') {
      const { thread } = await bus.rpc('thread/start', { cwd: report.cwd, model, config: threadConfig,
        approvalPolicy: 'never', sandbox: 'danger-full-access' });
      report.threads.push(thread.id); save();
      await bus.rpc('thread/name/set', { threadId: thread.id, name });
      return thread.id;
    }
    const sid = await newThread('同步提问验收'), other = await newThread('异步提问验收', 'gpt-6.1-sol'), pid = projectId(report.cwd);
    await bus.rpc('turn/start', { threadId: other, input: [{ type: 'text', text: '验收准备' }] });
    await until(async () => (await bus.rpc('thread/read', { threadId: other })).thread.status.type === 'idle');
    const route = `/projects/${pid}/sessions/${sid}`, asyncRoute = `/projects/${pid}/sessions/${other}`;
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
      const credentials = { username: 'input_' + randomUUID().slice(0, 10), password: randomUUID() };
      report.accounts.push(credentials.username); save();
      await api(context, '/auth/register', 'POST', credentials, 201);
      const { user } = await api(context, '/auth/login', 'POST', credentials); context.user = user;
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base); await page.getByRole('textbox', { name: '发送消息' }).waitFor();
      await openThread(page, user, pid, sid);
    }
    const [a, b] = pages;
    await api(contexts[0], route + '/messages', 'POST', { text: 'INPUT_SYNC', plan: true });
    await card(a).getByRole('radio', { name: /浅色/ }).waitFor();
    await card(b).getByRole('radio', { name: /浅色/ }).waitFor();
    assert.ok(await a.locator('.question-waiting').count());
    await card(a).getByRole('radio', { name: /浅色/ }).check();
    await card(a).getByLabel('自行填写或补充说明').fill('保留的中文备注');
    await a.locator('.session-row').filter({ hasText: '异步提问验收' }).locator('button').first().click();
    await a.locator('.breadcrumb strong').filter({ hasText: '异步提问验收' }).waitFor();
    assert.equal(await a.locator('.question-card').count(), 0);
    await a.locator('.session-row').filter({ hasText: '同步提问验收' }).locator('button').first().click();
    await card(a).getByLabel('自行填写或补充说明').waitFor();
    assert.equal(await card(a).getByLabel('自行填写或补充说明').inputValue(), '保留的中文备注');
    await screen(a, 'sync-dark');
    await a.evaluate(() => window.assistantTheme.setMode('light')); await screen(a, 'sync-light');
    await a.reload(); await card(a).waitFor();
    const generation = (await api(contexts[0], '/status')).runId;
    report.phase = 'restart-web'; report.generation = generation; save(); console.log('RESTART_WEB');
    await until(async () => { try { return (await api(contexts[0], '/status')).runId !== generation; } catch { return false; } }, 90000);
    await until(async () => await card(a).getByRole('button', { name: '跳过', exact: true }).isEnabled().catch(() => false));
    await a.reload(); await card(a).waitFor();
    report.checks.push('真实同步请求、两账号同显、切换会话保留草稿、刷新及Web进程重启恢复'); save();
    await contexts[0].setOffline(true);
    await until(async () => !await card(a).getByRole('radio', { name: /浅色/ }).isEnabled());
    await contexts[0].setOffline(false);
    await until(async () => await card(a).getByRole('radio', { name: /浅色/ }).isEnabled());
    await card(a).getByRole('radio', { name: /浅色/ }).check();
    await card(a).getByLabel('自行填写或补充说明').fill('提交中文备注');
    await card(a).getByRole('button', { name: '下一题', exact: true }).click();
    await card(a).getByLabel('自行填写或补充说明').fill('自由回答');
    await a.setViewportSize({ width: 390, height: 844 }); await screen(a, 'sync-mobile-light');
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await a.evaluate(() => window.assistantTheme.setMode('dark')); await screen(a, 'sync-mobile-dark');
    await card(a).getByRole('button', { name: '发送', exact: true }).click();
    await until(async () => !await a.locator('.question-card').count() && !await b.locator('.question-card').count());
    await until(async () => (await api(contexts[1], route + '/history?view=items')).items.some(item => item.text?.includes('提交中文备注')));
    report.checks.push('断网禁用、重连恢复、多题选项和备注及自由回答、两账号同步关闭，模型接口收到答案'); save();
    await a.setViewportSize({ width: 1440, height: 1000 });
    // A second real request tests empty answers and competing responses.
    await api(contexts[0], route + '/messages', 'POST', { text: 'INPUT_SYNC', plan: true });
    await card(a).waitFor(); await card(b).waitFor();
    const history = await api(contexts[0], route + '/history?view=items'), request = history.approvals[0];
    const data = { requestId: request.id, answers: { theme: { answers: [] }, secret: { answers: [] } } };
    const results = await Promise.all(contexts.map(context => context.request.post(base + '/api' + route + '/approval', { data })));
    assert.deepEqual(results.map(r => r.status()).sort(), [200, 404]);
    await until(async () => !await a.locator('.question-card').count() && !await b.locator('.question-card').count());
    await until(async () => (await api(contexts[0], route + '/history?view=timing')).turns[0].status === 'completed');
    await api(contexts[0], route + '/messages', 'POST', { text: 'INPUT_SYNC', plan: true });
    await card(a).waitFor();
    await card(a).getByRole('button', { name: '跳过', exact: true }).click();
    await card(a).getByRole('button', { name: '上一题', exact: true }).waitFor();
    await card(a).getByRole('button', { name: '跳过', exact: true }).click();
    await until(async () => !await a.locator('.question-card').count());
    await until(async () => (await api(contexts[0], route + '/history?view=timing')).turns[0].status === 'completed');
    await api(contexts[0], route + '/messages', 'POST', { text: 'INPUT_SYNC', plan: true });
    await card(a).waitFor();
    const stale = (await api(contexts[0], route + '/history?view=items')).approvals[0];
    await api(contexts[0], route + '/stop', 'POST');
    await until(async () => !await a.locator('.question-card').count());
    await api(contexts[0], route + '/approval', 'POST', { requestId: stale.id, answers: {} }, 404);
    report.checks.push('双账号并发只提交一次、空答案及逐题跳过、停止后旧请求拒绝'); save();
    for (let i = 0; i < 2; i++) await openThread(pages[i], contexts[i].user, pid, other);
    await api(contexts[0], asyncRoute + '/messages', 'POST', { text: 'INPUT_ASYNC' });
    await card(a).getByRole('radio', { name: '浅色', exact: true }).waitFor({ timeout: 30000 });
    await card(b).waitFor();
    await until(async () => await card(a).getByRole('radio', { name: '浅色', exact: true }).isEnabled());
    await a.reload(); await card(a).waitFor();
    await screen(a, 'async-desktop');
    await card(a).getByRole('radio', { name: '浅色', exact: true }).check();
    await card(a).getByRole('button', { name: '发送', exact: true }).click();
    await until(async () => !await a.locator('.question-card').count() && !await b.locator('.question-card').count());
    await until(async () => (await api(contexts[1], asyncRoute + '/history?view=items')).items.some(item => item.text?.includes('异步回答已到达模型接口')));
    await a.reload(); await a.getByRole('textbox', { name: '发送消息' }).waitFor();
    assert.equal(await a.locator('.question-card').count(), 0);
    assert.ok((await a.locator('.question-answer').textContent()).includes('浅色'));
    report.checks.push('真实app-server异步提问、刷新恢复、原生回答标记到达模型接口、其他账号及刷新后不重复提问'); save();
    await api(contexts[0], asyncRoute + '/messages', 'POST', { text: 'INPUT_ASYNC' });
    await card(a).waitFor();
    await until(async () => await card(a).getByRole('button', { name: '发送', exact: true }).isEnabled().catch(() => false) ||
      await card(a).getByRole('radio', { name: '浅色', exact: true }).isEnabled());
    await card(a).getByRole('button', { name: '跳过', exact: true }).click();
    assert.equal(await a.locator('.question-card').count(), 0);
    assert.equal(await b.locator('.question-card').count(), 1);
    await a.reload(); await card(a).waitFor();
    report.checks.push('异步跳过遵循上游语义，仅关闭当前页面，另一账号及刷新后仍可回答'); save();
    await openThread(a, contexts[0].user, pid, sid);
    await api(contexts[0], route + '/messages', 'POST', { text: 'INPUT_SYNC', plan: true });
    await card(a).waitFor();
    const oldRequest = (await api(contexts[0], route + '/history?view=items')).approvals[0];
    const oldGeneration = (await api(contexts[0], '/status')).runId;
    report.phase = 'restart-executor'; save(); console.log('RESTART_EXECUTOR');
    await until(async () => { const status = await api(contexts[0], '/status'); return status.connected && status.runId !== oldGeneration; }, 90000);
    await until(async () => !await a.locator('.question-card').count());
    await api(contexts[0], route + '/approval', 'POST', { requestId: oldRequest.id, answers: {} }, 404);
    report.checks.push('执行端重启使旧同步请求失效，页面清理且后端拒绝旧答案'); save();
    // Protocol edge cases are explicit browser fixtures, separate from the real app-server checks above.
    let fixture = { id: 7001, method: 'item/tool/requestUserInput', params: { threadId: sid, turnId: 'fixture', isBlocking: true,
      questions: [{ id: 'secret', header: '密码', question: '请输入测试口令', isSecret: true, options: null }] } };
    let sent, failOnce = true;
    await a.route(/\/history\?view=items/, async intercepted => {
      await intercepted.fulfill({ json: { items: [], nextCursor: null, active: false, approvals: [fixture] } });
    });
    await a.route('**/approval', async intercepted => {
      if (failOnce) { failOnce = false; return intercepted.abort(); }
      sent = intercepted.request().postDataJSON();
      await intercepted.fulfill({ json: { ok: true } });
    });
    await a.reload(); await card(a).waitFor();
    const secret = card(a).getByLabel('填写回答');
    assert.equal(await secret.getAttribute('type'), 'password');
    await secret.fill('仅验收使用的口令');
    await secret.press('Enter');
    await card(a).getByRole('alert').waitFor();
    assert.equal(await secret.inputValue(), '仅验收使用的口令');
    await card(a).getByRole('button', { name: '发送', exact: true }).click();
    await until(() => sent);
    assert.deepEqual(sent.answers, { secret: { answers: ['user_note: 仅验收使用的口令'] } });
    sent = null;
    fixture = { ...fixture, id: 7002, params: { ...fixture.params, isBlocking: false } };
    await a.clock.install();
    await a.reload(); await card(a).waitFor();
    await a.clock.fastForward(61000);
    await card(a).getByRole('status').filter({ hasText: '自动跳过' }).waitFor();
    await a.clock.fastForward(61000); await until(() => sent);
    assert.deepEqual(sent.answers, {});
    await a.clock.resume();
    report.checks.push('浏览器协议夹具验证敏感输入、键盘提交、失败保留与重试、非阻塞问题120秒自动空答案'); save();
    const anon = await browser.newContext();
    await api(anon, route + '/history?view=items', 'GET', undefined, 401);
    await api(anon, route + '/approval', 'POST', { requestId: 1, answers: {} }, 401);
    assert.deepEqual(errors, []); report.passed = true; report.phase = 'complete';
  } catch (e) {
    report.passed = false; report.error = e.stack;
    if (pages[0]) await screen(pages[0], 'failure').catch(() => {});
    throw e;
  } finally {
    for (const threadId of report.threads) {
      try {
        const { thread } = await bus.rpc('thread/read', { threadId, includeTurns: true });
        for (const turn of thread.turns || []) if (turn.status === 'inProgress') await bus.rpc('turn/interrupt', { threadId, turnId: turn.id });
        await bus.rpc('thread/delete', { threadId });
      } catch (e) { report.cleanupError = e.message; }
    }
    if (report.cwd && !report.cleanupError) await bus.rpc('fs/remove', { path: report.cwd, recursive: true }).catch(e => { report.cleanupError = e.message; });
    save(); await bus.close(); await browser.close();
  }
  console.log(JSON.stringify(report));
})().catch(e => { console.error(e); process.exitCode = 1; });
