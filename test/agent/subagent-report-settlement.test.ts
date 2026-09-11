import { afterEach, describe, expect, it } from "vitest";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import { SUBAGENT_LIMITS } from "../../src/store/subagents.js";

const report = `Status: complete
## Findings
The worker returns verified research to its parent after gathering the assigned evidence.
## Evidence
src/agent/subagents/worker.ts:1 defines the worker implementation inspected here.
## Next steps
No additional research is needed for this assignment.
## Coverage gaps
Runtime behavior was not independently exercised.`;

const managers: SubagentManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

async function settle(text: string) {
  const manager = new SubagentManager("report-settlement", { worker: async () => text });
  managers.push(manager);
  manager.setEnabled(true);
  const run = manager.start({ title: "Inspect worker", prompt: "Inspect the research worker", cwd: "/tmp", provider: "openai", model: "test" });
  const waiting = manager.wait(run.id);
  const result = await waiting;
  expect(manager.get(run.id)).toEqual(result);
  expect(manager.pendingResults()).toContainEqual(result);
  return result;
}

describe("report settlement safety", () => {
  it.each(["", report])("settles oversized custom-worker output as an error and wakes waiters: prefix=%s", async (prefix) => {
    const result = await settle(prefix + "😀".repeat(SUBAGENT_LIMITS.report / 4 + 1));
    expect(result.status).toBe("error");
    expect(result.error).toContain("storage safety limit");
    expect(result.report).toBeUndefined();
  });

  it("settles reports that exceed the bound after redaction without rejecting the settlement callback", async () => {
    const text = report + "\npassword=a".repeat(250_000);
    expect(Buffer.byteLength(text)).toBeLessThan(SUBAGENT_LIMITS.report);
    const result = await settle(text);
    expect(result.status).toBe("error");
    expect(result.error).toContain("storage safety limit");
    expect(result.report).toBeUndefined();
  });

  it("preserves the complete report at the inclusive byte boundary", async () => {
    const text = report + "x".repeat(SUBAGENT_LIMITS.report - Buffer.byteLength(report));
    const result = await settle(text);
    expect(result.status).toBe("completed");
    expect(result.report).toBe(text);
    expect(result.error).toBeUndefined();
  });
});
