import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// This test uses a real headless Rust API and a separately served web client, but never a paid model.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = process.env.EXM_CODE_TEST_TMP || (process.platform === "linux" ? "/tmp/opencode" : tmpdir());
const webuiDir = join(root, "webui");
const viteBin = join(root, "node_modules/vite/bin/vite.js");
await mkdir(temporaryRoot, { recursive: true });
const workspace = await mkdtemp(join(temporaryRoot, "exm-code-e2e-"));
const requests = [];
const modelErrors = [];
let slowRequests = 0;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages.at(-1);
    if (last.role === "user" && last.content.includes("CANCEL_SLOW_TASK")) {
      slowRequests += 1;
      await new Promise((resolveClosed) => response.once("close", resolveClosed));
      return;
    }
    const codeMode = body.tools.some((tool) => tool.function.name === "propose_change");
    let message;
    if (!codeMode) {
      message = { content: "## Plan\n\n1. Inspect project files.\n2. Propose a small, reviewed change.\n3. Run the checks.", tool_calls: null };
    } else if (last.role !== "tool") {
      message = { content: null, tool_calls: [{
        id: "create_example", type: "function", function: {
          name: "propose_change",
          arguments: JSON.stringify({ path: "example.txt", content: "reviewed from the browser\n", reason: "Small end-to-end test change" }),
        },
      }] };
    } else {
      message = { content: "A file proposal is ready. Review it before applying." };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }] }));
  } catch (error) {
    modelErrors.push(error);
    response.writeHead(500);
    response.end(String(error));
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");

const env = { ...process.env };
for (const key of ["EXM_CODE_BASE_URL", "EXM_CODE_MODEL", "EXM_CODE_API_KEY", "EXM_CODE_DATA_DIR", "EXM_CODE_AUTH_TOKEN", "VITE_EXM_CODE_SERVER_URL"]) delete env[key];
const binary = process.env.EXM_CODE_BINARY || join(resolve(root, process.env.CARGO_TARGET_DIR || "target"), "debug", process.platform === "win32" ? "exm-code.exe" : "exm-code");
let server;
let webui;
let browser;
let page;
const authToken = "exm-code-e2e-token-at-least-32-bytes";
let allowedOrigin;

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function startApiServer(port) {
  const child = spawn(binary, ["serve", workspace, "--port", String(port), "--auth-token", authToken, "--allowed-origin", allowedOrigin], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  server = child;
  let log = "";
  return new Promise((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error(`API server startup timed out: ${log}`)), 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`API server exited (${code}): ${log}`)); });
    child.stderr.on("data", (data) => {
      log += String(data);
      const address = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) { clearTimeout(timer); resolveAddress(address); }
    });
  });
}

