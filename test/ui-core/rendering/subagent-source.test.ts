import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSubagentStore } from "../../../src/store/subagents.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentEvent, SubagentRun } from "../../../src/agent/subagents/types.js";
import { createSubagentPagerSource, formatSubagentRun, orderSubagentRuns, subagentsBarVisible } from "../../../src/ui-core/rendering/subagent-source.js";
import { subagentDurationLabel } from "../../../src/ui-core/rendering/duration.js";

function run(events: Array<Pick<SubagentEvent, "kind" | "text">> = [], extra: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "inspector", parentSessionId: "parent", title: "Inspect orchestration",
    prompt: "Trace delegation and report evidence", cwd: "/workspace", provider: "openai", model: "test",
    attempt: 1, status: "running", createdAt: 1, updatedAt: 1,
    events: events.map((event, sequence) => ({ ...event, sequence: sequence + 1, timestamp: sequence })),
    ...extra,
  };
}

const temporaryDirectories: string[] = [];

function historyDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "clai-subagent-source-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("subagent duration", () => {
  it.each(["running", "stopping"] as const)("keeps %s time live across activity updates", (status) => {
    const snapshot = run([], { status, createdAt: 1000, startedAt: 1000, updatedAt: 9000 });
    expect(subagentDurationLabel(snapshot, 11_000)).toBe("elapsed 10s");
    expect(subagentDurationLabel(snapshot, 66_000)).toBe("elapsed 1m05s");
    expect(formatSubagentRun(snapshot, 66_000)).toContain("Elapsed 1m05s");
  });

  it.each(["completed", "partial", "stopped", "error"] as const)("freezes %s duration at settlement", (status) => {
    const snapshot = run([], { status, createdAt: 1000, startedAt: 8000, updatedAt: 12_000 });
    expect(subagentDurationLabel(snapshot, 100_000)).toBe("duration 4.0s");
    expect(subagentDurationLabel(snapshot, 200_000)).toBe("duration 4.0s");
  });

  it("labels legacy multi-attempt totals and omits invalid spans", () => {
    expect(subagentDurationLabel(run([], { attempt: 2, createdAt: 1000 }), 11_000)).toBe("total elapsed 10s");
    expect(subagentDurationLabel(run([], { attempt: 2, status: "stopped", createdAt: 1000, updatedAt: 11_000 }), 90_000)).toBe("total duration 10s");
    expect(subagentDurationLabel(run([], { startedAt: 2000 }), 1000)).toBe("");
    expect(subagentDurationLabel(run([], { startedAt: NaN }), 1000)).toBe("");
  });
});

