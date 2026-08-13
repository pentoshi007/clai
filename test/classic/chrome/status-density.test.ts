import { describe, expect, it } from "vitest";
import type { ResponderRuntimeState } from "../../../src/app/controllers/session-responder.js";
import type { ContextUsageSnapshot } from "../../../src/llm/token-usage.js";
import { queueRows, queueRowsWanted } from "../../../src/classic/chrome/queue-rows.js";
import { responderRow, responderVisible } from "../../../src/classic/chrome/responder-row.js";
import {
  formatElapsed,
  relativizeHome,
  statusRows,
  statusRowsWanted,
  type StatusViewInput,
} from "../../../src/classic/chrome/status-rows.js";
import { allocateChrome } from "../../../src/classic/chrome/row-budget.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });
const ascii = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: false });

const WIDTHS = [40, 48, 68, 96, 120] as const;

function usage(tokens: number, limit: number): ContextUsageSnapshot {
  return {
    contextTokens: tokens,
    contextLimit: limit,
    lastCompletionTokens: 0,
    sessionPromptTokens: tokens,
    sessionCompletionTokens: 0,
    exact: true,
  };
}

function base(columns: number, overrides: Partial<StatusViewInput> = {}): StatusViewInput {
  return {
    ink,
    columns,
    allocatedRows: 1,
    mode: "agent",
    contextChip: "ctx 24.1k/128k",
    contextUsage: usage(24_100, 128_000),
    running: false,
    compacting: false,
    activity: undefined,
    elapsedSeconds: 0,
    cancelArmed: false,
    tick: 0,
    hasDraft: false,
    queued: 0,
    planVisible: false,
    hasActivePlan: false,
    ...overrides,
  };
}

const STATES: readonly {
  readonly name: string;
  readonly overrides: Partial<StatusViewInput>;
}[] = [
  { name: "idle", overrides: {} },
  {
    name: "running",
    overrides: { running: true, activity: "shell.exec npm test", elapsedSeconds: 12 },
  },
  {
    name: "armed-cancel",
    overrides: { running: true, activity: "generating response", elapsedSeconds: 75, cancelArmed: true },
  },
  { name: "queued", overrides: { queued: 2, hasDraft: true } },
  { name: "compacting", overrides: { compacting: true, elapsedSeconds: 3 } },
];

describe("status rows", () => {
  for (const width of WIDTHS) {
    for (const state of STATES) {
      it(`width=${width} · ${state.name} fits and matches its golden`, () => {
        const rows = statusRows(base(width, state.overrides));
        for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width);
        expect(rows.map(plainText)).toMatchSnapshot();
      });
    }
  }

  it("keeps exactly one row at every width, badge left and context flush right", () => {
    for (const width of WIDTHS) {
      const rows = statusRows(base(width));
      expect(rows).toHaveLength(1);
      const row = plainText(rows[0]!);
      expect(row.trim().startsWith("AGENT")).toBe(true);
      expect(row.trimEnd().endsWith(width < 68 ? "24.1k" : "ctx 24.1k/128k")).toBe(true);
    }
  });

  it("renders context editing inline without the legacy percentage chip", () => {
    const editing = statusRows(
      base(80, { contextLimitEditing: true, contextLimitDraft: "253k" }),
    );
    expect(editing).toHaveLength(1);
    const text = plainText(editing[0]!);
    expect(text).toContain("ctx limit 253k");
    expect(text).toContain("save");
    expect(text).not.toContain("%");
    expect(text).not.toContain("ctx 24.1k/128k");
    expect(displayWidth(editing[0]!)).toBeLessThanOrEqual(80);

    const reset = plainText(
      statusRows(base(80, { contextLimitEditing: true, contextLimitDraft: "" }))[0]!,
    );
    expect(reset).toContain("1m or 253k");
  });

  it("always wants a single row — meta lives on the composer border now", () => {
    expect(statusRowsWanted()).toBe(1);
  });

  it("stays one row no matter how many the allocator grants", () => {
    expect(statusRows(base(120, { allocatedRows: 3 }))).toHaveLength(1);
    expect(statusRows(base(120, { allocatedRows: 2 }))).toHaveLength(1);
    expect(statusRows(base(120, { allocatedRows: 1 }))).toHaveLength(1);
  });

  it("never drops row one, even at zero allocation", () => {
    expect(statusRows(base(120, { allocatedRows: 0 }))).toHaveLength(1);
  });

  it("replaces the hints with the activity while busy", () => {
    const idle = plainText(statusRows(base(120))[0]!);
    const busy = plainText(statusRows(base(120, { running: true, activity: "thinking", elapsedSeconds: 5 }))[0]!);
    expect(idle).toContain("thinking");
    expect(idle).toContain("/ commands");
    expect(busy).toContain("5s");
    expect(busy).toContain("esc: cancel");
    expect(busy).not.toContain("/ commands");
  });

  it("says compacting instead of the activity while compacting", () => {
    expect(plainText(statusRows(base(120, { compacting: true }))[0]!)).toContain("compacting");
  });

  it("escalates the armed-cancel wording", () => {
    expect(plainText(statusRows(base(120, { running: true, cancelArmed: true }))[0]!)).toContain(
      "esc again to cancel",
    );
  });

  it("adds the draft hints only when a draft exists", () => {
    expect(plainText(statusRows(base(120))[0]!)).not.toContain("^X cut");
    const drafted = plainText(statusRows(base(120, { hasDraft: true }))[0]!);
    expect(drafted).toContain("^X cut");
    expect(drafted).not.toContain("^X clear");
  });

  it("shows the tasks hint only when a plan exists or is visible", () => {
    expect(plainText(statusRows(base(120))[0]!)).not.toContain("tasks");
    expect(plainText(statusRows(base(120, { hasActivePlan: true }))[0]!)).toContain("^H tasks");
  });

  it("never shows scroll badges in the status row", () => {
    for (const columns of WIDTHS) {
      expect(plainText(statusRows(base(columns))[0]!)).not.toContain("▲");
      expect(plainText(statusRows(base(columns))[0]!)).not.toContain("▼");
    }
  });

  it("colours the context chip by usage severity", () => {
    const colored = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
    const normal = statusRows(base(120, { ink: colored }))[0]!;
    const critical = statusRows(
      base(120, {
        ink: colored,
        contextChip: "ctx 120k/128k",
        contextUsage: usage(120_000, 128_000),
      }),
    )[0]!;
    expect(normal).not.toBe(critical);
    expect(plainText(critical)).toContain("ctx 120k/128k");
  });

  it("shortens the chip at sm and keeps the model off the row", () => {
    const row = plainText(statusRows(base(60))[0]!);
    expect(row).toContain("24.1k");
    expect(row).not.toContain("/128k");
    expect(row).not.toContain("kimi-k2-thinking");
  });

  it("formats elapsed time across the minute boundary", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m00s");
    expect(formatElapsed(125)).toBe("2m05s");
  });

  it("relativizes the home directory", () => {
    expect(relativizeHome("/Users/me/dev/clai", "/Users/me")).toBe("~/dev/clai");
    expect(relativizeHome("/Users/me", "/Users/me")).toBe("~");
    expect(relativizeHome("/opt/clai", "/Users/me")).toBe("/opt/clai");
  });

  it("agrees with the allocator about how many rows it wants", () => {
    const layout = allocateChrome({
      rows: 40,
      columns: 120,
      composerTextRows: 1,
      statusRowsWanted: statusRowsWanted(),
      toastCount: 0,
      queueCount: 0,
      responderVisible: false,
      planVisible: false,
      planRowsWanted: 0,
      overlay: undefined,
    });
    expect(layout.status).toBe(1);
    expect(statusRows(base(120, { allocatedRows: layout.status }))).toHaveLength(1);
  });
});

