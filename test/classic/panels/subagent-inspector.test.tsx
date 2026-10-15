import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { SubagentManager } from "../../../src/agent/subagents/manager.js";
import type { SubagentRun } from "../../../src/agent/subagents/types.js";
import { PanelHost } from "../../../src/classic/panels/panel-host.js";
import { pagerViewModel } from "../../../src/classic/panels/pager-panel.js";
import { FileSubagentStore, SUBAGENT_LIMITS } from "../../../src/store/subagents.js";
import { createSubagentPagerSource, formatSubagentRun } from "../../../src/ui-core/rendering/subagent-source.js";
import { createTextPagerSource } from "../../../src/ui-core/rendering/artifact-pager-source.js";
import { colorInk, createHarness } from "./harness.js";
import { stripAnsiSequences } from "../../../src/ui-core/rendering/sanitize-display.js";
import { formatFsReadSection } from "../../../src/tools/fs/read-sections.js";

it("renders changing elapsed time and a frozen duration in the Classic inspector", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let run: SubagentRun = {
    id: "timed", parentSessionId: "parent", title: "Timed inspector", prompt: "Inspect timing",
    cwd: "/workspace", provider: "openai", model: "test", attempt: 1, status: "running",
    createdAt: 1000, startedAt: 1000, updatedAt: 1000, events: [],
  };
  const listeners = new Set<() => void>();
  const source = createSubagentPagerSource({
    get: () => run,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, run.id);
  const harness = createHarness({ columns: 120, rows: 46 });
  harness.overlay.openPager(run.title, formatSubagentRun(run), source, undefined, "force");
  const view = render(<PanelHost controller={harness.panels} ink={colorInk} columns={120} rows={40} jobs={[]} transcript={harness.transcript} now={0} />);
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(view.lastFrame()).toContain("Elapsed 0.0s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.lastFrame()).toContain("Elapsed 1.0s");
    run = { ...run, status: "completed", updatedAt: 2000 };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.lastFrame()).toContain("Duration 1.0s");
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.lastFrame()).toContain("Duration 1.0s");
  } finally {
    view.unmount();
    harness.overlay.dispose();
    harness.panels.dispose();
    vi.useRealTimers();
  }
});

