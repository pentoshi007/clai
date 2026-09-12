import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import { runSubagentTool } from "../../src/agent/subagents/tools.js";
import type { SubagentRun, SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { SubagentInbox } from "../../src/agent/turn/subagent-inbox.js";
import { FileSubagentStore, restoreSubagentRun } from "../../src/store/subagents.js";
import type { ChatMessage } from "../../src/types.js";

const managers: SubagentManager[] = [];
const roots: string[] = [];
const report = "Status: complete\n## Findings\nOwnership is checked before allowing route access.\n## Evidence\nsrc/routes.ts:12 checks ownership of the requested resource.\n## Next steps\nNo code changes are required.\n## Coverage gaps\nRuntime behavior was not exercised.";
const assignment = { title: "Routes", prompt: "Inspect ownership", cwd: "/tmp", provider: "openai" as const, model: "test" };
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clai-summary-"));
  roots.push(root);
  const store = new FileSubagentStore(root);
  const work: { input: SubagentWorkerInput; resolve: (report: string) => void }[] = [];
  const createManager = () => {
    const manager = new SubagentManager("parent", { store, worker: (input) => new Promise<string>((resolve) => {
      work.push({ input, resolve });
      input.signal.addEventListener("abort", () => resolve("This must not become a report"), { once: true });
    }) });
    managers.push(manager);
    return manager;
  };
  return { store, work, createManager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  await tick();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable subagent summary recovery", () => {
  it("retains the last report through restart, activity eviction, stop, reload, and disabled delegation", async () => {
    const { work, createManager } = fixture();
    const manager = createManager();
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve(report);
    await manager.wait(run.id);
    manager.acknowledgeResult(run.id, 1);
    manager.restart(run.id);
    await tick();
    for (let index = 0; index < 120; index++) work[1]!.input.emit({ kind: "tool", text: `Activity ${index}` });
    work[1]!.input.saveCheckpoint!({ messages: [{ role: "user", content: "Compacted child context" }] });
    manager.stop(run.id);
    await manager.wait(run.id);
    manager.dispose();
    const restored = createManager();
    expect(restored.get(run.id)).toMatchObject({
      status: "stopped", attempt: 2, report: undefined,
      lastKnownSummary: { attempt: 1, status: "completed", report },
    });
    restored.setEnabled(false);
    const read = (offset: number, attempt = 1) => runSubagentTool({ name: "subagent.read", args: {
      id: run.id, view: "summary", attempt, offset, length: 50,
    } }, { manager: restored, ...assignment }, new AbortController().signal);
    const first = await read(0);
    const data = JSON.parse(first.output.slice(first.output.indexOf("\n") + 1));
    expect(first.ok).toBe(true);
    expect(data).toMatchObject({ status: "stopped", attempt: 2, summaryAttempt: 1, summaryStatus: "completed", report: report.slice(0, 50), nextOffset: 50 });
    expect((await read(50)).output).toContain(JSON.stringify(report.slice(50, 100)));
    expect((await read(0, 2)).ok).toBe(false);
    expect(restored.pendingResults()).toHaveLength(1);
  });

  it("retains a validated internal checkpoint summary without inventing a stopped report", async () => {
    const { work, createManager } = fixture();
    const manager = createManager();
    const run = manager.start(assignment);
    await tick();
    const partial = report.replace("Status: complete", "Status: partial").replace("Coverage gaps\nNone.", "Coverage gaps\nMore routes remain.");
    work[0]!.input.saveSummary!(partial);
    expect(() => work[0]!.input.saveSummary!("Unstructured interrupted output")).toThrow("invalid summary");
    manager.stop(run.id);
    await manager.wait(run.id);
    work[0]!.input.saveSummary!(report);
    manager.dispose();
    const restored = createManager();
    expect(restored.get(run.id)).toMatchObject({ status: "stopped", report: undefined,
      lastKnownSummary: { attempt: 1, status: "partial", report: partial } });
  });

  it("restores every unacknowledged result beyond the history cap and persists acknowledgements", () => {
    const { store, createManager } = fixture();
    for (let index = 0; index < 30; index++) store.save({ ...assignment,
      id: `child-${index}`, parentSessionId: "parent", attempt: 1, status: "completed",
      createdAt: index, updatedAt: index, report: `Report ${index}`, events: [], resultAcknowledged: false,
    });
    const manager = createManager();
    expect(manager.pendingResults()).toHaveLength(30);
    const messages: ChatMessage[] = [{ role: "system", content: "Stable parent prefix" }];
    const inbox = new SubagentInbox(manager, "parent", messages);
    const deliveries = inbox.prepare({ maxRequestTokens: 100_000, estimateTokens: (items) => items.reduce((sum, item) => sum + item.content.length, 0) });
    expect(new Set(deliveries.map(({ id }) => id)).size).toBe(30);
    expect(messages[0]).toEqual({ role: "system", content: "Stable parent prefix" });
    inbox.acknowledge(deliveries);
    manager.dispose();
    expect(createManager().pendingResults()).toEqual([]);
    expect(store.load("parent")).toHaveLength(24);
  });

  it("upgrades legacy reports and rejects invalid summary metadata", () => {
    const run: SubagentRun = { ...assignment, id: "legacy", parentSessionId: "parent", attempt: 1,
      status: "completed", createdAt: 1, updatedAt: 1, events: [], report };
    expect(restoreSubagentRun(run, "parent")?.lastKnownSummary).toEqual({ attempt: 1, status: "completed", report });
    for (const summary of [null, { attempt: 2, status: "completed", report }, { attempt: 1, status: "stopped", report }, { attempt: 1, status: "partial", report: "" }]) {
      expect(restoreSubagentRun({ ...run, lastKnownSummary: summary }, "parent")).toBeUndefined();
    }
  });

  it("redacts stored summaries separately from report and activity fields", () => {
    const { store } = fixture();
    store.save({ ...assignment, id: "redacted", parentSessionId: "parent", attempt: 2,
      status: "stopped", createdAt: 1, updatedAt: 2, events: [],
      lastKnownSummary: { attempt: 1, status: "completed", report: `${report}\npassword=private` } });
    const restored = store.load("parent")[0]!;
    expect(restored.lastKnownSummary?.report).toContain("password=[redacted]");
    expect(restored.lastKnownSummary?.report).not.toContain("private");
  });
});
