import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "./diff.ts";

test("diff preserves common lines instead of marking whole files changed", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [
    { kind: "same", text: "a" }, { kind: "remove", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" },
  ]);
});

test("diff supports new, empty, repeated and large files", () => {
  for (const [before, after] of [["", "new\n"], ["old", ""], ["a\na\nb", "a\nb\nb"], ["a\n".repeat(1200), "b\n".repeat(1200)]]) {
    const lines = diffLines(before, after);
    assert.equal(lines.filter((line) => line.kind !== "add").map((line) => line.text).join("\n"), before);
    assert.equal(lines.filter((line) => line.kind !== "remove").map((line) => line.text).join("\n"), after);
  }
});
