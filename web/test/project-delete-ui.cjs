// Run with the preinstalled Playwright/Chromium against the isolated Compose only.
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');

(async () => {
  const { DesktopBus } = await import('../server/desktop-mqtt.mjs');
  const config = JSON.parse(readFileSync('/tests/test-results/project-delete-config.json', 'utf8'));
  const bus = new DesktopBus(config.mqtt), browser = await chromium.launch({ headless: true });
  const base = 'http://web:31026', name = '项目删除界面-' + randomUUID();
  const report = { cwd: '/workspace/' + name, threads: [], checks: [] }, errors = [];
  const contexts = [], roots = [report.cwd, report.cwd + '-保留项目'];
  const save = () => writeFileSync('/tests/test-results/project-delete-ui.json', JSON.stringify(report, null, 2), 'utf8');
  async function request(context, route, method = 'GET', data, expected = 200) {
    const response = await context.request.fetch(base + '/api' + route, { method, data });
    assert.equal(response.status(), expected, await response.text());
    return response.json();
  }
  try {
    for (let i = 0; !bus.ready() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(bus.ready()); save();
    for (let i = 0; i < 100; i++) {
      if (await fetch(base).then(response => response.ok).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
      const credentials = { username: 'del_ui_' + randomUUID().slice(0, 10), password: randomUUID() };
      await request(context, '/auth/register', 'POST', credentials, 201);
      await request(context, '/auth/login', 'POST', credentials);
    }
    const { project } = await request(contexts[0], '/projects', 'POST', { name }, 201);
    report.threads.push(...project.sessions.map(s => s.id)); save();
    const p = '/projects/' + project.id;
    const extra = await request(contexts[0], p + '/sessions', 'POST', { name: '第二个会话' }, 201);
    report.threads.push(extra.session.id); save();
    const archived = await request(contexts[0], p + '/sessions', 'POST', { name: '已归档会话' }, 201);
    report.threads.push(archived.session.id); save();
    await request(contexts[0], p + '/sessions/' + archived.session.id + '/archive', 'POST');
    const other = await request(contexts[0], '/projects', 'POST', { name: name + '-保留项目' }, 201);
    report.threads.push(...other.project.sessions.map(s => s.id)); save();
    await bus.rpc('fs/writeFile', { path: report.cwd + '/保留.txt', dataBase64: Buffer.from('保留项目文件').toString('base64') });
    const pages = [];
    for (const context of contexts) {
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('.project-group').filter({ has: page.locator('.project-label span', { hasText: name }) }).first().waitFor();
    }
    const group = page => page.locator('.project-group').filter({ has: page.locator('.project-label span').filter({ hasText: new RegExp('^' + name + '$') }) });
    await group(pages[1]).locator('.project-label').click();
    await group(pages[0]).hover();
    await group(pages[0]).getByTitle('删除项目及全部会话', { exact: true }).click();
    const dialog = pages[0].getByRole('dialog');
    await dialog.getByText(/含已归档会话/).waitFor();
    await dialog.getByText(/历史无法恢复/).waitFor();
    await pages[0].screenshot({ path: '/tests/test-results/project-delete-confirm.png', fullPage: true });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    for (const threadId of [project.sessions[0].id, extra.session.id, archived.session.id]) {
      assert.equal((await bus.rpc('thread/read', { threadId })).thread.id, threadId);
    }
    report.checks.push('删除确认明确提示永久删除、已归档会话、共享影响和文件保留；取消无修改');
    const anonymous = await browser.newContext();
    await request(anonymous, p, 'DELETE', undefined, 401); await anonymous.close();
    await group(pages[0]).hover();
    await group(pages[0]).getByTitle('删除项目及全部会话', { exact: true }).click();
    await pages[0].getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await pages[0].getByRole('dialog').waitFor({ state: 'hidden' });
    for (const page of pages) {
      await group(page).waitFor({ state: 'detached' });
      await page.reload(); await group(page).waitFor({ state: 'detached' });
      await page.locator('.project-label span').filter({ hasText: name + '-保留项目' }).waitFor();
    }
    for (const archived of [false, true]) assert.equal((await bus.rpc('thread/list', { cwd: report.cwd, archived })).data.length, 0);
    const file = await bus.rpc('fs/readFile', { path: report.cwd + '/保留.txt' });
    assert.equal(Buffer.from(file.dataBase64, 'base64').toString(), '保留项目文件');
    await bus.rpc('thread/read', { threadId: other.project.sessions[0].id });
    assert.deepEqual(errors, []);
    report.checks.push('浏览器一键删除含归档会话、双账号即时移除且刷新不恢复、其他项目与目录文件保留、未登录拒绝');
    await pages[0].setViewportSize({ width: 390, height: 844 });
    await pages[0].getByRole('button', { name: '展开侧栏', exact: true }).click();
    assert.ok(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await pages[0].screenshot({ path: '/tests/test-results/project-delete-mobile.png', fullPage: true });
    report.checks.push('手机侧栏无横向溢出，浏览器无运行错误'); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally {
    save();
    for (const threadId of report.threads) await bus.rpc('thread/delete', { threadId }).catch(() => {});
    for (const path of roots) await bus.rpc('fs/remove', { path, recursive: true }).catch(() => {});
    await bus.close(); await browser.close();
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
