import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertResponderResultLedger } from "../src/agent/responder-context.js";
import { buildDurableEnvelope } from "../src/agent/durable-envelope.js";
import { compactMessagesWithSummary } from "../src/agent/context-manager.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import { createCurrentJobsPort } from "../src/app/adapters/current-jobs-adapter.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import { JobManager } from "../src/tools/jobs.js";
import type { ChatMessage } from "../src/types.js";

const dirs: string[] = [];
const managers: JobManager[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(manager: JobManager, id: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (manager.getJob(id)?.status === "exited") return;
    await sleep(20);
  }
  throw new Error("responder job did not exit");
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

describe("responder persistence settlement", () => {
  it("does not mark a consumed receipt analyzed until its ledger save succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-responder-persist-"));
    dirs.push(dir);
    const manager = new JobManager(dir);
    managers.push(manager);
    const sessionId = "persisted-ledger-gate";
    const leaseId = manager.activateResponderLease(sessionId);
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: leaseId,
      },
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    await waitForExit(manager, jobId!);
    const notification = manager.claimNextResponderNotification(
      sessionId,
      leaseId,
    );
    expect(notification).toBeTruthy();
    expect(manager.markRead(notification!.id, sessionId)).toBe(true);

    let failSave = true;
    const persistence = {
      async saveSession() {
        expect(
          manager.getPendingNotifications(sessionId)[0]?.analyzedAt,
        ).toBeUndefined();
        if (failSave) throw new Error("simulated session save failure");
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const session = new SessionController({
      agent: {
        async runTurn() {
          return createTurnOutcome({
            status: "succeeded",
            answer: "unused",
            steps: 1,
            remainingCriteria: [],
          });
        },
      },
      persistence,
      jobs: createCurrentJobsPort(manager),
      emit: () => undefined,
      sessionId,
    });
    const history: ChatMessage[] = [{ role: "user", content: "work" }];
    upsertResponderResultLedger(history, notification!);
    session.restoreMessages(history);

    await expect(session.persistNow()).rejects.toThrow(
      "simulated session save failure",
    );
    expect(manager.getPendingNotifications(sessionId)[0]).toMatchObject({
      deliveredAt: expect.any(String),
      readAt: expect.any(String),
    });
    expect(
      manager.getPendingNotifications(sessionId)[0]?.analyzedAt,
    ).toBeUndefined();

    failSave = false;
    await session.persistNow();
    expect(manager.getPendingNotifications(sessionId)).toHaveLength(0);
    session.dispose();
  });

  it("does not redeliver a read result after history commit, restart, and compaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-responder-restart-"));
    dirs.push(dir);
    const sessionId = "restart-compaction-ledger";
    const first = new JobManager(dir);
    managers.push(first);
    const lease = first.activateResponderLease(sessionId);
    const started = await first.startJob(
      `${JSON.stringify(process.execPath)} -e "console.log('result')"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        responderLeaseId: lease,
      },
    );
    await waitForExit(first, started.backgroundJob!.id);
    const notification = first.claimNextResponderNotification(sessionId, lease)!;
    expect(first.markDeliveryStarted(notification.id, sessionId)).toBe(true);
    expect(first.markRead(notification.id, sessionId)).toBe(true);

    let committed: ChatMessage[] = [];
    const session = new SessionController({
      agent: {
        async runTurn() {
          return createTurnOutcome({
            status: "succeeded",
            answer: "unused",
            steps: 1,
            remainingCriteria: [],
          });
        },
      },
      persistence: {
        async saveSession(messages) {
          committed = messages.map((message) => ({ ...message }));
        },
        async loadPlan() { return undefined; },
        async savePlan() {},
        async deletePlan() {},
      },
      jobs: createCurrentJobsPort(first),
      emit: () => undefined,
      sessionId,
    });
    const history: ChatMessage[] = [
      { role: "user", content: "run delegated work" },
      { role: "assistant", content: "waiting" },
    ];
    upsertResponderResultLedger(history, notification);
    session.loadHistory(history, { sessionId });
    await session.persistNow();
    expect(committed.some((message) => message.content.includes(notification.id))).toBe(true);
    session.dispose();

    const restarted = new JobManager(dir);
    managers.push(restarted);
    const restartedLease = restarted.activateResponderLease(sessionId);
    expect(restarted.claimNextResponderNotification(sessionId, restartedLease)).toBeUndefined();

    const envelope = buildDurableEnvelope({
      responder: { unread: [], consumed: [notification.id] },
    })!;
    const compacted = await compactMessagesWithSummary(
      committed,
      async () => "delegated result was analyzed and retained",
      { budgetTokens: 0, keepRecent: 1, durableEnvelope: envelope },
    );
    const memory = compacted.messages.find((message) =>
      message.content.includes("DURABLE WORK ENVELOPE"),
    );
    expect(memory?.content).toContain(notification.id);
    expect(memory?.content).toContain("never re-read");
    expect(restarted.claimNextResponderNotification(sessionId, restartedLease)).toBeUndefined();
  });
});
