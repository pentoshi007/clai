import { describe, expect, it } from "vitest";
import {
  formatKeyEventStatus,
  isProviderFailureStatus,
} from "../src/llm/key-rotation.js";
import { toastRows, toastRowsWanted } from "../src/classic/chrome/toast-rows.js";
import { allocateChrome } from "../src/classic/chrome/row-budget.js";
import type { ToastItem } from "../src/ui-core/controllers/toast-controller.js";
import { createInkTheme } from "../src/classic/render/ink-theme.js";
import { plainText } from "../src/classic/render/ansi-text.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });

function toast(message: string): ToastItem {
  return { id: message, message, level: "warn", createdAt: 0, durationMs: 5000 };
}

function renderFullyBudgeted(message: string, columns: number): string {
  const items = [toast(message)];
  const granted = allocateChrome({
    rows: 40,
    columns,
    composerTextRows: 1,
    statusRowsWanted: 2,
    toastCount: toastRowsWanted(items, columns),
    queueCount: 0,
    responderVisible: false,
    planVisible: false,
    planRowsWanted: 0,
    overlay: undefined,
  }).toast;
  return toastRows({ ink, columns, allocatedRows: granted, toasts: items })
    .map((row) => plainText(row).trim())
    .join(" ")
    .replace(/^!\s+/, "")
    .replace(/\s+/g, " ");
}

describe("provider failure status classification", () => {
  it("flags the server-error lines the router produces", () => {
    for (const status of [
      "switching tokenrouter key [2/3] …ab12 (server error (502))",
      "switching tokenrouter key [2/3] …ab12 (server error (503))",
      "⏳ tokenrouter [1/2] …ab12 server error (502) in 8s…",
      "⏳ tokenrouter rate limited; staying on selected provider.",
      "switching to nvidia/openai/gpt-oss-20b after 3 failed",
      "all tokenrouter API keys failed",
      "switching gemini key [2/4] …cd34 (auth failed (401))",
      "switching openai key [2/2] …ef56 (insufficient credits (402))",
    ]) {
      expect(isProviderFailureStatus(status), status).toBe(true);
    }
  });

  it("flags every rotation event the key emitter forwards", () => {
    const base = { provider: "tokenrouter" as const, maskedTail: "…ab12" };
    for (const event of [
      { ...base, type: "switch" as const, reason: "server error (502)" },
      { ...base, type: "retry" as const, reason: "server error (503)", waitMs: 8_000 },
      { ...base, type: "exhausted" as const },
    ]) {
      expect(isProviderFailureStatus(formatKeyEventStatus(event)), event.type).toBe(true);
    }
  });

  it("ignores sticky-key and self-healing adaptation lines", () => {
    for (const status of [
      "using tokenrouter [1/2] …ab12",
      "ℹ tokenrouter/kimi-k3 rejected reasoning options — retrying without them",
      "ℹ free/deepseek does not support native tools — falling back to text protocol",
      "ℹ openai/gpt-5 needs its reasoning replayed — retrying with it attached",
      "",
      "   ",
    ]) {
      expect(isProviderFailureStatus(status), status).toBe(false);
    }
  });
});

describe("provider failure toasts are not truncated", () => {
  it("keeps the whole 502 line at widths where one row is not enough", () => {
    const status = "⏳ tokenrouter [1/2] …ab12 server error (502) in 8s…";
    for (const columns of [60, 72, 80, 120]) {
      expect(renderFullyBudgeted(status, columns), `columns=${columns}`).toBe(status);
    }
  });

  it("demands the rows a wrapped message needs instead of one row per toast", () => {
    const status = "switching tokenrouter key [2/3] …ab12 (server error (502))";
    expect(toastRowsWanted([toast(status)], 60)).toBe(2);
    expect(toastRowsWanted([toast("short")], 60)).toBe(1);
    expect(toastRowsWanted([], 60)).toBe(0);
  });

  it("never asks the allocator for more rows than the chrome cap", () => {
    const many = Array.from({ length: 6 }, (_, i) => toast(`failure ${"x".repeat(90)} ${i}`));
    expect(toastRowsWanted(many, 60)).toBeLessThanOrEqual(2);
  });
});
