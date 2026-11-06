import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { atomicJson, readJson, Locks, HttpError, requireValue } from './storage.mjs';
const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
export class Auth {
  constructor(file) { this.file = file; this.locks = new Locks(); }
  async init() {
    this.state = await readJson(this.file, { users: [], sessions: [] });
    if (!Array.isArray(this.state.users) || !Array.isArray(this.state.sessions)) throw new Error('用户存储格式错误，停止启动以保护数据');
  }
  validatePassword(value) { requireValue(typeof value === 'string' && value.length >= 8 && value.length <= 128, '密码须为 8–128 个字符'); }
  async encoded(password) {
    const salt = randomBytes(16).toString('hex');
    return { salt, digest: (await scrypt(password, salt, 64)).toString('hex') };
  }
  async matches(password, user) {
    const computed = await scrypt(password, user.salt, 64);
    const stored = Buffer.from(user.digest, 'hex');
    return computed.length === stored.length && timingSafeEqual(computed, stored);
  }
  public(user) { return { id: user.id, username: user.username }; }
  async mutate(fn) {
    return this.locks.run('auth', async () => {
      const next = structuredClone(this.state);
      const result = await fn(next);
      next.sessions = next.sessions.filter(s => s.expiresAt > Date.now());
      await atomicJson(this.file, next); this.state = next;
      return result;
    });
  }
  async register(username, password) {
    requireValue(typeof username === 'string' && /^[\p{L}\p{N}_-]{3,40}$/u.test(username), '账号须为 3–40 个字母、数字、下划线或连字符');
    this.validatePassword(password);
    const encoded = await this.encoded(password);
    return this.mutate(state => {
      if (state.users.some(u => u.username.toLocaleLowerCase() === username.toLocaleLowerCase())) throw new HttpError(409, '账号已存在');
      const user = { id: randomUUID(), username, ...encoded, createdAt: new Date().toISOString() };
      state.users.push(user); return this.public(user);
    });
  }
  async login(username, password) {
    requireValue(typeof username === 'string' && typeof password === 'string' && password.length <= 128);
    const token = randomBytes(32).toString('hex');
    const user = await this.mutate(async state => {
      const user = state.users.find(u => u.username.toLocaleLowerCase() === username.toLocaleLowerCase());
      if (!user || !await this.matches(password, user)) throw new HttpError(401, '账号或密码错误');
      state.sessions = state.sessions.filter(s => s.uid !== user.id);
      state.sessions.push({ hash: hash(token), uid: user.id, expiresAt: Date.now() + 7 * 86400000 });
      return this.public(user);
    });
    return { token, user };
  }
  token(req) { return /(?:^|;\s*)codex_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
  user(req) {
    const token = this.token(req);
    const session = token && this.state.sessions.find(s => s.hash === hash(token) && s.expiresAt > Date.now());
    const user = session && this.state.users.find(u => u.id === session.uid);
    if (!user) throw new HttpError(401, '请先登录');
    return this.public(user);
  }
  async logout(req) {
    const token = this.token(req);
    if (token) await this.mutate(state => { state.sessions = state.sessions.filter(s => s.hash !== hash(token)); });
  }
  async password(uid, oldPassword, newPassword) {
    this.validatePassword(newPassword);
    requireValue(typeof oldPassword === 'string' && oldPassword.length <= 128);
    return this.mutate(async state => {
      const user = state.users.find(u => u.id === uid);
      if (!user || !await this.matches(oldPassword, user)) throw new HttpError(400, '原密码错误');
      Object.assign(user, await this.encoded(newPassword));
      state.sessions = state.sessions.filter(s => s.uid !== uid);
    });
  }
}
