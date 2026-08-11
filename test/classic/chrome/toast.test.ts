import { describe, expect, it } from "vitest";
import { ToastController } from "../../../src/ui-core/controllers/toast-controller.js";
import type { ToastItem, ToastLevel } from "../../../src/ui-core/controllers/toast-controller.js";
import { allocateChrome } from "../../../src/classic/chrome/row-budget.js";
import { MAX_TOAST_ROWS } from "../../../src/classic/chrome/row-budget.js";
import { toastRows, visibleToasts } from "../../../src/classic/chrome/toast-rows.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });
const colored = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

function toast(message: string, level: ToastLevel = "info"): ToastItem {
  return { id: message, message, level, createdAt: 0, durationMs: 5000 };
}

function rows(items: readonly ToastItem[], columns = 80, allocatedRows = MAX_TOAST_ROWS) {
  return toastRows({ ink, columns, allocatedRows, toasts: items }).map(plainText);
}

describe("toast rows", () => {
  it("renders nothing when there is nothing to show", () => {
    expect(rows([])).toEqual([]);
    expect(rows([toast("hi")], 80, 0)).toEqual([]);
  });

  it("caps at two rows and renders the newest first", () => {
    const all = [toast("first"), toast("second"), toast("third")];
    expect(visibleToasts(all, MAX_TOAST_ROWS).map((item) => item.message)).toEqual([
      "second",
      "third",
    ]);
    expect(rows(all).map((row) => row.trim())).toEqual(["·  third", "·  second (+1)"]);
  });

  it("puts the overflow marker on the last row only", () => {
    const all = [toast("a"), toast("b"), toast("c")];
    const rendered = rows(all, 80, 1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.trim()).toBe("·  c (+2)");
  });

  it("omits the marker when everything fits", () => {
    expect(rows([toast("only")]).map((row) => row.trim())).toEqual(["·  only"]);
  });

  it("caps the pill at 85% of the columns and clips with an ellipsis", () => {
    const long = "x".repeat(200);
    const rendered = toastRows({ ink, columns: 40, allocatedRows: 2, toasts: [toast(long)] });
    const row = plainText(rendered[0]!);
    expect(displayWidth(row)).toBe(40);
    const text = row.trim();
    expect(text.endsWith("…")).toBe(true);
    expect(displayWidth(text)).toBe(30);
  });

  it("centers the pill horizontally", () => {
    const rendered = rows([toast("hi")], 80, 1);
    const row = rendered[0]!;
    expect(displayWidth(row)).toBe(80);
    expect(row.trim()).toBe("·  hi");
    const pillWidth = Math.max(16, displayWidth("·  hi") + 4);
    const leftPad = Math.floor((80 - pillWidth) / 2);
    expect(row.indexOf("·") - 2).toBe(leftPad);
    expect(row.slice(leftPad + pillWidth)).toBe(" ".repeat(80 - leftPad - pillWidth));
  });

  it("plates each level differently", () => {
    const painted = (level: ToastLevel) =>
      toastRows({ ink: colored, columns: 40, allocatedRows: 2, toasts: [toast("msg", level)] })[0]!;
    const seen = new Set(["success", "warn", "error", "info"].map((level) => painted(level as ToastLevel)));
    expect(seen.size).toBe(4);
  });

  it("never exceeds the rows the allocator granted", () => {
    const all = [toast("a"), toast("b"), toast("c")];
    for (const granted of [0, 1, 2, 3, 9]) {
      expect(rows(all, 80, granted).length).toBeLessThanOrEqual(Math.min(granted, MAX_TOAST_ROWS));
    }
  });

  it("takes at most two rows from the allocator however many toasts are live", () => {
    const layout = allocateChrome({
      rows: 40,
      columns: 80,
      composerTextRows: 1,
      statusRowsWanted: 2,
      toastCount: 3,
      queueCount: 0,
      responderVisible: false,
      planVisible: false,
      planRowsWanted: 0,
      overlay: undefined,
    });
    expect(layout.toast).toBe(MAX_TOAST_ROWS);
  });

  it("leaves the live tail unchanged when a toast appears and clears", () => {
    const demand = (toastCount: number) => ({
      rows: 40,
      columns: 80,
      composerTextRows: 1,
      statusRowsWanted: 2 as const,
      toastCount,
      queueCount: 0,
      responderVisible: false,
      planVisible: false,
      planRowsWanted: 0,
      overlay: undefined,
    });
    const before = allocateChrome(demand(0));
    const during = allocateChrome(demand(2));
    const after = allocateChrome(demand(0));
    expect(during.liveTail).toBe(before.liveTail - 2);
    expect(after.liveTail).toBe(before.liveTail);
    expect(after.composer).toBe(before.composer);
  });
});

describe("controller integration", () => {
  it("replaces a same-key toast instead of stacking it", () => {
    const controller = new ToastController();
    controller.warn("switching to backup API key", { key: "api-key" });
    controller.warn("switching to backup API key", { key: "api-key" });
    controller.warn("switching to backup API key", { key: "api-key" });
    expect(controller.getToasts()).toHaveLength(1);
    expect(rows(controller.getToasts()).map((row) => row.trim())).toEqual([
      "!  switching to backup API key",
    ]);
    controller.dispose();
  });

  it("keeps at most three live and shows the newest two", () => {
    const controller = new ToastController();
    for (const message of ["one", "two", "three", "four"]) controller.info(message);
    expect(controller.getToasts()).toHaveLength(3);
    expect(rows(controller.getToasts()).map((row) => row.trim())).toEqual([
      "·  four",
      "·  three (+1)",
    ]);
    controller.dispose();
  });
});