import { describe, expect, it, vi } from "vitest";
import { frameToolResult } from "../../src/agent/turn/tool-execution/result-framing.js";

describe("private credential tool results", () => {
  it("returns content to model context without sending it to artifacts, UI, hooks, or audit", async () => {
    const saveArtifact = vi.fn(async () => "/must-not-exist");
    const emitToolResult = vi.fn();
    const onToolResult = vi.fn();
    const audit = vi.fn(async () => undefined);
    const framed = await frameToolResult({
      step: 1,
      saveArtifact,
      setJobArtifact: vi.fn(),
      formatContext: (_call, result) => result.output,
      emitToolResult,
      onToolResult,
      audit,
      recordEngagementOutcome: async () => undefined,
      recordLedgerCall: vi.fn(),
    }, { name: "creds.get", args: { id: "id" } }, { ok: true, output: "private-fixture-content", sensitive: true });
    expect(framed.contextOutput).toBe("private-fixture-content");
    expect(framed.artifactPath).toBeUndefined();
    expect(saveArtifact).not.toHaveBeenCalled();
    expect(JSON.stringify([emitToolResult.mock.calls, onToolResult.mock.calls, audit.mock.calls])).not.toContain("private-fixture-content");
  });
});
