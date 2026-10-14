import { describe, expect, it } from "vitest";
import { composerDirectoryRow, directoryRow } from "../../../src/classic/chrome/directory-row.js";
import { queueRows } from "../../../src/classic/chrome/queue-rows.js";
import { statusRows, type StatusViewInput } from "../../../src/classic/chrome/status-rows.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
const base = { ink, cwd: "/repo/clai", branch: "main", hasActivePlan: true, planVisible: false, queued: 2, queueVisible: true };

function status(queued: number, queueVisible: boolean): StatusViewInput {
  return {
    ink, columns: 200, allocatedRows: 1, mode: "agent", contextChip: undefined,
    contextUsage: undefined, running: false, compacting: false, activity: undefined,
    cancelArmed: false, tick: 0, hasDraft: false, queued, queueVisible,
    planVisible: false, hasActivePlan: true,
  };
}

describe("classic queue context indicator", () => {
  it.each([40, 48, 68, 96, 120, 200])("keeps queued status immediately after tasks at %i columns", (columns) => {
    for (const planVisible of [false, true]) {
      for (const queueVisible of [false, true]) {
        const row = composerDirectoryRow({ ...base, columns, planVisible, queueVisible });
        const text = stripAnsi(row);
        expect(text).toMatch(/(?:cntrl\+H to (?:expand|hide)|\^H tasks) · 2(?: queued|q)/);
        expect(text).toContain("Alt+Q");
        expect(text.includes("hidden")).toBe(!queueVisible);
        expect(displayWidth(row)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it.each([1, 2, 4, 12, 20, 28])("does not overflow an extremely narrow %i-column row", (columns) => {
    const row = composerDirectoryRow({ ...base, columns, queueVisible: false });
    expect(displayWidth(row)).toBeLessThanOrEqual(columns);
  });

  it("keeps the directory unchanged when there is neither a queue nor a collapsed plan", () => {
    for (const hasActivePlan of [false, true]) {
      const input = { ...base, columns: 120, hasActivePlan, planVisible: true, queued: 0 };
      expect(composerDirectoryRow(input)).toBe(directoryRow(input));
    }
  });

  it("preserves the original collapsed task hint when the queue is empty and visible", () => {
    const row = composerDirectoryRow({ ...base, columns: 120, queued: 0 });
    expect(stripAnsi(row)).toContain("Tasks active . cntrl+H to expand");
    expect(stripAnsi(row)).not.toContain("Alt+Q");
  });

  it("shows hidden state and a recovery shortcut for an empty queue", () => {
    const row = stripAnsi(composerDirectoryRow({ ...base, columns: 120, queued: 0, queueVisible: false }));
    expect(row).toContain("Queue hidden");
    expect(row).toContain("Alt+Q to show");
  });

  it("shows queue status without inventing an active tasks section", () => {
    const row = stripAnsi(composerDirectoryRow({ ...base, columns: 120, hasActivePlan: false }));
    expect(row).toContain("2 queued");
    expect(row).toContain("Alt+Q to hide");
    expect(row).not.toMatch(/tasks|cntrl\+H|\^H/);
  });

  it("shows a discoverable toggle in the queue header without losing its actions", () => {
    const rows = queueRows({ ink, columns: 200, allocatedRows: 3, queued: ["one", "two"], selected: 0 });
    expect(stripAnsi(rows[0]!)).toContain("Alt+Q hide");
    for (const action of ["^Y/^V select", "^S send", "^] edit", "^_ drop"]) expect(stripAnsi(rows[0]!)).toContain(action);
  });

  it("places the lower-status queue segment after tasks and indicates hidden state", () => {
    for (const queueVisible of [false, true]) {
      const row = stripAnsi(statusRows(status(2, queueVisible))[0]!);
      expect(row).toMatch(/\^H tasks · 2 queued/);
      expect(row.includes("hidden")).toBe(!queueVisible);
    }
  });
});
