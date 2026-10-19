import { afterEach, describe, expect, it, vi } from "vitest";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { lateWorkNote, LATE_WORK_MARKER } from "../../src/app/controllers/session-late-work.js";
import type { RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { getProvider } from "../../src/llm/router.js";
import { updateConfig } from "../../src/store/config.js";
import { getSession, pendingSessionMerge, upsertSession } from "../../src/store/history.js";
import { buildFileChange } from "../../src/tools/file-diff.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { applySessionResume } from "../../src/ui-core/bootstrap/session-resume.js";

const opened: AppServices[] = [];
afterEach(() => {
  for (const services of opened.splice(0)) services.dispose();
  vi.restoreAllMocks();
});

const first: TranscriptItem = { kind: "user", id: "a-first", text: "start the migration", done: true };
const reply: TranscriptItem = { kind: "assistant", id: "a-reply", text: "migration started", done: true };
const lateEdit: TranscriptItem = {
  kind: "tool", id: "a-late-edit", name: "fs.edit", argsDisplay: "/repo/db.ts", output: "", status: "ok", done: true,
  fileChanges: [buildFileChange({ path: "/repo/db.ts", before: "v1\n", after: "v2\n", kind: "edit" })],
};
const lateAnswer: TranscriptItem = { kind: "assistant", id: "a-late-answer", text: "MIGRATION_FINISHED_IN_MINIMIZED_PROCESS", done: true };
const baseMessages = [{ role: "user" as const, content: "start the migration" }, { role: "assistant" as const, content: "migration started" }];

function writer(requests: RunTurnRequest[]): AppServices {
  vi.spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
  const services = createCompositionRoot({
    provider: "free", model: "fixture-model", persistence: createCurrentPersistencePort(),
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 35 }),
    agent: { async runTurn(request, handlers) {
      requests.push(request);
      const outcome = createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      handlers.onEvent?.({ type: "turn-start", prompt: request.prompt, ...(request.displayPrompt !== undefined ? { displayPrompt: request.displayPrompt } : {}) });
      handlers.onEvent?.({ type: "assistant-message", text: "ok" });
      handlers.onMessages?.([...(request.history ?? []), { role: "user", content: request.prompt }, { role: "assistant", content: "ok" }]);
      handlers.onEvent?.({ type: "turn-end", outcome, finalAnswer: "ok", steps: 1 });
      return outcome;
    } },
  });
  opened.push(services);
  return services;
}

const transcriptIds = (services: AppServices) => services.transcript.getState().order;

