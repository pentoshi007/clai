import { describe, expect, it } from "vitest";
import { formatToolArgs } from "../../../src/agent/tool-call-parser.js";
import {
  buildFeedBlocks,
  toolBlockKind,
  type BlockKind,
} from "../../../src/classic/feed/feed-blocks.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { buildUserLines } from "../../../src/classic/blocks/user-lines.js";
import { buildThinkingLines } from "../../../src/classic/blocks/thinking-lines.js";
import { buildNoticeLines } from "../../../src/classic/blocks/notice-lines.js";
import { buildToolLines, toolElapsed, toolHeaderLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildBatchLines } from "../../../src/classic/blocks/batch-lines.js";
import { buildCompactedLines } from "../../../src/classic/blocks/compacted-lines.js";
import { buildTurnSummaryLines } from "../../../src/classic/blocks/turn-summary-lines.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import type { ToolItem, AssistantItem, UserItem } from "../../../src/ui-core/state/transcript-types.js";
import { transcriptItems } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, GOLDEN_COLOR_MODES, GOLDEN_WIDTHS, scriptedTurn } from "./fixture.js";

const turn = scriptedTurn();

describe("classic turn-summary colors", () => {
  it.each(["truecolor", "256", "none"] as const)("keeps the timing and colors the counts in %s", (colorMode) => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80, colorMode }));
    const row = buildTurnSummaryLines(ctx, {
      id: "summary", sequence: 0, turnId: undefined, timestamp: 0, kind: "turn-summary",
      durationMs: 76_000, status: "completed", changes: { added: 213, removed: 435 },
    })[0]!;
    expect(stripAnsi(row)).toContain("Worked for 1m16s · +213 -435");
    expect(row).toContain(ctx.ink.fg("success", "+213"));
    expect(row).toContain(ctx.ink.fg("diffDel", "-435"));
    if (colorMode === "none") expect(row).not.toContain("\x1b[");
  });
});

function kindsAt(columns: number): BlockKind[] {
  return buildFeedBlocks(turn.state, feedView(turn, { columns })).map((b) => b.kind);
}

