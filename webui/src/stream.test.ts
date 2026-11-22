import assert from "node:assert/strict";
import { test } from "node:test";
import { readEventStream } from "./stream.ts";

function response(text: string, chunkSize = 1): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }));
}

test("SSE handles split UTF-8, CRLF, keepalive, and progress", async () => {
  const events: unknown[] = [];
  const result = await readEventStream(response(': ping\r\n\r\ndata: {"type":"progress","progress":{"name":"读取文件"}}\r\n\r\ndata: {"type":"done","reply":{"content":"完成 ✓"}}\r\n\r\n'), (event) => events.push(event));
  assert.deepEqual(events, [{ name: "读取文件" }]);
  assert.deepEqual(result, { content: "完成 ✓" });
});

test("SSE never treats a truncated stream as a successful task", async () => {
  await assert.rejects(readEventStream(response('data: {"type":"progress","progress":{"round":1}}\n\n'), () => {}), /连接中断/);
});

test("SSE surfaces runtime errors", async () => {
  await assert.rejects(readEventStream(response('data: {"type":"error","error":"Task cancelled"}\n\n'), () => {}), /Task cancelled/);
});

test("SSE rejects invalid JSON instead of silently losing results", async () => {
  await assert.rejects(readEventStream(response('data: {broken}\n\n'), () => {}), SyntaxError);
});
