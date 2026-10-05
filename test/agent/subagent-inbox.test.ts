import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentInbox } from "../../src/agent/turn/subagent-inbox.js";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { ChatMessage } from "../../src/types.js";
import type { SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { runSubagentTool } from "../../src/agent/subagents/tools.js";

const managers: SubagentManager[] = [];
const settlements: (() => void)[] = [];
const estimateTokens = (messages: ChatMessage[]): number => messages.reduce((total, message) => total + message.content.length, 0);
const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function setup(sessionId = "parent") {
  const work: { input: SubagentWorkerInput; resolve: (report: string) => void; reject: (error: Error) => void }[] = [];
  const manager = new SubagentManager(sessionId, {
    worker: (input) => new Promise<string>((resolve, reject) => {
      work.push({ input, resolve, reject });
      settlements.push(() => resolve("Cleanup"));
    }),
  });
  managers.push(manager);
  manager.setEnabled(true);
  const messages: ChatMessage[] = [{ role: "system", content: "Stable prefix" }, { role: "user", content: "Research" }];
  const inbox = new SubagentInbox(manager, sessionId, messages);
  const start = () => manager.start({ title: "Research", prompt: `Task ${manager.list().length}`, provider: "openai", model: "test", cwd: "/tmp" });
  return { manager, work, messages, inbox, start };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const settle of settlements.splice(0)) settle();
  await tick();
});

