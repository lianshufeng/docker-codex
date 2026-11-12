import React, { useEffect, useState } from 'react';
import { dateLabel, duration, elapsed, validTime, type TurnTiming } from './timing';
import './timing.css';

export function MessageTime({ value }: { value?: number }) {
  if (!validTime(value)) return null;
  return <time className="message-time" dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString('zh-CN')}>
    {new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
  </time>;
}
export function TimeSeparator({ value }: { value: number }) {
  return <div className="time-separator"><time dateTime={new Date(value).toISOString()}>{dateLabel(value)}</time></div>;
}
export function TurnTime({ turn, connected }: { turn: TurnTiming; connected: boolean }) {
  const [now, setNow] = useState(Date.now);
  const active = turn.status === 'inProgress';
  useEffect(() => {
    setNow(Date.now());
    if (!active || !connected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, connected, turn.id]);
  const ms = elapsed(turn, now);
  if (!active && ms === undefined && turn.status === 'completed') return null;
  const label = active ? connected ? '正在工作' : '连接中断，等待同步' : turn.status === 'interrupted' ? '已停止' : turn.status === 'failed' ? '执行失败' : '本轮用时';
  return <div className={'turn-time' + (active ? ' active' : '')} data-turn-id={turn.id} data-duration-ms={!active ? ms : undefined}
    title="从本轮开始到结束的总时长，包含工具执行与等待时间">
    {label}{ms === undefined ? active || label !== '本轮用时' ? '' : '未知' : `${active || label !== '本轮用时' ? ' · 已用时 ' : ' '}${duration(ms)}`}
  </div>;
}
