export interface DiffLine { kind: "same" | "add" | "remove"; text: string }

/** Bounded line LCS. Large replacements fall back to exact remove/add blocks. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix);
  const lines: DiffLine[] = a.slice(0, prefix).map((text) => ({ kind: "same", text }));
  if ((old.length + 1) * (next.length + 1) <= 1_000_000) {
    const width = next.length + 1;
    const matrix = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) {
      for (let j = next.length - 1; j >= 0; j--) {
        matrix[i * width + j] = old[i] === next[j] ? matrix[(i + 1) * width + j + 1] + 1 : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { lines.push({ kind: "same", text: old[i++] }); j++; }
      else if (i < old.length && (j === next.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) lines.push({ kind: "remove", text: old[i++] });
      else lines.push({ kind: "add", text: next[j++] });
    }
  } else {
    for (const text of old) lines.push({ kind: "remove", text });
    for (const text of next) lines.push({ kind: "add", text });
  }
  for (const text of a.slice(a.length - suffix)) lines.push({ kind: "same", text });
  return lines;
}