describe("subagent presentation", () => {
  it("shows read paths and exact options, not file bodies or protocol envelopes", () => {
    const text = formatSubagentRun(run([
      { kind: "assistant", text: 'Inspecting the worker.\n```tool\n{"name":"fs.read","args":{"path":"src/worker.ts"}}\n```' },
      { kind: "tool", text: 'Calling fs.read: {"path":"src/worker.ts","offset":81,"limit":80,"lines":true}' },
      { kind: "tool", text: "Success: 81: export const PRIVATE_FILE_BODY = 42;\n# hasMore=true next={\"offset\":161,\"limit\":80}" },
      { kind: "tool", text: 'Calling fs.read: {"path":"src","pattern":"orchestrat.*","glob":"**/*.ts"}' },
      { kind: "tool", text: "Success: src/worker.ts:81: PRIVATE_FILE_BODY" },
    ]));
    expect(text).toContain('✓ fs.read src/worker.ts (offset=81, limit=80, lines=true)');
    expect(text).toContain('✓ fs.read src (pattern="orchestrat.*", glob="**/*.ts")');
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

  it("preserves earlier partial checkpoints that differ from the final report", () => {
    const text = formatSubagentRun(run([
      { kind: "assistant", text: "Status: partial\nInitial evidence and remaining work." },
      { kind: "assistant", text: "Status: complete\nFinal evidence with verified results." },
      { kind: "notice", text: "completed · attempt 1\n\n## Report\nStatus: complete\nFinal evidence with verified results." },
    ], { status: "completed", report: "Status: complete\nFinal evidence with verified results." }));
    expect(text).toContain("Initial evidence and remaining work.");
    expect(text.match(/Final evidence with verified results/g)).toHaveLength(1);
  });

  it("shows the active fallback route instead of the assignment route", () => {
    const text = formatSubagentRun(run([], { activeProvider: "anthropic", activeModel: "fallback" }));
    expect(text).toContain("running · attempt 1 · anthropic/fallback");
    expect(text).not.toContain("openai/test");
    expect(formatSubagentRun(run([]))).toContain("running · attempt 1 · openai/test");
  });
});

describe("subagent bar ordering", () => {
  it("shows live runs first and the most recent settled work next", () => {
    const runs = [
      run([], { id: "old", status: "completed", updatedAt: 1 }),
      run([], { id: "live", status: "running", updatedAt: 2 }),
      run([], { id: "newest-done", status: "error", updatedAt: 3 }),
      run([], { id: "stopping", status: "stopping", updatedAt: 4 }),
    ];
    expect(orderSubagentRuns(runs).map((entry) => entry.id)).toEqual([
      "live",
      "stopping",
      "newest-done",
      "old",
    ]);
  });
});

describe("subagent pager snapshots", () => {
  it("ticks unchanged live snapshots, freezes on completion, and cleans up clocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let snapshot = run([], { createdAt: 1000, startedAt: 1000, updatedAt: 1000 });
    const listeners = new Set<() => void>();
    const source = createSubagentPagerSource({
      get: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }, snapshot.id);
    const changed = vi.fn();
    source.watch!(changed);
    expect(await source.readAll()).toContain("Elapsed 0.0s");
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await source.readAll()).toContain("Elapsed 2.0s");
    snapshot = { ...snapshot, status: "completed", updatedAt: Date.now() };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(await source.readAll()).toContain("Duration 2.0s");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changed).toHaveBeenCalledTimes(3);
    snapshot = { ...snapshot, attempt: 2, status: "running", startedAt: Date.now() };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    source.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
  });

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

describe("durable subagent presentation", () => {
  it("renders all persisted activity with compact tools and one continuous page", async () => {
    const store = createSubagentStore(historyDirectory());
    const report = "Status: complete\nAll documentation was inspected.";
    const archived = run([
      { kind: "assistant", text: "Earliest investigation update" },
      { kind: "tool", text: 'Calling shell.exec: {"command":"pdftotext documentation.pdf -"}' },
      { kind: "tool", text: "Success: PRIVATE_PDF_CONTENT\n".repeat(5000) },
      ...Array.from({ length: 140 }, (_, index) => ({ kind: "assistant" as const, text: `Evidence ${index}: ${"documentation detail ".repeat(40)}` })),
      { kind: "assistant", text: report },
    ], { status: "completed", report, recovery: "exact" });
    store.appendActivity!({ ...archived, events: archived.events.slice(-96) }, archived.events);
    const retained = { ...archived, events: archived.events.slice(-2) };
    const source = createSubagentPagerSource({
      get: () => retained,
      activityPath: () => store.activityPath!(retained.parentSessionId, retained.id),
      subscribe: () => () => undefined,
    }, retained.id);
    try {
      const page = await source.readPage(0);
      expect(page.body).toContain("Earliest investigation update");
      expect(page.body).toContain("✓ shell.exec pdftotext documentation.pdf -");
      expect(page.body).toContain("Evidence 139:");
      expect(page.body).toContain("completed · attempt 1 · openai/test");
      expect(page.body).toContain("saved conversation checkpoint");
      expect(page.body.match(/All documentation was inspected/g)).toHaveLength(1);
      expect(page.body).not.toMatch(/PRIVATE_PDF_CONTENT|Calling |Success:|### Attempt/);
      expect(page.totalBytes).toBeGreaterThan(64 * 1024);
      expect(page.pageCount).toBe(1);
      expect(page.nextOffset).toBe(page.totalBytes);
      expect((await source.readTail!()).body).toBe(page.body);
      expect((await source.search("Earliest", 0, false))?.body).toBe(page.body);
      expect(await source.readAll()).toBe(page.body);
    } finally {
      source.dispose();
    }
  });

  it("retains a supported zero-sequence persisted event after live eviction", async () => {
    const store = createSubagentStore(historyDirectory());
    const archived = run([
      { kind: "assistant", text: "First imported investigation update" },
      { kind: "assistant", text: "Latest retained investigation update" },
    ], { status: "completed" });
    const events = archived.events.map((event) => ({ ...event, sequence: event.sequence - 1 }));
    const snapshot = { ...archived, events: events.slice(-1) };
    store.appendActivity!(snapshot, events);
    const source = createSubagentPagerSource({
      get: () => snapshot,
      activityPath: () => store.activityPath!(snapshot.parentSessionId, snapshot.id),
      subscribe: () => () => undefined,
    }, snapshot.id);
    try {
      const text = await source.readAll();
      expect(text).toContain("First imported investigation update");
      expect(text).toContain("Latest retained investigation update");
    } finally {
      source.dispose();
    }
  });

  it("preserves marker-like assistant text without allowing tool bodies to corrupt framing", async () => {
    const store = createSubagentStore(historyDirectory());
    const quoted = String.raw`Quoted journal examples:

### Attempt 1 · 1000 · tool
Literal header text

\### Attempt 1 · 1001 · assistant
\\### Attempt 1 · 1002 · notice · escaped

### Attempt 1 · 1003 · assistant · escaped
End of quoted examples`;
    const archived = run([
      { kind: "tool", text: 'Calling fs.read: {"path":"first.md"}' },
      { kind: "tool", text: "Success: Tool body\n\n### Attempt 1 · 999 · assistant\nPRIVATE_TOOL_BODY" },
      { kind: "assistant", text: quoted },
      { kind: "tool", text: 'Calling fs.read: {"path":"second.md"}' },
      { kind: "tool", text: "Success: SECOND_PRIVATE_TOOL_BODY" },
      { kind: "assistant", text: "True subsequent investigation update" },
    ], { status: "completed", prompt: "Read examples\n\n### Attempt 1 · 9999 · assistant\nKeep assignment separate" });
    store.appendActivity!(archived, archived.events);
    const snapshot = { ...archived, events: [] };
    const source = createSubagentPagerSource({
      get: () => snapshot,
      activityPath: () => store.activityPath!(snapshot.parentSessionId, snapshot.id),
      subscribe: () => () => undefined,
    }, snapshot.id);
    try {
      const text = await source.readAll();
      expect(text).toContain("✓ fs.read first.md");
      expect(text).toContain("✓ fs.read second.md");
      expect(text).toContain(quoted);
      expect(text).toContain("True subsequent investigation update");
      expect(text).not.toMatch(/PRIVATE_TOOL_BODY|SECOND_PRIVATE_TOOL_BODY/);
    } finally {
      source.dispose();
    }
  });

  it("merges unflushed updates and retains complete persisted assistant text", async () => {
    const store = createSubagentStore(historyDirectory());
    const original = run([
      { kind: "assistant", text: "Started investigation" },
      { kind: "tool", text: 'Calling fs.read: {"path":"documentation.md"}' },
      { kind: "tool", text: "Success: PRIVATE_DOCUMENT_BODY" },
    ]);
    store.appendActivity!(original, original.events);
    let snapshot = run([
      ...original.events,
      { kind: "assistant", text: "Current live update, not saved yet" },
    ]);
    const source = createSubagentPagerSource({
      get: () => snapshot,
      activityPath: () => store.activityPath!(snapshot.parentSessionId, snapshot.id),
      subscribe: () => () => undefined,
    }, snapshot.id);
    try {
      expect(await source.readAll()).toContain("Current live update, not saved yet");
      const complete = { ...snapshot.events.at(-1)!, text: `Current live update: ${"evidence ".repeat(20_000)}COMPLETE_PERSISTED_END` };
      store.appendActivity!(snapshot, [complete]);
      snapshot = { ...snapshot, events: [{ ...complete, text: complete.text.slice(0, 128_000) }] };
      const text = await source.readAll();
      expect(text).toContain("Started investigation");
      expect(text).toContain("✓ fs.read documentation.md");
      expect(text).toContain("COMPLETE_PERSISTED_END");
      expect(text.match(/Current live update:/g)).toHaveLength(1);
      expect(text).not.toContain("PRIVATE_DOCUMENT_BODY");
    } finally {
      source.dispose();
    }
  });

  it("reads appended records across partial UTF-8 and header boundaries", async () => {
    const path = join(historyDirectory(), "activity.txt");
    writeFileSync(path, "# Fixture\n\n## Activity\n\n### Attempt 1 · 1 · assistant\nFirst update\n");
    const snapshot = run([], { status: "completed" });
    const source = createSubagentPagerSource({ get: () => snapshot, activityPath: () => path, subscribe: () => () => undefined }, snapshot.id);
    try {
      expect(await source.readAll()).toContain("First update");
      appendFileSync(path, "\n### Attempt 1 · 2 · assist");
      expect(await source.readAll()).toContain("First update");
      const appended = Buffer.from("ant\nLatest evidence ☃️\n", "utf8");
      const boundary = appended.indexOf(Buffer.from("☃", "utf8")) + 1;
      appendFileSync(path, appended.subarray(0, boundary));
      await source.readAll();
      appendFileSync(path, appended.subarray(boundary));
      const text = await source.readAll();
      expect(text).toContain("First update");
      expect(text).toContain("Latest evidence ☃️");
      expect(text).not.toContain("�");
    } finally {
      source.dispose();
    }
  });

  it("retains live events across eviction and temporary journal unavailability", async () => {
    const path = join(historyDirectory(), "activity.txt");
    writeFileSync(path, "# Fixture\n\n## Activity\n\n### Attempt 1 · 1 · assistant\nArchived beginning\n");
    let snapshot = run([{ kind: "assistant", text: "Unflushed update" }]);
    snapshot = { ...snapshot, events: [{ ...snapshot.events[0]!, sequence: 2 }] };
    let activityPath: string | undefined = path;
    const source = createSubagentPagerSource({ get: () => snapshot, activityPath: () => activityPath, subscribe: () => () => undefined }, snapshot.id);
    try {
      expect(await source.readAll()).toContain("Unflushed update");
      activityPath = undefined;
      snapshot = { ...snapshot, events: [{ sequence: 3, kind: "assistant", text: "Newest update", timestamp: 3 }] };
      const text = await source.readAll();
      expect(text).toContain("Archived beginning");
      expect(text).toContain("Unflushed update");
      expect(text).toContain("Newest update");
    } finally {
      source.dispose();
    }
  });

  it("retains cumulative assistant revisions across intervening tool records", async () => {
    const path = join(historyDirectory(), "activity.txt");
    writeFileSync(path, [
      "# Fixture", "", "## Activity", "",
      "### Attempt 1 · 1 · assistant", "Investigating", "",
      "### Attempt 1 · 2 · tool", 'Calling fs.read: {"path":"README.md"}', "",
      "### Attempt 1 · 3 · tool", "Success: PRIVATE_BODY", "",
      "### Attempt 1 · 1 · assistant", "Investigating with verified evidence", "",
    ].join("\n"));
    const snapshot = run([], { status: "completed" });
    const source = createSubagentPagerSource({ get: () => snapshot, activityPath: () => path, subscribe: () => () => undefined }, snapshot.id);
    try {
      const text = await source.readAll();
      expect(text).toContain("Investigating with verified evidence");
      expect(text.match(/Investigating/g)).toHaveLength(1);
      expect(text).toContain("✓ fs.read README.md");
      expect(text).not.toContain("PRIVATE_BODY");
    } finally {
      source.dispose();
    }
  });

  it("rejects source reads disposed while the durable journal is loading", async () => {
    const path = join(historyDirectory(), "activity.txt");
    writeFileSync(path, "# Fixture\n\n## Activity\n\n### Attempt 1 · 1 · assistant\nEvidence\n");
    const snapshot = run([], { status: "completed" });
    const source = createSubagentPagerSource({ get: () => snapshot, activityPath: () => path, subscribe: () => () => undefined }, snapshot.id);
    const pending = source.readAll();
    source.dispose();
    await expect(pending).rejects.toThrow("subagent pager source is disposed");
    await expect(source.readPage(0)).rejects.toThrow("subagent pager source is disposed");
  });

  it("marks each persisted multi-file read result without retaining file bodies", async () => {
    const store = createSubagentStore(historyDirectory());
    const snapshot = run([
      { kind: "tool", text: 'Calling fs.read: {"files":[{"path":"one.md"},{"path":"missing.md"}]}' },
      { kind: "tool", text: 'Success: # fs.read file=1/2 path="one.md" status=ok\nPRIVATE_BODY\n# end fs.read file=1/2\n\n# fs.read file=2/2 path="missing.md" status=failed\nFile not found\n# end fs.read file=2/2' },
    ], { status: "completed" });
    store.appendActivity!(snapshot, snapshot.events);
    const source = createSubagentPagerSource({
      get: () => ({ ...snapshot, events: [] }),
      activityPath: () => store.activityPath!(snapshot.parentSessionId, snapshot.id),
      subscribe: () => () => undefined,
    }, snapshot.id);
    try {
      const text = await source.readAll();
      expect(text).toContain("✗ fs.read");
      expect(text).toContain("file 1/2: ✓ one.md");
      expect(text).toContain("file 2/2: ✗ missing.md");
      expect(text).toContain("missing.md: File not found");
      expect(text).not.toContain("PRIVATE_BODY");
    } finally {
      source.dispose();
    }
  });
});

describe("subagents bar visibility", () => {
  it("stays visible while any run is live or undelivered", () => {
    expect(subagentsBarVisible([run()])).toBe(true);
    expect(subagentsBarVisible([run([], { status: "stopping" })])).toBe(true);
    expect(subagentsBarVisible([run([], { status: "completed", resultAcknowledged: false })])).toBe(true);
    expect(subagentsBarVisible([run([], { status: "error", resultAcknowledged: undefined })])).toBe(true);
  });

  it("hides once every run is settled and delivered", () => {
    expect(subagentsBarVisible([run([], { status: "completed", resultAcknowledged: true })])).toBe(false);
    expect(subagentsBarVisible([
      run([], { status: "completed", resultAcknowledged: true }),
      run([], { status: "error", resultAcknowledged: true }),
    ])).toBe(false);
    expect(subagentsBarVisible([])).toBe(false);
  });

  it("stays visible when a delivered run sits beside a live one", () => {
    expect(subagentsBarVisible([
      run([], { status: "completed", resultAcknowledged: true }),
      run(),
    ])).toBe(true);
  });
});
