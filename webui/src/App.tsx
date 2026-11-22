import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { EditorFile } from "./EditorDialog";
import {
  Alert, App as AntApp, Button, Checkbox, Dropdown, Input, Modal, Popover, Spin, Tooltip,
} from "antd";
import {
  ArrowDownOutlined, ArrowUpOutlined, BulbOutlined, CheckOutlined, CodeOutlined, DownOutlined,
  FileOutlined, FileTextOutlined, FolderOpenOutlined, FolderOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, PaperClipOutlined, PlusOutlined, RightOutlined, SearchOutlined,
  SettingOutlined, SlidersOutlined, StopOutlined, ThunderboltOutlined, MoreOutlined, CopyOutlined,
} from "@ant-design/icons";
import type { TextAreaRef } from "antd/es/input/TextArea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "./diff";
import { api, type FileEntry, type FileProposal, type Message, type Mode, type Session, type SessionUpdate, type Settings, type TaskProgress } from "./api";
import { humanSize, modes, sortedFiles, suggestions } from "./domain";
import { disconnectServer, isDesktopClient, saveServerConnection, serverAuthToken, serverBaseUrl } from "./runtime";

const modeIcons: Record<Mode, string> = { code: "⌘", plan: "☷", spec: "◇", goal: "◎" };
const EditorDialog = lazy(() => import("./EditorDialog"));

async function bootstrapWorkspace() {
  if (isDesktopClient() && !(await api.hasWorkspace())) {
    const selected = await api.selectWorkspace();
    if (!selected) throw new Error("首次使用请选择一个项目目录。你也可以稍后重试。");
  }
  const [settings, { sessions: existing }, { entries }] = await Promise.all([api.settings(), api.sessions(), api.listFiles()]);
  let first = existing.find((session) => !session.archived);
  const sessions = [...existing];
  if (!first) { first = await api.createSession("code"); sessions.unshift(first); }
  const { messages } = await api.messages(first.id);
  return { settings, sessions, entries, first, messages };
}

function ModePicker({ value, onChange }: { value: Mode; onChange: (mode: Mode) => void }) {
  return <div className="mode-picker" role="tablist" aria-label="任务工作流">
    {modes.map((mode) => <button type="button" key={mode.key} role="tab" aria-selected={value === mode.key} className={value === mode.key ? "selected" : ""} onClick={() => onChange(mode.key)}>
      <span className={`mode-glyph glyph-${mode.key}`}>{modeIcons[mode.key]}</span>{mode.label}
    </button>)}
  </div>;
}

function FileTree({ path, entries, expanded, onToggle, onOpen, level = 0 }: {
  path: string; entries: Record<string, FileEntry[]>; expanded: Set<string>; onToggle: (entry: FileEntry) => void; onOpen: (entry: FileEntry) => void; level?: number;
}) {
  const files = sortedFiles(entries[path] ?? []);
  return <div className="file-tree-list">
    {files.map((entry) => <div key={entry.path}>
      <button className="tree-entry" style={{ paddingLeft: 9 + level * 13 }} onClick={() => entry.isDir ? onToggle(entry) : onOpen(entry)} title={entry.path}>
        <span className="tree-chevron">{entry.isDir ? expanded.has(entry.path) ? <DownOutlined /> : <RightOutlined /> : null}</span>
        <span className={`tree-file-icon ${entry.isDir ? "folder" : ""}`}>{entry.isDir ? expanded.has(entry.path) ? <FolderOpenOutlined /> : <FolderOutlined /> : <FileOutlined />}</span>
        <span className="tree-entry-name" title={entry.isDir ? entry.path : `${entry.path} · ${humanSize(entry.size)}`}>{entry.name}</span>
        {!entry.isDir && entry.extension && <span className="tree-extension">{entry.extension}</span>}
      </button>
      {entry.isDir && expanded.has(entry.path) && <FileTree path={entry.path} entries={entries} expanded={expanded} onToggle={onToggle} onOpen={onOpen} level={level + 1} />}
    </div>)}
  </div>;
}

