export interface StreamEvent<T, P> {
  type: "progress" | "done" | "error";
  progress?: P;
  reply?: T;
  error?: string;
}

/** Fetch-based SSE supports Authorization headers and cancels on disconnect. */
export async function readEventStream<T, P>(response: Response, progress: (value: P) => void): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务器未返回事件流。");
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 20 * 1024 * 1024) throw new Error("事件流超出大小限制。");
      // SSE lines may use CRLF and UTF-8 characters may span network chunks.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as StreamEvent<T, P>;
        if (event.type === "progress" && event.progress) progress(event.progress);
        if (event.type === "error") throw new Error(event.error || "任务失败。");
        if (event.type === "done" && event.reply !== undefined) return event.reply;
      }
      if (done) throw new Error("连接中断，任务结果尚未完整接收。请重新载入会话检查结果。");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
