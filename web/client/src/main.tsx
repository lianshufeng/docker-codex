import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplyMarkdown, ReturnedImage } from './reply-images';
import { Plus, Folder, FolderOpen, MessageSquare, PanelLeftClose, PanelLeftOpen, ArrowUp, Square, ChevronDown, ChevronRight, Files, X, Download, Trash2, RefreshCw, LogOut, KeyRound, Settings2, ArrowLeft, Check, AlertCircle, Pencil, Terminal, Globe, FileText } from 'lucide-react';
import './style.css';
import './images.css';

type User = { id: string; username: string };
type Session = { id: string; threadId: string; name: string; createdAt: string };
type Project = { id: string; name: string; sessions: Session[]; deleting?: boolean };
type Item = { id: string; type: string; text?: string; content?: any[]; command?: string; aggregatedOutput?: string; status?: string; changes?: any[] };
type Dialog = { type: string; title: string; value?: string; project?: Project; session?: Session; file?: any };
async function api(url: string, options: RequestInit = {}) {
  const response = await fetch('/api' + url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json().catch(() => ({ error: '服务器响应无效' }));
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
const post = (url: string, body: any = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
function Logo({ small = false }: { small?: boolean }) {
  return <span className={'logo ' + (small ? 'small' : '')} aria-hidden="true">⌘</span>;
}
function App() {
  const [user, setUser] = useState<User | null>(null), [boot, setBoot] = useState(true);
  const [mode, setMode] = useState('login'), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]), [pid, setPid] = useState(''), [sid, setSid] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}), [sidebar, setSidebar] = useState(true), [filePanel, setFilePanel] = useState(false);
  const [status, setStatus] = useState<any>({ connected: false, state: 'connecting' });
  const [items, setItems] = useState<Item[]>([]), [running, setRunning] = useState(false), [loadingHistory, setLoadingHistory] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<any[]>([]), [message, setMessage] = useState(''), [filePath, setFilePath] = useState(''), [files, setFiles] = useState<any[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null), [dialogValue, setDialogValue] = useState(''), [oldPassword, setOldPassword] = useState('');
  const [menu, setMenu] = useState(false), [socketConnected, setSocketConnected] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const imageVersion = useRef(0);
  const selection = useRef({ pid, sid }); selection.current = { pid, sid };
  const historyVersion = useRef(0), liveVersion = useRef(0), fileVersion = useRef(0), scroll = useRef<HTMLDivElement>(null);
  const project = projects.find(p => p.id === pid), session = project?.sessions.find(s => s.id === sid);
  const sessionUrl = (p = pid, s = sid) => `/projects/${p}/sessions/${s}`;
  async function refreshProjects() { const result = await api('/projects'); setProjects(result.projects); return result.projects as Project[]; }
  async function loadHistory(older = false) {
    const selected = selection.current; if (!selected.sid) return;
    const version = ++historyVersion.current, liveAt = liveVersion.current;
    setLoadingHistory(true);
    try {
      const result = await api(sessionUrl(selected.pid, selected.sid) + '/history' + (older && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      if (version !== historyVersion.current || selected.sid !== selection.current.sid) return;
      const turns = [...result.turns].reverse();
      const incoming = turns.flatMap((turn: any) => turn.items || []);
      setItems(current => {
        if (older) return [...incoming, ...current.filter(i => !incoming.some((v: Item) => v.id === i.id))];
        if (liveVersion.current !== liveAt) {
          const merged = [...incoming];
          for (const item of current) { const index = merged.findIndex(i => i.id === item.id); if (index >= 0) merged[index] = item; else merged.push(item); }
          return merged;
        }
        return incoming;
      });
      setCursor(result.nextCursor || null); setRunning(Boolean(result.active)); setApprovals(result.approvals || []);
    } catch (e: any) { setError(e.message); } finally { if (version === historyVersion.current) setLoadingHistory(false); }
  }
  async function refreshFiles() {
    if (!pid) return; const version = ++fileVersion.current;
    try { const result = await api(`/projects/${pid}/files?path=${encodeURIComponent(filePath)}`); if (version === fileVersion.current) setFiles(result.files); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => { api('/me').then(result => { setUser(result.user); setStatus(result.status); }).catch(() => {}).finally(() => setBoot(false)); }, []);
  useEffect(() => {
    if (!user) return;
    const savedSelection = JSON.parse(localStorage.getItem('codex-selection-' + user.id) || '{}');
    setProjects([]); setItems([]); setApprovals([]); setPid(''); setSid('');
    refreshProjects().then(list => {
      const saved = savedSelection;
      const p = list.find(v => v.id === saved.pid) || list[0];
      if (p) { setPid(p.id); setSid(p.sessions.find(s => s.id === saved.sid)?.id || p.sessions[0]?.id || ''); }
    }).catch(e => setError(e.message));
    let disposed = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>;
    function connect() {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.onopen = () => { setSocketConnected(true); if (selection.current.sid) loadHistory(); };
      socket.onmessage = event => {
        let data: any; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'auth-expired') { setUser(null); setItems([]); return; }
        if (data.type === 'status') { setStatus(data); if (data.connected && selection.current.sid) loadHistory(); return; }
        if (data.type !== 'rpc' || data.sessionId !== selection.current.sid) return;
        liveVersion.current++;
        const { method, params = {}, id } = data.payload;
        if (id !== undefined) setApprovals(current => [...current.filter(a => a.id !== id), data.payload]);
        if (method === 'serverRequest/resolved') setApprovals(current => current.filter(a => a.id !== params.requestId));
        if (method === 'turn/started') setRunning(true);
        if (method === 'turn/completed') { setRunning(false); setApprovals([]); if (params.turn.error) setError(params.turn.error.message); loadHistory(); }
        if (method === 'error') setError(params.error?.message || params.message || '任务发生错误');
        if ((method === 'item/started' || method === 'item/completed') && params.item) {
          setItems(current => { const index = current.findIndex(i => i.id === params.item.id); if (index < 0) return [...current, params.item]; return current.map((i, n) => n === index ? params.item : i); });
        }
        if (method === 'item/agentMessage/delta') {
          setItems(current => {
            if (!current.some(i => i.id === params.itemId)) return [...current, { id: params.itemId, type: 'agentMessage', text: params.delta }];
            return current.map(i => i.id === params.itemId ? { ...i, text: (i.text || '') + params.delta } : i);
          });
        }
        if (method === 'item/commandExecution/outputDelta') setItems(current => current.map(i => i.id === params.itemId ? { ...i, aggregatedOutput: ((i.aggregatedOutput || '') + params.delta).slice(-20000) } : i));
      };
      socket.onclose = event => { setSocketConnected(false); if (event.code === 1008) { setUser(null); setItems([]); return; } if (!disposed) timer = setTimeout(connect, 2000); };
      socket.onerror = () => socket.close();
    }
    connect(); return () => { disposed = true; clearTimeout(timer); socket?.close(); };
  }, [user?.id]);
  useEffect(() => {
    historyVersion.current++; fileVersion.current++; imageVersion.current++; setImages([]); setItems([]); setCursor(null); setRunning(false); setApprovals([]); setFilePath('');
    if (user) localStorage.setItem('codex-selection-' + user.id, JSON.stringify({ pid, sid }));
    if (sid) loadHistory();
  }, [pid, sid]);
  useEffect(() => { if (filePanel && pid) refreshFiles(); }, [filePanel, pid, filePath, running]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [items.length, items.at(-1)?.text, running]);
  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'register') await post('/auth/register', { username, password });
      const result = await post('/auth/login', { username, password }); setUser(result.user); setPassword('');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  function openDialog(value: Dialog) { setDialog(value); setDialogValue(value.value || ''); setOldPassword(''); setMenu(false); setError(''); }
  async function confirmDialog(event: React.FormEvent) {
    event.preventDefault(); if (!dialog) return; setBusy(true); setError('');
    try {
      const p = dialog.project;
      if (dialog.type === 'project') {
        const result = await post('/projects', { name: dialogValue }); await refreshProjects(); setPid(result.project.id); setSid('');
      } else if (dialog.type === 'session' && p) {
        const result = await post(`/projects/${p.id}/sessions`, { name: dialogValue || '新会话' }); await refreshProjects(); setPid(p.id); setSid(result.session.id);
      } else if (dialog.type === 'rename-project' && p) {
        await api(`/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: dialogValue }) }); await refreshProjects();
      } else if (dialog.type === 'rename-session' && p && dialog.session) {
        await api(sessionUrl(p.id, dialog.session.id), { method: 'PATCH', body: JSON.stringify({ name: dialogValue }) }); await refreshProjects();
      } else if (dialog.type === 'delete-project' && p) {
        await api(`/projects/${p.id}`, { method: 'DELETE' }); await refreshProjects(); if (pid === p.id) { setPid(''); setSid(''); }
      } else if (dialog.type === 'delete-session' && p && dialog.session) {
        await api(sessionUrl(p.id, dialog.session.id), { method: 'DELETE' }); await refreshProjects(); if (sid === dialog.session.id) setSid('');
      } else if (dialog.type === 'delete-file' && p) {
        const relative = [filePath, dialog.file.name].filter(Boolean).join('/');
        await api(`/projects/${p.id}/files?path=${encodeURIComponent(relative)}`, { method: 'DELETE' }); await refreshFiles();
      } else if (dialog.type === 'password') {
        await post('/auth/password', { oldPassword, newPassword: dialogValue }); setUser(null); setItems([]); setNotice('密码已修改，请重新登录');
      }
      setDialog(null);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    if (busy) return;
    const version = imageVersion.current;
    try {
      if (files.some(file => !['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024)) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF，单张不超过 2 MB');
      const added = await Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file);
      })));
      if (version !== imageVersion.current) return;
      setImages(current => [...current, ...added].slice(0, 4));
      if (images.length + added.length > 4) setError('每条消息最多附带 4 张图片');
    } catch (e: any) { setError(e.message); }
  }
  async function send(event: React.FormEvent, steer = false) {
    event.preventDefault(); if ((!message.trim() && !images.length) || !session || busy) return; setBusy(true); setError('');
    const selected = selection.current.sid;
    imageVersion.current++;
    try { await post(sessionUrl() + '/messages', { text: message, images, steer }); if (selection.current.sid === selected) { setMessage(''); setImages([]); setRunning(true); } }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function stop() { try { await post(sessionUrl() + '/stop'); } catch (e: any) { setError(e.message); } }
  const connected = status.connected && socketConnected;
  if (boot) return <div className="boot"><Logo/><span>正在连接工作空间…</span></div>;
  if (!user) return <main className="auth-page"><div className="auth-brand"><Logo/><strong>AI 助手</strong><span>Workspace</span></div><div className="auth-intro"><div className="eyebrow">YOUR IDEAS, IN MOTION</div><h1>从一个想法，<br/>到一个完成的项目。</h1><p>与你的 AI 助手 协作，让调研、文档和日常工作<br/>在一个专属空间里完成。</p><div className="auth-features"><span><Globe size={18}/> 浏览器调研</span><span><FileText size={18}/> 文档与报告</span><span><Terminal size={18}/> 代码与自动化</span></div><div className="auth-example"><span className="tiny-label">一个工作空间，无限可能</span><p>“整理最新资料，生成一份调研报告”</p><div><span className="dot"/> AI 助手 已准备好</div></div></div><section className="auth-card"><h2>{mode === 'login' ? '欢迎回来' : '创建你的账号'}</h2><p>{mode === 'login' ? '登录后继续你的项目与对话' : '开始你的第一个工作空间'}</p><form onSubmit={authenticate}><label>账号<input name="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={40} placeholder="输入账号"/></label><label>密码<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={128} placeholder="至少 8 个字符"/></label>{error && <div role="alert" className="inline-error">{error}</div>}{notice && <div className="notice">{notice}</div>}<button className="primary auth-submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? '登录' : '注册并登录'}<ArrowUp size={17}/></button></form><div className="auth-switch">{mode === 'login' ? '还没有账号？' : '已经有账号？'}<button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? '创建账号' : '返回登录'}</button></div><p className="auth-footnote">你的项目、对话与文件，始终有序。</p></section><div className="auth-footer">AI ASSISTANT WORKSPACE <span>一个轻量、专注的协作空间</span></div></main>;
  return <div className={'app ' + (!sidebar ? 'sidebar-hidden' : '')}>
    {sidebar && <aside className="sidebar"><div className="sidebar-top"><div className="brand"><Logo small/><strong>AI 助手</strong></div><button className="icon-button" title="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={18}/></button></div><button className="new-project" onClick={() => openDialog({ type: 'project', title: '创建项目' })}><Plus size={18}/> 新建项目</button><div className="section-label">项目 <span>{projects.length}</span></div><nav className="project-tree">{projects.length === 0 && <p className="sidebar-empty">创建一个项目<br/>开始整理你的想法</p>}{projects.map(p => <div className="project-group" key={p.id}><div className={'project-row '+(pid===p.id?'selected-project':'')}><button className="project-label" onClick={() => { setPid(p.id); setSid(p.sessions[0]?.id || ''); setCollapsed(v => ({...v,[p.id]:!v[p.id]})); }}>{collapsed[p.id] ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}<Folder size={16}/><span>{p.name}</span></button><div className="row-actions"><button title="创建会话" onClick={() => openDialog({type:'session',title:'创建会话',project:p})}><Plus size={14}/></button><button title="重命名项目" onClick={() => openDialog({type:'rename-project',title:'重命名项目',value:p.name,project:p})}><Pencil size={13}/></button><button title="删除项目" onClick={() => openDialog({type:'delete-project',title:'删除项目',project:p})}><Trash2 size={13}/></button></div></div>{!collapsed[p.id] && <div className="sessions">{p.sessions.map(s => <div className={'session-row '+(sid===s.id?'active':'')} key={s.id}><button onClick={() => { setPid(p.id); setSid(s.id); }}><MessageSquare size={14}/><span>{s.name}</span></button><div className="row-actions"><button title="重命名会话" onClick={() => openDialog({type:'rename-session',title:'重命名会话',value:s.name,project:p,session:s})}><Pencil size={12}/></button><button title="删除会话" onClick={() => openDialog({type:'delete-session',title:'删除会话',project:p,session:s})}><Trash2 size={12}/></button></div></div>)}<button className="add-session" onClick={() => openDialog({type:'session',title:'创建会话',project:p})}><Plus size={13}/> 新会话</button></div>}</div>)}</nav><div className="sidebar-bottom"><div className="connection"><span className={'dot '+(!connected?'offline':'')}/>{connected?'AI 助手 已连接':'正在等待连接'}<span className="mqtt-label">MQTT</span></div><button className="user-button" onClick={() => setMenu(!menu)}><span className="avatar">{user.username[0].toUpperCase()}</span><span>{user.username}<small>个人工作空间</small></span><Settings2 size={16}/></button>{menu && <div className="user-menu"><button onClick={() => openDialog({type:'password',title:'修改密码'})}><KeyRound size={16}/> 修改密码</button><button onClick={async () => { await post('/auth/logout'); setUser(null); setItems([]); }}><LogOut size={16}/> 退出登录</button></div>}</div></aside>}
    <main className="main"><header className="main-header"><div className="breadcrumb">{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} title="展开侧栏"><PanelLeftOpen size={19}/></button>}<span>{project?.name || '工作空间'}</span>{session && <><ChevronRight size={13}/><strong>{session.name}</strong></>}</div><button className={'file-toggle '+(filePanel?'selected':'')} onClick={() => setFilePanel(!filePanel)} disabled={!project}><Files size={16}/> 文件</button></header>
    {error && <div role="alert" className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误"><X size={15}/></button></div>}
    <div className="chat-scroll" ref={scroll}>{!session ? <div className="welcome"><Logo/><div className="eyebrow">LET’S BUILD SOMETHING</div><h1>{project ? '让这个项目，向前一步。' : '今天，想完成什么？'}</h1><p>{project ? '新建一个会话，开始与你的 AI 助手 协作。' : '从一个项目开始，把想法变成实际成果。'}</p><button className="primary" onClick={() => openDialog(project ? {type:'session',title:'创建会话',project} : {type:'project',title:'创建项目'})}><Plus size={17}/>{project?'新建会话':'创建第一个项目'}</button><div className="suggestions"><div><Globe/><strong>探索与调研</strong><span>浏览公开资料，整理关键发现</span></div><div><FileText/><strong>文档与报告</strong><span>生成可下载的办公文件</span></div><div><Terminal/><strong>构建与自动化</strong><span>让重复工作自动完成</span></div></div></div> : <div className="conversation">{cursor && <button className="older" disabled={loadingHistory} onClick={() => loadHistory(true)}>加载更早的消息</button>}{loadingHistory && items.length===0 && <div className="history-loading">正在加载会话…</div>}{items.length===0 && !loadingHistory && <div className="session-welcome"><Logo/><h2>从这里开始</h2><p>描述你想完成的任务，AI 助手 将在这个项目里工作。</p></div>}{items.map(item => <ChatItem key={item.id} item={item} projectId={pid}/>)}{running && <div className="working"><span className="pulse"/> AI 助手 正在工作<span className="working-hint">可以追加要求或停止任务</span></div>}{approvals.map(a => <div className="approval" key={String(a.id)}><strong>AI 助手 需要你的确认</strong><p>{a.params?.reason || a.params?.command || a.method}</p>{a.method.endsWith('/requestApproval') ? <div>{['accept','decline'].map(decision => <button key={decision} onClick={async () => { try { await post(sessionUrl()+'/approval',{requestId:a.id,decision}); setApprovals(v=>v.filter(x=>x.id!==a.id)); }catch(e:any){setError(e.message)} }}>{decision==='accept'?'允许':'拒绝'}</button>)}</div> : <p>此请求类型暂不支持，请停止任务后调整要求。</p>}</div>)}</div>}</div>
    <div className="composer-wrap"><form className="composer" onSubmit={e => send(e,running)}>
    {images.length > 0 && <div className="image-attachments">{images.map((image,index) => <div className="image-attachment" key={index}><img src={image} alt={`待发送图片 ${index+1}`}/><button type="button" aria-label={`移除图片 ${index+1}`} disabled={busy} onClick={() => setImages(current => current.filter((_,i) => i !== index))}><X size={14}/></button></div>)}</div>}
    <textarea aria-label="发送消息" value={message} onChange={e => setMessage(e.target.value)} onPaste={pasteImages} placeholder={session ? '描述任务，或粘贴图片…' : '先创建一个项目和会话'} disabled={!session||busy} onKeyDown={e => {if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if((message.trim()||images.length)&&!busy&&connected)send(e as any,running)}}}/><div className="composer-bottom"><span><span className="dot"/> AI 助手 <ChevronDown size={12}/></span><div><span className="enter-hint">{running?'追加到当前任务':'Enter 发送 · Shift + Enter 换行'}</span>{running && <button type="button" className="stop-button" title="停止任务" aria-label="停止任务" onClick={stop}><Square size={14} fill="currentColor"/></button>}<button type="submit" className="send-button" aria-label={running?'追加要求':'发送消息'} disabled={(!message.trim()&&!images.length)||!session||!connected||busy}><ArrowUp size={18}/></button></div></div></form><div className="composer-note">AI 助手 可能会出错，请核对重要信息。<span>文件保存在当前项目中</span></div></div></main>
    {filePanel && project && <aside className="file-panel"><div className="file-header"><strong>项目文件</strong><div><button title="刷新文件" onClick={refreshFiles}><RefreshCw size={15}/></button><button title="关闭文件" onClick={() => setFilePanel(false)}><X size={17}/></button></div></div><div className="file-path"><button disabled={!filePath} onClick={() => setFilePath(filePath.split('/').slice(0,-1).join('/'))}><ArrowLeft size={14}/></button><span>{filePath || project.name}</span></div>{files.length===0 && <div className="file-empty"><FolderOpen size={30}/><p>文件夹是空的</p><span>AI 助手 生成的文件会出现在这里</span></div>}<div className="file-list">{files.map(file => {const relative=[filePath,file.name].filter(Boolean).join('/');return <div className="file-row" key={file.name}><button className="file-name" onClick={() => file.directory && setFilePath(relative)} title={file.name}>{file.directory?<Folder size={17}/>:<FileText size={17}/>}<span>{file.name}<small>{file.directory?'文件夹':formatBytes(file.size)}</small></span></button><div>{!file.directory && <a title="下载文件" aria-label={'下载 '+file.name} href={`/api/projects/${pid}/download?path=${encodeURIComponent(relative)}`}><Download size={15}/></a>}<button title="删除文件" aria-label={'删除 '+file.name} onClick={() => openDialog({type:'delete-file',title:'删除文件',project,file})}><Trash2 size={14}/></button></div></div>})}</div><div className="files-foot">仅显示当前项目的文件</div></aside>}
    {dialog && <div className="modal-backdrop" onMouseDown={e => {if(e.target===e.currentTarget&&!busy)setDialog(null)}}><section className="modal" role="dialog" aria-modal="true" aria-label={dialog.title}><div className="modal-title"><h2>{dialog.title}</h2><button className="icon-button" onClick={() => setDialog(null)}><X size={18}/></button></div><form onSubmit={confirmDialog}>{dialog.type.startsWith('delete') ? <p className="delete-warning">确定删除「{dialog.file?.name || dialog.session?.name || dialog.project?.name}」？{dialog.type==='delete-project'?'项目下的会话、文件及磁盘目录也会删除。':dialog.type==='delete-session'?'仅删除聊天会话，项目共享文件会保留；删除文件请使用文件面板，或删除整个项目。':'此操作不可恢复。'}</p> : <>{dialog.type==='password' && <label>原密码<input type="password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)} required autoComplete="current-password"/></label>}<label>{dialog.type==='password'?'新密码':'名称'}<input autoFocus value={dialogValue} type={dialog.type==='password'?'password':'text'} onChange={e=>setDialogValue(e.target.value)} placeholder={dialog.type==='password'?'至少 8 个字符':'输入名称'} required minLength={dialog.type==='password'?8:1} maxLength={dialog.type==='password'?128:80} autoComplete={dialog.type==='password'?'new-password':'off'}/></label></>}{error && <div className="inline-error">{error}</div>}<div className="modal-buttons"><button type="button" className="secondary" onClick={()=>setDialog(null)}>取消</button><button className={dialog.type.startsWith('delete')?'danger':'primary'} disabled={busy}>{busy?'正在处理…':dialog.type.startsWith('delete')?'确认删除':'确定'}</button></div></form></section></div>}
  </div>;
}
function formatBytes(value:number){return value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`}
function MessageImages({content}:{content:any[]}) {
  return <div className="message-images">{content.filter(c => c.type === 'localImage' || c.type === 'image').map((image,index) => {
    const local = typeof image.path === 'string' && /\/([0-9a-f-]{36})\/attachments\/([0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/.exec(image.path);
    const src = local ? `/api/projects/${local[1]}/download?path=${encodeURIComponent('attachments/' + local[2])}` : /^data:image\/(png|jpeg|webp|gif);base64,/.test(image.url || '') ? image.url : '';
    return src ? <a key={index} href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt={`消息图片 ${index+1}`} loading="lazy"/></a> : <span key={index}>[图片]</span>;
  })}</div>;
}
function ChatItem({item, projectId}:{item:Item; projectId:string}) {
  if(item.type==='reasoning')return null;
  if(item.type==='userMessage'){const text=(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');return <div className="user-message"><div><MessageImages content={item.content || []}/>{text}</div></div>}
  if(item.type==='agentMessage')return <article className="agent-message"><div className="agent-label"><Logo small/><span>AI 助手</span></div><div className="markdown"><ReplyMarkdown text={item.text || ''} projectId={projectId}/></div></article>;
  if(item.type==='imageView')return <ReturnedImage value={(item as Item & {path:string}).path} projectId={projectId}/>;
  if(item.type==='commandExecution')return <details className="tool-item"><summary><Terminal size={14}/><span>{item.status==='inProgress'?'正在执行命令':'执行命令'}</span><small>{item.status==='completed'?'完成':item.status==='inProgress'?'运行中':item.status}</small><ChevronDown size={13}/></summary><pre>{item.command}</pre>{item.aggregatedOutput&&<pre className="tool-output">{item.aggregatedOutput.slice(-20000)}</pre>}</details>;
  if(item.type==='fileChange')return <details className="tool-item"><summary><FileText size={14}/><span>文件修改</span><ChevronDown size={13}/></summary><pre>{JSON.stringify(item.changes,null,2)}</pre></details>;
  return <div className="other-event"><Check size={13}/>{item.type}</div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
