import React, { useId, useSyncExternalStore } from 'react';
import './theme.css';

type ThemeMode = 'auto' | 'light' | 'dark';
declare global {
  interface Window {
    assistantTheme: {
      getSnapshot(): { mode: ThemeMode; theme: 'light' | 'dark' };
      subscribe(listener: () => void): () => void;
      setMode(value: ThemeMode): void;
    };
  }
}

export function ThemeSettings() {
  const id = useId();
  const { mode, theme } = useSyncExternalStore(window.assistantTheme.subscribe, window.assistantTheme.getSnapshot);
  return <section className="theme-settings" aria-labelledby={id}>
    <div className="theme-heading"><span id={id}>外观</span>{mode === 'auto' && <small>当前{theme === 'light' ? '浅色' : '深色'}</small>}</div>
    <div className="theme-options" role="group" aria-label="外观">
      {(['auto', 'light', 'dark'] as const).map((value, index) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => window.assistantTheme.setMode(value)}>{['自动', '浅色', '深色'][index]}</button>)}
    </div>
    {mode === 'auto' && <small className="theme-schedule">本地时间 08:00–20:00 使用浅色</small>}
  </section>;
}
