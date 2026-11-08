// Run inside the isolated Codex image with its existing Playwright and Chromium.
const { chromium } = require('playwright');
const mqtt = require('/opt/codex-mqtt/node_modules/mqtt');
const { randomUUID } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cwd = '/workspace/shared-ui-' + randomUUID();
  const report = { cwd, checks: [], threads: [] };
  const client = mqtt.connect('mqtt://mqtt:1883', { username: 'admin', password: 'admin@2026', protocolVersion: 5 });
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  await client.subscribeAsync('codex/admin/reply/+');
  async function rpc(method, params) {
    const id = 'ui-' + randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.off('message', receive); reject(new Error('RPC timeout')); }, 20000);
      function receive(topic, bytes) { if (topic !== 'codex/admin/reply/' + id) return;
        clearTimeout(timer); client.off('message', receive); const result = JSON.parse(bytes); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); }
      client.on('message', receive); client.publish('codex/admin/command', JSON.stringify({ id, method, params }), { qos: 1 });
    });
  }
  try {
    await page.goto('http://web:31021');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByLabel('账号', { exact: true }).fill('ui_' + randomUUID().slice(0, 12));
    await page.getByLabel('密码', { exact: true }).fill(randomUUID());
    await page.getByRole('button', { name: '注册并登录' }).click();
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill(cwd.split('/').at(-1));
    assert.equal(await page.getByText('执行端已有目录的绝对路径').count(), 0);
    await page.screenshot({ path: '/tmp/project-name-dialog.png', fullPage: true });
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const projects = await (await context.request.get('http://web:31021/api/projects')).json();
    const project = projects.projects.find(p => p.cwd === cwd);
    assert.ok(project); report.threads = project.sessions.map(s => s.id);
    report.checks.push('浏览器注册、创建远端目录和会话');
    await page.locator('input[type=file]').evaluate((element) => {
      const input = element;
      const selection = new DataTransfer();
      selection.items.add(new File(['编号=UI7391'], '界面输入.txt', { type: 'text/plain' }));
      selection.items.add(new File([new Uint8Array(100 * 1024 * 1024).fill(37)], '界面大文件.bin', { type: 'application/octet-stream' }));
      input.files = selection.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('.file-attachment').filter({ hasText: '界面大文件.bin' }).waitFor({ timeout: 120000 });
    await page.getByRole('textbox', { name: '发送消息' }).fill('只读取文本附件，回复编号UI7391和界面验收通过，不读取大二进制附件，不修改文件。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('.agent-message').filter({ hasText: 'UI7391' }).first().waitFor({ timeout: 120000 });
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor({ state: 'hidden', timeout: 120000 });
    assert.equal(await page.locator('.message-file a').count(), 2);
    const large = page.getByRole('link', { name: '界面大文件.bin', exact: true });
    const range = await context.request.get(new URL(await large.getAttribute('href'), page.url()).href, { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status(), 206);
    assert.deepEqual(await range.body(), Buffer.alloc(16, 37));
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: '界面输入.txt', exact: true }).click(); await download;
    await page.reload();
    await page.getByRole('link', { name: '界面大文件.bin', exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/shared-ui-desktop.png', fullPage: true });
    report.checks.push('浏览器上传100MiB、附件引用、Range下载、真实任务与刷新历史');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('complementary', { name: '项目与会话' }).waitFor();
    await page.screenshot({ path: '/tmp/shared-ui-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    report.checks.push('手机侧栏与页面无横向溢出、无前端运行错误'); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message;
    report.uiErrors = await page.locator('.inline-error, .error-banner, [role=alert]').allTextContents();
    report.pageErrors = errors;
    await page.screenshot({ path: '/tmp/shared-ui-failure.png', fullPage: true }); throw error; }
  finally {
    for (const id of report.threads) await rpc('thread/delete', { threadId: id }).catch(() => {});
    await rpc('fs/remove', { path: cwd, recursive: true }).catch(() => {});
    await writeFile('/tmp/shared-ui-acceptance.json', JSON.stringify(report, null, 2), 'utf8');
    await client.endAsync(true); await browser.close(); console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
