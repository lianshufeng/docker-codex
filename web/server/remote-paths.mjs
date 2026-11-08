import path from 'node:path';

export function remotePaths(root) {
  const windows = /^[a-z]:[\\/]/i.test(root) || /^\\\\/.test(root);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(root)) throw new Error('codexWorkspaceRoot 必须是执行端的绝对路径');
  const join = (...parts) => api.join(root, ...parts);
  const equal = (a, b) => typeof a === 'string' && api.isAbsolute(a) &&
    (windows ? api.relative(b, a) === '' : api.normalize(a) === api.normalize(b));
  function relative(cwd, value) {
    if (windows && /^\/[a-z]:\//i.test(value)) value = value.slice(1);
    if (api.isAbsolute(value)) {
      value = api.relative(cwd, value);
      if (api.isAbsolute(value)) return '../';
    }
    return windows ? value.replaceAll('\\', '/') : value;
  }
  return { join, equal, relative, windows };
}
