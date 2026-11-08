import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolute, projectId, checkedPath, imagePath, listThreads, projectOptions, linuxProjectPath } from '../server/app-workspace.mjs';

test('remote directory identifiers preserve paths without local metadata', () => {
  assert.equal(projectId('E:\\工程\\Demo'), projectId('e:/工程/demo/'));
  assert.notEqual(projectId('/workspace/A'), projectId('/workspace/a'));
  assert.throws(() => absolute('../project'));
  assert.equal(imagePath('E:\\工程', 'file:///E:/%E5%B7%A5%E7%A8%8B/a.png'), 'a.png');
});
test('remote files reject traversal and symbolic links before reading', async () => {
  const bus = { rpc: async (method, { path }) => ({ isDirectory: true, isSymlink: path === '/data/link' }) };
  await assert.rejects(checkedPath(bus, '/data', '../secret'));
  await assert.rejects(checkedPath(bus, '/data', '.web-project.json'));
  await assert.rejects(checkedPath(bus, '/data', 'link/secret'), /符号链接/);
  assert.equal((await checkedPath(bus, '/data', '正常.txt')).target, '/data/正常.txt');
});
test('thread pagination includes app-server sources and refuses a repeated cursor', async () => {
  let calls = 0;
  const bus = { rpc: async (method, params) => {
    assert.ok(params.sourceKinds.includes('appServer'));
    calls++;
    return { data: [{ id: String(calls) }], nextCursor: calls === 1 ? 'next' : null };
  } };
  assert.equal((await listThreads(bus)).length, 2);
  await assert.rejects(listThreads({ rpc: async () => ({ data: [], nextCursor: 'same' }) }), /分页游标/);
});

test('project creation uses a Linux directory name and discovers Windows drives from the endpoint', async () => {
  assert.equal(linuxProjectPath('我的项目'), '/workspace/我的项目');
  for (const value of ['../outside', '/absolute', 'a/b', 'a\\b', '.', '..', ' trailing ', '.web-secret', 'CON']) {
    assert.throws(() => linuxProjectPath(value));
  }
  const linux = { supports: () => true, rpc: async () => ({ isDirectory: true }) };
  assert.deepEqual(await projectOptions(linux), { platform: 'linux', root: '/workspace' });
  const windows = { supports: () => true, rpc: async (method, params) => {
    if (method === 'thread/list') return { data: [{ cwd: 'E:\\工程\\现有项目' }], nextCursor: null };
    if (params.path === '/') throw new Error('path must be absolute');
    if (['C:\\', 'E:\\'].includes(params.path)) return { isDirectory: true };
    throw new Error('系统找不到指定的路径 (os error 3)');
  } };
  const result = await projectOptions(windows);
  assert.equal(result.platform, 'windows');
  assert.equal(result.initialPath, 'E:\\工程\\现有项目');
  assert.deepEqual(result.roots.map(entry => entry.path), ['E:\\', 'C:\\']);
  await assert.rejects(projectOptions({ supports: () => true, rpc: async () => { throw new Error('连接已断开'); } }), /连接已断开/);
});
