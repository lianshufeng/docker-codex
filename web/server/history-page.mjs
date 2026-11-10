import { HttpError, requireValue } from './storage.mjs';

const pageSize = 50;
const deferAt = 4096;
const unsupported = /(?:not supported|unsupported|unknown method|method not found|not implemented|requires experimentalApi)/i;

function encode(mode, cursor, anchor) {
  return Buffer.from(JSON.stringify([mode, cursor, anchor])).toString('base64url');
}

function decode(token) {
  if (!token) return ['items', null, null];
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 3 && ['items', 'newer', 'turns'].includes(value[0]) &&
      value.slice(1).every(v => v === null || typeof v === 'string')) return value;
  } catch {}
  throw new HttpError(400, '历史分页游标无效');
}

export function compactItem(item, turnId) {
  const entry = { ...item, turnId };
  if (typeof entry.aggregatedOutput === 'string' && entry.aggregatedOutput.length > deferAt) {
    delete entry.aggregatedOutput;
    entry.outputDeferred = true;
  }
  return entry;
}

export async function historyPage(bus, threadId, token, { itemId, turnId } = {}) {
  requireValue(!token || token.length <= 8192, '历史分页游标无效');
  requireValue(!itemId || (itemId.length <= 256 && turnId?.length > 0 && turnId.length <= 256), '工具输出标识无效');
  let [mode, cursor, anchor] = decode(token);
  const visited = new Set();
  if (mode !== 'turns') {
    try {
      do {
        const page = await bus.rpc('thread/items/list', { threadId, limit: pageSize, sortDirection: mode === 'newer' ? 'asc' : 'desc',
          ...(cursor ? { cursor } : {}), ...(itemId ? { turnId } : {}) });
        const found = itemId && page.data.find(entry => entry.item.id === itemId);
        if (found) return { output: found.item.aggregatedOutput ?? '' };
        if (!itemId) return { items: page.data.map(entry => compactItem(entry.item, entry.turnId)),
          nextCursor: page.nextCursor ? encode(mode, page.nextCursor, null) : null,
          newerCursor: mode === 'items' && page.backwardsCursor ? encode('newer', page.backwardsCursor, null) : null };
        if (visited.has(page.nextCursor)) throw new HttpError(502, '执行端重复返回同一个历史游标');
        visited.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      throw new HttpError(404, '工具输出已不存在');
    } catch (error) {
      if (/not materialized yet/i.test(error.message) && !itemId) return { items: [], nextCursor: null };
      if (token || (error.rpcCode !== -32601 && !unsupported.test(error.message))) throw error;
      cursor = null;
      visited.clear();
    }
  }

  const items = [];
  do {
    if (visited.has(cursor)) throw new HttpError(502, '执行端重复返回同一个历史游标');
    visited.add(cursor);
    let page;
    try {
      page = await bus.rpc('thread/turns/list', { threadId, limit: 10, itemsView: 'full', sortDirection: 'desc',
        ...(cursor ? { cursor } : {}) });
    } catch (error) {
      if (!itemId && /not materialized yet/i.test(error.message)) return { items: [], nextCursor: null };
      throw error;
    }
    if (itemId) {
      const turn = page.data.find(turn => turn.id === turnId);
      if (turn) {
        const found = turn.items?.find(item => item.id === itemId);
        if (!found) break;
        return { output: found.aggregatedOutput ?? '' };
      }
    } else {
      const entries = page.data.flatMap(turn => [...(turn.items ?? [])].reverse().map(item => ({ item, turnId: turn.id })));
      const start = anchor ? entries.findIndex(({ item }) => item.id === anchor) + 1 : 0;
      if (anchor && !start) throw new HttpError(409, '历史已变化，请重新打开会话');
      const remaining = pageSize - items.length;
      const chunk = entries.slice(start, start + remaining);
      items.push(...chunk.map(({ item, turnId }) => compactItem(item, turnId)));
      if (items.length === pageSize) {
        const nextCursor = start + chunk.length < entries.length
          ? encode('turns', cursor, chunk.at(-1).item.id)
          : page.nextCursor ? encode('turns', page.nextCursor, null) : null;
        return { items, nextCursor };
      }
    }
    anchor = null;
    cursor = page.nextCursor;
  } while (cursor);
  if (itemId) throw new HttpError(404, '工具输出已不存在');
  return { items, nextCursor: null };
}
