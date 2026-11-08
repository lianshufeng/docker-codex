import { readFile, writeFile, rename, mkdir, readdir, lstat, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, message = '请求参数无效') {
  if (!condition) throw new HttpError(400, message);
}
export function identifier(value) {
  requireValue(typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value), '无效的资源 ID');
  return value;
}
export function displayName(value) {
  requireValue(typeof value === 'string' && value.trim().length > 0, '名称不能为空');
  return value.trim();
}
export class Locks {
  queues = new Map();
  async run(key, fn) {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.queues.set(key, current);
    try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }
}
export async function readJson(file, missing) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && missing !== undefined) return missing; throw error; }
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
export class Projects {
  constructor(root) { this.root = path.resolve(root); this.locks = new Locks(); this.userLocks = new Locks(); }
  userRoot(uid) { return path.join(this.root, identifier(uid)); }
  directory(uid, pid) { return path.join(this.userRoot(uid), identifier(pid)); }
  metaFile(uid, pid) { return path.join(this.directory(uid, pid), '.web-project.json'); }
  async checkedDirectory(uid, pid) {
    const dir = this.directory(uid, pid);
    for (const part of [this.userRoot(uid), dir]) {
      let stat;
      try { stat = await lstat(part); } catch (e) { if (e.code === 'ENOENT') throw new HttpError(404, '项目不存在'); throw e; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError(403, '禁止访问链接目录');
    }
    return dir;
  }
  async get(uid, pid) {
    await this.checkedDirectory(uid, pid);
    if ((await lstat(this.metaFile(uid, pid))).isSymbolicLink()) throw new HttpError(403, '项目元信息不可为符号链接');
    const meta = await readJson(this.metaFile(uid, pid));
    if (!meta || !Array.isArray(meta.sessions) || meta.id !== pid) throw new HttpError(409, '项目元信息损坏');
    return meta;
  }
  async list(uid) {
    const dir = this.userRoot(uid);
    let entries;
    try {
      if ((await lstat(dir)).isSymbolicLink()) throw new HttpError(403, '用户目录不可为符号链接');
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const output = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      try { output.push(await this.get(uid, entry.name)); }
      catch (e) { console.error('project_scan_error', entry.name, e.message); }
    }
    return output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async create(uid, name) {
    return this.userLocks.run(uid, async () => {
    const id = randomUUID();
    const meta = { id, name: displayName(name), createdAt: new Date().toISOString(), sessions: [] };
    await mkdir(this.userRoot(uid), { recursive: true });
    if ((await lstat(this.userRoot(uid))).isSymbolicLink()) throw new HttpError(403, '禁止链接目录');
    await mkdir(this.directory(uid, id));
    await atomicJson(this.metaFile(uid, id), meta);
    return meta;
    });
  }
  async removeEmptyUserDirectory(uid) {
    return this.userLocks.run(uid, async () => {
      const dir = this.userRoot(uid);
      try {
        if ((await lstat(dir)).isSymbolicLink()) throw new HttpError(403, '用户目录不可为符号链接');
        // Non-recursive removal is atomic: never remove a remaining project or user file.
        await rmdir(dir);
      } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    });
  }
  async update(uid, pid, fn) {
    const meta = await this.get(uid, pid);
    await fn(meta);
    await atomicJson(this.metaFile(uid, pid), meta);
    return meta;
  }
  async file(uid, pid, relative = '', allowRoot = true) {
    const root = await this.checkedDirectory(uid, pid);
    requireValue(typeof relative === 'string' && !relative.includes('\0') && !relative.includes('\\') && !path.posix.isAbsolute(relative), '文件路径无效');
    const segments = relative.split('/').filter(Boolean);
    requireValue(segments.every(s => s !== '.' && s !== '..' && !s.startsWith('.web-')), '禁止访问内部文件或上级目录');
    if (process.platform === 'win32') {
      requireValue(segments.every(s => !/[<>:"|?*]/.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)), '禁止访问 Windows 特殊路径');
    }
    requireValue(allowRoot || segments.length > 0, '不能删除项目根目录');
    let target = root;
    for (const segment of segments) {
      target = path.join(target, segment);
      const stat = await lstat(target).catch(e => { if (e.code === 'ENOENT') throw new HttpError(404, '文件不存在'); throw e; });
      if (stat.isSymbolicLink()) throw new HttpError(403, '禁止访问符号链接');
    }
    const actual = await realpath(target);
    const actualRoot = await realpath(root);
    if (actual !== actualRoot && !actual.startsWith(actualRoot + path.sep)) throw new HttpError(403, '路径越界');
    return { target, stat: await lstat(target) };
  }
}
