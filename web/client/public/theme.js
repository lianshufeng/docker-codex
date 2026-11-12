// Run before first paint; React and other tabs share this single controller.
(() => {
  const key = 'assistant-appearance';
  const valid = value => ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
  let mode = 'auto', snapshot, timer;
  const listeners = new Set();
  try { mode = valid(localStorage.getItem(key)); } catch {}
  function refresh() {
    clearTimeout(timer);
    const now = new Date();
    const theme = mode === 'auto' ? (now.getHours() >= 8 && now.getHours() < 20 ? 'light' : 'dark') : mode;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#191919');
    if (!snapshot || snapshot.mode !== mode || snapshot.theme !== theme) {
      snapshot = { mode, theme };
      listeners.forEach(listener => listener());
    }
    if (mode === 'auto') {
      const next = new Date(now);
      next.setHours(now.getHours() < 8 ? 8 : now.getHours() < 20 ? 20 : 32, 0, 0, 0);
      // A bounded recheck also detects clock/timezone changes in an open tab.
      timer = setTimeout(refresh, Math.min(next.getTime() - now.getTime(), 60000));
    }
  }
  window.assistantTheme = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setMode(value) {
      mode = valid(value);
      try { localStorage.setItem(key, mode); } catch {}
      refresh();
    },
  };
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { mode = valid(event.newValue); refresh(); }
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
})();
