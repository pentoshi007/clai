import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createCurrentJobsPort } from "../../src/app/adapters/current-jobs-adapter.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { JobManager } from "../../src/tools/jobs.js";

const directory = await mkdtemp(join(tmpdir(), "clai-responder-panel-"));
const manager = new JobManager(directory);
const jobs = createCurrentJobsPort(manager);
const captures: { phase: string; width: number; frame: string }[] = [];
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  jobs,
  agent: {
    async runTurn(_request, handlers) {
      await new Promise<void>(resolve => handlers.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return createTurnOutcome({ status: "aborted", answer: "stopped", steps: 0, remainingCriteria: [] });
    },
  },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 30 }),
});
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 120, height: 30, useThread: false, useMouse: true,
});
let active: Promise<void> | undefined;
const ownerSessionId = services.session.sessionId;

async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
}

async function check(phase: string, visible: boolean): Promise<void> {
  for (const width of [120, 80, 40]) {
    const frame = await settle(() => setup.resize(width, 30));
    assert.equal(frame.includes("Responder:"), visible, `${phase} at ${width}\n${frame}`);
    assert.ok(frame.includes("AGENT"), frame);
    captures.push({ phase, width, frame });
  }
  await settle(() => setup.resize(120, 30));
}

async function start(id: string, exitCode: number, responder: boolean): Promise<{ id: string; trigger: string }> {
  const trigger = join(directory, id);
  const script = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) process.exit(${exitCode}); }, 20); setTimeout(() => process.exit(99), 20000);`;
  let jobId = "";
  await settle(async () => {
    const result = await manager.startJob(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, {
      ownerSessionId, responder, wakeOnCompletion: responder, name: id,
    });
    assert.ok(result.ok, result.output);
    assert.ok(result.backgroundJob);
    jobId = result.backgroundJob.id;
  });
  return { id: jobId, trigger };
}

async function complete(job: { id: string; trigger: string }) {
  await settle(async () => {
    let unsubscribe = (): void => {};
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`No completion notification for ${job.id}`));
      }, 5000);
      unsubscribe = jobs.subscribe(change => {
        if (change.type !== "notification" || change.jobId !== job.id) return;
        if (!jobs.pendingNotifications(ownerSessionId).some(notification => notification.jobId === job.id)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
    await writeFile(job.trigger, "finish");
    await completion;
  });
  const notification = jobs.pendingNotifications(ownerSessionId).find(entry => entry.jobId === job.id);
  assert.ok(notification);
  await settle();
  return notification;
}

try {
  await settle(() => { active = services.session.submit("Hold foreground while testing the responder display"); });
  await check("empty", false);
  const ordinary = await start("ordinary-background-fixture", 0, false);
  await check("ordinary background work", false);
  const first = await start("completed-responder-fixture", 0, true);
  const second = await start("pending-responder-fixture", 7, true);
  await check("running", true);
  const rows = setup.captureCharFrame().split("\n");
  const header = rows.findIndex(row => row.includes("Responder:"));
  await settle(() => setup.mockMouse.click(rows[header]!.indexOf("Responder:") + 1, header));
  assert.ok(setup.captureCharFrame().includes("completed-responder-fixture"));
  const firstNotification = await complete(first);
  assert.equal(firstNotification.deliveredAt, undefined);
  await check("ready beside running", true);
  await settle(() => {
    assert.equal(jobs.markDeliveryStarted(firstNotification.id, ownerSessionId), true);
    assert.equal(jobs.markDelivered(firstNotification.id, ownerSessionId), true);
  });
  const mixed = setup.captureCharFrame();
  assert.ok(!mixed.includes("completed-responder-fixture"), mixed);
  assert.ok(mixed.includes("pending-responder-fixture"), mixed);
  assert.ok(!mixed.includes("delivered"), mixed);
  assert.equal(firstNotification.readAt, undefined, "Hiding a delivered entry must not acknowledge the result");
  await check("delivered beside running", true);
  const secondNotification = await complete(second);
  assert.equal(secondNotification.status, "failed");
  await check("failed result awaiting delivery", true);
  await settle(() => {
    assert.equal(jobs.markDeliveryStarted(secondNotification.id, ownerSessionId), true);
    assert.equal(jobs.markDelivered(secondNotification.id, ownerSessionId), true);
  });
  await check("all delivered but unread", false);
  assert.equal(jobs.pendingNotifications(ownerSessionId).length, 2, "Delivery history remains available");
  const history = await settle(() => services.overlay.openJobs());
  assert.ok(history.includes(first.id), history);
  assert.ok(history.includes(second.id), history);
  await settle(() => services.overlay.close());
  assert.equal(services.overlay.getState().kind, "none");
  for (const notification of [firstNotification, secondNotification]) {
    await settle(() => {
      assert.equal(jobs.markRead(notification.id, ownerSessionId), true);
      assert.equal(jobs.markAnalyzed(notification.id, ownerSessionId), true);
      assert.equal(jobs.acknowledge(notification.id, ownerSessionId), true);
    });
  }
  await check("read and acknowledged", false);
  assert.equal(jobs.running(ownerSessionId).some(job => job.id === ordinary.id), true);
  const capturePath = process.env.CLAI_RESPONDER_PANEL_CAPTURE;
  if (capturePath) await writeFile(capturePath, JSON.stringify(captures));
  console.log(`Native responder panel passed: ${captures.length} running, pending, failed, mixed, delivered and read frames at 120/80/40 columns`);
} finally {
  await act(async () => {
    services.session.abort();
    await active;
    for (const job of manager.getRunningJobs(ownerSessionId)) await manager.stopJob(job.id, { graceMs: 100 });
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
  await rm(directory, { recursive: true, force: true });
}
