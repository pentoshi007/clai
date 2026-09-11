import { describe, expect, it } from "vitest";
import { subagentReportStatus } from "../../src/agent/subagents/report.js";
import { SUBAGENT_LIMITS } from "../../src/store/subagents.js";

const report = (citation: string, status = "complete") => `Status: ${status}
## Findings
The inspected file defines the worker's execution contract; consumers remain unverified.
## Evidence
${citation} defines the execution contract inspected during this investigation.
## Next steps
Inspect consumers before changing the contract.
## Coverage gaps
Tests were not run and callers were not examined.`;

describe("subagent report citations", () => {
  it.each([
    "Dockerfile:12",
    "Makefile:4",
    "src/worker.ts:10-20",
    "src/worker.ts#L10-L20",
    "src/worker.ts lines 10–20",
    "`src/worker.ts` lines 10–20",
    "Dockerfile line 12",
    "https://example.com/documentation#workers",
  ])("accepts filename-and-line evidence or source URLs: %s", (citation) => {
    expect(subagentReportStatus(report(citation))).toBe("completed");
    expect(subagentReportStatus(report(citation, "partial"))).toBe("partial");
  });

  it.each(["Dockerfile", "lines 10–20", "src/worker.ts lines zero", "Dockerfile:0", "source file"])("rejects evidence without a source citation: %s", (citation) => {
    expect(subagentReportStatus(report(citation))).toBeUndefined();
  });

  it("still requires all report sections when a filename citation is present", () => {
    expect(subagentReportStatus(report("Dockerfile:12").replace("## Coverage gaps", "## Other notes"))).toBeUndefined();
  });

  it("accepts substantive reports beyond the former 24000-character limit", () => {
    const findings = `${report("src/worker.ts:42")}\n${"Verified evidence. ".repeat(10_000)}`;
    expect(findings.length).toBeGreaterThan(24_000);
    expect(subagentReportStatus(findings)).toBe("completed");
  });

  it("keeps report validation aligned with the transport byte-safety boundary", () => {
    const findings = `${report("src/worker.ts:42")}\n${"😀".repeat(SUBAGENT_LIMITS.report / 4)}`;
    expect(findings.length).toBeLessThan(SUBAGENT_LIMITS.report);
    expect(subagentReportStatus(findings)).toBeUndefined();
  });

  it("accepts reports exactly at the byte-safety boundary and rejects one byte over it", () => {
    const prefix = report("src/worker.ts:42");
    const findings = prefix + "x".repeat(SUBAGENT_LIMITS.report - Buffer.byteLength(prefix));
    expect(subagentReportStatus(findings)).toBe("completed");
    expect(subagentReportStatus(`${findings}x`)).toBeUndefined();
  });
});
