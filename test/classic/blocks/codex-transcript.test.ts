import { describe, expect, it } from "vitest";
import { buildToolLines, toolHeaderLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildDiffLines } from "../../../src/classic/blocks/diff-lines.js";
import { buildUserLines } from "../../../src/classic/blocks/user-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { buildFileChange } from "../../../src/tools/file-diff.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

function fixture(expanded = false, columns = 120) {
  const turn = scriptedTurn();
  const item = transcriptItems(turn.state).find((candidate): candidate is ToolItem => candidate.kind === "tool" && candidate.name === "shell.exec")!;
  const state = { ...turn.state, expandOutputGlobal: expanded };
  return { turn, item: { ...item, endedAt: undefined }, ctx: blockContextFor(state, feedView(turn, { columns, colorMode: "none" })) };
}

describe("Codex-style classic transcript", () => {
  it("renders a single input line and the first three output lines", () => {
    const { turn, item, ctx } = fixture();
    const command = "python3 - <<'PY'\nprint('hidden input')\nPY";
    turn.spool.replace(item.toolCallId, Array.from({ length: 10 }, (_, i) => `OUTPUT_${i}`).join("\n"));
    const rows = buildToolLines(ctx, { ...item, argsDisplay: command }).map(stripAnsi);
    expect(rows[0]).toBe("• Shell python3 - <<'PY' …");
    expect(rows.slice(1, 4)).toEqual(["  └ OUTPUT_0", "    OUTPUT_1", "    OUTPUT_2"]);
    expect(rows).toHaveLength(5);
    expect(rows[4]).toContain("+ click to expand");
    expect(rows[4]).toContain("7 lines");
    expect(rows.join("\n")).not.toMatch(/hidden input|OUTPUT_9/);
    expect(command).toBe("python3 - <<'PY'\nprint('hidden input')\nPY");
  });

  it.each([18, 40, 80, 240])("clips giant preview lines without adding rows at %i columns", (columns) => {
    const { turn, item, ctx } = fixture(false, columns);
    turn.spool.replace(item.toolCallId, `${"界🙂".repeat(10_000)}\nSECOND\nTHIRD\nFOURTH`);
    const rows = buildToolLines(ctx, { ...item, argsDisplay: "echo input" });
    expect(toolHeaderLines(ctx, item)).toHaveLength(1);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toContain("…");
    expect(rows.map(stripAnsi).join("\n")).toContain("THIRD");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(ctx.width);
  });

  it("lists explored files without options, counts, or JSON", () => {
    const { item, ctx } = fixture();
    const rows = buildToolLines(ctx, { ...item, name: "fs.read", argsDisplay: JSON.stringify({ files: [
      { path: "src/first.ts", offset: 30, limit: 8 },
      { path: "src/second.ts", pattern: "needle", context: 2 },
    ] }) }).map(stripAnsi);
    expect(rows[0]).toBe("• Explored");
    expect(rows[1]).toBe("  └ Read src/first.ts");
    expect(rows[2]).toBe("    Read src/second.ts");
    expect(rows.join("\n")).not.toMatch(/offset|limit|needle|options|file 1|\{"/);
    expect(rows.at(-1)).toContain("+ click to expand");
  });

  it("shows all retained output including blank and repeated lines when expanded", () => {
    const { item, turn, ctx } = fixture(true);
    const output = ["same", "same", "", "", ...Array.from({ length: 80 }, (_, i) => `ROW_${i}`)].join("\n");
    turn.spool.replace(item.toolCallId, output);
    const text = buildToolLines(ctx, { ...item, argsDisplay: "first\n    last" }).map(stripAnsi).join("\n");
    expect(text).toContain("    last");
    expect(text).toContain("  └ same\n    same\n\n");
    expect(text).toContain("ROW_79");
    expect(text).toContain("- click to collapse");
    expect(turn.spool.tail(item.toolCallId)).toBe(output);
  });

  it("puts diff paths and counts inline and removes the vertical rail", () => {
    const { item, ctx } = fixture();
    const change = buildFileChange({ path: "src/app.ts", kind: "edit", before: "const old = 1;", after: "const next = 2;" });
    const rows = buildDiffLines(ctx, { ...item, name: "fs.edit", fileChanges: [change] }).map(stripAnsi);
    expect(rows[0]).toBe("• Edited src/app.ts (+1 -1)");
    expect(rows[1]).toMatch(/^\s+1 - const old = 1;/);
    expect(rows[2]).toMatch(/^\s+1 \+ const next = 2;/);
    expect(rows.join("\n")).not.toContain("│");
  });

  it.each(["failed", "blocked"] as const)("retains %s file-operation diagnostics with and without partial changes", (status) => {
    const { item, ctx, turn } = fixture();
    const message = "ENOENT: target unavailable\nSECOND\nTHIRD\nFULL_ERROR";
    const change = buildFileChange({ path: "src/first.ts", kind: "create", before: "", after: "created" });
    for (const fileChanges of [undefined, [change]]) {
      const failed = { ...item, name: "fs.write", argsDisplay: "src/missing.ts", status, reason: message, summary: message, fileChanges };
      turn.spool.replace(item.toolCallId, "");
      const compact = buildDiffLines(ctx, failed).map(stripAnsi).join("\n");
      expect(compact).toContain("ENOENT: target unavailable");
      expect(compact).toContain("THIRD");
      expect(compact).not.toContain("FULL_ERROR");
      const expandedCtx = { ...ctx, state: { ...ctx.state, expandOutputGlobal: true } };
      const expanded = buildDiffLines(expandedCtx, failed).map(stripAnsi);
      expect(expanded.join("\n")).toContain("FULL_ERROR");
      expect(expanded.every(row => displayWidth(row) <= ctx.width)).toBe(true);
    }
  });

  it("uses a prompt chevron with aligned continuation lines", () => {
    const { ctx } = fixture();
    const rows = buildUserLines(ctx, { id: "prompt", kind: "user", timestamp: 0, sequence: 0, turnId: undefined, text: "first\nsecond" }).map(stripAnsi);
    expect(rows).toEqual(["› first", "  second"]);
  });
});
