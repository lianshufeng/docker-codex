import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, connect } from 'node:net';

const { chromium } = createRequire(import.meta.url)('playwright');
const target = new URL(process.argv[2] || 'http://127.0.0.1:3000');
// 使用回环地址保证容器内浏览器的真实剪贴板权限可用。
const tunnel = createServer(socket => {
  const upstream = connect(Number(target.port || 80), target.hostname);
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${tunnel.address().port}`;
const output = path.resolve(process.argv[3] || 'test-results/attachments');
const report = { checks: [], users: [], projects: [], sessions: [], startedAt: new Date().toISOString() };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const other = await browser.newContext();
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
await mkdir(output, { recursive: true });
async function request(client, url, method = 'GET', data, expected = 200) {
  const response = await client.request.fetch(base + '/api' + url, { method, data });
  assert.equal(response.status(), expected, await response.text());
  return response.json();
}
async function until(fn, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('附件验收等待超时');
}
function pass(check) { report.checks.push(check); console.log('PASS', check); }
try {
  await until(async () => {
    try { return (await fetch(base)).ok; } catch { return false; }
  }, 60000);
  for (const [client, tag] of [[context, 'a'], [other, 'b']]) {
    const credentials = { username: `attach_${tag}_${Date.now().toString(36)}`, password: 'Attachment-test-2026!' };
    const { user } = await request(client, '/auth/register', 'POST', credentials, 201);
    report.users.push(user);
    await request(client, '/auth/login', 'POST', credentials);
  }
  await until(async () => (await request(context, '/status')).connected, 60000);
  const { project } = await request(context, '/projects', 'POST', { name: '附件上传独立验收' }, 201);
  report.projects.push(project);
  const { session } = await request(context, `/projects/${project.id}/sessions`, 'POST', { name: '附件读取' }, 201);
  report.sessions.push(session);
  const route = `/projects/${project.id}`;
  const chat = `${route}/sessions/${session.id}`;
  pass('独立用户登录、项目和真实会话创建');
  await page.goto(base);
  const input = page.getByRole('textbox', { name: '发送消息' });
  await input.waitFor();
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 150;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 150);
    ctx.fillStyle = 'black'; ctx.font = 'bold 64px Arial'; ctx.fillText('582764', 40, 100);
    return canvas.toDataURL().split(',')[1];
  }), 'base64');
  const textFile = value => ({ name: '中文报告.txt', mimeType: 'text/plain', buffer: Buffer.from(value) });
  const selected = [textFile('共享目录读取成功 937416'), textFile('同名附件第二份 624819'), { name: '图片.png', mimeType: 'image/png', buffer: png }];
  await page.evaluate(async value => {
    const blob = await (await fetch('data:image/png;base64,' + value)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, png.toString('base64'));
  await input.focus(); await input.press('Control+V');
  await page.getByAltText('待发送图片 1').waitFor();
  await input.press('Control+V');
  await page.getByAltText('待发送图片 2').waitFor();
  await page.getByRole('button', { name: '移除图片 2', exact: true }).click();
  await page.getByRole('button', { name: '移除图片 1', exact: true }).click();
  assert.equal(await page.getByAltText('待发送图片 1').count(), 0);
  pass('真实 Ctrl+V 图片粘贴与附件移除');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await (await chooser).setFiles(selected);
  await page.getByAltText('待发送图片 3').waitFor();
  assert.equal(await page.getByRole('button', { name: /^移除(附件|图片)/ }).count(), 3);
  await input.fill('请实际执行命令读取本条消息附带的两个文本文件，回复其完整内容，并识别图片中的数字。只读取当前项目，不修改文件。');
  await until(async () => page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), 30000);
  const sent = page.waitForResponse(response => response.url().endsWith(chat + '/messages') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const sentResponse = await sent;
  assert.equal(sentResponse.status(), 200, await sentResponse.text());
  pass('加号多选本地中文文本与图片并随消息发送');
  let history;
  await until(async () => { history = await request(context, chat + '/history'); return history.turns.length && !history.active; });
  const items = history.turns.flatMap(turn => turn.items || []);
  const answer = items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.match(answer, /937416/); assert.match(answer, /624819/); assert.match(answer, /582764/);
  assert.ok(items.some(item => item.type === 'commandExecution'));
  pass('真实模型经共享目录读取两份附件并识别图片');
  const root = await request(context, route + '/files');
  assert.ok(root.files.some(file => file.name === 'attachments' && file.directory));
  const days = (await request(context, route + '/files?path=attachments')).files;
  const day = days.find(file => /^\d{8}$/.test(file.name)).name;
  const relative = `attachments/${day}`;
  const listed = (await request(context, route + '/files?path=' + relative)).files;
  assert.ok(listed.some(file => file.name === '中文报告.txt'));
  assert.ok(listed.some(file => file.name === '中文报告1.txt'));
  const shared = `/workspace/${report.users[0].id}/${project.id}/${relative}/中文报告.txt`;
  if (process.platform !== 'win32') assert.equal(await readFile(shared, 'utf8'), '共享目录读取成功 937416');
  const download = await context.request.get(base + '/api' + route + '/download?path=' + encodeURIComponent(relative + '/中文报告1.txt'));
  assert.equal(download.status(), 200); assert.equal(await download.text(), '同名附件第二份 624819');
  pass('日期目录、中文原名、同名数字后缀、下载和挂载目录核对');
  await page.reload();
  await page.getByRole('link', { name: '中文报告1.txt', exact: true }).waitFor();
  const image = page.getByAltText('消息图片 1');
  await image.waitFor();
  await until(async () => image.evaluate(element => element.complete && element.naturalWidth > 0), 30000);
  pass('刷新后从 app-server 历史恢复附件下载和图片预览');
  await request(other, route + '/files', 'GET', undefined, 404);
  await request(other, chat + '/history', 'GET', undefined, 404);
  await request(other, chat + '/messages', 'POST', { files: [{ name: '拒绝.txt', data: 'data:text/plain;base64,YQ==' }] }, 404);
  await request(other, route + '/files?path=attachments', 'DELETE', undefined, 404);
  const denied = await other.request.get(base + '/api' + route + '/download?path=' + encodeURIComponent(relative + '/中文报告.txt'));
  assert.equal(denied.status(), 404);
  await request(context, route + '/files?path=../', 'DELETE', undefined, 400);
  await request(context, chat + '/messages', 'POST', { files: Array(5).fill({ name: '多.txt', data: 'data:text/plain;base64,YQ==' }) }, 400);
  await request(context, chat + '/messages', 'POST', { files: [{ name: '伪装.png', data: 'data:image/png;base64,YWJj' }] }, 400);
  pass('跨用户上传、历史、下载、删除及路径越界和非法附件被拒绝');
  // 两个会话并发上传同名文件，均由服务端分配唯一名称。
  const second = (await request(context, route + '/sessions', 'POST', { name: '并发重名' }, 201)).session;
  report.sessions.push(second);
  const concurrent = { text: '读取附件，回复其内容。', files: [{ name: '并发.txt', data: 'data:text/plain;base64,OTg3NjU0' }] };
  await Promise.all([request(context, chat + '/messages', 'POST', concurrent), request(context, route + '/sessions/' + second.id + '/messages', 'POST', concurrent)]);
  await request(context, route + '/files?path=' + relative, 'DELETE', undefined, 409);
  await until(async () => !(await request(context, chat + '/history')).active && !(await request(context, route + '/sessions/' + second.id + '/history')).active);
  const duplicated = (await request(context, route + '/files?path=' + relative)).files;
  assert.ok(duplicated.some(file => file.name === '并发.txt'));
  assert.ok(duplicated.some(file => file.name === '并发1.txt'));
  pass('不同会话并发重名不覆盖，运行中的文件夹删除被拒绝');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('.file-name').filter({ hasText: 'attachments' }).click();
  await page.locator('.file-name').filter({ hasText: day }).click();
  await page.locator('.file-name').filter({ hasText: '中文报告1.txt' }).waitFor();
  await page.screenshot({ path: path.join(output, 'attachments.png'), fullPage: true });
  await page.locator('.file-path button').click();
  await page.getByRole('button', { name: '删除 ' + day, exact: true }).click();
  await page.getByText('将删除该文件夹及全部内容，无法恢复。', { exact: false }).waitFor();
  const removed = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/files?'));
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  assert.equal((await removed).status(), 200);
  await request(context, route + '/files?path=' + relative, 'GET', undefined, 404);
  await page.getByRole('link', { name: '中文报告.txt', exact: true }).click();
  await page.getByText('文件不存在或已删除', { exact: true }).waitFor();
  assert.deepEqual(failures, []);
  pass('浏览器文件夹图标和导航、递归删除确认及聊天附件失效提示');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; console.error(error); process.exitCode = 1;
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  await browser.close();
  tunnel.close();
}