describe("queue panel", () => {
  const queued = ["run the migration afterwards", "and update the changelog"];

  it("asks for one header row plus its items", () => {
    expect(queueRowsWanted(0)).toBe(0);
    expect(queueRowsWanted(2)).toBe(3);
    expect(queueRowsWanted(9)).toBe(5);
  });

  it("renders a header and the selected marker", () => {
    const rows = queueRows({ ink, columns: 80, allocatedRows: 3, queued, selected: 1 });
    expect(rows).toHaveLength(3);
    expect(plainText(rows[0]!)).toContain("2 queued");
    expect(plainText(rows[1]!)).toContain("1   run the migration afterwards");
    expect(plainText(rows[2]!)).toContain("2 ❯ and update the changelog");
  });

  it("summarises the overflow on the last row", () => {
    const many = Array.from({ length: 9 }, (_, index) => `item ${index + 1}`);
    const rows = queueRows({ ink, columns: 80, allocatedRows: 5, queued: many, selected: 0 });
    expect(rows).toHaveLength(5);
    expect(plainText(rows[4]!)).toContain("+6 more");
  });

  it("renders nothing when empty or when the allocator gave it one row", () => {
    expect(queueRows({ ink, columns: 80, allocatedRows: 3, queued: [], selected: 0 })).toEqual([]);
    expect(queueRows({ ink, columns: 80, allocatedRows: 1, queued, selected: 0 })).toEqual([]);
  });

  it("falls back to ascii hints without unicode", () => {
    const rows = queueRows({ ink: ascii, columns: 100, allocatedRows: 3, queued, selected: 0 });
    expect(plainText(rows[0]!)).toContain("ctrl+s send");
  });

  it("stays inside the width at every column count", () => {
    for (const width of WIDTHS) {
      for (const row of queueRows({ ink, columns: width, allocatedRows: 5, queued, selected: 0 })) {
        expect(displayWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("responder strip", () => {
  function state(overrides: Partial<ResponderRuntimeState> = {}): ResponderRuntimeState {
    return { mode: "off", running: 0, ready: 0, delivered: 0, archived: 0, failed: 0, ...overrides };
  }

  it("hides itself when there is nothing to report", () => {
    expect(responderVisible(state())).toBe(false);
    expect(responderVisible(state({ mode: "listening" }))).toBe(true);
    expect(responderVisible(state({ delivered: 1 }))).toBe(true);
  });

  it("reads from the shared formatter", () => {
    const row = plainText(
      responderRow({ ink, columns: 120, state: state({ mode: "listening", running: 1, delivered: 2 }) }),
    );
    expect(row).toContain("Responder: listening · 1 running · 2 delivered");
    expect(row).toContain("^J jobs");
  });

  it("compacts below 68 columns", () => {
    expect(
      plainText(responderRow({ ink, columns: 60, state: state({ mode: "listening", running: 1 }) })),
    ).toContain("R: listening");
  });

  it("stays inside the width at every column count", () => {
    for (const width of WIDTHS) {
      const row = responderRow({
        ink,
        columns: width,
        state: state({ mode: "listening", running: 1, ready: 2, delivered: 3 }),
      });
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
  });
});
