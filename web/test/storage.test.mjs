import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Auth } from '../server/auth.mjs';
import { Projects } from '../server/storage.mjs';

test('password hashing, persisted sessions, password change invalidates sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-web-auth-'));
  try {
    const auth = new Auth(path.join(dir, 'users.json')); await auth.init();
    const results = await Promise.allSettled([auth.register('example', 'password-123'), auth.register('example', 'password-123')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const { user, token } = await auth.login('example', 'password-123');
    const req = { headers: { cookie: `codex_session=${token}` } };
    assert.equal(auth.user(req).id, user.id);
    const restored = new Auth(auth.file); await restored.init(); assert.equal(restored.user(req).id, user.id);
    assert.ok(!(await readFile(auth.file, 'utf8')).includes('password-123'));
    await auth.password(user.id, 'password-123', 'changed-456');
    assert.throws(() => auth.user(req));
    await assert.rejects(auth.login('example', 'password-123'));
    assert.ok((await auth.login('example', 'changed-456')).token);
  } finally { await rm(dir, { recursive: true }); }
});
test('project paths, concurrent metadata changes, internal files and symlink escape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-web-project-'));
  try {
    const projects = new Projects(root), uid = randomUUID(), other = randomUUID();
    const project = await projects.create(uid, '中文项目');
    await Promise.all(Array.from({length:20}, (_, i) => projects.locks.run(project.id, () => projects.update(uid, project.id, p => { p.sessions.push({id:String(i)}); }))));
    assert.equal((await projects.get(uid, project.id)).sessions.length, 20);
    assert.equal((await projects.list(uid)).length, 1);
    await assert.rejects(projects.get(other, project.id));
    for (const p of ['../escape', '.web-project.json', '/etc/passwd', 'a\\b']) await assert.rejects(projects.file(uid, project.id, p));
    await writeFile(path.join(projects.directory(uid, project.id), '正常.txt'), '中文', 'utf8');
    assert.ok((await projects.file(uid, project.id, '正常.txt')).stat.isFile());
    if (process.platform !== 'win32') {
      await symlink('/etc', path.join(projects.directory(uid, project.id), 'escape'));
      await assert.rejects(projects.file(uid, project.id, 'escape/passwd'));
    }
  } finally { await rm(root, { recursive: true }); }
});

test('empty user cleanup preserves projects and listing does not recreate deleted directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'web-cleanup-'));
  try {
    const projects = new Projects(root), uid = randomUUID();
    assert.deepEqual(await projects.list(uid), []);
    await assert.rejects(lstat(projects.userRoot(uid)), { code: 'ENOENT' });
    const project = await projects.create(uid, '删除验收');
    await projects.removeEmptyUserDirectory(uid);
    assert.ok((await lstat(projects.directory(uid, project.id))).isDirectory());
    await rm(projects.directory(uid, project.id), { recursive: true });
    await projects.removeEmptyUserDirectory(uid);
    assert.deepEqual(await projects.list(uid), []);
    await assert.rejects(lstat(projects.userRoot(uid)), { code: 'ENOENT' });
    await mkdir(projects.userRoot(uid));
    await writeFile(path.join(projects.userRoot(uid), '保留.txt'), '不可误删', 'utf8');
    await projects.removeEmptyUserDirectory(uid);
    assert.equal(await readFile(path.join(projects.userRoot(uid), '保留.txt'), 'utf8'), '不可误删');
    const [, created] = await Promise.all([projects.removeEmptyUserDirectory(uid), projects.create(uid, '并发创建')]);
    assert.equal((await projects.get(uid, created.id)).name, '并发创建');
  } finally { await rm(root, { recursive: true }); }
});
