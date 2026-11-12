import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.mjs';
import { DesktopBus } from './desktop-mqtt.mjs';
import { sharedApi } from './shared-api.mjs';
import { compactItem } from './history-page.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(appRoot, 'config.json');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const allowRegistration = config.allowRegistration !== false;
const auth = new Auth(path.resolve(appRoot, config.dataDirectory, 'users.json'));
await auth.init();
const bus = new DesktopBus(config.mqtt);
const sockets = new Set();
const shared = sharedApi(bus, config, broadcast);
const status = shared.status;
function broadcast(uid, message) {
  const data = JSON.stringify(message);
  const activity = message.type === 'rpc' && ['turn/started', 'turn/completed'].includes(message.payload.method)
    ? JSON.stringify({ type: 'turn-activity', sessionId: message.sessionId, running: message.payload.method === 'turn/started' })
    : null;
  let scopedData = data;
  if (message.type === 'rpc') {
    const event = message.payload;
    if (event.method === 'item/commandExecution/outputDelta') scopedData = null;
    else if (['item/started', 'item/completed'].includes(event.method) && event.params?.item) {
      scopedData = JSON.stringify({ ...message, payload: { ...event, params: { ...event.params,
        item: compactItem(event.params.item, event.params.turnId, event.params) } } });
    } else if (activity && event.params?.turn?.items?.length) {
      scopedData = JSON.stringify({ ...message, payload: { ...event, params: { ...event.params,
        turn: { ...event.params.turn, items: [] } } } });
    }
  }
  for (const socket of sockets) {
    if (uid && socket.uid !== uid) continue;
    const payload = !socket.scoped ? data : message.type === 'rpc' && socket.threadId !== message.sessionId ? activity : scopedData;
    if (!payload) continue;
    try {
      auth.user(socket.request);
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, '客户端过慢，请重新加载历史'); continue; }
      if (socket.readyState === 1) socket.send(payload);
    } catch { socket.close(1008, '登录已失效'); }
  }
}
const app = express(); app.disable('x-powered-by');
app.use(compression({ filter: (req, res) => !req.headers.range && compression.filter(req, res) }));
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
const router = express.Router();
router.get('/auth/config', (req, res) => res.json({ allowRegistration }));
const limits = new Map();
router.use('/auth', (req, res, next) => {
  const key = req.socket.remoteAddress;
  const now = Date.now(), current = limits.get(key);
  const value = current && current.until > now ? current : { count: 0, until: now + 60000 };
  if (++value.count > 40) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  limits.set(key, value); next();
}, express.json());
const cookie = (res, token, req) => res.cookie('codex_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 7 * 86400000 });
router.post('/auth/register', async (req, res) => {
  if (!allowRegistration) return res.status(403).json({ error: '账号注册已关闭' });
  const user = await auth.register(req.body.username, req.body.password);
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
const messageRoute = /^\/projects\/[^/]+\/sessions\/[^/]+\/messages$/;
const parseJson = express.json();
router.use((req, res, next) => req.method === 'POST' && messageRoute.test(req.path) ? next() : parseJson(req, res, next));
router.use(shared.router);
app.use('/api', router);
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(appRoot, 'dist'), { index: 'index.html', setHeaders(res, file) {
  if (path.dirname(file) === path.join(appRoot, 'dist', 'assets')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
} }));
app.get('/{*route}', (req, res) => res.sendFile(path.join(appRoot, 'dist/index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error('request_error', req.method, req.path, error.message);
  res.status(status).json({ error: status === 500 ? '服务端操作失败，请查看日志后重试' : error.message });
});
const server = createServer(app);
const ws = new WebSocketServer({ noServer: true, maxPayload: 4096,
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true } });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/events') throw new Error();
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new Error();
    const user = auth.user(req);
    ws.handleUpgrade(req, socket, head, client => {
      client.uid = user.id; client.request = req; sockets.add(client);
      client.alive = true;
      client.on('pong', () => { client.alive = true; });
      client.scoped = url.searchParams.get('view') === 'thread';
      client.on('message', bytes => {
        try {
          auth.user(req);
          const data = JSON.parse(bytes.toString());
          if (client.scoped && data?.type === 'subscribe' && typeof data.threadId === 'string' && data.threadId.length <= 256) {
            client.threadId = data.threadId;
            client.send(JSON.stringify({ type: 'subscribed', threadId: data.threadId }));
          }
        } catch {}
      });
      client.send(JSON.stringify({ type: 'status', ...status() }));
      client.on('close', () => sockets.delete(client));
      client.on('error', () => sockets.delete(client));
    });
  } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});
const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    if (!socket.alive) { socket.terminate(); continue; }
    try { auth.user(socket.request); socket.alive = false; socket.ping(); } catch { socket.close(1008, '登录已失效'); }
  }
  for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
}, 30000);
server.listen(config.port, config.host || '0.0.0.0', () => console.log(`Web ready on :${config.port}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; clearInterval(heartbeat);
  for (const socket of sockets) socket.close(1001, '服务重启');
  server.close(); await bus.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
