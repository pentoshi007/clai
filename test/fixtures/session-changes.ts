import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import type { FileLineChanges } from "../../src/app/controllers/session-changes.js";

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
