import type { AgentEvent } from "../../src/agent/events.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { buildFileChange } from "../../src/tools/file-diff.js";
import type { SessionPlan } from "../../src/store/plan.js";

export interface FakeStream extends NodeJS.WritableStream {
  isTTY?: boolean | undefined;
  readonly chunks: string[];
  text(): string;
}

export function fakeStream(isTTY = false): FakeStream {
  const chunks: string[] = [];
  const stream = {
    chunks,
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
    text(): string {
      return chunks.join("");
    },
  };
  return stream as unknown as FakeStream;
}

/** Monotonic clock so elapsed labels are deterministic. */
export function fakeClock(stepMs = 1_200): () => number {
  let now = 1_000;
  return () => {
    const value = now;
    now += stepMs;
    return value;
  };
}

export const FIXTURE_CHANGE = buildFileChange({
  path: "/repo/src/app.ts",
  before: "const a = 1;\nconst b = 2;\n",
  after: "const a = 1;\nconst b = 3;\nconst c = 4;\n",
  kind: "edit",
});

export const FIXTURE_BATCH_BODY = [
  "── #1 shell.exec [ok exit=0]",
  "alpha",
  "── #2 fs.read [fail exit=1]",
  "boom",
].join("\n");

export const FIXTURE_PLAN: SessionPlan = {
  sessionId: "s1",
  goal: "ship the thing",
  status: "in_progress",
  tasks: [
    { id: "t1", title: "t1: read code", state: "done" },
    { id: "t2", title: "write code", state: "in_progress" },
    { id: "t3", title: "verify", state: "pending" },
  ],
  createdAt: 0,
  updatedAt: 0,
} as unknown as SessionPlan;

export const FIXTURE_OUTCOME = createTurnOutcome({
  status: "succeeded",
  answer: "Found 6 PDFs over 100 MB.",
  steps: 3,
  remainingCriteria: [],
});

/**
 * The scripted turn from 06-ONESHOT §6 step 3: assistant text, thinking, three
 * tools, one failure, one blocked tool, a file diff, a batch, a compaction and
 * an abort.
 */
export function scriptedEvents(): readonly AgentEvent[] {
  return [
    { type: "turn-start", prompt: "find large pdfs" },
    { type: "status", text: "step 1" },
    { type: "thinking-block", content: "I should search the home directory." },
    { type: "assistant-message", text: "I'll search your home directory." },
    { type: "tool-call", id: "c1", name: "shell.exec", argsDisplay: "find ~ -name '*.pdf'" },
    { type: "tool-start", id: "c1" },
    { type: "tool-output", id: "c1", chunk: "atlas.pdf\nscan.pdf\nreport.pdf\nnotes.pdf\n" },
    { type: "tool-result", id: "c1", ok: true, exitCode: 0, summary: "ok" },
    { type: "tool-call", id: "c2", name: "shell.exec", argsDisplay: "du -sh missing" },
    { type: "tool-result", id: "c2", ok: false, exitCode: 1, summary: "du: missing: No such file" },
    { type: "tool-blocked", id: "c3", name: "fs.delete", reason: "confirmation required" },
    { type: "tool-call", id: "c4", name: "fs.edit", argsDisplay: '{"path":"/repo/src/app.ts"}' },
    {
      type: "tool-result",
      id: "c4",
      ok: true,
      summary: "edited",
      fileChanges: [FIXTURE_CHANGE],
    },
    { type: "tool-call", id: "c5", name: "tool.batch", argsDisplay: "2 calls" },
    { type: "tool-output", id: "c5", chunk: FIXTURE_BATCH_BODY, replace: true },
    { type: "tool-result", id: "c5", ok: false, summary: "1 of 2 failed" },
    { type: "compaction-start", id: "k1", beforeTokens: 120_000 },
    {
      type: "compaction-completed",
      id: "k1",
      summary: "earlier work",
      beforeTokens: 120_000,
      afterTokens: 30_000,
      contextScope: "assembled-request",
    },
    { type: "turn-aborted" },
  ];
}