async function startWebUi(apiAddress, port) {
  webui = spawn(process.execPath, [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: webuiDir,
    env: { ...env, EXM_CODE_UI_PORT: String(port), EXM_CODE_DEV_API: apiAddress },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (webui.exitCode !== null) throw new Error(`Web client exited (${webui.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return `http://127.0.0.1:${port}`;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("The separately served web client did not start within 15 seconds.");
}

async function stopApiServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exit = once(server, "exit");
  server.kill("SIGTERM");
  await exit;
}

try {
  const nestedFile = join(workspace, "src", "components", "DeepExample.tsx");
  await mkdir(dirname(nestedFile), { recursive: true });
  await writeFile(nestedFile, "export const DeepExample = 'selected project context';\n");
  const apiPort = await freePort();
  const uiPort = await freePort();
  allowedOrigin = `http://127.0.0.1:${uiPort}`;
  const apiAddress = await startApiServer(apiPort);
  const webAddress = await startWebUi(apiAddress, uiPort);
  const headers = { Authorization: `Bearer ${authToken}` };
  assert.equal((await fetch(`${apiAddress}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${apiAddress}/`, { headers })).status, 404, "The API must not serve the web application");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  await page.addInitScript(({ base, token }) => {
    localStorage.setItem("exm-code.server-url", base);
    sessionStorage.setItem(`exm-code.server-token:${base}`, token);
  }, { base: apiAddress, token: authToken });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(webAddress);
  await page.getByRole("heading", { name: /把想法/ }).waitFor();
  const screenshot = process.env.EXM_CODE_E2E_SCREENSHOT || join(root, "test-results", "workspace.png");
  await mkdir(dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });

  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByLabel("API Base URL", { exact: true }).fill(`http://127.0.0.1:${model.address().port}/v1`);
  await page.getByLabel("模型名称", { exact: true }).fill("local-e2e-model");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("设置已保存在本机", { exact: true }).waitFor();
  await page.getByPlaceholder("查找文件...").fill("DeepExample");
  await page.locator(".search-result").filter({ hasText: "DeepExample.tsx" }).click();
  await page.locator(".attached-context").waitFor();
  await page.getByRole("textbox", { name: "编程任务输入" }).fill("Create an example file for me");
  const sendButton = page.locator(".send-button");
  try {
    await sendButton.waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("发送"));
      return button && !button.disabled;
    }, null, { timeout: 8_000 });
  } catch (error) {
    console.error("E2E send preconditions:", await page.locator(".composer").innerText(), "settings:", await page.locator(".connection").innerText(), "input:", await page.getByRole("textbox", { name: "编程任务输入" }).inputValue());
    await page.screenshot({ path: join(temporaryRoot, "exm-code-e2e-failure.png") });
    throw error;
  }
  await sendButton.click();
  await page.getByText("A file proposal is ready. Review it before applying.", { exact: true }).waitFor();
  await page.locator(".task-progress").waitFor();
  assert.ok((await page.locator(".task-progress").textContent()).includes("propose_change"));
  await assert.rejects(readFile(join(workspace, "example.txt")), { code: "ENOENT" });
  assert.ok(requests[0].messages.at(-1).content.includes("selected project context"));
  await page.locator(".proposal-preview > summary").click();
  const proposalCard = page.locator(".proposal-card");
  if (await proposalCard.count() !== 1) {
    console.error("Missing proposal card; model requests:", JSON.stringify(requests, null, 2), "page:", await page.locator(".message-stream").innerText());
    throw new Error("The real Rust model-tool loop did not return a pending proposal.");
  }
  await proposalCard.locator(".ant-btn-primary").click();
  await page.getByText("✓ 已应用 · example.txt", { exact: true }).waitFor();
  assert.equal(await readFile(join(workspace, "example.txt"), "utf8"), "reviewed from the browser\n");

  await page.reload();
  await page.getByText("✓ 已应用 · example.txt", { exact: true }).waitFor();
  assert.equal(await page.locator(".proposal-card .ant-btn-primary").count(), 0);
  if (await page.locator(".composer .mode-picker").count() === 0) {
    console.error("Composer was not rendered after reload:", await page.locator("body").innerText());
    await page.screenshot({ path: join(temporaryRoot, "exm-code-e2e-reloaded.png") });
    throw new Error("Expected a persistent composer after loading conversation history.");
  }
  const [modeResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith("/api/sessions/")),
    page.locator(".composer .mode-picker").getByRole("tab", { name: /Plan/ }).click(),
  ]);
  assert.equal(modeResponse.status(), 200);
  const persistedSessions = await fetch(`${apiAddress}/api/sessions`, { headers }).then((response) => response.json());
  assert.equal(persistedSessions.sessions[0].mode, "plan");
  await page.getByRole("textbox", { name: "编程任务输入" }).fill("Plan the next milestone");
  await page.getByRole("textbox", { name: "编程任务输入" }).press("Enter");
  await page.getByText("Inspect project files.", { exact: true }).waitFor();
  await stopApiServer();
  await startApiServer(apiPort);
  await page.goto(webAddress);
  await page.getByText("Inspect project files.", { exact: true }).waitFor();
  assert.equal(await page.locator(".composer .mode-picker").getByRole("tab", { name: /Plan/ }).getAttribute("aria-selected"), "true");
  await page.getByText("local-e2e-model", { exact: true }).waitFor();

  // Session features use the same persisted Runtime through real authenticated CORS requests.
  await page.locator(".session-more").first().click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "任务名称" }).fill("Reviewed milestone");
  await page.getByRole("dialog", { name: "重命名任务" }).locator(".ant-btn-primary").click();
  await page.locator(".session-title").getByText("Reviewed milestone", { exact: true }).waitFor();
  await page.locator(".session-more").first().click();
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await page.getByRole("button", { name: "管理任务 Reviewed milestone", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出 Markdown", exact: true }).click();
  assert.ok((await page.getByRole("textbox", { name: "导出的 Markdown" }).inputValue()).includes("Plan the next milestone"));
  await page.getByRole("dialog", { name: "导出 · Reviewed milestone" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".session-more").first().click();
  await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: "恢复任务", exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith("/api/sessions/")),
    page.locator(".composer .mode-picker").getByRole("tab", { name: /Code/ }).click(),
  ]);
  await page.getByRole("button", { name: "新建文件提案", exact: true }).click();
  await page.getByRole("textbox", { name: "新文件路径", exact: true }).fill("manual-review.txt");
  await page.locator(".code-editor .cm-content").fill("manually reviewed content\n");
  await page.getByRole("button", { name: "生成审阅提案", exact: true }).click();
  const manual = page.locator(".proposal-card").filter({ hasText: "manual-review.txt" });
  await manual.waitFor();
  await assert.rejects(readFile(join(workspace, "manual-review.txt")), { code: "ENOENT" });
  await manual.locator(".ant-btn-primary").click();
  await page.getByText("✓ 已应用 · manual-review.txt", { exact: true }).waitFor();
  assert.equal(await readFile(join(workspace, "manual-review.txt"), "utf8"), "manually reviewed content\n");
  await page.getByRole("checkbox", { name: "搜索文件内容" }).check();
  await page.getByPlaceholder("查找文件...").fill("manually reviewed");
  await page.locator(".content-match").filter({ hasText: "manual-review.txt" }).waitFor();
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname.startsWith("/api/sessions/")),
    page.locator(".composer .mode-picker").getByRole("tab", { name: /Plan/ }).click(),
  ]);
  await page.getByRole("textbox", { name: "编程任务输入" }).fill("CANCEL_SLOW_TASK");
  await page.getByRole("textbox", { name: "编程任务输入" }).press("Enter");
  // Wait for a real model request so cancellation cannot pass by merely aborting the browser UI.
  for (let attempt = 0; slowRequests === 0 && attempt < 60; attempt++) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(slowRequests, 1);
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await page.locator(".task-status").getByText("任务已取消", { exact: true }).waitFor();
  for (let attempt = 0; attempt < 60; attempt++) {
    const { tasks } = await fetch(`${apiAddress}/api/tasks`, { headers }).then((response) => response.json());
    if (!tasks.length) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.deepEqual((await fetch(`${apiAddress}/api/tasks`, { headers }).then((response) => response.json())).tasks, []);
  await page.reload();
  await page.locator(".task-status").getByText("任务已取消", { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".composer").waitFor();
  const mobileMain = await page.locator(".main-area").boundingBox();
  assert.equal(mobileMain?.width, 390, "The mobile conversation must occupy the full viewport width");
  await page.getByText("Inspect project files.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("navigation", { name: "最近任务" }).waitFor();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  assert.equal((await page.locator(".main-area").boundingBox())?.width, 390);
  assert.deepEqual(errors, []);
  assert.deepEqual(modelErrors, []);
  console.log("E2E passed: production web client, authenticated cross-origin API, live tool events, reviewed model/editor edits, content search, persistence/restart, rename/pin/archive/export, real cancellation, mobile layout.");
} catch (error) {
  if (page) {
    console.error("E2E failure page:", await page.locator("body").innerText().catch(() => "Page unavailable"));
    await page.screenshot({ path: join(root, "test-results", "e2e-failure.png") }).catch(() => undefined);
  }
  throw error;
} finally {
  await browser?.close();
  await stopApiServer();
  if (webui?.exitCode === null) webui.kill("SIGTERM");
  model.closeAllConnections();
  await new Promise((resolveClosed) => model.close(resolveClosed));
  // The directory is exclusively created and owned by this test run.
  await rm(workspace, { recursive: true, force: true });
}
