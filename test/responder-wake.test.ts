import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCurrentJobsPort } from "../src/app/adapters/current-jobs-adapter.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import { SessionResponder } from "../src/app/controllers/session-responder.js";
import { JobManager } from "../src/tools/jobs.js";

const dirs: string[] = [];
const managers: JobManager[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(): Promise<{ dir: string; manager: JobManager }> {
  const dir = await mkdtemp(join(tmpdir(), "clai-wake-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.getRunningJobs()) {
      await manager.stopJob(job.id, { graceMs: 200 });
    }
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("condition not reached before timeout");
}

function buildResponder(manager: JobManager, sessionId: string, busy = { value: false }) {
  const jobs = createCurrentJobsPort(manager);
  const acknowledgePrompt = (prompt: string): void => {
    const notificationId = /^notification=(.+)$/m.exec(prompt)?.[1]?.trim();
    if (!notificationId) return;
    if (!jobs.markRead(notificationId, sessionId)) return;
    jobs.markAnalyzed(notificationId);
    jobs.acknowledge(notificationId);
  };
  const runTurn = vi.fn().mockImplementation(
    async (prompt: string, onStarted: () => void) => {
      onStarted();
      acknowledgePrompt(prompt);
      return { status: "completed" as const };
    },
  );
  const notifyDelivery = vi.fn();
  const responder = new SessionResponder({
    jobs,
    persistence: {
      saveSession: async () => undefined,
      loadPlan: async () => undefined,
      savePlan: async () => undefined,
      deletePlan: async () => undefined,
    },
    sessionId: () => sessionId,
    isBusy: () => busy.value,
    hasQueuedWork: () => false,
    continueQueue: async () => undefined,
    runTurn,
    notifyState: () => undefined,
    notifyDelivery,
  });
  const unsubscribe = jobs.subscribe((change) => responder.handleChange(change));
  return {
    jobs,
    responder,
    runTurn,
    acknowledgePrompt,
    notifyDelivery,
    unsubscribe,
    busy,
  };
}

async function startResponderJob(
  manager: JobManager,
  sessionId: string,
  leaseId: string | undefined,
  script = "process.exit(0)",
) {
  return manager.startJob(
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    {
      ownerSessionId: sessionId,
      responder: true,
      wakeOnCompletion: true,
      ...(leaseId ? { responderLeaseId: leaseId } : {}),
    },
  );
}

describe("runtime responder listening lease", () => {
  it("starts off, never wakes, and keeps the unleased completion claimable", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "passive");
    expect(ctx.responder.getState().mode).toBe("off");

    await startResponderJob(manager, "passive", undefined);
    await waitFor(() => manager.getPendingNotifications("passive").length === 1);
    ctx.responder.scheduleWake();
    await sleep(100);

    expect(ctx.runTurn).not.toHaveBeenCalled();
    const pending = manager.getPendingNotifications("passive")[0];
    expect(pending?.archivedAt).toBeUndefined();

    // A later activation adopts the receipt the passive session accumulated.
    ctx.responder.activate();
    const leaseId = manager.getResponderLeaseId("passive")!;
    expect(
      manager.claimNextResponderNotification("passive", leaseId)?.id,
    ).toBe(pending?.id);
    ctx.unsubscribe();
  });

  it("activates explicitly and delivers one completion while idle", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "active");
    ctx.responder.activate();
    const leaseId = ctx.jobs.getResponderLeaseId("active");
    expect(ctx.responder.getState().mode).toBe("idle");

    await startResponderJob(manager, "active", leaseId);
    await waitFor(() => ctx.runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications("active").length === 0);

    expect(ctx.notifyDelivery).toHaveBeenCalledTimes(1);
    expect(ctx.runTurn.mock.calls[0]?.[0]).toContain("Responder result arrived");
    ctx.unsubscribe();
  });

  it("queues a busy completion and consumes it only at the next idle boundary", async () => {
    const { manager } = await fixture();
    const busy = { value: true };
    const ctx = buildResponder(manager, "busy", busy);
    ctx.responder.activate();
    await startResponderJob(
      manager,
      "busy",
      ctx.jobs.getResponderLeaseId("busy"),
    );
    await waitFor(() => manager.getPendingNotifications("busy").length === 1);
    expect(ctx.runTurn).not.toHaveBeenCalled();

    busy.value = false;
    ctx.responder.scheduleWake();
    await waitFor(() => ctx.runTurn.mock.calls.length === 1);
    ctx.unsubscribe();
  });

  it("delivers simultaneous completions as separate FIFO interruptions", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "fifo");
    let release!: () => void;
    ctx.runTurn.mockImplementationOnce(
      (prompt: string, onStarted: () => void) =>
        new Promise((resolve) => {
          onStarted();
          release = () => {
            ctx.acknowledgePrompt(prompt);
            resolve({ status: "completed" as const });
          };
        }),
    );
    ctx.responder.activate();
    const leaseId = ctx.jobs.getResponderLeaseId("fifo");

    await Promise.all([
      startResponderJob(manager, "fifo", leaseId, "setTimeout(() => process.exit(0), 20)"),
      startResponderJob(manager, "fifo", leaseId, "setTimeout(() => process.exit(0), 40)"),
    ]);
    await waitFor(() => ctx.runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications("fifo").length === 2);
    release();
    await waitFor(() => ctx.runTurn.mock.calls.length === 2);
    await waitFor(() => manager.getPendingNotifications("fifo").length === 0);

    expect(ctx.notifyDelivery).toHaveBeenCalledTimes(2);
    expect(ctx.runTurn.mock.calls[0]?.[0]).not.toBe(ctx.runTurn.mock.calls[1]?.[0]);
    ctx.unsubscribe();
  });

  it("deactivation leaves the process alive and keeps its eventual result", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "abort");
    ctx.responder.activate();
    const started = await startResponderJob(
      manager,
      "abort",
      ctx.jobs.getResponderLeaseId("abort"),
      "setTimeout(() => process.exit(0), 1200)",
    );
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    expect(manager.getJob(id!)?.status).toBe("running");

    ctx.responder.deactivate();
    expect(manager.getJob(id!)?.status).toBe("running");
    await waitFor(() => manager.getJob(id!)?.status === "exited");
    await sleep(50);

    expect(ctx.runTurn).not.toHaveBeenCalled();
    expect(manager.getPendingNotifications("abort")[0]?.archivedAt).toBeUndefined();
    ctx.unsubscribe();
  });

  it("keeps an aborted responder analysis durable without auto-retrying", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "no-retry");
    ctx.runTurn.mockImplementation(
      async (_prompt: string, onStarted: () => void) => {
        onStarted();
        return { status: "aborted" as const };
      },
    );
    ctx.responder.activate();
    await startResponderJob(
      manager,
      "no-retry",
      ctx.jobs.getResponderLeaseId("no-retry"),
    );
    await waitFor(() => ctx.runTurn.mock.calls.length === 1);
    await sleep(300);

    expect(ctx.runTurn).toHaveBeenCalledTimes(1);
    const first = manager.getPendingNotifications("no-retry")[0];
    expect(first).toMatchObject({ deliveryStartedAt: expect.any(String) });
    expect(first?.deliveredAt).toBeUndefined();

    ctx.runTurn.mockImplementation(
      async (prompt: string, onStarted: () => void) => {
        onStarted();
        ctx.acknowledgePrompt(prompt);
        return { status: "completed" as const };
      },
    );
    await startResponderJob(
      manager,
      "no-retry",
      ctx.jobs.getResponderLeaseId("no-retry"),
    );
    await waitFor(() => ctx.runTurn.mock.calls.length === 2);
    await sleep(100);

    // The aborted receipt is not re-presented in this runtime, but it was never
    // consumed either: a fresh lease can still claim it.
    expect(ctx.runTurn).toHaveBeenCalledTimes(2);
    expect(ctx.runTurn.mock.calls[1]?.[0]).not.toContain(`job=${first?.jobId}`);
    const retained = manager
      .getPendingNotifications("no-retry")
      .find((candidate) => candidate.id === first?.id);
    expect(retained?.deliveredAt).toBeUndefined();
    manager.releaseResponderLease("no-retry", ctx.jobs.getResponderLeaseId("no-retry"));
    const freshLease = manager.activateResponderLease("no-retry");
    expect(
      manager.claimNextResponderNotification("no-retry", freshLease)?.id,
    ).toBe(first?.id);
    ctx.unsubscribe();
  });

  it("bounds UTF-8 result previews to 20 lines and 4 KiB", async () => {
    const { manager } = await fixture();
    const ctx = buildResponder(manager, "bounded");
    ctx.responder.activate();
    const script = "for(let i=0;i<100;i++) console.log('λ'.repeat(200)+i)";
    await startResponderJob(
      manager,
      "bounded",
      ctx.jobs.getResponderLeaseId("bounded"),
      script,
    );
    await waitFor(() => ctx.runTurn.mock.calls.length === 1);

    const prompt = String(ctx.runTurn.mock.calls[0]?.[0]);
    const preview = prompt
      .split("Preview (maximum 20 lines / 4 KiB):\n")[1]!
      .split("\nReview this compact result.")[0]!;
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(4_120);
    expect(preview.split("\n").length).toBeLessThanOrEqual(21);
    expect(preview).not.toContain("�");
    ctx.unsubscribe();
  });

  it("keeps loadHistory and abort responder-off without stopping jobs", async () => {
    const { manager } = await fixture();
    const jobs = createCurrentJobsPort(manager);
    const session = new SessionController({
      agent: {
        async runTurn(_request, handlers) {
          handlers.onMessages?.([]);
          return "done";
        },
      },
      persistence: {
        saveSession: async () => undefined,
        loadPlan: async () => undefined,
        savePlan: async () => undefined,
        deletePlan: async () => undefined,
      },
      jobs,
      emit: () => undefined,
      sessionId: "controller-lifecycle",
      noHistory: true,
    });

    expect(session.getState().responder.mode).toBe("off");
    await session.submit("start listening");
    expect(session.getState().responder.mode).toBe("idle");
    const started = await startResponderJob(
      manager,
      "controller-lifecycle",
      jobs.getResponderLeaseId("controller-lifecycle"),
      "setTimeout(() => process.exit(0), 800)",
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    expect(manager.getJob(jobId!)?.status).toBe("running");

    session.loadHistory([{ role: "user", content: "restored" }], {
      sessionId: "controller-lifecycle",
    });
    expect(session.getState().responder.mode).toBe("off");
    expect(manager.getJob(jobId!)?.status).toBe("running");

    await session.submit("listen again");
    session.abort();
    expect(session.getState().responder.mode).toBe("off");
    expect(manager.getJob(jobId!)?.status).toBe("running");
    session.dispose();
  });
});
