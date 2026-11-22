import assert from "node:assert/strict";
import { test } from "node:test";
import { isDesktopClient, normalizeServerUrl, saveServerConnection, serverAuthToken } from "./runtime.ts";

test("connection URL validation protects credentials and requires HTTPS remotely", () => {
  assert.equal(normalizeServerUrl(" https://agent.example.com/prefix/ "), "https://agent.example.com/prefix");
  assert.equal(normalizeServerUrl("http://127.0.0.1:4180/"), "http://127.0.0.1:4180");
  for (const value of ["http://agent.example.com", "https://user:password@agent.example.com", "https://agent.example.com?token=secret", "https://agent.example.com#hash", "javascript:alert(1)"]) {
    assert.throws(() => normalizeServerUrl(value));
  }
});

test("server tokens are scoped by server and not reused after switching", () => {
  const local = new Map<string, string>(), session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) || null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) });
  Object.assign(globalThis, { window: {}, localStorage: storage(local), sessionStorage: storage(session) });
  saveServerConnection("https://one.example", "secret-one");
  assert.equal(serverAuthToken(), "secret-one");
  saveServerConnection("https://two.example", "");
  assert.equal(serverAuthToken(), "");
  saveServerConnection("https://one.example", "secret-one");
  assert.equal(serverAuthToken(), "secret-one");
});

test("small touch-screen desktop stays desktop when native platform says desktop", () => {
  Object.assign(globalThis, { window: { __TAURI__: { core: {} }, __EXM_CODE_PLATFORM__: "desktop" } });
  assert.equal(isDesktopClient(), true);
});