describe("late work from an older writer", () => {
  it("summarises late entries newest first within a bounded note", () => {
    expect(lateWorkNote([{ kind: "notice", id: "n", level: "info", text: "x", done: true }])).toBeUndefined();
    const note = lateWorkNote([first, lateEdit, lateAnswer])!;
    expect(note.startsWith(LATE_WORK_MARKER)).toBe(true);
    expect(note).toContain("- user: start the migration");
    expect(note).toContain("- tool fs.edit /repo/db.ts · ok · /repo/db.ts +1 -1");
    expect(note).toContain("- assistant: MIGRATION_FINISHED_IN_MINIMIZED_PROCESS");
    expect(note).not.toContain("[context-note]");
    const many = Array.from({ length: 40 }, (_, index): TranscriptItem => ({ kind: "assistant", id: `m${index}`, text: `ENTRY_${index} ${"x".repeat(400)}`, done: true }));
    const bounded = lateWorkNote(many)!;
    expect(bounded.length).toBeLessThan(7_000);
    expect(bounded).toContain("ENTRY_39");
    expect(bounded).not.toContain("ENTRY_0 ");
    expect(bounded).toMatch(/… \d+ earlier entries omitted/);
  });

  it("shows the older writer's late entries live and tells the model once, without touching earlier messages", async () => {
    updateConfig({ privateMode: false });
    const id = "late-writer-live";
    await upsertSession(id, baseMessages, "migration", [first, reply], undefined, 1, "0001-writer-a");
    const requests: RunTurnRequest[] = [];
    const services = writer(requests);
    await applySessionResume(services, (await getSession(id))!);
    services.session.notice("info", "resumed in the foreground");
    const noticeId = transcriptIds(services).at(-1)!;
    await services.session.submit("check the schema");
    const beforeLate = requests[0]!;
    expect(beforeLate.prompt).toBe("check the schema");

    await upsertSession(id, [...baseMessages, { role: "user", content: "finish" }], undefined, [first, reply, lateEdit, lateAnswer], undefined, 50, "0001-writer-a");
    expect((await getSession(id))?.pendingMerge).toBe(true);

    await vi.waitFor(() => expect(transcriptIds(services)).toContain(lateAnswer.id), { timeout: 8_000 });
    const order = transcriptIds(services);
    expect(order.indexOf(reply.id)).toBeLessThan(order.indexOf(lateEdit.id));
    expect(order.indexOf(lateEdit.id)).toBeLessThan(order.indexOf(lateAnswer.id));
    expect(order).toContain(noticeId);
    expect(services.transcript.getState().byId.get(lateAnswer.id)).toMatchObject({ kind: "assistant", text: lateAnswer.text });

    await vi.waitFor(async () => {
      const saved = await getSession(id);
      expect(saved?.pendingMerge).toBeUndefined();
      expect(saved?.unsyncedItemIds).toEqual([lateEdit.id, lateAnswer.id]);
    });
    expect(await pendingSessionMerge(id)).toBeUndefined();

    await services.session.submit("what happened?");
    const afterLate = requests[1]!;
    expect(afterLate.prompt.startsWith(LATE_WORK_MARKER)).toBe(true);
    expect(afterLate.prompt).toContain("MIGRATION_FINISHED_IN_MINIMIZED_PROCESS");
    expect(afterLate.prompt.endsWith("\n\nwhat happened?")).toBe(true);
    expect(afterLate.displayPrompt).toBe("what happened?");
    expect(afterLate.history?.slice(0, beforeLate.history!.length + 2)).toEqual([
      ...beforeLate.history!, { role: "user", content: "check the schema" }, { role: "assistant", content: "ok" },
    ]);
    expect(afterLate.history?.some((message) => message.content.includes(LATE_WORK_MARKER))).toBe(false);
    const users = [...services.transcript.getState().byId.values()].filter((item) => item.kind === "user").map((item) => item.text);
    expect(users).toContain("what happened?");
    expect(users.some((text) => text.includes(LATE_WORK_MARKER))).toBe(false);

    await services.session.submit("and now?");
    expect(requests[2]!.prompt).toBe("and now?");
    const final = await getSession(id);
    expect(final?.unsyncedItemIds).toBeUndefined();
    expect(final?.transcript?.map((item) => item.id)).toEqual(expect.arrayContaining([lateEdit.id, lateAnswer.id]));
    expect(final?.messages.some((message) => message.content.includes("MIGRATION_FINISHED_IN_MINIMIZED_PROCESS"))).toBe(true);
  });

  it("carries undelivered late work across a reopen", async () => {
    updateConfig({ privateMode: false });
    const id = "late-writer-reopen";
    await upsertSession(id, baseMessages, "migration", [first, reply], undefined, 1, "0001-writer-a");
    const requests: RunTurnRequest[] = [];
    const resumed = writer(requests);
    await applySessionResume(resumed, (await getSession(id))!);
    await resumed.session.submit("check the schema");
    await upsertSession(id, baseMessages, undefined, [first, reply, lateAnswer], undefined, 50, "0001-writer-a");
    await vi.waitFor(async () => expect((await getSession(id))?.unsyncedItemIds).toEqual([lateAnswer.id]), { timeout: 8_000 });
    resumed.dispose();

    const reopened = writer(requests);
    await applySessionResume(reopened, (await getSession(id))!);
    expect(transcriptIds(reopened)).toContain(lateAnswer.id);
    await reopened.session.submit("continue");
    expect(requests.at(-1)!.prompt.startsWith(LATE_WORK_MARKER)).toBe(true);
    expect(requests.at(-1)!.prompt).toContain("MIGRATION_FINISHED_IN_MINIMIZED_PROCESS");
    expect(requests.at(-1)!.displayPrompt).toBe("continue");
  });

  it("waits for a running turn to settle before absorbing, then delivers the note on the following turn", async () => {
    updateConfig({ privateMode: false });
    const id = "late-writer-busy";
    await upsertSession(id, baseMessages, "migration", [first, reply], undefined, 1, "0001-writer-a");
    const requests: RunTurnRequest[] = [];
    const services = writer(requests);
    await applySessionResume(services, (await getSession(id))!);
    await services.session.submit("check the schema");
    const gate = Promise.withResolvers<void>();
    const agent = services.ports.agent;
    const runTurn = agent.runTurn.bind(agent);
    vi.spyOn(agent, "runTurn").mockImplementationOnce(async (request, handlers) => {
      await gate.promise;
      return runTurn(request, handlers);
    });
    const running = services.session.submit("long task");
    await vi.waitFor(() => expect(services.session.getState().running).toBe(true));
    await upsertSession(id, baseMessages, undefined, [first, reply, lateAnswer], undefined, 50, "0001-writer-a");
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(transcriptIds(services)).not.toContain(lateAnswer.id);
    gate.resolve();
    await running;
    await vi.waitFor(() => expect(transcriptIds(services)).toContain(lateAnswer.id), { timeout: 8_000 });
    expect(requests.at(-1)!.prompt).toBe("long task");
    await services.session.submit("next");
    expect(requests.at(-1)!.prompt.startsWith(LATE_WORK_MARKER)).toBe(true);
  }, 20_000);
});
