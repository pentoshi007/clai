import { describe, expect, it } from "vitest";
import {
  compactionElapsedLabel,
  formatDurationMs,
  thinkingElapsedLabel,
  toolElapsedLabel,
  turnSummaryLabel,
} from "../../../src/ui-core/rendering/duration.js";
import type { ToolItem } from "../../../src/ui-core/state/transcript-types.js";

function tool(
  partial: Partial<Pick<ToolItem, "name" | "status" | "timestamp" | "startedAt" | "endedAt">>,
): Pick<ToolItem, "name" | "status" | "timestamp" | "startedAt" | "endedAt"> {
  return {
    name: "shell.exec",
    status: "running",
    timestamp: 1_000,
    ...partial,
  };
}

describe("formatDurationMs", () => {
  it("formats sub-second, seconds, minutes, and hours", () => {
    expect(formatDurationMs(0)).toBe("0.0s");
    expect(formatDurationMs(2_500)).toBe("2.5s");
    expect(formatDurationMs(9_999)).toBe("10.0s");
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(76_000)).toBe("1m16s");
    expect(formatDurationMs(3_600_000)).toBe("1h00m");
  });

  it("returns empty for invalid/negative input", () => {
    expect(formatDurationMs(-1)).toBe("");
    expect(formatDurationMs(Number.NaN)).toBe("");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("toolElapsedLabel", () => {
  it("shows no clock while a command is queued (not yet running)", () => {
    expect(
      toolElapsedLabel(tool({ status: "queued", timestamp: 1_000 }), 61_000),
    ).toBeUndefined();
  });

  it("shows no clock for blocked commands", () => {
    expect(
      toolElapsedLabel(tool({ status: "blocked", timestamp: 1_000 }), 61_000),
    ).toBeUndefined();
  });

  it("counts a running command from its real start time, not queue time", () => {
    // Queued at t=1s, actually started at t=30s; at t=42s it has run 12s.
    const label = toolElapsedLabel(
      tool({ status: "running", timestamp: 1_000, startedAt: 30_000 }),
      42_000,
    );
    expect(label).toBe("12s");
  });

  it("falls back to timestamp when startedAt is absent (hydrated history)", () => {
    const label = toolElapsedLabel(
      tool({ status: "running", timestamp: 1_000 }),
      13_000,
    );
    expect(label).toBe("12s");
  });

  it("measures a completed command from start to end", () => {
    const label = toolElapsedLabel(
      tool({
        status: "ok",
        timestamp: 1_000,
        startedAt: 30_000,
        endedAt: 42_000,
      }),
      99_000,
    );
    expect(label).toBe("12s");
  });

  it("returns undefined when a completed command has no end time", () => {
    expect(
      toolElapsedLabel(tool({ status: "ok", timestamp: 1_000 }), 99_000),
    ).toBeUndefined();
  });

  it("hides elapsed time for filesystem tools except fs.search", () => {
    expect(
      toolElapsedLabel(tool({ name: "fs.read", status: "running" }), 13_000),
    ).toBeUndefined();
    expect(
      toolElapsedLabel(
        tool({ name: "fs.write", status: "ok", endedAt: 13_000 }),
        99_000,
      ),
    ).toBeUndefined();
    expect(
      toolElapsedLabel(tool({ name: "fs.search", status: "running" }), 13_000),
    ).toBe("12s");
    expect(
      toolElapsedLabel(tool({ name: "shell.exec", status: "running" }), 13_000),
    ).toBe("12s");
  });
});

describe("turnSummaryLabel", () => {
  it("formats completed/aborted/error summaries", () => {
    expect(turnSummaryLabel(76_000, "completed")).toBe("Worked for 1m16s");
    expect(turnSummaryLabel(5_000, "aborted")).toBe("Worked for 5.0s · aborted");
    expect(turnSummaryLabel(2_500, "error")).toBe("Worked for 2.5s · error");
  });
});

describe("thinkingElapsedLabel / compactionElapsedLabel", () => {
  it("advances live timers from their lifecycle start", () => {
    expect(
      thinkingElapsedLabel(
        { streaming: true, timestamp: 1_000, startedAt: 30_000 },
        42_000,
      ),
    ).toBe("12s");
    expect(
      compactionElapsedLabel(
        { streaming: true, timestamp: 1_000, startedAt: 30_000 },
        42_000,
      ),
    ).toBe("12s");
  });

  it("freezes final timers at endedAt and hides unavailable legacy durations", () => {
    expect(
      thinkingElapsedLabel(
        {
          streaming: false,
          timestamp: 1_000,
          startedAt: 30_000,
          endedAt: 42_000,
        },
        99_000,
      ),
    ).toBe("12s");
    expect(
      compactionElapsedLabel(
        {
          streaming: false,
          timestamp: 1_000,
          startedAt: 30_000,
          endedAt: 42_000,
        },
        99_000,
      ),
    ).toBe("12s");
    expect(
      thinkingElapsedLabel({ streaming: false, timestamp: 1_000 }, 99_000),
    ).toBeUndefined();
    expect(
      compactionElapsedLabel({ streaming: false, timestamp: 1_000 }, 99_000),
    ).toBeUndefined();
  });
});
