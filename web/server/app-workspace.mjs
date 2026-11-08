import path from 'node:path';
import { HttpError, requireValue } from './storage.mjs';

const pathApi = value => /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
export function absolute(value) {
  requireValue(typeof value === 'string' && value.length <= 2048 && !/[\0-\x1f]/.test(value) &&
    (/^[a-z]:[\\/]/i.test(value) || (value.startsWith('/') && !value.startsWith('//'))), '请输入执行端的绝对目录路径');
  const api = pathApi(value);
  const result = api.normalize(value);
  return result === api.parse(result).root ? result : result.replace(/[\\/]+$/, '');
}
export function projectId(cwd) {
  const full = absolute(cwd);
  return Buffer.from(pathApi(full) === path.win32 ? full.toLowerCase() : full).toString('base64url');
}
export const projectOf = cwd => ({ id: projectId(cwd), cwd, name: pathApi(cwd).basename(cwd) || cwd, sessions: [] });
export const sessionOf = thread => ({ id: thread.id, threadId: thread.id, name: thread.name || thread.preview?.split(/\r?\n|附件：/)[0].trim().slice(0, 80) || '新会话',
  createdAt: new Date((thread.createdAt || 0) * 1000).toISOString(), updatedAt: new Date((thread.updatedAt || 0) * 1000).toISOString() });

export async function listThreads(bus, params = {}) {
  const generation = bus.state?.runId;
  const threads = new Map(), cursors = new Set();
  let cursor;
  do {
    const page = await bus.rpc('thread/list', { sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], modelProviders: [], limit: 100, ...params, cursor });
    for (const thread of page.data) threads.set(thread.id, thread);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new HttpError(502, '执行端重复返回同一个分页游标');
    cursors.add(cursor);
  } while (cursor);
  if (generation !== bus.state?.runId) throw new HttpError(503, '执行端连接已变化，请刷新列表');
  return [...threads.values()];
}

// Query the execution endpoint; the Web host may run on another operating system.
export async function projectOptions(bus) {
  if (!bus.supports('fs/getMetadata')) throw new HttpError(409, '执行端不支持目录选择，请更新桥接服务');
  try {
    const stat = await bus.rpc('fs/getMetadata', { path: '/' });
    if (stat.isDirectory) return { platform: 'linux', root: '/workspace' };
  } catch (error) {
    if (!/absolute|invalid.*path|路径.*无效/i.test(error.message)) throw error;
  }
  const threads = await listThreads(bus);
  const recent = threads.map(t => t.cwd).filter(cwd => typeof cwd === 'string' && /^[a-z]:[\\/]/i.test(cwd));
  const drives = [...new Set([...recent.map(cwd => cwd.slice(0, 2).toUpperCase()),
    ...'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map(letter => `${letter}:`)])];
  const roots = [];
  for (const drive of drives) {
    try {
      const stat = await bus.rpc('fs/getMetadata', { path: `${drive}\\` });
      if (stat.isDirectory && !stat.isSymlink) roots.push({ name: drive, path: `${drive}\\` });
    } catch (error) {
      if (!/not found|no such file|cannot find|找不到|not ready|device|access.*denied|拒绝访问|os error (?:[235]|15|21)\b/i.test(error.message)) throw error;
    }
  }
  if (!roots.length) throw new HttpError(502, '无法读取执行端的工作目录');
  return { platform: 'windows', roots, initialPath: recent[0] || '' };
}

export function linuxProjectPath(name) {
  requireValue(typeof name === 'string' && name.trim() === name && name.length > 0 &&
    Buffer.byteLength(name) <= 180 && !name.includes('/') && !name.includes('\\'), '请输入有效项目名，不能包含路径');
  parts(name);
  requireValue(!name.startsWith('.'), '项目名不能以点开头');
  return `/workspace/${name}`;
}

function parts(relative) {
  requireValue(typeof relative === 'string' && !relative.includes('\\') && !relative.startsWith('/'), '文件路径无效');
  const names = relative.split('/').filter(Boolean);
  requireValue(names.every(name => !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
    !/^\.web-/i.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)), '禁止访问上级、内部或特殊路径');
  return names;
}
export async function checkedPath(bus, root, relative = '', { allowMissing = false, allowRoot = true } = {}) {
  const names = parts(relative), api = pathApi(root);
  requireValue(allowRoot || names.length, '请选择目录中的文件');
  const target = api.join(root, ...names);
  const { root: volume } = api.parse(target);
  let current = volume, stat;
  const components = target.slice(volume.length).split(api.sep).filter(Boolean);
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = api.join(current, components[i]);
    try { stat = await bus.rpc('fs/getMetadata', { path: current }); }
    catch (error) {
      if (/not found|no such file|cannot find|找不到|os error [23]\b/i.test(error.message)) {
        if (allowMissing && i === components.length - 1) return { target, stat: null };
        throw new HttpError(404, '文件或目录不存在');
      }
      throw error;
    }
    if (stat.isSymlink) throw new HttpError(403, '禁止访问符号链接');
    if (i < components.length - 1 && !stat.isDirectory) throw new HttpError(400, '上级路径不是目录');
  }
  return { target, stat };
}
export function imagePath(root, value) {
  if (value.startsWith('file://')) {
    const url = new URL(value);
    requireValue(!url.host, '图片路径无效');
    value = decodeURIComponent(url.pathname);
  }
  value = value.replace(/^sandbox:/, '');
  const api = pathApi(root);
  if (api === path.win32) value = value.replace(/^\/(?=[a-z]:\/)/i, '').replaceAll('\\', '/');
  if (api.isAbsolute(value)) {
    value = api.relative(root, value);
    requireValue(!api.isAbsolute(value), '图片路径越界');
  }
  return value.replaceAll(api.sep, '/').replace(/^\.\//, '');
}
