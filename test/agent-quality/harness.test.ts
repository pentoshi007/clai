import { describe, expect, it } from "vitest";
import {
  QUALITY_SCENARIOS,
  activeExperimentTags,
  baselineColdSystemTokens,
  compareQualityRuns,
  snapshotComposition,
} from "./harness.js";
import type { ChatMessage } from "../../src/types.js";

describe("agent quality harness skeleton", () => {
  it("registers all audit scenario classes", () => {
    const ids = new Set(QUALITY_SCENARIOS.map((s) => s.id));
    expect(ids.has("small_coding")).toBe(true);
    expect(ids.has("pentest_scoped")).toBe(true);
    expect(ids.has("large_context")).toBe(true);
    expect(ids.has("provider_disconnect")).toBe(true);
    expect(QUALITY_SCENARIOS.length).toBeGreaterThanOrEqual(12);
    for (const s of QUALITY_SCENARIOS) {
      expect(s.successCriteria.length).toBeGreaterThan(0);
      expect(s.nonNegotiables.length).toBeGreaterThan(0);
    }
  });

  it("snapshots composition without embedding message text in counts", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "# ROLE\nconstitution body" },
      { role: "user", content: "SECRET_PROMPT_SHOULD_NOT_BE_IN_METRICS_KEYS" },
      { role: "assistant", content: "ok" },
    ];
    const snap = snapshotComposition(messages, undefined, "small_coding");
    expect(snap.scenarioId).toBe("small_coding");
    expect(snap.breakdown.userMessageCount).toBe(1);
    expect(snap.estimatedHistoryTokens).toBeGreaterThan(0);
    expect(JSON.stringify(snap.breakdown)).not.toContain(
      "SECRET_PROMPT_SHOULD_NOT_BE_IN_METRICS_KEYS",
    );
  });

  it("cold system baseline stays in a professional agent band (not empty, not huge)", () => {
    const base = baselineColdSystemTokens(
      "shell.exec, fs.read, fs.write, plan.create, task.update",
    );
    // Floor: real agent constitution is multi-k tokens.
    expect(base.systemEstTokens).toBeGreaterThan(2_000);
    // Ceiling guard against accidental prompt bloat (constitution alone).
    expect(base.systemEstTokens).toBeLessThan(20_000);
    expect(base.composedEstTokens).toBeGreaterThan(base.systemEstTokens);
  });

  it("surfaces active E1–E6 experiment tags", () => {
    const tags = activeExperimentTags().join(" ");
    expect(tags).toMatch(/E1:/);
    expect(tags).toMatch(/E2:/);
    expect(tags).toMatch(/E3:/);
    expect(tags).toMatch(/E4:/);
    expect(tags).toMatch(/E5:/);
    expect(tags).toMatch(/E6:/);
  });

  it("compareQualityRuns flags quality regression, not token wins", () => {
    const base = {
      scenarioId: "small_coding" as const,
      passed: true,
      notes: "ok",
      inputTokens: 50_000,
    };
    const worse = {
      scenarioId: "small_coding" as const,
      passed: false,
      notes: "missed fix",
      inputTokens: 1_000,
    };
    const betterTokensButFail = compareQualityRuns(base, worse);
    expect(betterTokensButFail.qualityRegressed).toBe(true);

    const samePass = compareQualityRuns(base, {
      ...base,
      inputTokens: 10_000,
    });
    expect(samePass.qualityRegressed).toBe(false);
  });
});
