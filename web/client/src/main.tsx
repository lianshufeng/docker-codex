import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplyMarkdown, ReturnedImage } from './reply-images';
import { ProjectLocation, ProjectLocationValue } from './project-location';
import { ElicitationForm } from './elicitation-form';
import { uploadFile } from './upload';
import { Plus, Folder, FolderOpen, MessageSquare, LoaderCircle, PanelLeftClose, PanelLeftOpen, ArrowUp, Square, ChevronDown, ChevronRight, Files, X, Download, Archive, Trash2, RefreshCw, LogOut, KeyRound, Settings2, ArrowLeft, Check, AlertCircle, Pencil, Terminal, Globe, File, FileText } from 'lucide-react';
import './style.css';
import './images.css';

type User = { id: string; username: string };
type Session = { id: string; threadId: string; name: string; createdAt: string; updatedAt?: string; running?: boolean };
type Project = { id: string; name: string; cwd: string; sessions: Session[]; deleting?: boolean };
type Item = { id: string; type: string; text?: string; content?: any[]; command?: string; aggregatedOutput?: string; status?: string; changes?: any[] };
type Attachment = { data: string; name: string; size: number; image: boolean; transferId?: string };
type Dialog = { type: string; title: string; value?: string; project?: Project; session?: Session; file?: any; relative?: string };
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
const compactLayout = '(max-width: 800px)';
function SessionIndicator({ running, unread, size }: { running: boolean; unread: boolean; size: number }) {
  if (running) return <LoaderCircle size={size} className="session-spinner" role="img" aria-label="正在执行"><title>正在执行</title></LoaderCircle>;
  if (unread) return <span className="session-unread" role="img" aria-label="已结束，未查看" title="已结束，未查看"/>;
  return <MessageSquare size={size} aria-hidden="true"/>;
}
function App() {
  const [user, setUser] = useState<User | null>(null), [boot, setBoot] = useState(true);
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [mode, setMode] = useState('login'), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<{ sessionId: string; turnId: string; message: string } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]), [pid, setPid] = useState(''), [sid, setSid] = useState('');
  const [turnActivity, setTurnActivity] = useState<Map<string, { running: boolean; version: number }>>(() => new Map());
  const turnVersion = useRef(0);
  const [unread, setUnread] = useState<{ userId: string; sessions: Set<string> } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}), [desktopSidebar, setDesktopSidebar] = useState(true), [filePanel, setFilePanel] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(compactLayout).matches);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [sessionQuery, setSessionQuery] = useState(''), [recentLimit, setRecentLimit] = useState(8);
  const sidebar = isMobile ? mobileSidebar : desktopSidebar;
  const drawerOpen = isMobile && (sidebar || (filePanel && Boolean(pid)));
  const [status, setStatus] = useState<any>({ connected: false, state: 'connecting' });
  const [items, setItems] = useState<Item[]>([]), [running, setRunning] = useState(false), [loadingHistory, setLoadingHistory] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<any[]>([]), [message, setMessage] = useState(''), [filePath, setFilePath] = useState(''), [files, setFiles] = useState<any[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null), [dialogValue, setDialogValue] = useState(''), [oldPassword, setOldPassword] = useState('');
  const [projectLocation, setProjectLocation] = useState<ProjectLocationValue | null>(null);
  const [menu, setMenu] = useState(false), [socketConnected, setSocketConnected] = useState(false);
  const [images, setImages] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!drawerOpen || !user || dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !drawer.current) return;
      const controls = Array.from(drawer.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', trapFocus);
    return () => { document.removeEventListener('keydown', trapFocus); previousFocus?.focus(); };
  }, [drawerOpen, sidebar, user?.id, dialog]);
  const [readingFiles, setReadingFiles] = useState(false);
  const reading = useRef(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const imageVersion = useRef(0);
  const selection = useRef({ pid, sid }); selection.current = { pid, sid };
  const historyVersion = useRef(0), liveVersion = useRef(0), fileVersion = useRef(0), scroll = useRef<HTMLDivElement>(null);
  const project = projects.find(p => p.id === pid), session = project?.sessions.find(s => s.id === sid);
  const sessionUrl = (p = pid, s = sid) => `/projects/${p}/sessions/${s}`;
  useEffect(() => {
    const media = window.matchMedia(compactLayout);
    const update = () => { setIsMobile(media.matches); setMobileSidebar(false); setFilePanel(false); };
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);
  function setSidebar(open: boolean) {
    if (isMobile) { setMobileSidebar(open); if (open) setFilePanel(false); }
    else setDesktopSidebar(open);
    if (!open) setMenu(false);
  }
  function closeDrawer() { setSidebar(false); setFilePanel(false); }
  function toggleFiles() {
    if (isMobile) setSidebar(false);
    setFilePanel(!filePanel);
  }
  const projectsVersion = useRef(0);
  async function refreshProjects() {
    const version = ++projectsVersion.current;
    const turnAt = turnVersion.current;
    const result = await api('/projects');
    if (version === projectsVersion.current) {
      setProjects(result.projects);
      setTurnActivity(current => new Map([...current].filter(([, activity]) => activity.version > turnAt)));
    }
    return result.projects as Project[];
  }
  function markRead(sessionId: string) {
    setUnread(current => {
      if (!current?.sessions.has(sessionId)) return current;
      const sessions = new Set(current.sessions);
      sessions.delete(sessionId);
      return { ...current, sessions };
    });
  }
  function sessionIndicator(session: Session, size: number) {
    return <SessionIndicator size={size}
      running={Boolean(status.connected && socketConnected && (turnActivity.get(session.id)?.running ?? session.running))}
      unread={Boolean(unread && unread.userId === user?.id && unread.sessions.has(session.id))}/>;
  }
  function selectSession(projectId: string, sessionId: string) {
    selection.current = { pid: projectId, sid: sessionId };
    markRead(sessionId);
    setPid(projectId); setSid(sessionId); setSessionQuery(''); setRecentLimit(8);
    if (isMobile) setSidebar(false);
  }
  function sessionActivity(session: Session) { return Date.parse(session.updatedAt || session.createdAt) || 0; }
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
      if (!older && !result.active && liveVersion.current === liveAt) {
        setRetry(current => current?.sessionId === selected.sid ? null : current);
      }
    } catch (e: any) {
      if (version === historyVersion.current && selected.sid === selection.current.sid) setError(e.message);
    } finally { if (version === historyVersion.current) setLoadingHistory(false); }
  }
  async function refreshFiles() {
    if (!pid) return; const version = ++fileVersion.current;
    try { const result = await api(`/projects/${pid}/files?path=${encodeURIComponent(filePath)}`); if (version === fileVersion.current) setFiles(result.files); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => {
    const session = api('/me').then(result => { setUser(result.user); setStatus(result.status); });
    const settings = api('/auth/config').then(result => setAllowRegistration(result.allowRegistration === true));
    Promise.allSettled([session, settings]).then(() => setBoot(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    const userId = user.id;
    const savedSelection = JSON.parse(localStorage.getItem('codex-selection-' + user.id) || '{}');
    const unreadKey = 'codex-unread-' + user.id;
    let savedUnread: string[] = [];
    try { savedUnread = JSON.parse(localStorage.getItem(unreadKey) || '[]'); } catch {}
    setUnread({ userId: user.id, sessions: new Set(Array.isArray(savedUnread) ? savedUnread : []) });
    setTurnActivity(new Map());
    setProjects([]); setItems([]); setApprovals([]); setRetry(null); setPid(''); setSid(''); setSessionQuery(''); setRecentLimit(8);
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
        if (data.type === 'session-activity') {
          setProjects(current => current.map(project => project.id === data.projectId ? {
            ...project,
            sessions: project.sessions.map(session => session.id === data.sessionId && (!session.updatedAt || session.updatedAt < data.updatedAt)
              ? { ...session, updatedAt: data.updatedAt } : session),
          } : project));
          return;
        }
        if (data.type === 'projects-changed') { refreshProjects().catch(e => setError(e.message)); return; }
        if (data.type === 'status') { setStatus(data); if (data.connected) { refreshProjects().catch(e => setError(e.message)); if (selection.current.sid) loadHistory(); } return; }
        if (data.type !== 'rpc') return;
        const { method, params = {}, id } = data.payload;
        if (method === 'turn/started' || method === 'turn/completed') {
          const version = ++turnVersion.current;
          const running = method === 'turn/started';
          setTurnActivity(current => new Map(current).set(data.sessionId, { running, version }));
          if (!running && (data.sessionId !== selection.current.sid || document.hidden)) {
            setUnread(current => current?.userId === userId
              ? { ...current, sessions: new Set(current.sessions).add(data.sessionId) } : current);
          }
        }
        if (data.sessionId !== selection.current.sid) return;
        liveVersion.current++;
        if (method === 'error' && params.willRetry === true) {
          const attempt = /^Reconnecting\.{3}\s*(\d+\/\d+)$/.exec(params.error?.message ?? params.message ?? '')?.[1];
          setRetry({ sessionId: data.sessionId, turnId: params.turnId,
            message: attempt ? `正在重连… ${attempt}` : '连接中断，正在重试…' });
        } else if (method === 'error' || method === 'turn/completed' ||
          (method?.startsWith('item/') && (method.endsWith('/delta') || method === 'item/started' || method === 'item/completed'))) {
          const turnId = params.turnId ?? params.turn?.id;
          setRetry(current => current && current.sessionId === data.sessionId && current.turnId === turnId ? null : current);
        }
        if (id !== undefined) setApprovals(current => [...current.filter(a => a.id !== id), data.payload]);
        if (method === 'serverRequest/resolved') setApprovals(current => current.filter(a => a.id !== params.requestId));
        if (method === 'turn/started') setRunning(true);
        if (method === 'turn/completed') {
          setRunning(false);
          setApprovals(current => current.filter(request =>
            request.method === 'mcpServer/elicitation/request' && request.params.turnId !== params.turn.id));
          if (params.turn.error) setError(params.turn.error.message);
          loadHistory();
        }
        if (method === 'error' && params.willRetry !== true) setError(params.error?.message || params.message || '任务发生错误');
        if ((method === 'item/started' || method === 'item/completed') && params.item) {
          setItems(current => { const index = current.findIndex(i => i.id === params.item.id); if (index < 0) return [...current, params.item]; return current.map((i, n) => n === index ? params.item : i); });
        }
        if (method === 'item/agentMessage/delta') {
          setItems(current => {
            if (!current.some(i => i.id === params.itemId)) return [...current, { id: params.itemId, type: 'agentMessage', text: params.delta }];
            return current.map(i => i.id === params.itemId ? { ...i, text: (i.text || '') + params.delta } : i);
          });
        }
        if (method === 'item/commandExecution/outputDelta') setItems(current => current.map(i => i.id === params.itemId ? { ...i, aggregatedOutput: ((i.aggregatedOutput || '') + params.delta) } : i));
      };
      socket.onclose = event => { setSocketConnected(false); if (event.code === 1008) { setUser(null); setItems([]); return; } if (!disposed) timer = setTimeout(connect, 2000); };
      socket.onerror = () => socket.close();
    }
    connect(); return () => { disposed = true; clearTimeout(timer); socket?.close(); };
  }, [user?.id]);
  useEffect(() => {
    if (unread && unread.userId === user?.id) {
      localStorage.setItem('codex-unread-' + unread.userId, JSON.stringify([...unread.sessions]));
    }
  }, [unread, user?.id]);
  useEffect(() => {
    if (!sid || unread?.userId !== user?.id) return;
    const viewSession = () => { if (!document.hidden) markRead(sid); };
    viewSession();
    document.addEventListener('visibilitychange', viewSession);
    return () => document.removeEventListener('visibilitychange', viewSession);
  }, [sid, unread?.userId, user?.id]);
  useEffect(() => {
    historyVersion.current++; fileVersion.current++; imageVersion.current++; setImages([]); setItems([]); setCursor(null); setRunning(false); setApprovals([]); setRetry(null); setFilePath('');
    if (user) localStorage.setItem('codex-selection-' + user.id, JSON.stringify({ pid, sid }));
    if (sid) loadHistory();
    else setLoadingHistory(false);
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
  function openDialog(value: Dialog) { setNotice(''); setProjectLocation(null); setDialog(value); setDialogValue(value.value || ''); setOldPassword(''); setMenu(false); setError(''); }
  async function confirmDialog(event: React.FormEvent) {
    event.preventDefault(); if (!dialog) return; setBusy(true); setError('');
    try {
      const p = dialog.project;
      if (dialog.type === 'project') {
        if (!projectLocation) return;
        const { project: created } = await post('/projects', projectLocation);
        setProjects(current => {
          const existing = current.find(project => project.id === created.id);
          const sessions = [...created.sessions, ...(existing?.sessions ?? []).filter(session => !created.sessions.some((added: Session) => added.id === session.id))];
          return [{ ...created, sessions }, ...current.filter(project => project.id !== created.id)];
        });
        selectSession(created.id, created.sessions[0]?.id || '');
        void refreshProjects().catch(e => setError(e.message));
      } else if (dialog.type === 'session' && p) {
        const result = await post(`/projects/${p.id}/sessions`, status.capabilities?.renameThread === false ? {} : { name: dialogValue || '新会话' });
        setProjects(current => current.map(project => project.id === p.id
          ? { ...project, sessions: [result.session, ...project.sessions.filter(session => session.id !== result.session.id)] } : project));
        setPid(p.id); setSid(result.session.id); setDialog(null); if (isMobile) setSidebar(false);
        void refreshProjects().catch(e => setError(e.message));
        if (result.warning) setError(result.warning);
      } else if (dialog.type === 'rename-project' && p) {
        await api(`/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: dialogValue }) }); await refreshProjects();
      } else if (dialog.type === 'rename-session' && p && dialog.session) {
        await api(sessionUrl(p.id, dialog.session.id), { method: 'PATCH', body: JSON.stringify({ name: dialogValue }) }); await refreshProjects();
      } else if (dialog.type === 'delete-project' && p) {
        await api(`/projects/${p.id}`, { method: 'DELETE' }); await refreshProjects(); if (pid === p.id) { setPid(''); setSid(''); }
      } else if (dialog.type === 'archive-session' && p && dialog.session) {
        const archivedId = dialog.session.id;
        await post(sessionUrl(p.id, archivedId) + '/archive');
        if (selection.current.sid === archivedId) {
          historyVersion.current++;
          setSid('');
          setError('');
        }
        setProjects(current => current.flatMap(project => {
          if (project.id !== p.id) return [project];
          const sessions = project.sessions.filter(session => session.id !== archivedId);
          return sessions.length ? [{ ...project, sessions }] : [];
        }));
        void refreshProjects().catch(e => setError(e.message));
      } else if (dialog.type === 'delete-file' && p && dialog.relative) {
        await api(`/projects/${p.id}/files?path=${encodeURIComponent(dialog.relative)}`, { method: 'DELETE' }); await refreshFiles();
      } else if (dialog.type === 'password') {
        await post('/auth/password', { oldPassword, newPassword: dialogValue }); setUser(null); setItems([]); setNotice('密码已修改，请重新登录');
      }
      setDialog(null);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function addFiles(selected: File[]) {
    if (!selected.length || busy || reading.current || !session) return;
    reading.current = true; setReadingFiles(true); setError('');
    const version = imageVersion.current;
    try {
      if (selected.some(file => file.type.startsWith('image/') && !['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))) throw new Error('图片格式不受支持');
      const added: Attachment[] = [];
      for (const file of selected) {
        const image = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
        if (status.capabilities?.fileTransfer) {
          const receipt = await uploadFile(pid, session.id, file, image, percent => setUploadProgress(`${file.name} · ${percent}%`));
          if (version !== imageVersion.current) return;
          const preview = image ? URL.createObjectURL(file) : '';
          added.push({ data: preview, name: file.name, size: file.size, image, transferId: receipt.transferId });
        } else added.push(await new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ data: String(reader.result), name: file.name, size: file.size, image: file.type.startsWith('image/') }); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file);
        }));
      }
      if (version !== imageVersion.current) return;
      setImages(current => [...current, ...added]);
    } catch (e: any) { setError(e.message); } finally { reading.current = false; setReadingFiles(false); setUploadProgress(''); }
  }
  async function pasteImages(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    await addFiles(files);
  }
  async function send(event: React.FormEvent, steer = false) {
    event.preventDefault(); if ((!message.trim() && !images.length) || !session || busy || reading.current) return; setBusy(true); setError('');
    const selected = selection.current.sid;
    imageVersion.current++;
    try { await post(sessionUrl() + '/messages', { text: message, files: images.filter(file => !file.transferId), attachments: images.filter(file => file.transferId).map(file => file.transferId), steer }); if (selection.current.sid === selected) { setMessage(''); setImages([]); setRunning(true); if (filePanel) await refreshFiles(); } }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function stop() { try { await post(sessionUrl() + '/stop'); } catch (e: any) { setError(e.message); } }
  const connected = status.connected && socketConnected;
  const canSteer = status.capabilities?.steer !== false;
  const canArchiveThread = status.capabilities?.archiveThread !== false;
  const canRenameThread = status.capabilities?.renameThread !== false;
  const canFiles = status.capabilities?.files !== false;
  const query = sessionQuery.trim().toLocaleLowerCase();
  const matchingProjects = query ? projects.filter(project => project.name.toLocaleLowerCase().includes(query)) : projects;
  const recentSessions = useMemo(() => projects.flatMap(project => project.sessions.map(session => ({ project, session })))
    .filter(({ project, session }) => !query || (project.name + ' ' + session.name).toLocaleLowerCase().includes(query))
    .sort((a, b) => sessionActivity(b.session) - sessionActivity(a.session) || a.session.id.localeCompare(b.session.id)), [projects, query]);
  if (boot) return <div className="boot"><Logo/><span>正在连接工作空间…</span></div>;
  if (!user) return <main className="auth-page"><div className="auth-brand"><Logo/><strong>AI 助手</strong><span>Workspace</span></div><div className="auth-intro"><div className="eyebrow">YOUR IDEAS, IN MOTION</div><h1>从一个想法，<br/>到一个完成的项目。</h1><p>与你的 AI 助手 协作，让调研、文档和日常工作<br/>在一个专属空间里完成。</p><div className="auth-features"><span><Globe size={18}/> 浏览器调研</span><span><FileText size={18}/> 文档与报告</span><span><Terminal size={18}/> 代码与自动化</span></div><div className="auth-example"><span className="tiny-label">一个工作空间，无限可能</span><p>“整理最新资料，生成一份调研报告”</p><div><span className="dot"/> AI 助手 已准备好</div></div></div><section className="auth-card"><h2>{mode === 'login' ? '欢迎回来' : '创建你的账号'}</h2><p>{mode === 'login' ? '登录后继续共享项目与对话' : '登录后共享执行端工作空间'}</p><form onSubmit={authenticate}><label>账号<input name="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={40} placeholder="输入账号"/></label><label>密码<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={128} placeholder="至少 8 个字符"/></label>{error && <div role="alert" className="inline-error">{error}</div>}{notice && <div className="notice">{notice}</div>}<button className="primary auth-submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? '登录' : '注册并登录'}<ArrowUp size={17}/></button></form>{allowRegistration && <div className="auth-switch">{mode === 'login' ? '还没有账号？' : '已经有账号？'}<button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? '创建账号' : '返回登录'}</button></div>}<p className="auth-footnote">你的项目、对话与文件，始终有序。</p></section><div className="auth-footer">AI ASSISTANT WORKSPACE <span>一个轻量、专注的协作空间</span></div></main>;
  return <div className={'app ' + (!sidebar ? 'sidebar-hidden' : '')} onKeyDown={event => { if (event.key === 'Escape' && drawerOpen && !dialog) closeDrawer(); }}>
    {drawerOpen && <div className="mobile-backdrop" aria-hidden="true" onClick={closeDrawer}/>}
    {sidebar && <aside className="sidebar" aria-label="项目与会话" ref={isMobile ? drawer : undefined}><div className="sidebar-top"><div className="brand"><Logo small/><strong>AI 助手</strong></div><button className="icon-button" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={18}/></button></div><button className="new-project" onClick={() => openDialog({ type: 'project', title: '新建项目' })}><Plus size={18}/> 新建项目</button><label className="sidebar-search"><span>搜索项目或会话</span><input type="search" aria-label="搜索项目或会话" placeholder="搜索项目或会话…" value={sessionQuery} onChange={event => { setSessionQuery(event.target.value); setRecentLimit(8); }}/></label><nav className="project-tree" aria-label="会话导航">
      <div className="section-label">{query ? '搜索结果' : '最近会话'} <span>{recentSessions.length}</span></div>
      <div className="recent-sessions">{recentSessions.slice(0, recentLimit).map(({ project: p, session: s }) => <button key={s.id} className={'recent-session '+(sid===s.id?'active':'')} onClick={() => selectSession(p.id,s.id)} title={s.name+' · '+p.cwd}>{sessionIndicator(s,15)}<span><strong>{s.name}</strong><small>{p.name}</small></span></button>)}
      {recentSessions.length===0 && <p className="sidebar-empty">{query ? (matchingProjects.length ? '匹配的项目下暂无会话' : '没有找到匹配的会话') : '新建会话后会显示在这里'}</p>}
      {recentSessions.length>recentLimit && <button className="load-more-sessions" onClick={() => setRecentLimit(value => value+20)}>查看更多会话 <ChevronDown size={13}/></button>}</div>
      {(!query || matchingProjects.length > 0) && <div className="section-label project-section-label">项目 <span>{matchingProjects.length}</span></div>}{!query && projects.length === 0 && <p className="sidebar-empty">创建一个项目<br/>开始整理你的想法</p>}{matchingProjects.map(p => <div className="project-group" key={p.id}><div className={'project-row '+(pid===p.id?'selected-project':'')}><button className="project-label" title={p.cwd} onClick={() => { if (query) { setPid(p.id); setSid(p.sessions[0]?.id || ''); setCollapsed(v => ({...v,[p.id]:false})); setSessionQuery(''); setRecentLimit(8); return; } if (!isMobile || pid !== p.id) { setPid(p.id); setSid(p.sessions[0]?.id || ''); } setCollapsed(v => ({...v,[p.id]:!(v[p.id] ?? (pid!==p.id))})); }}>{(collapsed[p.id] ?? (pid!==p.id)) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}<Folder size={16}/><span>{p.name}</span></button><div className="row-actions"><button title="创建会话" onClick={() => openDialog({type:'session',title:'创建会话',project:p})}><Plus size={14}/></button><button disabled title="目录分组名称由执行端路径决定" onClick={() => openDialog({type:'rename-project',title:'重命名项目',value:p.name,project:p})}><Pencil size={13}/></button><button disabled title="请逐个归档会话，目录单独管理" onClick={() => openDialog({type:'delete-project',title:'删除项目',project:p})}><Trash2 size={13}/></button></div></div>{!query && !(collapsed[p.id] ?? (pid!==p.id)) && <div className="sessions">{p.sessions.map(s => <div className={'session-row '+(sid===s.id?'active':'')} key={s.id}><button onClick={() => selectSession(p.id,s.id)}>{sessionIndicator(s,14)}<span>{s.name}</span></button><div className="row-actions"><button title={canRenameThread?"重命名会话":"更新桌面连接服务后可修改名称"} disabled={!canRenameThread} onClick={() => openDialog({type:'rename-session',title:'重命名会话',value:s.name,project:p,session:s})}><Pencil size={12}/></button><button title="归档会话" disabled={!canArchiveThread} onClick={() => openDialog({type:'archive-session',title:'归档会话',project:p,session:s})}><Archive size={12}/></button></div></div>)}<button className="add-session" onClick={() => openDialog({type:'session',title:'创建会话',project:p})}><Plus size={13}/> 新会话</button></div>}</div>)}</nav><div className="sidebar-bottom"><div className="connection"><span className={'dot '+(!connected?'offline':'')}/>{connected?'AI 助手 已连接':'正在等待连接'}<span className="mqtt-label">MQTT</span></div><button className="user-button" onClick={() => setMenu(!menu)}><span className="avatar">{user.username[0].toUpperCase()}</span><span>{user.username}<small>共享工作空间</small></span><Settings2 size={16}/></button>{menu && <div className="user-menu"><button onClick={() => openDialog({type:'password',title:'修改密码'})}><KeyRound size={16}/> 修改密码</button><button onClick={async () => { await post('/auth/logout'); setUser(null); setItems([]); }}><LogOut size={16}/> 退出登录</button></div>}</div></aside>}
    <main className="main" inert={drawerOpen}><header className="main-header"><div className="breadcrumb">{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} title="展开侧栏" aria-label="展开侧栏"><PanelLeftOpen size={19}/></button>}<span>{project?.name || '工作空间'}</span>{session && <><ChevronRight size={13}/><strong>{session.name}</strong></>}</div><button className={'file-toggle '+(filePanel?'selected':'')} onClick={toggleFiles} disabled={!project||!canFiles} aria-expanded={filePanel}><Files size={16}/> 文件</button></header>
    {error && <div role="alert" className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误"><X size={15}/></button></div>}
    {!error && retry && retry.sessionId === sid && <div role="status" className="error-banner"><AlertCircle size={16}/><span>{retry.message}</span><button onClick={() => setRetry(null)} aria-label="关闭重连提示"><X size={15}/></button></div>}
    <div className="chat-scroll" ref={scroll}>{!session ? <div className="welcome"><Logo/><div className="eyebrow">LET’S BUILD SOMETHING</div><h1>{project ? '让这个项目，向前一步。' : '今天，想完成什么？'}</h1><p>{project ? '新建一个会话，开始与你的 AI 助手 协作。' : '从一个项目开始，把想法变成实际成果。'}</p><button className="primary" onClick={() => openDialog(project ? {type:'session',title:'创建会话',project} : {type:'project',title:'新建项目'})}><Plus size={17}/>{project?'新建会话':'选择工作目录'}</button><div className="suggestions"><div><Globe/><strong>探索与调研</strong><span>浏览公开资料，整理关键发现</span></div><div><FileText/><strong>文档与报告</strong><span>生成可下载的办公文件</span></div><div><Terminal/><strong>构建与自动化</strong><span>让重复工作自动完成</span></div></div></div> : <div className="conversation">{cursor && <button className="older" disabled={loadingHistory} onClick={() => loadHistory(true)}>加载更早的消息</button>}{loadingHistory && items.length===0 && <div className="history-loading">正在加载会话…</div>}{items.length===0 && !loadingHistory && <div className="session-welcome"><Logo/><h2>从这里开始</h2><p>描述你想完成的任务，AI 助手 将在这个项目里工作。</p></div>}{items.map(item => <ChatItem key={item.id} item={item} projectId={pid}/>)}{running && <div className="working"><span className="pulse"/> AI 助手 正在工作<span className="working-hint">{canSteer ? '可以追加要求或停止任务' : '可以停止任务'}</span></div>}{approvals.map(a => a.method === 'mcpServer/elicitation/request' ? <ElicitationForm key={JSON.stringify([sid, a.id])} request={a.params} respond={async answer => {
      await post(sessionUrl()+'/approval', {requestId:a.id, ...answer});
      if (selection.current.sid === sid) setApprovals(current => current.filter(request => request !== a));
    }}/> : a.method === "item/tool/requestUserInput" ? <UserInputRequest key={JSON.stringify([sid, a.id])} questions={a.params.questions} onSubmit={async answers => {
      await post(sessionUrl()+'/approval', {requestId:a.id, answers});
      if (selection.current.sid === sid) setApprovals(current => current.filter(request => request !== a));
    }}/> : <div className="approval" key={String(a.id)}><strong>AI 助手 需要你的确认</strong><p>{a.params?.reason || a.params?.command || a.method}</p>{a.method.endsWith('/requestApproval') ? <div>{['accept','decline'].map(decision => <button key={decision} onClick={async () => { try { await post(sessionUrl()+'/approval',{requestId:a.id,decision}); setApprovals(v=>v.filter(x=>x.id!==a.id)); }catch(e:any){setError(e.message)} }}>{decision==='accept'?'允许':'拒绝'}</button>)}</div> : <p>此请求类型暂不支持，请停止任务后调整要求。</p>}</div>)}</div>}</div>
    <div className="composer-wrap">{uploadProgress && <div className="notice" role="status">正在上传 {uploadProgress}，失败后重新选择文件可续传</div>}<form className="composer" onSubmit={e => send(e,running)}>
    {images.length > 0 && <div className="image-attachments">{images.map((file,index) => <div className="image-attachment" key={index} title={`${file.name} · ${formatBytes(file.size)}`}>{file.image ? <img src={file.data} alt={`待发送图片 ${index+1}`}/> : <div className="file-attachment"><FileText size={22}/><span>{file.name}<small>{formatBytes(file.size)}</small></span></div>}<button type="button" aria-label={`移除${file.image ? '图片' : '附件'} ${index+1}`} disabled={busy} onClick={() => setImages(current => current.filter((_,i) => i !== index))}><X size={14}/></button></div>)}</div>}
    <textarea aria-label="发送消息" value={message} onChange={e => setMessage(e.target.value)} onPaste={pasteImages} placeholder={session ? '描述任务，或粘贴图片…' : '先创建一个项目和会话'} disabled={!session||busy} onKeyDown={e => {if(!isMobile&&e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if((message.trim()||images.length)&&!busy&&connected&&(!running||canSteer))send(e as any,running)}}}/><div className="composer-bottom"><span><span className="dot"/> AI 助手 <ChevronDown size={12}/></span><div><input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(Array.from(e.target.files || [])); e.currentTarget.value = ''; }}/><button type="button" className="icon-button" title="添加文件（支持分块上传和断点续传）" aria-label="添加文件" disabled={!session||busy||readingFiles||!canFiles} onClick={() => fileInput.current?.click()}><Plus size={18}/></button><span className="enter-hint">{running?(canSteer?'追加到当前任务':'等待当前任务完成'):'Enter 发送 · Shift + Enter 换行'}</span>{running && <button type="button" className="stop-button" title="停止任务" aria-label="停止任务" onClick={stop}><Square size={14} fill="currentColor"/></button>}<button type="submit" className="send-button" aria-label={running?'追加要求':'发送消息'} disabled={(!message.trim()&&!images.length)||!session||!connected||busy||readingFiles||(running&&!canSteer)}><ArrowUp size={18}/></button></div></div></form><div className="composer-note">AI 助手 可能会出错，请核对重要信息。<span>所有登录用户共享当前执行端</span></div></div></main>
    {filePanel && project && <aside className="file-panel" aria-label="项目文件" ref={isMobile ? drawer : undefined}><div className="file-header"><strong>项目文件</strong><div><button title="刷新文件" onClick={refreshFiles}><RefreshCw size={15}/></button><button title="关闭文件" onClick={() => setFilePanel(false)}><X size={17}/></button></div></div><div className="file-path"><button disabled={!filePath} onClick={() => setFilePath(filePath.split('/').slice(0,-1).join('/'))}><ArrowLeft size={14}/></button><span>{filePath || project.name}</span></div>{files.length===0 && <div className="file-empty"><FolderOpen size={30}/><p>文件夹是空的</p><span>AI 助手 生成的文件会出现在这里</span></div>}<div className="file-list">{files.map(file => {const relative=[filePath,file.name].filter(Boolean).join('/');return <div className="file-row" key={file.name}><button className="file-name" onClick={() => file.directory && setFilePath(relative)} title={file.name}>{file.directory?<Folder size={17}/>:<File size={17}/>}<span>{file.name}<small>{file.directory?'文件夹':formatBytes(file.size)}</small></span></button><div>{!file.directory && <a title="下载文件" aria-label={'下载 '+file.name} href={`/api/projects/${pid}/download?path=${encodeURIComponent(relative)}`}><Download size={15}/></a>}<button title={file.directory?'删除文件夹':'删除文件'} disabled={busy||running} aria-label={'删除 '+file.name} onClick={() => openDialog({type:'delete-file',title:file.directory?'删除文件夹':'删除文件',project,file,relative})}><Trash2 size={14}/></button></div></div>})}</div><div className="files-foot">仅显示当前项目的文件</div></aside>}
    {dialog && <div className="modal-backdrop" onMouseDown={e => {if(e.target===e.currentTarget&&!busy)setDialog(null)}}><section className="modal" role="dialog" aria-modal="true" aria-label={dialog.title}><div className="modal-title"><h2>{dialog.title}</h2><button className="icon-button" onClick={() => setDialog(null)}><X size={18}/></button></div><form onSubmit={confirmDialog}>{dialog.type==='archive-session' ? <p className="delete-warning">确定归档「{dialog.session?.name}」？会话将从共享列表移除，历史、目录和文件会保留。</p> : dialog.type.startsWith('delete') ? <p className="delete-warning">确定删除「{dialog.file?.name || dialog.session?.name || dialog.project?.name}」？{dialog.type==='delete-project'?'目录分组由执行端会话决定，请逐个归档会话。':dialog.file?.directory?'将删除该文件夹及全部内容，无法恢复。':'此操作不可恢复。'}</p> : <>{dialog.type==='password' && <label>原密码<input type="password" value={oldPassword} onChange={e=>setOldPassword(e.target.value)} required autoComplete="current-password"/></label>}{dialog.type==='project' ? <ProjectLocation request={api} onChange={setProjectLocation}/> : dialog.type==='session'&&!canRenameThread ? <p className="delete-warning">将在当前项目中创建新会话。当前桌面连接服务尚未支持自定义名称，更新后可修改名称。</p> : <label>{dialog.type==='password'?'新密码':'名称'}<input autoFocus value={dialogValue} type={dialog.type==='password'?'password':'text'} onChange={e=>setDialogValue(e.target.value)} placeholder={dialog.type==='password'?'至少 8 个字符':'输入名称'} required minLength={dialog.type==='password'?8:1} maxLength={dialog.type==='password'?128:undefined} autoComplete={dialog.type==='password'?'new-password':'off'}/></label>}</>}{dialog.type==='project' && notice && <div className="notice">{notice}</div>}{error && <div className="inline-error">{error}</div>}<div className="modal-buttons"><button type="button" className="secondary" onClick={()=>setDialog(null)}>取消</button><button className={dialog.type.startsWith('delete')?'danger':'primary'} disabled={busy||(dialog.type==='project'&&!projectLocation)}>{busy?'正在处理…':dialog.type==='archive-session'?'确认归档':dialog.type.startsWith('delete')?'确认删除':'确定'}</button></div></form></section></div>}
  </div>;
}
type InputQuestion = { id: string; header: string; question: string; isOther: boolean; isSecret: boolean;
  options: { label: string; description: string }[] | null };

function InputQuestionField({ question, index }: { question: InputQuestion; index: number }) {
  const [selected, setSelected] = useState('');
  const options = question.options || [];
  return <fieldset>
    <legend>{question.header}</legend>
    <label>
      {question.question}
      {options.length > 0 && <select required value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="" disabled>请选择</option>
        {options.map((option, i) => <option key={i} value={i}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}
        {question.isOther && <option value="other">其他（自行填写）</option>}
      </select>}
      {(!options.length || selected === 'other') && <input name={String(index)} required
        aria-label="填写答案" type={question.isSecret ? 'password' : 'text'} autoComplete="off"/>}
      {selected !== '' && selected !== 'other' && <input type="hidden" name={String(index)} value={options[Number(selected)].label}/>}
    </label>
  </fieldset>;
}

function UserInputRequest({ questions, onSubmit }: {
  questions: InputQuestion[];
  onSubmit: (answers: Record<string, string>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await onSubmit(Object.fromEntries(questions.map((question, i) => [question.id, String(data.get(String(i)) ?? '')])));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return <form className="approval user-input-request" onSubmit={submit}>
    <strong>AI 助手 等待你的回答</strong>
    {questions.map((question, i) => <InputQuestionField key={question.id} question={question} index={i}/>)}
    <button disabled={busy}>{busy ? '正在提交…' : '提交回答'}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function formatBytes(value:number){if(value==null)return '文件';return value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`}
function MessageImages({content,projectId}:{content:any[];projectId:string}) {
  return <div className="message-images">{content.filter(c => c.type === 'localImage' || c.type === 'image').map((image,index) => {
    const local = typeof image.path === 'string' ? image.path : '';
    const src = local ? `/api/projects/${projectId}/image?path=${encodeURIComponent(local)}` : /^data:image\/(png|jpeg|webp|gif);base64,/.test(image.url || '') ? image.url : '';
    return src ? <MessageImage key={src} src={src} index={index}/> : <span key={index}>[图片]</span>;
  })}</div>;
}
function MessageImage({src, index}:{src:string; index:number}) {
  const [missing, setMissing] = useState(false);
  return missing ? <span>图片不存在或无法读取</span> : <a href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt={`消息图片 ${index+1}`} loading="lazy" onError={() => setMissing(true)}/></a>;
}
function MessageFile({name, relative, projectId}:{name:string; relative:string; projectId:string}) {
  const [error, setError] = useState('');
  const url = `/api/projects/${projectId}/download?path=${encodeURIComponent(relative)}`;
  async function download(event: React.MouseEvent) {
    event.preventDefault(); setError('');
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) throw new Error(response.status === 404 ? '文件不存在或已删除' : '文件下载失败');
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    } catch (e: any) { setError(e.message); }
  }
  return <span className="message-file"><File size={16}/><a href={url} onClick={download}>{name}</a>{error && <small role="alert">{error}</small>}</span>;
}
function UserMessage({content, projectId}:{content:any[]; projectId:string}) {
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return <div className="user-message"><div><MessageImages content={content} projectId={projectId}/>{text.split('\n').map((line:string, index:number) => {
    if (line.startsWith('附件：')) {
      try {
        const file = JSON.parse(line.slice(3));
        if (typeof file.name === 'string' && typeof file.path === 'string' && /^attachments\/(?:\d{8}\/)?[^/\\]+$/.test(file.path)) return <MessageFile key={index} name={file.name} relative={file.path} projectId={projectId}/>;
      } catch { /* 普通消息中的同名文本按原样显示。 */ }
    }
    return <React.Fragment key={index}>{line}{'\n'}</React.Fragment>;
  })}</div></div>;
}
function ChatItem({item, projectId}:{item:Item; projectId:string}) {
  if(item.type==='reasoning')return null;
  if(item.type==='userMessage')return <UserMessage content={item.content || []} projectId={projectId}/>;
  if(item.type==='agentMessage')return <article className="agent-message"><div className="agent-label"><Logo small/><span>AI 助手</span></div><div className="markdown"><ReplyMarkdown text={item.text || ''} projectId={projectId}/></div></article>;
  if(item.type==='imageView')return <ReturnedImage value={(item as Item & {path:string}).path} projectId={projectId}/>;
  if(item.type==='commandExecution')return <details className="tool-item"><summary><Terminal size={14}/><span>{item.status==='inProgress'?'正在执行命令':'执行命令'}</span><small>{item.status==='completed'?'完成':item.status==='inProgress'?'运行中':item.status}</small><ChevronDown size={13}/></summary><pre>{item.command}</pre>{item.aggregatedOutput&&<pre className="tool-output">{item.aggregatedOutput}</pre>}</details>;
  if(item.type==='fileChange')return <details className="tool-item"><summary><FileText size={14}/><span>文件修改</span><ChevronDown size={13}/></summary><pre>{JSON.stringify(item.changes,null,2)}</pre></details>;
  return <div className="other-event"><Check size={13}/>{item.type}</div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
