import stringWidth from "string-width";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Chrome } from "../../../src/classic/chrome/Chrome.js";
import {
  allocateChrome,
  type ChromeDemand,
} from "../../../src/classic/chrome/row-budget.js";

const COLUMNS = 80;

function demand(over: Partial<ChromeDemand>): ChromeDemand {
  return {
    rows: 24,
    columns: COLUMNS,
    composerTextRows: 1,
    statusRowsWanted: 1,
    toastCount: 0,
    queueCount: 0,
    responderVisible: false,
    planVisible: false,
    planRowsWanted: 0,
    overlay: undefined,
    ...over,
  };
}

function frameOf(input: ChromeDemand): { rows: string[]; total: number } {
  const layout = allocateChrome(input);
  const { lastFrame, unmount } = render(
    createElement(Chrome, { layout, columns: input.columns }),
  );
  const frame = lastFrame() ?? "";
  unmount();
  return {
    rows: frame === "" ? [] : frame.split("\n"),
    total: layout.total,
  };
}

const SHAPES: readonly (readonly [string, Partial<ChromeDemand>])[] = [
  ["idle", {}],
  ["multiline draft", { composerTextRows: 6 }],
  ["toasts and queue", { toastCount: 2, queueCount: 3 }],
  ["plan visible", { planVisible: true, planRowsWanted: 6 }],
  ["overlay open", { overlay: { kind: "pager", rowsWanted: 12 } }],
  [
    "everything at once",
    {
      composerTextRows: 4,
      statusRowsWanted: 3,
      toastCount: 2,
      queueCount: 2,
      responderVisible: true,
      planVisible: true,
      planRowsWanted: 5,
      overlay: { kind: "picker", rowsWanted: 9 },
    },
  ],
];

describe("Ink frame height equals ChromeLayout.total", () => {
  for (const rows of [8, 12, 24, 50]) {
    for (const [name, over] of SHAPES) {
      it(`rows=${rows} · ${name}`, () => {
        const { rows: frameRows, total } = frameOf(demand({ ...over, rows }));
        expect(frameRows).toHaveLength(total);
        expect(total).toBeLessThanOrEqual(rows);
      });
    }
  }

  it("never writes past the last column", () => {
    for (const columns of [20, 44, 80, 120]) {
      const { rows } = frameOf(demand({ rows: 24, columns, composerTextRows: 3 }));
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    }
  }, 10_000);

  it("renders one row when the terminal has exactly one row", () => {
    expect(frameOf(demand({ rows: 1 })).rows).toHaveLength(1);
  });

  it("emits no bare escape byte and no unterminated SGR", () => {
    const { rows } = frameOf(
      demand({ rows: 24, toastCount: 2, planVisible: true, planRowsWanted: 4 }),
    );
    for (const row of rows) {
      expect(row).not.toMatch(/\x1b(?!\[[0-9;]*m)/);
      const opens = row.match(/\x1b\[[0-9;]*m/g) ?? [];
      if (opens.length > 0) expect(row).toMatch(/\x1b\[0?m$/);
    }
  });
});