describe("buildFeedBlocks", () => {
  it("produces one block per visible transcript item, in order", () => {
    expect(kindsAt(80)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool",
      "tool",
      "tool",
      "diff",
      "batch",
      "compacted",
    ]);
  });

  it("keeps notices out of the feed — the composition root routes them to toasts", () => {
    expect(kindsAt(80)).not.toContain("notice");
  });

  it("prepends the intro card as the first block when requested", () => {
    const blocks = buildFeedBlocks(
      turn.state,
      feedView(turn, { columns: 96, withIntro: true }),
    );
    expect(blocks[0]?.kind).toBe("intro");
    expect(blocks[0]?.itemId).toBe("intro");
    expect(blocks[0]?.sequence).toBe(-1);
  });

  it("routes tool items to tool, diff, and batch kinds", () => {
    const tools = transcriptItems(turn.state).filter(
      (item): item is ToolItem => item.kind === "tool",
    );
    const byName = new Map(tools.map((item) => [item.name, toolBlockKind(item)]));
    expect(byName.get("shell.exec")).toBe("tool");
    expect(byName.get("fs.edit")).toBe("diff");
    expect(byName.get("tool.batch")).toBe("batch");
  });

  it("hides filesystem elapsed time while showing shell searches", () => {
    const item = transcriptItems(turn.state).find(
      (candidate): candidate is ToolItem => candidate.kind === "tool" && candidate.name === "shell.exec",
    );
    expect(item).toBeDefined();
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    expect(toolElapsed(ctx, { ...item!, name: "fs.read" })).toBeUndefined();
    expect(toolElapsed(ctx, { ...item!, name: "fs.write" })).toBeUndefined();
    expect(toolElapsed(ctx, { ...item!, name: "shell.exec" })).toBeDefined();
    expect(toolElapsed(ctx, item!)).toBeDefined();
  });

  it("keeps compact headers while preserving status colors, timing and exit details", () => {
    const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 120 }));
    for (const status of ["running", "ok", "failed"] as const) {
      const item = { ...source, status, exitCode: status === "failed" ? 127 : 0 };
      const rows = toolHeaderLines(ctx, item);
      const header = rows.map(stripAnsi).join("\n");
      expect(rows).toHaveLength(1);
      expect(header).not.toMatch(/\b(running|failed|done)\b/);
      expect(header).toContain("• Shell");
      expect(header).toContain(toolElapsed(ctx, item)!);
      if (status === "failed") expect(header).toContain("127 · not found");
    }
  });

  it("shows explored files without read options or content", () => {
    const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    const item = { ...source, name: "fs.read", argsDisplay: "src/app.ts\noffset=12 · limit=8 · lines=12–19" };
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const text = buildToolLines(ctx, item).map(stripAnsi).join("\n");
    expect(text).toContain("• Explored");
    expect(text).toContain("  └ Read src/app.ts");
    expect(text).toContain("+ click to expand");
    expect(text).not.toMatch(/options|offset|limit|PASS src\/routes/);
  });

  it("shows only subagent titles in classic tool cards", () => {
    const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    const prompt = "do not display this prompt";
    const context = "do not display this context";
    const item = { ...source, name: "subagent.start_many", argsDisplay: formatToolArgs({
      name: "subagent.start_many", args: { assignments: [
        { title: "Map renderer", prompt, context }, { title: "Map classic", prompt, context },
      ] },
    }) };
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const text = buildToolLines(ctx, item).map(stripAnsi).join("\n");
    expect(text).toContain("subagent.start_many");
    expect(text).toContain("Map renderer, Map classic");
    expect(text).not.toContain(prompt);
    expect(text).not.toContain(context);
  });

  it("shows the first three lines and hidden count, not the output tail", () => {
    const previewTurn = scriptedTurn();
    const source = transcriptItems(previewTurn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    previewTurn.spool.replace(source.toolCallId, Array.from({ length: 10 }, (_, i) => `preview line ${i + 1}`).join("\n"));
    const ctx = blockContextFor(previewTurn.state, feedView(previewTurn, { columns: 80 }));
    const text = buildToolLines(ctx, source).map(stripAnsi).join("\n");
    for (const i of [1, 2, 3]) expect(text).toContain(`preview line ${i}`);
    for (const i of [4, 8, 9, 10]) expect(text).not.toContain(`preview line ${i}`);
    expect(text).toContain("+ click to expand (7 lines)");
  });

  it("clips huge output to the terminal width without extra preview rows", () => {
    const outputTurn = scriptedTurn();
    const source = transcriptItems(outputTurn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    const normal = `normal line ${"word ".repeat(18)}`.trim();
    outputTurn.spool.replace(source.toolCallId, [`{"payload":"${"z".repeat(20_000)}"}`, normal, "third", "fourth", "tail"].join("\n"));
    for (const columns of [40, 80, 120, 240]) {
      const ctx = blockContextFor(outputTurn.state, feedView(outputTurn, { columns }));
      const lines = buildToolLines(ctx, source);
      const plain = lines.map(stripAnsi);
      expect(lines).toHaveLength(5);
      expect(plain[1]).toContain("…");
      expect(plain[2]).toContain(normal.slice(0, 20));
      expect(plain[3]).toContain("third");
      for (const row of lines) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it("expands tabs in tool output so rows keep their measured width", () => {
    const tabbed = scriptedTurn();
    const source = transcriptItems(tabbed.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
    tabbed.spool.replace(source.toolCallId, "completed\tsuccess\tMerge pull request #36\tCI\tmain\tpush\n36617238855\t4m27s\t2026-09-29T19:09:34Z");
    const ctx = blockContextFor(tabbed.state, feedView(tabbed, { columns: 62 }));
    for (const row of buildToolLines(ctx, source)) {
      expect(row).not.toContain("\t");
      expect(displayWidth(row)).toBeLessThanOrEqual(62);
    }
  });

  it("keeps a three-row diff preview while output is minimized", () => {
    const diff = buildFeedBlocks({ ...turn.state, expandOutputGlobal: false, expandFileDiffsGlobal: true }, feedView(turn, { columns: 96 })).find((block) => block.kind === "diff")!;
    expect(diff.lines).toHaveLength(5);
    expect(diff.lines.map(stripAnsi).join("\n")).toContain("+ click to expand");
    expect(diff.lines.map(stripAnsi).join("\n")).not.toContain("- click to collapse");
  });

  it.each(["256", "truecolor"] as const)("retains syntax and full-width Codex diff fills in %s", (colorMode) => {
    const view = feedView(turn, { columns: 96, colorMode });
    const state = { ...turn.state, expandOutputGlobal: true };
    const diff = buildFeedBlocks(state, view).find((block) => block.kind === "diff")!;
    const addRow = diff.lines.find((line) => stripAnsi(line).includes("limit = 25"))!;
    const delRow = diff.lines.find((line) => stripAnsi(line).includes("findMany();"))!;
    expect(stripAnsi(addRow)).toMatch(/2 \+ /);
    expect(stripAnsi(delRow)).toMatch(/2 - /);
    expect(addRow).toContain(view.ink.hex("#569CD6", "const"));
    expect(delRow).toContain(view.ink.hex("#569CD6", "const"));
    expect(addRow).toContain(view.ink.band("X", 1, { bg: "diffAddBg" }).split("X")[0]!);
    expect(delRow).toContain(view.ink.band("X", 1, { bg: "diffDelBg" }).split("X")[0]!);
    expect(displayWidth(addRow)).toBe(96);
    expect(displayWidth(delRow)).toBe(96);
  });

  it("shows the same disclosure action for every output block state", () => {
    const kinds: readonly BlockKind[] = ["tool", "batch", "diff", "compacted"];
    for (const expanded of [false, true]) {
      const blocks = buildFeedBlocks({ ...turn.state, expandOutputGlobal: expanded }, feedView(turn, { columns: 96 }));
      for (const kind of kinds) {
        const text = blocks.filter((block) => block.kind === kind).flatMap((block) => block.lines).map(stripAnsi).join("\n");
        expect(text).toContain(expanded ? "- click to collapse" : "+ click to expand");
        expect(text).not.toContain(expanded ? "+ click to expand" : "- click to collapse");
      }
    }
  });

  it("keeps disclosure available for empty, failed, and compaction blocks", () => {
    const tools = transcriptItems(turn.state).filter((item): item is ToolItem => item.kind === "tool");
    const plain = tools.find((item) => item.name === "shell.exec" && item.status === "failed")!;
    const batch = tools.find((item) => item.name === "tool.batch")!;
    const compacted = transcriptItems(turn.state).find((item) => item.kind === "compacted")!;
    for (const expanded of [false, true]) {
      const ctx = blockContextFor({ ...turn.state, expandOutputGlobal: expanded }, feedView(turn, { columns: 40 }));
      const variants = [buildToolLines(ctx, { ...plain, summary: undefined }), buildBatchLines(ctx, { ...batch, toolCallId: plain.toolCallId }),
        buildCompactedLines(ctx, { ...compacted, summary: "" }), buildCompactedLines(ctx, { ...compacted, error: "provider rejected compaction" })];
      for (const rows of variants) {
        expect(rows.map(stripAnsi).join("\n")).toContain(expanded ? "- click to collapse" : "+ click to expand");
        for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(ctx.width);
      }
    }
  });

  it("keys blocks by generation so a reset cannot collide with prior keys", () => {
    const first = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, generation: 0 }));
    const second = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, generation: 1 }));
    expect(first[0]?.key).toBe("0:user-fevt-1");
    expect(second[0]?.key).toBe("1:user-fevt-1");
    expect(new Set(first.map((b) => b.key)).size).toBe(first.length);
  });

  it("marks the open batch tool as open and every settled block as closed", () => {
    const blocks = buildFeedBlocks(turn.state, feedView(turn, { columns: 80 }));
    const open = blocks.filter((b) => b.open).map((b) => b.kind);
    expect(open).toEqual(["batch"]);
  });

  it("is deterministic for identical inputs", () => {
    const a = buildFeedBlocks(turn.state, feedView(turn, { columns: 80 }));
    const b = buildFeedBlocks(turn.state, feedView(turn, { columns: 80 }));
    expect(a.map((x) => x.lines)).toEqual(b.map((x) => x.lines));
  });

  it("hides quiet meta tools entirely", () => {
    const view = feedView(turn, { columns: 80 });
    const state = turn.state;
    const quiet = transcriptItems(state).find(
      (item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec",
    );
    expect(quiet).toBeDefined();
    const withQuiet: typeof state = {
      ...state,
      byId: new Map(state.byId).set("quiet", {
        ...quiet!,
        id: "quiet",
        name: "task.update",
        status: "ok",
      }),
      order: [...state.order, "quiet"],
    };
    const before = buildFeedBlocks(state, view).length;
    expect(buildFeedBlocks(withQuiet, view).length).toBe(before);
  });

  it("renders every row of a very long block", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const item: AssistantItem = {
      id: "huge",
      kind: "assistant",
      streaming: false,
      sequence: 1,
      turnId: undefined,
      timestamp: 0,
      text: Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n"),
    };
    const state = {
      ...turn.state,
      order: ["huge"],
      byId: new Map([["huge", item as never]]),
    };
    const blocks = buildFeedBlocks(state, feedView(turn, { columns: 80 }));
    expect(blocks[0]!.lines.join("\n")).toContain("line 599");
    expect(blocks[0]!.lines.length).toBeGreaterThanOrEqual(600);
    expect(ctx.width).toBe(80);
  });
});

