export type Mode = "code" | "plan" | "spec" | "goal";

export interface Session {
  id: string;
  title: string;
  mode: Mode;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  extension?: string;
}

export interface FileProposal {
  id: string;
  path: string;
  content: string;
  reason: string;
  baseContent: string;
  baseExists: boolean;
  status: "pending" | "applied" | "dismissed";
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  proposals?: FileProposal[];
  createdAt: string;
  status?: "completed" | "cancelled" | "error";
}

export interface Settings {
  baseUrl: string;
  model: string;
  configured: boolean;
  workspace: string;
}

import { desktopInvoke, isDesktopClient, pickDesktopWorkspace, serverAuthToken, serverBaseUrl } from "./runtime.ts";
import { readEventStream } from "./stream.ts";

export type SessionUpdate = Partial<Pick<Session, "title" | "mode" | "pinned" | "archived">>;
export interface TaskProgress {
  requestId: string;
  sessionId: string;
  type: "modelRequest" | "toolStarted" | "toolFinished";
  round?: number;
  name?: string;
  target?: string;
  success?: boolean;
}
export interface AgentReply { content: string; model: string; proposals: FileProposal[] }

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== "string") return {};
  try { return JSON.parse(init.body) as Record<string, unknown>; } catch { return {}; }
}

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = new URL(path, "http://exm-code.desktop");
  const body = bodyOf(init);
  const method = init?.method?.toUpperCase() || "GET";
  const command = (name: string, args?: Record<string, unknown>) => desktopInvoke<T>(name, args);
  if (url.pathname === "/api/settings" && method === "GET") return command("get_settings");
  if (url.pathname === "/api/settings" && method === "PUT") return command("save_settings", { input: body });
  if (url.pathname === "/api/workspace") return command("workspace_info");
  if (url.pathname === "/api/files") return command("list_files", { path: url.searchParams.get("path") || "" });
  if (url.pathname === "/api/files/search") return command("search_files", { query: url.searchParams.get("query") || "" });
  if (url.pathname === "/api/files/content-search") return command("search_content", { query: url.searchParams.get("query") || "" });
  if (url.pathname === "/api/file") return command("read_file", { path: url.searchParams.get("path") || "" });
  if (url.pathname === "/api/files/apply") return command("apply_proposal", { proposalId: body.proposalId });
  if (url.pathname === "/api/proposals/dismiss") return command("dismiss_proposal", { proposalId: body.proposalId });
  if (url.pathname === "/api/proposals/manual") return command("stage_edit", { input: body });
  if (url.pathname === "/api/sessions" && method === "GET") return command("list_sessions");
  if (url.pathname === "/api/sessions" && method === "POST") return command("create_session", { mode: body.mode || "code" });
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "PUT") return command("update_session", { id: decodeURIComponent(sessionMatch[1]), input: body });
  if (sessionMatch && method === "DELETE") return command("delete_session", { id: decodeURIComponent(sessionMatch[1]) });
  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch) return command("list_messages", { id: decodeURIComponent(messagesMatch[1]) });
  const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (exportMatch) return command("export_session", { id: decodeURIComponent(exportMatch[1]) });
  if (url.pathname === "/api/tasks") return command("active_tasks");
  const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancelMatch) return command("cancel_chat", { requestId: decodeURIComponent(cancelMatch[1]) });
  throw new Error(`Unsupported desktop operation: ${method} ${url.pathname}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (isDesktopClient()) return desktopRequest<T>(path, init);
  const response = await httpRequest(path, init);
  return response.json() as Promise<T>;
}

async function httpRequest(path: string, init?: RequestInit): Promise<Response> {
  const base = serverBaseUrl();
  const token = serverAuthToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers },
    signal: init?.signal,
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      detail = parsed.error || parsed.message || text;
    } catch { /* Non-JSON API errors are plain text. */ }
    throw new Error(detail || response.statusText);
  }
  return response;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Pick<Settings, "baseUrl" | "model"> & { apiKey: string; clearApiKey?: boolean }) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  workspace: () => request<{ root: string; name: string }>("/api/workspace"),
  hasWorkspace: () => desktopInvoke<boolean>("has_workspace"),
  listFiles: (path = "") => request<{ entries: FileEntry[] }>(`/api/files?path=${encodeURIComponent(path)}`),
  searchFiles: (query: string) => request<{ entries: FileEntry[] }>(`/api/files/search?query=${encodeURIComponent(query)}`),
  searchContent: (query: string) => request<{ matches: { path: string; preview: string }[] }>(`/api/files/content-search?query=${encodeURIComponent(query)}`),
  readFile: (path: string) => request<{ path: string; content: string }>(`/api/file?path=${encodeURIComponent(path)}`),
  applyFile: (proposal: FileProposal) => request<{ ok: boolean; path: string }>("/api/files/apply", json({ proposalId: proposal.id })),
  dismissProposal: (id: string) => request<{ ok: boolean; path: string }>("/api/proposals/dismiss", json({ proposalId: id })),
  stageEdit: (input: { sessionId: string; path: string; content: string; baseContent: string; baseExists: boolean }) => request<{ ok: boolean; proposal: FileProposal }>("/api/proposals/manual", json(input)),
  sessions: () => request<{ sessions: Session[] }>("/api/sessions"),
  createSession: (mode: Mode = "code") => request<Session>("/api/sessions", json({ mode })),
  messages: (id: string) => request<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`),
  chat: async (sessionId: string, mode: Mode, message: string, contextPath?: string, signal?: AbortSignal, onProgress: (event: TaskProgress) => void = () => {}) => {
    signal?.throwIfAborted();
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cancel = () => { void api.cancelTask(requestId).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (isDesktopClient()) {
        const { Channel } = await import("@tauri-apps/api/core");
        signal?.throwIfAborted();
        const channel = new Channel<TaskProgress>();
        channel.onmessage = (event) => { if (!signal?.aborted) onProgress(event); };
        const reply = await desktopInvoke<AgentReply>("chat", { requestId, sessionId, mode, message, contextPath, onEvent: channel });
        signal?.throwIfAborted();
        return reply;
      }
      const response = await httpRequest("/api/chat/stream", { ...json({ requestId, sessionId, mode, message, contextPath }), signal, headers: { Accept: "text/event-stream" } });
      return await readEventStream<AgentReply, TaskProgress>(response, onProgress);
    } finally { signal?.removeEventListener("abort", cancel); }
  },
  cancelTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, json({})),
  activeTasks: () => request<{ tasks: { requestId: string; sessionId: string }[] }>("/api/tasks"),
  updateSession: (id: string, update: Mode | SessionUpdate) => request<Session>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(typeof update === "string" ? { mode: update } : update) }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  exportSession: (id: string) => request<{ title: string; markdown: string }>(`/api/sessions/${encodeURIComponent(id)}/export`),
  recentProjects: () => desktopInvoke<{ projects: { name: string; path: string; available: boolean }[] }>("recent_projects"),
  openWorkspace: (path: string) => desktopInvoke("select_workspace", { path }),
  selectWorkspace: async () => {
    const selected = await pickDesktopWorkspace();
    if (!selected) return null;
    return api.workspace();
  },
};
