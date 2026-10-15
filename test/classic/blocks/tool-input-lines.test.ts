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
  it("shows one input row without changing the shared presenter", () => {
    const command = "echo first\necho second\necho third\necho fourth\necho fifth";
    const item = tool(command);
    expect(header(item, 80)).toEqual(["• Shell echo first …"]);
    expect(item.argsDisplay).toBe(command);
    expect(presentTool(item).argsDisplay).toContain("click for full");
  });

  it.each([18, 40, 80])("clips input to one row at %i columns and expands every character", (columns) => {
    const command = `printf '${"wide界🙂 text ".repeat(100)}FINAL_ARGUMENT_TOKEN'`;
    const item = tool(command);
    const preview = header(item, columns);
    expect(preview).toHaveLength(1);
    expect(preview.join("\n")).not.toContain("FINAL_ARGUMENT_TOKEN");
    const expanded = header(item, columns, true);
    expect(expanded.slice(2).join("").replace(/\s/g, "")).toBe(command.replace(/\s/g, ""));
    expect(expanded.join("\n")).not.toContain("click for full");
  });

  it("preserves all logical lines, blank lines, and indentation when expanded", () => {
    const command = ["python3 - <<'PY'", "", "if True:", "    print('preserved indentation')", "", "PY", "echo LAST_INPUT_LINE"].join("\n");
    const rows = header(tool(command), 80, true);
    expect(rows.join("\n")).toContain("LAST_INPUT_LINE");
    expect(rows.join("\n")).toContain("        print('preserved indentation')");
    expect(rows.filter((row) => row === "")).toHaveLength(2);
  });

  it.each(["terminal.start", "web.search", "tool.batch"])("uses a one-row preview for %s", (name) => {
    const item = tool("first input\nsecond input\nthird input\nfourth input", name);
    expect(header(item, 40)).toHaveLength(1);
    expect(header(item, 40).join("\n")).not.toContain("second input");
    expect(header(item, 40, true).join("\n")).toContain("fourth input");
  });

  it.each([18, 40, 80, 120])("keeps fs.read file lists option-free and full details recoverable at %i columns", (columns) => {
    const lastPath = `src/${"nested界🙂/".repeat(20)}last-file.ts`;
    const pattern = `${"needle_".repeat(40)}LAST_PATTERN_TOKEN`;
    const args = JSON.stringify({ files: [
      { path: "first.ts", offset: 1, limit: 10 },
      { path: "second.ts", pattern, context: 2 },
      { path: lastPath, limit: 50 },
    ] });
    const item = tool(args, "fs.read");
    const collapsed = header(item, columns);
    expect(collapsed).toHaveLength(4);
    expect(collapsed.join("\n")).toContain("first.ts");
    expect(collapsed.join("\n")).not.toMatch(/options|offset|limit|pattern|context/);
    const expanded = header(item, columns, true).join("\n").replace(/\s/g, "");
    expect(expanded).toContain(lastPath);
    expect(expanded).toContain(pattern);
    expect(expanded).toContain('"context":2');
    expect(item.argsDisplay).toBe(args);
  });

  it.each([18, 40, 80, 120])("recovers long single-file inputs and filters at %i columns", (columns) => {
    const path = `src/${"nested/".repeat(30)}FINAL_PATH.ts`;
    const pattern = `${"long_filter_".repeat(40)}FINAL_FILTER`;
    const item = tool(JSON.stringify({ path, pattern, context: 3, caseInsensitive: true, maxMatches: 100 }), "fs.read");
    expect(header(item, columns)).toHaveLength(2);
    expect(header(item, columns).join("\n")).not.toContain("FINAL_FILTER");
    const full = header(item, columns, true).join("\n").replace(/\s/g, "");
    expect(full).toContain(path);
    expect(full).toContain(pattern);
    expect(full).toContain('"caseInsensitive":true');
    expect(full).toContain('"maxMatches":100');
  });

  it("lists all ten supported files compactly", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `src/FILE_${index}.ts`, offset: index + 1, limit: 8 }));
    const rows = header(tool(JSON.stringify({ files }), "fs.read"), 40);
    expect(rows).toHaveLength(11);
    for (const file of files) expect(rows.join("\n")).toContain(file.path);
    expect(rows.join("\n")).not.toContain("offset");
  });

  it("uses inline short inputs and leaves output independent of argument shape", () => {
    const item = tool("echo ok");
    expect(header(item, 80)).toEqual(["• Shell echo ok"]);
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    expect(buildToolBodyLines(ctx, tool("first\nsecond\nthird\nfourth"))).toEqual(buildToolBodyLines(ctx, item));
  });

  it("keeps restored terminal secret inputs redacted even when expanded", () => {
    const item = tool(JSON.stringify({ id: "terminal-id", kind: "secret", text: "do-not-display-this-value" }), "terminal.send");
    const rows = header(item, 80, true).join("\n");
    expect(rows).toContain("secret=[local input]");
    expect(rows).not.toContain("do-not-display-this-value");
  });

  it("expands and collapses complete stored input through Ctrl+O", () => {
    const h = createHarness();
    const item = tool(Array.from({ length: 20 }, (_, index) => `echo INPUT_LINE_${index}`).join("\n"));
    const cache = new FeedBlockCache();
    const view = feedView(turn, { columns: 80 });
    try {
      h.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
      const text = () => buildFeedBlocks(h.services.transcript.getState(), view, cache).flatMap((block) => block.lines).map(stripAnsi).join("\n");
      expect(text()).not.toContain("INPUT_LINE_19");
      h.wiring.handleData("\x0f");
      expect(text()).toContain("INPUT_LINE_19");
      expect(text()).toContain("- click to collapse");
      h.wiring.handleData("\x0f");
      expect(text()).not.toContain("INPUT_LINE_19");
      expect(text()).toContain("+ click to expand");
      expect(h.services.transcript.getState().byId.get(item.id)).toEqual(item);
    } finally { h.dispose(); }
  });

  it("reveals hidden input in live frames and collapses it again", async () => {
    const h = createHarness({ rows: 36 });
    const item = tool(Array.from({ length: 20 }, (_, index) => `echo FRAME_INPUT_${index}`).join("\n"));
    h.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
    const ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("FRAME_INPUT_0"));
      expect(ui.lastFrame()).not.toContain("FRAME_INPUT_19");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("FRAME_INPUT_19"));
      expect(ui.lastFrame()).toContain("- click to collapse");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("FRAME_INPUT_19"));
      expect(ui.lastFrame()).toContain("+ click to expand");
      expect(h.services.transcript.getState().byId.get(item.id)).toEqual(item);
    } finally { ui.unmount(); ui.cleanup(); h.dispose(); }
  });

  it("keeps read options hidden until the live transcript is expanded", async () => {
    const h = createHarness({ columns: 100, rows: 70 });
    const item = tool(JSON.stringify({ files: Array.from({ length: 6 }, (_, i) => ({ path: `src/INPUT_FILE_${i}.ts`, pattern: `READ_PATTERN_${i}` })) }), "fs.read");
    h.services.session.spool.replace(item.toolCallId, "UNMODIFIED_READ_OUTPUT");
    h.services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });
    const ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("INPUT_FILE_5.ts"));
      expect(ui.lastFrame()).not.toContain("READ_PATTERN_5");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("READ_PATTERN_5"));
      expect(ui.lastFrame()).toContain("UNMODIFIED_READ_OUTPUT");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("READ_PATTERN_5"));
      expect(h.services.session.spool.tail(item.toolCallId)).toBe("UNMODIFIED_READ_OUTPUT");
    } finally { ui.unmount(); ui.cleanup(); h.dispose(); }
  });
});
