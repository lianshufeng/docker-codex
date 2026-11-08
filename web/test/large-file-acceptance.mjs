// Run only against a dedicated test workspace. Cleans up its recorded resources.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DesktopBus } from '../server/desktop-mqtt.mjs';
import { FileTransport, chunkBytes, checksum } from '../server/file-transport.mjs';
import { projectId } from '../server/app-workspace.mjs';

const [base = 'http://127.0.0.1:31021', broker = 'mqtt://127.0.0.1:18884', parent = '/workspace', reportName = 'large-files'] = process.argv.slice(2);
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const bus = new DesktopBus({ ...config.mqtt, url: broker });
const files = new FileTransport(bus);
const cwd = `${parent}/large-files-${randomUUID()}`, report = { cwd, checks: [] }, threads = [];
let cookie;
async function api(route, method = 'GET', body, expected = 200, headers = {}) {
  const response = await fetch(base + '/api' + route, { method, headers: { cookie: cookie || '',
    ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal(response.status, expected, `${route}: ${response.status} ${response.status !== expected ? await response.text() : ''}`);
  return response;
}
function pass(value) { report.checks.push(value); console.log('PASS', value); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; !bus.ready() && i < 100; i++) await pause(200);
  assert.ok(bus.ready());
  assert.equal(files.limits().maxFileBytes, null);
  const replies = await Promise.all(Array.from({ length: 150 }, () => bus.rpc('thread/list', { limit: 1 }, 60000)));
  assert.ok(replies.every(reply => Array.isArray(reply.data)));
  pass('150条并发标准请求返回且未触发累计命令限制');
  await bus.rpc('fs/createDirectory', { path: cwd });
  const created = await bus.rpc('thread/start', { cwd }); threads.push(created.thread.id);
  const threadId = created.thread.id;
  const credentials = { username: 'large_' + randomUUID().slice(0, 10), password: randomUUID() };
  await api('/auth/register', 'POST', credentials, 201);
  await api('/auth/login', 'POST', credentials);
  const project = `/projects/${projectId(cwd)}`;
  const rpcFile = `${cwd}/raw-rpc.bin`;
  const rpcBytes = Buffer.alloc(4 * 1024 * 1024, 21).toString('base64');
  await bus.rpc('fs/writeFile', { path: rpcFile, dataBase64: rpcBytes }, 60000);
  assert.equal((await bus.rpc('fs/readFile', { path: rpcFile }, 60000)).dataBase64, rpcBytes);
  pass('超过旧单条上限的JSON-RPC输入和输出原样往返');
  for (const megabytes of [129]) {
    const size = megabytes * 1024 * 1024, transferId = randomUUID();
    const start = await (await api(project + '/uploads', 'POST', { name: `中文-${megabytes}MiB.bin`, size, transferId, image: false, threadId }, 201)).json();
    const expectedHash = createHash('sha256'), block = Buffer.alloc(chunkBytes);
    const write = (offset, data, hash = checksum(data), expected = 200) => api(`${project}/uploads/${transferId}?offset=${offset}`, 'PUT', data, expected, { 'x-chunk-sha256': hash });
    for (let offset = 0; offset < size; offset += chunkBytes) {
      block.fill(offset / chunkBytes % 251);
      if (offset === 0) await write(offset, block, 'wrong-hash', 400);
      if (offset === 2 * chunkBytes) {
        const controller = new AbortController();
        const interrupted = fetch(`${base}/api${project}/uploads/${transferId}?offset=${offset}`, {
          method: 'PUT', signal: controller.signal, body: block, headers: { cookie,
            'content-type': 'application/octet-stream', 'x-chunk-sha256': checksum(block) } });
        setTimeout(() => controller.abort(), 2);
        await interrupted.catch(() => {});
      }
      await write(offset, block); expectedHash.update(block);
      if (offset === chunkBytes) {
        await write(offset, block);
        await bus.rpc('thread/list', { limit: 1 });
        const resumed = await (await api(project + '/uploads', 'POST', { name: `中文-${megabytes}MiB.bin`, size, transferId, image: false, threadId }, 201)).json();
        assert.equal(resumed.offset, 2 * chunkBytes);
      }
    }
    const expected = expectedHash.digest('hex');
    const receipt = await (await api(`${project}/uploads/${transferId}/finish`, 'POST', { sha256: expected })).json();
    assert.equal(receipt.sha256, expected);
    assert.equal((await (await api(`${project}/uploads/${transferId}/finish`, 'POST', {})).json()).sha256, expected);
    const url = `${project}/download?path=${encodeURIComponent(start.relative)}`;
    const download = await api(url);
    const hash = createHash('sha256'); let received = 0;
    for await (const chunk of download.body) { hash.update(chunk); received += chunk.length; }
    assert.equal(received, size); assert.equal(hash.digest('hex'), expected);
    const range = await api(url, 'GET', undefined, 206, { Range: `bytes=${chunkBytes}-${2 * chunkBytes - 1}` });
    assert.equal(range.headers.get('content-length'), String(chunkBytes));
    assert.ok(Buffer.from(await range.arrayBuffer()).every(value => value === 1));
    await api(url, 'GET', undefined, 416, { Range: `bytes=${size}-` });
    pass(`${megabytes}MiB上传下载哈希一致、重复块、续传、RPC并行、Range恢复`);
    await api(`${project}/files?path=${encodeURIComponent(start.relative)}`, 'DELETE');
  }
  const aborted = await (await api(project + '/uploads', 'POST', { name: 'cancel.bin', size: 1, threadId }, 201)).json();
  await api(`${project}/uploads/${aborted.transferId}`, 'DELETE');
  await assert.rejects(files.request({ op: 'read', root: cwd, relative: '../secret', offset: 0, length: 1 }), /路径/);
  pass('取消传输与越界路径拒绝');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; console.error(error); process.exitCode = 1; }
finally {
  for (const threadId of threads) await bus.rpc('thread/delete', { threadId }).catch(() => {});
  await bus.rpc('fs/remove', { path: cwd, recursive: true }).catch(() => {});
  await bus.close();
  await writeFile(new URL(`../test-results/${reportName}.json`, import.meta.url), JSON.stringify(report, null, 2), 'utf8');
}
