import { describe, expect, it } from "vitest";
import type { ColorMode } from "../../../src/app/ports/terminal-port.js";
import { buildBatchLines } from "../../../src/classic/blocks/batch-lines.js";
import { diffTitleLine } from "../../../src/classic/blocks/diff-lines.js";
import { buildToolBodyLines, toolGlyph, toolHeaderLines } from "../../../src/classic/blocks/tool-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { createInkTheme, type ThemeToken } from "../../../src/classic/render/ink-theme.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { classicToolLabel } from "../../../src/classic/blocks/tool-label.js";
import { transcriptItems, type ToolItem, type ToolStatus } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const STATUS_COLORS: Readonly<Record<ToolStatus, ThemeToken>> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "diffDel",
};
const COLOR_MODES: readonly ColorMode[] = ["truecolor", "256", "16", "none"];
const STATUSES = Object.keys(STATUS_COLORS) as ToolStatus[];

function fixture(themeHint: "dark" | "light", colorMode: ColorMode, expanded = false) {
  const turn = scriptedTurn();
  const item = transcriptItems(turn.state).find(
    (entry): entry is ToolItem => entry.kind === "tool" && entry.name === "shell.exec",
  )!;
  const ink = createInkTheme({ themeHint, colorMode, unicode: true });
  const ctx = blockContextFor(
    { ...turn.state, expandOutputGlobal: expanded },
    { ...feedView(turn, { columns: 120 }), ink },
  );
  return { ctx, item, turn };
}

describe.each(["dark", "light"] as const)("classic tool colors in the %s theme", (themeHint) => {
  it.each(COLOR_MODES)("matches OpenTUI tool states, input and output in %s", (colorMode) => {
    const { ctx, item, turn } = fixture(themeHint, colorMode);
    turn.spool.replace(item.toolCallId, "COLOR_OUTPUT");
    for (const status of STATUSES) {
      const tool = { ...item, status, argsDisplay: "echo COLOR_INPUT" };
      const header = toolHeaderLines(ctx, tool).join("\n");
      expect(header).toContain(ctx.ink.fg(STATUS_COLORS[status], toolGlyph(ctx, status)));
      expect(header).toContain(ctx.ink.style(classicToolLabel(tool), { fg: STATUS_COLORS[status], bold: true }));
      expect(header).toContain(ctx.ink.fg("inputBorder", "echo COLOR_INPUT"));
      const output = buildToolBodyLines(ctx, tool).join("\n");
      expect(output).toContain(ctx.ink.fg("toolOutput", "COLOR_OUTPUT"));
      expect(output).toContain(ctx.ink.fg("toolOutput", `  ${ctx.glyphs.bodyBranch} `));
      if (colorMode === "none") expect(header + output).not.toContain("\x1b[");
    }
  });

  it.each(COLOR_MODES)("matches wrapped and expanded input colors in %s", (colorMode) => {
    for (const expanded of [false, true]) {
      const { ctx, item } = fixture(themeHint, colorMode, expanded);
      const header = toolHeaderLines(ctx, { ...item, argsDisplay: "FIRST_INPUT\nSECOND_INPUT\nTHIRD_INPUT" });
      expect(header[0]).toContain(ctx.ink.fg("inputBorder", "FIRST_INPUT …"));
      expect(header.join("\n").includes(ctx.ink.fg("inputBorder", "SECOND_INPUT"))).toBe(expanded);
      expect(header.map(stripAnsi).join("\n").includes("THIRD_INPUT")).toBe(expanded);
    }
  });

  it.each(COLOR_MODES)("preserves fs.read field colors in %s", (colorMode) => {
    const { ctx, item } = fixture(themeHint, colorMode);
    const header = toolHeaderLines(ctx, {
      ...item, name: "fs.read", argsDisplay: JSON.stringify({ path: "src/app.ts", limit: 8 }),
    }).join("\n");
    expect(header).toContain(ctx.ink.fg("toolOutput", "Read"));
    expect(header).toContain(ctx.ink.fg("inputBorder", "src/app.ts"));
    expect(stripAnsi(header)).not.toMatch(/options|limit=8|file:/);
  });

  it.each(COLOR_MODES)("matches diff header state colors without changing stats in %s", (colorMode) => {
    const { ctx, turn } = fixture(themeHint, colorMode);
    const item = transcriptItems(turn.state).find(
      (entry): entry is ToolItem => entry.kind === "tool" && entry.name === "fs.edit",
    )!;
    for (const status of STATUSES) {
      const header = diffTitleLine(ctx, { ...item, status }, item.fileChanges![0]);
      expect(header).toContain(ctx.ink.fg(STATUS_COLORS[status], toolGlyph(ctx, status)));
      const verb = status === "ok" ? "Edited" : status === "failed" || status === "blocked" ? "Edit failed" : "Editing";
      expect(header).toContain(ctx.ink.style(verb, { fg: STATUS_COLORS[status], bold: true }));
      expect(header).toContain(ctx.ink.style("+3", { fg: "success", bold: true }));
      expect(header).toContain(ctx.ink.style("-2", { fg: "diffDel", bold: true }));
    }
  });

  it.each(COLOR_MODES)("matches batch section state and output colors in %s", (colorMode) => {
    const { ctx, item, turn } = fixture(themeHint, colorMode, true);
    turn.spool.replace(item.toolCallId, [
      "── #1 shell.exec [running]", "RUNNING_OUTPUT",
      "── #2 fs.read [ok exit=0]", "SUCCESS_OUTPUT",
      "── #3 web.fetch [fail exit=1]", "FAILED_OUTPUT",
      "── #4 http.fetch [cancelled]", "CANCELLED_OUTPUT",
    ].join("\n"));
    const rows = buildBatchLines(ctx, { ...item, name: "tool.batch" });
    for (const [name, token, output] of [
      ["Shell", "activity", "RUNNING_OUTPUT"],
      ["Explored", "success", "SUCCESS_OUTPUT"],
      ["Opened", "diffDel", "FAILED_OUTPUT"],
      ["Fetched", "muted", "CANCELLED_OUTPUT"],
    ] as const) {
      const row = rows.find((line) => stripAnsi(line).trimStart().includes(name) && !stripAnsi(line).includes("tool.batch"));
      expect(row).toContain(ctx.ink.fg(token, name));
      expect(rows.join("\n")).toContain(ctx.ink.fg("toolOutput", output));
    }
  });

  it.each(COLOR_MODES)("matches collapsed output gap colors in %s", (colorMode) => {
    const { ctx, item, turn } = fixture(themeHint, colorMode);
    turn.spool.replace(item.toolCallId, Array.from({ length: 10 }, (_, i) => `OUTPUT_${i}`).join("\n"));
    const rows = buildToolBodyLines(ctx, item);
    const disclosure = rows.find((line) => stripAnsi(line).includes("7 lines"))!;
    expect(disclosure).toContain(ctx.ink.fg("hint", "+ click to expand"));
    expect(disclosure).toContain(ctx.ink.fg("hint", " (7 lines) · Ctrl+O"));
    expect(rows.join("\n")).toContain(ctx.ink.fg("toolOutput", "OUTPUT_0"));
    expect(rows.join("\n")).toContain(ctx.ink.fg("toolOutput", "OUTPUT_2"));
    expect(stripAnsi(rows.join("\n"))).not.toContain("OUTPUT_9");
  });
});
