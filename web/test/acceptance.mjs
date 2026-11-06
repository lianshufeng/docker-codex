import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:3000';
const report = { startedAt: new Date().toISOString(), checks: [], users: [], tasks: [] };
const suffix = Date.now().toString(36);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(500); }
  throw new Error('Acceptance wait timeout');
}
function pass(name) { report.checks.push(name); console.log('PASS', name); }
class Client {
  cookie = ''; events = [];
  async request(url, method = 'GET', body, expected = 200) {
    const response = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0];
    return result;
  }
  async connect() {
    this.socket = new WebSocket('ws://127.0.0.1:3000/events', { headers: { Cookie: this.cookie, Origin: base } });
    this.socket.on('message', buffer => this.events.push(JSON.parse(buffer.toString())));
    this.socket.on('error', () => {});
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
  }
  close() { this.socket?.close(); }
}
async function docker(args) {
  await new Promise((resolve, reject) => {
    const p = spawn('docker', args, { cwd: path.dirname(root), stdio: 'pipe' }); let text = '';
    p.stdout.on('data', b => text += b); p.stderr.on('data', b => text += b);
    p.on('error', reject); p.on('close', code => code === 0 ? resolve() : reject(new Error(text)));
  });
}
const a = new Client(), b = new Client();
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 180000);
  for (const [client, name] of [[a, 'alice'], [b, 'bob']]) {
    const username = `test_${name}_${suffix}`;
    const { user } = await client.request('/auth/register', 'POST', { username, password: 'Test-password-2026' }, 201);
    report.users.push({ ...user, password: 'Test-password-2026' });
    await client.request('/auth/login', 'POST', { username, password: 'Test-password-2026' });
    await client.connect();
  }
  pass('two users register + login + authenticated WebSocket');
  await until(async () => (await a.request('/status')).connected);
  const { project } = await a.request('/projects', 'POST', { name: '远程模型验收项目' }, 201);
  const { project: otherProject } = await b.request('/projects', 'POST', { name: '另一个用户的项目' }, 201);
  const { session } = await a.request(`/projects/${project.id}/sessions`, 'POST', { name: '办公文件验收' }, 201);
  const sbase = `/projects/${project.id}/sessions/${session.id}`;
  const initial = await a.request(sbase + '/history'); assert.deepEqual(initial.turns, []);
  pass('project directory + real thread creation + empty history');
  await b.request(`/projects/${project.id}/files`, 'GET', undefined, 404);
  await b.request(sbase + '/history', 'GET', undefined, 404);
  await b.request(`/projects/${project.id}`, 'DELETE', undefined, 404);
  await a.request(`/projects/${project.id}/files?path=../`, 'GET', undefined, 400);
  await a.request(`/projects/${project.id}/download?path=.web-project.json`, 'GET', undefined, 400);
  pass('cross-user project/history/delete and traversal/internal metadata rejected');
  const prompt = `这是小型Web端到端验收，直接执行命令完成，不要仅给建议。当前cwd就是本项目，禁止修改其他目录。用一个短Python命令创建 office.docx：用python-docx写标题“中文办公验收”和段落“总和：36”。用一个短Node脚本调用已有Playwright浏览器打开https://example.com，保存screenshot.png，读取网页标题并写入browser.json；同一浏览器使用page.pdf生成sample.pdf，再运行pdfinfo检查。最后写result.json为{"total":36,"status":"通过"}。所有JSON UTF-8无BOM。只创建这5个文件和必要脚本，任务简短，完成后回复“验收完成”。如果浏览器网络失败，请明确失败，不可伪造截图。`;
  const { turnId } = await a.request(sbase + '/messages', 'POST', { text: prompt });
  await until(() => a.events.some(e => e.payload?.method === 'item/started' && e.payload.params.turnId === turnId), 120000);
  const early = a.events.find(e => e.payload?.method === 'turn/completed' && e.payload.params.turn.id === turnId);
  if (early) assert.equal(early.payload.params.turn.status, 'completed', JSON.stringify(early));
  await a.request(`/projects/${project.id}`, 'DELETE', undefined, 409);
  await until(() => a.events.some(e => e.payload?.method === 'turn/completed' && e.payload.params.turn.id === turnId), 600000);
  let complete = a.events.find(e => e.payload?.method === 'turn/completed' && e.payload.params.turn.id === turnId);
  assert.equal(complete.payload.params.turn.status, 'completed', JSON.stringify(complete));
  assert.ok(!b.events.some(e => e.type === 'rpc' && e.payload.params?.threadId === session.threadId));
  pass('remote model task completes and events do not leak to second user');
  const history = await a.request(sbase + '/history');
  assert.ok(history.turns.some(t => t.items.some(i => i.type === 'userMessage')));
  assert.ok(history.turns.some(t => t.items.some(i => i.type === 'agentMessage')));
  assert.ok(history.turns.some(t => t.items.some(i => i.type === 'commandExecution')));
  const listed = (await a.request(`/projects/${project.id}/files`)).files;
  for (const name of ['office.docx', 'sample.pdf', 'screenshot.png', 'browser.json', 'result.json']) {
    assert.ok(listed.some(f => f.name === name && f.size > 0), `Missing output ${name}`);
    const response = await fetch(`${base}/api/projects/${project.id}/download?path=${encodeURIComponent(name)}`, { headers: { Cookie: a.cookie } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (name.endsWith('.pdf')) assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    if (name.endsWith('.docx')) assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (name.endsWith('.png')) assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    if (name === 'browser.json') assert.ok(JSON.stringify(JSON.parse(bytes)).includes('Example Domain'));
    if (name === 'result.json') assert.equal(JSON.parse(bytes).total, 36);
  }
  report.tasks.push({ uid: report.users[0].id, projectId: project.id, sessionId: session.id, threadId: session.threadId, turnId });
  pass('browser screenshot + Word + PDF generated and downloaded with valid file signatures');
  a.close(); b.close();
  await docker(['compose', '-f', 'web/docker-compose.yml', 'restart']);
  await until(async () => { try { return (await a.request('/me')).user.id === report.users[0].id; } catch { return false; } }, 120000);
  assert.ok((await a.request('/projects')).projects.some(p => p.id === project.id));
  assert.ok((await a.request(sbase + '/history')).turns.length > 0);
  pass('Web restart preserves login/project mapping and app-server history');
  await a.connect();
  const stopped = await a.request(sbase + '/messages', 'POST', { text: '请执行 python -c "import time; time.sleep(60)"，完成后回复。' });
  await until(() => a.events.some(e => e.payload?.method === 'item/started' && e.payload.params.turnId === stopped.turnId && e.payload.params.item.type === 'commandExecution'), 180000);
  await a.request(sbase + '/stop', 'POST');
  await until(() => a.events.some(e => e.payload?.method === 'turn/completed' && e.payload.params.turn.id === stopped.turnId));
  assert.equal(a.events.find(e => e.payload?.method === 'turn/completed' && e.payload.params.turn.id === stopped.turnId).payload.params.turn.status, 'interrupted');
  pass('running task stops through Web API -> MQTT');
  await a.request(`/projects/${project.id}/files?path=result.json`, 'DELETE');
  await a.request(`/projects/${project.id}/download?path=result.json`, 'GET', undefined, 404);
  await a.request(sbase, 'DELETE');
  assert.equal((await a.request('/projects')).projects.find(p => p.id === project.id).sessions.length, 0);
  await a.request(`/projects/${project.id}`, 'DELETE');
  await b.request(`/projects/${otherProject.id}`, 'DELETE');
  pass('file/session/project deletion reflected on disk and API');
  await b.request('/auth/password', 'POST', { oldPassword: 'Test-password-2026', newPassword: 'Changed-password-2026' });
  await b.request('/auth/login', 'POST', { username: report.users[1].username, password: 'Test-password-2026' }, 401);
  await b.request('/auth/login', 'POST', { username: report.users[1].username, password: 'Changed-password-2026' });
  await b.request('/auth/logout', 'POST'); await b.request('/me', 'GET', undefined, 401);
  pass('change password invalidates old password and logout invalidates session');
  report.passed = true;
} catch (error) { console.error('FAIL', error.message); report.error = error.message; report.passed = false; process.exitCode = 1; }
finally {
  a.close(); b.close(); report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
}