describe("golden fixtures", () => {
  for (const columns of GOLDEN_WIDTHS) {
    for (const colorMode of GOLDEN_COLOR_MODES) {
      for (const unicode of [true, false]) {
        const label = `${columns}c ${colorMode} ${unicode ? "unicode" : "ascii"}`;
        it(`renders the scripted turn at ${label}`, () => {
          const blocks = buildFeedBlocks(
            turn.state,
            feedView(turn, { columns, colorMode, unicode, withIntro: true }),
          );
          const snapshot = blocks
            .map((block) => `── ${block.kind} ${block.open ? "open" : "closed"}\n${block.lines.join("\n")}`)
            .join("\n");
          expect(snapshot).toMatchSnapshot();
        });
      }
    }
  }
});

describe("block builders", () => {
  it("collapses a user prompt past six rows", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 40 }));
    const item: UserItem = {
      id: "u",
      kind: "user",
      sequence: 1,
      turnId: undefined,
      timestamp: 0,
      text: Array.from({ length: 20 }, (_, i) => `paragraph number ${i} of the prompt`).join("\n"),
    };
    const lines = buildUserLines(ctx, item);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain("+");
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(ctx.width);
  });

  it("collapses thinking to a single header row by default", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const item = transcriptItems(turn.state).find((i) => i.kind === "thinking");
    expect(item).toBeDefined();
    const lines = buildThinkingLines(ctx, item as never);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("Reasoning");
    expect(stripAnsi(lines[0]!)).toContain("+ click to expand");
    expect(stripAnsi(lines[0]!)).toContain("Ctrl+T");
  });

  it("expands thinking when the global toggle is on", () => {
    const state = { ...turn.state, expandThinkingGlobal: true };
    const ctx = blockContextFor(state, feedView(turn, { columns: 80 }));
    const item = transcriptItems(state).find((i) => i.kind === "thinking");
    const lines = buildThinkingLines(ctx, item as never);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[0]!)).toContain("- click to collapse");
  });
});


