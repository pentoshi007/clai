import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import type { FileLineChanges } from "../../src/app/controllers/session-changes.js";
import { buildFileChange, type FileChange } from "../../src/tools/file-diff.js";

export const savedChanges: readonly FileLineChanges[] = [
  { path: `src/<provider>/${"long-directory/".repeat(12)}file.ts`, added: 200, removed: 400 },
  { path: "src/old.ts", added: 18, removed: 36 },
];

export const savedChangeTranscript: readonly TranscriptItem[] = [
  { kind: "user", id: "prompt-1", text: "Edit the files", done: true },
  { kind: "turn-summary", id: "summary-1", durationMs: 76_000, status: "completed", changes: { added: 213, removed: 435 }, done: true },
  { kind: "user", id: "prompt-2", text: "One more edit", done: true },
  { kind: "turn-summary", id: "summary-2", durationMs: 5_000, status: "aborted", changes: { added: 5, removed: 1 }, done: true },
  { kind: "user", id: "prompt-3", text: "Explain the result", done: true },
  { kind: "turn-summary", id: "summary-3", durationMs: 2_000, status: "completed", done: true },
];

const answerBefore = Array.from({ length: 12 }, (_, index) => `const v${index} = ${index};`).join("\n") + "\n";

export const diffedChanges: readonly FileChange[] = [
  buildFileChange({ path: "/repo/src/answer.ts", before: answerBefore, after: answerBefore.replace("const v6 = 6;", "const answer = 42;"), kind: "edit" }),
  buildFileChange({ path: "/repo/tools/run.py", before: "", after: "def run():\n    return 1\n", kind: "create" }),
];

export const diffedChangeTranscript: readonly TranscriptItem[] = [
  { kind: "user", id: "diff-prompt", text: "Edit the answer and add a runner", done: true },
  { kind: "tool", id: "diff-edit", name: "fs.edit", argsDisplay: "/repo/src/answer.ts", output: "", status: "ok", fileChanges: [diffedChanges[0]!], done: true },
  { kind: "tool", id: "diff-create", name: "fs.write", argsDisplay: "/repo/tools/run.py", output: "", status: "ok", fileChanges: [diffedChanges[1]!], done: true },
  { kind: "turn-summary", id: "diff-summary", durationMs: 3_000, status: "completed", changes: { added: 3, removed: 1 }, done: true },
];
