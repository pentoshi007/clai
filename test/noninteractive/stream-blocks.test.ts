import { describe, expect, it } from "vitest";
import {
  buildAssistantDeltaLines,
  buildAssistantMessageLines,
  buildBatchLines,
  buildCompactedLines,
  buildCompactionCompletedLines,
  buildCompactionDeltaLines,
  buildCompactionFailedLines,
  buildCompactionStartLines,
  buildConfirmRequestLines,
  buildContextEstimateLines,
  buildNoticeLines,
  buildPlanUpdateLines,
  buildStatusLines,
  buildThinkingBlockLines,
  buildThinkingDeltaLines,
  buildTokenUsageLines,
  buildToolBlockedLines,
  buildToolCallLines,
  buildToolDiffLines,
  buildToolOutputLines,
  buildToolResultLines,
  buildToolStartLines,
  buildTurnAbortedLines,
  buildTurnEndLines,
  buildTurnErrorLines,
  buildTurnStartLines,
  COLLAPSED_BODY_ROWS,
  createStreamContext,
  VERBOSE_BODY_ROWS,
  type StreamContext,
  type StreamVerbosity,
} from "../../src/noninteractive/stream-blocks.js";
import { displayWidth, stripAnsi } from "../../src/classic/render/measure.js";
import { FIXTURE_BATCH_BODY, FIXTURE_CHANGE, FIXTURE_OUTCOME, FIXTURE_PLAN } from "./fixture.js";

const WIDTHS = [40, 80, 120] as const;

function ctxAt(
  columns: number,
  overrides: {
    color?: boolean;
    unicode?: boolean;
    verbosity?: StreamVerbosity;
    showThinking?: boolean;
  } = {},
): StreamContext {
  return createStreamContext({
    columns,
    color: overrides.color ?? false,
    unicode: overrides.unicode ?? true,
    verbosity: overrides.verbosity ?? "normal",
    showThinking: overrides.showThinking ?? true,
  });
}

const BUILDERS: readonly (readonly [string, (ctx: StreamContext) => readonly string[]])[] = [
  ["turn-start", (c) => buildTurnStartLines(c, { type: "turn-start", prompt: "hello there" })],
  ["status", (c) => buildStatusLines(c, { type: "status", text: "step 2" })],
  ["thinking-delta", () => buildThinkingDeltaLines()],
  [
    "thinking-block",
    (c) => buildThinkingBlockLines(c, { type: "thinking-block", content: "weighing options" }),
  ],
  ["assistant-delta", () => buildAssistantDeltaLines()],
  [
    "assistant-message",
    (c) => buildAssistantMessageLines(c, { type: "assistant-message", text: "**done** now" }),
  ],
  ["notice", (c) => buildNoticeLines(c, { type: "notice", level: "warn", text: "key rotated" })],
  [
    "tool-call",
    (c) =>
      buildToolCallLines(c, {
        type: "tool-call",
        id: "c1",
        name: "shell.exec",
        argsDisplay: "find ~ -name '*.pdf'",
      }),
  ],
  ["tool-start", () => buildToolStartLines()],
  [
    "tool-output",
    (c) =>
      buildToolOutputLines(
        c,
        { type: "tool-output", id: "c1", chunk: "one\ntwo\nthree\nfour\nfive\nsix\n", replace: true },
        { name: "shell.exec" },
      ),
  ],
  [
    "tool-result",
    (c) =>
      buildToolResultLines(
        c,
        { type: "tool-result", id: "c1", ok: true, exitCode: 0, summary: "ok" },
        { elapsed: "1.2s" },
      ),
  ],
  [
    "tool-result-diff",
    (c) =>
      buildToolDiffLines(
        c,
        {
          type: "tool-result",
          id: "c4",
          ok: true,
          summary: "edited",
          fileChanges: [FIXTURE_CHANGE],
        },
        "fs.edit",
      ),
  ],
  ["tool-batch", (c) => buildBatchLines(c, FIXTURE_BATCH_BODY)],
  [
    "tool-blocked",
    (c) =>
      buildToolBlockedLines(c, {
        type: "tool-blocked",
        id: "c3",
        name: "fs.delete",
        reason: "confirmation required",
      }),
  ],
  ["plan-update", (c) => buildPlanUpdateLines(c, { type: "plan-update", plan: FIXTURE_PLAN })],
  [
    "confirm-request",
    (c) =>
      buildConfirmRequestLines(c, {
        type: "confirm-request",
        id: "q1",
        kind: "tool",
        prompt: "Run shell.exec?",
      }),
  ],
  ["turn-end", () => buildTurnEndLines()],
  ["turn-aborted", (c) => buildTurnAbortedLines(c)],
  ["turn-error", (c) => buildTurnErrorLines(c, { type: "turn-error", message: "network down" })],
  [
    "compaction-start",
    (c) => buildCompactionStartLines(c, { type: "compaction-start", id: "k1", beforeTokens: 120_000 }),
  ],
  ["compaction-delta", () => buildCompactionDeltaLines()],
  [
    "compaction-completed",
    (c) =>
      buildCompactionCompletedLines(c, {
        type: "compaction-completed",
        id: "k1",
        summary: "s",
        beforeTokens: 120_000,
        afterTokens: 30_000,
      }),
  ],
  [
    "compaction-failed",
    (c) =>
      buildCompactionFailedLines(c, {
        type: "compaction-failed",
        id: "k1",
        message: "model refused",
        retainedTokens: 120_000,
      }),
  ],
  [
    "compacted",
    (c) =>
      buildCompactedLines(c, {
        type: "compacted",
        summary: "s",
        beforeTokens: 120_000,
        afterTokens: 30_000,
      }),
  ],
  [
    "token-usage",
    (c) =>
      buildTokenUsageLines(c, {
        type: "token-usage",
        usage: { promptTokens: 1_200, completionTokens: 300, totalTokens: 1_500, exact: true },
        model: "gpt-x",
      }),
  ],
  [
    "context-estimate",
    (c) => buildContextEstimateLines(c, { type: "context-estimate", estimatedTokens: 42_000 }),
  ],
];

