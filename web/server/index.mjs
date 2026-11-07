import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdir, readdir, lstat, rm, readFile, open } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.mjs';
import { CodexBus } from './mqtt.mjs';
import { decodeImages, decodeFiles } from './images.mjs';
import { Projects, Locks, HttpError, requireValue, displayName } from './storage.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(appRoot, 'config.json'), 'utf8'));
const maxConcurrentTasks = config.maxConcurrentTasks ?? 4;
const attachmentDate = new Intl.DateTimeFormat('en-CA', { timeZone: config.attachmentTimeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new Error('maxConcurrentTasks 必须是正整数');
const projects = new Projects(config.workspaceRoot);
const auth = new Auth(path.resolve(appRoot, config.dataDirectory, 'users.json'));
await mkdir(config.workspaceRoot, { recursive: true }); await auth.init();
const bus = new CodexBus(config.mqtt);
const registry = new Map(), active = new Map(), approvals = new Map();
const sockets = new Set();
const threadLocks = new Locks();
const admissions = new Locks();
let concurrencyRunId;
for (const user of auth.state.users) {
  for (const project of await projects.list(user.id)) {
    for (const session of project.sessions) if (typeof session.threadId === 'string') registry.set(session.threadId, { uid: user.id, pid: project.id, sid: session.id });
  }
  await projects.removeEmptyUserDirectory(user.id);
}
function status() { return { connected: bus.ready(), state: bus.state.state, runId: bus.state.runId, activeTasks: active.size, maxConcurrentTasks }; }
function broadcast(uid, message) {
  const data = JSON.stringify(message);
  for (const socket of sockets) {
    if (uid && socket.uid !== uid) continue;
    try {
      auth.user(socket.request);
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, '客户端过慢，请重新加载历史'); continue; }
      if (socket.readyState === 1) socket.send(data);
    } catch { socket.close(1008, '登录已失效'); }
  }
}
let lastRunId;
bus.on('status', () => {
  if (!bus.ready()) concurrencyRunId = undefined;
  if (lastRunId && bus.state.runId && lastRunId !== bus.state.runId) { active.clear(); approvals.clear(); }
  if (bus.state.runId) lastRunId = bus.state.runId;
  broadcast(null, { type: 'status', ...status() });
});
bus.on('notification', (message, runId) => {
  if (runId !== bus.state.runId) return;
  const params = message.params || {};
  const tid = params.threadId || params.thread?.id;
  const owner = registry.get(tid);
  if (!owner) return;
  if (message.method === 'turn/started') active.set(tid, params.turn.id);
  if (message.method === 'turn/completed') active.delete(tid);
  if (message.id !== undefined) approvals.set(String(message.id), { threadId: tid, message });
  if (message.method === 'serverRequest/resolved') approvals.delete(String(params.requestId));
  if (message.method === 'turn/completed') for (const [id, item] of approvals) if (item.threadId === tid) approvals.delete(id);
  if (message.method.startsWith('item/reasoning')) return;
  if (params.item?.type === 'reasoning') return;
  broadcast(owner.uid, { type: 'rpc', projectId: owner.pid, sessionId: owner.sid, payload: message });
});
const app = express(); app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
    catch { return res.status(403).json({ error: '禁止跨站请求' }); }
  }
  next();
});
const messageRoute = /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/messages$/;
const parseJson = express.json({ limit: '256kb' });
app.use((req, res, next) => req.method === 'POST' && messageRoute.test(req.path) ? next() : parseJson(req, res, next));
const router = express.Router();
const limits = new Map();
router.use('/auth', (req, res, next) => {
  const key = req.socket.remoteAddress;
  const now = Date.now(), current = limits.get(key);
  const value = current && current.until > now ? current : { count: 0, until: now + 60000 };
  if (++value.count > 40) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  limits.set(key, value); next();
});
const cookie = (res, token, req) => res.cookie('codex_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 7 * 86400000 });
router.post('/auth/register', async (req, res) => {
  const user = await auth.register(req.body.username, req.body.password);
  await mkdir(projects.userRoot(user.id), { recursive: true });
  res.status(201).json({ user });
});
router.post('/auth/login', async (req, res) => {
  const { user, token } = await auth.login(req.body.username, req.body.password);
  broadcast(user.id, { type: 'auth-expired' }); cookie(res, token, req); res.json({ user });
});
router.post('/auth/logout', async (req, res) => { await auth.logout(req); res.clearCookie('codex_session', { path: '/' }); res.json({ ok: true }); });
router.use((req, res, next) => { try { req.user = auth.user(req); next(); } catch (e) { next(e); } });
router.get('/me', (req, res) => res.json({ user: req.user, status: status() }));
router.post('/auth/password', async (req, res) => {
  await auth.password(req.user.id, req.body.oldPassword, req.body.newPassword);
  broadcast(req.user.id, { type: 'auth-expired' }); res.clearCookie('codex_session', { path: '/' }); res.json({ ok: true });
});
router.get('/status', (req, res) => res.json(status()));
router.get('/projects', async (req, res) => res.json({ projects: await projects.list(req.user.id) }));
router.post('/projects', async (req, res) => res.status(201).json({ project: await projects.create(req.user.id, req.body.name) }));
function key(req) { return `${req.user.id}/${req.params.pid}`; }
async function getSession(req) {
  const project = await projects.get(req.user.id, req.params.pid);
  const session = project.sessions.find(s => s.id === req.params.sid);
  if (!session) throw new HttpError(404, '会话不存在');
  registry.set(session.threadId, { uid: req.user.id, pid: project.id, sid: session.id });
  return { project, session };
}
function cwd(req) { return path.posix.join(config.codexWorkspaceRoot, req.user.id, req.params.pid); }
function assertIdle(project) {
  if (project.sessions.some(s => active.has(s.threadId))) throw new HttpError(409, '项目有任务执行中，请停止任务后再操作');
}
async function reserveTask(session) {
  await admissions.run('tasks', async () => {
    if (!bus.ready()) throw new HttpError(503, 'AI 助手 尚未连接');
    if (concurrencyRunId !== bus.state.runId) {
      // Reconcile running threads after restart/reconnect before admitting more work.
      const runId = bus.state.runId;
      let cursor;
      do {
        const loaded = await bus.rpc('thread/loaded/list', cursor ? { cursor } : {});
        for (const id of loaded.data) {
          if (!registry.has(id)) continue;
          const { thread } = await bus.rpc('thread/read', { threadId: id });
          if (thread.status?.type === 'active') {
            if (!active.has(id)) active.set(id, 'unknown');
          } else active.delete(id);
        }
        cursor = loaded.nextCursor;
      } while (cursor);
      if (!bus.ready() || runId !== bus.state.runId) throw new HttpError(503, 'AI 助手 连接已变化，请重试');
      concurrencyRunId = runId;
    }
    if (active.has(session.threadId)) throw new HttpError(409, '会话正在执行，请追加要求或先停止任务');
    if (active.size >= maxConcurrentTasks) throw new HttpError(429, `已达到并发任务上限（${maxConcurrentTasks}），请等待任务完成后重试`);
    active.set(session.threadId, 'pending');
  });
}
async function syncState(session) {
  let result;
  try { result = await bus.rpc('thread/read', { threadId: session.threadId }); }
  catch (error) {
    const original = session.threadId, owner = registry.get(original);
    if (!owner || !/thread.*not found|thread not loaded|no rollout found|thread.*does not exist/i.test(error.message)) throw error;
    // Empty threads have no rollout to recover after app-server restart. Recreate only these, never replay messages.
    result = await threadLocks.run(original, async () => {
      const current = (await projects.get(owner.uid, owner.pid)).sessions.find(s => s.id === owner.sid);
      if (!current) throw new HttpError(404, '会话已删除');
      if (current.threadId !== original) { Object.assign(session, current); return bus.rpc('thread/read', { threadId: current.threadId }); }
      try {
        const resumed = await bus.rpc('thread/resume', { threadId: original, cwd: path.posix.join(config.codexWorkspaceRoot, owner.uid, owner.pid), sandbox: config.sandbox, approvalPolicy: config.approvalPolicy });
        return { thread: resumed.thread };
      } catch (resumeError) {
        if (current.hasTurns || !/thread.*not found|thread not loaded|no rollout found|thread.*does not exist/i.test(resumeError.message)) throw resumeError;
      }
      const created = await bus.rpc('thread/start', { cwd: path.posix.join(config.codexWorkspaceRoot, owner.uid, owner.pid), sandbox: config.sandbox, approvalPolicy: config.approvalPolicy });
      await projects.update(owner.uid, owner.pid, p => { p.sessions.find(s => s.id === owner.sid).threadId = created.thread.id; });
      session.threadId = created.thread.id; registry.delete(original); registry.set(session.threadId, owner);
      return { thread: created.thread };
    });
  }
  const owner = registry.get(session.threadId);
  if (owner) {
    const expected = path.posix.join(config.codexWorkspaceRoot, owner.uid, owner.pid);
    if (result.thread.cwd !== expected) throw new HttpError(403, '线程工作目录与项目不匹配');
  }
  const running = result.thread.status?.type === 'active';
  if (running && !active.has(session.threadId)) active.set(session.threadId, 'unknown');
  // thread/read can briefly report idle after turn/start; only a known completed turn clears our reservation.
  if (!running && active.has(session.threadId)) {
    const known = active.get(session.threadId);
    const turns = await listTurns(session.threadId, { limit: 5 });
    if (turns.data.some(t => t.id === known && ['completed','failed','interrupted'].includes(t.status))) active.delete(session.threadId);
  }
  return result.thread;
}
router.patch('/projects/:pid', async (req, res) => {
  await projects.locks.run(key(req), async () => res.json({ project: await projects.update(req.user.id, req.params.pid, p => { p.name = displayName(req.body.name); }) }));
});
async function deleteThread(session) {
  try { await bus.rpc('thread/delete', { threadId: session.threadId }); }
  catch (e) { if (!/thread.*not found|thread.*does not exist|no rollout found/i.test(e.message)) throw e; }
  registry.delete(session.threadId); active.delete(session.threadId);
}
router.delete('/projects/:pid', async (req, res) => {
  await projects.locks.run(key(req), async () => {
    let project = await projects.get(req.user.id, req.params.pid);
    for (const session of project.sessions) await syncState(session).catch(e => { if (!project.deleting) throw e; });
    assertIdle(project);
    await projects.update(req.user.id, req.params.pid, p => { p.deleting = true; });
    for (const session of [...project.sessions]) {
      await deleteThread(session);
      await projects.update(req.user.id, req.params.pid, p => { p.sessions = p.sessions.filter(s => s.id !== session.id); });
    }
    await projects.checkedDirectory(req.user.id, req.params.pid);
    await rm(projects.directory(req.user.id, req.params.pid), { recursive: true });
    await projects.removeEmptyUserDirectory(req.user.id);
    res.json({ ok: true });
  });
});
router.post('/projects/:pid/sessions', async (req, res) => {
  await projects.locks.run(key(req), async () => {
    const project = await projects.get(req.user.id, req.params.pid);
    if (project.deleting) throw new HttpError(409, '项目正在删除，可重试删除');
    const result = await bus.rpc('thread/start', { cwd: cwd(req), approvalPolicy: config.approvalPolicy, sandbox: config.sandbox });
    const session = { id: randomUUID(), threadId: result.thread.id, name: displayName(req.body.name || '新会话'), createdAt: new Date().toISOString(), hasTurns: false };
    try { await projects.update(req.user.id, req.params.pid, p => { p.sessions.push(session); }); }
    catch (e) { await deleteThread(session).catch(error => console.error('orphan_thread', session.threadId, error.message)); throw e; }
    registry.set(session.threadId, { uid: req.user.id, pid: req.params.pid, sid: session.id });
    res.status(201).json({ session });
  });
});
router.patch('/projects/:pid/sessions/:sid', async (req, res) => {
  await projects.locks.run(key(req), async () => {
    const { session } = await getSession(req); const name = displayName(req.body.name);
    await bus.rpc('thread/name/set', { threadId: session.threadId, name });
    await projects.update(req.user.id, req.params.pid, p => { p.sessions.find(s => s.id === session.id).name = name; });
    res.json({ ok: true });
  });
});
router.delete('/projects/:pid/sessions/:sid', async (req, res) => {
  await projects.locks.run(key(req), async () => {
    const { session } = await getSession(req); await syncState(session);
    if (active.has(session.threadId)) throw new HttpError(409, '会话正在执行，请先停止');
    await deleteThread(session);
    await projects.update(req.user.id, req.params.pid, p => { p.sessions = p.sessions.filter(s => s.id !== session.id); });
    res.json({ ok: true });
  });
});
function publicTurn(turn) { return { ...turn, items: (turn.items || []).filter(i => i.type !== 'reasoning') }; }
async function listTurns(threadId, params = {}) {
  try { return await bus.rpc('thread/turns/list', { threadId, ...params }); }
  catch (error) {
    if (/not materialized yet/.test(error.message)) return { data: [], nextCursor: null };
    if (!/list_turns is not supported|unsupported.*method/i.test(error.message)) throw error;
    const legacy = await bus.rpc('thread/read', { threadId, includeTurns: true });
    const offset = params.cursor ? Number(String(params.cursor).replace(/^legacy:/, '')) : 0;
    requireValue(Number.isSafeInteger(offset) && offset >= 0, '历史游标无效');
    const turns = [...(legacy.thread.turns || [])].reverse();
    const end = offset + (params.limit || 20);
    return { data: turns.slice(offset, end), nextCursor: end < turns.length ? `legacy:${end}` : null };
  }
}
router.get('/projects/:pid/sessions/:sid/history', async (req, res) => {
  const { session } = await getSession(req);
  const thread = await syncState(session);
  const result = await listTurns(session.threadId, { limit: 20, itemsView: 'full', sortDirection: 'desc', ...(req.query.cursor ? { cursor: String(req.query.cursor) } : {}) });
  res.json({ turns: result.data.map(publicTurn), nextCursor: result.nextCursor, active: active.get(session.threadId) || null,
    approvals: [...approvals.values()].filter(a => a.threadId === session.threadId).map(a => a.message), status: thread.status });
});
router.post('/projects/:pid/sessions/:sid/messages', express.json({ limit: '56mb' }), async (req, res) => {
  requireValue(req.body && typeof req.body === 'object', '消息格式无效');
  const text = req.body.text ?? '';
  const images = decodeImages(req.body.images);
  const files = decodeFiles(req.body.files);
  requireValue(images.length + files.length <= 4, '每条消息最多附带 4 个文件');
  requireValue(typeof text === 'string' && text.length <= 30000 && (text.trim().length > 0 || images.length > 0 || files.length > 0), '请输入消息或附带文件，文字最多 30000 个字符');
  await projects.locks.run(key(req), async () => {
    const { project, session } = await getSession(req);
    if (project.deleting) throw new HttpError(409, '项目正在删除');
    await syncState(session);
    async function input() {
      const content = text.trim() ? [{ type: 'text', text }] : [];
      if (images.length || files.length) {
        const root = await projects.checkedDirectory(req.user.id, req.params.pid);
        const dateParts = attachmentDate.formatToParts(new Date());
        const day = ['year', 'month', 'day'].map(type => dateParts.find(part => part.type === type).value).join('');
        for (const relative of ['attachments', `attachments/${day}`]) {
          try { await mkdir(path.join(root, relative)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          const directory = await projects.file(req.user.id, req.params.pid, relative);
          requireValue(directory.stat.isDirectory(), '附件路径必须是文件夹');
        }
        const { target } = await projects.file(req.user.id, req.params.pid, `attachments/${day}`);
        const saved = [];
        async function save(bytes, originalName) {
          const parsed = path.parse(originalName);
          const base = parsed.name || '文件';
          const ext = parsed.ext;
          for (let index = 0; index < 10000; index++) {
            const name = `${base}${index ? index : ''}${ext}`;
            const destination = path.join(target, name);
            try {
              const handle = await open(destination, 'wx', 0o600);
              saved.push(destination);
              try { await handle.writeFile(bytes); } finally { await handle.close(); }
              return name;
            }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
          throw new HttpError(409, '附件名称冲突过多，请稍后重试');
        }
        try {
          for (const image of images) {
            const name = await save(image.bytes, `图片.${image.extension}`);
            content.push({ type: 'localImage', path: path.posix.join(cwd(req), 'attachments', day, name) });
          }
          for (const file of files) {
            const name = await save(file.bytes, file.name);
            const relative = path.posix.join('attachments', day, name);
            content.push({ type: 'text', text: `附件：${JSON.stringify({ name, path: relative })}` });
            if (file.image) content.push({ type: 'localImage', path: path.posix.join(cwd(req), relative) });
          }
        } catch (error) {
          await Promise.all(saved.map(file => rm(file, { force: true })));
          throw error;
        }
      }
      return content;
    }
    if (req.body.steer) {
      const turnId = active.get(session.threadId);
      if (!turnId || turnId === 'unknown') throw new HttpError(409, '没有可追加的活动任务，请刷新');
      await bus.rpc('turn/steer', { threadId: session.threadId, expectedTurnId: turnId, input: await input() });
      return res.json({ turnId, steered: true });
    }
    const loaded = await bus.rpc('thread/loaded/list');
    if (!loaded.data.includes(session.threadId)) await bus.rpc('thread/resume', { threadId: session.threadId, cwd: cwd(req), approvalPolicy: config.approvalPolicy, sandbox: config.sandbox });
    await reserveTask(session);
    let started = false;
    try {
      const result = await bus.rpc('turn/start', { threadId: session.threadId, input: await input() });
      started = true;
      await projects.update(req.user.id, req.params.pid, p => { p.sessions.find(s => s.id === session.id).hasTurns = true; });
      if (active.has(session.threadId)) active.set(session.threadId, result.turn.id);
      res.json({ turnId: result.turn.id });
    } catch (e) {
      if (!started) { active.delete(session.threadId); concurrencyRunId = undefined; }
      throw e;
    }
  });
});
router.post('/projects/:pid/sessions/:sid/stop', async (req, res) => {
  const { session } = await getSession(req);
  const thread = await syncState(session);
  let turnId = active.get(session.threadId);
  if (turnId === 'unknown' || turnId === 'pending') {
    const turns = await listTurns(session.threadId, { limit: 5 });
    turnId = turns.data.find(t => t.status === 'inProgress')?.id;
  }
  if (!turnId) return res.json({ ok: true });
  await bus.rpc('turn/interrupt', { threadId: session.threadId, turnId }); res.json({ ok: true });
});
router.post('/projects/:pid/sessions/:sid/approval', async (req, res) => {
  const { session } = await getSession(req);
  const approval = approvals.get(String(req.body.requestId));
  if (!approval || approval.threadId !== session.threadId) throw new HttpError(404, '审批已结束或不属于本会话');
  requireValue(['accept', 'decline', 'cancel'].includes(req.body.decision), '审批决定无效');
  await bus.publish({ id: approval.message.id, result: { decision: req.body.decision } });
  approvals.delete(String(req.body.requestId)); res.json({ ok: true });
});
router.get('/projects/:pid/files', async (req, res) => {
  await projects.get(req.user.id, req.params.pid);
  const { target, stat } = await projects.file(req.user.id, req.params.pid, String(req.query.path || ''));
  if (!stat.isDirectory()) throw new HttpError(400, '不是文件夹');
  const names = (await readdir(target)).filter(n => !n.startsWith('.web-'));
  const files = [];
  for (const name of names.slice(0, 1000)) {
    try { const s = await lstat(path.join(target, name)); if (!s.isSymbolicLink()) files.push({ name, directory: s.isDirectory(), size: s.size, modifiedAt: s.mtime.toISOString() }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  res.json({ files: files.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)), truncated: names.length > 1000 });
});
router.get('/projects/:pid/download', async (req, res, next) => {
  await projects.get(req.user.id, req.params.pid);
  const { target, stat } = await projects.file(req.user.id, req.params.pid, String(req.query.path || ''), false);
  if (!stat.isFile()) throw new HttpError(400, '仅支持下载文件');
  res.attachment(path.basename(target));
  const stream = createReadStream(target, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) });
  stream.on('error', next); stream.pipe(res);
});
router.get('/projects/:pid/image', async (req, res, next) => {
  await projects.get(req.user.id, req.params.pid);
  let relative = String(req.query.path || '');
  if (relative.startsWith('file://')) {
    try { const url = new URL(relative); if (url.host) throw new Error(); relative = decodeURIComponent(url.pathname); }
    catch { throw new HttpError(400, '图片路径无效'); }
  }
  if (relative.startsWith('sandbox:')) relative = relative.slice('sandbox:'.length);
  if (path.posix.isAbsolute(relative)) relative = path.posix.relative(cwd(req), relative);
  if (relative.startsWith('./')) relative = relative.slice(2);
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' };
  const type = types[path.extname(relative).toLowerCase()];
  if (!type) throw new HttpError(400, '不支持预览此图片格式');
  const { target, stat } = await projects.file(req.user.id, req.params.pid, relative, false);
  if (!stat.isFile()) throw new HttpError(400, '不是图片文件');
  res.type(type);
  res.setHeader('Content-Disposition', 'inline');
  const stream = createReadStream(target, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) });
  stream.on('error', next); stream.pipe(res);
});
router.delete('/projects/:pid/files', async (req, res) => {
  await projects.locks.run(key(req), async () => {
    const project = await projects.get(req.user.id, req.params.pid);
    for (const session of project.sessions) await syncState(session);
    assertIdle(project);
    const { target } = await projects.file(req.user.id, req.params.pid, String(req.query.path || ''), false);
    await rm(target, { recursive: true }); res.json({ ok: true });
  });
});
app.use('/api', router);
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(appRoot, 'dist'), { index: 'index.html' }));
app.get('/{*route}', (req, res) => res.sendFile(path.join(appRoot, 'dist/index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error('request_error', req.method, req.path, error.message);
  res.status(status).json({ error: status === 500 ? '服务端操作失败，请查看日志后重试' : error.message });
});
const server = createServer(app);
const ws = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  try {
    if (new URL(req.url, 'http://localhost').pathname !== '/events') throw new Error();
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error();
    const user = auth.user(req);
    ws.handleUpgrade(req, socket, head, client => {
      client.uid = user.id; client.request = req; sockets.add(client);
      client.send(JSON.stringify({ type: 'status', ...status() }));
      client.on('close', () => sockets.delete(client));
      client.on('error', () => sockets.delete(client));
    });
  } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});
const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    try { auth.user(socket.request); socket.ping(); } catch { socket.close(1008, '登录已失效'); }
  }
  for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
}, 30000);
server.listen(config.port, '0.0.0.0', () => console.log(`Web ready on :${config.port}; MQTT ${config.mqtt.url}; workspace ${config.workspaceRoot}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; clearInterval(heartbeat);
  for (const socket of sockets) socket.close(1001, '服务重启');
  server.close(); await bus.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
