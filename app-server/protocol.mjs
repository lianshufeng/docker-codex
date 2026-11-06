export function parseCommand(buffer, { maxBytes, maxTtlMs, now = Date.now() }) {
  if (buffer.length > maxBytes) throw new Error('message_too_large');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const command = JSON.parse(text);
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('invalid_envelope');
  const { messageId, expiresAt, payload } = command;
  if (typeof messageId !== 'string' || !messageId.length || messageId.length > 128) throw new Error('invalid_message_id');
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + maxTtlMs) throw new Error('invalid_expiry');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_payload');
  const owns = key => Object.hasOwn(payload, key);
  const hasId = owns('id');
  if (hasId && !(typeof payload.id === 'string' || Number.isSafeInteger(payload.id))) throw new Error('invalid_rpc_id');
  if (owns('method')) {
    if (typeof payload.method !== 'string' || !payload.method.length || owns('result') || owns('error')) throw new Error('invalid_rpc_request');
    if (['initialize', 'initialized'].includes(payload.method)) throw new Error('initialization_owned_by_bridge');
    if (hasId && String(payload.id).startsWith('__bridge_')) throw new Error('reserved_rpc_id');
  } else if (!hasId || owns('result') === owns('error')) {
    throw new Error('invalid_rpc_response');
  }
  return command;
}

// Deduplication covers this process lifetime; callers must reconcile uncertain results after a restart.
export class Deduplicator {
  constructor(limit) { this.limit = limit; this.entries = new Map(); }
  accept(id, expiresAt, now = Date.now()) {
    for (const [key, expiry] of this.entries) if (expiry <= now) this.entries.delete(key);
    if (this.entries.has(id)) return false;
    if (this.entries.size >= this.limit) throw new Error('dedup_capacity_exceeded');
    this.entries.set(id, expiresAt);
    return true;
  }
}

export class JsonLines {
  constructor(maxBytes, onMessage) { this.maxBytes = maxBytes; this.onMessage = onMessage; this.pending = Buffer.alloc(0); }
  push(chunk) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(start, index));
      if (this.pending.length) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(this.pending);
        this.onMessage(JSON.parse(text));
      }
      this.pending = Buffer.alloc(0);
      start = index + 1;
    }
    this.append(chunk.subarray(start));
  }
  append(chunk) {
    if (this.pending.length + chunk.length > this.maxBytes) throw new Error('stdout_line_too_large');
    this.pending = Buffer.concat([this.pending, chunk]);
  }
}
