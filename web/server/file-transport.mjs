import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from './storage.mjs';

export const chunkBytes = 512 * 1024;


export function encodeFrame(metadata, data = Buffer.alloc(0)) {
  const header = Buffer.from(JSON.stringify(metadata));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, data]);
}

export function decodeFrame(payload) {
  if (payload.length < 4) throw new Error('文件响应格式无效');
  const size = payload.readUInt32BE();
  if (size > 32764 || size + 4 > payload.length) throw new Error('文件响应头无效');
  return { metadata: JSON.parse(payload.subarray(4, size + 4)), data: payload.subarray(size + 4) };
}

export class FileTransport {
  constructor(bus) {
    this.bus = bus;
    this.pending = new Map();
    bus.client.on('message', (topic, bytes, packet) => {
      if (packet?.retain || !topic.startsWith(`${bus.base}/files/reply/`)) return;
      const id = topic.split('/').at(-1), request = this.pending.get(id);
      if (!request) return;
      try {
        const response = decodeFrame(bytes);
        if (response.metadata.error) throw new HttpError(409, response.metadata.error);
        request.resolve({ ...response.metadata.result, data: response.data });
      } catch (error) { request.reject(error); }
    });
  }
  limits() { return this.bus.remote?.fileTransfer?.version === 1 ? this.bus.remote.fileTransfer : null; }
  async request(metadata, data = Buffer.alloc(0)) {
    const bus = this.bus, generation = bus.state.runId, base = bus.base;
    if (!bus.ready()) throw new HttpError(503, '文件连接尚未就绪');
    if (!this.limits()) throw new HttpError(409, '执行端需要升级大文件传输服务');
    const id = randomUUID();
    const payload = encodeFrame(metadata, data);
    return new Promise((resolve, reject) => {
        const disconnected = () => {
          if (!bus.ready() || generation !== bus.state.runId) finish(new HttpError(503, '文件连接中断，请重试续传'));
        };
        const finish = (error, result) => {
          clearTimeout(timer); bus.off('status', disconnected); this.pending.delete(id);
          error ? reject(error) : resolve(result);
        };
        const timer = setTimeout(() => finish(new HttpError(504, '文件块响应超时，请重试续传')), 60000);
        this.pending.set(id, { resolve: result => finish(null, result), reject: error => finish(error) });
        bus.on('status', disconnected);
        if (!bus.ready() || generation !== bus.state.runId) { disconnected(); return; }
        bus.client.publishAsync(`${base}/files/request/${id}`, payload, { qos: 1, retain: false }).catch(error => finish(error));
    });
  }
}

export const checksum = data => createHash('sha256').update(data).digest('hex');
