import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentInbox } from "../../src/agent/turn/subagent-inbox.js";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { ChatMessage } from "../../src/types.js";
import type { SubagentWorkerInput } from "../../src/agent/subagents/types.js";

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
