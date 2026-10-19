import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionChanges, fileLineChanges } from "../../src/app/controllers/session-changes.js";
import { buildFileChange } from "../../src/tools/file-diff.js";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { getSession } from "../../src/store/history.js";
import { applySessionResume } from "../../src/ui-core/bootstrap/session-resume.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { getProvider } from "../../src/llm/router.js";
import { updateConfig } from "../../src/store/config.js";
import { rowToSession, upsertSqlite } from "../../src/store/history/sqlite-backend.js";

const edit = buildFileChange({ path: "/repo/app.ts", before: "old\n", after: "new\nextra\n", kind: "edit" });
const remove = buildFileChange({ path: "/repo/old.ts", before: "one\ntwo\n", after: "", kind: "delete" });
const followup = buildFileChange({ path: "/repo/app.ts", before: "new\nextra\n", after: "new\nfixed\n", kind: "edit" });
const opened: AppServices[] = [];
afterEach(() => { for (const services of opened.splice(0)) services.dispose(); vi.restoreAllMocks(); });

describe("session line changes", () => {
  it("combines each file's recorded changes without replaying the same tool twice", () => {
    const ledger = new SessionChanges();
    ledger.record("first", [edit, remove]);
    ledger.record("first", [edit, remove]);
    const frozen = ledger.snapshot();
    ledger.record("next", [followup]);
    expect(frozen.totals).toEqual({ added: 2, removed: 3 });
    expect(ledger.snapshot()).toEqual({ totals: { added: 3, removed: 4 }, files: [
      { path: "/repo/app.ts", added: 3, removed: 2 }, { path: "/repo/old.ts", added: 0, removed: 2 },
    ], changes: [edit, remove, followup] });
    expect(ledger.snapshot()).toBe(ledger.snapshot());
    expect(frozen.changes).toEqual([edit, remove]);
  });

  it("omits absent, zero, binary and invalid line statistics", () => {
    expect(fileLineChanges(undefined)).toEqual([]);
    expect(fileLineChanges([
      buildFileChange({ path: "same.ts", before: "same", after: "same", kind: "edit" }),
      { ...edit, binary: true },
      { ...edit, stats: { ...edit.stats, added: NaN } },
    ])).toEqual([]);
    expect(new SessionChanges().snapshot()).toEqual({ totals: undefined, files: [], changes: [] });
  });

  it("restores older tool statistics through compaction and isolates session switches", () => {
    const tool: TranscriptItem = { kind: "tool", id: "edit", name: "fs.edit", argsDisplay: "app.ts", output: "", status: "ok", fileChanges: [edit], done: true };
    const compacted: TranscriptItem = { kind: "compacted", id: "compact", summary: "earlier work", originalItems: [tool], done: true };
    const ledger = new SessionChanges();
    ledger.restore(undefined, [compacted, tool]);
    expect(ledger.snapshot().totals).toEqual({ added: 2, removed: 1 });
    expect(ledger.snapshot().changes).toEqual([edit]);
    ledger.restore([{ path: "other-session.ts", added: 8, removed: 9 }], [tool]);
    expect(ledger.snapshot().files).toEqual([{ path: "other-session.ts", added: 8, removed: 9 }]);
    expect(ledger.snapshot().changes).toEqual([edit]);
    ledger.restore();
    expect(ledger.snapshot().totals).toBeUndefined();
    expect(ledger.snapshot().changes).toEqual([]);
  });

  it("round-trips line counts through the SQLite history payload", () => {
    let payload: unknown;
    const record = { id: "sqlite-changes", cwd: "/repo", createdAt: "2026-10-13", updatedAt: "2026-10-13", messages: [],
      changes: [{ path: "/repo/app.ts", added: 213, removed: 435 }] };
    upsertSqlite({ exec() {}, prepare() { return {
      run(...args: unknown[]) { payload = args.at(-1); }, get() {}, all() { return []; },
    }; } }, record);
    const loaded = rowToSession({ id: record.id, cwd: record.cwd, created_at: record.createdAt, updated_at: record.updatedAt, messages_json: payload });
    expect(loaded.changes).toEqual(record.changes);
  });

  it("persists per-run summaries and session totals, resumes them, and opens /changes", async () => {
    updateConfig({ privateMode: false });
    vi.spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
    const make = () => {
      let run = 0;
      const services = createCompositionRoot({
        provider: "free", model: "fixture-model", persistence: createCurrentPersistencePort(),
        capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 35 }),
        agent: { async runTurn(request, handlers) {
          run += 1;
          const outcome = createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
          handlers.onEvent?.({ type: "turn-start", prompt: request.prompt });
          const changes = run === 1 ? [edit, remove] : run === 2 ? [followup] : [];
          if (changes.length) {
            handlers.onEvent?.({ type: "tool-call", id: `fixture-${run}`, name: "fs.writeMany", argsDisplay: "recorded file edits" });
            handlers.onEvent?.({ type: "tool-result", id: `fixture-${run}`, ok: true, summary: "applied", fileChanges: changes });
          }
          handlers.onEvent?.({ type: "assistant-message", text: "ok" });
          handlers.onMessages?.([...(request.history ?? []), { role: "user", content: request.prompt }, { role: "assistant", content: "ok" }]);
          handlers.onEvent?.({ type: "turn-end", outcome, finalAnswer: "ok", steps: 1 });
          return outcome;
        } },
      });
      attachCommandHandlers(services);
      opened.push(services);
      return services;
    };
    const services = make();
    await services.session.submit("Edit two files");
    await services.session.submit("Edit app.ts again");
    await services.session.submit("Explain the result without edits");
    const record = await getSession(services.session.sessionId);
    expect(record?.changes).toEqual([
      { path: "/repo/app.ts", added: 3, removed: 2 }, { path: "/repo/old.ts", added: 0, removed: 2 },
    ]);
    expect(record?.transcript?.filter((item) => item.kind === "turn-summary").map((item) => item.changes))
      .toEqual([{ added: 2, removed: 3 }, { added: 1, removed: 1 }, undefined]);
    services.dispose();
    const resumed = make();
    await applySessionResume(resumed, record!);
    expect(resumed.session.changesReport().totals).toEqual({ added: 3, removed: 4 });
    expect([...resumed.transcript.getState().byId.values()].filter((item) => item.kind === "turn-summary").map((item) => item.changes))
      .toEqual([{ added: 2, removed: 3 }, { added: 1, removed: 1 }, undefined]);
    await resumed.commands.dispatch({ name: "changes" });
    const pager = resumed.overlay.getState();
    expect(pager.kind).toBe("pager");
    if (pager.kind === "pager") {
      const body = await pager.source!.readAll();
      expect(body).toContain("+3 -4");
      expect(body).toContain("+3 -2  /repo/app.ts");
      expect(body).toContain("+0 -2  /repo/old.ts");
      const diffs = body.slice(body.indexOf("---"));
      expect(diffs.indexOf("> +3 -2  /repo/app.ts")).toBeLessThan(diffs.indexOf("│ edit · /repo/app.ts"));
      expect(diffs).toContain("1 │ − old");
      expect(diffs).toContain("1 │ + new");
      expect(diffs).toContain("2 │ + extra");
      expect(diffs).toContain("2 │ + fixed");
      expect(diffs).toContain("│ delete · /repo/old.ts");
      expect(diffs).toContain("1 │ − one");
      expect(diffs).not.toContain("diff not kept");
    }
    const changed = vi.fn();
    const unwatch = pager.kind === "pager" ? pager.source!.watch!(changed) : () => {};
    await resumed.session.submit("Continue the resumed session");
    expect(resumed.session.changesReport().totals).toEqual({ added: 5, removed: 7 });
    if (pager.kind === "pager") expect(await pager.source!.readAll()).toContain("+5 -7");
    expect(changed).toHaveBeenCalled();
    unwatch();
    resumed.overlay.close();
    resumed.session.reset({ mintNewId: true });
    await resumed.commands.dispatch({ name: "changes" });
    const empty = resumed.overlay.getState();
    if (empty.kind === "pager") expect(await empty.source!.readAll()).toContain("No line changes recorded");
    expect(resumed.session.changesReport().files).toEqual([]);
  });
});
