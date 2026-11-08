// Only run against the isolated Windows test app-server, never existing production threads.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DesktopBus } from '../server/desktop-mqtt.mjs';
import { projectId } from '../server/app-workspace.mjs';

const base = 'http://127.0.0.1:31022';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const bus = new DesktopBus({ ...config.mqtt, url: 'mqtt://127.0.0.1:18885' });
const cwd = `${process.argv[2]}/thread-name-${randomUUID()}`;
const report = { cwd, threads: [], checks: [] };
let cookie;
async function request(route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + '/api' + route, { method, headers: { cookie: cookie || '', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
}
try {
  for (let attempt = 0; !bus.ready() && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(bus.ready());
  assert.equal(bus.remote.methods, '*');
  await bus.rpc('config/read');
  report.checks.push('桥透传未列入旧白名单的标准只读方法');
  await bus.rpc('fs/createDirectory', { path: cwd });
  const credentials = { username: 'name_' + randomUUID().slice(0, 12), password: randomUUID() };
  await request('/auth/register', 'POST', credentials, 201);
  await request('/auth/login', 'POST', credentials);
  const project = await request('/projects', 'POST', { path: cwd }, 201);
  report.threads.push(project.project.sessions[0].id);
  const route = `/projects/${projectId(cwd)}/sessions`;
  const created = await request(route, 'POST', { name: '新建时命名' }, 201);
  report.threads.push(created.session.id);
  assert.equal((await bus.rpc('thread/read', { threadId: created.session.id })).thread.name, '新建时命名');
  report.checks.push('Web创建命名会话，app-server读取到相同名称');
  const renamed = await request(`${route}/${created.session.id}`, 'PATCH', { name: '中文改名已保存' });
  assert.equal(renamed.session.name, '中文改名已保存');
  assert.equal((await bus.rpc('thread/read', { threadId: created.session.id })).thread.name, '中文改名已保存');
  const projects = await request('/projects');
  assert.equal(projects.projects.find(p => p.id === projectId(cwd)).sessions.find(s => s.id === created.session.id).name, '中文改名已保存');
  report.checks.push('改名写入app-server，重新查询列表保持相同名称');
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) { report.passed = false; report.error = error.message; console.error(error); process.exitCode = 1; }
finally {
  for (const threadId of report.threads) await bus.rpc('thread/delete', { threadId }).catch(() => {});
  await bus.rpc('fs/remove', { path: cwd, recursive: true }).catch(() => {});
  await bus.close();
  await writeFile(new URL('../test-results/windows-thread-names.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
}
