import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Folder } from 'lucide-react';

export type ProjectLocationValue = { platform: 'linux'; name: string } | { platform: 'windows'; path: string };
type Entry = { name?: string; fileName?: string; path: string };
type Options = { platform: 'linux' | 'windows'; root?: string; roots?: Entry[]; initialPath?: string };
type Directory = { path: string; parent: string | null; entries: Entry[] };

export function ProjectLocation({ request, onChange }: {
  request: (url: string) => Promise<any>; onChange: (value: ProjectLocationValue | null) => void;
}) {
  const [options, setOptions] = useState<Options | null>(null), [directory, setDirectory] = useState<Directory | null>(null);
  const [name, setName] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const version = useRef(0);
  async function browse(path: string) {
    const id = ++version.current;
    setLoading(true); setError(''); onChange(null);
    try {
      const result = path ? await request('/directories?path=' + encodeURIComponent(path)) : null;
      if (id !== version.current) return;
      setDirectory(result);
      onChange(result ? { platform: 'windows', path: result.path } : null);
    } catch (e: any) {
      if (id !== version.current) return;
      setError(e.message); setDirectory(null);
    } finally { if (id === version.current) setLoading(false); }
  }
  useEffect(() => {
    let disposed = false;
    request('/project-options').then(async (result: Options) => {
      if (disposed) return;
      setOptions(result);
      if (result.platform === 'windows') await browse(result.initialPath || '');
      else setLoading(false);
    }).catch((e: any) => { if (!disposed) { setError(e.message); setLoading(false); } });
    return () => { disposed = true; version.current++; };
  }, [request]);
  if (!options) return <div className="project-location">{loading ? <p role="status">正在读取工作位置…</p> : <p className="inline-error">{error}</p>}</div>;
  if (options.platform === 'linux') return <div className="project-location"><label>项目名称<input autoFocus required maxLength={80}
    value={name} placeholder="例如：我的项目" onChange={event => {
      const value = event.target.value; setName(value);
      onChange(value.trim() ? { platform: 'linux', name: value } : null);
    }}/></label><p>将创建同名文件夹，所有登录用户共享。</p>
    <small className="project-location-path">保存位置：{options.root}/{name || '项目名称'}</small></div>;
  const entries = directory?.entries || options.roots || [];
  return <div className="project-location"><p>选择项目文件夹，所有登录用户共享。</p>
    <div className="directory-toolbar"><button type="button" className="secondary" disabled={loading || !directory}
      onClick={() => browse(directory?.parent || '')}><ArrowLeft size={14}/>上一级</button>
      <button type="button" className="secondary" disabled={loading || !directory} onClick={() => browse('')}>此电脑</button></div>
    <div className="project-location-path" title={directory?.path}>{directory?.path || '此电脑'}</div>
    {loading ? <p role="status">正在读取文件夹…</p> : <div className="directory-list" role="group" aria-label="选择项目文件夹">
      {entries.map(entry => <button type="button" key={entry.path} onClick={() => browse(entry.path)}><Folder size={17}/><span>{entry.fileName || entry.name}</span></button>)}
      {!entries.length && <p>此文件夹为空，可以直接选择。</p>}</div>}
    {error && <p className="inline-error">{error}</p>}
    {directory && !loading && <small>点击“确定”使用当前文件夹。</small>}
  </div>;
}
