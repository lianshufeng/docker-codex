// Only run against an isolated development app-server. Creates and deletes its own directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DesktopBus } from '../server/desktop-mqtt.mjs';
import { projectId } from '../server/app-workspace.mjs';
import { WebSocket } from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:31021';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const bus = new DesktopBus({ ...config.mqtt, url: process.argv[3] || 'mqtt://127.0.0.1:18884' });
const cwd = `${process.argv[4] || '/workspace'}/shared-acceptance-${randomUUID()}`;
const report = { checks: [], cwd, threads: [] };
const accounts = [{}, {}];
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(500); }
  throw new Error('验收等待超时');
}
async function api(user, route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + '/api' + route, { method, headers: { cookie: user.cookie || '', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  assert.equal(response.status, expected, `${method} ${route}: ${raw.slice(0, 300)}`);
  return data;
}
function pass(name) { report.checks.push(name); console.log('PASS', name); }
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  await until(() => bus.ready(), 20000);
  await bus.rpc('fs/createDirectory', { path: cwd });
  // Regression: the previous desktop bridge permanently stopped after 128 requests.
  for (let i = 0; i < 135; i++) await bus.rpc('thread/list', { limit: 1 });
  pass('连续超过128次只读请求，桥保持可用');
  const { thread: seed } = await bus.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  report.threads.push(seed.id);
  await bus.rpc('thread/name/set', { threadId: seed.id, name: '执行端先建会话' });
  for (const user of accounts) {
    const credentials = { username: `shared_${randomUUID().slice(0, 10)}`, password: randomUUID() };
    await api(user, '/auth/register', 'POST', credentials, 201);
    await api(user, '/auth/login', 'POST', credentials);
  }
  const [a, b] = accounts, pid = projectId(cwd), p = `/projects/${pid}`, s = `${p}/sessions/${seed.id}`;
  for (const user of accounts) {
    const projects = await api(user, '/projects');
    assert.ok(projects.projects.some(project => project.id === pid && project.sessions.some(session => session.id === seed.id)));
  }
  pass('两个账号直接读取执行端已有线程，无本地项目映射');
  await api(b, s, 'PATCH', { name: '共享改名成功' });
  assert.equal((await bus.rpc('thread/read', { threadId: seed.id })).thread.name, '共享改名成功');
  pass('Web改名写入app-server，其他账号共享');
  await api({}, '/projects', 'GET', undefined, 401);
  await api({}, `${p}/download?path=file.txt`, 'GET', undefined, 401);
  const contents = Buffer.from('编号7391，中文文件');
  await bus.rpc('fs/writeFile', { path: `${cwd}/external.txt`, dataBase64: contents.toString('base64') });
  assert.equal(await api(b, `${p}/download?path=external.txt`), contents.toString());
  await api(a, `${p}/download?path=../secret`, 'GET', undefined, 400);
  pass('无磁盘挂载下远程文件下载与登录保护');
  await api(a, '/directories', 'POST', { path: `${cwd}/子目录` }, 201);
  assert.ok((await api(b, '/directories?path=' + encodeURIComponent(cwd))).entries.some(e => e.fileName === '子目录'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await bus.rpc('fs/writeFile', { path: `${cwd}/图.png`, dataBase64: png.toString('base64') });
  const picture = await fetch(base + '/api' + p + '/image?path=' + encodeURIComponent(`${cwd}/图.png`), { headers: { cookie: b.cookie } });
  assert.equal(picture.status, 200);
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), png);
  pass('中文子目录创建浏览与绝对路径图片读取');
  socket = new WebSocket(base.replace('http', 'ws') + '/events', { headers: { Cookie: b.cookie, Origin: base } });
  const events = [];
  socket.on('message', bytes => events.push(JSON.parse(bytes)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const result = await api(a, s + '/messages', 'POST', { text: '只读取当前目录附件中的编号，回复编号并说共享验收通过，禁止修改文件。',
    files: [{ name: '输入.txt', data: 'data:text/plain;base64,' + Buffer.from('编号=7391').toString('base64') }] });
  await until(() => events.find(event => event.payload?.method === 'turn/completed' && event.payload.params.turn.id === result.turnId));
  const history = await api(b, s + '/history');
  assert.ok(JSON.stringify(history).includes('7391'));
  assert.ok(history.turns.some(turn => turn.id === result.turnId && turn.status === 'completed'));
  pass('A上传附件并发起真实任务，B收到事件并读取历史');
  const extra = await api(a, p + '/sessions', 'POST', { name: '并发保护验收' }, 201);
  report.threads.push(extra.session.id);
  const started = await api(a, s + '/messages', 'POST', { text: '请执行等待20秒的命令，然后回复等待完成。' });
  await api(b, s + '/messages', 'POST', { text: '重复请求' }, 409);
  await api(b, s, 'DELETE', undefined, 409);
  await api(b, p, 'DELETE', undefined, 409);
  await api(b, `${p}/files?path=external.txt`, 'DELETE', undefined, 409);
  assert.equal((await api(a, '/status')).maxConcurrentTasks, null);
  const second = `${p}/sessions/${extra.session.id}`;
  const parallel = await api(b, `${second}/messages`, 'POST', { text: '请执行等待20秒的命令，然后回复等待完成。' });
  assert.notEqual(parallel.turnId, started.turnId);
  await api(b, `${second}/stop`, 'POST');
  await api(b, s + '/messages', 'POST', { text: '完成后不再执行其他命令。', steer: true });
  await api(b, s + '/stop', 'POST');
  await until(async () => (await api(a, s + '/history')).turns.some(t => t.id === started.turnId && t.status === 'interrupted'));
  pass('不同会话并发、同会话防重复、追加要求和停止任务');
  const { entries } = await bus.rpc('fs/readDirectory', { path: cwd });
  assert.ok(!entries.some(entry => entry.fileName === '.web-project.json'));
  await api(b, `${p}/files?path=external.txt`, 'DELETE');
  await api(a, `${p}/download?path=external.txt`, 'GET', undefined, 404);
  await api(b, s, 'DELETE');
  await bus.rpc('fs/writeFile', { path: `${cwd}/保留.txt`, dataBase64: Buffer.from('项目删除保留文件').toString('base64') });
  await api({}, p, 'DELETE', undefined, 401);
  const deleted = await api(a, p, 'DELETE');
  assert.ok(deleted.deleted.includes(seed.id));
  assert.ok(deleted.deleted.includes(extra.session.id));
  for (const archived of [false, true]) {
    const remaining = await bus.rpc('thread/list', { cwd, archived });
    assert.equal(remaining.data.length, 0);
  }
  assert.ok(!(await api(b, '/projects')).projects.some(project => project.id === projectId(cwd)));
  assert.equal(Buffer.from((await bus.rpc('fs/readFile', { path: `${cwd}/保留.txt` })).dataBase64, 'base64').toString(), '项目删除保留文件');
  assert.ok((await bus.rpc('fs/getMetadata', { path: cwd })).isDirectory);
  pass('未登录拒绝删除；项目批量永久删除含归档会话，双账号列表同步且目录文件保留');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; console.error(error); process.exitCode = 1; }
finally {
  socket?.close();
  for (const threadId of report.threads) await bus.rpc('thread/delete', { threadId }).catch(() => {});
  await bus.rpc('fs/remove', { path: cwd, recursive: true }).catch(() => {});
  await bus.close();
  await writeFile(new URL(`../test-results/${process.argv[5] || 'shared-acceptance'}.json`, import.meta.url), JSON.stringify(report, null, 2), 'utf8');
}
