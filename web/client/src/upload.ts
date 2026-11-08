type Upload = { transferId: string; offset: number; complete: boolean; };

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch('/api' + url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '上传失败');
  return result;
}

async function digest(bytes: ArrayBuffer) {
  if (!crypto.subtle) return '';
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function uploadId() {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function uploadFile(projectId: string, threadId: string, file: File, image: boolean, progress: (value: number) => void) {
  const base = `/projects/${projectId}/uploads`;
  const key = `web-upload-${projectId}-${file.name}-${file.size}-${file.lastModified}`;
  let transferId = localStorage.getItem(key) || uploadId();
  localStorage.setItem(key, transferId);
  const begin = async (): Promise<Upload> => request(base, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, image, transferId, threadId }) });
  let state;
  try { state = await begin(); }
  catch (error: any) {
    if (!/过期|不一致|不完整|已删除/.test(error.message)) throw error;
    transferId = uploadId(); localStorage.setItem(key, transferId); state = await begin();
  }
  const blockSize = 512 * 1024;
  const write = (offset: number, bytes: ArrayBuffer, hash: string) => request(`${base}/${transferId}?offset=${offset}`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(hash ? { 'x-chunk-sha256': hash } : {}) }, body: bytes });
  for (let offset = 0; offset < state.offset; offset += blockSize) {
    const bytes = await file.slice(offset, offset + blockSize).arrayBuffer();
    const hash = await digest(bytes);
    try { await write(offset, bytes, hash); }
    catch (error) { localStorage.removeItem(key); throw error; }
  }
  for (let offset = state.offset; offset < file.size;) {
    const bytes = await file.slice(offset, offset + blockSize).arrayBuffer();
    const hash = await digest(bytes);
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await write(offset, bytes, hash);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    if (!result || result.offset <= offset) throw new Error('上传进度无效，请重试');
    offset = result.offset;
    progress(file.size ? Math.round(offset / file.size * 100) : 100);
  }
  const result = await request(`${base}/${transferId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  localStorage.removeItem(key);
  return { transferId, ...result };
}
