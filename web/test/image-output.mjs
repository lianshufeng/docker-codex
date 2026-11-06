import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let project, session;
async function request(url, method = 'GET', data, expected = 200) {
  const response = await context.request.fetch('http://127.0.0.1:3000/api' + url, { method, data });
  const result = await response.json();
  assert.equal(response.status(), expected, JSON.stringify(result));
  return result;
}
async function until(fn, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('图片显示验收等待超时');
}
try {
  await until(async () => { try { return (await fetch('http://127.0.0.1:3000')).ok; } catch { return false; } });
  const credentials = { username: 'output_' + Date.now().toString(36), password: 'Image-output-2026!' };
  const user = (await request('/auth/register', 'POST', credentials, 201)).user;
  await request('/auth/login', 'POST', credentials);
  project = (await request('/projects', 'POST', { name: '回复图片验收' }, 201)).project;
  session = (await request(`/projects/${project.id}/sessions`, 'POST', { name: '真实网页截图' }, 201)).session;
  const base = `/projects/${project.id}/sessions/${session.id}`;
  await page.goto('http://127.0.0.1:3000');
  const input = page.getByRole('textbox', { name: '发送消息' });
  await input.waitFor();
  await until(async () => (await request('/status')).connected);
  await request(base + '/messages', 'POST', { text: '请直接执行一个简短任务：使用已有 Playwright 浏览器打开 https://example.com，截图保存到当前项目的“网页截图.png”，不可伪造截图。完成后最终回复必须包含两种Markdown：第一行 ![网页截图](./网页截图.png)，第二行 [打开截图](当前工作目录的绝对路径/网页截图.png)，请替换成实际绝对路径。不要创建其他文件。' });
  let history;
  await until(async () => { history = await request(base + '/history'); return history.turns.length && !history.active; });
  const answer = history.turns.flatMap(turn => turn.items || []).filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.match(answer, /网页截图\.png/, answer);
  const images = page.locator('.agent-message .reply-image img');
  await until(async () => await images.count() >= 2 && images.evaluateAll(nodes => nodes.every(image => image.complete && image.naturalWidth > 0)), 30000);
  checks.push('真实远程任务生成网页截图，相对路径 Markdown 图片及绝对路径图片链接即时显示');
  const absolute = `/workspace/${user.id}/${project.id}/网页截图.png`;
  for (const value of ['网页截图.png', absolute, 'sandbox:' + absolute, 'file://' + encodeURI(absolute)]) {
    const response = await context.request.get(`http://127.0.0.1:3000/api/projects/${project.id}/image?path=${encodeURIComponent(value)}`);
    assert.equal(response.status(), 200, value);
    assert.match(response.headers()['content-type'], /image\/png/);
    assert.match(response.headers()['content-disposition'], /inline/);
    assert.equal((await response.body()).subarray(1, 4).toString(), 'PNG');
  }
  for (const value of ['../private.png', '/etc/private.png', '.web-project.json']) {
    const response = await context.request.get(`http://127.0.0.1:3000/api/projects/${project.id}/image?path=${encodeURIComponent(value)}`);
    assert.ok([400, 403, 404].includes(response.status()), value);
  }
  const other = await browser.newContext();
  const credentials2 = { username: 'other_' + Date.now().toString(36), password: 'Image-output-2026!' };
  for (const action of ['register', 'login']) assert.ok((await other.request.post('http://127.0.0.1:3000/api/auth/' + action, { data: credentials2 })).ok());
  assert.equal((await other.request.get(`http://127.0.0.1:3000/api/projects/${project.id}/image?path=网页截图.png`)).status(), 404);
  await other.close();
  checks.push('中文路径、file/sandbox 路径正常，越界路径与跨用户图片请求被拒绝');
  await page.reload();
  await until(async () => await images.count() >= 2 && images.evaluateAll(nodes => nodes.every(image => image.complete && image.naturalWidth > 0)), 30000);
  checks.push('刷新页面后历史回复图片正常回显');
  // Browser-only fixture checks remote links and graceful failure without external network dependency.
  const png = await (await context.request.get(`http://127.0.0.1:3000/api/projects/${project.id}/image?path=网页截图.png`)).body();
  await page.route('https://image-test.invalid/remote.png', route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route('**/history', async route => {
    const response = await route.fetch(); const result = await response.json();
    result.turns[0].items.push({ id: 'image-fixture', type: 'agentMessage', text: '![远程图片](https://image-test.invalid/remote.png)\n\n![不存在的图片](missing.png)' });
    await route.fulfill({ response, json: result });
  });
  await page.reload();
  await until(async () => page.getByAltText('远程图片').evaluate(image => image.complete && image.naturalWidth > 0), 30000);
  await page.getByText('图片暂不可用，点击重试：不存在的图片').waitFor();
  checks.push('远程图片地址可加载，缺失图片显示可理解的提示');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/image-output.png'), fullPage: true });
  await request(`/projects/${project.id}`, 'DELETE'); project = undefined;
} catch (error) {
  console.error('FAIL', error.message); process.exitCode = 1;
} finally {
  if (project && session) await request(`/projects/${project.id}/sessions/${session.id}/stop`, 'POST', {}).catch(() => {});
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/image-output.json'), JSON.stringify({ passed: !process.exitCode, checks }, null, 2), 'utf8');
  checks.forEach(check => console.log('PASS', check));
  await browser.close();
}
