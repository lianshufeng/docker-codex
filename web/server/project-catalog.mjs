import { randomUUID } from 'node:crypto';
import { listThreadPage, projectOf } from './app-workspace.mjs';
import { HttpError, Locks } from './storage.mjs';

const pageSize = 10;
const maxScans = 64;
const maxIdleMs = 30 * 60_000;

export function projectCatalog(bus, session) {
  const scans = new Map(), locks = new Locks();

  async function nextThread(scan) {
    while (!scan.buffer.length && scan.source) {
      const source = scan.source;
      const cursor = scan.cursor;
      const page = source === 'threads'
        ? await listThreadPage(bus, { limit: 30, sortKey: 'updated_at', cursor })
        : await bus.rpc('thread/loaded/list', cursor ? { cursor } : {});
      if (page.nextCursor && scan.cursors.has(page.nextCursor)) {
        throw new HttpError(502, '执行端重复返回同一个项目分页游标');
      }
      scan.buffer = [...page.data];
      scan.bufferSource = source;
      scan.cursor = page.nextCursor || undefined;
      if (scan.cursor) scan.cursors.add(scan.cursor);
      else {
        scan.cursors.clear();
        scan.source = source === 'threads' && bus.supports('thread/loaded/list') ? 'loaded' : null;
      }
    }
    if (!scan.buffer.length) return null;
    const entry = scan.buffer[0];
    let thread = entry;
    if (scan.bufferSource === 'loaded') {
      try { thread = scan.listedThreads.has(entry) ? {} : (await bus.rpc('thread/read', { threadId: entry })).thread; }
      catch (error) {
        if (error.message !== `thread not loaded: ${entry}`) throw error;
        thread = {};
      }
    } else scan.listedThreads.add(entry.id);
    scan.buffer.shift();
    return thread;
  }

  return async function page(cursor, owner) {
    const now = Date.now();
    const [id, index] = cursor ? cursor.split(':') : [randomUUID(), '0'];
    const offset = Number(index);
    let scan = scans.get(id);
    if (!cursor) {
      while (scans.size >= maxScans) scans.delete(scans.keys().next().value);
      scan = { owner, runId: bus.state.runId, source: 'threads', buffer: [], cursors: new Set(),
        listedThreads: new Set(), seen: new Set(), pending: [], pages: [] };
    }
    if (!scan || scan.owner !== owner || scan.runId !== bus.state.runId ||
        (cursor && now - scan.lastUsed > maxIdleMs) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new HttpError(409, '项目分页已失效，请重新加载项目列表');
    }
    scan.lastUsed = now;
    scans.delete(id);
    scans.set(id, scan);
    return locks.run(id, async () => {
      if (scan.pages[offset]) return scan.pages[offset];
      if (offset !== scan.pages.length) throw new HttpError(409, '项目分页已失效，请重新加载项目列表');
      while (scan.pending.length < pageSize) {
        const thread = await nextThread(scan);
        if (!thread) break;
        if (!thread.cwd) continue;
        const project = projectOf(thread.cwd);
        if (scan.seen.has(project.id)) continue;
        scan.seen.add(project.id);
        project.sessions.push(session(thread));
        scan.pending.push(project);
      }
      const result = { projects: scan.pending, nextCursor: scan.buffer.length || scan.source ? `${id}:${offset + 1}` : null };
      scan.pending = [];
      scan.pages.push(result);
      return result;
    });
  };
}