function SettingsDialog({ open, initial, onClose, onSave }: { open: boolean; initial: Settings | null; onClose: () => void; onSave: (next: Pick<Settings, "baseUrl" | "model"> & { apiKey: string; clearApiKey?: boolean }) => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  useEffect(() => { if (initial) { setBaseUrl(initial.baseUrl); setModel(initial.model); } setApiKey(""); setClearApiKey(false); setError(""); }, [initial, open]);
  const save = async () => {
    setSaving(true); setError("");
    try { await onSave({ baseUrl, model, apiKey, clearApiKey }); setApiKey(""); onClose(); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <Modal open={open} title={<span className="modal-title"><SlidersOutlined /> 模型与连接</span>} onCancel={onClose} footer={null} width={500} destroyOnHidden>
      <div className="settings-form">
      <p className="settings-copy">使用 OpenAI 兼容接口。密钥仅保存在 Agent 所在端的私有配置文件（桌面应用数据目录，或服务端 .exm-code）。配置文件未加密，请妥善保护，勿提交到版本控制。</p>
      <label>API Base URL<Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="url" /></label>
      <label>模型名称<Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1" /></label>
      <label>API Key<Input.Password value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={initial?.configured ? "同一地址留空保留；更换地址需重新填写" : "粘贴 API key"} autoComplete="new-password" /></label>
      <Checkbox checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)}>清除已保存的 API Key</Checkbox>
      {error && <Alert type="error" showIcon message={error} />}
      <div className="settings-actions"><span className="settings-local"><i />仅保存在 Agent Runtime 所在端</span><Button type="primary" loading={saving} onClick={() => void save()}>保存设置</Button></div>
    </div>
  </Modal>;
}

function ProposalCard({ proposal, onApply, onDismiss, applying }: { proposal: FileProposal; onApply: () => void; onDismiss: () => void; applying: boolean }) {
  const lines = useMemo(() => diffLines(proposal.baseContent, proposal.content), [proposal.baseContent, proposal.content]);
  const [expanded, setExpanded] = useState(false);
  return <section className="proposal-card">
    <header><span className="proposal-file"><FileTextOutlined /> {proposal.path}</span><span className="proposal-review"><i />待你审阅</span></header>
    <p>{proposal.reason}</p>
    <details className="proposal-preview"><summary>审阅文件差异 <span>+{lines.filter((line) => line.kind === "add").length} / −{lines.filter((line) => line.kind === "remove").length}</span></summary>
      <pre>{(expanded ? lines : lines.slice(0, 400)).map((line, index) => <span className={line.kind === "add" ? "diff-new" : line.kind === "remove" ? "diff-old" : "diff-same"} key={index}>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "} {line.text || " "}{"\n"}</span>)}</pre>
      {!expanded && lines.length > 400 && <Button size="small" onClick={() => setExpanded(true)}>显示其余 {lines.length - 400} 行</Button>}
    </details>
    <footer><span>应用前会再次检查文件是否发生变化</span><div><Button size="small" onClick={onDismiss}>忽略</Button><Button size="small" type="primary" icon={<CheckOutlined />} loading={applying} onClick={onApply}>审阅并应用</Button></div></footer>
  </section>;
}

function MessageView({ message, onApply, onDismiss, applyingPath }: { message: Message; onApply: (proposal: FileProposal) => void; onDismiss: (path: string) => void; applyingPath: string }) {
  const { message: toast } = AntApp.useApp();
  return <article className={`chat-message ${message.role}`}>
    <div className={`avatar ${message.role}`}>{message.role === "assistant" ? <span>ex</span> : "Y"}</div>
    <div className="message-content">
      <header><b>{message.role === "assistant" ? "ExM Code" : "你"}</b><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.role === "assistant" && <span className="message-model"><BulbOutlined /> assistant</span>}</header>
      {message.role === "assistant" ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div> : <p className="user-text">{message.content}</p>}
      {message.status && message.status !== "completed" && <span className="task-status">{message.status === "cancelled" ? "任务已取消" : "请求未完成"}</span>}
      <Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制消息" onClick={() => { void navigator.clipboard.writeText(message.content).then(() => toast.success("已复制")).catch(() => toast.error("无法访问剪贴板，请手动复制")); }}>复制</Button>
      {message.proposals?.map((proposal) => proposal.status === "pending" ? <ProposalCard key={proposal.id} proposal={proposal} applying={applyingPath === proposal.id} onApply={() => onApply(proposal)} onDismiss={() => onDismiss(proposal.id)} /> : <p className="resolved-proposal" key={proposal.id}>{proposal.status === "applied" ? "✓ 已应用" : "已忽略"} · {proposal.path}</p>)}
    </div>
  </article>;
}

export default function App() {
  const { message: toast, modal } = AntApp.useApp();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<Mode>("code");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [serverUrl, setServerUrl] = useState(() => serverBaseUrl());
  const [serverToken, setServerToken] = useState(() => serverAuthToken());
  const [serverOpen, setServerOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [files, setFiles] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 650);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 950);
  const [applyingPath, setApplyingPath] = useState("");
  const [fileError, setFileError] = useState("");
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [exported, setExported] = useState<{ title: string; markdown: string } | null>(null);
  const [progress, setProgress] = useState<TaskProgress[]>([]);
  const [projects, setProjects] = useState<{ name: string; path: string; available: boolean }[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [contentSearch, setContentSearch] = useState(false);
  const [contentMatches, setContentMatches] = useState<{ path: string; preview: string }[]>([]);
  const [editor, setEditor] = useState<EditorFile | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TextAreaRef>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bootstrapRef = useRef<ReturnType<typeof bootstrapWorkspace> | null>(null);
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  const active = sessions.find((session) => session.id === activeSession);
  const filteredSessions = useMemo(() => sessions.filter((session) => !!session.archived === showArchived && session.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt)), [sessions, filter, showArchived]);
  const rootFiles = files[""] ?? [];
  const fileCount = Object.values(files).reduce((sum, entries) => sum + entries.filter((item) => !item.isDir).length, 0);

  const loadWorkspace = useCallback(async () => {
    try {
      const [{ entries }, nextSettings] = await Promise.all([api.listFiles(), api.settings()]);
      setFiles({ "": entries }); setSettings(nextSettings); setFileError("");
    } catch (error) { setFileError(String(error)); }
  }, []);

  const openProject = async (path?: string) => {
    if (busy || applyingPath) { toast.info("请先停止任务或等待提案应用完成"); return; }
    try {
      const project = path ? await api.openWorkspace(path) : await api.selectWorkspace();
      if (!project) return;
      setProjectsOpen(false); setShowArchived(false); setProgress([]); setFilter(""); setDraft("");
      setEditor(null);
      abortRef.current?.abort(); abortRef.current = null;
      activeSessionRef.current = ""; setActiveSession("");
      setBusy(false); setMessages([]); setSelectedFile(null); setExpanded(new Set()); setFileSearch(""); setContentMatches([]); setFileError("");
      const [nextSettings, sessionResponse, fileResponse] = await Promise.all([api.settings(), api.sessions(), api.listFiles()]);
      setSettings(nextSettings); setSessions(sessionResponse.sessions); setFiles({ "": fileResponse.entries });
      const first = sessionResponse.sessions.find((session) => !session.archived);
      if (first) {
        activeSessionRef.current = first.id;
        setActiveSession(first.id); setMode(first.mode); setLoadingSession(true);
        await loadSession(first.id);
      } else {
        const session = await api.createSession("code");
        activeSessionRef.current = session.id; setSessions([session]); setActiveSession(session.id); setMode("code");
      }
    } catch (error) { toast.error(`无法打开项目：${String(error)}`); }
  };

  const loadSession = useCallback(async (id: string) => {
    try {
      const result = await api.messages(id);
      if (activeSessionRef.current === id) setMessages(result.messages);
    } catch (error) { if (activeSessionRef.current === id) toast.error(String(error)); }
    finally { if (activeSessionRef.current === id) setLoadingSession(false); }
  }, [toast]);

  const newTask = useCallback(async (nextMode: Mode = "code") => {
    try {
      abortRef.current?.abort(); abortRef.current = null; setBusy(false);
      setProgress([]); setShowArchived(false);
      const session = await api.createSession(nextMode);
      setLoadingSession(false);
      activeSessionRef.current = session.id;
      setSessions((current) => [session, ...current]); setActiveSession(session.id); setMessages([]); setMode(nextMode); setSelectedFile(null); setDraft("");
      inputRef.current?.focus();
    } catch (error) { toast.error(`无法创建任务：${String(error)}`); }
  }, [toast]);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); void newTask(mode); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [mode, newTask]);

  useEffect(() => {
    const query = fileSearch.trim();
    if (!query) { setSearchResults(null); setSearchingFiles(false); return; }
    let cancelled = false;
    setSearchingFiles(true);
    const timer = window.setTimeout(() => {
      if (contentSearch) {
        void api.searchContent(query).then(({ matches }) => { if (!cancelled) { setContentMatches(matches); setFileError(""); } })
          .catch((error: unknown) => { if (!cancelled) { setContentMatches([]); setFileError(String(error)); } })
          .finally(() => { if (!cancelled) setSearchingFiles(false); });
        return;
      }
      void api.searchFiles(query).then(({ entries }) => {
        if (!cancelled) { setSearchResults(entries); setFileError(""); }
      }).catch((error: unknown) => {
        if (!cancelled) { setSearchResults([]); setFileError(String(error)); }
      }).finally(() => { if (!cancelled) setSearchingFiles(false); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [fileSearch, contentSearch]);

  useEffect(() => {
    let cancelled = false;
    bootstrapRef.current ??= bootstrapWorkspace();
    void bootstrapRef.current.then(({ settings, sessions, entries, first, messages }) => {
      if (cancelled) return;
      setSettings(settings); setSessions(sessions); setFiles({ "": entries });
      activeSessionRef.current = first.id; setActiveSession(first.id); setMode(first.mode); setMessages(messages);
    }).catch((error: unknown) => { if (!cancelled) setBootError(String(error)); })
      .finally(() => { if (!cancelled) setBooting(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const selectSession = (session: Session) => {
    if (session.id === activeSessionRef.current) return;
    abortRef.current?.abort(); abortRef.current = null; setBusy(false);
    setProgress([]);
    setEditor(null);
    activeSessionRef.current = session.id;
    setLoadingSession(true); setMessages([]); setDraft("");
    setActiveSession(session.id); setMode(session.mode); setSelectedFile(null); void loadSession(session.id);
  };

  const toggleFolder = async (entry: FileEntry) => {
    const isOpen = expanded.has(entry.path);
    if (isOpen) { setExpanded((current) => { const next = new Set(current); next.delete(entry.path); return next; }); return; }
    setExpanded((current) => new Set(current).add(entry.path));
    if (!files[entry.path]) {
      try { const { entries } = await api.listFiles(entry.path); setFiles((current) => ({ ...current, [entry.path]: entries })); }
      catch (error) { toast.error(String(error)); }
    }
  };

  const openFile = async (entry: FileEntry) => {
    try { const file = await api.readFile(entry.path); setSelectedFile(file); setFileError(""); }
    catch (error) { setFileError(String(error)); toast.error(`无法打开文件：${String(error)}`); }
  };

  const openSearchResult = async (entry: FileEntry) => {
    if (!entry.isDir) { await openFile(entry); return; }
    setFileSearch("");
    setExpanded((current) => new Set(current).add(entry.path));
    if (!files[entry.path]) {
      try { const { entries } = await api.listFiles(entry.path); setFiles((current) => ({ ...current, [entry.path]: entries })); }
      catch (error) { toast.error(String(error)); }
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    const targetSession = activeSession;
    const targetMode = mode;
    if (!prompt || loadingSession || abortRef.current || !targetSession || active?.archived) return;
    if (!settings?.configured) { setSettingsOpen(true); return; }
    setDraft(""); setBusy(true); setProgress([]);
    const controller = new AbortController(); abortRef.current = controller;
    const userMessage: Message = { role: "user", content: prompt, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, userMessage]);
    try {
      const reply = await api.chat(targetSession, targetMode, prompt, selectedFile?.path, controller.signal, (event) => {
        if (activeSessionRef.current === targetSession && !controller.signal.aborted) setProgress((current) => [...current.slice(-79), event]);
      });
      const assistant: Message = { role: "assistant", content: reply.content, proposals: reply.proposals, createdAt: new Date().toISOString() };
      if (activeSessionRef.current === targetSession) setMessages((current) => [...current, assistant]);
      setSessions((current) => current.map((session) => session.id === targetSession ? { ...session, title: session.title === "New task" ? prompt.slice(0, 52) : session.title, mode: targetMode, updatedAt: assistant.createdAt } : session).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch (error) {
      if (controller.signal.aborted) {
        if (activeSessionRef.current === targetSession) setMessages((current) => [...current, { role: "assistant", content: "任务已取消。", status: "cancelled", createdAt: new Date().toISOString() }]);
        return;
      }
      const text = String(error);
      if (text.toLowerCase().includes("exm_code_api_key")) setSettingsOpen(true);
      if (activeSessionRef.current === targetSession) { setDraft(prompt); setMessages((current) => [...current, { role: "assistant", content: text, status: "error", createdAt: new Date().toISOString() }]); }
    } finally { if (abortRef.current === controller) { abortRef.current = null; if (activeSessionRef.current === targetSession) setBusy(false); } }
  };

  const decideProposal = async (id: string, proposal?: FileProposal) => {
    if (applyingPath) return;
    const session = activeSessionRef.current;
    setApplyingPath(id);
    try {
      if (proposal) await api.applyFile(proposal);
      else await api.dismissProposal(id);
      const status = proposal ? "applied" : "dismissed";
      if (activeSessionRef.current === session) {
        setMessages((current) => current.map((item) => ({ ...item, proposals: item.proposals?.map((entry) => entry.id === id ? { ...entry, status } : entry) })));
      }
      if (proposal) { toast.success(`已更新 ${proposal.path}`); await loadWorkspace(); }
    } catch (error) { toast.error(`提案状态未更新：${String(error)}`); }
    finally { setApplyingPath(""); }
  };

  const saveSettings = async (next: Pick<Settings, "baseUrl" | "model"> & { apiKey: string; clearApiKey?: boolean }) => {
    const result = await api.saveSettings(next); setSettings((current) => current ? { ...current, ...result } : null); toast.success("设置已保存在本机");
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  const chooseMode = (nextMode: Mode) => {
    if (busy) return;
    const previous = mode;
    setMode(nextMode);
    if (activeSession) {
      setSessions((current) => current.map((item) => item.id === activeSession ? { ...item, mode: nextMode } : item));
      void api.updateSession(activeSession, nextMode).catch((error) => { setMode(previous); toast.error(String(error)); });
    }
  };

  const updateTask = async (session: Session, update: SessionUpdate) => {
    try {
      const next = await api.updateSession(session.id, update);
      setSessions((current) => current.map((entry) => entry.id === next.id ? next : entry));
      if (next.id === activeSessionRef.current) setMode(next.mode);
      setRenaming(null);
    } catch (error) { toast.error(String(error)); }
  };

  const deleteTask = (session: Session) => {
    modal.confirm({ title: "删除任务？", content: `将永久删除“${session.title}”的对话和未应用提案，不会撤销已应用的文件改动。`, okText: "删除", okButtonProps: { danger: true }, cancelText: "取消", onOk: async () => {
      await api.deleteSession(session.id);
      setSessions((current) => current.filter((entry) => entry.id !== session.id));
      if (activeSessionRef.current === session.id) { activeSessionRef.current = ""; setActiveSession(""); setMessages([]); await newTask(mode); }
    } });
  };

  const connectServer = () => {
    try { saveServerConnection(serverUrl, serverToken); window.location.reload(); }
    catch (error) { toast.error(String(error)); }
  };

  if (booting) return <main className="boot-screen"><div className="brand-mark">ex</div><Spin /><p>正在打开 ExM Code…</p></main>;

  if (bootError) return <main className="boot-screen">
    <div className="brand-mark">ex</div><h1>{isDesktopClient() ? "无法打开项目" : "无法连接 Agent 服务"}</h1><p>{bootError}</p>
    {isDesktopClient() ? <Button type="primary" onClick={() => { void api.selectWorkspace().then((workspace) => { if (workspace) window.location.reload(); }).catch((error) => toast.error(String(error))); }}>选择项目目录</Button> : <div className="settings-form server-connect-form">
      <label>Agent API URL<Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://agent.example.com" autoComplete="url" /></label>
      <label>访问令牌<Input.Password value={serverToken} onChange={(event) => setServerToken(event.target.value)} placeholder="Bearer token" autoComplete="current-password" /></label>
      <Button type="primary" onClick={connectServer}>保存并连接</Button>
    </div>}
    <Button onClick={() => window.location.reload()}>重试</Button>
    <small>{isDesktopClient() ? "桌面端在本机运行 Agent；请选择要处理的项目目录。" : "Web 客户端需要连接已部署的 ExM Code API 服务。令牌只保存在当前浏览器会话中。"}</small>
  </main>;

  return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${rightOpen ? "inspector-open" : "inspector-closed"}`}>
      <header className="topbar">
        <div className="top-brand"><div className="brand-mark">ex</div><span className="brand-name">exm<span>code</span></span><span className="brand-version">0.1</span></div>
        <div className="top-project"><span className="top-project-dot" /><span>{settings?.workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"}</span><span className="top-project-branch"><FolderOutlined /> {isDesktopClient() ? "device" : "server"}</span></div>
         <div className="top-spacer" />
         {isDesktopClient() && <Tooltip title="打开项目"><Button type="text" className="top-icon" aria-label="打开项目" disabled={busy || !!applyingPath} icon={<FolderOpenOutlined />} onClick={() => { void api.recentProjects().then(({ projects: recent }) => { setProjects(recent); setProjectsOpen(true); }).catch((error) => toast.error(String(error))); }} /></Tooltip>}
         {!isDesktopClient() && <Button type="text" className="top-icon" onClick={() => setServerOpen(true)}>连接</Button>}
        <div className={`connection ${settings?.configured ? "connected" : "disconnected"}`}><i />{settings?.configured ? <><span>{settings.model}</span><span className="connection-ok">ready</span></> : <button onClick={() => setSettingsOpen(true)}>配置模型</button>}</div>
        <Tooltip title="模型设置"><Button type="text" className="top-icon" aria-label="模型设置" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} /></Tooltip>
        <div className="top-avatar">N</div>
      </header>

      <aside className="left-sidebar">
        <div className="sidebar-workspace"><span className="workspace-icon"><CodeOutlined /></span><span><b>工作区</b><small>{settings?.workspace || "未连接"}</small></span><button className="icon-button" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><MenuFoldOutlined /></button></div>
        <Button block className="new-task-button" icon={<PlusOutlined />} onClick={() => void newTask(mode)}>新建任务 <kbd>⌘ K</kbd></Button>
        <label className="search-box"><SearchOutlined /><input ref={searchRef} aria-label="搜索任务" placeholder="搜索任务..." value={filter} onChange={(event) => setFilter(event.target.value)} /><kbd>⌘ F</kbd></label>
        <div className="sidebar-section"><span>{showArchived ? "已归档任务" : "最近任务"}</span><Button size="small" type="text" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "返回最近" : "已归档"}</Button></div>
        <nav className="session-list" aria-label="最近任务">
          {filteredSessions.map((session) => <div className="session-row" key={session.id}><button className={`session-item ${session.id === activeSession ? "active" : ""}`} onClick={() => selectSession(session)}>
            <span className={`session-mode-icon ${session.mode}`}>{modeIcons[session.mode]}</span><span className="session-title">{session.pinned ? "↑ " : ""}{session.title || "未命名任务"}</span>{session.id === activeSession && <span className="session-active-dot" />}
          </button><Dropdown trigger={["click"]} menu={{ items: [
            { key: "rename", label: "重命名" }, { key: "pin", label: session.pinned ? "取消置顶" : "置顶" },
            { key: "archive", label: session.archived ? "恢复任务" : "归档" }, { key: "export", label: "导出 Markdown" },
            { key: "delete", label: "删除", danger: true, disabled: busy && session.id === activeSession },
          ], onClick: ({ key }) => {
            if (key === "rename") { setRenaming(session); setRenameTitle(session.title); }
            if (key === "pin") void updateTask(session, { pinned: !session.pinned });
            if (key === "archive") void updateTask(session, { archived: !session.archived });
            if (key === "export") void api.exportSession(session.id).then(setExported).catch((error) => toast.error(String(error)));
            if (key === "delete") deleteTask(session);
          } }}><button className="session-more icon-button" aria-label={`管理任务 ${session.title}`}><MoreOutlined /></button></Dropdown></div>)}
          {!filteredSessions.length && <p className="sidebar-empty">没有找到任务</p>}
        </nav>
        <div className="sidebar-bottom"><button onClick={() => setSettingsOpen(true)}><SettingOutlined /> 设置与模型</button><div className="user-profile"><div className="user-avatar">N</div><span><b>{isDesktopClient() ? "本地工作区" : "Agent 工作区"}</b><small>{isDesktopClient() ? "仅此设备" : "服务器连接"}</small></span><span className="more-dots">···</span></div></div>
      </aside>

      {!sidebarOpen && <button className="reopen-sidebar" onClick={() => setSidebarOpen(true)} aria-label="展开侧栏"><MenuUnfoldOutlined /></button>}

      <main className="main-area">
        <div className="taskbar">
          <div className="breadcrumb"><span className="crumb-project">{settings?.workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"}</span><RightOutlined /><span className="crumb-active">{active?.title || "新任务"}</span></div>
          <div className="taskbar-actions"><span className="safe-badge"><span />改动需审阅</span><Tooltip title="工作区文件"><Button aria-label="切换文件面板" type="text" className="top-icon" icon={<FolderOpenOutlined />} onClick={() => setRightOpen((open) => !open)} /></Tooltip><span className="task-count">{sessions.length} 个任务</span></div>
        </div>

        <section className={`conversation ${messages.length ? "has-messages" : "welcome"}`} ref={scrollRef}>
          {!messages.length ? <div className="welcome-card">
            <div className="welcome-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-center"><CodeOutlined /></div><i className="orbit-spark spark-one">✳</i><i className="orbit-spark spark-two">·</i><i className="orbit-spark spark-three">✳</i></div>
            <span className="welcome-eyebrow"><i /> LOCAL-FIRST CODING AGENT <i /></span>
            <h1>把想法，变成<span>可交付的代码。</span></h1>
            <p className="welcome-subtitle">从目标到规格，从计划到实现。每一步都在你的工作区里。</p>
            <ModePicker value={mode} onChange={chooseMode} />
            <div className="starter-grid">
              {suggestions[mode].map((suggestion, index) => <button key={suggestion} onClick={() => { setDraft(suggestion); inputRef.current?.focus(); }}><span className={`starter-icon starter-${index}`}><BulbOutlined /></span><span>{suggestion}</span><ArrowUpOutlined /></button>)}
            </div>
            <div className="welcome-foot"><span>开始前从 <b>Goal</b> 定义成功，再用 <b>Spec</b> 和 <b>Plan</b> 把路走清楚。</span><span><kbd>⌘</kbd> <kbd>Enter</kbd> 发送</span></div>
          </div> : <div className="message-stream">
            <div className="stream-intro"><span className="stream-line" /><span>{active?.title || "当前任务"}</span><span className="stream-line" /></div>
            {messages.map((item, index) => <MessageView key={`${item.createdAt}-${index}`} message={item} onApply={(proposal) => void decideProposal(proposal.id, proposal)} onDismiss={(id) => void decideProposal(id)} applyingPath={applyingPath} />)}
            {!!progress.length && <details className="task-progress" open={busy}><summary>{busy ? "Agent 正在运行" : "本次执行记录"} · {progress.filter((event) => event.type === "toolFinished").length} 次工具调用</summary><ol>{progress.map((event, index) => <li key={index}>{event.type === "modelRequest" ? `模型推理 · 第 ${event.round} 轮` : event.type === "toolStarted" ? `${event.name} ${event.target || ""}` : `${event.success ? "✓" : "✕"} ${event.name}`}</li>)}</ol></details>}
            {busy && <div className="assistant-thinking" role="status"><div className="avatar assistant"><span>ex</span></div><div><div className="thinking-dots"><i /><i /><i /></div><span>{progress.at(-1)?.type === "toolStarted" ? `正在执行 ${progress.at(-1)?.name}…` : "正在研究工作区..."}</span></div></div>}
          </div>}
        </section>

        <div className="composer-wrap">
          {active?.archived && <Alert type="info" message="此任务已归档，恢复后可继续对话。" action={<Button size="small" onClick={() => void updateTask(active, { archived: false })}>恢复任务</Button>} />}
          {!settings?.configured && <button className="model-notice" onClick={() => setSettingsOpen(true)}><span className="notice-pulse" /><span>还差一步：连接模型后即可开始</span><b>配置模型 <ArrowDownOutlined /></b></button>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            {selectedFile && <div className="attached-context"><FileOutlined /><span>{selectedFile.path}</span><span>已在工作区上下文中</span><button type="button" aria-label="移除已选文件" onClick={() => setSelectedFile(null)}>×</button></div>}
            <Input.TextArea ref={inputRef} value={draft} disabled={!!active?.archived} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKey} placeholder={mode === "code" ? "描述你要构建、调试或理解的内容…" : `在 ${mode.toUpperCase()} 模式下描述你的想法…`} autoSize={{ minRows: 2, maxRows: 7 }} aria-label="编程任务输入" />
          <div className="composer-toolbar">
              <div className="composer-left"><ModePicker value={mode} onChange={chooseMode} /><Tooltip title="浏览文件并选择上下文"><Button type="text" icon={<PaperClipOutlined />} onClick={() => setRightOpen(true)}>添加上下文</Button></Tooltip></div>
              <div className="composer-right"><span className="composer-hint">Shift + Enter 换行</span>{busy ? <Button className="send-button stop-button" aria-label="停止任务" icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>停止任务</Button> : <Button className="send-button" type="primary" icon={<ArrowUpOutlined />} disabled={!draft.trim() || loadingSession || !!active?.archived} htmlType="submit">发送</Button>}</div>
            </div>
          </form>
          <div className="composer-disclaimer">ExM Code 可能会出错。应用更改前请审阅提案。<span><ThunderboltOutlined /> 由你的模型驱动</span></div>
        </div>
      </main>

      <aside className="right-sidebar">
        <div className="inspector-tabs"><button className="inspector-tab active"><FolderOutlined /> 文件</button><button className="inspector-tab" onClick={() => setSettingsOpen(true)}><SlidersOutlined /> 上下文</button><button className="icon-button inspector-collapse" aria-label="收起文件栏" onClick={() => setRightOpen(false)}><MenuUnfoldOutlined /></button></div>
        <div className="project-title"><div className="project-symbol"><CodeOutlined /></div><div><b>{settings?.workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"}</b><small>{rootFiles.length} 项目文件</small></div><Popover content={<div className="project-popover"><b>工作区目录</b><code>{settings?.workspace}</code><span>从启动服务的目录载入。</span></div>} trigger="click"><button className="more-dots" aria-label="项目详情">···</button></Popover></div>
        <label className="file-search"><SearchOutlined /><input placeholder="查找文件..." value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} /></label>
        <div className="file-search-options"><Checkbox checked={contentSearch} onChange={(event) => setContentSearch(event.target.checked)}>搜索文件内容</Checkbox><Button size="small" type="text" aria-label="新建文件提案" disabled={busy || mode !== "code" || !!active?.archived} icon={<PlusOutlined />} onClick={() => setEditor({ path: "", content: "", baseExists: false, sessionId: activeSession })} /><Button size="small" type="text" onClick={() => void loadWorkspace()}>刷新</Button></div>
        <div className="file-explorer">
          {fileError && <Alert type="error" showIcon message="无法读取工作区" description={fileError} />}
          {fileSearch.trim() ? searchingFiles ? <div className="file-empty"><Spin size="small" /><span>搜索中…</span></div> : contentSearch ? <div className="file-tree-list">{contentMatches.map((entry, index) => <button className="content-match" key={`${entry.path}-${index}`} onClick={() => void openFile({ name: entry.path, path: entry.path, isDir: false, size: 0 })}><b>{entry.path}</b><small>{entry.preview}</small></button>)}{!contentMatches.length && <p className="file-empty">没有匹配的内容</p>}</div> : searchResults?.length ? <div className="file-tree-list">{searchResults.map((entry) => <button className="tree-entry search-result" key={entry.path} onClick={() => void openSearchResult(entry)} title={entry.path}><span className={`tree-file-icon ${entry.isDir ? "folder" : ""}`}>{entry.isDir ? <FolderOutlined /> : <FileOutlined />}</span><span className="tree-entry-name">{entry.path}</span></button>)}</div> : <div className="file-empty"><SearchOutlined /><span>没有匹配的文件</span></div> : rootFiles.length ? <FileTree path="" entries={files} expanded={expanded} onToggle={(entry) => void toggleFolder(entry)} onOpen={(entry) => void openFile(entry)} /> : !fileError ? <div className="file-empty"><FolderOutlined /><span>此工作区暂无文件</span></div> : null}
        </div>
        {selectedFile ? <div className="file-preview"><header><span><FileTextOutlined /> {selectedFile.path.split("/").pop()}</span><button onClick={() => setSelectedFile(null)}>×</button></header><pre>{selectedFile.content.split("\n").slice(0, 80).map((line, index) => <span key={index}><i>{index + 1}</i>{line || " "}{"\n"}</span>)}{selectedFile.content.split("\n").length > 80 && "…"}</pre><footer><Button size="small" disabled={busy || mode !== "code" || !!active?.archived} onClick={() => setEditor({ ...selectedFile, baseExists: true, sessionId: activeSession })}>编辑</Button><Button size="small" onClick={() => { setDraft((value) => `${value}${value ? "\n" : ""}Review ${selectedFile.path}`); inputRef.current?.focus(); }}>提问此文件 <ArrowUpOutlined /></Button></footer></div> : <div className="inspector-bottom"><div className="inspector-card"><div className="inspector-card-head"><span><BulbOutlined /> WORKFLOW</span><span className="flow-live">LIVE</span></div><div className="workflow-rail">{[
          ["01", "Goal", "界定结果"], ["02", "Spec", "明确边界"], ["03", "Plan", "拆解步骤"], ["04", "Code", "审阅交付"],
        ].map(([number, name, detail]) => {
          const flowMode = ["goal", "spec", "plan", "code"] as const;
          const currentIndex = flowMode.indexOf(mode);
          const stepIndex = flowMode.indexOf(name.toLowerCase() as Mode);
          return <button type="button" key={name} className={`workflow-step ${mode === name.toLowerCase() ? "current" : ""} ${stepIndex < currentIndex ? "done" : ""}`} onClick={() => chooseMode(name.toLowerCase() as Mode)}><span className="step-number">{number}</span><span className="step-name">{name}<small>{detail}</small></span>{stepIndex < currentIndex ? <CheckOutlined /> : null}</button>;
        })}</div><p>可随时切换工作方式，不锁定工作流。</p></div><div className="workspace-status"><span><i />工作区已就绪</span><span>{fileCount} 个文件</span></div></div>}
      </aside>

      {!rightOpen && <button className="reopen-inspector" onClick={() => setRightOpen(true)} aria-label="展开文件栏"><FolderOpenOutlined /></button>}
      <SettingsDialog open={settingsOpen} initial={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />
      {!isDesktopClient() && <Modal open={serverOpen} title="连接 Agent 服务" onCancel={() => setServerOpen(false)} footer={<><Button onClick={() => { disconnectServer(); window.location.reload(); }}>断开并清除令牌</Button><Button type="primary" onClick={connectServer}>保存并重连</Button></>}>
        <div className="settings-form server-connect-form">
          <label>Agent API URL<Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://agent.example.com" autoComplete="url" /></label>
          <label>访问令牌<Input.Password value={serverToken} onChange={(event) => setServerToken(event.target.value)} placeholder="Bearer token" autoComplete="current-password" /></label>
        </div>
      </Modal>}
      <Modal open={!!renaming} title="重命名任务" okText="保存" cancelText="取消" onCancel={() => setRenaming(null)} onOk={() => { if (renaming) void updateTask(renaming, { title: renameTitle }); }}>
        <Input value={renameTitle} maxLength={120} aria-label="任务名称" onChange={(event) => setRenameTitle(event.target.value)} onPressEnter={() => { if (renaming) void updateTask(renaming, { title: renameTitle }); }} />
      </Modal>
      <Modal open={!!exported} title={`导出 · ${exported?.title || ""}`} onCancel={() => setExported(null)} footer={<Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(exported?.markdown || "").then(() => toast.success("已复制 Markdown")).catch(() => toast.info("请在文本框中手动全选并复制")); }}>复制 Markdown</Button>}>
        <Input.TextArea readOnly value={exported?.markdown} autoSize={{ minRows: 12, maxRows: 24 }} aria-label="导出的 Markdown" />
      </Modal>
      <Modal open={projectsOpen} title="打开项目" onCancel={() => setProjectsOpen(false)} footer={<Button type="primary" icon={<FolderOpenOutlined />} onClick={() => void openProject()}>浏览项目目录</Button>}>
        <div className="recent-projects">{projects.map((project) => <Button key={project.path} disabled={!project.available} onClick={() => void openProject(project.path)}><span>{project.name}<small>{project.path}{!project.available ? "（目录不可用）" : ""}</small></span></Button>)}{!projects.length && <p>尚无最近项目，请选择一个目录。</p>}</div>
      </Modal>
      {editor && <Suspense fallback={<Spin fullscreen />}><EditorDialog file={editor} onClose={() => setEditor(null)} onStaged={async (id) => { if (activeSessionRef.current === id) await loadSession(id); toast.success("提案已生成，尚未写入文件"); }} /></Suspense>}
    </div>;
}
