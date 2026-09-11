import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentManager } from "../src/agent/subagents/manager.js";
import { mintSessionId } from "../src/app/controllers/session-persistence.js";
import type { SubagentAssignment, SubagentCheckpoint, SubagentRun, SubagentStore, SubagentWorkerInput } from "../src/agent/subagents/types.js";

const assignment: SubagentAssignment = { title: "Investigate", prompt: "Read the implementation", cwd: "/tmp", provider: "openai", model: "test" };
const managers: SubagentManager[] = [];
const settlements: (() => void)[] = [];
function controlled(store?: SubagentStore, parentSessionId = "parent") {
  const work: { input: SubagentWorkerInput; resolve: (report: string) => void; reject: (error: Error) => void }[] = [];
  const manager = new SubagentManager(parentSessionId, {
    ...(store ? { store } : {}),
    worker: (input) => new Promise<string>((resolve, reject) => { work.push({ input, resolve, reject }); settlements.push(() => resolve("Settled during cleanup")); }),
  });
  managers.push(manager);
  return { manager, work };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const settle of settlements.splice(0)) settle();
  await tick();
  await tick();
  vi.useRealTimers();
});

describe("SubagentManager", () => {
  it("accepts generated session IDs at a secret-prefix clock collision", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1789126537844);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const id = mintSessionId();
      expect(id).toBe("sess-mtwvqvsk-i");
      expect(controlled(undefined, id).manager.parentSessionId).toBe(id);
    } finally {
      random.mockRestore();
    }
  });

  it.each(["sk-secretvalue", "sess-mtwvqvsk-secretvalue", "sess-mtwvqvsk-abc\x1b[0m"])("still rejects secret-like or unsafe parent IDs: %s", (id) => {
    expect(() => new SubagentManager(id)).toThrow("Invalid parent session ID");
  });

  it("is off by default and does not impose a fixed concurrency cap", async () => {
    const { manager, work } = controlled();
    expect(manager.enabled).toBe(false);
    expect(() => manager.start(assignment)).toThrow(/disabled/);
    manager.setEnabled(true);
    const runs = Array.from({ length: 8 }, (_, index) => manager.start({ ...assignment, prompt: `Task ${index}` }));
    expect(new Set(runs.map((run) => run.id)).size).toBe(8);
    await tick();
    expect(work).toHaveLength(8);
    work[0]!.resolve("A report");
    expect((await manager.wait(runs[0]!.id)).status).toBe("completed");
    expect(manager.start(assignment).status).toBe("running");
  });

  it("keeps aborting assignments reserved and ignores late events and reports", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const runs = Array.from({ length: 3 }, (_, index) => manager.start({ ...assignment, prompt: `Task ${index}` }));
    await tick();
    manager.setEnabled(false);
    expect(work.every(({ input }) => input.signal.aborted)).toBe(true);
    manager.setEnabled(true);
    expect(() => manager.start({ ...assignment, prompt: "Task 0" })).toThrow(/Duplicate/);
    work[0]!.input.emit({ kind: "assistant", text: "late secret" });
    work[0]!.resolve("Late completion");
    const stopped = await manager.wait(runs[0]!.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.report).toBeUndefined();
    expect(stopped.events).toEqual([]);
    expect(manager.start(assignment).status).toBe("running");
  });

  it("does not launch work stopped before the worker microtask", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    manager.stop(run.id);
    expect((await manager.wait(run.id)).status).toBe("stopped");
    expect(work).toHaveLength(0);
  });

  it.each(["dispose", "purge"] as const)("preserves duplicate protection after %s until workers actually settle", async (operation) => {
    const previous = controlled(undefined, "previous-session");
    previous.manager.setEnabled(true);
    for (let index = 0; index < 3; index++) previous.manager.start({ ...assignment, prompt: `Previous task ${index}` });
    await tick();
    previous.manager[operation]();
    expect(previous.work.every(({ input }) => input.signal.aborted)).toBe(true);

    const next = controlled(undefined, "next-session");
    next.manager.setEnabled(true);
    expect(() => next.manager.start({ ...assignment, prompt: "Previous task 0" })).toThrow(/Duplicate/);
    expect(next.manager.list()).toEqual([]);
    previous.work[0]!.resolve("Late completion");
    await tick();
    expect(next.manager.start({ ...assignment, prompt: "Previous task 0" }).status).toBe("running");
    expect(() => next.manager.start({ ...assignment, prompt: "Previous task 1" })).toThrow(/Duplicate/);
    previous.work[1]!.reject(new Error("Late failure"));
    await tick();
    expect(next.manager.start({ ...assignment, prompt: "Previous task 1" }).status).toBe("running");
  });

  it("rejects duplicate live assignments regardless of title, including across managers and restarts", async () => {
    const current = controlled();
    const next = controlled(undefined, "next-session");
    current.manager.setEnabled(true);
    next.manager.setEnabled(true);
    const first = current.manager.start(assignment);
    expect(() => current.manager.start({ ...assignment, title: "Different title" })).toThrow(/Duplicate/);
    expect(() => next.manager.start({ ...assignment, title: "Different title", context: "" })).toThrow(/Duplicate/);
    await tick();
    current.manager.stop(first.id);
    expect(() => next.manager.start(assignment)).toThrow(/Duplicate/);
    current.work[0]!.resolve("Late result");
    await current.manager.wait(first.id);
    expect(next.manager.start({ ...assignment, title: "New attempt" }).status).toBe("running");
    expect(() => current.manager.restart(first.id)).toThrow(/Duplicate/);
  });

  it("distinguishes assignments by prompt, context, cwd, provider, and model", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    manager.start(assignment);
    for (const difference of [{ prompt: "Different task" }, { context: "Different context" }, { cwd: "/var/tmp" }, { provider: "anthropic" as const }, { model: "another-model" }]) {
      const run = manager.start({ ...assignment, ...difference });
      await tick();
      work.at(-1)!.resolve("Complete");
      expect((await manager.wait(run.id)).status).toBe("completed");
    }
  });

  it("restarts the same ID, preserves attempt summaries, and rejects live restarts", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const first = manager.start(assignment);
    expect(() => manager.restart(first.id)).toThrow(/previous attempt/);
    await tick();
    work[0]!.resolve("Original findings");
    await manager.wait(first.id);
    const second = manager.restart(first.id);
    expect(second.id).toBe(first.id);
    expect(second.attempt).toBe(2);
    expect(second.report).toBeUndefined();
    expect(second.events.at(-1)).toMatchObject({ kind: "notice", text: "Attempt 1: completed\nOriginal findings" });
    await tick();
    work[1]!.reject(new Error("sk-privatefailure"));
    expect(await manager.wait(first.id)).toMatchObject({ status: "error", error: "sk-••••••" });
  });

  it("keeps exact checkpoints private, isolated and recoverable after an error or stop", async () => {
    const saved: SubagentRun[] = [];
    const { manager, work } = controlled({ load: () => [], save: (run) => saved.push(run), remove: vi.fn() });
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const checkpoint: SubagentCheckpoint = {
      messages: [{ role: "assistant", content: "private evidence", reasoningBlock: { text: "opaque provider artifact" } }],
      pending: { native: true, next: 1, calls: [{ name: "fs.list", args: { path: "/tmp" } }] },
    };
    const original = structuredClone(checkpoint);
    work[0]!.input.saveCheckpoint!(checkpoint);
    checkpoint.messages[0]!.content = "mutation outside the manager";
    work[0]!.reject(new Error("Transient provider failure"));
    expect(await manager.wait(run.id)).toMatchObject({ status: "error", recovery: "exact" });
    expect(JSON.stringify([saved, manager.list()])).not.toMatch(/private evidence|opaque provider artifact|messages/);
    expect(manager.restart(run.id)).toMatchObject({ attempt: 2, recovery: "exact" });
    await tick();
    expect(work[1]!.input.checkpoint).toEqual(original);
    work[1]!.input.checkpoint!.messages[0]!.content = "mutation in the next worker";
    manager.stop(run.id);
    work[1]!.input.saveCheckpoint!({ ...original, messages: [{ role: "assistant", content: "late checkpoint" }] });
    work[1]!.resolve("Late report");
    expect((await manager.wait(run.id)).status).toBe("stopped");
    manager.restart(run.id);
    await tick();
    expect(work[2]!.input.checkpoint).toEqual(original);
  });

  it.each(["completed", "partial", "error", "stopped"] as const)("passes focused follow-ups to %s children without replacing their evidence or native checkpoint", async (status) => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start({ ...assignment, context: "Original scope" });
    await tick();
    const checkpoint: SubagentCheckpoint = {
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "first", name: "fs.list", args: {} }, { id: "second", name: "fs.read", args: { path: "source.ts" } }] },
        { role: "tool", toolCallId: "first", content: "source.ts" },
      ],
      nativeTools: true,
      pending: { native: true, next: 1, calls: [{ id: "first", name: "fs.list", args: {} }, { id: "second", name: "fs.read", args: { path: "source.ts" } }] },
    };
    work[0]!.input.emit({ kind: "tool", text: "source.ts:12: original evidence" });
    work[0]!.input.saveCheckpoint!(checkpoint);
    if (status === "stopped") manager.stop(run.id);
    if (status === "error") work[0]!.reject(new Error("Temporary failure"));
    else work[0]!.resolve(status === "partial" ? "Status: partial\n## Findings\nThe original implementation exports the selected handler.\n## Evidence\nsource.ts:12 exports the handler function.\n## Next steps\nInspect the caller before changing the contract.\n## Coverage gaps\nThe caller has not been inspected." : "Original findings");
    expect((await manager.wait(run.id)).status).toBe(status);
    const followup = { prompt: "Check the caller", context: "Focus on the changed route" };
    expect(manager.restart(run.id, followup)).toMatchObject({ id: run.id, attempt: 2, recovery: "exact", prompt: assignment.prompt, context: "Original scope" });
    followup.prompt = "Mutated by caller";
    await tick();
    expect(work[1]!.input.followup).toEqual({ prompt: "Check the caller", context: "Focus on the changed route" });
    expect(Object.isFrozen(work[1]!.input.followup)).toBe(true);
    expect(work[1]!.input.checkpoint).toEqual({ ...checkpoint, pendingFollowup: { prompt: "Check the caller", context: "Focus on the changed route" } });
    expect(work[1]!.input.run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "source.ts:12: original evidence" }),
      expect.objectContaining({ text: expect.stringContaining(`Attempt 1: ${status}`) }),
      expect.objectContaining({ text: expect.stringContaining("Check the caller") }),
    ]));
  });

  it("does not resend prior follow-up instructions on a plain continuation", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve("Original findings");
    await manager.wait(run.id);
    manager.restart(run.id, { context: "Inspect the caller" });
    await tick();
    expect(work[1]!.input.followup).toEqual({ context: "Inspect the caller" });
    const checkpoint: SubagentCheckpoint = { messages: [{ role: "user", content: "Inspect the caller" }] };
    work[1]!.input.saveCheckpoint!(checkpoint);
    work[1]!.reject(new Error("Temporary failure"));
    await manager.wait(run.id);
    manager.restart(run.id);
    await tick();
    expect(work[2]!.input.followup).toBeUndefined();
    expect(work[2]!.input.checkpoint).toEqual(checkpoint);
    expect(work[2]!.input.run.attempt).toBe(3);
  });

  it("merges durable follow-up fields while delivering only the new delta", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve("Original findings");
    await manager.wait(run.id);
    manager.restart(run.id, { prompt: "Inspect the caller", context: "Original caller context" });
    await tick();
    work[1]!.resolve("Caller findings");
    await manager.wait(run.id);
    const updated = manager.restart(run.id, { context: "The caller moved to routes.ts" });
    expect(updated.followup).toEqual({ prompt: "Inspect the caller", context: "The caller moved to routes.ts" });
    expect(Object.isFrozen(updated.followup)).toBe(true);
    await tick();
    expect(work[2]!.input.followup).toEqual({ context: "The caller moved to routes.ts" });
    expect(work[2]!.input.run.followup).toEqual(updated.followup);
    work[2]!.resolve("Updated caller findings");
    await manager.wait(run.id);
    expect(manager.restart(run.id, { prompt: "Inspect the caller tests" }).followup).toEqual({
      prompt: "Inspect the caller tests", context: "The caller moved to routes.ts",
    });
  });

  it("retains queued follow-ups when stopped before the worker starts", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const checkpoint: SubagentCheckpoint = { messages: [{ role: "assistant", content: "Prior findings" }], finished: true };
    work[0]!.input.saveCheckpoint!(checkpoint);
    work[0]!.resolve("Prior findings");
    await manager.wait(run.id);
    manager.restart(run.id, { prompt: "Inspect the caller" });
    manager.stop(run.id);
    await manager.wait(run.id);
    expect(work).toHaveLength(1);
    manager.restart(run.id);
    await tick();
    expect(work[1]!.input.followup).toBeUndefined();
    expect(work[1]!.input.checkpoint).toEqual({ ...checkpoint, pendingFollowup: { prompt: "Inspect the caller" } });
  });

  it("rejects follow-ups until a stopped attempt actually settles", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    expect(() => manager.restart(run.id, { prompt: "Inspect the caller" })).toThrow("previous attempt");
    manager.stop(run.id);
    expect(() => manager.restart(run.id, { prompt: "Inspect the caller" })).toThrow("previous attempt");
    expect(manager.get(run.id)).toMatchObject({ attempt: 1, status: "stopping" });
    expect(work).toHaveLength(1);
    work[0]!.resolve("Late findings");
    await manager.wait(run.id);
    expect(manager.restart(run.id, { prompt: "Inspect the caller" })).toMatchObject({ attempt: 2, status: "running" });
    await tick();
    expect(work[1]!.input.followup).toEqual({ prompt: "Inspect the caller" });
  });

  it("retains redacted follow-up history across session restoration", async () => {
    const saved = new Map<string, SubagentRun>();
    const store: SubagentStore = { load: () => [...saved.values()], save: (run) => { saved.set(run.id, run); }, remove: vi.fn() };
    const { manager, work } = controlled(store);
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve("Original findings");
    await manager.wait(run.id);
    manager.restart(run.id, { context: "Inspect the caller; api_key=private-token" });
    await tick();
    expect(work[1]!.input.followup).toEqual({ context: "Inspect the caller; api_key=[redacted]" });
    work[1]!.reject(new Error("Interrupted follow-up"));
    await manager.wait(run.id);
    manager.dispose();
    const restored = controlled(store);
    restored.manager.setEnabled(true);
    expect(restored.manager.restart(run.id)).toMatchObject({ id: run.id, attempt: 3, recovery: "history" });
    await tick();
    const input = restored.work[0]!.input;
    expect(input.checkpoint).toBeUndefined();
    expect(input.followup).toBeUndefined();
    expect(input.run.followup).toEqual({ context: "Inspect the caller; api_key=[redacted]" });
    expect(Object.isFrozen(input.run.followup)).toBe(true);
    expect(saved.get(run.id)?.followup).toEqual(input.run.followup);
    expect(JSON.stringify(input.run.events)).toContain("Inspect the caller");
    expect(JSON.stringify([...saved.values()])).not.toContain("private-token");
    expect(input.run.events.some((event) => event.text.includes("Original findings"))).toBe(true);
  });

  it.each([
    { prompt: "" }, { prompt: " \n " }, { prompt: "\x1b[31m" }, { prompt: "x".repeat(12001) },
    { context: "" }, { context: "\x1b[31m" }, { context: "x".repeat(24001) },
  ])("rejects invalid follow-ups without changing a settled child ($#)", async (followup) => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve("Original findings");
    const settled = await manager.wait(run.id);
    expect(() => manager.restart(run.id, followup)).toThrow(/non-empty string/);
    expect(manager.get(run.id)).toBe(settled);
    await tick();
    expect(work).toHaveLength(1);
  });

  it("retains provider-sized private checkpoints without a separate execution budget", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const checkpoint: SubagentCheckpoint = { messages: [{ role: "user", content: "x".repeat(1_048_576) }] };
    work[0]!.input.saveCheckpoint!(checkpoint);
    work[0]!.reject(new Error("Provider disconnected"));
    await manager.wait(run.id);
    manager.restart(run.id);
    await tick();
    expect(work[1]!.input.checkpoint).toEqual(checkpoint);
  });

  it("settles partial reports without advertising successful completion", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const report = "Status: partial\n## Findings\nThe selected runtime exports a worker; its consumers remain unverified.\n## Evidence\nsrc/worker.ts:1 exports the worker factory.\n## Next steps\nInspect callers before changing its contract.\n## Coverage gaps\nThe investigation ended before callers were examined.";
    work[0]!.resolve(report);
    expect(await manager.wait(run.id)).toMatchObject({ status: "partial", report, error: undefined });
    expect((await manager.wait(run.id, 0)).status).toBe("partial");
    expect(manager.restart(run.id)).toMatchObject({ attempt: 2, recovery: "history" });
  });

  it.each(["Status: partial\nNo evidence", "Status: complete\nNo evidence"])("rejects invalid structured reports: %s", async (report) => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve(report);
    expect(await manager.wait(run.id)).toMatchObject({ status: "error", report: undefined, error: "Worker returned an invalid report" });
  });

  it("cancels and times out waits without stopping the worker", async () => {
    vi.useFakeTimers();
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const abort = new AbortController();
    const cancelled = manager.wait(run.id, 1000, abort.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await rejection;
    expect(work[0]!.input.signal.aborted).toBe(false);
    const timedOut = manager.wait(run.id, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect((await timedOut).status).toBe("running");
    const alreadyAborted = AbortSignal.abort();
    await expect(manager.wait(run.id, 100, alreadyAborted)).rejects.toMatchObject({ name: "AbortError" });
    const waiting = manager.wait(run.id);
    const disposed = expect(waiting).rejects.toThrow(/disposed/);
    manager.dispose();
    await disposed;
  });

  it("waits without a polling deadline and wakes for any terminal child", async () => {
    vi.useFakeTimers();
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const first = manager.start(assignment);
    const second = manager.start({ ...assignment, prompt: "Independent task" });
    await tick();
    const delivered = vi.fn();
    const waiting = manager.waitAny().then(delivered);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered).not.toHaveBeenCalled();
    work[1]!.reject(new Error("Provider unavailable"));
    await waiting;
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id: second.id, status: "error", error: "Provider unavailable" }));
    expect(manager.get(first.id)?.status).toBe("running");
    expect(manager.pendingResults()).toHaveLength(1);
    expect((await manager.waitAny())?.id).toBe(second.id);
    manager.acknowledgeResult(second.id, second.attempt);
    const next = manager.waitAny();
    work[0]!.resolve("Completed findings");
    expect(await next).toMatchObject({ id: first.id, report: "Completed findings" });
  });

  it("keeps terminal deliveries immutable and acknowledges the exact attempt", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.resolve("First result");
    await manager.wait(run.id);
    manager.restart(run.id, { prompt: "Follow up" });
    await tick();
    work[1]!.resolve("Second result");
    await manager.wait(run.id);
    expect(manager.pendingResults().map((result) => [result.attempt, result.report])).toEqual([[1, "First result"], [2, "Second result"]]);
    manager.acknowledgeResult(run.id, 1);
    expect(manager.pendingResults()).toEqual([expect.objectContaining({ attempt: 2, report: "Second result" })]);
    manager.acknowledgeResult(run.id, 1);
    expect(manager.pendingResults()).toHaveLength(1);
    manager.purge();
    expect(manager.pendingResults()).toEqual([]);
    expect(await manager.waitAny()).toBeUndefined();
  });

  it("cancels an any-child join without cancelling its workers", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    manager.start(assignment);
    await tick();
    const controller = new AbortController();
    const waiting = manager.waitAny(undefined, undefined, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(work[0]!.input.signal.aborted).toBe(false);
    expect(manager.pendingResults()).toEqual([]);
  });

  it("wakes on a stopped child only after its operation settles", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    const delivered = vi.fn();
    const waiting = manager.waitAny([run.id]).then(delivered);
    manager.stop(run.id);
    await tick();
    expect(delivered).not.toHaveBeenCalled();
    work[0]!.resolve("Late result");
    await waiting;
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped", report: undefined }));
  });

  it("does not turn disk retention into an assignment limit or drop live session history", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const active = manager.start(assignment);
    for (let index = 0; index < 23; index++) {
      const run = manager.start({ ...assignment, prompt: `Task ${index}` });
      await tick();
      work.at(-1)!.resolve(`Report ${index}`);
      await manager.wait(run.id);
    }
    expect(manager.list()).toHaveLength(24);
    expect(manager.get(active.id)?.status).toBe("running");
    const retained = manager.list();
    expect(manager.start({ ...assignment, prompt: "New task" }).status).toBe("running");
    expect(manager.list().slice(0, 24)).toEqual(retained);
    expect(manager.restart(retained.at(-1)!.id).attempt).toBe(2);
  });

  it("merges assistant deltas before redaction and bounds activity without truncating reports", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start({ ...assignment, title: "\x1b[31mTitle\x1b[0m", context: "api_key=privatevalue" });
    await tick();
    const emit = work[0]!.input.emit;
    emit({ kind: "assistant", text: "sk-first", append: true });
    emit({ kind: "assistant", text: "second", append: true });
    expect(manager.get(run.id)?.events.at(-1)?.text).toBe("sk-••••••");
    expect(manager.get(run.id)?.title).toBe("Title");
    expect(manager.get(run.id)?.context).toBe("api_key=[redacted]");
    for (let index = 0; index < 120; index++) emit({ kind: "tool", text: `${index} ${"x".repeat(2000)}` });
    emit({ kind: "assistant", text: "z".repeat(150_000) });
    work[0]!.resolve("\x1b]52;c;evil\x07sk-private " + "r".repeat(50_000));
    const result = await manager.wait(run.id);
    expect(result.events.length).toBeLessThanOrEqual(96);
    expect(result.report).toBe("sk-•••••• " + "r".repeat(50_000));
    const chars = [result.title, result.prompt, result.context, result.error, result.cwd, result.provider, result.model, result.id, result.parentSessionId, ...result.events.map((event) => event.text)].reduce<number>((sum, text) => sum + (text?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(128_000);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("throttles event notifications and persistence, then flushes completion", async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { manager, work } = controlled({ load: () => [], save, remove: vi.fn() });
    manager.setEnabled(true);
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    const run = manager.start(assignment);
    await tick();
    for (let index = 0; index < 20; index++) work[0]!.input.emit({ kind: "assistant", text: "x", append: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(2);
    work[0]!.resolve("Final report");
    await tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ status: "completed", report: "Final report" });
    unsubscribe();
    expect((await manager.wait(run.id)).report).toBe("Final report");
  });

  it("reuses frozen snapshots until that child changes", async () => {
    const save = vi.fn();
    const { manager, work } = controlled({ load: () => [], save, remove: vi.fn() });
    manager.setEnabled(true);
    const first = manager.start(assignment);
    const second = manager.start({ ...assignment, prompt: "Another task" });
    await tick();
    expect(manager.get(first.id)).toBe(first);
    expect(manager.list()).toEqual([first, second]);
    expect(manager.list()[0]).toBe(first);
    expect(Object.isFrozen(manager.list())).toBe(true);
    work[0]!.input.emit({ kind: "assistant", text: "sk-private", append: true });
    const updated = manager.get(first.id)!;
    expect(updated).not.toBe(first);
    expect(manager.get(first.id)).toBe(updated);
    expect(manager.list()[0]).toBe(updated);
    expect(manager.get(second.id)).toBe(second);
    expect(first.events).toEqual([]);
    expect(updated.events[0]?.text).toBe("sk-••••••");
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated.events)).toBe(true);
    expect(Object.isFrozen(updated.events[0])).toBe(true);
    expect(Reflect.set(updated.events[0]!, "text", "mutated")).toBe(false);
    work[0]!.input.emit({ kind: "assistant", text: "suffix", append: true });
    const appended = manager.get(first.id)!;
    expect(appended).not.toBe(updated);
    expect(appended.events[0]?.text).toBe("sk-••••••");
    manager.stop(first.id);
    const stopping = manager.get(first.id)!;
    expect(stopping).not.toBe(appended);
    expect(save.mock.calls.at(-1)?.[0]).toBe(stopping);
    work[0]!.resolve("Late report");
    const stopped = await manager.wait(first.id);
    expect(stopped).not.toBe(stopping);
    expect(manager.get(first.id)).toBe(stopped);
    expect(save.mock.calls.at(-1)?.[0]).toBe(stopped);
    const restarted = manager.restart(first.id);
    expect(restarted).not.toBe(stopped);
    expect(manager.get(first.id)).toBe(restarted);
    expect(manager.get(second.id)).toBe(second);
  });

  it("notifies without eagerly reading or passing child snapshots", async () => {
    vi.useFakeTimers();
    const { manager, work } = controlled();
    manager.setEnabled(true);
    manager.start(assignment);
    await tick();
    const list = vi.spyOn(manager, "list");
    const get = vi.spyOn(manager, "get");
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    work[0]!.input.emit({ kind: "assistant", text: "Findings", append: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.mock.calls).toEqual([[]]);
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    unsubscribe();
    list.mockRestore();
    get.mockRestore();
  });

  it("keeps streamed secrets redacted across notifications, failed saves, and tool events", async () => {
    vi.useFakeTimers();
    const snapshots: string[] = [];
    const save = vi.fn((run: SubagentRun) => {
      snapshots.push(JSON.stringify(run));
      if (run.events.length) throw new Error("History unavailable");
    });
    const { manager, work } = controlled({ load: () => [], save, remove: vi.fn() });
    manager.subscribe(() => snapshots.push(JSON.stringify(manager.list())));
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.input.emit({ kind: "assistant", text: '{"api_key":"private', append: true });
    await vi.advanceTimersByTimeAsync(400);
    work[0]!.input.emit({ kind: "tool", text: "Reading file" });
    work[0]!.input.emit({ kind: "assistant", text: 'continuation"}', append: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(manager.get(run.id)?.events.find((event) => event.kind === "assistant")?.text).toBe('{"api_key":[redacted]}');
    expect(snapshots.join("\n")).not.toMatch(/private|continuation/);
    work[0]!.resolve("Complete");
    expect((await manager.wait(run.id)).status).toBe("completed");
  });

  it("does not expose a secret continuation after its assistant event is evicted", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    work[0]!.input.emit({ kind: "assistant", text: "sk-private", append: true });
    for (let index = 0; index < 100; index++) work[0]!.input.emit({ kind: "notice", text: String(index) });
    work[0]!.input.emit({ kind: "assistant", text: "continuation", append: true });
    expect(JSON.stringify(manager.get(run.id))).not.toContain("continuation");
    work[0]!.input.emit({ kind: "assistant", text: "New assistant message" });
    work[0]!.input.emit({ kind: "assistant", text: " continues", append: true });
    expect(manager.get(run.id)?.events.at(-1)?.text).toBe("New assistant message continues");
  });

  it("allows empty context, rejects invisible required text, and isolates invalid restored records", async () => {
    const { manager, work } = controlled();
    manager.setEnabled(true);
    expect(() => manager.start({ ...assignment, title: "\x1b[31m\x1b[0m" })).toThrow(/title/);
    const run = manager.start({ ...assignment, context: "" });
    await tick();
    work[0]!.resolve("Findings");
    const completed = await manager.wait(run.id);
    const restored = new SubagentManager("parent", {
      store: { load: () => [{ ...completed, id: "invalid", title: "\x1b[31m\x1b[0m" }, completed], save: vi.fn(), remove: vi.fn() },
    });
    managers.push(restored);
    expect(restored.list().map((child) => child.id)).toEqual([run.id]);
  });

  it("reports empty and synchronously thrown worker failures explicitly", async () => {
    const worker = vi.fn().mockImplementationOnce(() => { throw new Error("password=privatefailure"); }).mockResolvedValueOnce("");
    const manager = new SubagentManager("parent", { worker });
    managers.push(manager);
    manager.setEnabled(true);
    const run = manager.start(assignment);
    expect(await manager.wait(run.id)).toMatchObject({ status: "error", error: "password=[redacted]" });
    manager.restart(run.id);
    expect(await manager.wait(run.id)).toMatchObject({ attempt: 2, status: "error", error: "Worker returned no report" });
  });

  it("rejects unknown children and invalid waits without allocating work", async () => {
    const { manager } = controlled();
    manager.setEnabled(true);
    expect(() => manager.stop("foreign")).toThrow(/Unknown/);
    expect(() => manager.restart("foreign")).toThrow(/Unknown/);
    await expect(manager.wait("foreign")).rejects.toThrow(/Unknown/);
    const run = manager.start(assignment);
    for (const timeout of [-1, 0.5, 2_147_483_648, Infinity, NaN]) await expect(manager.wait(run.id, timeout)).rejects.toThrow(/timeout/);
    expect((await manager.wait(run.id, 0)).status).toBe("running");
  });

  it("validates assignment sizes and rejects recursive launches", async () => {
    let manager: SubagentManager;
    manager = new SubagentManager("parent", { worker: async () => {
      expect(() => manager.start(assignment)).toThrow(/Recursive/);
      return "Done";
    } });
    managers.push(manager);
    manager.setEnabled(true);
    for (const [key, maximum] of [["title", 120], ["prompt", 12000], ["context", 24000]] as const) {
      expect(() => manager.start({ ...assignment, [key]: "x".repeat(maximum + 1) })).toThrow(key);
    }
    expect((await manager.wait(manager.start(assignment).id)).status).toBe("completed");
  });

  it("purges without late resurrection or allowing duplicate unsettled work", async () => {
    const save = vi.fn();
    const remove = vi.fn();
    const { manager, work } = controlled({ load: () => [], save, remove });
    manager.setEnabled(true);
    const runs = Array.from({ length: 3 }, (_, index) => manager.start({ ...assignment, prompt: `Task ${index}` }));
    await tick();
    const waiting = manager.wait(runs[0]!.id);
    const removed = expect(waiting).rejects.toThrow(/removed/);
    manager.purge();
    await removed;
    expect(manager.list()).toEqual([]);
    expect(remove).toHaveBeenCalledWith("parent");
    expect(() => manager.start({ ...assignment, prompt: "Task 0" })).toThrow(/Duplicate/);
    const saves = save.mock.calls.length;
    work[0]!.resolve("Late");
    await tick();
    expect(save).toHaveBeenCalledTimes(saves);
    expect(manager.list()).toEqual([]);
    expect(manager.start(assignment).status).toBe("running");
  });

  it("does not recreate cleared history when an old disposed session settles", async () => {
    const save = vi.fn();
    const { manager, work } = controlled({ load: () => [], save, remove: vi.fn() });
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    manager.dispose();
    save.mockClear();
    work[0]!.resolve("Late report after history was cleared");
    await tick();
    expect(manager.get(run.id)?.status).toBe("stopped");
    expect(save).not.toHaveBeenCalled();
  });

  it("restores interrupted children as stopped without worker calls and isolates parents", async () => {
    const saved: SubagentRun[] = [];
    const { manager, work } = controlled({ load: () => saved, save: (run) => { saved.push(run); }, remove: () => undefined });
    manager.setEnabled(true);
    const run = manager.start(assignment);
    await tick();
    expect(work).toHaveLength(1);
    saved.push({ ...saved[0]!, parentSessionId: "another", id: "foreign" });
    const worker = vi.fn(async () => "Unexpected");
    const restored = new SubagentManager("parent", { worker, store: { load: () => saved, save: () => undefined, remove: () => undefined } });
    managers.push(restored);
    expect(restored.enabled).toBe(false);
    expect(restored.get(run.id)?.status).toBe("stopped");
    expect(restored.get("foreign")).toBeUndefined();
    restored.setEnabled(true);
    await tick();
    expect(worker).not.toHaveBeenCalled();
  });
});
