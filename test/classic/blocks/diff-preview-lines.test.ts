import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { buildDiffLines } from "../../../src/classic/blocks/diff-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { buildFileChange, type FileChange } from "../../../src/tools/file-diff.js";
import { buildModalPagerRows } from "../../../src/ui-core/rendering/file-diff-view.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness } from "../app/harness.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const turn = scriptedTurn();
const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "fs.edit")!;

function change(lines: number, file = 0): FileChange {
  return buildFileChange({
    path: `/repo/file-${file}.ts`, before: "", kind: "create",
    after: Array.from({ length: lines }, (_, row) => `const ROW_${file}_${row} = ${row};`).join("\n"),
  });
}

function fixture(changes: FileChange[], columns = 80, expanded = false) {
  const item = { ...source, name: changes.length > 1 ? "fs.writeMany" : "fs.write", fileChanges: changes };
  const state = {
    ...turn.state, order: [item.id], byId: new Map([[item.id, item]]),
    expandOutputGlobal: expanded, expandFileDiffsGlobal: true,
  };
  const ctx = blockContextFor(state, feedView(turn, { columns, colorMode: "none" }));
  const rows = buildDiffLines(ctx, item);
  const headerRows = columns + 2 >= 44 ? 1 : 2;
  return { item, state, ctx, rows, body: rows.slice(headerRows, -1).map(stripAnsi) };
}

describe("classic collapsed diff previews", () => {
  it.each([24, 40, 80, 120])("caps a single-file body including its gap at 20 rows at %i columns", (columns) => {
    const { body, rows, item } = fixture([change(60)], columns);
    expect(body).toHaveLength(20);
    expect(body.at(-1)).toContain("more");
    expect(body.join("\n")).not.toContain("ROW_0_59");
    expect(body.join("\n")).not.toContain("click for full");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    expect(buildModalPagerRows(item.fileChanges[0]!).map((row) => row.body).join("\n")).toContain("ROW_0_59");
  });

  it.each([24, 40, 80, 120])("caps a multi-file body collectively, including paths and hidden-file notices, at %i columns", (columns) => {
    const changes = Array.from({ length: 15 }, (_, file) => change(30, file));
    const { body, rows, item } = fixture(changes, columns);
    expect(body.length).toBeLessThanOrEqual(20);
    expect(body.join("\n")).toMatch(/more files/);
    expect(body.join("\n")).not.toContain("file-14.ts");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    expect(item.fileChanges).toEqual(changes);
  });

  it.each([0, 1, 19, 20])("does not unnecessarily shorten a %i-row single-file diff", (lines) => {
    const { body } = fixture([change(lines)], 120);
    expect(body.length).toBeLessThanOrEqual(20);
    if (lines > 0) {
      expect(body.join("\n")).toContain(`ROW_0_${lines - 1}`);
      expect(body.join("\n")).not.toContain("more");
    }
  });

  it("keeps binary and empty previews bounded", () => {
    const binary = { ...change(0), binary: true };
    expect(fixture([binary]).body).toHaveLength(1);
    expect(fixture([binary]).body[0]).toContain("binary");
    expect(fixture([change(0)]).body).toHaveLength(1);
  });

  it("leaves expanded single-file and multi-file budgets unchanged", () => {
    const single = fixture([change(60)], 120, true);
    expect(single.body.length).toBeGreaterThan(20);
    expect(single.body.join("\n")).toContain("ROW_0_39");
    const multi = fixture(Array.from({ length: 8 }, (_, file) => change(30, file)), 120, true);
    expect(multi.body.length).toBeGreaterThan(20);
    expect(multi.body.join("\n")).toContain("file-7.ts");
  });

  it("expands and re-collapses actual frames through Ctrl+O without altering stored diffs", async () => {
    const h = createHarness({ columns: 120, rows: 70 });
    const { item, state } = fixture([change(60)], 120);
    h.services.transcript.hydrate(state);
    const ui = render(createElement(ServicesProvider, {
      services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
    }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("ROW_0_0"));
      expect(ui.lastFrame()).not.toContain("ROW_0_39");
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("ROW_0_39"));
      h.wiring.handleData("\x0f");
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("ROW_0_39"));
      expect(h.services.transcript.getState().byId.get(item.id)).toEqual(item);
    } finally {
      ui.unmount();
      ui.cleanup();
      h.dispose();
    }
  });
});