describe("NoticeBlock (hydrated history only)", () => {
  const notice = {
    id: "n1",
    kind: "notice" as const,
    sequence: 1,
    turnId: undefined,
    timestamp: 0,
    level: "warn" as const,
    text: "provider fell back to nvidia because the primary key was rate limited",
  };

  it("uses a sparse warning bullet and aligned body", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 48 }));
    const lines = buildNoticeLines(ctx, notice);
    expect(stripAnsi(lines[0]!)).toContain("⚠ provider");
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[1]!).startsWith("  ")).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(ctx.width);
  });

  it("aligns notice text across levels without plates", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80, colorMode: "none" }));
    const widths = (["info", "warn", "error"] as const).map((level) => buildNoticeLines(ctx, { ...notice, level, text: "x" })[0]!.indexOf("x"));
    expect(new Set(widths).size).toBe(1);
  });
});

describe("classic reasoning and compaction timers", () => {
  it("renders live elapsed labels in both card headers", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 96 }));
    const thinking = transcriptItems(turn.state).find(
      (item) => item.kind === "thinking",
    );
    const compacted = transcriptItems(turn.state).find(
      (item) => item.kind === "compacted",
    );
    expect(thinking).toBeDefined();
    expect(compacted).toBeDefined();

    const thinkingLines = buildThinkingLines(ctx, {
      ...thinking!,
      streaming: true,
      startedAt: ctx.now - 12_000,
      endedAt: undefined,
    } as never);
    const compactedLines = buildCompactedLines(ctx, {
      ...compacted!,
      streaming: true,
      startedAt: ctx.now - 12_000,
      endedAt: undefined,
    } as never);

    expect(stripAnsi(thinkingLines[0]!)).toContain("12s");
    expect(stripAnsi(compactedLines[0]!)).toContain("12s");
  });
});