it("renders readable subagent activity and one evidence report in Classic", async () => {
  const report = "Status: complete\n## Findings\nThe worker delegates bounded read-only research.\n## Evidence\nsrc/agent/subagents/worker.ts:81 contains the dispatch loop.\n## Next steps\nVerify cancellation.\n## Coverage gaps\nNo live provider was contacted.";
  const run: SubagentRun = {
    id: "inspector", parentSessionId: "parent", title: "Inspect orchestration", prompt: "Trace the worker and report evidence",
    cwd: "/workspace", provider: "openai", model: "test", attempt: 1, status: "completed", createdAt: 1, updatedAt: 2,
    events: [
      { sequence: 1, timestamp: 1, kind: "tool", text: 'Calling fs.read: {"path":"src/agent/subagents/worker.ts","offset":81,"limit":80}' },
      { sequence: 2, timestamp: 2, kind: "tool", text: "Success: PRIVATE_FILE_BODY_MUST_NOT_APPEAR" },
      { sequence: 3, timestamp: 3, kind: "assistant", text: report },
    ],
    report,
  };
  const harness = createHarness({ columns: 120, rows: 46 });
  const body = formatSubagentRun(run);
  harness.overlay.openPager(run.title, body, createTextPagerSource(body, `memory://subagent/${run.id}`), undefined, "force");
  const view = render(<PanelHost controller={harness.panels} ink={colorInk} columns={120} rows={40} jobs={[]} transcript={harness.transcript} now={0} />);
  try {
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("\x1b[1mExplored");
    expect(frame).toContain(colorInk.fg("success", "✓ ").replace(/\x1b\[39m(?:\x1b\[0m)?$/, ""));
    expect(frame).toContain("src/agent/subagents/worker.ts");
    expect(frame).toContain(colorInk.fg("inputBorder", "src/agent/subagents/worker.ts").replace(/\x1b\[39m(?:\x1b\[0m)?$/, ""));
    expect(frame).not.toMatch(/offset=|limit=|fs\.read/);
    expect(frame).not.toContain("PRIVATE_FILE_BODY_MUST_NOT_APPEAR");
    expect(frame.match(/The worker delegates/g)).toHaveLength(1);
    expect(frame).toContain("No live provider was contacted.");
    if (process.env.CLAI_CLASSIC_SUBAGENT_CAPTURE_PATH) await writeFile(process.env.CLAI_CLASSIC_SUBAGENT_CAPTURE_PATH, frame);
  } finally {
    view.unmount();
    harness.overlay.dispose();
    harness.panels.dispose();
  }
});

it("keeps the complete durable subagent transcript readable and continuously navigable in Classic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clai-classic-durable-inspector-"));
  const store = new FileSubagentStore(directory);
  const report = [
    "Status: complete",
    "## Findings",
    "FINAL_DURABLE_FINDING: All retained evidence was inspected.",
    "## Evidence",
    "src/agent/subagents/worker.ts:81 records the investigation.",
    "## Next steps",
    "Verify the complete transcript remains accessible after restoring the session.",
    "## Coverage gaps",
    "No live provider was contacted.",
  ].join("\n");
  const evidence = Array.from({ length: 140 }, (_, index) =>
    `DURABLE_EVIDENCE_${String(index).padStart(3, "0")} ${"retained evidence ".repeat(40)}`.trimEnd(),
  );
  let manager = new SubagentManager("classic-durable-inspector", {
    store,
    worker: async ({ emit }) => {
      emit({ kind: "assistant", text: "FIRST_DURABLE_FINDING" });
      emit({ kind: "tool", text: 'Calling fs.read: {"path":"src/agent/subagents/worker.ts","offset":81,"limit":80}' });
      emit({ kind: "tool", text: "Success: PRIVATE_DURABLE_FILE_BODY_MUST_NOT_APPEAR" });
      for (const text of evidence) emit({ kind: "assistant", text });
      return report;
    },
  });
  const harness = createHarness({ columns: 120, rows: 46 });
  let view: ReturnType<typeof render> | undefined;
  let source: ReturnType<typeof createSubagentPagerSource> | undefined;
  try {
    const started = manager.start({
      title: "Durable inspector", prompt: "Read the complete investigation", cwd: directory,
      provider: "openai", model: "test",
    });
    await manager.wait(started.id);
    expect(manager.activityPath(started.id)).toBeDefined();
    manager.dispose();
    manager = new SubagentManager("classic-durable-inspector", { store });
    const restored = manager.get(started.id)!;
    expect(restored.status).toBe("completed");
    expect(restored.events.length).toBeLessThanOrEqual(SUBAGENT_LIMITS.events);
    expect(restored.events.some((event) => event.text.includes("FIRST_DURABLE_FINDING"))).toBe(false);
    source = createSubagentPagerSource(manager, started.id);
    const complete = await source.readAll();
    expect(Buffer.byteLength(complete)).toBeGreaterThan(64 * 1024);
    expect(complete).toContain("FIRST_DURABLE_FINDING");
    expect(complete).toContain(evidence[0]);
    expect(complete).toContain(evidence.at(-1));
    expect(complete).toContain("✓ Explored\n  └ Read src/agent/subagents/worker.ts");
    expect(complete).not.toMatch(/offset=|limit=/);
    expect(complete).not.toMatch(/PRIVATE_DURABLE_FILE_BODY_MUST_NOT_APPEAR|Calling fs\.read|Success:|### Attempt/);
    expect(complete.match(/FINAL_DURABLE_FINDING/g)).toHaveLength(1);
    const page = await source.readPage(0);
    expect(page.body).toBe(complete);
    expect(page.pageNumber).toBe(1);
    expect(page.pageCount).toBe(1);
    expect(page.nextOffset).toBe(page.totalBytes);
    harness.overlay.openPager(restored.title, formatSubagentRun(restored), source, undefined, "force");
    view = render(<PanelHost controller={harness.panels} ink={colorInk} columns={120} rows={40} jobs={[]} transcript={harness.transcript} now={0} />);
    await vi.waitFor(() => expect(harness.panels.getSnapshot().pagerBody).toBe(complete));
    await vi.waitFor(() => expect(view!.lastFrame()).toContain("FIRST_DURABLE_FINDING"));
    expect(view.lastFrame()).toContain("Explored");
    expect(view.lastFrame()).not.toContain("PRIVATE_DURABLE_FILE_BODY_MUST_NOT_APPEAR");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(40);
    const lines = pagerViewModel(complete, 120, 40, "formatted").searchLines;
    expect(lines.length).toBeGreaterThan(500);
    expect(harness.press("end")).toBe(true);
    expect(harness.panels.getSnapshot().pager.caret).toBe(lines.length - 1);
    await vi.waitFor(() => expect(view!.lastFrame()).toContain("FINAL_DURABLE_FINDING"));
    expect(harness.press("home")).toBe(true);
    expect(harness.panels.getSnapshot().pager.caret).toBe(0);
    expect(harness.press("ctrl+r")).toBe(true);
    expect(harness.handlePasteThroughPanels("DURABLE_EVIDENCE_110")).toBe(true);
    expect(harness.press("enter")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_110");
    await vi.waitFor(() => expect(view!.lastFrame()).toContain("DURABLE_EVIDENCE_110"));
    expect(harness.press("ctrl+r")).toBe(true);
    expect(harness.press("backspace")).toBe(true);
    expect(harness.press("backspace")).toBe(true);
    expect(harness.press("backspace")).toBe(true);
    expect(harness.press("enter")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_000");
    expect(harness.press("n")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_001");
    expect(harness.press("shift+n")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_000");
    expect(harness.press("shift+n")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_139");
    expect(harness.press("n")).toBe(true);
    expect(lines[harness.panels.getSnapshot().pager.caret]).toContain("DURABLE_EVIDENCE_000");
    expect(harness.press("c")).toBe(true);
    await vi.waitFor(() => expect(harness.copied).toEqual([complete]));
    expect(harness.panels.getSnapshot().pagerBody).toBe(complete);
  } finally {
    view?.unmount();
    harness.overlay.dispose();
    harness.panels.dispose();
    source?.dispose();
    manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it.each([80, 120])("keeps live named usage compact, styled and output-free at %i columns in Classic", async (columns) => {
  let run: SubagentRun = {
    id: `live-tools-${columns}`, parentSessionId: "parent", title: "Live tool inspection", prompt: "Inspect inputs",
    cwd: "/workspace", provider: "openai", model: "test", attempt: 1, status: "running",
    createdAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now(), events: [],
  };
  const listeners = new Set<() => void>();
  const source = createSubagentPagerSource({
    get: () => run,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, run.id);
  const harness = createHarness({ columns, rows: 46 });
  harness.overlay.openPager(run.title, formatSubagentRun(run), source, undefined, "force");
  const view = render(<PanelHost controller={harness.panels} ink={colorInk} columns={columns} rows={40} jobs={[]} transcript={harness.transcript} now={0} />);
  Object.defineProperty(view.stdout, "columns", { value: columns });
  view.stdout.emit("resize");
  const emit = (kind: "tool" | "assistant", text: string): void => {
    run = { ...run, updatedAt: Date.now(), events: [...run.events, { kind, text, timestamp: Date.now(), sequence: run.events.length + 1 }] };
    for (const listener of listeners) listener();
  };
  const waitFor = async (needle: string): Promise<string> => {
    await vi.waitFor(() => expect(stripAnsiSequences(view.lastFrame() ?? "")).toContain(needle));
    return stripAnsiSequences(view.lastFrame() ?? "");
  };
  const assertCompact = (frame: string, first: string, last: string): void => {
    const rows = frame.split("\n");
    const start = rows.findIndex((row) => row.includes(first));
    const end = rows.findIndex((row) => row.includes(last));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const row of rows.slice(start, end + 1)) expect(row.replace(/[│┃]/g, "").trim()).not.toBe("");
    expect(rows.length).toBeLessThanOrEqual(40);
  };
  try {
    emit("assistant", "LIVE-TOOL-START");
    const command = ["printf '%s\\n' '**literal** `argument` <br> # heading | column';", "printf CLASSIC-INPUT-END"].join("\r\n");
    emit("tool", `Calling shell.exec: ${JSON.stringify({ command })}`);
    const formatted = await waitFor("In progress");
    expect(formatted).toContain("→ Shell");
    expect(formatted).toContain("'**literal** `argument` <br> # heading");
    expect(formatted).not.toContain("CLASSIC-INPUT-END");
    expect(formatted.split("\n").filter(row => row.includes("→ Shell"))).toHaveLength(1);
    assertCompact(formatted, "LIVE-TOOL-START", "In progress");
    expect(harness.press("r")).toBe(true);
    const raw = await waitFor("→ Shell");
    expect(raw).toContain("…");
    expect(raw).not.toContain("CLASSIC-INPUT-END");
    assertCompact(raw, "LIVE-TOOL-START", "In progress");
    emit("tool", "Success: PRIVATE_TOOL_BODY");
    const complete = await waitFor("✓ Shell");
    expect(complete).not.toMatch(/In progress|PRIVATE_TOOL_BODY/);
    assertCompact(complete, "LIVE-TOOL-START", "✓ Shell");
    const files = [
      { path: `docs/FIRST-READ.md/${"first-section/".repeat(7)}`, offset: 12, limit: 80 },
      { path: `docs/SECOND-READ.md/${"second-section/".repeat(7)}`, offset: 200, limit: 60 },
    ];
    emit("tool", `Calling fs.read: ${JSON.stringify({ files })}`);
    const pendingRead = await waitFor("→ Explored");
    assertCompact(pendingRead, "→ Explored", "In progress");
    expect(harness.press("f")).toBe(true);
    await vi.waitFor(() => {
      const readRows = stripAnsiSequences(view.lastFrame() ?? "").split("\n").filter(row => /Read docs\//.test(row));
      expect(readRows).toHaveLength(2);
      for (const row of readRows) expect(row).toContain("…");
    });
    const formattedRead = await waitFor("→ Explored");
    assertCompact(formattedRead, "→ Explored", "In progress");
    emit("tool", `Success: ${files.map((file, index) => formatFsReadSection({ index: index + 1, total: 2, path: file.path, ok: index === 0, body: "PRIVATE_TOOL_BODY" })).join("\n\n")}`);
    const completedRead = await waitFor("✗ Explored");
    expect(completedRead).toContain("  └ Read docs/FIRST-READ.md");
    expect(completedRead).toContain("    Read ✗ docs/SECOND-READ.md");
    expect(completedRead).not.toMatch(/In progress|PRIVATE_TOOL_BODY|offset=|limit=|file [12]\/2:/);
    assertCompact(completedRead, "✗ Explored", "SECOND-READ.md");
    emit("tool", 'Calling web.fetch: {"url":"https://example.test"}');
    emit("tool", "Error: Tool denied: PRIVATE_DENIAL_BODY");
    const denied = await waitFor("Denied");
    expect(denied).toContain("✗ Opened https://example.test");
    expect(denied).not.toContain("PRIVATE_DENIAL_BODY");
    expect(await source.readAll()).not.toMatch(/PRIVATE_TOOL_BODY|PRIVATE_DENIAL_BODY/);
    expect(run.events.some(event => event.text.includes("CLASSIC-INPUT-END"))).toBe(true);
  } finally {
    view.unmount();
    harness.overlay.dispose();
    harness.panels.dispose();
    source.dispose();
  }
});
