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

const dir = await mkdtemp(join(tmpdir(), "clai-native-cancel-"));
const trigger = join(dir, "finish-responder");
const manager = new JobManager(dir);
const jobs = createCurrentJobsPort(manager);
let deliveries = 0;
const services = createCompositionRoot({
  noHistory: true,
  jobs,
  agent: {
    async runTurn(request, handlers) {
      if (request.prompt.startsWith("hold ")) {
        await new Promise<void>(resolve => handlers.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return createTurnOutcome({ status: "aborted", answer: "stopped", steps: 0, remainingCriteria: [] });
      }
      deliveries += 1;
      const id = /^notification=(.+)$/m.exec(request.prompt)?.[1]?.trim();
      if (id) {
        jobs.markRead(id, services.session.sessionId);
        jobs.markAnalyzed(id);
        jobs.acknowledge(id);
      }
      return createTurnOutcome({ status: "succeeded", answer: "delivered", steps: 0, remainingCriteria: [] });
    },
  },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 30 }),
});
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 120, height: 30, useThread: false, useMouse: true, kittyKeyboard: true,
});
let active: Promise<void> | undefined;

async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
}

async function waitForJobEvent(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) {
    await settle(() => new Promise(resolve => setTimeout(resolve, 25)));
  }
  assert.ok(predicate(), "the external job event arrives before the deadline");
}

async function startTurn(label: string): Promise<void> {
  await settle(() => { active = services.session.submit(`hold ${label}`); });
  assert.equal(services.session.getState().running, true);
}

function cancelButton(): { x: number; y: number; row: string } {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex(row => row.includes("esc: cancel"));
  assert.ok(y >= 0, setup.captureCharFrame());
  return { x: rows[y]!.indexOf("esc: cancel"), y, row: rows[y]! };
}

try {
  await startTurn("click");
  const ownerSessionId = services.session.sessionId;
  const ordinary = await manager.startJob(`${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`, { ownerSessionId });
  const script = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) process.exit(0); }, 25);`;
  const responder = await manager.startJob(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, {
    ownerSessionId, responder: true, wakeOnCompletion: true,
  });
  const ordinaryId = ordinary.backgroundJob!.id;
  const responderId = responder.backgroundJob!.id;
  const lease = jobs.getResponderLeaseId(ownerSessionId);
  const button = cancelButton();
  await settle(() => setup.mockMouse.moveTo(button.x + 1, button.y));
  const hovered = setup.captureCharFrame().split("\n")[button.y]!;
  assert.ok(hovered.includes("esc: cancel"), "hover preserves the compact Esc label");
  assert.equal(hovered.indexOf("│", button.x), button.row.indexOf("│", button.x), "hover preserves adjacent layout");
  assert.ok(!hovered.includes("background work continues"), "hover does not expand Esc");
  await settle(() => setup.mockMouse.click(button.x + 1, button.y));
  await active;
  assert.equal(services.session.getState().running, false, "one click stops the main agent");
  assert.equal(manager.getJob(ordinaryId)?.status, "running");
  assert.equal(manager.getJob(responderId)?.status, "running");
  assert.equal(jobs.getResponderLeaseId(ownerSessionId), lease);
  assert.equal(services.session.getState().responder.mode, "listening");

  await settle(() => setup.mockMouse.moveTo(0, 0));
  await startTurn("keyboard");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.session.getState().running, true, "one keyboard Esc only arms cancellation");
  await new Promise(resolve => setTimeout(resolve, 80));
  await settle(() => setup.mockInput.pressEscape());
  await active;
  assert.equal(services.session.getState().running, false, "double keyboard Esc stops the main agent");
  assert.equal(manager.getJob(ordinaryId)?.status, "running");
  assert.equal(manager.getJob(responderId)?.status, "running");
  assert.equal(jobs.getResponderLeaseId(ownerSessionId), lease);

  await new Promise(resolve => setTimeout(resolve, 80));
  await settle(() => setup.mockInput.pressEscape());
  await new Promise(resolve => setTimeout(resolve, 80));
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(manager.getJob(ordinaryId)?.status, "running", "background-only Esc is harmless");
  assert.equal(manager.getJob(responderId)?.status, "running");
  await writeFile(trigger, "finish");
  await waitForJobEvent(() => deliveries > 0);
  assert.equal(manager.getJob(responderId)?.status, "exited");
  await settle(() => setup.mockInput.pressKey("c", { ctrl: true }));
  await waitForJobEvent(() => manager.getJob(ordinaryId)?.status === "killed");
  console.log("Native foreground cancellation passed: fixed hover, one-click abort, double keyboard Esc, surviving jobs, delivered responder result and Ctrl+C cleanup");
} catch (error) {
  console.error(JSON.stringify({ jobs: manager.listJobs(services.session.sessionId), notifications: jobs.pendingNotifications(services.session.sessionId), state: services.session.getState(), lease: jobs.getResponderLeaseId(services.session.sessionId) }));
  throw error;
} finally {
  services.session.abort();
  await active;
  for (const job of manager.getRunningJobs()) await manager.stopJob(job.id, { graceMs: 200 });
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
  await rm(dir, { recursive: true, force: true });
}
