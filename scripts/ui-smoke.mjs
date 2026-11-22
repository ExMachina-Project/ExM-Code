import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const port = Number(process.env.EXM_CODE_UI_PORT || 5174);
const webuiDir = fileURLToPath(new URL("../webui/", import.meta.url));
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1"], {
  cwd: webuiDir,
  stdio: "ignore",
  env: { ...process.env, EXM_CODE_UI_PORT: String(port) },
});
let browser;

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited with status ${server.exitCode}`);
    try { ready = (await fetch(`http://127.0.0.1:${port}`)).ok; } catch { /* Wait for Vite to bind. */ }
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw new Error("Vite did not start within 15 seconds.");

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const session = { id: "smoke-session", title: "New task", mode: "code", updatedAt: new Date().toISOString() };

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    let body;
    if (pathname === "/api/settings") body = { baseUrl: "http://127.0.0.1:11434/v1", model: "local-smoke-model", configured: true, workspace: "/tmp/exm-code-smoke" };
    else if (pathname === "/api/sessions" && route.request().method() === "GET") body = { sessions: [session] };
    else if (pathname === "/api/sessions/smoke-session/messages") body = { messages: [] };
    else if (pathname === "/api/sessions/smoke-session" && route.request().method() === "PUT") body = session;
    else if (pathname === "/api/files") body = { entries: [{ name: "src", path: "src", isDir: true, size: 0 }, { name: "Cargo.toml", path: "Cargo.toml", isDir: false, size: 120, extension: "toml" }] };
    else if (pathname === "/api/chat/stream") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "progress", progress: { type: "modelRequest", round: 1 } })}\n\ndata: ${JSON.stringify({ type: "done", reply: { content: "## Goal\n\nA focused smoke test passed.", model: "local-smoke-model", proposals: [] } })}\n\n` });
      return;
    }
    else if (pathname === "/api/sessions" && route.request().method() === "POST") body = session;
    else body = { entries: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("heading", { name: /把想法/ }).waitFor();
  await page.locator(".welcome-card .mode-picker").getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("textbox", { name: "编程任务输入" }).fill("Plan a small safe change");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText("A focused smoke test passed.").waitFor();
  console.log("UI smoke test passed: project shell, workflow switching, and task submission.");
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
}
