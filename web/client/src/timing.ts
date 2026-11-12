export type ItemTiming = { startedAtMs?: number | null; completedAtMs?: number | null; durationMs?: number | null };
export type TurnTiming = { id: string; status: string; startedAt?: number | null; completedAt?: number | null; durationMs?: number | null };

export function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
}
export function messageTime(item: ItemTiming) {
  return validTime(item.startedAtMs) ? item.startedAtMs : validTime(item.completedAtMs) ? item.completedAtMs : undefined;
}
export function elapsed(turn: TurnTiming, now: number) {
  if (turn.status !== 'inProgress' && validTime(turn.durationMs)) return turn.durationMs;
  if (!validTime(turn.startedAt)) return undefined;
  const end = turn.status === 'inProgress' ? now : validTime(turn.completedAt) ? turn.completedAt * 1000 : undefined;
  return end === undefined ? undefined : Math.max(0, end - turn.startedAt * 1000);
}
export function duration(value: number, precise = false) {
  if (precise && value < 60000) return `${(Math.max(0, value) / 1000).toFixed(1)}秒`;
  const seconds = Math.floor(Math.max(0, value) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? hours + '小时' : ''}${hours || minutes ? minutes + '分' : ''}${rest}秒`;
}
export function separator(current: number, previous?: number) {
  return previous === undefined || new Date(current).toDateString() !== new Date(previous).toDateString() || current - previous >= 30 * 60000;
}
export function dateLabel(value: number, now = Date.now()) {
  const date = new Date(value), today = new Date(now), yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString() === today.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天'
    : date.toLocaleDateString('zh-CN', { year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined, month: 'long', day: 'numeric' });
  return `${day} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
