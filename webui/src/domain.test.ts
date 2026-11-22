import test from "node:test";
import assert from "node:assert/strict";
import { humanSize, languageFor, modes, sortedFiles, suggestions } from "./domain.ts";

test("workflow modes have useful starter prompts", () => {
  assert.deepEqual(modes.map(({ key }) => key), ["code", "plan", "spec", "goal"]);
  for (const mode of modes) assert.ok(suggestions[mode.key].length >= 3);
});

test("editor language follows source file extension", () => {
  assert.equal(languageFor("src/main.rs"), "rust");
  assert.equal(languageFor("webui/App.tsx"), "typescript");
  assert.equal(languageFor("config.json"), "json");
  assert.equal(languageFor("README.md"), "text");
});

test("workspace entries sort folders ahead of files", () => {
  const entries = sortedFiles([
    { name: "z.rs", path: "z.rs", isDir: false, size: 1 },
    { name: "src", path: "src", isDir: true, size: 0 },
    { name: "Cargo.toml", path: "Cargo.toml", isDir: false, size: 1 },
  ]);
  assert.deepEqual(entries.map(({ name }) => name), ["src", "Cargo.toml", "z.rs"]);
});

test("file size formatting is compact", () => {
  assert.equal(humanSize(12), "12 B");
  assert.equal(humanSize(1024), "1.0 KB");
});
