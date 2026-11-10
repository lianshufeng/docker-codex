import express from 'express';
import { externalUrl, formFields, validField } from '../elicitation.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import sharp from 'sharp';
import { FileTransport, chunkBytes, checksum } from './file-transport.mjs';
import { Locks, HttpError, requireValue, displayName } from './storage.mjs';
import { decodeImages, decodeFiles } from './images.mjs';
import { absolute, projectId, projectOf, sessionOf, listThreadPage, listThreads, checkedPath, imagePath, projectOptions, linuxProjectPath } from './app-workspace.mjs';
import { historyPage } from './history-page.mjs';
import { projectCatalog } from './project-catalog.mjs';

export function sharedApi(bus, config, broadcast) {
  const router = express.Router(), locks = new Locks(), admissions = new Locks();
  const transport = bus.client ? new FileTransport(bus) : null;
  const context = new AsyncLocalStorage();
  // A multi-step HTTP operation must never continue writing to a different endpoint.
  bus = new Proxy(bus, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'rpc' || key === 'publish') return (...args) => {
      const request = context.getStore();
      if (request && request.runId !== target.state.runId) return Promise.reject(new HttpError(503, '执行端连接已变化，请重新查询后操作'));
      return value.apply(target, args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  router.use((req, res, next) => context.run({ runId: bus.state.runId }, next));
  const reservations = new Map(), approvals = new Map(), submitted = new Map();
  const listedSession = t => ({ ...sessionOf(t), running: t.status?.type === 'active' || reservations.has(t.id) });
  const catalogPage = projectCatalog(bus, listedSession);
  const capabilities = () => ({ steer: bus.supports('turn/steer'), plan: bus.supports('config/read') && bus.supports('turn/start'),
    renameThread: bus.supports('thread/name/set'), archiveThread: bus.supports('thread/archive'),
    files: bus.supports('fs/readDirectory') && bus.supports('fs/readFile'), shared: true,
    fileTransfer: transport?.limits(), maxFileBytes: transport?.limits() ? transport.limits().maxFileBytes : null });
  const status = () => ({ connected: bus.ready(), state: bus.state.state, runId: bus.state.runId,
    activeTasks: reservations.size, maxConcurrentTasks: null, capabilities: capabilities() });
  let runId;
  bus.on('status', () => {
    if (runId !== bus.state.runId || !bus.ready()) { reservations.clear(); approvals.clear(); }
    runId = bus.state.runId;
    broadcast(null, { type: 'status', ...status() });
  });
  bus.on('notification', (message, generation) => {
    if (generation !== bus.state.runId) return;
    const params = message.params || {}, id = params.threadId || params.thread?.id;
    if (message.method === 'serverRequest/resolved') approvals.delete(String(params.requestId));
    if (!id) return;
    if (message.method === 'turn/started') reservations.set(id, params.turn.id);
    if (message.method === 'turn/completed') {
      reservations.delete(id);
      for (const [key, approval] of approvals) {
        if (approval.params?.threadId !== id) continue;
        if (approval.method === 'mcpServer/elicitation/request' && approval.params.turnId !== params.turn.id) continue;
        approvals.delete(key);
      }
    }
    if (message.id !== undefined) approvals.set(String(message.id), message);
    broadcast(null, { type: 'rpc', sessionId: id, payload: message });
    if (['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived', 'thread/deleted'].includes(message.method)) {
      const created = message.method === 'thread/started' && params.thread?.cwd;
      const project = created ? { ...projectOf(params.thread.cwd), sessions: [sessionOf(params.thread)] } : undefined;
      broadcast(null, { type: 'projects-changed', project,
        removed: ['thread/archived', 'thread/deleted'].includes(message.method) ? id : undefined });
    }
  });
  function root(req) {
    const decoded = Buffer.from(req.params.pid, 'base64url').toString('utf8');
    requireValue(projectId(decoded) === req.params.pid, '目录标识无效');
    return absolute(decoded);
  }
  async function thread(req) {
    const result = await bus.rpc('thread/read', { threadId: req.params.sid });
    if (projectId(result.thread.cwd) !== req.params.pid) throw new HttpError(404, '会话不在此目录');
    return result.thread;
  }
  async function turns(id, cursor) {
    try { return await bus.rpc('thread/turns/list', { threadId: id, limit: 20, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) }); }
    catch (error) { if (/not materialized yet/.test(error.message)) return { data: [], nextCursor: null }; throw error; }
  }
  async function idle(cwd) {
    const threads = await listThreads(bus, { cwd });
    if (threads.some(t => t.status?.type === 'active' || reservations.has(t.id))) throw new HttpError(409, '目录中有任务运行，请先停止任务');
  }
  async function transfer(req, operation, data) {
    if (!transport) throw new HttpError(409, '文件服务不可用');
    const generation = context.getStore().runId;
    if (generation !== bus.state.runId) throw new HttpError(503, '执行端已变化，请重试');
    return transport.request({ ...operation, root: root(req) }, data);
  }
  router.post('/projects/:pid/uploads', async (req, res) => {
    const cwd = root(req), size = req.body.size;
    if (!transport?.limits()) throw new HttpError(409, '执行端需要升级大文件传输服务');
    requireValue(Number.isSafeInteger(size) && size >= 0, '附件大小无效');
    requireValue(typeof req.body.threadId === 'string', '请选择会话');
    const { thread: owner } = await bus.rpc('thread/read', { threadId: req.body.threadId });
    requireValue(projectId(owner.cwd) === req.params.pid, '会话不在此目录');
    const name = String(req.body.name || '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    requireValue(name && Buffer.byteLength(name) <= 180 && !name.startsWith('.web-'), '附件名称无效');
    const image = Boolean(req.body.image) || /\.(png|jpe?g|gif|webp)$/i.test(name);
    const attachment = await checkedPath(bus, cwd, 'attachments', { allowMissing: true });
    if (!attachment.stat) await bus.rpc('fs/createDirectory', { path: attachment.target, recursive: true });
    const transferId = req.body.transferId || randomUUID();
    requireValue(typeof transferId === 'string' && /^[a-f0-9-]{36}$/.test(transferId), '上传标识无效');
    const relative = `attachments/${transferId}-${name}`;
    const receipt = await transfer(req, { op: 'begin', transferId, relative, name, size, image });
    res.status(201).json({ transferId, ...receipt, chunkBytes });
  });
  router.get('/projects/:pid/uploads/:upload', async (req, res) => {
    res.json(await transfer(req, { op: 'status', transferId: req.params.upload }));
  });
  router.put('/projects/:pid/uploads/:upload', express.raw({ type: 'application/octet-stream', limit: chunkBytes }), async (req, res) => {
    requireValue(Buffer.isBuffer(req.body), '文件块无效');
    const offset = Number(req.query.offset);
    requireValue(Number.isSafeInteger(offset) && offset >= 0, '文件块偏移无效');
    const sha256 = checksum(req.body);
    requireValue(!req.headers['x-chunk-sha256'] || sha256 === req.headers['x-chunk-sha256'], '文件块校验失败');
    res.json(await transfer(req, { op: 'write', transferId: req.params.upload, offset, sha256 }, req.body));
  });
  router.post('/projects/:pid/uploads/:upload/finish', async (req, res) => {
    res.json(await transfer(req, { op: 'finish', transferId: req.params.upload, sha256: req.body.sha256 }));
  });
  router.delete('/projects/:pid/uploads/:upload', async (req, res) => {
    res.json(await transfer(req, { op: 'abort', transferId: req.params.upload }));
  });
  router.get('/status', (req, res) => res.json(status()));
  router.get('/projects', async (req, res) => {
    const paged = req.query.view === 'page';
    const selected = typeof req.query.selected === 'string' ? req.query.selected : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const pageCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    if (req.query.view === 'catalog') return res.json(await catalogPage(pageCursor, req.user?.id));
    const page = paged ? await listThreadPage(bus, { limit: 30, sortKey: 'updated_at',
      cursor: pageCursor, ...(query ? { searchTerm: query } : {}) }) : null;
    const threads = page ? page.data.slice(0, 30) : await listThreads(bus);
    if (page && !pageCursor && !query && selected && !threads.some(t => t.id === selected)) {
      try {
        const { thread: saved } = await bus.rpc('thread/read', { threadId: selected });
        if (!saved.archived && !/[\\/]archived_sessions[\\/]/.test(saved.path || '')) threads.push(saved);
      } catch (error) {
        if (!/not found|not loaded|no (?:rollout|thread)|invalid.*(?:id|uuid)/i.test(error.message)) throw error;
      }
    }
    // Empty in-memory threads are not necessarily materialized on disk yet.
    if (!paged && bus.supports('thread/loaded/list')) {
      let cursor;
      do {
        const page = await bus.rpc('thread/loaded/list', cursor ? { cursor } : {});
        for (const id of page.data) if (!threads.some(t => t.id === id)) {
          try {
            const result = await bus.rpc('thread/read', { threadId: id });
            threads.push(result.thread);
          } catch (error) {
            // The thread may be deleted between the loaded-list snapshot and this read.
            if (error.message !== `thread not loaded: ${id}`) throw error;
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const groups = new Map();
    for (const t of threads) {
      if (!t.cwd) continue;
      const p = projectOf(t.cwd);
      if (!groups.has(p.id)) groups.set(p.id, p);
      groups.get(p.id).sessions.push(listedSession(t));
    }
    const projects = [...groups.values()];
    for (const p of projects) p.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ projects, nextCursor: page?.nextCursor ?? null });
  });
  router.get('/projects/:pid/sessions', async (req, res) => {
    const cwd = root(req);
    const threads = await listThreads(bus, { cwd, sortKey: 'updated_at' });
    const sessions = threads.filter(t => t.cwd && projectId(t.cwd) === req.params.pid).map(listedSession);
    res.json({ sessions });
  });
  async function create(cwd, name) {
    const requestedName = name ? displayName(name) : undefined;
    if (requestedName && !bus.supports('thread/name/set')) throw new HttpError(409, '当前连接尚未支持修改会话名称，请更新桌面连接服务，或不填写名称创建会话');
    const { thread: created } = await bus.rpc('thread/start', { cwd, sandbox: config.sandbox, approvalPolicy: config.approvalPolicy });
    if (projectId(created.cwd) !== projectId(cwd)) throw new HttpError(502, '执行端工作目录不匹配');
    let warning;
    if (requestedName) {
      try { await bus.rpc('thread/name/set', { threadId: created.id, name: requestedName }); }
      catch (error) {
        // The thread already exists. Return it so a naming failure cannot cause duplicate creation.
        warning = `会话已创建，名称暂未保存：${error.message}`;
      }
    }
    broadcast(null, { type: 'projects-changed' });
    return { thread: { ...created, ...(!warning && requestedName ? { name: requestedName } : {}) }, warning };
  }
  router.post('/projects', async (req, res) => {
    let cwd;
    if (req.body.path) cwd = absolute(req.body.path);
    else {
      cwd = linuxProjectPath(req.body.name);
      const options = await projectOptions(bus);
      requireValue(options.platform === 'linux', '请选择项目文件夹');
      await locks.run(cwd, async () => {
        const { stat } = await checkedPath(bus, cwd, '', { allowMissing: true });
        if (!stat) await bus.rpc('fs/createDirectory', { path: cwd, recursive: false });
      });
    }
    if (bus.supports('fs/getMetadata')) {
      const { stat } = await checkedPath(bus, cwd);
      requireValue(stat.isDirectory, '请选择已有目录');
    }
    const { thread: t } = await create(cwd);
    res.status(201).json({ project: { ...projectOf(t.cwd), sessions: [sessionOf(t)] } });
  });
  router.get('/project-options', async (req, res) => res.json(await projectOptions(bus)));
  router.get('/directories', async (req, res) => {
    const cwd = absolute(String(req.query.path || ''));
    const { stat } = await checkedPath(bus, cwd);
    requireValue(stat.isDirectory, '请选择文件夹');
    const result = await bus.rpc('fs/readDirectory', { path: cwd });
    const api = /^[a-z]:/i.test(cwd) ? path.win32 : path.posix;
    res.json({ path: cwd, parent: api.dirname(cwd) === cwd ? null : api.dirname(cwd),
      entries: result.entries.filter(e => e.isDirectory && !e.fileName.startsWith('.web-'))
        .map(e => ({ ...e, path: api.join(cwd, e.fileName) })) });
  });
  router.post('/directories', async (req, res) => {
    const cwd = absolute(req.body.path);
    await checkedPath(bus, cwd, '', { allowMissing: true });
    await bus.rpc('fs/createDirectory', { path: cwd, recursive: false }); res.status(201).json({ path: cwd });
  });
  router.patch('/projects/:pid', (req, res) => { throw new HttpError(409, '项目按目录分组，请直接修改会话名称'); });
  router.delete('/projects/:pid', (req, res) => { throw new HttpError(409, '请逐个删除会话，目录与文件单独管理'); });
  router.post('/projects/:pid/sessions', async (req, res) => {
    const created = await create(root(req), req.body.name);
    res.status(201).json({ session: sessionOf(created.thread), ...(created.warning ? { warning: created.warning } : {}) });
  });
  router.patch('/projects/:pid/sessions/:sid', async (req, res) => {
    const name = displayName(req.body.name);
    await locks.run(req.params.sid, async () => {
      await thread(req);
      await bus.rpc('thread/name/set', { threadId: req.params.sid, name });
      const result = await thread(req);
      if (result.name !== name) throw new HttpError(502, '会话名称未保存到执行端，请刷新后重试');
      broadcast(null, { type: 'projects-changed' }); res.json({ ok: true, session: sessionOf(result) });
    });
  });
  async function archiveSession(req, res) {
    await locks.run(req.params.sid, async () => {
      let t;
      try { t = await thread(req); }
      catch (error) {
        if (!/thread not loaded/.test(error.message)) throw error;
        t = (await listThreads(bus, { cwd: root(req) })).find(candidate => candidate.id === req.params.sid);
        if (!t) throw new HttpError(404, '会话不在此目录');
      }
      if (t && (t.status?.type === 'active' || reservations.has(t.id))) throw new HttpError(409, '会话正在执行，请先停止');
      await bus.rpc('thread/archive', { threadId: req.params.sid });
      broadcast(null, { type: 'projects-changed' }); res.json({ ok: true });
    });
  }
  router.post('/projects/:pid/sessions/:sid/archive', archiveSession);
  // Older pages may still submit DELETE. They receive the same archive behavior.
  router.delete('/projects/:pid/sessions/:sid', archiveSession);
  router.get('/projects/:pid/sessions/:sid/history', async (req, res) => {
    const t = await thread(req), cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const pending = () => [...approvals.values()].filter(a => a.params?.threadId === t.id);
    if (req.query.view === 'items') {
      const page = await historyPage(bus, t.id, cursor, { itemId: typeof req.query.output === 'string' ? req.query.output : undefined,
        turnId: typeof req.query.turn === 'string' ? req.query.turn : undefined });
      return res.json({ ...page, active: t.status?.type === 'active' || reservations.has(t.id), approvals: pending() });
    }
    const result = await turns(t.id, cursor);
    const activeTurn = result.data.find(turn => turn.status === 'inProgress');
    const running = t.status?.type === 'active' || activeTurn;
    if (!running && result.data.some(turn => turn.id === reservations.get(t.id) && turn.status !== 'inProgress')) reservations.delete(t.id);
    res.json({ turns: result.data,
      nextCursor: result.nextCursor, active: running ? activeTurn?.id || reservations.get(t.id) || 'unknown' : reservations.get(t.id) || null,
      approvals: pending(), status: t.status });
  });
  router.post('/projects/:pid/sessions/:sid/messages', express.json({ limit: Number.MAX_SAFE_INTEGER }), async (req, res) => {
    const requestId = req.body.requestId;
    requireValue(requestId === undefined || (typeof requestId === 'string' && /^[a-f0-9]{32}$/i.test(requestId)), '消息请求标识无效');
    const key = requestId && JSON.stringify([req.user?.id, req.params.sid, requestId]);
    const remember = result => {
      if (!key) return;
      const now = Date.now();
      for (const [id, receipt] of submitted) if (receipt.expires <= now) submitted.delete(id);
      if (submitted.size >= 2048) submitted.delete(submitted.keys().next().value);
      submitted.set(key, { result, expires: now + 15 * 60_000 });
    };
    const text = req.body.text || '', images = decodeImages(req.body.images), files = decodeFiles(req.body.files);
    const attachments = req.body.attachments || [];
    requireValue(Array.isArray(attachments), '附件引用无效');
    requireValue(typeof text === 'string' && (text.trim() || images.length || files.length || attachments.length), '请输入消息或附件');
    await locks.run(req.params.sid, async () => {
      let t = await thread(req);
      const receipt = key && submitted.get(key);
      if (receipt && receipt.expires > Date.now()) {
        if (!receipt.result) throw new HttpError(503, '上一条消息的发送结果待确认，请查看会话历史');
        return res.json({ ...receipt.result, duplicate: true });
      }
      if (!req.body.steer && (t.status?.type === 'active' || reservations.has(t.id))) throw new HttpError(409, '会话正在执行');
      if (req.body.steer && !bus.supports('turn/steer')) throw new HttpError(409, '执行端不支持追加要求');
      const content = text.trim() ? [{ type: 'text', text }] : [];
      for (const transferId of attachments) {
        const receipt = await transfer(req, { op: 'status', transferId });
        requireValue(receipt.complete, '附件尚未上传完成');
        const location = await checkedPath(bus, t.cwd, receipt.relative);
        requireValue(location.stat.isFile, '附件已删除');
        content.push(receipt.image ? { type: 'localImage', path: location.target }
          : { type: 'text', text: `附件：${JSON.stringify({ name: receipt.name, path: receipt.relative })}` });
      }
      if (images.length || files.length) {
        const api = /^[a-z]:/i.test(t.cwd) ? path.win32 : path.posix;
        const attachment = await checkedPath(bus, t.cwd, 'attachments', { allowMissing: true });
        if (!attachment.stat) await bus.rpc('fs/createDirectory', { path: attachment.target, recursive: true });
        await checkedPath(bus, t.cwd, 'attachments');
        for (const f of [...images.map(i => ({ ...i, name: `图片.${i.extension}`, image: true })), ...files]) {
          const relative = `attachments/${randomUUID()}-${f.name}`;
          const saved = await checkedPath(bus, t.cwd, relative, { allowMissing: true });
          await bus.rpc('fs/writeFile', { path: saved.target, dataBase64: f.bytes.toString('base64') });
          content.push(f.image ? { type: 'localImage', path: api.join(t.cwd, relative) }
            : { type: 'text', text: `附件：${JSON.stringify({ name: f.name, path: relative })}` });
        }
      }
      if (req.body.steer) {
        const history = await turns(t.id), activeTurn = history.data.find(x => x.status === 'inProgress');
        const turnId = activeTurn?.id || reservations.get(t.id);
        requireValue(turnId && turnId !== 'pending', '没有可追加的活动任务');
        remember(null);
        try { await bus.rpc('turn/steer', { threadId: t.id, expectedTurnId: turnId, input: content }); }
        catch (error) { if (![503, 504].includes(error.status)) submitted.delete(key); throw error; }
        const result = { turnId, steered: true };
        remember(result);
        return res.json(result);
      }
      await admissions.run('tasks', async () => {
        if (reservations.has(t.id) || t.status?.type === 'active') throw new HttpError(409, '会话正在执行');
        reservations.set(t.id, 'pending');
      });
      try {
        if (t.status?.type === 'notLoaded') t = (await bus.rpc('thread/resume', { threadId: t.id, excludeTurns: true })).thread;
        let collaborationMode;
        if (typeof req.body.plan === 'boolean') {
          const { config: effective } = await bus.rpc('config/read', { cwd: t.cwd });
          let model = effective?.model;
          if (!model) {
            const { data } = await bus.rpc('model/list');
            model = data.find(candidate => candidate.isDefault)?.model;
          }
          requireValue(typeof model === 'string' && model, '无法确定协作模式使用的模型');
          collaborationMode = { mode: req.body.plan ? 'plan' : 'default', settings: {
            model, reasoning_effort: effective?.model_reasoning_effort ?? null, developer_instructions: null } };
        }
        remember(null);
        const { turn } = await bus.rpc('turn/start', { threadId: t.id, input: content, ...(collaborationMode ? { collaborationMode } : {}) });
        if (reservations.has(t.id)) reservations.set(t.id, turn.id);
        const result = { turnId: turn.id };
        remember(result);
        res.json(result);
      } catch (error) {
        if (![503, 504].includes(error.status)) { reservations.delete(t.id); submitted.delete(key); }
        throw error;
      }
    });
  });
  router.post('/projects/:pid/sessions/:sid/stop', async (req, res) => {
    const t = await thread(req), result = await turns(t.id);
    const turn = result.data.find(x => x.status === 'inProgress');
    if (turn) await bus.rpc('turn/interrupt', { threadId: t.id, turnId: turn.id });
    res.json({ ok: true });
  });
  router.post('/projects/:pid/sessions/:sid/approval', async (req, res) => {
    const t = await thread(req), key = String(req.body.requestId), pending = approvals.get(key);
    await locks.run(`response:${key}`, async () => {
      if (!pending || approvals.get(key) !== pending || pending.params?.threadId !== t.id) {
        throw new HttpError(404, '此请求已结束');
      }
      let result;
      if (pending.method === 'item/tool/requestUserInput') {
        const { answers } = req.body;
        const questions = pending.params.questions;
        requireValue(answers && typeof answers === 'object' && !Array.isArray(answers) &&
          Object.keys(answers).length === questions.length, '请回答所有问题');
        result = { answers: Object.fromEntries(questions.map(question => {
          const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : null;
          requireValue(typeof answer === 'string' && answer.trim() &&
            (!question.options?.length || question.isOther || question.options.some(option => option.label === answer)),
          '请选择有效选项或填写答案');
          return [question.id, { answers: [answer] }];
        })) };
      } else if (pending.method === 'mcpServer/elicitation/request') {
        const { action, content } = req.body;
        requireValue(['accept', 'decline', 'cancel'].includes(action), '表单操作无效');
        result = { action, content: null, _meta: null };
        if (action === 'accept' && ['form', 'openai/form'].includes(pending.params.mode)) {
          const fields = formFields(pending.params.requestedSchema);
          requireValue(fields, '此表单包含暂不支持的题型');
          requireValue(content && typeof content === 'object' && !Array.isArray(content) &&
            Object.keys(content).every(name => fields.some(field => field.name === name)), '表单字段无效');
          for (const field of fields) {
            const present = Object.hasOwn(content, field.name);
            requireValue(present ? validField(field, content[field.name]) : !field.required,
              `请检查「${field.title || field.name}」的答案`);
          }
          result.content = content;
        } else if (action === 'accept') {
          requireValue(pending.params.mode === 'url' && externalUrl(pending.params.url), '外部链接无效');
        }
      } else if (pending.method === 'item/permissions/requestApproval') {
        requireValue(['accept', 'decline'].includes(req.body.decision), '审批决定无效');
        result = { permissions: req.body.decision === 'accept' ? pending.params.permissions : {}, scope: 'turn' };
      } else {
        requireValue(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(pending.method), '此请求类型暂不支持');
        requireValue(['accept', 'decline', 'cancel'].includes(req.body.decision), '审批决定无效');
        result = { decision: req.body.decision };
      }
      await bus.publish({ id: pending.id, result });
      if (approvals.get(key) === pending) {
        approvals.delete(key);
        broadcast(null, { type: 'rpc', sessionId: t.id,
          payload: { method: 'serverRequest/resolved', params: { threadId: t.id, requestId: pending.id } } });
      }
    });
    res.json({ ok: true });
  });
  router.get('/projects/:pid/files', async (req, res) => {
    const { target, stat } = await checkedPath(bus, root(req), String(req.query.path || ''));
    requireValue(stat.isDirectory, '不是目录');
    const { entries } = await bus.rpc('fs/readDirectory', { path: target });
    res.json({ files: entries.filter(e => !e.fileName.startsWith('.web-')).map(e => ({ name: e.fileName, directory: e.isDirectory, size: null })) });
  });
  async function download(req, res, image = false) {
    const relative = image ? imagePath(root(req), String(req.query.path || '')) : String(req.query.path || '');
    const { target, stat } = await checkedPath(bus, root(req), relative, { allowRoot: false });
    requireValue(stat.isFile, '请选择文件');
    if (transport?.limits()) {
      const file = await transfer(req, { op: 'open', relative });
      let start = 0, end = file.size - 1;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${file.version}"`);
      if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === `"${file.version}"`)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        } else start = -1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) {
          return res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
        }
        res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
      }
      if (image) {
        requireValue(/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(relative), '图片格式无效');
        res.type(path.extname(relative));
      } else res.attachment(relative.split('/').at(-1));
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD') return res.end();
      for (let offset = start; offset <= end && !res.destroyed; offset += chunkBytes) {
        const result = await transfer(req, { op: 'read', relative, offset, length: Math.min(chunkBytes, end - offset + 1), version: file.version });
        requireValue(result.data.length === Math.min(chunkBytes, end - offset + 1) && checksum(result.data) === result.sha256, '下载块校验失败');
        if (!res.write(result.data)) await new Promise(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done); res.once('close', done);
        });
      }
      return res.end();
    }
    const { dataBase64 } = await bus.rpc('fs/readFile', { path: target });
    const bytes = Buffer.from(dataBase64, 'base64');
    if (image) {
      requireValue(/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(relative), '图片格式无效');
      res.type(path.extname(relative));
    } else res.attachment(relative.split('/').at(-1));
    res.send(bytes);
  }
  async function thumbnail(req, res) {
    const relative = imagePath(root(req), String(req.query.path || ''));
    requireValue(/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(relative), '图片格式无效');
    const { target, stat } = await checkedPath(bus, root(req), relative, { allowRoot: false });
    requireValue(stat.isFile, '请选择文件');
    const maxBytes = 12 * 1024 * 1024;
    let bytes;
    if (transport?.limits()) {
      const file = await transfer(req, { op: 'open', relative });
      if (file.size > maxBytes) throw new HttpError(413, '图片过大，请直接查看原图');
      const chunks = [];
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        if (res.destroyed) return;
        const length = Math.min(chunkBytes, file.size - offset);
        const part = await transfer(req, { op: 'read', relative, offset, length, version: file.version });
        requireValue(part.data.length === length && checksum(part.data) === part.sha256, '下载块校验失败');
        chunks.push(part.data);
      }
      bytes = Buffer.concat(chunks);
    } else {
      if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) throw new HttpError(413, '图片过大，请直接查看原图');
      const { dataBase64 } = await bus.rpc('fs/readFile', { path: target });
      bytes = Buffer.from(dataBase64, 'base64');
      if (bytes.length > maxBytes) throw new HttpError(413, '图片过大，请直接查看原图');
    }
    const raster = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
      ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
      (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ||
      (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12)));
    if (!raster) throw new HttpError(415, '无法生成缩略图，请直接查看原图');
    let preview;
    try {
      const image = sharp(bytes, { limitInputPixels: 16_000_000, pages: 1 });
      const { format } = await image.metadata();
      if (!['png', 'jpeg', 'gif', 'webp', 'heif'].includes(format)) throw new Error();
      preview = await image.rotate().resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 65 }).toBuffer();
    } catch { throw new HttpError(415, '无法生成缩略图，请直接查看原图'); }
    res.type('webp').send(preview);
  }
  router.get('/projects/:pid/download', (req, res) => download(req, res));
  router.get('/projects/:pid/image', (req, res) => download(req, res, true));
  router.get('/projects/:pid/thumbnail', thumbnail);
  router.delete('/projects/:pid/files', async (req, res) => {
    await admissions.run('tasks', async () => {
      await idle(root(req));
      const { target } = await checkedPath(bus, root(req), String(req.query.path || ''), { allowRoot: false });
      await bus.rpc('fs/remove', { path: target, recursive: true, force: false }); res.json({ ok: true });
    });
  });
  return { router, status };
}
