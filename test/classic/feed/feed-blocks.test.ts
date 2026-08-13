import { describe, expect, it } from "vitest";
import {
  buildFeedBlocks,
  MAX_BLOCK_ROWS,
  toolBlockKind,
  type BlockKind,
} from "../../../src/classic/feed/feed-blocks.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { buildUserLines } from "../../../src/classic/blocks/user-lines.js";
import { buildThinkingLines } from "../../../src/classic/blocks/thinking-lines.js";
import { buildNoticeLines } from "../../../src/classic/blocks/notice-lines.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildBatchLines } from "../../../src/classic/blocks/batch-lines.js";
import { buildCompactedLines } from "../../../src/classic/blocks/compacted-lines.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import type { ToolItem, UserItem } from "../../../src/ui-core/state/transcript-types.js";
import { transcriptItems } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, GOLDEN_COLOR_MODES, GOLDEN_WIDTHS, scriptedTurn } from "./fixture.js";

const turn = scriptedTurn();

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

  it("keeps diff hunks visible while tool output is minimized", () => {
    const state = { ...turn.state, expandOutputGlobal: false, expandFileDiffsGlobal: true };
    const diff = buildFeedBlocks(state, feedView(turn, { columns: 96 })).find(
      (block) => block.kind === "diff",
    );
    expect(diff).toBeDefined();
    const text = diff!.lines.map(stripAnsi).join("\n");
    expect(text).toContain("Ctrl+O to expand");
    expect(text).not.toContain("Ctrl+O to minimize");
    expect(text).not.toContain("file  /repo/src/routes/users.ts");
    expect(diff!.lines.length).toBeGreaterThan(4);
  });

  it("shows the Ctrl+O action for every output card state", () => {
    const outputKinds: readonly BlockKind[] = ["tool", "batch", "diff", "compacted"];
    for (const [expanded, label, otherLabel] of [
      [false, "Ctrl+O to expand", "Ctrl+O to minimize"],
      [true, "Ctrl+O to minimize", "Ctrl+O to expand"],
    ] as const) {
      const state = { ...turn.state, expandOutputGlobal: expanded };
      const blocks = buildFeedBlocks(state, feedView(turn, { columns: 96 }));
      for (const kind of outputKinds) {
        const text = blocks
          .filter((block) => block.kind === kind)
          .flatMap((block) => block.lines)
          .map(stripAnsi)
          .join("\n");
        expect(text, `${kind} ${expanded ? "expanded" : "collapsed"}`).toContain(label);
        expect(text, `${kind} ${expanded ? "expanded" : "collapsed"}`).not.toContain(otherLabel);
      }
    }
  });

  it("shows the Ctrl+O action when output bodies are empty or failed", () => {
    const tools = transcriptItems(turn.state).filter(
      (item): item is ToolItem => item.kind === "tool",
    );
    const plain = tools.find((item) => item.name === "shell.exec" && item.status === "failed");
    const batch = tools.find((item) => item.name === "tool.batch");
    const compacted = transcriptItems(turn.state).find((item) => item.kind === "compacted");
    expect(plain).toBeDefined();
    expect(batch).toBeDefined();
    expect(compacted).toBeDefined();

    for (const [expanded, label] of [
      [false, "Ctrl+O to expand"],
      [true, "Ctrl+O to minimize"],
    ] as const) {
      const state = { ...turn.state, expandOutputGlobal: expanded };
      const ctx = blockContextFor(state, feedView(turn, { columns: 40 }));
      const variants = [
        buildToolLines(ctx, { ...plain!, summary: undefined }),
        buildBatchLines(ctx, { ...batch!, toolCallId: plain!.toolCallId }),
        buildCompactedLines(ctx, { ...compacted!, summary: "" }),
        buildCompactedLines(ctx, { ...compacted!, error: "provider rejected compaction" }),
      ];
      for (const lines of variants) {
        expect(lines.map(stripAnsi).join("\n")).toContain(label);
        for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(ctx.width);
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

  it("bounds a pathological block to MAX_BLOCK_ROWS", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const item: UserItem = {
      id: "huge",
      kind: "user",
      sequence: 1,
      turnId: undefined,
      timestamp: 0,
      text: Array.from({ length: MAX_BLOCK_ROWS + 200 }, (_, i) => `line ${i}`).join("\n"),
    };
    const state = {
      ...turn.state,
      order: ["huge"],
      byId: new Map([["huge", item as never]]),
    };
    const blocks = buildFeedBlocks(state, feedView(turn, { columns: 80 }));
    expect(blocks[0]!.lines.length).toBeLessThanOrEqual(MAX_BLOCK_ROWS);
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
    expect(lines[0]).toContain("thinking");
    expect(lines[0]).toContain("Ctrl+T to expand");
  });

  it("expands thinking when the global toggle is on", () => {
    const state = { ...turn.state, expandThinkingGlobal: true };
    const ctx = blockContextFor(state, feedView(turn, { columns: 80 }));
    const item = transcriptItems(state).find((i) => i.kind === "thinking");
    const lines = buildThinkingLines(ctx, item as never);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("Ctrl+T to hide");
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
    text: "provider fell back to groq because the primary key was rate limited",
  };

  it("renders a fixed-width plate and a 7-column body", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 48 }));
    const lines = buildNoticeLines(ctx, notice);
    expect(lines[0]).toContain("WARN");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]!.startsWith("       ")).toBe(true);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(ctx.width);
  });

  it("keeps the plate width identical across levels", () => {
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80, colorMode: "none" }));
    const widths = (["info", "warn", "error"] as const).map(
      (level) => buildNoticeLines(ctx, { ...notice, level, text: "x" })[0]!.indexOf("x"),
    );
    expect(new Set(widths).size).toBe(1);
  });
});
