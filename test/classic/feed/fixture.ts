import {
  asMessageId,
  asSessionId,
  asToolCallId,
  asTurnId,
  type AnyAppEvent,
} from "../../../src/app/events/app-event.js";
import { OutputSpool } from "../../../src/app/events/event-buffer.js";
import { createCountingIdFactory, EventSequencer } from "../../../src/app/events/sequencer.js";
import { buildFileChange } from "../../../src/tools/file-diff.js";
import type { ColorMode } from "../../../src/app/ports/terminal-port.js";
import { applyAppEvent } from "../../../src/ui-core/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import type { FeedViewInput } from "../../../src/classic/feed/feed-blocks.js";

export const FIXTURE_NOW = 1_700_000_060_000;
const CLOCK = 1_700_000_000_000;

export const GOLDEN_WIDTHS = [40, 48, 68, 80, 96, 120, 200] as const;
export const GOLDEN_COLOR_MODES: readonly ColorMode[] = ["truecolor", "none"];

export interface ScriptedTurn {
  readonly state: TranscriptState;
  readonly spool: OutputSpool;
}

const BEFORE = [
  "export async function listUsers(req, res) {",
  "  const rows = await db.users.findMany();",
  "  res.json(rows);",
  "}",
  "",
].join("\n");

const AFTER = [
  "export async function listUsers(req, res) {",
  "  const { limit = 25, offset = 0 } = req.query;",
  "  const rows = await db.users.findMany({ limit, offset });",
  "  res.json({ rows, limit, offset });",
  "}",
  "",
].join("\n");

const BATCH_OUTPUT = [
  "── #1 fs.read [ok exit=0]",
  "12 lines",
  "── #2 shell.exec [running]",
  "resolving dependencies",
  "── #3 fs.read [ok exit=0]",
  "8 lines",
].join("\n");

const THINKING =
  "the route returns a bare array, so adding pagination changes the contract";

const ASSISTANT = [
  "I'll read the route handler first.",
  "",
  "The change touches three files:",
  "",
  "1. `src/db/users.ts` — add limit and offset",
].join("\n");

/**
 * The scripted turn from the W07 gate: assistant text, three tools, a failure,
 * a blocked tool, a diff, a batch, and a compaction.
 */
export function scriptedTurn(): ScriptedTurn {
  let tick = 0;
  const seq = new EventSequencer(asSessionId("sess-1"), createCountingIdFactory("f"), {
    now: () => CLOCK + (tick += 400),
  });
  const turnId = asTurnId("turn-1");
  const spool = new OutputSpool();

  const okCall = asToolCallId("call-ok");
  const failCall = asToolCallId("call-fail");
  const blockedCall = asToolCallId("call-blocked");
  const diffCall = asToolCallId("call-diff");
  const batchCall = asToolCallId("call-batch");

  spool.append(okCall, "PASS src/routes/users.test.ts\nPASS src/db/users.test.ts\nTests: 42 passed, 42 total\n");
  spool.append(failCall, "sh: tsc: command not found\n");
  spool.append(batchCall, BATCH_OUTPUT);

  const change = buildFileChange({
    path: "/repo/src/routes/users.ts",
    before: BEFORE,
    after: AFTER,
    kind: "edit",
  });

  const events: AnyAppEvent[] = [
    seq.build("turn-started", { prompt: "add pagination to the users endpoint and return metadata in the response body" }, turnId),
    seq.build("thinking-delta", { text: THINKING }, turnId),
    seq.build("thinking-block", { messageId: asMessageId("m-think"), content: THINKING }, turnId),
    seq.build("assistant-delta", { text: ASSISTANT }, turnId),
    seq.build("assistant-message", { messageId: asMessageId("m-1"), text: ASSISTANT }, turnId),

    seq.build("tool-call", { toolCallId: okCall, name: "shell.exec", argsDisplay: "npm test -- --run" }, turnId),
    seq.build("tool-started", { toolCallId: okCall }, turnId),
    seq.build("tool-output", { ref: { toolCallId: okCall, chunkBytes: 32, totalBytes: 76 } }, turnId),
    seq.build("tool-result", { toolCallId: okCall, ok: true, exitCode: 0, summary: "Tests: 42 passed, 42 total" }, turnId),

    seq.build("tool-call", { toolCallId: failCall, name: "shell.exec", argsDisplay: "npm run build" }, turnId),
    seq.build("tool-started", { toolCallId: failCall }, turnId),
    seq.build("tool-result", { toolCallId: failCall, ok: false, exitCode: 127, summary: "sh: tsc: command not found" }, turnId),

    seq.build("tool-call", { toolCallId: blockedCall, name: "fs.delete", argsDisplay: "/etc/hosts" }, turnId),
    seq.build("tool-blocked", { toolCallId: blockedCall, name: "fs.delete", reason: "path outside the authorized workspace" }, turnId),

    seq.build("tool-call", { toolCallId: diffCall, name: "fs.edit", argsDisplay: "/repo/src/routes/users.ts" }, turnId),
    seq.build("tool-started", { toolCallId: diffCall }, turnId),
    seq.build("tool-result", { toolCallId: diffCall, ok: true, exitCode: 0, summary: "edited", fileChanges: [change] }, turnId),

    seq.build("tool-call", { toolCallId: batchCall, name: "tool.batch", argsDisplay: "3 tools" }, turnId),
    seq.build("tool-started", { toolCallId: batchCall }, turnId),
    seq.build("tool-output", { ref: { toolCallId: batchCall, chunkBytes: 64, totalBytes: 128 } }, turnId),

    seq.build("compaction-started", { compactionId: "c1", beforeTokens: 48_200 }, turnId),
    seq.build("compaction-completed", {
      compactionId: "c1",
      beforeTokens: 48_200,
      afterTokens: 9_100,
      summary: "Session goal: add pagination. Files touched: src/db/users.ts, src/routes/users.ts. Tests pass.",
    }, turnId),
    seq.build("notice", { level: "warn", text: "provider fell back to groq" }, turnId),
  ];

  return { state: events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE), spool };
}

export interface ViewOptions {
  readonly columns: number;
  readonly colorMode?: ColorMode | undefined;
  readonly unicode?: boolean | undefined;
  readonly generation?: number | undefined;
  readonly withIntro?: boolean | undefined;
}

export function feedView(turn: ScriptedTurn, options: ViewOptions): FeedViewInput {
  return {
    columns: options.columns,
    ink: createInkTheme({
      themeHint: "dark",
      colorMode: options.colorMode ?? "truecolor",
      unicode: options.unicode ?? true,
    }),
    now: FIXTURE_NOW,
    spool: turn.spool,
    generation: options.generation ?? 0,
    intro: options.withIntro
      ? {
          version: "3.17.0",
          mode: "AGENT",
          provider: "groq",
          model: "kimi-k2-thinking",
          permissions: "auto-approve reads",
          workdir: "~/dev/clai",
        }
      : undefined,
  };
}
