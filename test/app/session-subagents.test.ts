import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSubagents } from "../../src/app/controllers/session-subagents.js";
import { SubagentManager } from "../../src/agent/subagents/manager.js";

const managers: SubagentManager[] = [];
const deliveries: SessionSubagents[] = [];
const tick = async (): Promise<void> => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function setup(manager = new SubagentManager("parent", { worker: async () => "Verified evidence" })) {
  managers.push(manager);
  manager.setEnabled(true);
  const state = { busy: false, queued: false, sessionId: "parent" };
  const runTurn = vi.fn(async (_prompt: string) => {
    for (const run of manager.pendingResults()) manager.acknowledgeResult(run.id, run.attempt);
    return { status: "completed" as "completed" | "aborted" | "error" };
  });
  const continueQueue = vi.fn(async () => { state.queued = false; });
  const delivery = new SessionSubagents({
    sessionId: () => state.sessionId,
    isBusy: () => state.busy,
    hasQueuedWork: () => state.queued,
    continueQueue,
    runTurn,
  });
  deliveries.push(delivery);
  delivery.bind(manager);
  delivery.activate();
  const start = () => manager.start({ title: "Research", prompt: `Task ${manager.list().length}`, provider: "openai", model: "test", cwd: "/tmp" });
  return { manager, delivery, state, runTurn, continueQueue, start };
}

afterEach(async () => {
  for (const delivery of deliveries.splice(0)) delivery.dispose();
  for (const manager of managers.splice(0)) manager.dispose();
  await tick();
});

describe("SessionSubagents", () => {
  it("wakes once for a restored result and persists its acknowledgement", async () => {
    const save = vi.fn();
    const manager = new SubagentManager("parent", { store: { save, remove: () => undefined, load: () => [{
      id: "restored", parentSessionId: "parent", title: "Saved research", prompt: "Inspect source",
      cwd: "/tmp", provider: "openai", model: "test", attempt: 1, status: "completed",
      createdAt: 1, updatedAt: 2, events: [], report: "Verified evidence", resultAcknowledged: false,
    }] } });
    const { delivery, runTurn } = setup(manager);
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "restored", resultAcknowledged: true }));
    delivery.scheduleWake();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("wakes once on a terminal result without timer polling", async () => {
    const { start, delivery, runTurn } = setup();
    await tick();
    expect(runTurn).not.toHaveBeenCalled();
    start();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
    delivery.scheduleWake();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("defers delivery while a foreground turn or compaction is unsettled", async () => {
    const { start, state, delivery, runTurn } = setup();
    state.busy = true;
    start();
    await tick();
    expect(runTurn).not.toHaveBeenCalled();
    state.busy = false;
    delivery.scheduleWake();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("lets queued user work consume results instead of racing a hidden turn", async () => {
    const { start, state, runTurn, continueQueue } = setup();
    state.queued = true;
    start();
    await tick();
    expect(continueQueue).toHaveBeenCalledOnce();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each(["deactivate", "dispose"] as const)("fences scheduled wakes on %s", async (operation) => {
    const { start, delivery, runTurn } = setup();
    start();
    delivery[operation]();
    await tick();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("does not route results into another session", async () => {
    const { start, state, runTurn } = setup();
    state.sessionId = "another-parent";
    start();
    await tick();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each(["aborted", "error", "completed"] as const)("does not spin when a %s turn leaves evidence pending", async (status) => {
    const { start, manager, delivery, runTurn } = setup();
    runTurn.mockImplementation(async () => {
      delivery.scheduleWake();
      return { status };
    });
    start();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(manager.pendingResults()).toHaveLength(1);
  });

  it("handles a thrown wake failure without losing evidence or an unhandled rejection", async () => {
    const { start, manager, runTurn } = setup();
    runTurn.mockRejectedValue(new Error("Provider unavailable"));
    start();
    await tick();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(manager.pendingResults()).toHaveLength(1);
  });
});