describe("SubagentInbox", () => {
  it("appends evidence once across retries and acknowledges only after success", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const prefix = structuredClone(messages);
    const run = start();
    await tick();
    work[0]!.resolve("Verified report");
    await manager.wait(run.id);
    const deliveries = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    expect(messages.slice(0, 2)).toEqual(prefix);
    expect(messages[2]).toMatchObject({ role: "user", internal: true });
    expect(messages[2]!.content).toContain("Verified report");
    expect(manager.pendingResults()).toHaveLength(1);
    expect(inbox.prepare({ maxRequestTokens: 10_000, estimateTokens })).toEqual(deliveries);
    expect(messages).toHaveLength(3);
    inbox.acknowledge(deliveries);
    expect(manager.pendingResults()).toEqual([]);
    expect(await inbox.beforeFinal()).toBe(false);
  });

  it("re-prepares evidence removed by compaction rather than losing the result", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("Verified report");
    await manager.wait(run.id);
    const first = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    messages.pop();
    inbox.acknowledge(first);
    expect(manager.pendingResults()).toHaveLength(1);
    expect(inbox.prepare({ maxRequestTokens: 10_000, estimateTokens })).toHaveLength(1);
    expect(messages[2]!.content).toContain("Verified report");
  });

  it("acknowledges the report only after every page reaches a successful request", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    const report = "A".repeat(24_000) + "B".repeat(24_000) + "Final evidence";
    work[0]!.resolve(report);
    await manager.wait(run.id);
    const delivered: string[] = [];
    for (const offset of [0, 24_000, 48_000]) {
      const pages = inbox.prepare({ maxRequestTokens: 100_000, estimateTokens });
      expect(pages).toHaveLength(1);
      expect(pages[0]?.offset).toBe(offset);
      const page = JSON.parse(pages[0]!.message.content.split("\n").at(-1)!);
      delivered.push(page.report);
      const request = structuredClone(messages);
      inbox.acknowledge(pages, request.filter((message) => message.content !== pages[0]!.message.content));
      expect(manager.pendingResults()).toHaveLength(1);
      inbox.acknowledge(pages, request);
      expect(manager.get(run.id)?.deliveredReportChars).toBe(offset + page.report.length);
    }
    expect(delivered.join("")).toBe(report);
    expect(manager.pendingResults()).toEqual([]);
    expect(manager.get(run.id)?.resultAcknowledged).toBe(true);
  });

  it("acknowledges contiguous pages delivered together through tools in a single successful request", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("First evidence. ".repeat(2000));
    await manager.wait(run.id);
    const context = { manager, provider: "openai" as const, model: "test", cwd: "/tmp" };
    for (const offset of [24_000, 0]) {
      const result = await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report", offset } }, context, new AbortController().signal);
      messages.push({ role: "tool", content: result.output, subagentReceipt: result.subagentReceipt });
    }
    const deliveries = inbox.prepare({ maxRequestTokens: 100_000, estimateTokens });
    expect(messages).toHaveLength(4);
    expect(manager.pendingResults()).toHaveLength(1);
    inbox.acknowledge(deliveries, structuredClone(messages));
    expect(manager.pendingResults()).toEqual([]);
  });

  it("redelivers an acknowledgement whose parent history was lost before persistence", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("Durable evidence");
    await manager.wait(run.id);
    inbox.acknowledge(inbox.prepare({ maxRequestTokens: 10_000, estimateTokens }));
    expect(manager.pendingResults()).toEqual([]);
    messages.splice(2);
    const resumed = new SubagentInbox(manager, "parent", messages);
    expect(manager.pendingResults()).toHaveLength(1);
    expect(resumed.prepare({ maxRequestTokens: 10_000, estimateTokens })[0]?.message.content).toContain("Durable evidence");
  });

  it("keeps delivered conclusions after compaction without re-reading the report", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("Verified finding in src/main.ts:42");
    await manager.wait(run.id);
    inbox.acknowledge(inbox.prepare({ maxRequestTokens: 10_000, estimateTokens }));
    messages.splice(2);
    messages.push({ role: "system", content: `DURABLE WORK ENVELOPE\nRead-only subagents: [${run.id}] Research (completed, attempt 1, result read) — Verified finding` });
    const resumed = new SubagentInbox(manager, "parent", messages);
    expect(resumed.prepare({ maxRequestTokens: 10_000, estimateTokens })).toEqual([]);
    const prefix = structuredClone(messages);
    resumed.prepareInventory();
    expect(messages.slice(0, prefix.length)).toEqual(prefix);
    expect(messages.at(-1)?.content).toContain("src/main.ts:42");
    resumed.prepareInventory();
    expect(messages).toHaveLength(prefix.length + 1);
  });

  it("recovers legacy acknowledgements that cannot prove the whole report was delivered", () => {
    const run = { id: "legacy-child", parentSessionId: "parent", attempt: 1, status: "completed" as const,
      title: "Research", prompt: "Inspect the source", cwd: "/tmp", provider: "openai" as const, model: "test",
      createdAt: 1, updatedAt: 2, events: [], report: "Legacy evidence. ".repeat(2000), resultAcknowledged: true };
    const manager = new SubagentManager("parent", { store: { load: () => [run], save: () => undefined, remove: () => undefined } });
    managers.push(manager);
    const messages: ChatMessage[] = [{ role: "system", content: `DURABLE WORK ENVELOPE\n[legacy-child] Research (completed, attempt 1, result read) — Legacy finding` }];
    const inbox = new SubagentInbox(manager, "parent", messages);
    expect(manager.pendingResults()).toHaveLength(1);
    expect(inbox.prepare({ maxRequestTokens: 100_000, estimateTokens })[0]?.offset).toBe(0);
  });

  it("delivers stopped summaries even when new delegation is disabled", async () => {
    const { manager, work, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.input.saveSummary!("Status: partial\n## Findings\nVerified source evidence is retained, but the investigation is incomplete.\n## Evidence\nsrc/main.ts:42 contains the inspected behavior.\n## Next steps\nInspect the consumer.\n## Coverage gaps\nThe consumer has not been read.");
    manager.setEnabled(false);
    work[0]!.resolve("Interrupted");
    await manager.wait(run.id);
    const pages = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    expect(pages[0]?.message.content).toContain("src/main.ts:42");
    inbox.acknowledge(pages);
    expect(manager.pendingResults()).toEqual([]);
  });

  it("bounds large reports to remaining request space and supplies a continuation cursor", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("Evidence. ".repeat(5000));
    await manager.wait(run.id);
    inbox.prepare({ maxRequestTokens: 1500, estimateTokens });
    expect(estimateTokens(messages)).toBeLessThanOrEqual(1500);
    const result = JSON.parse(messages.at(-1)!.content.split("\n").at(-1)!);
    expect(result).toMatchObject({ id: run.id, attempt: 1, reportOffset: 0, reportLength: 50_000 });
    expect(result.nextOffset).toBe(result.report.length);
    expect(result.nextOffset).toBeGreaterThan(0);
  });

  it("fails explicitly without dropping a result when even its receipt cannot fit", async () => {
    const { manager, work, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("Evidence");
    await manager.wait(run.id);
    expect(() => inbox.prepare({ maxRequestTokens: 1, estimateTokens })).toThrow("Insufficient request context");
    expect(manager.pendingResults()).toHaveLength(1);
  });

  it("nudges the parent to launch siblings before waiting on a lone gatherer", async () => {
    const { manager, work, messages, inbox, start } = setup();
    start();
    await tick();
    const onWaiting = vi.fn();
    expect(await inbox.beforeFinal(undefined, onWaiting)).toBe(true);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(messages.at(-1)?.content).toContain("launch every other independent context assignment");

    let finished = false;
    const waiting = inbox.beforeFinal(undefined, onWaiting).then((result) => { finished = true; return result; });
    await tick();
    expect(finished).toBe(false);
    expect(onWaiting).toHaveBeenCalledOnce();
    work[0]!.resolve("Evidence");
    expect(await waiting).toBe(true);
    expect(manager.pendingResults()).toHaveLength(1);
  });

  it.each(["completed", "error", "stopped"] as const)("joins %s without polling or cancelling healthy children", async (status) => {
    const { manager, work, inbox, start } = setup();
    const first = start();
    start();
    await tick();
    const onWaiting = vi.fn();
    let finished = false;
    const wait = inbox.beforeFinal(undefined, onWaiting).then((result) => { finished = true; return result; });
    await tick();
    expect(finished).toBe(false);
    expect(onWaiting).toHaveBeenCalledOnce();
    if (status === "stopped") manager.stop(first.id);
    if (status === "error") work[0]!.reject(new Error("Provider failed"));
    else work[0]!.resolve("Evidence");
    expect(await wait).toBe(true);
    expect(manager.get(first.id)?.status).toBe(status);
    expect(work[1]!.input.signal.aborted).toBe(false);
  });

  it("cancels the parent's wait without aborting its child", async () => {
    const { work, inbox, start } = setup();
    start();
    await tick();
    const controller = new AbortController();
    const wait = inbox.beforeFinal(controller.signal);
    controller.abort(new Error("Parent interrupted"));
    await expect(wait).rejects.toThrow("Parent interrupted");
    expect(work[0]!.input.signal.aborted).toBe(false);
  });

  it("delivers old attempt evidence separately after a restart", async () => {
    const { manager, work, inbox, start } = setup();
    const run = start();
    await tick();
    work[0]!.resolve("First report");
    await manager.wait(run.id);
    manager.restart(run.id, { prompt: "Follow up" });
    const deliveries = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    expect(deliveries[0]).toMatchObject({ id: run.id, attempt: 1 });
    inbox.acknowledge(deliveries);
    expect(manager.get(run.id)?.attempt).toBe(2);
    expect(manager.get(run.id, 1)?.report).toBe("First report");
  });

  it("delivers concurrent distinct children once in reverse settlement order and preserves that order on retry", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const prefix = structuredClone(messages);
    const first = start();
    const second = start();
    const third = start();
    await tick();

    work[2]!.resolve("Third report");
    work[1]!.resolve("Second report");
    work[0]!.resolve("First report");
    await Promise.all([manager.wait(first.id), manager.wait(second.id), manager.wait(third.id)]);

    const deliveries = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    expect(messages.slice(0, 2)).toEqual(prefix);
    expect(deliveries.map(({ id, attempt }) => ({ id, attempt }))).toEqual([
      { id: third.id, attempt: 1 },
      { id: second.id, attempt: 1 },
      { id: first.id, attempt: 1 },
    ]);
    expect(messages.slice(2).map((message) => JSON.parse(message.content.split("\n").at(-1)!))).toEqual([
      expect.objectContaining({ id: third.id, attempt: 1, report: "Third report" }),
      expect.objectContaining({ id: second.id, attempt: 1, report: "Second report" }),
      expect.objectContaining({ id: first.id, attempt: 1, report: "First report" }),
    ]);
    expect(inbox.prepare({ maxRequestTokens: 10_000, estimateTokens })).toEqual(deliveries);
    expect(messages).toHaveLength(5);
    inbox.acknowledge(deliveries);
    expect(manager.pendingResults()).toEqual([]);
  });

  it("queues a result that settles during a request for the next request without rewriting its prefix", async () => {
    const { manager, work, messages, inbox, start } = setup();
    const prefix = structuredClone(messages);
    const first = start();
    const second = start();
    await tick();

    work[0]!.resolve("First report");
    await manager.wait(first.id);
    const firstRequestDeliveries = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    const firstRequestMessages = structuredClone(messages);

    work[1]!.resolve("Second report");
    await manager.wait(second.id);
    expect(messages).toEqual(firstRequestMessages);
    expect(messages.slice(0, 2)).toEqual(prefix);
    expect(manager.pendingResults().map(({ id, attempt }) => ({ id, attempt }))).toEqual([
      { id: first.id, attempt: 1 },
      { id: second.id, attempt: 1 },
    ]);

    inbox.acknowledge(firstRequestDeliveries);
    const nextRequestDeliveries = inbox.prepare({ maxRequestTokens: 10_000, estimateTokens });
    expect(nextRequestDeliveries.map(({ id, attempt }) => ({ id, attempt }))).toEqual([
      { id: second.id, attempt: 1 },
    ]);
    expect(messages.slice(0, 2)).toEqual(prefix);
    expect(messages).toHaveLength(4);
  });

  it("ignores disabled or foreign-session managers", async () => {
    const { manager, messages, inbox, start } = setup();
    start();
    const foreign = new SubagentInbox(manager, "another-parent", messages);
    expect(await foreign.beforeFinal()).toBe(false);
    expect(foreign.prepare({ maxRequestTokens: 10_000, estimateTokens })).toEqual([]);
    manager.setEnabled(false);
    expect(await inbox.beforeFinal()).toBe(false);
  });
});
