import { describe, expect, it } from "vitest";
import { subagentReportStatus } from "../../src/agent/subagents/report.js";

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
});
