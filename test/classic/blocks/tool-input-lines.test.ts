import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { buildToolBodyLines, toolHeaderLines } from "../../../src/classic/blocks/tool-lines.js";
import { blockContextFor, buildFeedBlocks, FeedBlockCache } from "../../../src/classic/feed/feed-blocks.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { presentTool } from "../../../src/ui-core/rendering/tool-presenter.js";
import { EMPTY_TRANSCRIPT_STATE, transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness } from "../app/harness.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const turn = scriptedTurn();
const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;

function tool(argsDisplay: string, name = "shell.exec"): ToolItem {
  return { ...source, name, argsDisplay, status: "ok", endedAt: undefined };
}

function header(item: ToolItem, columns: number, expanded = false): string[] {
  const state = { ...turn.state, expandOutputGlobal: expanded };
  const ctx = blockContextFor(state, feedView(turn, { columns }));
  const rows = toolHeaderLines(ctx, item);
  for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
  return rows.map(stripAnsi);
}

describe("classic tool-input previews", () => {
  it("shows at most two input rows and no click-for-full hint", () => {
    const command = "echo first\necho second\necho third\necho fourth\necho fifth";
    const item = tool(command);
    const rows = header(item, 80);
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain("echo first");
    expect(rows.join("\n")).toContain("echo second");
    expect(rows.join("\n")).not.toContain("echo third");
    expect(rows.at(-1)).toContain("…");
    expect(rows.join("\n")).not.toContain("click for full");
    expect(item.argsDisplay).toBe(command);
    expect(presentTool(item).argsDisplay).toContain("click for full");
  });

  it.each([18, 40, 80])("limits wrapped input to two rows at %i columns and expands every character", (columns) => {
    const command = `printf '${"wide界🙂 text ".repeat(100)}FINAL_ARGUMENT_TOKEN'`;
    const item = tool(command);
    const preview = header(item, columns);
    expect(preview.length).toBeLessThanOrEqual(3);
    expect(preview.join("\n")).not.toContain("FINAL_ARGUMENT_TOKEN");
    const expanded = header(item, columns, true);
    expect(expanded.slice(1).join("").replace(/\s/g, "")).toBe(`(${command})`.replace(/\s/g, ""));
    expect(expanded.join("\n")).not.toContain("click for full");
  });

  it("shows all logical lines, blank lines, and indentation when expanded", () => {
    const command = ["python3 - <<'PY'", "", "if True:", "    print('preserved indentation')", "", "PY", "echo LAST_INPUT_LINE"].join("\n");
    const rows = header(tool(command), 80, true);
    expect(rows.join("\n")).toContain("LAST_INPUT_LINE");
    expect(rows.join("\n")).toContain("(    print('preserved indentation'))");
    expect(rows.filter((row) => row.trim() === "()")).toHaveLength(2);
  });

  it.each(["terminal.start", "web.search", "tool.batch"])("applies the same preview budget to %s", (name) => {
    const rows = header(tool("first input\nsecond input\nthird input\nfourth input", name), 40);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.join("\n")).not.toContain("third input");
    expect(header(tool("first input\nsecond input\nthird input\nfourth input", name), 40, true).join("\n")).toContain("fourth input");
  });

  it.each([18, 40, 80, 120])("keeps every fs.read path and option untruncated at %i columns", (columns) => {
    const lastPath = `src/${"nested界🙂/".repeat(20)}last-file.ts`;
    const pattern = `${"needle_".repeat(40)}LAST_PATTERN_TOKEN`;
    const item = tool(JSON.stringify({ files: [
      { path: "first-file.ts", offset: 1, limit: 10 },
      { path: "second-file.ts", pattern, context: 2 },
      { path: lastPath, limit: 50 },
    ] }), "fs.read");
    const collapsed = header(item, columns);
    const text = collapsed.join("\n").replace(/\s/g, "");
    expect(collapsed.length).toBeGreaterThan(3);
    expect(text).toContain("first-file.ts");
    expect(text).toContain("second-file.ts");
    expect(text).toContain(lastPath);
    expect(text).toContain(`pattern="${pattern}"`);
    expect(text).toContain("context=2");
    expect(text).toContain("limit=50");
    expect(text).not.toMatch(/…|clickforfull/);
    expect(header(item, columns, true)).toEqual(collapsed);
    expect(item.argsDisplay).toBe(JSON.stringify({ files: [
      { path: "first-file.ts", offset: 1, limit: 10 },
      { path: "second-file.ts", pattern, context: 2 },
      { path: lastPath, limit: 50 },
    ] }));
  });

  it.each([18, 40, 80, 120])("keeps a single fs.read path and long filters complete at %i columns", (columns) => {
    const path = `src/${"nested/".repeat(30)}FINAL_PATH.ts`;
    const pattern = `${"long_filter_".repeat(40)}FINAL_FILTER`;
    const item = tool(JSON.stringify({ path, pattern, context: 3, caseInsensitive: true, maxMatches: 100 }), "fs.read");
    const rows = header(item, columns);
    const text = rows.join("\n").replace(/\s/g, "");
    expect(text).toContain(path);
    expect(text).toContain(`pattern="${pattern}"`);
    expect(text).toContain("context=3");
    expect(text).toContain("caseInsensitive=true");
    expect(text).toContain("maxMatches=100");
    expect(text).not.toContain("…");
    expect(rows).toEqual(header(item, columns, true));
  });

  it("shows all ten supported fs.read inputs without an expansion toggle", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `src/INPUT_FILE_${index}.ts`, offset: index + 1, limit: 8 }));
    const item = tool(JSON.stringify({ files }), "fs.read");
    const rows = header(item, 40);
    expect(rows).toHaveLength(21);
    for (const file of files) {
      expect(rows.join("\n")).toContain(file.path);
      expect(rows.join("\n")).toContain(`offset=${file.offset}`);
    }
    expect(rows).toEqual(header(item, 40, true));
  });

  it("keeps short inline inputs and tool output unchanged", () => {
    const item = tool("echo ok");
    expect(header(item, 80)).toEqual(["✓ shell.exec (echo ok)"]);
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const body = buildToolBodyLines(ctx, item);
    expect(buildToolBodyLines(ctx, tool("first\nsecond\nthird\nfourth"))).toEqual(body);
  });

  it("keeps restored terminal secret inputs redacted even when expanded", () => {
    const item = tool(JSON.stringify({ id: "terminal-id", kind: "secret", text: "do-not-display-this-value" }), "terminal.send");
    const rows = header(item, 80, true).join("\n");
    expect(rows).toContain("secret=[local input]");
    expect(rows).not.toContain("do-not-display-this-value");
  });

  it("expands and collapses the complete stored input through the actual Ctrl+O key", () => {
    const harness = createHarness();
    const command = Array.from({ length: 20 }, (_, index) => `echo INPUT_LINE_${index}`).join("\n");
    const item = tool(command);
    const cache = new FeedBlockCache();
    const view = feedView(turn, { columns: 80 });
    try {
      harness.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
      const text = (): string => buildFeedBlocks(harness.services.transcript.getState(), view, cache)
        .flatMap((block) => block.lines).map(stripAnsi).join("\n");
      expect(text()).not.toContain("INPUT_LINE_19");
      harness.wiring.handleData("\x0f");
      expect(harness.services.transcript.getState().expandOutputGlobal).toBe(true);
      expect(text()).toContain("INPUT_LINE_19");
      expect(text()).toContain("Ctrl+O to minimize");
      expect(text()).not.toContain("click for full");
      expect(harness.services.transcript.getState().byId.get(item.id)).toEqual(item);
      harness.wiring.handleData("\x0f");
      expect(harness.services.transcript.getState().expandOutputGlobal).toBe(false);
      expect(text()).not.toContain("INPUT_LINE_19");
      expect(text()).toContain("Ctrl+O to expand");
    } finally {
      harness.dispose();
    }
  });

  it("reveals the hidden input in the live ClassicApp frame and collapses it again", async () => {
    const harness = createHarness({ rows: 30 });
    const item = tool(Array.from({ length: 20 }, (_, index) => `echo FRAME_INPUT_${index}`).join("\n"));
    harness.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
    const ui = render(createElement(ServicesProvider, {
      services: harness.services,
      children: createElement(ClassicApp, { wiring: harness.wiring }),
    }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("FRAME_INPUT_0"));
      expect(ui.lastFrame()).not.toContain("FRAME_INPUT_19");
      expect(ui.lastFrame()).not.toContain("click for full");
      harness.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("FRAME_INPUT_19"));
      expect(ui.lastFrame()).toContain("Ctrl+O to minimize");
      harness.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("FRAME_INPUT_19"));
      expect(ui.lastFrame()).toContain("Ctrl+O to expand");
      expect(harness.services.transcript.getState().byId.get(item.id)).toEqual(item);
    } finally {
      ui.unmount();
      ui.cleanup();
      harness.dispose();
    }
  });

  it("shows all fs.read inputs in live collapsed frames before and after Ctrl+O", async () => {
    const harness = createHarness({ columns: 80, rows: 70 });
    const files = Array.from({ length: 6 }, (_, index) => ({
      path: `src/${"nested/".repeat(6)}INPUT_FILE_${index}.ts`,
      offset: index + 1, limit: 8, pattern: `READ_PATTERN_${index}`,
    }));
    const item = tool(JSON.stringify({ files }), "fs.read");
    harness.services.session.spool.replace(item.toolCallId, "UNMODIFIED_READ_OUTPUT");
    harness.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
    const ui = render(createElement(ServicesProvider, {
      services: harness.services,
      children: createElement(ClassicApp, { wiring: harness.wiring }),
    }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("INPUT_FILE_5.ts"));
      expect(ui.lastFrame()).toContain("READ_PATTERN_5");
      expect(harness.services.transcript.getState().expandOutputGlobal).toBe(false);
      harness.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Ctrl+O to minimize"));
      expect(ui.lastFrame()).toContain("INPUT_FILE_5.ts");
      expect(ui.lastFrame()).toContain("READ_PATTERN_5");
      harness.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Ctrl+O to expand"));
      expect(ui.lastFrame()).toContain("INPUT_FILE_5.ts");
      expect(ui.lastFrame()).toContain("READ_PATTERN_5");
      expect(harness.services.transcript.getState().byId.get(item.id)).toEqual(item);
      expect(harness.services.session.spool.tail(item.toolCallId)).toBe("UNMODIFIED_READ_OUTPUT");
    } finally {
      ui.unmount();
      ui.cleanup();
      harness.dispose();
    }
  });
});
