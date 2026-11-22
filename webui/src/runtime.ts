export interface DesktopRuntime {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __EXM_CODE_RUNTIME__?: { baseUrl: string };
    __EXM_CODE_PLATFORM__?: "desktop" | "mobile";
    __TAURI__?: { core: DesktopRuntime };
  }
}

export function isDesktopClient(): boolean {
  return isTauriClient() && !isMobileClient();
}

export function isTauriClient(): boolean {
  return !!window.__TAURI__?.core;
}

export function isMobileClient(): boolean {
  return isTauriClient() && window.__EXM_CODE_PLATFORM__ === "mobile";
}

export async function initializeClient(): Promise<void> {
  if (!isTauriClient()) return;
  const { platform } = await desktopInvoke<{ platform: "desktop" | "mobile" }>("client_info");
  window.__EXM_CODE_PLATFORM__ = platform;
}

function stored(storage: Storage, key: string): string {
  try { return storage.getItem(key) || ""; } catch { return ""; }
}

export function normalizeServerUrl(value: string): string {
  if (!value.trim()) return "";
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址必须为 HTTPS（本机可用 HTTP），且不能包含账号、查询参数或片段。");
  }
  return url.href.replace(/\/+$/, "");
}

export function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI__?.core.invoke;
  if (!invoke) return Promise.reject(new Error("This operation requires the ExM Code desktop client."));
  return invoke<T>(command, args);
}

export function serverBaseUrl(): string {
  try {
    const explicit = localStorage.getItem("exm-code.server-url");
    if (explicit !== null) return explicit;
  } catch { /* Browser storage may be disabled. */ }
  return window.__EXM_CODE_RUNTIME__?.baseUrl?.replace(/\/$/, "")
    || (import.meta.env?.VITE_EXM_CODE_SERVER_URL as string | undefined)?.replace(/\/$/, "")
    || "";
}

export function serverAuthToken(): string {
  return stored(sessionStorage, `exm-code.server-token:${serverBaseUrl()}`);
}

export function saveServerConnection(baseUrl: string, token: string): void {
  const normalized = normalizeServerUrl(baseUrl);
  if (token && /[^\x21-\x7e]/.test(token.trim())) throw new Error("令牌不能包含空格或控制字符。");
  localStorage.setItem("exm-code.server-url", normalized);
  if (token.trim()) sessionStorage.setItem(`exm-code.server-token:${normalized}`, token.trim());
  else sessionStorage.removeItem(`exm-code.server-token:${normalized}`);
  sessionStorage.removeItem("exm-code.server-token");
}

export function disconnectServer(): void {
  sessionStorage.removeItem(`exm-code.server-token:${serverBaseUrl()}`);
  localStorage.removeItem("exm-code.server-url");
}

export async function pickDesktopWorkspace(): Promise<string | null> {
  if (!isDesktopClient()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "Open project folder" });
  if (typeof selected !== "string") return null;
  await desktopInvoke("select_workspace", { path: selected });
  return selected;
}
