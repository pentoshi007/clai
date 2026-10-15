import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { buildDiffLines } from "../../../src/classic/blocks/diff-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { buildFileChange, type FileChange } from "../../../src/tools/file-diff.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness } from "../app/harness.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const turn = scriptedTurn();
const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "fs.edit")!;

function change(lines: number, file = 0): FileChange {
  return buildFileChange({ path: `/repo/file-${file}.ts`, before: "", kind: "create", after: Array.from({ length: lines }, (_, row) => `const ROW_${file}_${row} = ${row};`).join("\n") });
}

function fixture(changes: FileChange[], columns = 80, expanded = false) {
  const item = { ...source, name: changes.length > 1 ? "fs.writeMany" : "fs.write", fileChanges: changes };
  const state = { ...turn.state, order: [item.id], byId: new Map([[item.id, item]]), expandOutputGlobal: expanded, expandFileDiffsGlobal: true };
  const ctx = blockContextFor(state, feedView(turn, { columns, colorMode: "none" }));
  const rows = buildDiffLines(ctx, item);
  return { item, state, ctx, rows, body: rows.slice(1, -1).map(stripAnsi) };
}

describe("classic Codex diff previews", () => {
  it.each([24, 40, 80, 120])("caps single-file previews at three rows at %i columns", (columns) => {
    const { body, rows, item, ctx } = fixture([change(60)], columns);
    expect(body).toHaveLength(3);
    expect(body.join("\n")).not.toContain("ROW_0_59");
    expect(rows.at(-1)).toContain("click to expand");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(ctx.width);
    expect(item.fileChanges[0]?.afterText).toContain("ROW_0_59");
  });

  it.each([24, 40, 80, 120])("bounds each multi-file preview and lists omitted files at %i columns", (columns) => {
    const changes = Array.from({ length: 15 }, (_, file) => change(30, file));
    const { body, rows, item, ctx } = fixture(changes, columns);
    expect(body.filter((line) => /\d+ \+ /.test(line))).toHaveLength(36);
    expect(body.join("\n")).toContain("more files");
    expect(body.join("\n")).not.toContain("file-14.ts");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(ctx.width);
    expect(item.fileChanges).toEqual(changes);
  });

  it.each([0, 1, 2, 3])("does not unnecessarily shorten a %i-row diff", (count) => {
    const { body } = fixture([change(count)], 120);
    expect(body).toHaveLength(Math.max(1, count));
    if (count > 0) expect(body.join("\n")).toContain(`ROW_0_${count - 1}`);
  });

  it("handles binary and empty previews", () => {
    expect(fixture([{ ...change(0), binary: true }]).body[0]).toContain("binary");
    expect(fixture([change(0)]).body[0]).toContain("no line changes");
  });

  it("reveals every stored diff line and every file when expanded", () => {
    const single = fixture([change(60)], 120, true);
    expect(single.body.join("\n")).toContain("ROW_0_59");
    const multi = fixture(Array.from({ length: 15 }, (_, file) => change(60, file)), 120, true);
    expect(multi.body.join("\n")).toContain("file-14.ts");
    expect(multi.body.join("\n")).toContain("ROW_14_59");
    expect(multi.rows.at(-1)).toContain("click to collapse");
  });

  it("wraps full long code without a rail or lost characters", () => {
    const full = `const wide = '${"界🙂".repeat(300)}END';`;
    const file = buildFileChange({ path: "wide.ts", kind: "create", before: "", after: full });
    const { body, rows, ctx } = fixture([file], 40, true);
    expect(body.join("\n")).not.toContain("│");
    expect(body.join("").replace(/\s/g, "")).toContain(full.replace(/\s/g, ""));
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(ctx.width);
  });

  it("expands and re-collapses live frames without changing stored diffs", async () => {
    const h = createHarness({ columns: 120, rows: 80 });
    const { item, state } = fixture([change(60)], 120);
    h.services.transcript.hydrate(state);
    const ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("ROW_0_0"));
      expect(ui.lastFrame()).not.toContain("ROW_0_59");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("ROW_0_59"));
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("ROW_0_59"));
      expect(h.services.transcript.getState().byId.get(item.id)).toEqual(item);
    } finally { ui.unmount(); ui.cleanup(); h.dispose(); }
  });
});
