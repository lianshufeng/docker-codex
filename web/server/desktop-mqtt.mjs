import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError } from './storage.mjs';

const legacyMethods = new Set(['model/list', 'thread/list', 'thread/read', 'thread/start', 'thread/resume',
  'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt', 'rpc/respond']);

// The desktop bridge shares an already initialized app-server with the desktop UI.
export class DesktopBus extends EventEmitter {
  constructor(config, connect = mqtt.connect) {
    super();
    this.base = undefined; this.candidates = new Map();
    this.subscribedBase = undefined;
    this.state = { state: 'connecting', runId: randomUUID() };
    this.pending = new Map();
    this.client = connect(config.url, { protocolVersion: 5, username: config.username, password: config.password,
      family: 4, clientId: `web-desktop-${randomUUID()}`, clean: true, reconnectPeriod: 2000,
      resubscribe: false, queueQoSZero: false, connectTimeout: 10000 });
    this.client.on('error', error => console.error('mqtt_connection', error.message));
    this.client.on('connect', () => {
      this.subscribed = false; this.remote = undefined;
      this.candidates.clear(); this.base = undefined; this.subscribedBase = undefined;
      this.client.subscribe('codex/+/status', { qos: 1 }, (error, granted) => {
        this.subscribed = !error && granted?.length === 1 && granted.every(g => g.qos <= 2);
        this.update();
      });
    });
    this.client.on('close', () => {
      clearTimeout(this.discoveryTimer);
      this.subscribed = false; this.remote = undefined;
      this.state.runId = randomUUID(); this.rejectPending('桌面连接已断开，执行结果未知，请查询历史后再操作'); this.update();
    });
    this.client.on('message', (topic, bytes, packet) => {
      if (topic.includes('/files/')) return;
      try {
        const message = JSON.parse(bytes.toString('utf8'));
        if (/^codex\/[^/]+\/status$/.test(topic)) {
          const base = topic.slice(0, -7);
          if (message.attached && message.writerReady && [undefined, 1].includes(message.protocolVersion)) this.candidates.set(base, message);
          else this.candidates.delete(base);
          if (this.candidates.size > 1) this.discover();
          clearTimeout(this.discoveryTimer);
          this.discoveryTimer = setTimeout(() => this.discover(), 300);
        }
        if (topic === `${this.base}/status`) {
          if ((this.remote?.attached && !message.attached) || (this.remote?.runId && message.runId !== this.remote.runId)) {
            this.state.runId = randomUUID(); this.rejectPending('桌面进程已断开，请重新附加后查询历史');
          }
          this.remote = this.subscribedBase === this.base && this.candidates.size === 1 ? this.candidates.get(this.base) : undefined;
          this.update(); return;
        }
        if (topic.startsWith(`${this.base}/reply/`)) {
          const id = topic.slice(`${this.base}/reply/`.length), request = this.pending.get(id);
          if (!request) return;
          clearTimeout(request.timer); this.pending.delete(id);
          if (message.error) {
            const detail = typeof message.error === 'string' ? message.error : message.error.message || '桌面请求失败';
            if (detail === '已达到本次服务运行的命令数量上限') {
              request.reject(new HttpError(503, '当前仍连接旧版桌面桥，累计请求已达上限。请切换到新版桌面连接服务。'));
            } else {
              const error = new HttpError(message.stage === 'delivery_unknown' ? 503 : 502, detail);
              if (typeof message.error === 'object') error.rpcCode = message.error.code;
              request.reject(error);
            }
          }
          else request.resolve(message.result);
          return;
        }
        if (this.ready() && topic === `${this.base}/observed/output` && !packet?.retain && message.method) {
          this.emit('notification', message, this.state.runId);
        }
      } catch (error) { console.error('desktop_mqtt_message', error.message); }
    });
  }
  discover() {
    if (this.candidates.size !== 1) {
      if (this.remote) this.state.runId = randomUUID();
      this.remote = undefined; this.rejectPending('执行端数量不唯一，请检查服务状态'); this.update(); return;
    }
    const [base, remote] = [...this.candidates][0];
    if (base !== this.base || this.subscribedBase !== base) {
      const previous = this.base;
      this.base = base; this.state.runId = randomUUID(); this.rejectPending('执行端已变化，请重新查询状态');
      if (previous && previous !== base) this.client.unsubscribe([`${previous}/reply/+`, `${previous}/observed/output`, `${previous}/files/reply/+`]);
      this.remote = undefined;
      this.client.subscribe([`${base}/reply/+`, `${base}/observed/output`, `${base}/files/reply/+`], { qos: 1 }, (error, granted) => {
        if (this.base !== base || !this.client.connected) return;
        if (!error && granted?.length === 3 && granted.every(g => g.qos <= 2)) {
          this.subscribedBase = base;
          if (this.candidates.size === 1) this.remote = this.candidates.get(base);
        }
        this.update();
      });
    } else { this.remote = remote; this.update(); }
  }
  supports(method) { return this.remote?.methods === '*' || (this.remote?.methods?.includes(method) ?? legacyMethods.has(method)); }
  update() {
    const state = this.candidates.size > 1 ? 'ambiguous' : this.client.connected && this.subscribed && this.remote?.attached && this.remote?.writerReady ? 'ready'
      : !this.client.connected ? 'offline' : this.remote?.attached ? 'waiting-writer' : 'waiting-desktop';
    this.state = { state, runId: this.state.runId };
    this.emit('status', { ...this.state, connected: this.ready() });
  }
  ready() { return this.client.connected && this.state.state === 'ready'; }
  rejectPending(message) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new HttpError(503, message)); }
    this.pending.clear();
  }
  rpc(method, params = {}, timeout = 0) {
    if (!this.ready()) return Promise.reject(new HttpError(503, this.state.state === 'ambiguous'
      ? '发现多个执行端，请检查连接配置' : 'AI 助手尚未就绪，请检查 MQTT 服务状态'));
    const generation = this.state.runId;
    const id = `web-${randomUUID()}`;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, '请求等待超时，执行结果请查询历史'));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      if (!this.ready() || generation !== this.state.runId) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new HttpError(503, '连接已变化，请查询执行状态'));
        return;
      }
      this.client.publishAsync(`${this.base}/command`, payload, { qos: 1, retain: false }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  publish(payload) {
    return this.rpc('rpc/respond', { requestId: payload.id,
      ...(this.remote?.pendingRequests ? { runId: this.remote.runId } : {}),
      ...Object.fromEntries(Object.entries(payload).filter(([key]) => ['result', 'error'].includes(key))) }, 10000);
  }
  async close() { clearTimeout(this.discoveryTimer); this.rejectPending('服务正在停止'); await this.client.endAsync(true); }
}
