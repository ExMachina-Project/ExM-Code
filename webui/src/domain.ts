import type { FileEntry, Mode } from "./api";

export const modes: { key: Mode; label: string; description: string }[] = [
  { key: "code", label: "Code", description: "Read, reason, and propose reviewed code changes." },
  { key: "plan", label: "Plan", description: "Break the work into ordered steps and checks." },
  { key: "spec", label: "Spec", description: "Write acceptance criteria and implementation requirements." },
  { key: "goal", label: "Goal", description: "Define outcomes, constraints, and milestones." },
];

export const suggestions: Record<Mode, string[]> = {
  code: ["Explain this codebase and show me where to start.", "Find a bug or risky edge case in the current project.", "Implement a feature and show me the proposed diff."],
  plan: ["Plan a careful approach to the next feature I have in mind.", "Break this task into small, testable implementation steps.", "Review the project structure and identify the best first milestone."],
  spec: ["Turn my feature idea into an implementation-ready spec.", "Define acceptance criteria and important edge cases.", "Write a concise spec for improving this project."],
  goal: ["Help me turn an idea into clear, measurable goals.", "Define what success looks like for this project.", "Clarify the constraints and milestones before implementation."],
};

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "rs") return "rust";
  if (ext === "json") return "json";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? "")) return "typescript";
  return "text";
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function sortedFiles(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}
