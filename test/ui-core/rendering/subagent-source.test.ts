import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentEvent, SubagentRun } from "../../../src/agent/subagents/types.js";
import { createSubagentPagerSource, formatSubagentRun } from "../../../src/ui-core/rendering/subagent-source.js";

function run(events: Array<Pick<SubagentEvent, "kind" | "text">> = [], extra: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "inspector", parentSessionId: "parent", title: "Inspect orchestration",
    prompt: "Trace delegation and report evidence", cwd: "/workspace", provider: "openai", model: "test",
    attempt: 1, status: "running", createdAt: 1, updatedAt: 1,
    events: events.map((event, sequence) => ({ ...event, sequence, timestamp: sequence })),
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

describe("subagent presentation", () => {
  it("shows read paths and exact options, not file bodies or protocol envelopes", () => {
    const text = formatSubagentRun(run([
      { kind: "assistant", text: 'Inspecting the worker.\n```tool\n{"name":"fs.read","args":{"path":"src/worker.ts"}}\n```' },
      { kind: "tool", text: 'Calling fs.read: {"path":"src/worker.ts","offset":81,"limit":80,"lines":true}' },
      { kind: "tool", text: "Success: 81: export const PRIVATE_FILE_BODY = 42;\n# hasMore=true next={\"offset\":161,\"limit\":80}" },
      { kind: "tool", text: 'Calling fs.search: {"path":"src","pattern":"orchestrat.*","glob":"**/*.ts"}' },
      { kind: "tool", text: "Success: src/worker.ts:81: PRIVATE_FILE_BODY" },
    ]));
    expect(text).toContain('✓ fs.read src/worker.ts (offset=81, limit=80, lines=true)');
    expect(text).toContain('✓ fs.search src (pattern="orchestrat.*", glob="**/*.ts")');
    expect(text).toContain("Inspecting the worker.");
    expect(text).not.toMatch(/PRIVATE_FILE_BODY|```tool|\[tool\]|hasMore|In progress/);
  });

  it("does not truncate command arguments and preserves denial diagnostics", () => {
    const command = `inspect ${"long-path/".repeat(200)}end --option=value`;
    const text = formatSubagentRun(run([
      { kind: "tool", text: `Calling shell.exec: ${JSON.stringify({ command })}` },
      { kind: "tool", text: "Error: Tool denied: shell.exec" },
    ]));
    expect(text).toContain(`✗ shell.exec ${command}`);
    expect(text).toContain("Tool denied: shell.exec");
    expect(text).not.toContain("✓");
  });

  it("presents streamed and final reports once without duplicating error notices", () => {
    const report = "Status: complete\n## Findings\nOne finding with evidence.";
    const text = formatSubagentRun(run([
      { kind: "assistant", text: report },
      { kind: "assistant", text: report },
    ], { status: "completed", report }));
    expect(text.match(/One finding/g)).toHaveLength(1);
    expect(text).toContain("## Report");
    const bounded = formatSubagentRun(run([
      { kind: "assistant", text: `${report}\nBeyond the report retention limit` },
    ], { status: "completed", report }));
    expect(bounded.match(/One finding/g)).toHaveLength(1);
    const error = "Provider unavailable";
    const failed = formatSubagentRun(run([
      { kind: "notice", text: `Subagent did not complete: ${error}` },
    ], { status: "error", error }));
    expect(failed.match(/Provider unavailable/g)).toHaveLength(1);
  });

  it("does not expose incomplete fenced tool JSON while streaming", () => {
    const text = formatSubagentRun(run([
      { kind: "assistant", text: 'Looking up the entrypoint.\n```tool\n{"name":"fs.read","args":' },
    ]));
    expect(text).toContain("Looking up the entrypoint.");
    expect(text).not.toMatch(/```|"args"/);
  });

  it("does not label interrupted calls as still running", () => {
    const text = formatSubagentRun(run([
      { kind: "tool", text: 'Calling fs.read: {"path":"src/worker.ts"}' },
    ], { status: "stopped", error: "Stopped by parent" }));
    expect(text).toContain("No result recorded");
    expect(text).toContain("## Stopped");
    expect(text).not.toContain("In progress");
  });

  it("distinguishes partial work and evidence-only recovery from exact continuation", () => {
    const text = formatSubagentRun(run([
      { kind: "assistant", text: "Status: complete\nMore evidence is needed." },
    ], { status: "partial", report: "Status: partial\nMore evidence is needed.", recovery: "history" }));
    expect(text).toContain("Partial report · investigation unfinished");
    expect(text.match(/More evidence is needed/g)).toHaveLength(1);
    expect(text).not.toContain("Status: complete");
    expect(text).toContain("retained evidence; exact checkpoint unavailable");
    expect(formatSubagentRun(run([], { recovery: "exact" }))).toContain("saved conversation checkpoint");
  });
});

describe("subagent pager snapshots", () => {
  it("formats an immutable run once across reads and searches", async () => {
    const snapshot = run([{ kind: "assistant", text: "Stable finding" }]);
    const events = vi.fn(() => snapshot.events);
    const observed = { ...snapshot, get events() { return events(); } };
    const source = createSubagentPagerSource({ get: () => observed, subscribe: () => () => undefined }, snapshot.id);
    try {
      await source.readPage(0);
      await source.readTail!();
      await source.search("finding", 0, false);
      expect(await source.readAll()).toContain("Stable finding");
      expect(events).toHaveBeenCalledOnce();
    } finally {
      source.dispose();
    }
  });

  it("ignores other child updates and releases pending notifications on disposal", async () => {
    vi.useFakeTimers();
    let snapshot: SubagentRun | undefined = run();
    const listeners = new Set<() => void>();
    const source = createSubagentPagerSource({
      get: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }, "inspector");
    const changed = vi.fn();
    source.watch!(changed);
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    snapshot = run([{ kind: "assistant", text: "New finding" }]);
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledOnce();
    expect(await source.readAll()).toContain("New finding");
    snapshot = undefined;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(await source.readAll()).toContain("no longer available");
    for (const listener of listeners) listener();
    source.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(listeners.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(source.isGrowing!()).toBe(false);
  });
});
