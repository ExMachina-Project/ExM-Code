import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Linux native smoke, not a browser with mocked Tauri globals.
// Run under xvfb-run; requires xdotool, ImageMagick and Python's SQLite module.
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "linux" || !process.env.DISPLAY) throw new Error("Native smoke requires Linux/X11; run: xvfb-run -a npm run test:desktop");
const temporaryRoot = process.env.EXM_CODE_TEST_TMP || "/tmp/opencode";
await mkdir(temporaryRoot, { recursive: true });
const temporary = await mkdtemp(join(temporaryRoot, "exm-code-native-"));
const project = join(temporary, "project");
const dataHome = join(temporary, "app-data");
const appData = join(dataHome, "dev.exmachina.exm-code");
await mkdir(project, { recursive: true });
await mkdir(appData, { recursive: true });
const requests = [];
const modelErrors = [];
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    assert.equal(input.model, "native-smoke-model");
    const message = input.messages.at(-1).role === "tool" ? { content: "Native IPC and model loop passed. Review the proposed change." } : {
      content: null, tool_calls: [{ id: "native-proposal", type: "function", function: { name: "propose_change", arguments: JSON.stringify({ path: "native-proposal.txt", content: "not written until reviewed\n", reason: "Native smoke test" }) } }],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }] }));
  } catch (error) { modelErrors.push(String(error)); response.writeHead(500); response.end("Native test model error"); }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
await writeFile(join(project, "native-smoke.txt"), "This project belongs only to the native smoke test.\n");
await writeFile(join(appData, "workspace.json"), JSON.stringify(project));
await writeFile(join(appData, "model.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: "native-smoke-model", apiKey: "" }));
let logs = "";
const binary = process.env.EXM_CODE_DESKTOP_BINARY || join(root, "desktop/src-tauri/target/debug/exm-code-desktop");
const app = spawn(binary, [], { cwd: root, detached: true, env: {
  ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(temporary, "config"), XDG_CACHE_HOME: join(temporary, "cache"),
  ...(process.getuid?.() === 0 ? { WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1" } : {}),
  WEBKIT_DISABLE_COMPOSITING_MODE: "1", NO_AT_BRIDGE: "1",
}, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", (data) => { logs += String(data); });
app.stderr.on("data", (data) => { logs += String(data); });
let spawnError;
let windowId;
app.on("error", (error) => { spawnError = error; });
async function sessionCount(query = "select count(*) from sessions") {
  const { stdout } = await exec("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(db.execute(sys.argv[2]).fetchone()[0])", join(project, ".exm-code/sessions.sqlite3"), query]);
  return Number(stdout.trim());
}
async function waitForCount(minimum, query) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (app.exitCode !== null) throw new Error(`Desktop exited (${app.exitCode}): ${logs}`);
    try { if ((await sessionCount(query)) >= minimum) return; } catch { /* Wait for native IPC. */ }
    await delay(150);
  }
  throw new Error(`Native IPC did not persist ${minimum} sessions: ${logs}`);
}
try {
  await waitForCount(1);
  const { stdout } = await exec("xdotool", ["search", "--onlyvisible", "--name", "^ExM Code$"], { timeout: 15000 });
  windowId = stdout.trim().split("\n")[0];
  assert.ok(windowId, "Expected a real native ExM Code window");
  await exec("xdotool", ["windowmove", windowId, "0", "0"]);
  await exec("xdotool", ["windowsize", windowId, "1280", "900"]);
  await delay(700); // SQLite may be initialized just before the first UI paint.
  const before = await sessionCount();
  await exec("xdotool", ["windowfocus", "--sync", windowId]);
  await exec("xdotool", ["mousemove", "--window", windowId, "600", "600", "click", "1"]);
  await exec("xdotool", ["key", "ctrl+k"]);
  await waitForCount(before + 1);
  await delay(200);
  await exec("xdotool", ["type", "--clearmodifiers", "Native smoke task"]);
  await exec("xdotool", ["key", "Return"]);
  await waitForCount(1, "select count(*) from messages where role='assistant' and proposals != '[]'");
  assert.equal(requests.length, 2);
  assert.deepEqual(modelErrors, []);
  await assert.rejects(readFile(join(project, "native-proposal.txt")), { code: "ENOENT" });
  await delay(200);
  await mkdir(join(root, "test-results"), { recursive: true });
  await exec("import", ["-window", windowId, join(root, "test-results/native-desktop.png")]);
  assert.ok(!logs.includes("panicked at"), logs);
  console.log("Native desktop smoke passed: real Tauri window, embedded assets, Ctrl+K, IPC/channel chat, Rust model/tool loop and persisted review proposal (no local Agent HTTP server).");
} catch (error) {
  if (windowId) {
    await mkdir(join(root, "test-results"), { recursive: true });
    await exec("import", ["-window", windowId, join(root, "test-results/native-desktop-failure.png")]).catch(() => undefined);
  }
  throw error;
} finally {
  if (app.pid && app.exitCode === null && app.signalCode === null) {
    const closed = once(app, "exit");
    process.kill(-app.pid, "SIGTERM");
    await closed;
  }
  model.closeAllConnections();
  await new Promise((resolveClosed) => model.close(resolveClosed));
  await rm(temporary, { recursive: true, force: true });
}
