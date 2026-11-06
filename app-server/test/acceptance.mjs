import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeClient } from './mqtt-client.mjs';

const root = process.cwd();
const runtime = resolve(root, 'acceptance/.runtime');
const results = resolve(root, 'acceptance/results');
const home = join(runtime, 'home');
const workspace = join(runtime, 'workspace');
const project = 'codex-mqtt-acceptance';
const instance = 'acceptance';
const port = process.env.ACCEPTANCE_MQTT_PORT || '18884';
const password = randomUUID();
const sourceHome = resolve(process.env.ACCEPTANCE_CODEX_HOME || 'codex-home');
const env = process.env;
const composeArgs = ['compose', '-p', project, '-f', join(runtime, 'compose.json')];
const report = { startedAt: new Date().toISOString(), checks: [], jobs: [] };
let client;
async function run(program, args) {
  return new Promise((resolveRun, reject) => {
    const process = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => process.kill(), 60000);
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { output += chunk; });
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('close', code => { clearTimeout(timer); code === 0 ? resolveRun(output.trim()) : reject(new Error(`${program} exited ${code}: ${output.slice(-3000)}`)); });
  });
}
function passed(name, details = {}) {
  report.checks.push({ name, passed: true, ...details });
  console.log('PASS', name, JSON.stringify(details));
}
async function thread(cwd, extra = {}) {
  return (await client.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', ...extra })).thread.id;
}
async function begin(threadId, text) {
  return (await client.rpc('turn/start', { threadId, input: [{ type: 'text', text }] })).turn.id;
}
async function complete(threadId, turnId) {
  const result = await client.event('turn/completed', params => params.threadId === threadId && params.turn.id === turnId, 240000);
  assert.equal(result.turn.status, 'completed', JSON.stringify(result.turn.error));
  return result;
}
try {
  await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true }); await mkdir(results, { recursive: true });
  await writeFile(join(runtime, 'mqtt.json'), JSON.stringify({ username: instance, password }), 'utf8');
  // Test credentials only. Production password files are maintained by the operator.
  await run('docker', ['run', '--rm', '-v', `${runtime}:/auth`, '--entrypoint', 'sh', 'eclipse-mosquitto:2', '-ec',
    'rm -f /auth/mqtt-passwords; mosquitto_passwd -c -b /auth/mqtt-passwords "$1" "$2"; chmod 644 /auth/mqtt-passwords', 'sh', instance, password]);
  // Copy only authentication and configuration, never the user's session databases.
  for (const file of ['config.toml', 'auth.json']) await copyFile(join(sourceHome, file), join(home, file));
  const compose = JSON.parse(await run('docker', ['compose', '-f', 'docker-compose-app-server.yaml', 'config', '--format', 'json']));
  compose.name = project;
  delete compose.volumes;
  compose.networks = { default: {} };
  compose.services.mqtt.ports = [{ target: 1883, published: port, host_ip: '127.0.0.1', protocol: 'tcp' }];
  compose.services['codex-app-server'].image = 'docker-codex:app-server';
  const brokerConfig = join(runtime, 'mosquitto/config');
  const brokerData = join(runtime, 'mosquitto/data');
  await mkdir(brokerConfig, { recursive: true }); await mkdir(brokerData, { recursive: true });
  for (const file of ['mosquitto.conf', 'acl']) await copyFile(join(root, 'mosquitto/config', file), join(brokerConfig, file));
  await copyFile(join(runtime, 'mqtt-passwords'), join(brokerConfig, 'passwords'));
  const sources = { '/mosquitto/config': brokerConfig, '/mosquitto/data': brokerData,
    '/run/secrets/mqtt.json': join(runtime, 'mqtt.json'), '/workspace': workspace, '/home/node/.codex': home };
  for (const service of Object.values(compose.services)) {
    for (const mount of service.volumes || []) if (sources[mount.target]) mount.source = sources[mount.target];
  }
  await writeFile(join(runtime, 'compose.json'), JSON.stringify(compose, null, 2), 'utf8');
  await run('docker', [...composeArgs, 'up', '-d', '--no-build', '--force-recreate']);
  client = new BridgeClient({ url: `mqtt://127.0.0.1:${port}`, instance, password });
  await client.wait(() => client.status?.state === 'ready');
  const responses = await Promise.all(Array.from({ length: 40 }, () => client.rpc('thread/list', { limit: 1 })));
  assert.ok(responses.every(response => Array.isArray(response.data)));
  passed('40 concurrent RPC requests correlate correctly');
  const jobs = Array.from({ length: 4 }, (_, index) => ({ id: `job-${index + 1}`, marker: `会话${index + 1}-${randomUUID().slice(0, 8)}`, values: [index + 1, 10, 25] }));
  for (const job of jobs) {
    const dir = join(workspace, job.id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'input.json'), JSON.stringify(job), 'utf8');
  }
  let active = 0, maxActive = 0;
  const pendingJobs = [...jobs];
  async function worker() {
    while (pendingJobs.length) {
      const job = pendingJobs.shift();
      const threadId = await thread(`/workspace/${job.id}`);
      const startedAt = Date.now(); active++; maxActive = Math.max(maxActive, active);
      const turnId = await begin(threadId, `这是服务验收任务。你的会话代号是“${job.marker}”，记住它。使用命令工具运行 Python，读取当前目录 input.json，将 values 求和，写入 result.json，内容为 {"marker": 原marker,"total": 求和结果}；另写 UTF-8 无 BOM 的 report.md，含“中文验收通过”和你的会话代号。只操作当前目录。必须实际执行，不要只提供代码。完成后简短回复代号和总和。`);
      await complete(threadId, turnId);
      active--;
      const actual = JSON.parse(await readFile(join(workspace, job.id, 'result.json'), 'utf8'));
      assert.deepEqual(actual, { marker: job.marker, total: job.values.reduce((sum, value) => sum + value, 0) });
      const markdown = await readFile(join(workspace, job.id, 'report.md'), 'utf8');
      assert.ok(markdown.includes('中文验收通过') && markdown.includes(job.marker) && !markdown.startsWith('\uFEFF'));
      const followUp = await begin(threadId, '不使用任何工具，仅回复本线程最初给出的会话代号。');
      await complete(threadId, followUp);
      const answer = client.events.filter(event => event.payload.method === 'item/completed' && event.payload.params.threadId === threadId && event.payload.params.turnId === followUp && event.payload.params.item.type === 'agentMessage').map(event => event.payload.params.item.text).join('');
      assert.ok(answer.includes(job.marker), `Thread context mismatch for ${job.id}`);
      report.jobs.push({ job: job.id, threadId, turnId, startedAt, finishedAt: Date.now(), total: actual.total });
      passed(`scheduled ${job.id}: files + Chinese + thread context`);
    }
  }
  await Promise.all([worker(), worker()]);
  assert.equal(maxActive, 2);
  passed('4 real tasks scheduled across 2 workers', { maxActive });
  assert.ok(client.events.some(event => event.payload.method === 'item/agentMessage/delta'));
  assert.ok(client.events.some(event => event.payload.method === 'item/completed' && event.payload.params.item.type === 'commandExecution'));
  passed('streaming agent text and actual command tool events');
  const cancelThread = await thread('/workspace');
  const cancelTurn = await begin(cancelThread, '请运行命令 python -c "import time; time.sleep(60)"，等它完成后再回复。');
  await client.event('item/started', params => params.threadId === cancelThread && params.item.type === 'commandExecution');
  await client.rpc('turn/interrupt', { threadId: cancelThread, turnId: cancelTurn });
  const interrupted = await client.event('turn/completed', params => params.threadId === cancelThread && params.turn.id === cancelTurn);
  assert.equal(interrupted.turn.status, 'interrupted');
  passed('interrupt a running real command');
  const outageThread = await thread('/workspace');
  const outageTurn = await begin(outageThread, '使用命令工具实际运行 python -c "import time; time.sleep(10); print(\'BROKER_OUTAGE_OK\')"。完成后只回复 BROKER_OUTAGE_OK。');
  await client.event('item/started', params => params.threadId === outageThread && params.item.type === 'commandExecution');
  const brokerRestartedAt = Date.now();
  await run('docker', [...composeArgs, 'restart', 'mqtt']);
  await client.wait(() => client.status?.state === 'ready' && client.status.time >= brokerRestartedAt);
  await complete(outageThread, outageTurn);
  assert.ok(client.events.some(event => event.payload.method === 'item/completed' && event.payload.params.turnId === outageTurn && event.payload.params.item.text?.includes('BROKER_OUTAGE_OK')));
  passed('broker restart during active model task preserves completion');
  const approvalThread = await thread('/workspace', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  const approvalTurn = await begin(approvalThread, '验收审批通信。请调用命令工具执行 python -c "print(1234567)"。必须执行命令，不要心算，遇到审批等待审批结果。');
  const approval = await client.wait(() => client.events.find(event => event.type === 'rpc' && event.payload.id !== undefined && event.payload.method?.endsWith('/requestApproval') && event.payload.params.threadId === approvalThread), 90000);
  await client.send({ id: approval.payload.id, result: { decision: 'decline' } });
  await client.event('serverRequest/resolved', params => params.requestId === approval.payload.id || params.threadId === approvalThread, 30000);
  // The model may try another command after a declined request; interrupt the isolated test turn.
  await client.rpc('turn/interrupt', { threadId: approvalThread, turnId: approvalTurn });
  await client.event('turn/completed', params => params.threadId === approvalThread && params.turn.id === approvalTurn);
  passed('real server-initiated approval request and client response roundtrip');
  const previousRun = client.status.runId;
  await run('docker', [...composeArgs, 'restart', 'codex-app-server']);
  await client.wait(() => client.status?.state === 'ready' && client.status.runId !== previousRun);
  const saved = report.jobs[0];
  await client.rpc('thread/resume', { threadId: saved.threadId, cwd: `/workspace/${saved.job}`, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const resumeTurn = await begin(saved.threadId, '不使用工具，回复你记住的会话代号。');
  await complete(saved.threadId, resumeTurn);
  const marker = jobs.find(job => job.id === saved.job).marker;
  assert.ok(client.events.some(event => event.payload.method === 'item/completed' && event.payload.params.turnId === resumeTurn && event.payload.params.item.text?.includes(marker)));
  passed('container restart + persistent thread resume retains context');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; console.error('FAIL', error.message); process.exitCode = 1;
} finally {
  if (client) await client.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(results, { recursive: true });
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await run('docker', [...composeArgs, 'down']).catch(error => { console.error(error.message); process.exitCode = 1; });
  console.log('Acceptance report: acceptance/results/report.json');
}