const ALWAYS_EMPTY = new Set([
  "thinking-delta",
  "assistant-delta",
  "compaction-delta",
  "tool-start",
  "turn-end",
]);

/** Diagnostics that only earn a row under `--verbose`. */
const VERBOSE_ONLY = new Set(["turn-start", "status", "token-usage", "context-estimate"]);

describe("stream-blocks", () => {
  for (const columns of WIDTHS) {
    for (const color of [false, true]) {
      describe(`width ${columns} · color ${color ? "on" : "off"}`, () => {
        const ctx = ctxAt(columns, { color });
        const loud = ctxAt(columns, { color, verbosity: "verbose" });

        for (const [kind, build] of BUILDERS) {
          it(`${kind} fits the content width and honours colour`, () => {
            const lines = build(VERBOSE_ONLY.has(kind) ? loud : ctx);
            if (ALWAYS_EMPTY.has(kind)) {
              expect(lines).toEqual([]);
              return;
            }
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) {
              expect(displayWidth(line)).toBeLessThanOrEqual(columns - 2);
              if (!color) expect(line).not.toContain("\x1b");
            }
          });
        }

        it("emits ANSI only when colour is on", () => {
          const rendered = BUILDERS.flatMap(([kind, build]) =>
            build(VERBOSE_ONLY.has(kind) ? loud : ctx),
          ).join("\n");
          expect(rendered.includes("\x1b")).toBe(color);
        });
      });
    }
  }

  it("renders the assistant answer with the shared markdown presenter", () => {
    const lines = buildAssistantMessageLines(ctxAt(80), {
      type: "assistant-message",
      text: "# Title\n\n- one\n- two",
    });
    expect(stripAnsi(lines[0] ?? "")).toMatch(/^◆ /);
    expect(lines.join("\n")).toContain("one");
  });

  it("hides thinking unless showThinking is set", () => {
    const event = { type: "thinking-block", content: "secret" } as const;
    expect(buildThinkingBlockLines(ctxAt(80, { showThinking: false }), event)).toEqual([]);
    expect(buildThinkingBlockLines(ctxAt(80), event)[0]).toContain("secret");
  });

  it("bounds tool output to three rows plus a hidden trailer, forty under verbose", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const event = { type: "tool-output", id: "c1", chunk: body, replace: true } as const;
    const normal = buildToolOutputLines(ctxAt(80), event);
    expect(normal.filter((line) => !line.includes("+"))).toHaveLength(COLLAPSED_BODY_ROWS);
    expect(normal.at(-1)).toMatch(/… \+\d+ lines/);

    const loud = buildToolOutputLines(ctxAt(80, { verbosity: "verbose" }), event);
    expect(loud.length).toBeGreaterThan(COLLAPSED_BODY_ROWS);
    expect(loud.length).toBeLessThanOrEqual(VERBOSE_BODY_ROWS + 2);
  });

  it("prints the diff title plus +N −M, hunks only under verbose", () => {
    const event = {
      type: "tool-result",
      id: "c4",
      ok: true,
      summary: "edited",
      fileChanges: [FIXTURE_CHANGE],
    } as const;
    const normal = buildToolDiffLines(ctxAt(120), event, "fs.edit");
    expect(stripAnsi(normal[0] ?? "")).toContain("+2");
    expect(stripAnsi(normal[0] ?? "")).toContain("−1");
    expect(normal).toHaveLength(2);

    const loud = buildToolDiffLines(ctxAt(120, { verbosity: "verbose" }), event, "fs.edit");
    expect(loud.length).toBeGreaterThan(normal.length);
    expect(loud.some((line) => stripAnsi(line).includes("const c = 4;"))).toBe(true);
  });

  it("suppresses every progress builder under quiet", () => {
    const ctx = ctxAt(80, { verbosity: "quiet" });
    for (const [kind, build] of BUILDERS) {
      if (kind === "assistant-message") continue;
      expect(build(ctx), kind).toEqual([]);
    }
    expect(
      buildAssistantMessageLines(ctx, { type: "assistant-message", text: "answer" }).length,
    ).toBeGreaterThan(0);
  });

  it("spells the ASCII exit suffix with the ASCII separator", () => {
    expect(
      stripAnsi(
        buildToolResultLines(ctxAt(80, { unicode: false }), {
          type: "tool-result",
          id: "c1",
          ok: false,
          exitCode: 126,
          summary: "x",
        })[0] ?? "",
      ),
    ).toBe("[failed] failed - 126 - not executable");
  });

  it("uses plain bracket prefixes instead of glyphs on ASCII surfaces", () => {
    const ctx = ctxAt(80, { unicode: false });
    expect(
      buildToolCallLines(ctx, {
        type: "tool-call",
        id: "c1",
        name: "shell.exec",
        argsDisplay: "ls",
      })[0],
    ).toMatch(/^\[tool\] shell\.exec/);
    expect(
      buildToolResultLines(ctx, {
        type: "tool-result",
        id: "c1",
        ok: false,
        exitCode: 127,
        summary: "boom",
      })[0],
    ).toMatch(/^\[failed\] failed - 127 - not found/);
  });

  it("keeps the outcome answer available to the renderer", () => {
    expect(FIXTURE_OUTCOME.answer).toContain("PDFs");
  });
});
