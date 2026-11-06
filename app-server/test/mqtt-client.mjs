import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';

export class BridgeClient {
  constructor({ url, instance, password }) {
    this.base = `codex/${instance}`;
    this.events = [];
    this.seen = new Set();
    this.pending = new Map();
    this.watchers = new Set();
    this.serial = 0;
    this.client = mqtt.connect(url, { protocolVersion: 5, username: instance, password,
      reconnectPeriod: 500, connectTimeout: 5000, clean: true });
    this.client.on('error', () => {}); // Reconnection is handled by MQTT.js; requests still have deadlines.
    this.client.on('connect', () => {
      this.client.subscribe([`${this.base}/out`, `${this.base}/status`], { qos: 1 });
    });
    this.client.on('message', (topic, bytes) => {
      let event;
      try { event = JSON.parse(bytes.toString('utf8')); } catch { return; }
      if (topic.endsWith('/status')) {
        this.status = event;
      } else {
        if (this.seen.has(event.eventId)) return;
        this.seen.add(event.eventId);
        if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
        this.events.push(event);
        if (this.events.length > 10000) this.events.shift();
        if (event.type === 'rpc' && !event.payload.method) {
          const pending = this.pending.get(event.payload.id);
          if (pending) {
            this.pending.delete(event.payload.id); clearTimeout(pending.timer);
            if (event.payload.error) pending.reject(new Error(JSON.stringify(event.payload.error)));
            else pending.resolve(event.payload.result);
          }
        }
      }
      for (const check of this.watchers) check();
    });
  }
  wait(predicate, timeout = 30000) {
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        try {
          const result = predicate();
          if (result) { this.watchers.delete(check); clearTimeout(timer); resolve(result); }
        } catch (error) { this.watchers.delete(check); clearTimeout(timer); reject(error); }
      };
      timer = setTimeout(() => { this.watchers.delete(check); reject(new Error('Bridge event timeout')); }, timeout);
      this.watchers.add(check); check();
    });
  }
  send(payload, overrides = {}) {
    const envelope = { messageId: randomUUID(), runId: this.status?.runId, expiresAt: Date.now() + 60000, payload, ...overrides };
    return this.client.publishAsync(`${this.base}/in`, JSON.stringify(envelope), {
      qos: 1, retain: false, properties: { messageExpiryInterval: 60 },
    });
  }
  rpc(method, params = {}, timeout = 30000) {
    const id = `acceptance-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  event(method, predicate, timeout = 180000) {
    return this.wait(() => this.events.find(event => event.type === 'rpc' && event.payload.method === method && predicate(event.payload.params)), timeout)
      .then(event => event.payload.params);
  }
  async close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Client closed')); }
    this.pending.clear();
    await this.client.endAsync(true);
  }
}
