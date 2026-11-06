import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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
  throw new Error('图片验收等待超时');
}
try {
  const credentials = { username: 'image_' + Date.now().toString(36), password: 'Image-input-2026!' };
  await request('/auth/register', 'POST', credentials, 201);
  await request('/auth/login', 'POST', credentials);
  project = (await request('/projects', 'POST', { name: '剪贴板图片验收' }, 201)).project;
  session = (await request(`/projects/${project.id}/sessions`, 'POST', { name: '视觉输入' }, 201)).session;
  const base = `/projects/${project.id}/sessions/${session.id}`;
  await request(base + '/messages', 'POST', { images: ['data:image/png;base64,YWJj'] }, 400);
  await page.goto('http://127.0.0.1:3000');
  const input = page.getByRole('textbox', { name: '发送消息' });
  await input.waitFor();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 300);
    ctx.fillStyle = 'black'; ctx.font = 'bold 60px Arial'; ctx.fillText('PASTE 7391', 60, 90);
    ctx.fillStyle = 'red'; ctx.beginPath(); ctx.moveTo(80, 260); ctx.lineTo(150, 130); ctx.lineTo(220, 260); ctx.fill();
    ctx.fillStyle = 'blue'; ctx.beginPath(); ctx.arc(400, 200, 65, 0, Math.PI * 2); ctx.fill();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  await input.focus(); await input.press('Control+V');
  await page.getByAltText('待发送图片 1').waitFor();
  await page.getByRole('button', { name: '移除图片 1', exact: true }).click();
  assert.equal(await page.getByAltText('待发送图片 1').count(), 0);
  await input.focus(); await input.press('Control+V');
  await page.getByAltText('待发送图片 1').waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible' });
  await until(async () => await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), 30000);
  // Send without text to verify that a clipboard image alone is a valid message.
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(async () => (await request(base + '/history')).turns.some(turn => turn.items?.some(item => item.type === 'userMessage')));
  checks.push('实际 Ctrl+V 粘贴、缩略图移除、仅图片发送通过');
  let history;
  await until(async () => { history = await request(base + '/history'); return history.turns.length > 0 && !history.active; });
  const contents = history.turns.flatMap(turn => turn.items || []);
  const userMessage = contents.find(item => item.type === 'userMessage');
  assert.ok(userMessage.content.some(item => item.type === 'localImage' || item.type === 'image'));
  const answer = contents.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.match(answer, /7391/, answer);
  checks.push('真实远程模型读出图片中的 7391，图片经过 MQTT 和 app-server 成功输入');
  await page.reload();
  const image = page.getByAltText('消息图片 1');
  await image.waitFor();
  await until(async () => image.evaluate(element => element.complete && element.naturalWidth > 0), 30000);
  checks.push('刷新后从 app-server 历史恢复图片，鉴权图片下载正常');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/image-input.png'), fullPage: true });
  await request(`/projects/${project.id}`, 'DELETE'); project = undefined;
} catch (error) {
  console.error('FAIL', error.message); process.exitCode = 1;
} finally {
  if (project && session) await request(`/projects/${project.id}/sessions/${session.id}/stop`, 'POST', {}).catch(() => {});
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/image-input.json'), JSON.stringify({ passed: !process.exitCode, checks }, null, 2), 'utf8');
  checks.forEach(check => console.log('PASS', check));
  await browser.close();
}
