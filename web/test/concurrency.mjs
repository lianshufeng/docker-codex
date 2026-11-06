import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const sessions = [];
let cookie = '', project;
async function request(url, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:3000/api' + url, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    try { if (await fn()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('等待状态超时');
}
async function restartWeb() {
  await new Promise((resolve, reject) => {
    const process = spawn('docker', ['compose', '-f', 'docker-compose.yml', 'restart', 'web'], { cwd: root, stdio: 'pipe' });
    let output = '';
    process.stderr.on('data', data => output += data);
    process.once('error', reject);
    process.once('exit', code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await until(async () => (await request('/status')).connected);
}
try {
  const username = 'concurrency_' + Date.now().toString(36);
  const credentials = { username, password: 'Concurrency-test-2026!' };
  await request('/auth/register', 'POST', credentials, 201);
  await request('/auth/login', 'POST', credentials);
  await until(async () => (await request('/status')).connected);
  assert.equal((await request('/status')).maxConcurrentTasks, 4);
  project = (await request('/projects', 'POST', { name: '并发上限验收' }, 201)).project;
  for (let i = 0; i < 5; i++) sessions.push((await request(`/projects/${project.id}/sessions`, 'POST', { name: `并发任务 ${i + 1}` }, 201)).session);
  const base = session => `/projects/${project.id}/sessions/${session.id}`;
  const message = { text: '请立即用终端执行 python -c "import time; time.sleep(120)"，执行完成后回复完成。不要创建或修改文件。' };
  await Promise.all(sessions.slice(0, 4).map(session => request(base(session) + '/messages', 'POST', message)));
  assert.equal((await request('/status')).activeTasks, 4);
  await request(base(sessions[4]) + '/messages', 'POST', message, 429);
  await request(base(sessions[0]) + '/messages', 'POST', message, 409);
  await request(`/projects/${project.id}`, 'DELETE', undefined, 409);
  checks.push('同项目四会话并发、第五个拒绝、同会话重复提交及删除保护通过');
  await restartWeb();
  await request(base(sessions[4]) + '/messages', 'POST', message, 429);
  assert.equal((await request('/status')).activeTasks, 4);
  checks.push('Web 重启后恢复四个活动任务，不突破上限');
  await Promise.all(sessions.slice(0, 4).map(session => request(base(session) + '/stop', 'POST', {})));
  await until(async () => (await request('/status')).activeTasks === 0);
  await request(base(sessions[4]) + '/messages', 'POST', message);
  await request(base(sessions[4]) + '/stop', 'POST', {});
  await until(async () => (await request('/status')).activeTasks === 0);
  checks.push('停止任务释放名额，后续任务可正常启动');
  await request(`/projects/${project.id}`, 'DELETE');
  project = undefined;
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
} finally {
  if (project) {
    // Cleanup is restricted to the project created by this test.
    for (const session of sessions) await request(`/projects/${project.id}/sessions/${session.id}/stop`, 'POST', {}).catch(() => {});
  }
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/concurrency.json'), JSON.stringify({ passed: !process.exitCode, checks }, null, 2), 'utf8');
  for (const check of checks) console.log('PASS', check);
}
