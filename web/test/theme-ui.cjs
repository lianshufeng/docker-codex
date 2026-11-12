// Run only in the isolated theme Compose with the image's preinstalled browser.
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { crc32, deflateSync } = require('node:zlib');

function previewPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(160); header.writeUInt32BE(96, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(481 * 96, 210); for (let row = 0; row < 96; row++) pixels[row * 481] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

(async () => {
  const { DesktopBus } = await import('../server/desktop-mqtt.mjs');
  const config = JSON.parse(readFileSync('/tests/test-results/theme-config.json', 'utf8'));
  const bus = new DesktopBus(config.mqtt), browser = await chromium.launch({ headless: true });
  const base = 'http://web:31028', name = '主题验收-' + randomUUID();
  const fixture = process.argv.includes('--fixture');
  const report = { cwd: '/workspace/' + name, threads: [], accounts: [], checks: [], fixture }, errors = [];
  const save = () => {
    const json = JSON.stringify(report, null, 2);
    writeFileSync(`/tests/test-results/theme-ui${fixture ? '-fixture' : ''}.json`, json, 'utf8');
    writeFileSync(`/tests/test-results/theme-run-${name.slice('主题验收-'.length)}.json`, json, 'utf8');
  };
  async function until(fn, timeout = 360000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 300)); }
    throw Error('主题验收等待超时');
  }
  async function api(context, route, method = 'GET', data, expected = 200) {
    const response = await context.request.fetch(base + '/api' + route, { method, data });
    assert.equal(response.status(), expected, await response.text()); return response.json();
  }
  const theme = page => page.locator('html').getAttribute('data-theme');
  async function rendered(page) {
    // React Suspense uses timers; advance the paused browser clock while chunks load.
    await until(async () => { await page.clock.runFor(100); return await page.locator('.markdown-table').count(); }, 20000);
  }
  async function appearance(page, value) {
    if (!await page.locator('.theme-options').count()) await page.locator('.user-button').click();
    await page.getByRole('button', { name: value, exact: true }).click();
  }
  try {
    await until(() => bus.ready(), 20000);
    await until(() => fetch(base).then(r => r.ok).catch(() => false), 30000);
    const contexts = [], pages = [];
    for (const timezoneId of ['Asia/Tokyo', 'UTC']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId });
      contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      const suffix = timezoneId === 'UTC' ? 'Z' : '+09:00';
      await page.clock.install({ time: new Date('2026-11-12T19:59:50' + suffix) });
      await page.clock.pauseAt(new Date('2026-11-12T19:59:59' + suffix));
      await page.goto(base); await page.locator('.auth-card').waitFor();
      assert.equal(await theme(page), 'light');
      await page.clock.fastForward(1100); assert.equal(await theme(page), 'dark');
      await appearance(page, '浅色'); await page.clock.fastForward(12 * 3600000); assert.equal(await theme(page), 'light');
      await page.reload(); assert.equal(await theme(page), 'light');
      await page.screenshot({ path: `/tests/test-results/theme-login-${timezoneId === 'UTC' ? 'utc' : 'tokyo'}.png`, fullPage: true });
      const credentials = { username: 'theme_' + randomUUID().slice(0, 10), password: randomUUID() };
      report.accounts.push(credentials.username); save();
      await api(context, '/auth/register', 'POST', credentials, 201);
      const { user } = await api(context, '/auth/login', 'POST', credentials);
      context.user = user;
    }
    report.checks.push('东京及UTC本地20点自动切换，手动浅色跨时段保持，刷新恢复，登录页浅色截图'); save();
    const { project } = await api(contexts[0], '/projects', 'POST', { name }, 201);
    report.threads.push(...project.sessions.map(s => s.id)); save();
    const pid = project.id, sid = project.sessions[0].id, route = `/projects/${pid}/sessions/${sid}`;
    await bus.rpc('fs/writeFile', { path: `${report.cwd}/共享中文.txt`, dataBase64: Buffer.from('主题共享文件7391').toString('base64') });
    await bus.rpc('fs/writeFile', { path: `${report.cwd}/预览.png`, dataBase64: previewPng() });
    for (let i = 0; i < pages.length; i++) {
      assert.ok((await api(contexts[i], '/projects')).projects.some(p => p.id === pid));
      await pages[i].evaluate(({ key, value }) => localStorage.setItem(key, value), { key: 'codex-selection-' + contexts[i].user.id, value: JSON.stringify({ pid, sid }) });
      await pages[i].reload(); await pages[i].getByRole('textbox', { name: '发送消息' }).waitFor();
    }
    const [a, b] = pages;
    const anon = await browser.newContext();
    await api(anon, '/projects', 'GET', undefined, 401);
    await api(anon, `/projects/${pid}/download?path=${encodeURIComponent('共享中文.txt')}`, 'GET', undefined, 401);
    assert.equal(await (await contexts[1].request.get(base + `/api/projects/${pid}/download?path=${encodeURIComponent('共享中文.txt')}`)).text(), '主题共享文件7391');
    let task;
    if (fixture) {
      // Only rendering is simulated; login, projects, files and authentication use real APIs.
      for (const page of pages) await page.route(/\/api\/projects\/[^/]+\/sessions\/[^/]+\/history(?:\?|$)/, async intercepted => {
        if (!new URL(intercepted.request().url()).searchParams.has('view') || new URL(intercepted.request().url()).searchParams.get('view') !== 'items') return intercepted.continue();
        await intercepted.fulfill({ status: 200, json: { items: [{ id: 'theme-render-fixture', type: 'agentMessage', text: '主题样式夹具7391\n\n| 项目 | 状态 |\n|---|---|\n| 外观 | 正常 |\n\n```javascript\nconst theme = "light"; // 中文注释\nconsole.log(theme);\n```\n\n![附件预览](预览.png)', completedAtMs: Date.now() }], nextCursor: null, active: false, approvals: [] } });
      });
      await a.reload(); await a.getByRole('textbox', { name: '发送消息' }).waitFor();
    } else {
      task = await api(contexts[0], route + '/messages', 'POST', { text: '只回复“主题验收通过7391”，附一个两列表格和一个JavaScript代码块，不执行工具，不修改文件。' });
      report.turnId = task.turnId; save();
      await a.locator('.working').waitFor({ timeout: 60000 });
    }
    await a.getByRole('textbox', { name: '发送消息' }).fill('切换主题后仍保留的草稿');
    await appearance(a, '深色'); await appearance(a, '浅色');
    assert.equal(await a.getByRole('textbox', { name: '发送消息' }).inputValue(), '切换主题后仍保留的草稿');
    if (task) await until(async () => (await api(contexts[1], route + '/history?view=timing')).turns.some(t => t.id === task.turnId && t.status === 'completed'));
    await rendered(a);
    await b.reload(); await rendered(b);
    if (fixture) await until(async () => { await a.clock.runFor(100); return a.locator('.reply-image img').evaluateAll(images => images.some(image => image.complete && image.naturalWidth === 160)); }, 10000);
    if (task) assert.ok((await api(contexts[1], route + '/history')).items.some(item => JSON.stringify(item).includes('7391')));
    report.checks.push(fixture ? '真实双账号共享会话文件和登录保护；Markdown响应夹具验证主题切换及草稿保持' : '双账号共享会话文件与真实任务历史，未登录接口拒绝，运行中切换保留草稿且任务完成'); save();
    const secondTab = await contexts[0].newPage(); await secondTab.goto(base);
    await secondTab.getByRole('textbox', { name: '发送消息' }).waitFor();
    await appearance(a, '深色'); await until(async () => await theme(secondTab) === 'dark', 10000);
    await appearance(a, '浅色'); await until(async () => await theme(secondTab) === 'light', 10000);
    await a.getByRole('button', { name: '深色', exact: true }).focus(); await a.keyboard.press('Enter');
    assert.equal(await theme(a), 'dark');
    for (const value of ['浅色', '深色']) {
      await appearance(a, value);
      await a.screenshot({ path: `/tests/test-results/theme-desktop-${value === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
      assert.equal(await a.locator('.main').evaluate(el => getComputedStyle(el).backgroundColor), value === '浅色' ? 'rgb(255, 255, 255)' : 'rgb(27, 27, 27)');
      await a.locator('.user-button').click();
      await a.getByRole('button', { name: '文件', exact: true }).click();
      await a.locator('.file-panel').waitFor();
      await a.getByTitle('共享中文.txt', { exact: true }).waitFor();
      await a.screenshot({ path: `/tests/test-results/theme-files-${value === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
      await a.getByTitle('关闭文件', { exact: true }).click();
      await a.locator('.user-button').click(); await a.getByRole('button', { name: '修改密码' }).click();
      await a.screenshot({ path: `/tests/test-results/theme-dialog-${value === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
      await a.getByRole('button', { name: '取消', exact: true }).click();
    }
    report.checks.push('多标签页同步，浅深色聊天、表格、代码、文件面板和弹窗截图'); save();
    await appearance(a, '自动');
    await a.clock.setSystemTime(new Date('2026-11-13T07:59:59+09:00')); await a.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await theme(a), 'dark'); await a.clock.fastForward(1100); assert.equal(await theme(a), 'light');
    await a.clock.setSystemTime(new Date('2026-11-13T23:00:00+09:00')); await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await theme(a), 'dark');
    await a.reload(); await a.getByRole('textbox', { name: '发送消息' }).waitFor(); await rendered(a);
    await a.setViewportSize({ width: 390, height: 844 });
    for (const value of ['浅色', '深色']) {
      await a.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await appearance(a, value);
      assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await a.screenshot({ path: `/tests/test-results/theme-mobile-menu-${value === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
      await a.locator('.mobile-backdrop').click({ position: { x: 380, y: 50 } });
      await a.screenshot({ path: `/tests/test-results/theme-mobile-${value === '浅色' ? 'light' : 'dark'}.png`, fullPage: true });
    }
    report.checks.push('浏览器虚拟时钟验证08点边界及后台恢复，手机两种主题无横向溢出');
    assert.deepEqual(errors, []); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally {
    save();
    for (const threadId of report.threads) {
      try {
        if (report.turnId) await bus.rpc('turn/interrupt', { threadId, turnId: report.turnId }).catch(() => {});
        await bus.rpc('thread/delete', { threadId });
      } catch (error) { report.cleanupError = error.message; }
    }
    if (report.threads.length) await bus.rpc('fs/remove', { path: report.cwd, recursive: true }).catch(() => {});
    save(); await bus.close(); await browser.close();
  }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
