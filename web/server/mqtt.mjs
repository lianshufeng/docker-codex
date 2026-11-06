import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError } from './storage.mjs';

export class CodexBus extends EventEmitter {
  constructor(config) {
    super(); this.pending = new Map(); this.seen = new Set(); this.state = { state: 'connecting' };
    this.base = `codex/${config.username}`;
    this.client = mqtt.connect(config.url, { protocolVersion: 5, username: config.username, password: config.password,
      clientId: `codex-web-${randomUUID()}`, clean: true, reconnectPeriod: 2000, resubscribe: false,
      queueQoSZero: false, connectTimeout: 10000, properties: { maximumPacketSize: 2097152 } });
    this.client.on('error', e => console.error('mqtt_connection', e.message));
    this.client.on('connect', () => {
      this.client.subscribe([`${this.base}/out`, `${this.base}/status`], { qos: 1 }, (error, granted) => {
        if (error || !granted?.length || granted.some(g => g.qos > 2)) this.change({ state: 'subscription-error' });
      });
    });
    this.client.on('close', () => { this.change({ ...this.state, state: 'offline' }); this.rejectPending('MQTT 已断开，请重新查询任务状态'); });
    this.client.on('message', (topic, buffer) => {
      try {
        const event = JSON.parse(buffer.toString('utf8'));
        if (topic === `${this.base}/status`) {
          if (this.state.runId && event.runId && event.runId !== this.state.runId) this.rejectPending('AI 助手 进程已重启，请重新查询任务状态');
          this.change(event); return;
        }
        if (!event.eventId || this.seen.has(event.eventId)) return;
        this.seen.add(event.eventId); if (this.seen.size > 20000) this.seen.delete(this.seen.values().next().value);
        if (event.type === 'bridgeError') {
          for (const [id, request] of this.pending) if (request.messageId === event.payload?.messageId) {
            clearTimeout(request.timer); this.pending.delete(id); request.reject(new HttpError(502, `桥接拒绝请求：${event.payload.code}`));
          }
          return;
        }
        if (event.type !== 'rpc' || !event.payload) return;
        const message = event.payload;
        if (!message.method && this.pending.has(message.id)) {
          const request = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(new HttpError(502, message.error.message || 'AI 助手 请求失败'));
          else request.resolve(message.result);
        } else if (message.method) this.emit('notification', message, event.runId);
      } catch (error) { console.error('mqtt_message', error.message); }
    });
  }
  ready() { return this.client.connected && this.state.state === 'ready'; }
  change(state) { this.state = state; this.emit('status', { ...state, connected: this.ready() }); }
  rejectPending(message) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new HttpError(503, message)); }
    this.pending.clear();
  }
  publish(payload, messageId = randomUUID()) {
    if (!this.ready()) throw new HttpError(503, 'AI 助手 未就绪，请等待 MQTT 连接恢复');
    const data = JSON.stringify({ messageId, runId: this.state.runId, expiresAt: Date.now() + 60000, payload });
    return this.client.publishAsync(`${this.base}/in`, data, { qos: 1, retain: false, properties: { messageExpiryInterval: 60 } });
  }
  rpc(method, params = {}, timeout = 20000) {
    if (!this.ready()) return Promise.reject(new HttpError(503, 'AI 助手 未就绪'));
    if (this.pending.size >= 512) return Promise.reject(new HttpError(503, '请求过多，请稍后再试'));
    const id = `web-${randomUUID()}`, messageId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HttpError(504, '请求超时，执行结果未知，请刷新状态，勿重复提交')); }, timeout);
      this.pending.set(id, { resolve, reject, timer, messageId });
      this.publish({ id, method, params }, messageId).catch(error => {
        const request = this.pending.get(id);
        if (request) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async close() { this.rejectPending('服务正在停止'); await this.client.endAsync(true); }
}
