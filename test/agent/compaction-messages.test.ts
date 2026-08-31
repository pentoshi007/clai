import { describe, expect, it } from "vitest";
import {
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
} from "../../src/agent/context-manager.js";
import {
  compactionFailureMessage,
  compactionSummaryText,
} from "../../src/agent/turn/compaction-messages.js";

describe("compaction summary text", () => {
  it("strips the plan-implement prefix with its blank line", () => {
    expect(
      compactionSummaryText(`${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n- body`),
    ).toBe("- body");
  });

  it("strips the compaction prefix with its blank line", () => {
    expect(compactionSummaryText(`${COMPACTION_MEMORY_PREFIX}\n\n- body`)).toBe(
      "- body",
    );
  });

  it("falls back to bare prefix removal for each memory kind", () => {
    expect(
      compactionSummaryText(`${PLAN_IMPLEMENT_MEMORY_PREFIX}- tight`),
    ).toBe("- tight");
    expect(compactionSummaryText(`${COMPACTION_MEMORY_PREFIX}- tight`)).toBe(
      "- tight",
    );
    expect(compactionSummaryText("unprefixed body")).toBe("unprefixed body");
    expect(compactionSummaryText("")).toBe("");
  });
});

describe("compaction failure message", () => {
  it("reports cancellation for aborted text before any policy classification", () => {
    expect(
      compactionFailureMessage({
        message: "stream aborted",
        policyLimited: false,
      }),
    ).toBe("Compaction was cancelled.");
    expect(
      compactionFailureMessage({
        message: "Request Aborted",
        policyLimited: true,
      }),
    ).toBe("Compaction was cancelled.");
  });

  it("reports the single-admission policy for operation policy errors", () => {
    expect(
      compactionFailureMessage({
        message:
          "compaction operation compaction-1 exhausted its admission budget (3) before another generation dispatch",
        policyLimited: true,
      }),
    ).toBe(
      "Compaction is limited to one pinned request (plus its bounded retry) and none completed; the original context was retained.",
    );
  });

  it("passes any other message through unchanged", () => {
    expect(
      compactionFailureMessage({
        message: "upstream 500",
        policyLimited: false,
      }),
    ).toBe("upstream 500");
  });
});
